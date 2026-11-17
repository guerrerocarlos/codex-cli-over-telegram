import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import type { Storage } from "./storage.js";
import {
  transcribeStoredJournalMedia,
  type StoredContextFile,
  type TelegramFileRef,
} from "./telegramMedia.js";

const execFileAsync = promisify(execFile);
const journalLocks = new Map<string, Promise<void>>();

export interface JournalConfig {
  version: 1;
  enabled: boolean;
  timezone: string;
  entriesDirectory: string;
  indexDirectory: string;
  autoCommit: boolean;
  autoPush: boolean;
  agentTrigger: "text-or-mention";
  imageIngestion: boolean;
  mediaKinds: string[];
}

interface JournalIndexEntry {
  id: string;
  path: string;
  capturedAt: string;
  telegramMessageId: number;
  telegramFileUniqueId: string;
  sha256: string;
  kind: string;
  transcriptionStatus: JournalTranscriptionStatus;
}

type JournalTranscriptionStatus = "complete" | "failed" | "not_applicable";

interface JournalIndex {
  version: 1;
  entries: JournalIndexEntry[];
}

export interface JournalArchiveInput {
  appConfig: AppConfig;
  journalConfig: JournalConfig;
  repoPath: string;
  storedFile: StoredContextFile;
  fileRef: TelegramFileRef;
  telegramMessageId: number;
  capturedAt: Date;
  authorUsername: string | null;
}

export interface JournalArchiveResult {
  entryPath: string;
  transcriptPath: string | null;
  commitHash: string | null;
  pushed: boolean;
  duplicate: boolean;
  transcriptionStatus: JournalTranscriptionStatus;
  transcriptionError: string | null;
  pushError: string | null;
}

export interface JournalRecoveryResult {
  repoPath: string;
  recovered: boolean;
  pushed: boolean;
  message: string;
}

interface JournalArchiveDependencies {
  transcribe?: (
    config: AppConfig,
    file: StoredContextFile,
    extractVideoAudio: boolean,
  ) => Promise<string>;
}

export async function loadJournalConfig(repoPath: string): Promise<JournalConfig | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.join(repoPath, "journal.config.json"), "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw new Error(`Could not load journal.config.json: ${errorMessage(error)}`);
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("journal.config.json must contain an object.");
  }
  const input = value as Record<string, unknown>;
  if (input.version !== 1) {
    throw new Error("journal.config.json version must be 1.");
  }
  const timezone = requiredString(input.timezone, "timezone");
  validateTimezone(timezone);
  const entriesDirectory = safeRelativeDirectory(input.entriesDirectory, "entriesDirectory");
  const indexDirectory = safeRelativeDirectory(input.indexDirectory, "indexDirectory");
  if (input.agentTrigger !== "text-or-mention") {
    throw new Error("journal.config.json agentTrigger must be text-or-mention.");
  }
  if (typeof input.imageIngestion !== "boolean") {
    throw new Error("journal.config.json imageIngestion must be a boolean.");
  }
  const mediaKinds = Array.isArray(input.mediaKinds)
    ? input.mediaKinds.filter((item): item is string => typeof item === "string")
    : [];
  if (mediaKinds.length === 0) {
    throw new Error("journal.config.json mediaKinds must contain at least one media kind.");
  }

  return {
    version: 1,
    enabled: input.enabled === true,
    timezone,
    entriesDirectory,
    indexDirectory,
    autoCommit: input.autoCommit === true,
    autoPush: input.autoPush === true,
    agentTrigger: "text-or-mention",
    imageIngestion: input.imageIngestion,
    mediaKinds,
  };
}

