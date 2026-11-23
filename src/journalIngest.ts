import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type http from "node:http";
import { Bot, InputFile } from "grammy";
import type { AppConfig } from "./config.js";
import { archiveJournalMedia, isJournalMedia, loadJournalConfig } from "./journal.js";
import { logger } from "./logger.js";
import type { Storage } from "./storage.js";
import type { StoredContextFile, TelegramFileRef } from "./telegramMedia.js";

export type JournalIngestHandler = (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>;

interface ImportMetadata {
  version: 1;
  sourceId: string;
  originalPath: string;
  sha256: string;
  byteCount: number;
  destination: { chatId: number; messageThreadId: number };
}

interface MultipartPart {
  headers: Record<string, string>;
  body: Buffer;
}

export function createJournalIngestHandler(input: {
  config: AppConfig;
  storage: Storage;
  bot: Bot;
}): JournalIngestHandler {
  return async (request, response) => {
    try {
      const parsed = await readImport(request, input.config.journalIngestMaxBytes);
      const { metadata, bytes, filename, mimeType } = parsed;
      const binding = input.storage.getBinding(metadata.destination.chatId, metadata.destination.messageThreadId);
      if (!binding) {
        respond(response, 422, { ok: false, error: "destination is not a bound Telegram topic" });
        return;
      }
      const journalConfig = await loadJournalConfig(binding.repoPath);
      const fileRefKind = "audio";
      const candidate: TelegramFileRef = {
        kind: fileRefKind,
        fileId: "pending",
        fileUniqueId: metadata.sha256,
        originalName: filename,
        mimeType,
        fileSize: bytes.byteLength,
        durationSeconds: null,
      };
      if (!journalConfig?.enabled || !isJournalMedia(candidate, journalConfig)) {
        respond(response, 422, { ok: false, error: "destination does not accept journal audio" });
        return;
      }

      let imported = input.storage.getJournalIngestImport(metadata.sha256);
      if (imported && (imported.chatId !== binding.chatId || imported.messageThreadId !== binding.messageThreadId)) {
        respond(response, 409, { ok: false, error: "digest is already assigned to another destination" });
        return;
      }
      if (imported?.status === "completed") {
        respond(response, 409, { ok: true, sha256: metadata.sha256, importId: importId(metadata.sha256) });
        return;
      }
      imported ??= input.storage.createJournalIngestImport(metadata.sha256, binding.chatId, binding.messageThreadId);

      if (imported.status === "processing") {
        const sent = await input.bot.api.sendAudio(
          binding.chatId,
          new InputFile(bytes, filename),
          { message_thread_id: binding.messageThreadId, disable_notification: true },
        );
        const audio = sent.audio;
        if (!audio) throw new Error("Telegram did not return audio metadata for the sent import.");
        input.storage.markJournalIngestSent(metadata.sha256, sent.message_id, audio.file_id, audio.file_unique_id);
        imported = input.storage.getJournalIngestImport(metadata.sha256);
      }

      if (!imported?.telegramMessageId || !imported.telegramFileId || !imported.telegramFileUniqueId) {
        throw new Error("Journal import does not have persisted Telegram delivery metadata.");
      }
      const storedFile = await stageImport(binding.repoPath, metadata.sha256, filename, mimeType, bytes);
      const archiveRef: TelegramFileRef = {
        ...candidate,
        fileId: imported.telegramFileId,
        fileUniqueId: imported.telegramFileUniqueId,
      };
      const result = await archiveJournalMedia({
        appConfig: input.config,
        journalConfig,
        repoPath: binding.repoPath,
        storedFile,
        fileRef: archiveRef,
        telegramMessageId: imported.telegramMessageId,
        capturedAt: new Date(),
        authorUsername: "journal-daemon",
      });
      input.storage.completeJournalIngestImport(metadata.sha256);
      input.storage.audit({
        telegramUserId: null,
        chatId: binding.chatId,
        messageThreadId: binding.messageThreadId,
        eventType: result.duplicate ? "journal_daemon_import_duplicate" : "journal_daemon_import_archived",
        details: { sha256: metadata.sha256, sourceId: metadata.sourceId, entryPath: result.entryPath },
      });
      respond(response, 201, { ok: true, sha256: metadata.sha256, importId: importId(metadata.sha256) });
    } catch (error) {
      logger.warn("journal daemon import failed", { error: error instanceof Error ? error.message : String(error) });
      respond(response, 500, { ok: false, error: "journal import failed" });
    }
  };
}

async function readImport(request: http.IncomingMessage, maximumBytes: number): Promise<{
  metadata: ImportMetadata;
  bytes: Buffer;
  filename: string;
  mimeType: string;
}> {
  const boundary = request.headers["content-type"]?.match(/multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i)?.slice(1).find(Boolean);
  if (!boundary) throw new Error("Expected multipart/form-data.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maximumBytes + 128 * 1024) throw new Error("Journal import exceeds the configured size limit.");
    chunks.push(buffer);
  }
  const parts = parseMultipart(Buffer.concat(chunks), boundary);
  const metadataPart = parts.find((part) => part.headers["content-disposition"]?.includes('name="metadata"'));
  const filePart = parts.find((part) => part.headers["content-disposition"]?.includes('name="file"'));
  if (!metadataPart || !filePart) throw new Error("Journal import requires metadata and file parts.");
  const metadata = normalizeMetadata(JSON.parse(metadataPart.body.toString("utf8")));
  if (filePart.body.byteLength !== metadata.byteCount || filePart.body.byteLength > maximumBytes) {
    throw new Error("Journal import byte count is invalid.");
  }
  const digest = createHash("sha256").update(filePart.body).digest("hex");
  if (digest !== metadata.sha256 || request.headers["idempotency-key"] !== `sha256:${digest}`) {
    throw new Error("Journal import digest is invalid.");
  }
  const disposition = filePart.headers["content-disposition"] ?? "";
  const rawName = disposition.match(/filename="([^"]+)"/i)?.[1] ?? "recording.audio";
  return {
    metadata,
    bytes: filePart.body,
    filename: safeFilename(rawName),
    mimeType: filePart.headers["content-type"] || "application/octet-stream",
  };
}

