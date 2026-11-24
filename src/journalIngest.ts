import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import Busboy from "busboy";
import type http from "node:http";
import { Bot, InputFile } from "grammy";
import type { AppConfig } from "./config.js";
import { archiveJournalMedia, isJournalMedia, loadJournalConfig, type JournalArchiveResult } from "./journal.js";
import { logger } from "./logger.js";
import type { Storage } from "./storage.js";
import type { StoredContextFile, TelegramFileRef } from "./telegramMedia.js";

export type JournalIngestHandler = (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>;
const execFileAsync = promisify(execFile);

export function githubTreeUrl(remote: string, entryPath: string): string | null {
  const normalized = remote.trim().replace(/\.git$/, "");
  const match = normalized.match(/^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+\/[^/]+)$/);
  return match ? `https://github.com/${match[1]}/tree/main/${entryPath}` : null;
}

async function journalEntryUrl(repoPath: string, entryPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "remote", "get-url", "origin"]);
    return githubTreeUrl(stdout, entryPath);
  } catch {
    return null;
  }
}

export function formatJournalDaemonArchiveResult(result: JournalArchiveResult, entryUrl: string | null): string {
  const lines = result.duplicate
    ? ["USB Drive Audio was already archived.", "", entryUrl ?? `Entry: ${result.entryPath}`]
    : [
        "USB Drive Audio received.",
        "",
        entryUrl ?? `Entry: ${result.entryPath}`,
        entryUrl ? null : result.transcriptPath ? `Transcript: ${result.transcriptPath}` : "Transcript: unavailable",
        entryUrl ? null : result.commitHash ? `Commit: ${result.commitHash}` : null,
        entryUrl ? null : result.pushed ? "GitHub: pushed" : "GitHub: push pending",
      ].filter((line): line is string => line !== null);
  if (result.transcriptionError) lines.push("", `Transcription failed and can be retried: ${result.transcriptionError}`);
  if (result.pushError) lines.push("", `Push failed and the local commit was retained: ${result.pushError}`);
  return lines.join("\n");
}

interface ImportMetadata {
  version: 1;
  sourceId: string;
  originalPath: string;
  sha256: string;
  byteCount: number;
  destination: { chatId: number; messageThreadId: number };
}

