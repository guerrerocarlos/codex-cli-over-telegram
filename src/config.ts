import "dotenv/config";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import type { ModelProvider, SandboxMode } from "./types.js";

export type CodexBackendKind = "app-server" | "exec";

export interface AppConfig {
  telegramBotToken: string;
  allowedTelegramUserIds: Set<number>;
  allowedTelegramChatIds: Set<number>;
  allowedTelegramChatIdsFile: string;
  approvalTelegramChatId: number | null;
  approvalTelegramMessageThreadId: number;
  allowedRepoRoots: string[];
  databasePath: string;
  codexBin: string;
  codexBackend: CodexBackendKind;
  defaultModelProvider: ModelProvider;
  xaiProviderId: string;
  xaiBaseUrl: string;
  xaiApiKeyEnv: string;
  xaiModels: string[];
  openaiTieredModels: string[];
  openaiServiceTiers: string[];
  grokAgentCommand: string;
  grokAgentArgs: string[];
  claudeAcpCommand: string;
  claudeAcpArgs: string[];
  claudeModels: string[];
  defaultSandboxMode: SandboxMode;
  alwaysYoloMode: boolean;
  maxParallelRuns: number;
  maxTelegramMessageChars: number;
  telegramSendIntervalMs: number;
  telegramAgentStreaming: boolean;
  telegramStreamFlushMs: number;
  telegramStreamMinChars: number;
  maxTelegramFileBytes: number;
  openaiApiKey: string | null;
  openaiTranscriptionModel: string;
  ffmpegBin: string;
  healthHost: string;
  healthPort: number;
  allowUnthreadedChats: boolean;
  managerRepoPath: string;
  managerBridgeToken: string;
  deployBranch: string;
  deployCommitHash: string;
  deployedAt: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function expandHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function parseNumberList(name: string): Set<number> {
  const raw = process.env[name]?.trim();
  return parseNumberListRaw(name, raw ?? "");
}

function parseNumberListRaw(name: string, raw: string): Set<number> {
  if (!raw) {
    return new Set();
  }

  const values = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const value = Number(item);
      if (!Number.isSafeInteger(value)) {
        throw new Error(`${name} contains a non-integer value: ${item}`);
      }
      return value;
    });

  return new Set(values);
}

function parseNumberListFile(pathValue: string, label: string): Set<number> {
  let raw: string;
  try {
    raw = readFileSync(pathValue, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") {
      return new Set();
    }
    throw error;
  }

  const values = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean)
    .join(",");
  return parseNumberListRaw(label, values);
}

function optionalInteger(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

function parseRepoRoots(): string[] {
  const raw = required("ALLOWED_REPO_ROOTS");
  const roots = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));

  if (roots.length === 0) {
    throw new Error("ALLOWED_REPO_ROOTS must contain at least one path");
  }

  return roots;
}

function parseSandboxMode(): SandboxMode {
  const mode = optional("DEFAULT_SANDBOX_MODE", "read-only");
  if (mode === "read-only" || mode === "workspace-write" || mode === "danger-full-access") {
    return mode;
  }
  throw new Error("DEFAULT_SANDBOX_MODE must be read-only, workspace-write, or danger-full-access");
}

function parseCodexBackend(): CodexBackendKind {
  const backend = optional("CODEX_BACKEND", "app-server");
  if (backend === "app-server" || backend === "exec") {
    return backend;
  }
  throw new Error("CODEX_BACKEND must be app-server or exec");
}

function parseModelProvider(name: string, fallback: ModelProvider): ModelProvider {
  const provider = optional(name, fallback);
  if (provider === "openai" || provider === "xai" || provider === "claude") {
    return provider;
  }
  throw new Error(`${name} must be openai, xai, or claude`);
}

