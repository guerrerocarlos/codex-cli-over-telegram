import http from "node:http";
import type { AppConfig } from "./config.js";
import { logger } from "./logger.js";

export interface ManagerBridgeRequest {
  chatId: number;
  selector: string;
  prompt: string;
}

export interface ManagerBridgeResult {
  ok: boolean;
  message: string;
  runId?: number;
  topicId?: number;
  topicName?: string;
  repoPath?: string;
  queuedBehind?: number;
}

export type ManagerBridgeHandler = (request: ManagerBridgeRequest) => Promise<ManagerBridgeResult>;

export function startHealthServer(config: AppConfig, managerBridgeHandler?: ManagerBridgeHandler): http.Server {
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

    if (request.method === "POST" && request.url === "/manager/queue-topic" && managerBridgeHandler) {
      void handleManagerBridgeRequest(config, managerBridgeHandler, request, response);
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

async function handleManagerBridgeRequest(
  config: AppConfig,
  handler: ManagerBridgeHandler,
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
    if (!isManagerBridgeRequest(body)) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "invalid request" }));
      return;
    }

    const result = await handler(body);
    response.writeHead(result.ok ? 200 : 400, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  } catch (error) {
    logger.warn("manager bridge request failed", {
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

function isManagerBridgeRequest(value: unknown): value is ManagerBridgeRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.chatId === "number" &&
    Number.isSafeInteger(record.chatId) &&
    typeof record.selector === "string" &&
    record.selector.trim().length > 0 &&
    typeof record.prompt === "string" &&
    record.prompt.trim().length > 0
  );
}