export function createJournalIngestHandler(input: {
  config: AppConfig;
  storage: Storage;
  bot: Bot;
}): JournalIngestHandler {
  return async (request, response) => {
    try {
      const parsed = await readImport(request);
      const { metadata } = parsed;
      const binding = input.storage.getBinding(metadata.destination.chatId, metadata.destination.messageThreadId);
      if (!binding) {
        respond(response, 422, { ok: false, error: "destination is not a bound Telegram topic" });
        return;
      }
      const journalConfig = await loadJournalConfig(binding.repoPath);
      const fileRefKind = "audio";
      const converted = await convertToMp3(input.config, parsed);
      const candidate: TelegramFileRef = {
        kind: fileRefKind,
        fileId: "pending",
        fileUniqueId: metadata.sha256,
        originalName: converted.filename,
        mimeType: "audio/mpeg",
        fileSize: converted.bytes,
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
          new InputFile(converted.path, converted.filename),
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
      const storedFile = await stageImport(binding.repoPath, metadata.sha256, converted.path, converted.filename, "audio/mpeg");
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
      try {
        const entryUrl = result.pushed ? await journalEntryUrl(binding.repoPath, result.entryPath) : null;
        await input.bot.api.sendMessage(binding.chatId, formatJournalDaemonArchiveResult(result, entryUrl), {
          message_thread_id: binding.messageThreadId,
          disable_notification: true,
        });
      } catch (notificationError) {
        logger.warn("journal daemon import result notification failed", {
          error: notificationError instanceof Error ? notificationError.message : String(notificationError),
          sha256: metadata.sha256,
        });
      }
      respond(response, 201, { ok: true, sha256: metadata.sha256, importId: importId(metadata.sha256) });
    } catch (error) {
      logger.warn("journal daemon import failed", { error: error instanceof Error ? error.message : String(error) });
      respond(response, 500, { ok: false, error: "journal import failed" });
    } finally {
      if ("journalDaemonTemporaryDirectory" in request) {
        await rm(request.journalDaemonTemporaryDirectory, { recursive: true, force: true });
      }
    }
  };
}

declare module "node:http" {
  interface IncomingMessage {
    journalDaemonTemporaryDirectory?: string;
  }
}

interface ParsedImport {
  metadata: ImportMetadata;
  rawPath: string;
  directory: string;
  filename: string;
  mimeType: string;
  byteCount: number;
}

export async function readImport(request: http.IncomingMessage): Promise<ParsedImport> {
  const contentType = request.headers["content-type"] ?? "";
  if (!/^multipart\/form-data\b/i.test(contentType)) throw new Error("Expected multipart/form-data.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "journal-daemon-import-"));
  request.journalDaemonTemporaryDirectory = directory;
  const rawPath = path.join(directory, "source");
  let metadataText: string | null = null;
  let file: { filename: string; mimeType: string; done: Promise<void> } | null = null;
  let byteCount = 0;
  const digest = createHash("sha256");
  try {
    await new Promise<void>((resolve, reject) => {
      const parser = Busboy({ headers: request.headers, limits: { fields: 1, files: 1, fieldSize: 64 * 1024 } });
      parser.on("field", (name, value) => {
        if (name !== "metadata" || metadataText !== null) {
          reject(new Error("Journal import has unexpected form fields."));
          return;
        }
        metadataText = value;
      });
      parser.on("file", (name, stream, info) => {
        if (name !== "file" || file !== null) {
          stream.resume();
          reject(new Error("Journal import has unexpected file parts."));
          return;
        }
        stream.on("data", (chunk: Buffer) => {
          byteCount += chunk.byteLength;
          digest.update(chunk);
        });
        file = {
          filename: safeFilename(info.filename || "recording.audio"),
          mimeType: info.mimeType || "application/octet-stream",
          done: finished(stream.pipe(createWriteStream(rawPath))),
        };
      });
      parser.once("error", reject);
      parser.once("fieldsLimit", () => reject(new Error("Journal import has too many form fields.")));
      parser.once("filesLimit", () => reject(new Error("Journal import has too many file parts.")));
      parser.once("finish", () => {
        if (!file) {
          reject(new Error("Journal import requires metadata and file parts."));
          return;
        }
        void file.done.then(resolve, reject);
      });
      request.once("aborted", () => reject(new Error("Journal import was aborted.")));
      request.pipe(parser);
    });
    const uploadedFile = file as { filename: string; mimeType: string; done: Promise<void> } | null;
    if (!metadataText || !uploadedFile) throw new Error("Journal import requires metadata and file parts.");
    const metadata = normalizeMetadata(JSON.parse(metadataText));
    const actualDigest = digest.digest("hex");
    if (byteCount !== metadata.byteCount) throw new Error("Journal import byte count is invalid.");
    if (actualDigest !== metadata.sha256 || request.headers["idempotency-key"] !== `sha256:${actualDigest}`) {
      throw new Error("Journal import digest is invalid.");
    }
    return { metadata, rawPath, directory, filename: uploadedFile.filename, mimeType: uploadedFile.mimeType, byteCount };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    delete request.journalDaemonTemporaryDirectory;
    throw error;
  }
}

async function convertToMp3(config: AppConfig, input: ParsedImport): Promise<{ path: string; filename: string; bytes: number }> {
  const filename = `${path.parse(input.filename).name || "recording"}.mp3`;
  const output = path.join(input.directory, filename);
  await runFfmpeg(config.ffmpegBin, ["-y", "-i", input.rawPath, "-vn", "-codec:a", "libmp3lame", "-b:a", "64k", output]);
  const details = await stat(output);
  return { path: output, filename, bytes: details.size };
}

async function runFfmpeg(ffmpegBin: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => reject(new Error(`Could not run ${ffmpegBin}: ${error.message}`)));
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${ffmpegBin} failed with exit code ${code ?? "unknown"}: ${stderr.slice(-1_000)}`)));
  });
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

async function stageImport(repoPath: string, sha256: string, sourcePath: string, filename: string, mimeType: string): Promise<StoredContextFile> {
  const directory = path.join(repoPath, ".context", "journal-daemon-imports");
  await mkdir(directory, { recursive: true });
  const absolutePath = path.join(directory, `${sha256}-${filename}`);
  await copyFile(sourcePath, absolutePath);
  const details = await stat(absolutePath);
  return { kind: "audio", absolutePath, relativePath: path.relative(repoPath, absolutePath), originalName: filename, mimeType, fileSize: details.size };
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
