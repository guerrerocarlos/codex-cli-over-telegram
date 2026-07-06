import http from "node:http";
import type { AppConfig } from "./config.js";
import { logger } from "./logger.js";

export type BridgeAction =
  | "queue_topic"
  | "list_topics"
  | "read_topic_messages"
  | "create_topic"
  | "create_cron"
  | "list_crons"
  | "delete_cron"
  | "create_work_item"
  | "list_work_items"
  | "update_work_item"
  | "complete_work_item";

export interface BridgeRequest {
  action: BridgeAction;
  chatId: number;
  selector?: string;
  prompt?: string;
  cron?: string;
  cronId?: number;
  workItemId?: number;
  title?: string;
  detail?: string;
  status?: string;
  priority?: string;
  evidence?: string;
  dueAt?: string;
  includeClosed?: boolean;
  limit?: number;
}

export interface BridgeResult {
  ok: boolean;
  message: string;
  runId?: number;
  topicId?: number;
  topicName?: string;
  repoPath?: string;
  queuedBehind?: number;
  topics?: unknown[];
  messages?: unknown[];
  crons?: unknown[];
  cronId?: number;
  nextRunAt?: string;
  workItems?: unknown[];
  workItem?: unknown;
  workItemId?: number;
}

export type BridgeHandler = (request: BridgeRequest) => Promise<BridgeResult>;

export function startHealthServer(config: AppConfig, bridgeHandler?: BridgeHandler): http.Server {
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          service: "codex-cli-over-telegram",
          branch: config.deployBranch,
          commitHash: config.deployCommitHash,
          deployedAt: config.deployedAt,
        }),
      );
      return;
    }

    if (
      request.method === "POST" &&
      (request.url === "/bridge" || request.url === "/manager/queue-topic") &&
      bridgeHandler
    ) {
      void handleBridgeRequest(config, bridgeHandler, request, response);
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "not found" }));
  });

  server.listen(config.healthPort, config.healthHost, () => {
    logger.info("health server listening", {
      host: config.healthHost,
      port: config.healthPort,
    });
  });

  return server;
}

async function handleBridgeRequest(
  config: AppConfig,
  handler: BridgeHandler,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  try {
    if (request.headers.authorization !== `Bearer ${config.managerBridgeToken}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }

    const body = await readJsonBody(request);
    const bridgeRequest = normalizeBridgeRequest(request.url ?? "", body);
    if (!bridgeRequest) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "invalid request" }));
      return;
    }

    const result = await handler(bridgeRequest);
    response.writeHead(result.ok ? 200 : 400, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  } catch (error) {
    logger.warn("telegram bridge request failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "manager bridge failed" }));
  }
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) {
      throw new Error("manager bridge request body is too large");
    }
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function normalizeBridgeRequest(url: string, value: unknown): BridgeRequest | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const chatId = record.chatId;
  if (typeof chatId !== "number" || !Number.isSafeInteger(chatId)) {
    return null;
  }

  if (url === "/manager/queue-topic") {
    if (typeof record.selector !== "string" || typeof record.prompt !== "string") {
      return null;
    }
    return {
      action: "queue_topic",
      chatId,
      selector: record.selector,
      prompt: record.prompt,
    };
  }

  const action = record.action;
  if (
    action !== "queue_topic" &&
    action !== "list_topics" &&
    action !== "read_topic_messages" &&
    action !== "create_topic" &&
    action !== "create_cron" &&
    action !== "list_crons" &&
    action !== "delete_cron" &&
    action !== "create_work_item" &&
    action !== "list_work_items" &&
    action !== "update_work_item" &&
    action !== "complete_work_item"
  ) {
    return null;
  }

  const bridgeRequest: BridgeRequest = {
    action,
    chatId,
  };
  if (typeof record.selector === "string") {
    bridgeRequest.selector = record.selector;
  }
  if (typeof record.prompt === "string") {
    bridgeRequest.prompt = record.prompt;
  }
  if (typeof record.cron === "string") {
    bridgeRequest.cron = record.cron;
  }
  if (typeof record.cronId === "number" && Number.isSafeInteger(record.cronId)) {
    bridgeRequest.cronId = record.cronId;
  }
  if (typeof record.workItemId === "number" && Number.isSafeInteger(record.workItemId)) {
    bridgeRequest.workItemId = record.workItemId;
  }
  if (typeof record.title === "string") {
    bridgeRequest.title = record.title;
  }
  if (typeof record.detail === "string") {
    bridgeRequest.detail = record.detail;
  }
  if (typeof record.status === "string") {
    bridgeRequest.status = record.status;
  }
  if (typeof record.priority === "string") {
    bridgeRequest.priority = record.priority;
  }
  if (typeof record.evidence === "string") {
    bridgeRequest.evidence = record.evidence;
  }
  if (typeof record.dueAt === "string") {
    bridgeRequest.dueAt = record.dueAt;
  }
  if (typeof record.includeClosed === "boolean") {
    bridgeRequest.includeClosed = record.includeClosed;
  }
  if (typeof record.limit === "number" && Number.isFinite(record.limit)) {
    bridgeRequest.limit = record.limit;
  }
  return bridgeRequest;
}
