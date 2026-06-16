import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerClient } from "./appServerClient.js";
import { AsyncQueue } from "./asyncQueue.js";
import { describeCommandOutput } from "./commandOutput.js";
import { codexProviderArgs } from "./modelProviders.js";
import { PLAN_MODE_DEVELOPER_INSTRUCTIONS } from "./planMode.js";
import type { AppConfig } from "./config.js";
import type {
  CodexBackend,
  CodexRunEvent,
  CodexRunRequest,
  SandboxMode,
  ThreadTokenUsageSnapshot,
} from "./types.js";
import { logger } from "./logger.js";

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

interface ActiveTurn {
  client: AppServerClient;
  threadId: string;
  turnId: string;
}

interface RpcThreadResponse {
  thread?: {
    id?: string;
  };
}

interface RpcTurnResponse {
  turn?: {
    id?: string;
  };
}

interface Notification {
  method: string;
  params?: any;
}

export class CodexAppServerBackend implements CodexBackend {
  private readonly active = new Map<number, ActiveTurn>();
  private readonly managerBridgeMcpPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "managerBridgeMcp.js",
  );

  constructor(private readonly config: AppConfig) {}

  async *run(request: CodexRunRequest): AsyncIterable<CodexRunEvent> {
    const client = new AppServerClient(this.config.codexBin, this.appServerOptions(request));
    const events = new AsyncQueue<CodexRunEvent>();
    let finalMessage = "";
    let threadId = request.codexThreadId;
    let turnId: string | null = null;

    client.onServerRequest((serverRequest, rpcClient) => {
      events.push({
        type: "progress",
        text:
          serverRequest.method === "mcpServer/elicitation/request" &&
          (serverRequest.params as any)?.serverName === "telegram_manager"
            ? "Telegram manager MCP elicitation accepted."
            : `Approval or input request declined: ${serverRequest.method}`,
      });
      this.declineServerRequest(serverRequest.method, serverRequest.id, serverRequest.params, rpcClient);
    });

    const unsubscribe = client.onNotification((notification) => {
      const mapped = this.mapNotification(notification, threadId, turnId);
      if (!mapped) {
        return;
      }

      if (mapped.type === "agent_message") {
        finalMessage = mapped.text;
      }

      events.push(mapped);

      if (mapped.type === "completed" || mapped.type === "failed") {
        events.close();
      }
    });

    try {
      await client.initialize();
      const threadResponse = await this.startOrResumeThread(client, request);

      threadId = threadResponse.thread?.id ?? request.codexThreadId;
      if (!threadId) {
        throw new Error("app-server did not return a thread id");
      }

      events.push({ type: "started", threadId, text: `Started app-server thread ${threadId}` });

      const turnResponse = (await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: request.prompt, text_elements: [] }],
        cwd: request.repoPath,
        model: request.model,
        approvalPolicy: request.approvalPolicy,
      })) as RpcTurnResponse;

      turnId = turnResponse.turn?.id ?? null;
      if (!turnId) {
        throw new Error("app-server did not return a turn id");
      }

      this.active.set(request.bindingId, { client, threadId, turnId });

      for await (const event of events) {
        if (event.type === "completed" && !event.finalMessage) {
          yield { type: "completed", finalMessage };
          continue;
        }
        yield event;
      }
    } catch (error) {
      yield {
        type: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      unsubscribe();
      this.active.delete(request.bindingId);
      client.close();
    }
  }

  async interrupt(bindingId: number): Promise<boolean> {
    const active = this.active.get(bindingId);
    if (!active) {
      return false;
    }

    await active.client.request("turn/interrupt", {
      threadId: active.threadId,
      turnId: active.turnId,
    });
    return true;
  }

  async steer(bindingId: number, prompt: string): Promise<boolean> {
    const active = this.active.get(bindingId);
    if (!active) {
      return false;
    }

    await active.client.request("turn/steer", {
      threadId: active.threadId,
      expectedTurnId: active.turnId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });
    return true;
  }

  async compactThread(threadId: string): Promise<void> {
    const client = new AppServerClient(this.config.codexBin, this.appServerOptions());
    let settled = false;

    try {
      await client.initialize();
      let cleanup = () => undefined;

      const completed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!settled) {
            reject(new Error("Timed out waiting for app-server compaction to finish"));
          }
        }, 5 * 60_000);

        const unsubscribe = client.onNotification((notification) => {
          const params = notification.params as any;
          if (params?.threadId && params.threadId !== threadId) {
            return;
          }

          if (notification.method === "thread/compacted") {
            settled = true;
            cleanup();
            resolve();
            return;
          }

          if (notification.method === "turn/completed") {
            const status = params?.turn?.status;
            if (status === "failed") {
              settled = true;
              cleanup();
              reject(new Error(params?.turn?.error?.message ?? "Codex compaction failed"));
              return;
            }
            settled = true;
            cleanup();
            resolve();
            return;
          }

          if (notification.method === "item/completed" && params?.item?.type === "contextCompaction") {
            settled = true;
            cleanup();
            resolve();
            return;
          }

          if (notification.method === "error") {
            settled = true;
            cleanup();
            reject(new Error(params?.error?.message ?? "Codex compaction failed"));
          }
        });

        cleanup = () => {
          clearTimeout(timeout);
          unsubscribe();
        };
      });

      try {
        await client.request("thread/compact/start", { threadId });
        await completed;
      } finally {
        cleanup();
      }
    } finally {
      client.close();
    }
  }

  private appServerOptions(request?: CodexRunRequest): { extraArgs: string[]; extraEnv: NodeJS.ProcessEnv } {
    const bridgeHost = this.config.healthHost === "0.0.0.0" ? "127.0.0.1" : this.config.healthHost;
    const bridgeUrl = `http://${bridgeHost}:${this.config.healthPort}/bridge`;
    const bridgeEnv: NodeJS.ProcessEnv = {
      MANAGER_BRIDGE_URL: bridgeUrl,
      MANAGER_BRIDGE_TOKEN: this.config.managerBridgeToken,
    };
    if (request) {
      bridgeEnv.MANAGER_BRIDGE_CHAT_ID = String(request.chatId);
    }
    return {
      extraArgs: [
        "-c",
        `mcp_servers.telegram_manager.command=${JSON.stringify(process.execPath)}`,
        "-c",
        `mcp_servers.telegram_manager.args=${JSON.stringify([this.managerBridgeMcpPath])}`,
        "-c",
        "mcp_servers.telegram_manager.default_tools_approval_mode=\"auto\"",
        "-c",
        "mcp_servers.telegram_manager.tools.queue_topic.approval_mode=\"auto\"",
        ...codexProviderArgs(this.config, request?.modelProvider ?? this.config.defaultModelProvider),
      ],
      extraEnv: bridgeEnv,
    };
  }

  private async startOrResumeThread(
    client: AppServerClient,
    request: CodexRunRequest,
  ): Promise<RpcThreadResponse> {
    if (request.codexThreadId) {
      try {
        return (await client.request("thread/resume", {
          threadId: request.codexThreadId,
          cwd: request.repoPath,
          model: request.model,
          developerInstructions: request.planMode ? PLAN_MODE_DEVELOPER_INSTRUCTIONS : null,
          approvalPolicy: request.approvalPolicy,
          sandbox: request.sandboxMode,
        })) as RpcThreadResponse;
      } catch (error) {
        logger.warn("failed to resume app-server thread; starting a new one", {
          threadId: request.codexThreadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return (await client.request("thread/start", {
      cwd: request.repoPath,
      model: request.model,
      developerInstructions: request.planMode ? PLAN_MODE_DEVELOPER_INSTRUCTIONS : null,
      approvalPolicy: request.approvalPolicy,
      sandbox: request.sandboxMode,
    })) as RpcThreadResponse;
  }

  private mapNotification(
    notification: Notification,
    threadId: string | null,
    turnId: string | null,
  ): CodexRunEvent | null {
    const params = notification.params;

    if (params?.threadId && threadId && params.threadId !== threadId) {
      return null;
    }
    if (params?.turnId && turnId && params.turnId !== turnId) {
      return null;
    }

    switch (notification.method) {
      case "turn/started": {
        return { type: "progress", text: "Codex turn started." };
      }
      case "thread/tokenUsage/updated": {
        const tokenUsage = this.mapTokenUsage(params?.tokenUsage);
        return tokenUsage ? { type: "token_usage", tokenUsage } : null;
      }
      case "item/agentMessage/delta": {
        return null;
      }
      case "item/started": {
        return this.mapItemStarted(params?.item);
      }
      case "item/completed": {
        return this.mapItemCompleted(params?.item);
      }
      case "turn/plan/updated": {
        const plan = Array.isArray(params?.plan)
          ? params.plan.map((step: any) => `- ${step.step ?? step.text ?? JSON.stringify(step)}`).join("\n")
          : "";
        return plan ? { type: "progress", text: `Plan updated:\n${plan}` } : null;
      }
      case "turn/completed": {
        const status = params?.turn?.status;
        if (status === "failed") {
          return {
            type: "failed",
            error: params?.turn?.error?.message ?? "Codex turn failed",
          };
        }
        if (status === "interrupted") {
          return { type: "failed", error: "Codex turn interrupted" };
        }
        const finalMessage = this.findLastAgentMessage(params?.turn?.items);
        return finalMessage ? { type: "completed", finalMessage } : { type: "completed" };
      }
      case "error": {
        return {
          type: "failed",
          error: params?.error?.message ?? "Codex app-server error",
        };
      }
      case "warning":
      case "guardianWarning":
      case "configWarning": {
        return params?.message ? { type: "progress", text: String(params.message) } : null;
      }
      case "item/fileChange/patchUpdated": {
        return { type: "file_changed", text: "File change patch updated." };
      }
      default:
        return null;
    }
  }

  private mapItemStarted(item: any): CodexRunEvent | null {
    if (!item?.type) {
      return null;
    }
    if (item.type === "commandExecution") {
      return { type: "command_started", text: item.command ?? "command" };
    }
    if (item.type === "mcpToolCall") {
      return { type: "progress", text: `Calling MCP tool ${item.server}.${item.tool}` };
    }
    if (item.type === "webSearch") {
      return { type: "progress", text: `Web search: ${item.query}` };
    }
    return null;
  }

  private mapTokenUsage(value: any): ThreadTokenUsageSnapshot | null {
    if (!value?.total || !value?.last) {
      return null;
    }
    return {
      total: this.mapTokenUsageBreakdown(value.total),
      last: this.mapTokenUsageBreakdown(value.last),
      modelContextWindow: typeof value.modelContextWindow === "number" ? value.modelContextWindow : null,
    };
  }

  private mapTokenUsageBreakdown(value: any): ThreadTokenUsageSnapshot["total"] {
    return {
      totalTokens: numberOrZero(value?.totalTokens),
      inputTokens: numberOrZero(value?.inputTokens),
      cachedInputTokens: numberOrZero(value?.cachedInputTokens),
      outputTokens: numberOrZero(value?.outputTokens),
      reasoningOutputTokens: numberOrZero(value?.reasoningOutputTokens),
    };
  }

  private mapItemCompleted(item: any): CodexRunEvent | null {
    if (!item?.type) {
      return null;
    }
    if (item.type === "agentMessage") {
      return { type: "agent_message", text: item.text ?? "" };
    }
    if (item.type === "commandExecution") {
      const text = describeCommandOutput(item);
      return text ? { type: "command_completed", text } : null;
    }
    if (item.type === "fileChange") {
      return { type: "file_changed", text: this.describeFileChange(item) };
    }
    if (item.type === "mcpToolCall") {
      return { type: "progress", text: `MCP tool ${item.server}.${item.tool} ${item.status ?? "completed"}` };
    }
    return null;
  }

  private findLastAgentMessage(items: any): string | undefined {
    if (!Array.isArray(items)) {
      return undefined;
    }
    for (const item of [...items].reverse()) {
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        return item.text;
      }
    }
    return undefined;
  }

  private describeFileChange(item: any): string {
    if (!Array.isArray(item.changes) || item.changes.length === 0) {
      return "File changes completed.";
    }
    const paths = item.changes
      .map((change: any) => change.path ?? change.movePath?.newPath ?? change.movePath?.oldPath)
      .filter(Boolean);
    return paths.length > 0 ? `Changed ${paths.join(", ")}` : "File changes completed.";
  }

  private declineServerRequest(method: string, id: number | string, params: any, client: AppServerClient): void {
    logger.info("declining app-server request", { method });

    if (method === "item/commandExecution/requestApproval") {
      client.respond(id, { decision: "decline" });
      return;
    }
    if (method === "item/fileChange/requestApproval") {
      client.respond(id, { decision: "decline" });
      return;
    }
    if (method === "mcpServer/elicitation/request") {
      if (params?.serverName === "telegram_manager") {
        logger.info("accepting telegram manager MCP elicitation", { serverName: params.serverName });
        client.respond(id, { action: "accept", content: {}, _meta: null });
        return;
      }
      client.respond(id, { action: "decline", content: null, _meta: null });
      return;
    }
    if (method === "item/tool/requestUserInput") {
      client.respond(id, { answers: {} });
      return;
    }
    if (method === "item/permissions/requestApproval") {
      client.respond(id, { permissions: {}, scope: "turn" });
      return;
    }
    client.respondError(id, `Unsupported app-server request: ${method}`);
  }
}