function parseStringList(name: string, fallback: string): string[] {
  return optional(name, fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseInteger(name: string, fallback: number): number {
  const raw = optional(name, String(fallback));
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const raw = optional(name, String(fallback)).toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  throw new Error(`${name} must be a boolean`);
}

function localBin(name: string): string {
  return path.resolve(process.cwd(), "node_modules", ".bin", name);
}

export function loadConfig(): AppConfig {
  const databasePath = path.resolve(optional("DATABASE_PATH", "./data/state.sqlite"));
  const managerRepoPath = path.resolve(expandHome(optional("MANAGER_REPO_PATH", "~/topic-zero")));
  const managerBridgeToken = optional("MANAGER_BRIDGE_TOKEN", randomBytes(32).toString("hex"));
  const extraTelegramUsersFile = path.resolve(expandHome(optional("ALLOWED_TELEGRAM_USER_IDS_FILE", "./data/allowed-telegram-users.txt")));
  const extraTelegramChatsFile = path.resolve(expandHome(optional("ALLOWED_TELEGRAM_CHAT_IDS_FILE", "./data/allowed-telegram-chats.txt")));
  mkdirSync(path.dirname(databasePath), { recursive: true });
  mkdirSync(managerRepoPath, { recursive: true });

  const allowedTelegramUserIds = new Set([
    ...parseNumberList("ALLOWED_TELEGRAM_USER_IDS"),
    ...parseNumberListFile(extraTelegramUsersFile, "ALLOWED_TELEGRAM_USER_IDS_FILE"),
  ]);
  const allowedTelegramChatIds = new Set([
    ...parseNumberList("ALLOWED_TELEGRAM_CHAT_IDS"),
    ...parseNumberListFile(extraTelegramChatsFile, "ALLOWED_TELEGRAM_CHAT_IDS_FILE"),
  ]);
  const approvalTelegramChatId = optionalInteger("TELEGRAM_APPROVAL_CHAT_ID") ?? [...allowedTelegramChatIds][0] ?? null;

  return {
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    allowedTelegramUserIds,
    allowedTelegramChatIds,
    allowedTelegramChatIdsFile: extraTelegramChatsFile,
    approvalTelegramChatId,
    approvalTelegramMessageThreadId: optionalInteger("TELEGRAM_APPROVAL_MESSAGE_THREAD_ID") ?? 0,
    allowedRepoRoots: parseRepoRoots(),
    databasePath,
    codexBin: optional("CODEX_BIN", "codex"),
    codexBackend: parseCodexBackend(),
    defaultModelProvider: parseModelProvider("DEFAULT_MODEL_PROVIDER", "openai"),
    xaiProviderId: optional("XAI_CODEX_PROVIDER_ID", "xai"),
    xaiBaseUrl: optional("XAI_BASE_URL", "https://api.x.ai/v1"),
    xaiApiKeyEnv: optional("XAI_API_KEY_ENV", "XAI_API_KEY"),
    xaiModels: parseStringList("XAI_MODELS", "grok-4.3,grok-build-0.1"),
    openaiTieredModels: parseStringList("OPENAI_TIERED_MODELS", "gpt-5.5"),
    openaiServiceTiers: parseStringList("OPENAI_SERVICE_TIERS", "fast,flex"),
    grokAgentCommand: optional("GROK_AGENT_COMMAND", "grok"),
    grokAgentArgs: parseStringList("GROK_AGENT_ARGS", "agent,stdio"),
    claudeAcpCommand: optional("CLAUDE_ACP_COMMAND", localBin("claude-agent-acp")),
    claudeAcpArgs: parseStringList("CLAUDE_ACP_ARGS", ""),
    claudeModels: parseStringList("CLAUDE_MODELS", "sonnet,opus,fable"),
    defaultSandboxMode: parseSandboxMode(),
    alwaysYoloMode: parseBoolean("CODEX_ALWAYS_YOLO", false),
    maxParallelRuns: parseInteger("MAX_PARALLEL_RUNS", 4),
    maxTelegramMessageChars: parseInteger("MAX_TELEGRAM_MESSAGE_CHARS", 3500),
    telegramSendIntervalMs: parseInteger("TELEGRAM_SEND_INTERVAL_MS", 3500),
    telegramAgentStreaming: parseBoolean("TELEGRAM_AGENT_STREAMING", true),
    telegramStreamFlushMs: parseInteger("TELEGRAM_STREAM_FLUSH_MS", 1000),
    telegramStreamMinChars: parseInteger("TELEGRAM_STREAM_MIN_CHARS", 120),
    maxTelegramFileBytes: parseInteger("MAX_TELEGRAM_FILE_BYTES", 20 * 1024 * 1024),
    openaiApiKey: process.env.OPENAI_API_KEY?.trim() || null,
    openaiTranscriptionModel: optional("OPENAI_TRANSCRIPTION_MODEL", "gpt-4o-transcribe"),
    ffmpegBin: optional("FFMPEG_BIN", "ffmpeg"),
    healthHost: optional("HEALTH_HOST", "127.0.0.1"),
    healthPort: parseInteger("HEALTH_PORT", 8787),
    allowUnthreadedChats: parseBoolean("ALLOW_UNTHREADED_CHATS", false),
    managerRepoPath,
    managerBridgeToken,
    deployBranch: optional("DEPLOY_BRANCH", "unknown"),
    deployCommitHash: optional("DEPLOY_COMMIT_HASH", "unknown"),
    deployedAt: optional("DEPLOYED_AT", "unknown"),
  };
}

export function formatIdSet(ids: Set<number>): string {
  return [...ids].join(",");
}