export function isJournalMedia(ref: TelegramFileRef, config: JournalConfig): boolean {
  if (!config.enabled) {
    return false;
  }
  if (config.mediaKinds.includes(ref.kind)) {
    return true;
  }
  const mime = ref.mimeType?.toLowerCase() ?? "";
  if (config.imageIngestion && (ref.kind === "photo" || ref.kind === "document" && mime.startsWith("image/"))) {
    return true;
  }
  return config.mediaKinds.includes("audio-document") && ref.kind === "document" && mime.startsWith("audio/")
    || config.mediaKinds.includes("video-document") && ref.kind === "document" && mime.startsWith("video/");
}

export async function recoverJournalRepositories(storage: Storage): Promise<JournalRecoveryResult[]> {
  const results: JournalRecoveryResult[] = [];
  for (const binding of storage.listBindings()) {
    let config: JournalConfig | null;
    try {
      config = await loadJournalConfig(binding.repoPath);
    } catch (error) {
      results.push({
        repoPath: binding.repoPath,
        recovered: false,
        pushed: false,
        message: errorMessage(error),
      });
      continue;
    }
    if (!config?.enabled) {
      continue;
    }
    results.push(await withJournalLock(binding.repoPath, () => recoverJournalRepository(binding.repoPath, config)));
  }
  return results;
}

