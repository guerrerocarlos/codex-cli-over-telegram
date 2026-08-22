import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AppServerClient } from "./appServerClient.js";
import { AsyncQueue } from "./asyncQueue.js";
import { describeCommandOutput } from "./commandOutput.js";
import { codexProviderArgs, codexServiceTierArgs } from "./modelProviders.js";
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

interface PendingPermissionApproval {
  client: AppServerClient;
  requestId: number | string;
  permissions: unknown;
  timeout: NodeJS.Timeout;
}

interface PendingElicitationApproval {
  client: AppServerClient;
  requestId: number | string;
  params: any;
  timeout: NodeJS.Timeout;
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
  private readonly pendingPermissionApprovals = new Map<string, PendingPermissionApproval>();
  private readonly pendingElicitationApprovals = new Map<string, PendingElicitationApproval>();
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
      if (serverRequest.method === "item/permissions/requestApproval") {
        this.requestPermissionApproval(serverRequest.id, serverRequest.params, rpcClient, events);
        return;
      }
      if (
        serverRequest.method === "mcpServer/elicitation/request" &&
        (serverRequest.params as any)?.serverName !== "telegram_manager"
      ) {
        this.requestElicitationApproval(serverRequest.id, serverRequest.params, rpcClient, events);
        return;
      }

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

  resolvePermissionApproval(approvalId: string, scope: "turn" | "session" | "deny"): boolean {
    const pending = this.pendingPermissionApprovals.get(approvalId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timeout);
    this.pendingPermissionApprovals.delete(approvalId);
    pending.client.respond(
      pending.requestId,
      scope === "turn" || scope === "session"
        ? {
            permissions: grantedPermissionsFromRequest(pending.permissions),
            scope,
          }
        : { permissions: {}, scope: "turn" },
    );
    logger.info("resolved app-server permission approval", { approvalId, scope });
    return true;
  }

  resolveElicitationApproval(approvalId: string, scope: "turn" | "session" | "deny"): boolean {
    const pending = this.pendingElicitationApprovals.get(approvalId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timeout);
    this.pendingElicitationApprovals.delete(approvalId);
    pending.client.respond(pending.requestId, buildElicitationResponse(pending.params, scope));
    logger.info("resolved app-server elicitation approval", { approvalId, scope });
    return true;
  }

  private requestPermissionApproval(
    requestId: number | string,
    params: any,
    client: AppServerClient,
    events: AsyncQueue<CodexRunEvent>,
  ): void {
    const approvalId = randomBytes(9).toString("base64url");
    const permissions = params?.permissions ?? {};
    const timeout = setTimeout(() => {
      if (!this.pendingPermissionApprovals.delete(approvalId)) {
        return;
      }
      client.respond(requestId, { permissions: {}, scope: "turn" });
      events.push({
        type: "progress",
        text: "Permission approval timed out and was denied.",
      });
      logger.warn("app-server permission approval timed out", { approvalId });
    }, 10 * 60_000);
    timeout.unref();

    this.pendingPermissionApprovals.set(approvalId, {
      client,
      requestId,
      permissions,
      timeout,
    });

    events.push({
      type: "permission_request",
      approvalId,
      reason: typeof params?.reason === "string" && params.reason.trim() ? params.reason : null,
      permissions,
    });
    logger.info("app-server permission approval requested", {
      approvalId,
      reason: typeof params?.reason === "string" ? params.reason : null,
      permissionKeys: permissionKeys(permissions),
    });
  }

