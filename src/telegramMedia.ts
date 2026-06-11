import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Bot } from "grammy";
import type { AppConfig } from "./config.js";

export interface TelegramFileRef {
  kind: string;
  fileId: string;
  fileUniqueId: string;
  originalName: string | null;
  mimeType: string | null;
  fileSize: number | null;
}

export interface StoredContextFile {
  kind: string;
  absolutePath: string;
  relativePath: string;
  originalName: string | null;
  mimeType: string | null;
  fileSize: number;
}

const transcriptionExtensions = new Set([".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm"]);

export async function saveTelegramFileToContext(
  bot: Bot,
  config: AppConfig,
  repoPath: string,
  ref: TelegramFileRef,
  telegramMessageId: number | null,
): Promise<StoredContextFile> {
  if (ref.fileSize !== null && ref.fileSize > config.maxTelegramFileBytes) {
    throw new Error(
      `Telegram file is ${formatBytes(ref.fileSize)}, above MAX_TELEGRAM_FILE_BYTES (${formatBytes(
        config.maxTelegramFileBytes,
      )}).`,
    );
  }

  const file = await bot.api.getFile(ref.fileId);
  if (!file.file_path) {
    throw new Error("Telegram did not return a downloadable file path.");
  }

  const response = await fetch(`https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`);
  if (!response.ok) {
    throw new Error(`Telegram file download failed with HTTP ${response.status}.`);
  }

  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength !== null && contentLength > config.maxTelegramFileBytes) {
    throw new Error(
      `Telegram file download is ${formatBytes(contentLength)}, above MAX_TELEGRAM_FILE_BYTES (${formatBytes(
        config.maxTelegramFileBytes,
      )}).`,
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > config.maxTelegramFileBytes) {
    throw new Error(
      `Telegram file download is ${formatBytes(bytes.byteLength)}, above MAX_TELEGRAM_FILE_BYTES (${formatBytes(
        config.maxTelegramFileBytes,
      )}).`,
    );
  }

  const contextDir = path.join(repoPath, ".context");
  await mkdir(contextDir, { recursive: true });
  await ensureContextGitignore(contextDir);

  const destination = path.join(
    contextDir,
    contextFilename(ref, file.file_path, telegramMessageId, new Date()),
  );
  await writeFile(destination, bytes, { flag: "wx" });

  return {
    kind: ref.kind,
    absolutePath: destination,
    relativePath: path.relative(repoPath, destination),
    originalName: ref.originalName,
    mimeType: ref.mimeType,
    fileSize: bytes.byteLength,
  };
}

export async function transcribeStoredAudio(config: AppConfig, storedFile: StoredContextFile): Promise<string> {
  if (!config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required to transcribe Telegram voice messages.");
  }

  const transcriptionFilePath = await ensureTranscriptionFormat(config, storedFile.absolutePath);
  const audioBytes = await readFile(transcriptionFilePath);
  const form = new FormData();
  form.set("model", config.openaiTranscriptionModel);
  form.set(
    "file",
    new Blob([new Uint8Array(audioBytes)], {
      type: mimeTypeForExtension(path.extname(transcriptionFilePath)),
    }),
    path.basename(transcriptionFilePath),
  );

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: form,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI transcription failed with HTTP ${response.status}: ${truncateErrorBody(body)}`);
  }

  const parsed = JSON.parse(body) as { text?: unknown };
  if (typeof parsed.text !== "string") {
    throw new Error("OpenAI transcription response did not include text.");
  }

  return parsed.text.trim();
}

export async function saveTranscriptForAudio(
  repoPath: string,
  storedFile: StoredContextFile,
  transcript: string,
): Promise<StoredContextFile> {
  const transcriptPath = `${storedFile.absolutePath}.transcript.txt`;
  const content = `${transcript.trim()}\n`;
  await writeFile(transcriptPath, content, { flag: "wx" });
  return {
    kind: "transcript",
    absolutePath: transcriptPath,
    relativePath: path.relative(repoPath, transcriptPath),
    originalName: storedFile.originalName ? `${storedFile.originalName}.transcript.txt` : null,
    mimeType: "text/plain",
    fileSize: Buffer.byteLength(content, "utf8"),
  };
}

async function ensureTranscriptionFormat(config: AppConfig, audioPath: string): Promise<string> {
  const extension = path.extname(audioPath).toLowerCase();
  if (transcriptionExtensions.has(extension)) {
    return audioPath;
  }

  const convertedPath = `${audioPath}.mp3`;
  try {
    await access(convertedPath, fsConstants.F_OK);
    return convertedPath;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await runFfmpeg(config.ffmpegBin, [
    "-y",
    "-i",
    audioPath,
    "-vn",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "128k",
    convertedPath,
  ]);
  return convertedPath;
}

async function runFfmpeg(ffmpegBin: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      reject(new Error(`Could not run ${ffmpegBin}: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${ffmpegBin} failed with exit code ${code ?? "unknown"}: ${truncateErrorBody(stderr)}`));
    });
  });
}

async function ensureContextGitignore(contextDir: string): Promise<void> {
  try {
    await writeFile(path.join(contextDir, ".gitignore"), "*\n!.gitignore\n", { flag: "wx" });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw error;
    }
  }
}

function contextFilename(
  ref: TelegramFileRef,
  telegramFilePath: string,
  telegramMessageId: number | null,
  now: Date,
): string {
  const originalExtension = extensionFrom(ref.originalName) ?? extensionFrom(telegramFilePath);
  const extension = originalExtension ?? extensionFromMime(ref.mimeType) ?? ".bin";
  const originalBase = ref.originalName ? path.basename(ref.originalName, path.extname(ref.originalName)) : ref.kind;
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const messagePart = telegramMessageId === null ? "msg-unknown" : `msg-${telegramMessageId}`;
  const uniquePart = sanitizeFilenamePart(ref.fileUniqueId).slice(0, 18) || "file";
  const namePart = sanitizeFilenamePart(originalBase) || ref.kind;

  return `${timestamp}-${messagePart}-${uniquePart}-${namePart}${extension.toLowerCase()}`;
}

function sanitizeFilenamePart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function extensionFrom(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const extension = path.extname(value).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : null;
}

function extensionFromMime(mimeType: string | null): string | null {
  if (!mimeType) {
    return null;
  }
  const normalized = mimeType.toLowerCase().split(";")[0]?.trim();
  switch (normalized) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
    case "audio/x-m4a":
      return ".m4a";
    case "audio/ogg":
      return ".oga";
    case "video/mp4":
      return ".mp4";
    case "video/webm":
      return ".webm";
    case "application/pdf":
      return ".pdf";
    default:
      return null;
  }
}

function mimeTypeForExtension(extension: string): string {
  switch (extension.toLowerCase()) {
    case ".mp3":
    case ".mpeg":
    case ".mpga":
      return "audio/mpeg";
    case ".mp4":
      return "audio/mp4";
    case ".m4a":
      return "audio/mp4";
    case ".wav":
      return "audio/wav";
    case ".webm":
      return "audio/webm";
    default:
      return "application/octet-stream";
  }
}

function parseContentLength(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function formatBytes(bytes: number): string {
  const mib = bytes / 1024 / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MiB`;
}

function truncateErrorBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= 800) {
    return trimmed;
  }
  return `${trimmed.slice(0, 800).trimEnd()}...`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