async function recoverJournalRepository(repoPath: string, config: JournalConfig): Promise<JournalRecoveryResult> {
  const status = (await git(repoPath, ["status", "--porcelain", "--untracked-files=all"])).stdout;
  if (!status) {
    if (!config.autoPush) {
      return { repoPath, recovered: false, pushed: false, message: "Journal repository is clean." };
    }
    try {
      await git(repoPath, ["push", "origin", "HEAD"]);
      return { repoPath, recovered: false, pushed: true, message: "Journal repository is clean and pushed." };
    } catch (error) {
      return { repoPath, recovered: false, pushed: false, message: `Pending push failed: ${errorMessage(error)}` };
    }
  }

  const statusLines = status.split("\n").filter(Boolean);
  if (!statusLines.every((line) => isRecoverableJournalStatus(line, config))) {
    return {
      repoPath,
      recovered: false,
      pushed: false,
      message: `Journal recovery skipped because unrelated changes exist:\n${status}`,
    };
  }

  const index = await rebuildJournalIndex(repoPath, config);
  if (index.entries.length === 0) {
    return { repoPath, recovered: false, pushed: false, message: "Journal recovery found no complete entries." };
  }
  const indexPath = path.join(repoPath, config.entriesDirectory, "index.json");
  await atomicWrite(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  const months = new Set(index.entries.map((entry) => entry.capturedAt.slice(0, 7)));
  for (const monthKey of months) {
    const [year, month] = monthKey.split("-");
    if (year && month) {
      const monthlyPath = path.posix.join(config.indexDirectory, year, `${month}.md`);
      await writeMonthlyIndex(repoPath, monthlyPath, index, year, month);
    }
  }
  await git(repoPath, ["add", "--", config.entriesDirectory, config.indexDirectory]);
  if (!(await hasStagedChanges(repoPath))) {
    return { repoPath, recovered: false, pushed: false, message: "Journal recovery had nothing to commit." };
  }
  await git(repoPath, ["commit", "-m", "journal: recover pending entries"]);
  let pushed = false;
  let message = "Recovered pending journal entries.";
  if (config.autoPush) {
    try {
      await git(repoPath, ["push", "origin", "HEAD"]);
      pushed = true;
      message = "Recovered and pushed pending journal entries.";
    } catch (error) {
      message = `Recovered pending journal entries locally, but push failed: ${errorMessage(error)}`;
    }
  }
  return { repoPath, recovered: true, pushed, message };
}

export async function archiveJournalMedia(
  input: JournalArchiveInput,
  dependencies: JournalArchiveDependencies = {},
): Promise<JournalArchiveResult> {
  return withJournalLock(input.repoPath, () => archiveJournalMediaUnlocked(input, dependencies));
}

async function archiveJournalMediaUnlocked(
  input: JournalArchiveInput,
  dependencies: JournalArchiveDependencies,
): Promise<JournalArchiveResult> {
  await ensureCleanRepository(input.repoPath);
  if (input.journalConfig.autoPush) {
    await git(input.repoPath, ["pull", "--ff-only"]);
    await ensureCleanRepository(input.repoPath);
  }

  const indexPath = path.join(input.repoPath, input.journalConfig.entriesDirectory, "index.json");
  const index = await readJournalIndex(indexPath);
  const rawBytes = await readFile(input.storedFile.absolutePath);
  const sha256 = createHash("sha256").update(rawBytes).digest("hex");
  const duplicate = index.entries.find((entry) =>
    entry.telegramFileUniqueId === input.fileRef.fileUniqueId || entry.sha256 === sha256,
  );
  if (duplicate && duplicate.transcriptionStatus !== "failed") {
    return {
      entryPath: duplicate.path,
      transcriptPath: duplicate.transcriptionStatus === "complete" ? `${duplicate.path}/transcript.md` : null,
      commitHash: null,
      pushed: true,
      duplicate: true,
      transcriptionStatus: duplicate.transcriptionStatus,
      transcriptionError: null,
      pushError: null,
    };
  }

  const parts = zonedDateParts(input.capturedAt, input.journalConfig.timezone);
  const entryId = duplicate?.id ?? journalEntryId(parts, input.telegramMessageId, input.fileRef.fileUniqueId);
  const entryRelativePath = duplicate?.path ?? path.posix.join(
    input.journalConfig.entriesDirectory,
    parts.year,
    parts.month,
    parts.day,
    entryId,
  );
  const entryAbsolutePath = path.join(input.repoPath, ...entryRelativePath.split("/"));
  const workingEntryPath = duplicate
    ? entryAbsolutePath
    : path.join(input.repoPath, ".context", "journal-pending", entryId);
  if (!duplicate) {
    await rm(workingEntryPath, { recursive: true, force: true });
  }
  await mkdir(workingEntryPath, { recursive: true });

  const rawFilename = duplicate
    ? await existingRawFilename(entryAbsolutePath)
    : `raw${safeExtension(input.storedFile.absolutePath)}`;
  const rawAbsolutePath = path.join(workingEntryPath, rawFilename);
  if (!duplicate) {
    await copyFile(input.storedFile.absolutePath, rawAbsolutePath);
  }

  const rawStoredFile: StoredContextFile = {
    ...input.storedFile,
    absolutePath: rawAbsolutePath,
    relativePath: path.relative(input.repoPath, rawAbsolutePath),
  };
  const transcribe = dependencies.transcribe ?? transcribeStoredJournalMedia;
  let transcript = "";
  let transcriptionError: string | null = null;
  const transcriptionApplicable = isTranscribableJournalMedia(input.fileRef);
  if (transcriptionApplicable) {
    try {
      transcript = (await transcribe(
        input.appConfig,
        rawStoredFile,
        isVideoRef(input.fileRef),
      )).trim();
      if (!transcript) {
        transcriptionError = "Transcription was empty.";
      }
    } catch (error) {
      transcriptionError = errorMessage(error);
    }
  }

  const transcriptionStatus: JournalTranscriptionStatus = transcriptionApplicable
    ? transcriptionError ? "failed" : "complete"
    : "not_applicable";
  const transcriptRelativePath = transcriptionStatus === "complete" ? `${entryRelativePath}/transcript.md` : null;
  if (transcriptRelativePath) {
    await atomicWrite(
      path.join(workingEntryPath, "transcript.md"),
      journalTranscriptMarkdown({
        entryId,
        capturedAt: parts.isoWithOffset,
        timezone: input.journalConfig.timezone,
        kind: input.fileRef.kind,
        rawFilename,
        telegramMessageId: input.telegramMessageId,
        fileUniqueId: input.fileRef.fileUniqueId,
        sha256,
        transcriptionModel: input.appConfig.openaiTranscriptionModel,
        transcript,
      }),
    );
  }

  const metadata = {
    version: 1,
    id: entryId,
    capturedAt: parts.isoWithOffset,
    receivedAt: new Date().toISOString(),
    timezone: input.journalConfig.timezone,
    source: {
      platform: "telegram",
      messageId: input.telegramMessageId,
      fileUniqueId: input.fileRef.fileUniqueId,
      kind: input.fileRef.kind,
      authorUsername: input.authorUsername,
    },
    media: {
      rawFile: rawFilename,
      originalName: input.fileRef.originalName,
      mimeType: input.fileRef.mimeType,
      sizeBytes: rawBytes.byteLength,
      durationSeconds: input.fileRef.durationSeconds,
      sha256,
    },
    transcription: {
      status: transcriptionStatus,
      model: transcriptionApplicable ? input.appConfig.openaiTranscriptionModel : null,
      transcriptFile: transcriptRelativePath ? "transcript.md" : null,
      error: transcriptionError,
    },
  };
  await atomicWrite(path.join(workingEntryPath, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  if (!duplicate) {
    await mkdir(path.dirname(entryAbsolutePath), { recursive: true });
    await rename(workingEntryPath, entryAbsolutePath);
  }

  const indexEntry: JournalIndexEntry = {
    id: entryId,
    path: entryRelativePath,
    capturedAt: parts.isoWithOffset,
    telegramMessageId: input.telegramMessageId,
    telegramFileUniqueId: input.fileRef.fileUniqueId,
    sha256,
    kind: input.fileRef.kind,
    transcriptionStatus,
  };
  index.entries = index.entries.filter((entry) => entry.id !== entryId);
  index.entries.push(indexEntry);
  index.entries.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
  await atomicWrite(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  const monthlyIndexRelativePath = path.posix.join(input.journalConfig.indexDirectory, parts.year, `${parts.month}.md`);
  await writeMonthlyIndex(input.repoPath, monthlyIndexRelativePath, index, parts.year, parts.month);

  let commitHash: string | null = null;
  let pushed = false;
  let pushError: string | null = null;
  if (input.journalConfig.autoCommit) {
    await git(input.repoPath, [
      "add",
      "--",
      entryRelativePath,
      path.posix.join(input.journalConfig.entriesDirectory, "index.json"),
      monthlyIndexRelativePath,
    ]);
    await git(input.repoPath, ["commit", "-m", `journal: add ${entryId}`]);
    commitHash = (await git(input.repoPath, ["rev-parse", "HEAD"])).stdout;
    if (input.journalConfig.autoPush) {
      try {
        await git(input.repoPath, ["push", "origin", "HEAD"]);
        pushed = true;
      } catch (error) {
        pushError = errorMessage(error);
      }
    }
  }

  return {
    entryPath: entryRelativePath,
    transcriptPath: transcriptRelativePath,
    commitHash,
    pushed,
    duplicate: false,
    transcriptionStatus,
    transcriptionError,
    pushError,
  };
}

async function readJournalIndex(indexPath: string): Promise<JournalIndex> {
  try {
    const parsed = JSON.parse(await readFile(indexPath, "utf8")) as JournalIndex;
    return parsed.version === 1 && Array.isArray(parsed.entries) ? parsed : { version: 1, entries: [] };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { version: 1, entries: [] };
    }
    throw new Error(`Could not read journal index: ${errorMessage(error)}`);
  }
}

async function writeMonthlyIndex(
  repoPath: string,
  relativePath: string,
  index: JournalIndex,
  year: string,
  month: string,
): Promise<void> {
  const sourceDirectory = path.posix.dirname(relativePath);
  const entries = index.entries.filter((entry) => entry.capturedAt.startsWith(`${year}-${month}-`));
  const lines = [
    `# Journal entries for ${year}-${month}`,
    "",
    ...entries.map((entry) => {
      const filename = entry.transcriptionStatus === "complete" ? "transcript.md" : "metadata.json";
      const target = path.posix.relative(sourceDirectory, `${entry.path}/${filename}`);
      const suffix = entry.transcriptionStatus === "failed"
        ? " (transcription failed)"
        : entry.transcriptionStatus === "not_applicable" ? " (no transcription needed)" : "";
      return `- [${entry.capturedAt}](${target})${suffix}`;
    }),
    "",
  ];
  await atomicWrite(path.join(repoPath, ...relativePath.split("/")), lines.join("\n"));
}

async function existingRawFilename(entryPath: string): Promise<string> {
  const metadata = JSON.parse(await readFile(path.join(entryPath, "metadata.json"), "utf8")) as {
    media?: { rawFile?: unknown };
  };
  if (typeof metadata.media?.rawFile !== "string") {
    throw new Error("Existing journal entry does not identify its raw media file.");
  }
  return metadata.media.rawFile;
}

async function atomicWrite(destination: string, content: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, destination);
}

async function ensureCleanRepository(repoPath: string): Promise<void> {
  const status = (await git(repoPath, ["status", "--porcelain", "--untracked-files=all"])).stdout;
  if (status) {
    throw new Error(`Journal repository has uncommitted changes:\n${status}`);
  }
}

function isRecoverableJournalStatus(line: string, config: JournalConfig): boolean {
  const status = line.slice(0, 2);
  const filePath = line.slice(3).replace(/^"|"$/g, "");
  const entriesPrefix = `${config.entriesDirectory}/`;
  const indexesPrefix = `${config.indexDirectory}/`;
  if (filePath === `${config.entriesDirectory}/index.json` || filePath.startsWith(indexesPrefix)) {
    return true;
  }
  return (status === "??" || status === "A ")
    && filePath.startsWith(entriesPrefix)
    && filePath !== `${config.entriesDirectory}/index.json`;
}

async function rebuildJournalIndex(repoPath: string, config: JournalConfig): Promise<JournalIndex> {
  const entriesRoot = path.join(repoPath, config.entriesDirectory);
  const metadataFiles = await findMetadataFiles(entriesRoot);
  const entries: JournalIndexEntry[] = [];
  for (const metadataPath of metadataFiles) {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      id?: unknown;
      capturedAt?: unknown;
      source?: { messageId?: unknown; fileUniqueId?: unknown; kind?: unknown };
      media?: { sha256?: unknown };
      transcription?: { status?: unknown };
    };
    if (
      typeof metadata.id !== "string"
      || typeof metadata.capturedAt !== "string"
      || typeof metadata.source?.messageId !== "number"
      || typeof metadata.source.fileUniqueId !== "string"
      || typeof metadata.source.kind !== "string"
      || typeof metadata.media?.sha256 !== "string"
      || (metadata.transcription?.status !== "complete"
        && metadata.transcription?.status !== "failed"
        && metadata.transcription?.status !== "not_applicable")
    ) {
      continue;
    }
    entries.push({
      id: metadata.id,
      path: path.relative(repoPath, path.dirname(metadataPath)).split(path.sep).join("/"),
      capturedAt: metadata.capturedAt,
      telegramMessageId: metadata.source.messageId,
      telegramFileUniqueId: metadata.source.fileUniqueId,
      sha256: metadata.media.sha256,
      kind: metadata.source.kind,
      transcriptionStatus: metadata.transcription.status,
    });
  }
  entries.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
  return { version: 1, entries };
}

async function findMetadataFiles(directory: string): Promise<string[]> {
  let items;
  try {
    items = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const files: string[] = [];
  for (const item of items) {
    const itemPath = path.join(directory, item.name);
    if (item.isDirectory()) {
      files.push(...await findMetadataFiles(itemPath));
    } else if (item.isFile() && item.name === "metadata.json") {
      files.push(itemPath);
    }
  }
  return files;
}

async function hasStagedChanges(repoPath: string): Promise<boolean> {
  try {
    await git(repoPath, ["diff", "--cached", "--quiet"]);
    return false;
  } catch {
    return true;
  }
}

async function git(repoPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", args, {
    cwd: repoPath,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function withJournalLock<T>(repoPath: string, action: () => Promise<T>): Promise<T> {
  const previous = journalLocks.get(repoPath) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  journalLocks.set(repoPath, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (journalLocks.get(repoPath) === tail) {
      journalLocks.delete(repoPath);
    }
  }
}

interface ZonedDateParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  offset: string;
  isoWithOffset: string;
}

export function zonedDateParts(date: Date, timezone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  });
  const values = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const offset = (values.timeZoneName ?? "GMT+00:00").replace(/^GMT/, "");
  const normalizedOffset = offset === "" ? "+00:00" : offset;
  const result = {
    year: requiredPart(values.year, "year"),
    month: requiredPart(values.month, "month"),
    day: requiredPart(values.day, "day"),
    hour: requiredPart(values.hour, "hour"),
    minute: requiredPart(values.minute, "minute"),
    second: requiredPart(values.second, "second"),
    offset: normalizedOffset,
  };
  return {
    ...result,
    isoWithOffset: `${result.year}-${result.month}-${result.day}T${result.hour}:${result.minute}:${result.second}${normalizedOffset}`,
  };
}

