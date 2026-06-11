import { AppServerClient } from "./appServerClient.js";
import { AsyncQueue } from "./asyncQueue.js";
import { describeCommandOutput } from "./commandOutput.js";
import type { CodexBackend, CodexRunEvent, CodexRunRequest, SandboxMode } from "./types.js";
import { logger } from "./logger.js";

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

  constructor(private readonly codexBin: string) {}

  async *run(request: CodexRunRequest): AsyncIterable<CodexRunEvent> {
    const client = new AppServerClient(this.codexBin);
    const events = new AsyncQueue<CodexRunEvent>();
    let finalMessage = "";
    let threadId = request.codexThreadId;
    let turnId: string | null = null;

    client.onServerRequest((serverRequest, rpcClient) => {
      events.push({
        type: "progress",
        text: `Approval or input request declined: ${serverRequest.method}`,
      });
      this.declineServerRequest(serverRequest.method, serverRequest.id, rpcClient);
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

  private declineServerRequest(method: string, id: number | string, client: AppServerClient): void {
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
