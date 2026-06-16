import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { AsyncQueue } from "./asyncQueue.js";
import type { AppConfig } from "./config.js";
import type { CodexBackend, CodexRunEvent, CodexRunRequest, ThreadTokenUsageSnapshot } from "./types.js";
import { logger } from "./logger.js";

interface ActiveAcpTurn {
  connection: acp.ClientSideConnection;
  sessionId: string;
  proc: ChildProcess;
}

interface AcpAgentBackendOptions {
  label: string;
  command: string;
  args: string[];
  modelInsertBefore?: string;
  yoloArgs?: string[];
}

export class AcpAgentBackend implements CodexBackend {
  private readonly active = new Map<number, ActiveAcpTurn>();

  constructor(private readonly options: AcpAgentBackendOptions) {}

  async *run(request: CodexRunRequest): AsyncIterable<CodexRunEvent> {
    const proc = spawn(this.options.command, acpAgentArgsForRequest(this.options, request), {
      cwd: request.repoPath,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events = new AsyncQueue<CodexRunEvent>();
    let finalMessage = "";
    let stderr = "";

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
      if (stderr.length > 20_000) {
        stderr = stderr.slice(-20_000);
      }
    });

    proc.once("error", (error) => {
      logger.error(`${this.options.label.toLowerCase()} acp process error`, {
        bindingId: request.bindingId,
        error: error.message,
      });
      events.push({ type: "failed", error: error.message });
      events.close();
    });

    if (!proc.stdin || !proc.stdout) {
      proc.kill();
      yield { type: "failed", error: `${this.options.label} ACP process did not expose stdio pipes.` };
      return;
    }

    const connection = new acp.ClientSideConnection(
      () => new TelegramAcpClient(this.options.label, events, request, (text) => {
        finalMessage = text;
      }),
      acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout)),
    );

    try {
      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: false,
            writeTextFile: false,
          },
          terminal: false,
        },
        clientInfo: {
          name: "codex-cli-over-telegram",
          version: "0.1.0",
        },
      });

      const session = await this.startOrResumeSession(connection, request);
      this.active.set(request.bindingId, { connection, sessionId: session.sessionId, proc });
      events.push({
        type: "started",
        threadId: session.sessionId,
        text: `Started ${this.options.label} ACP session ${session.sessionId}`,
      });

      const promptPromise = connection
        .prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: request.prompt }],
        })
        .then((response) => {
          const stopReason = response.stopReason;
          if (stopReason === "end_turn") {
            events.push({ type: "completed", finalMessage });
          } else if (stopReason === "cancelled") {
            events.push({ type: "failed", error: `${this.options.label} ACP turn was cancelled.` });
          } else {
            events.push({ type: "completed", finalMessage: finalMessage || `${this.options.label} stopped: ${stopReason}` });
          }
        })
        .catch((error) => {
          events.push({
            type: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => events.close());

      for await (const event of events) {
        yield event;
      }

      await promptPromise;
    } catch (error) {
      yield {
        type: "failed",
        error: `${error instanceof Error ? error.message : String(error)}${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
      };
    } finally {
      this.active.delete(request.bindingId);
      proc.kill();
    }
  }

  async interrupt(bindingId: number): Promise<boolean> {
    const active = this.active.get(bindingId);
    if (!active) {
      return false;
    }
    await active.connection.cancel({ sessionId: active.sessionId }).catch(() => undefined);
    active.proc.kill();
    this.active.delete(bindingId);
    return true;
  }

  private async startOrResumeSession(
    connection: acp.ClientSideConnection,
    request: CodexRunRequest,
  ): Promise<{ sessionId: string }> {
    if (request.codexThreadId) {
      try {
        await connection.resumeSession({
          sessionId: request.codexThreadId,
          cwd: request.repoPath,
          mcpServers: [],
        });
        return { sessionId: request.codexThreadId };
      } catch (error) {
        logger.warn(`failed to resume ${this.options.label.toLowerCase()} acp session; starting a new one`, {
          sessionId: request.codexThreadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return await connection.newSession({
      cwd: request.repoPath,
      mcpServers: [],
    });
  }
}

export class GrokAcpBackend extends AcpAgentBackend {
  constructor(config: AppConfig) {
    super({
      label: "Grok",
      command: config.grokAgentCommand,
      args: config.grokAgentArgs,
      modelInsertBefore: "stdio",
      yoloArgs: ["--always-approve"],
    });
  }
}

export class ClaudeAcpBackend extends AcpAgentBackend {
  constructor(config: AppConfig) {
    super({
      label: "Claude",
      command: config.claudeAcpCommand,
      args: config.claudeAcpArgs,
    });
  }
}

class TelegramAcpClient {
  private readonly toolLabels = new Map<string, string>();
  private readonly xaiToolCalls = new Map<string, XaiToolCallState>();
  private readonly xaiToolCallIdsByIndex = new Map<number, string>();
  private readonly xaiEmittedToolCalls = new Set<string>();
  private readonly agentMessages = new Map<string, string>();

  constructor(
    private readonly label: string,
    private readonly events: AsyncQueue<CodexRunEvent>,
    private readonly request: CodexRunRequest,
    private readonly onAgentMessage: (text: string) => void,
  ) {}

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          const messageId = update.messageId ?? "default";
          const text = `${this.agentMessages.get(messageId) ?? ""}${update.content.text}`;
          this.agentMessages.set(messageId, text);
          this.onAgentMessage([...this.agentMessages.values()].join("\n\n"));
          this.events.push({ type: "agent_message_delta", text: update.content.text, messageId });
        }
        return;
      case "agent_thought_chunk":
        if (update.content.type === "text") {
          this.events.push({ type: "progress", text: update.content.text });
        }
        return;
      case "tool_call":
        this.toolLabels.set(update.toolCallId, formatToolCall(update));
        this.events.push({ type: "command_started", text: this.toolLabels.get(update.toolCallId) ?? update.title });
        return;
      case "tool_call_update":
        this.toolLabels.set(update.toolCallId, formatToolCall(update, this.toolLabels.get(update.toolCallId)));
        if (update.status === "completed") {
          return;
        }
        this.events.push({
          type: "progress",
          text: `${this.toolLabels.get(update.toolCallId) ?? `Tool ${update.toolCallId}`}${update.status ? ` ${update.status}` : ""}`,
        });
        return;
      case "usage_update":
        this.events.push({ type: "token_usage", tokenUsage: acpUsageToThreadUsage(update) });
        return;
      case "plan":
        this.events.push({ type: "progress", text: `${this.label} produced a plan.` });
        return;
      default:
        return;
    }
  }

  async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    if (method === "_x.ai/session_notification") {
      this.handleXaiSessionNotification(params);
      return;
    }

    if (
      method === "_x.ai/queue/changed" ||
      method === "_x.ai/session/prompt_complete" ||
      method === "_x.ai/sessions/changed" ||
      method.startsWith("_x.ai/")
    ) {
      return;
    }

    logger.debug("ignored acp extension notification", { method });
  }

  private handleXaiSessionNotification(params: Record<string, unknown>): void {
    const update = objectRecord(params.update);
    if (!update) {
      return;
    }
    const sessionUpdate = stringValue(update.sessionUpdate);
    if (sessionUpdate === "tool_call_delta_chunk") {
      this.handleXaiToolCallDelta(update);
    }
  }

  private handleXaiToolCallDelta(update: Record<string, unknown>): void {
    const toolIndex = numberValue(update.tool_index);
    const explicitToolCallId = stringValue(update.tool_call_id);
    const toolCallId =
      explicitToolCallId ??
      (typeof toolIndex === "number" ? this.xaiToolCallIdsByIndex.get(toolIndex) : null) ??
      `tool-${toolIndex ?? 0}`;
    if (explicitToolCallId && typeof toolIndex === "number") {
      this.xaiToolCallIdsByIndex.set(toolIndex, explicitToolCallId);
    }

    const state = this.xaiToolCalls.get(toolCallId) ?? {
      id: toolCallId,
      name: null,
      argsJson: "",
    };

    const name = stringValue(update.name);
    if (name) {
      state.name = name;
    }

    const argsDelta = stringValue(update.arguments_delta);
    if (argsDelta) {
      state.argsJson += argsDelta;
    }

    this.xaiToolCalls.set(toolCallId, state);

    const label = formatXaiToolCall(state);
    if (!label || this.xaiEmittedToolCalls.has(toolCallId)) {
      return;
    }

    this.xaiEmittedToolCalls.add(toolCallId);
    this.toolLabels.set(toolCallId, label);
    this.events.push({ type: "command_started", text: label });
  }

  async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const preferred =
      this.request.sandboxMode === "danger-full-access"
        ? (params.options.find((option) => option.kind === "allow_once") ??
          params.options.find((option) => option.kind === "allow_always"))
        : (params.options.find((option) => option.kind === "reject_once") ??
          params.options.find((option) => option.kind === "reject_always"));

    if (!preferred) {
      return { outcome: { outcome: "cancelled" } };
    }

    this.events.push({ type: "progress", text: `${this.label} permission: ${params.toolCall.title} -> ${preferred.name}` });
    return { outcome: { outcome: "selected", optionId: preferred.optionId } };
  }

  async readTextFile(): Promise<acp.ReadTextFileResponse> {
    throw new Error("ACP file reads are not enabled for Telegram runs.");
  }

  async writeTextFile(): Promise<acp.WriteTextFileResponse> {
    throw new Error("ACP file writes are not enabled for Telegram runs.");
  }
}

interface XaiToolCallState {
  id: string;
  name: string | null;
  argsJson: string;
}

function formatToolCall(tool: acp.ToolCall | acp.ToolCallUpdate, fallback?: string): string {
  const title = (typeof tool.title === "string" && tool.title.trim()) || fallback || `Tool ${tool.toolCallId}`;
  const details = [
    ...formatLocations(tool.locations),
    ...formatRawObject(tool.rawInput),
    ...formatContent(tool.content),
    ...formatRawObject(tool.rawOutput, { output: true }),
  ];
  return details.length > 0 ? `${title}: ${dedupe(details).join(", ")}` : title;
}

function formatXaiToolCall(state: XaiToolCallState): string | null {
  if (!state.name) {
    return null;
  }

  const args = parseJsonObject(state.argsJson);
  if (state.argsJson.trim() && !args) {
    return null;
  }

  const details = args ? formatRawObject(args) : [];
  if (details.length === 0 && !state.argsJson.trim()) {
    return null;
  }

  const title = formatToolName(state.name);
  return details.length > 0 ? `${title}: ${dedupe(details).join(", ")}` : title;
}

function formatToolName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  if (!value.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return objectRecord(parsed);
  } catch {
    return null;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatLocations(locations: Array<acp.ToolCallLocation> | null | undefined): string[] {
  if (!locations) {
    return [];
  }
  return locations.map((location) => `${location.path}${location.line ? `:${location.line}` : ""}`);
}

function formatRawObject(value: unknown, options: { output?: boolean } = {}): string[] {
  if (!value || typeof value !== "object") {
    return typeof value === "string" && value.trim() ? [truncateOneLine(value)] : [];
  }

  const record = value as Record<string, unknown>;
  const preferredKeys = options.output
    ? ["path", "file", "file_path", "dir", "directory", "command", "cmd", "query", "pattern", "error"]
    : ["path", "file", "file_path", "dir", "directory", "command", "cmd", "query", "pattern"];
  const values = preferredKeys
    .map((key) => record[key])
    .flatMap((item) => formatRawValue(item));

  if (values.length > 0) {
    return values;
  }

  return [truncateOneLine(JSON.stringify(value))];
}

function formatRawValue(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) {
    return [truncateOneLine(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap(formatRawValue);
  }
  if (value && typeof value === "object") {
    return [truncateOneLine(JSON.stringify(value))];
  }
  return [];
}

function formatContent(content: Array<acp.ToolCallContent> | null | undefined): string[] {
  if (!content) {
    return [];
  }
  return content.flatMap((item) => {
    if (item.type === "content" && item.content.type === "text") {
      return [truncateOneLine(item.content.text)];
    }
    if (item.type === "diff") {
      return ["diff"];
    }
    if (item.type === "terminal") {
      return [`terminal ${item.terminalId}`];
    }
    return [];
  });
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function truncateOneLine(value: string, maxLength = 160): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 1)}...` : oneLine;
}

function acpUsageToThreadUsage(update: acp.UsageUpdate): ThreadTokenUsageSnapshot {
  const total = {
    totalTokens: update.used,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
  return {
    total,
    last: total,
    modelContextWindow: update.size,
  };
}

function acpAgentArgsForRequest(options: AcpAgentBackendOptions, request: CodexRunRequest): string[] {
  const args = [...options.args];
  const insertBeforeIndex = options.modelInsertBefore ? args.lastIndexOf(options.modelInsertBefore) : -1;
  const insertIndex = insertBeforeIndex >= 0 ? insertBeforeIndex : args.length;

  if (request.model) {
    args.splice(insertIndex, 0, "--model", request.model);
  }
  if (request.sandboxMode === "danger-full-access" && options.yoloArgs) {
    args.splice(insertIndex, 0, ...options.yoloArgs);
  }

  return args;
}