  private requestElicitationApproval(
    requestId: number | string,
    params: any,
    client: AppServerClient,
    events: AsyncQueue<CodexRunEvent>,
  ): void {
    const approvalId = randomBytes(9).toString("base64url");
    const timeout = setTimeout(() => {
      if (!this.pendingElicitationApprovals.delete(approvalId)) {
        return;
      }
      client.respond(requestId, { action: "decline", content: null, _meta: null });
      events.push({
        type: "progress",
        text: "App approval timed out and was denied.",
      });
      logger.warn("app-server elicitation approval timed out", { approvalId });
    }, 10 * 60_000);
    timeout.unref();

    this.pendingElicitationApprovals.set(approvalId, {
      client,
      requestId,
      params,
      timeout,
    });

    const title = elicitationTitle(params);
    events.push({
      type: "elicitation_request",
      approvalId,
      title,
      description: describeElicitationRequest(params),
    });
    logger.info("app-server elicitation approval requested", {
      approvalId,
      serverName: typeof params?.serverName === "string" ? params.serverName : null,
      mode: typeof params?.mode === "string" ? params.mode : null,
      title,
    });
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
    const bridgeArgs = request?.restrictedToRepo
      ? []
      : [
          "-c",
          `mcp_servers.telegram_manager.command=${JSON.stringify(process.execPath)}`,
          "-c",
          `mcp_servers.telegram_manager.args=${JSON.stringify([this.managerBridgeMcpPath])}`,
          "-c",
          `mcp_servers.telegram_manager.env_vars=${JSON.stringify([
            "MANAGER_BRIDGE_URL",
            "MANAGER_BRIDGE_TOKEN",
            "MANAGER_BRIDGE_CHAT_ID",
          ])}`,
          "-c",
          "mcp_servers.telegram_manager.default_tools_approval_mode=\"auto\"",
          "-c",
          "mcp_servers.telegram_manager.tools.queue_topic.approval_mode=\"auto\"",
          "-c",
          "mcp_servers.telegram_manager.tools.create_cron.approval_mode=\"auto\"",
          "-c",
          "mcp_servers.telegram_manager.tools.create_work_item.approval_mode=\"auto\"",
          "-c",
          "mcp_servers.telegram_manager.tools.update_work_item.approval_mode=\"auto\"",
          "-c",
          "mcp_servers.telegram_manager.tools.complete_work_item.approval_mode=\"auto\"",
        ];
    return {
      extraArgs: [
        ...bridgeArgs,
        ...codexProviderArgs(this.config, request?.modelProvider ?? this.config.defaultModelProvider),
        ...codexServiceTierArgs(
          request?.modelProvider === "openai" ? request.modelServiceTier : null,
        ),
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

function buildElicitationResponse(params: any, scope: "turn" | "session" | "deny"): Record<string, unknown> {
  if (scope === "deny") {
    return { action: "decline", content: null, _meta: null };
  }

  const content = buildElicitationContent(params, scope);
  if (content === undefined) {
    return { action: "decline", content: null, _meta: null };
  }

  return {
    action: "accept",
    content,
    _meta: scope === "session" ? buildElicitationAcceptedMeta(params) : null,
  };
}

function buildElicitationContent(params: any, scope: "turn" | "session"): Record<string, unknown> | null | undefined {
  if (params?.mode === "url") {
    return null;
  }

  const properties = params?.requestedSchema?.properties;
  if (!properties || typeof properties !== "object") {
    return undefined;
  }
  const entries = Object.entries(properties);
  if (entries.length === 0) {
    return null;
  }

  const required = new Set(
    Array.isArray(params?.requestedSchema?.required)
      ? params.requestedSchema.required.filter((entry: unknown): entry is string => typeof entry === "string")
      : [],
  );
  const content: Record<string, unknown> = {};
  let sawApprovalField = false;

  for (const [name, rawSchema] of entries) {
    const schema = rawSchema && typeof rawSchema === "object" ? (rawSchema as Record<string, unknown>) : null;
    if (!schema) {
      continue;
    }

    const value =
      approvalFieldValue(name, schema, scope) ??
      persistFieldValue(name, schema, params?._meta, scope) ??
      schema.default;
    if (value === undefined) {
      if (required.has(name)) {
        return undefined;
      }
      continue;
    }

    if (isApprovalFieldName(name, schema)) {
      sawApprovalField = true;
    }
    content[name] = value;
  }

  return sawApprovalField ? content : undefined;
}

function approvalFieldValue(name: string, schema: Record<string, unknown>, scope: "turn" | "session"): unknown {
  if (!isApprovalFieldName(name, schema)) {
    return undefined;
  }
  if (schema.type === "boolean") {
    return true;
  }
  const options = enumOptions(schema);
  const sessionChoice = options.find((option) => /session|always|forever/i.test(option.label));
  const acceptChoice = options.find((option) => /approve|allow|accept|yes/i.test(option.label));
  if (scope === "session") {
    return sessionChoice?.value ?? acceptChoice?.value;
  }
  return acceptChoice?.value ?? sessionChoice?.value;
}

function persistFieldValue(
  name: string,
  schema: Record<string, unknown>,
  meta: unknown,
  scope: "turn" | "session",
): unknown {
  if (scope !== "session" || !isPersistFieldName(name, schema)) {
    return undefined;
  }
  const options = enumOptions(schema);
  const hints = persistHints(meta);
  for (const hint of hints) {
    const match = options.find((option) => option.value === hint || option.label === hint);
    if (match) {
      return match.value;
    }
  }
  return undefined;
}

function buildElicitationAcceptedMeta(params: any): Record<string, unknown> | null {
  const [persist] = persistHints(params?._meta);
  return persist ? { persist } : null;
}

function grantedPermissionsFromRequest(permissions: any): Record<string, unknown> {
  if (!permissions || typeof permissions !== "object") {
    return {};
  }

  const granted: Record<string, unknown> = {};
  if (permissions.network) {
    granted.network = permissions.network;
  }
  if (permissions.fileSystem) {
    granted.fileSystem = permissions.fileSystem;
  }
  return granted;
}

function permissionKeys(permissions: any): string[] {
  if (!permissions || typeof permissions !== "object") {
    return [];
  }
  return Object.entries(permissions)
    .filter(([, value]) => Boolean(value))
    .map(([key]) => key);
}

function elicitationTitle(params: any): string {
  const message = stringValue(params?.message);
  const connectorName = stringValue(params?._meta?.connector_name);
  const toolTitle = stringValue(params?._meta?.tool_title);
  if (connectorName && toolTitle) {
    return `${connectorName}: ${toolTitle}`;
  }
  return message || "App approval requested";
}

function describeElicitationRequest(params: any): string {
  const lines = [
    stringValue(params?.message),
    stringValue(params?._meta?.connector_name) ? `App: ${stringValue(params._meta.connector_name)}` : null,
    stringValue(params?._meta?.tool_title) ? `Tool: ${stringValue(params._meta.tool_title)}` : null,
    stringValue(params?.serverName) ? `MCP server: ${stringValue(params.serverName)}` : null,
    stringValue(params?._meta?.tool_description),
    params?.mode === "url" && stringValue(params?.url) ? `URL: ${stringValue(params.url)}` : null,
    displayParams(params?._meta?.tool_params_display),
    schemaFields(params?.requestedSchema),
  ].filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.join("\n") : "No app approval details were provided.";
}

function displayParams(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const lines = value.slice(0, 8).map((entry) => {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    if (!record) {
      return null;
    }
    const name = stringValue(record.display_name) ?? stringValue(record.name);
    if (!name) {
      return null;
    }
    return `- ${name}: ${previewJson(record.value)}`;
  }).filter((line): line is string => Boolean(line));
  return lines.length > 0 ? ["Parameters:", ...lines].join("\n") : null;
}

function schemaFields(schema: unknown): string | null {
  const properties = schema && typeof schema === "object" ? (schema as any).properties : null;
  if (!properties || typeof properties !== "object") {
    return null;
  }
  const lines = Object.entries(properties).map(([name, rawSchema]) => {
    const propertySchema = rawSchema && typeof rawSchema === "object" ? (rawSchema as Record<string, unknown>) : null;
    if (!propertySchema) {
      return null;
    }
    const title = stringValue(propertySchema.title) ?? name;
    const description = stringValue(propertySchema.description);
    return description ? `- ${title}: ${description}` : `- ${title}`;
  }).filter((line): line is string => Boolean(line));
  return lines.length > 0 ? ["Fields:", ...lines].join("\n") : null;
}

function previewJson(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text && text.length > 120 ? `${text.slice(0, 117)}...` : text ?? "null";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function enumOptions(schema: Record<string, unknown>): Array<{ value: string; label: string }> {
  const fromEnum = Array.isArray(schema.enum)
    ? schema.enum
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => ({ value: entry, label: entry }))
    : [];
  const titled = [...oneOfOptions(schema.oneOf), ...oneOfOptions((schema.items as any)?.oneOf), ...oneOfOptions(schema.anyOf)];
  return [...fromEnum, ...titled];
}

function oneOfOptions(value: unknown): Array<{ value: string; label: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    const optionValue = stringValue(record?.const);
    if (!optionValue) {
      return [];
    }
    return [{ value: optionValue, label: stringValue(record?.title) ?? optionValue }];
  });
}

function isApprovalFieldName(name: string, schema: Record<string, unknown>): boolean {
  return fieldHaystack(name, schema).match(/\b(approve|approval|allow|accept|decision)\b/i) !== null;
}

function isPersistFieldName(name: string, schema: Record<string, unknown>): boolean {
  return fieldHaystack(name, schema).match(/\b(persist|session|always|scope)\b/i) !== null;
}

function fieldHaystack(name: string, schema: Record<string, unknown>): string {
  return [name, stringValue(schema.title), stringValue(schema.description)].filter(Boolean).join(" ");
}

function persistHints(meta: unknown): Array<"always" | "session"> {
  const raw = meta && typeof meta === "object" ? (meta as Record<string, unknown>).persist : null;
  const values =
    typeof raw === "string"
      ? [raw]
      : Array.isArray(raw)
        ? raw.filter((entry): entry is string => typeof entry === "string")
        : ["session", "always"];
  return [
    ...(values.includes("always") ? ["always" as const] : []),
    ...(values.includes("session") ? ["session" as const] : []),
  ];
}