function journalEntryId(parts: ZonedDateParts, messageId: number, fileUniqueId: string): string {
  const offset = parts.offset.replace(":", "-");
  const unique = fileUniqueId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 10) || "file";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}-${parts.minute}-${parts.second}${offset}-msg-${messageId}-${unique}`;
}

function journalTranscriptMarkdown(input: {
  entryId: string;
  capturedAt: string;
  timezone: string;
  kind: string;
  rawFilename: string;
  telegramMessageId: number;
  fileUniqueId: string;
  sha256: string;
  transcriptionModel: string;
  transcript: string;
}): string {
  return [
    "---",
    `id: ${JSON.stringify(input.entryId)}`,
    `captured_at: ${JSON.stringify(input.capturedAt)}`,
    `timezone: ${JSON.stringify(input.timezone)}`,
    `source_type: ${JSON.stringify(input.kind)}`,
    `raw_file: ${JSON.stringify(input.rawFilename)}`,
    `telegram_message_id: ${input.telegramMessageId}`,
    `telegram_file_unique_id: ${JSON.stringify(input.fileUniqueId)}`,
    `sha256: ${JSON.stringify(input.sha256)}`,
    `transcription_model: ${JSON.stringify(input.transcriptionModel)}`,
    "---",
    "",
    `# Journal entry ${input.capturedAt}`,
    "",
    input.transcript,
    "",
  ].join("\n");
}

function safeExtension(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ".bin";
}

function isVideoRef(ref: TelegramFileRef): boolean {
  return ref.kind === "video" || ref.kind === "video_note" || ref.mimeType?.toLowerCase().startsWith("video/") === true;
}

function isTranscribableJournalMedia(ref: TelegramFileRef): boolean {
  if (ref.kind === "voice" || ref.kind === "audio" || isVideoRef(ref)) {
    return true;
  }
  return ref.mimeType?.toLowerCase().startsWith("audio/") === true;
}

function safeRelativeDirectory(value: unknown, label: string): string {
  const directory = requiredString(value, label).replace(/\\/g, "/").replace(/\/$/, "");
  if (path.posix.isAbsolute(directory) || directory === "." || directory.split("/").includes("..")) {
    throw new Error(`journal.config.json ${label} must be a safe relative directory.`);
  }
  return directory;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`journal.config.json ${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredPart(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`Could not calculate journal ${label}.`);
  }
  return value;
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`journal.config.json timezone is invalid: ${timezone}`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