export function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const marker = Buffer.from(`--${boundary}`);
  const crlfMarker = Buffer.from(`\r\n--${boundary}`);
  const lfMarker = Buffer.from(`\n--${boundary}`);
  const parts: MultipartPart[] = [];
  let markerOffset = body.indexOf(marker);
  while (markerOffset >= 0) {
    let offset = markerOffset + marker.length;
    if (body.subarray(offset, offset + 2).equals(Buffer.from("--"))) break;
    if (body.subarray(offset, offset + 2).equals(Buffer.from("\r\n"))) offset += 2;
    else if (body[offset] === 0x0a) offset += 1;
    else break;
    const nextCRLF = body.indexOf(crlfMarker, offset);
    const nextLF = body.indexOf(lfMarker, offset);
    const next = nextCRLF < 0 ? nextLF : nextLF < 0 ? nextCRLF : Math.min(nextCRLF, nextLF);
    if (next < 0) break;
    const segment = body.subarray(offset, next);
    const crlfSeparator = segment.indexOf("\r\n\r\n");
    const lfSeparator = segment.indexOf("\n\n");
    const separator = crlfSeparator < 0 ? lfSeparator : lfSeparator < 0 ? crlfSeparator : Math.min(crlfSeparator, lfSeparator);
    if (separator >= 0) {
      const separatorLength = crlfSeparator === separator ? 4 : 2;
      const headers: Record<string, string> = {};
      for (const line of segment.subarray(0, separator).toString("utf8").split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      parts.push({ headers, body: segment.subarray(separator + separatorLength) });
    }
    markerOffset = next + (next === nextCRLF ? 2 : 1);
  }
  return parts;
}

function normalizeMetadata(value: unknown): ImportMetadata {
  const input = value as Record<string, unknown>;
  const destination = input?.destination as Record<string, unknown>;
  if (input?.version !== 1 || typeof input.sourceId !== "string" || typeof input.originalPath !== "string"
    || typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256)
    || typeof input.byteCount !== "number" || !Number.isSafeInteger(input.byteCount) || input.byteCount < 0
    || !destination || !Number.isSafeInteger(destination.chatId) || !Number.isSafeInteger(destination.messageThreadId)) {
    throw new Error("Journal import metadata is invalid.");
  }
  return {
    version: 1,
    sourceId: input.sourceId as string,
    originalPath: input.originalPath as string,
    sha256: input.sha256 as string,
    byteCount: input.byteCount as number,
    destination: { chatId: destination.chatId as number, messageThreadId: destination.messageThreadId as number },
  };
}

async function stageImport(repoPath: string, sha256: string, filename: string, mimeType: string, bytes: Buffer): Promise<StoredContextFile> {
  const directory = path.join(repoPath, ".context", "journal-daemon-imports");
  await mkdir(directory, { recursive: true });
  const absolutePath = path.join(directory, `${sha256}-${filename}`);
  await writeFile(absolutePath, bytes);
  return { kind: "audio", absolutePath, relativePath: path.relative(repoPath, absolutePath), originalName: filename, mimeType, fileSize: bytes.byteLength };
}

function safeFilename(value: string): string {
  const name = path.basename(value).replace(/[^A-Za-z0-9._-]/g, "_");
  return name || "recording.audio";
}

function importId(sha256: string): string { return `journal:${sha256}`; }

function respond(response: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
