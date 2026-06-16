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

export class GrokAcpBackend implements CodexBackend {
  private readonly active = new Map<number, ActiveAcpTurn>();

  constructor(private readonly config: AppConfig) {}

  async *run(request: CodexRunRequest): AsyncIterable<CodexRunEvent> {
    const proc = spawn(this.config.grokAgentCommand, grokAgentArgsForRequest(this.config, request), {
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
      logger.error("grok acp process error", { bindingId: request.bindingId, error: error.message });
      events.push({ type: "failed", error: error.message });
      events.close();
    });

    if (!proc.stdin || !proc.stdout) {
      proc.kill();
      yield { type: "failed", error: "Grok ACP process did not expose stdio pipes." };
      return;
    }

    const connection = new acp.ClientSideConnection(
      () => new TelegramAcpClient(events, request),
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
        text: `Started Grok ACP session ${session.sessionId}`,
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
            events.push({ type: "failed", error: "Grok ACP turn was cancelled." });
          } else {
            events.push({ type: "completed", finalMessage: finalMessage || `Grok stopped: ${stopReason}` });
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
        if (event.type === "agent_message") {
          finalMessage = event.text;
        }
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
        logger.warn("failed to resume grok acp session; starting a new one", {
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

class TelegramAcpClient {
  private readonly toolLabels = new Map<string, string>();

  constructor(
    private readonly events: AsyncQueue<CodexRunEvent>,
    private readonly request: CodexRunRequest,
  ) {}

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          this.events.push({ type: "agent_message", text: update.content.text });
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
        this.events.push({
          type: update.status === "completed" ? "command_completed" : "progress",
          text: `${this.toolLabels.get(update.toolCallId) ?? `Tool ${update.toolCallId}`}${update.status ? ` ${update.status}` : ""}`,
        });
        return;
      case "usage_update":
        this.events.push({ type: "token_usage", tokenUsage: acpUsageToThreadUsage(update) });
        return;
      case "plan":
        this.events.push({ type: "progress", text: "Grok produced a plan." });
        return;
      default:
        return;
    }
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

    this.events.push({ type: "progress", text: `Grok permission: ${params.toolCall.title} -> ${preferred.name}` });
    return { outcome: { outcome: "selected", optionId: preferred.optionId } };
  }

  async readTextFile(): Promise<acp.ReadTextFileResponse> {
    throw new Error("ACP file reads are not enabled for Telegram runs.");
  }

  async writeTextFile(): Promise<acp.WriteTextFileResponse> {
    throw new Error("ACP file writes are not enabled for Telegram runs.");
  }
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

function grokAgentArgsForRequest(config: AppConfig, request: CodexRunRequest): string[] {
  const args = [...config.grokAgentArgs];
  const stdioIndex = args.lastIndexOf("stdio");
  const insertIndex = stdioIndex >= 0 ? stdioIndex : args.length;

  if (request.model) {
    args.splice(insertIndex, 0, "--model", request.model);
  }
  if (request.sandboxMode === "danger-full-access") {
    args.splice(insertIndex, 0, "--always-approve");
  }

  return args;
}
