#!/usr/bin/env node
import Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

type JsonRpcId = number | string | null;

interface JsonRpcRequest {
  id?: JsonRpcId;
  method?: string;
  params?: any;
}

interface ToolCallArguments {
  topic?: unknown;
  prompt?: unknown;
  cron?: unknown;
  cronId?: unknown;
  workItemId?: unknown;
  title?: unknown;
  detail?: unknown;
  status?: unknown;
  priority?: unknown;
  evidence?: unknown;
  dueAt?: unknown;
  includeClosed?: unknown;
  limit?: unknown;
}

interface BridgeConfig {
  url: string;
  token: string;
  chatId: number;
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  void handleLine(line);
});

async function handleLine(line: string): Promise<void> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return;
  }

  if (request.id === undefined) {
    return;
  }

  try {
    switch (request.method) {
      case "initialize":
        respond(request.id, {
          protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "telegram_manager",
            version: "0.1.0",
          },
          instructions:
            "Use these tools to inspect bound Telegram topics, read stored topic messages, and queue work into specific topics. Prefer exact topic ids when available.",
        });
        return;
      case "tools/list":
        respond(request.id, {
          tools: [
            {
              name: "queue_topic",
              description:
                "Queue a prompt for a bound Telegram topic. Use this instead of telling the user to run /queue_topic or /assign.",
              inputSchema: {
                type: "object",
                properties: {
                  topic: {
                    type: "string",
                    description: "Worker topic id, topic name, or repo folder name.",
                  },
                  prompt: {
                    type: "string",
                    description: "The exact work prompt to queue in the target worker topic.",
                  },
                },
                required: ["topic", "prompt"],
                additionalProperties: false,
              },
            },
            {
              name: "list_topics",
              description: "List bound Telegram topics in this chat, including their topic ids, names, repos, and run status.",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
            {
              name: "read_topic_messages",
              description:
                "Read recently stored messages for a bound Telegram topic. Only messages observed after message storage was enabled are available.",
              inputSchema: {
                type: "object",
                properties: {
                  topic: {
                    type: "string",
                    description: "Topic id, topic name, or repo folder name.",
                  },
                  limit: {
                    type: "number",
                    description: "Maximum messages to return, up to 200. Defaults to 25.",
                  },
                },
                required: ["topic"],
                additionalProperties: false,
              },
            },
            {
              name: "create_topic",
              description:
                "Create a new Telegram forum topic, create or reuse a folder under the allowed repo roots, and bind the topic to that folder.",
              inputSchema: {
                type: "object",
                properties: {
                  topic: {
                    type: "string",
                    description: "Folder name or allowed folder path. The topic name is derived from the folder.",
                  },
                },
                required: ["topic"],
                additionalProperties: false,
              },
            },
            {
              name: "create_cron",
              description:
                "Create a scheduled cron prompt for a bound Telegram topic. Use this when you need to wake yourself or another topic on a recurring schedule.",
              inputSchema: {
                type: "object",
                properties: {
                  topic: {
                    type: "string",
                    description: "Topic id, topic name, or repo folder name.",
                  },
                  cron: {
                    type: "string",
                    description: "Five-field cron expression, for example: 0 * * * *",
                  },
                  prompt: {
                    type: "string",
                    description: "The prompt to queue each time the cron fires.",
                  },
                },
                required: ["topic", "cron", "prompt"],
                additionalProperties: false,
              },
            },
            {
              name: "list_crons",
              description: "List cron jobs configured for this Telegram chat.",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
            {
              name: "delete_cron",
              description: "Disable a Telegram cron job by id.",
              inputSchema: {
                type: "object",
                properties: {
                  cronId: {
                    type: "number",
                    description: "Cron job id to disable.",
                  },
                },
                required: ["cronId"],
                additionalProperties: false,
              },
            },
            {
              name: "create_work_item",
              description:
                "Create a persistent work item attached to a bound Telegram topic. Use this for tasks the manager should supervise across turns.",
              inputSchema: {
                type: "object",
                properties: {
                  topic: {
                    type: "string",
                    description: "Topic id, topic name, or repo folder name.",
                  },
                  title: {
                    type: "string",
                    description: "Short objective for the work item.",
                  },
                  detail: {
                    type: "string",
                    description: "Optional extra context, acceptance criteria, or verification instructions.",
                  },
                  priority: {
                    type: "string",
                    description: "Optional priority label, for example low, normal, high, urgent.",
                  },
                  dueAt: {
                    type: "string",
                    description: "Optional ISO timestamp or human-readable due marker.",
                  },
                },
                required: ["topic", "title"],
                additionalProperties: false,
              },
            },
            {
              name: "list_work_items",
              description: "List persistent work items for this Telegram chat.",
              inputSchema: {
                type: "object",
                properties: {
                  includeClosed: {
                    type: "boolean",
                    description: "Include done and canceled items. Defaults to false.",
                  },
                  limit: {
                    type: "number",
                    description: "Maximum items to return, up to 200. Defaults to 50.",
                  },
                },
                additionalProperties: false,
              },
            },
            {
              name: "update_work_item",
              description: "Update a persistent work item status, priority, details, evidence, or due marker.",
              inputSchema: {
                type: "object",
                properties: {
                  workItemId: {
                    type: "number",
                    description: "Work item id.",
                  },
                  status: {
                    type: "string",
                    description: "One of open, in_progress, blocked, done, canceled.",
                  },
                  detail: {
                    type: "string",
                    description: "Replacement detail text.",
                  },
                  priority: {
                    type: "string",
                    description: "Replacement priority label.",
                  },
                  evidence: {
                    type: "string",
                    description: "Evidence, blocker reason, or completion note.",
                  },
                  dueAt: {
                    type: "string",
                    description: "Replacement due marker.",
                  },
                },
                required: ["workItemId"],
                additionalProperties: false,
              },
            },
            {
              name: "complete_work_item",
              description: "Mark a persistent work item done with optional evidence.",
              inputSchema: {
                type: "object",
                properties: {
                  workItemId: {
                    type: "number",
                    description: "Work item id.",
                  },
                  evidence: {
                    type: "string",
                    description: "Completion evidence or verification summary.",
                  },
                },
                required: ["workItemId"],
                additionalProperties: false,
              },
            },
          ],
        });
        return;
      case "tools/call":
        respond(request.id, await callTool(request.params));
        return;
      default:
        respondError(request.id, `Unsupported method: ${request.method ?? "unknown"}`, -32601);
        return;
    }
  } catch (error) {
    respondError(request.id, error instanceof Error ? error.message : String(error));
  }
}

async function callTool(params: any): Promise<unknown> {
  const toolName = params?.name;
  if (
    toolName !== "queue_topic" &&
    toolName !== "list_topics" &&
    toolName !== "read_topic_messages" &&
    toolName !== "create_topic" &&
    toolName !== "create_cron" &&
    toolName !== "list_crons" &&
    toolName !== "delete_cron" &&
    toolName !== "create_work_item" &&
    toolName !== "list_work_items" &&
    toolName !== "update_work_item" &&
    toolName !== "complete_work_item"
  ) {
    throw new Error(`Unknown tool: ${params?.name ?? "missing"}`);
  }

  const args = (params.arguments ?? {}) as ToolCallArguments;
  const bridgeConfig = resolveBridgeConfig();
  if (!bridgeConfig) {
    throw new Error("Telegram bridge is not configured for this Codex run.");
  }

  const body: Record<string, unknown> = {
    chatId: bridgeConfig.chatId,
    action: toolName,
  };

  if (toolName === "queue_topic") {
    const topic = typeof args.topic === "string" ? args.topic.trim() : "";
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!topic || !prompt) {
      throw new Error("queue_topic requires non-empty topic and prompt arguments.");
    }
    body.selector = topic;
    body.prompt = prompt;
  }

  if (toolName === "read_topic_messages" || toolName === "create_topic") {
    const topic = typeof args.topic === "string" ? args.topic.trim() : "";
    if (!topic) {
      throw new Error(`${toolName} requires a non-empty topic argument.`);
    }
    body.selector = topic;
    if (toolName === "read_topic_messages" && typeof args.limit === "number" && Number.isFinite(args.limit)) {
      body.limit = args.limit;
    }
  }

  if (toolName === "create_cron") {
    const topic = typeof args.topic === "string" ? args.topic.trim() : "";
    const cron = typeof args.cron === "string" ? args.cron.trim() : "";
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!topic || !cron || !prompt) {
      throw new Error("create_cron requires non-empty topic, cron, and prompt arguments.");
    }
    body.selector = topic;
    body.cron = cron;
    body.prompt = prompt;
  }

  if (toolName === "delete_cron") {
    const cronId = typeof args.cronId === "number" && Number.isSafeInteger(args.cronId) ? args.cronId : null;
    if (cronId === null) {
      throw new Error("delete_cron requires a numeric cronId argument.");
    }
    body.cronId = cronId;
  }

  if (toolName === "create_work_item") {
    const topic = typeof args.topic === "string" ? args.topic.trim() : "";
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!topic || !title) {
      throw new Error("create_work_item requires non-empty topic and title arguments.");
    }
    body.selector = topic;
    body.title = title;
    if (typeof args.detail === "string") {
      body.detail = args.detail.trim();
    }
    if (typeof args.priority === "string") {
      body.priority = args.priority.trim();
    }
    if (typeof args.dueAt === "string") {
      body.dueAt = args.dueAt.trim();
    }
  }

  if (toolName === "list_work_items") {
    if (typeof args.includeClosed === "boolean") {
      body.includeClosed = args.includeClosed;
    }
    if (typeof args.limit === "number" && Number.isFinite(args.limit)) {
      body.limit = args.limit;
    }
  }

  if (toolName === "update_work_item" || toolName === "complete_work_item") {
    const workItemId =
      typeof args.workItemId === "number" && Number.isSafeInteger(args.workItemId) ? args.workItemId : null;
    if (workItemId === null) {
      throw new Error(`${toolName} requires a numeric workItemId argument.`);
    }
    body.workItemId = workItemId;
    if (toolName === "complete_work_item") {
      body.status = "done";
    }
    if (typeof args.status === "string") {
      body.status = args.status.trim();
    }
    if (typeof args.detail === "string") {
      body.detail = args.detail.trim();
    }
    if (typeof args.priority === "string") {
      body.priority = args.priority.trim();
    }
    if (typeof args.evidence === "string") {
      body.evidence = args.evidence.trim();
    }
    if (typeof args.dueAt === "string") {
      body.dueAt = args.dueAt.trim();
    }
  }

  const response = await fetch(bridgeConfig.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bridgeConfig.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const result = (await response.json()) as { ok?: boolean; message?: string };
  if (!response.ok || !result.ok) {
    throw new Error(result.message ?? `Telegram manager bridge failed with HTTP ${response.status}.`);
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

function respond(id: JsonRpcId, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id: JsonRpcId, message: string, code = -32000): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function resolveBridgeConfig(): BridgeConfig | null {
  const env = { ...readEnvFile("/etc/codex-cli-over-telegram/env"), ...process.env };
  const discoveredEnv = discoverRunningBridgeEnv();
  const url = env.MANAGER_BRIDGE_URL ?? discoveredEnv.MANAGER_BRIDGE_URL ?? defaultBridgeUrl(env);
  const token = env.MANAGER_BRIDGE_TOKEN ?? discoveredEnv.MANAGER_BRIDGE_TOKEN;
  const chatId = parseChatId(env.MANAGER_BRIDGE_CHAT_ID ?? discoveredEnv.MANAGER_BRIDGE_CHAT_ID) ?? inferChatId(env);

  if (!url || !token || chatId === null) {
    return null;
  }

  return { url, token, chatId };
}

function parseChatId(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const chatId = Number(value);
  return Number.isSafeInteger(chatId) ? chatId : null;
}

function defaultBridgeUrl(env: NodeJS.ProcessEnv): string {
  const host = env.HEALTH_HOST && env.HEALTH_HOST !== "0.0.0.0" ? env.HEALTH_HOST : "127.0.0.1";
  const port = env.HEALTH_PORT ?? "8787";
  return `http://${host}:${port}/bridge`;
}

function readEnvFile(filePath: string): NodeJS.ProcessEnv {
  if (!existsSync(filePath)) {
    return {};
  }

  const values: NodeJS.ProcessEnv = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    values[key] = unquoteEnvValue(value);
  }
  return values;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function discoverRunningBridgeEnv(): NodeJS.ProcessEnv {
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) {
      continue;
    }
    const environPath = `/proc/${pid}/environ`;
    try {
      const env = parseProcessEnv(readFileSync(environPath));
      if (env.MANAGER_BRIDGE_URL && env.MANAGER_BRIDGE_TOKEN) {
        return env;
      }
    } catch {
      // Ignore processes whose environment is not readable by this user.
    }
  }
  return {};
}

function parseProcessEnv(buffer: Buffer): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const entry of buffer.toString("utf8").split("\0")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return env;
}

function inferChatId(env: NodeJS.ProcessEnv): number | null {
  const configuredDatabasePath = expandHome(env.DATABASE_PATH ?? "data/state.sqlite");
  const databasePath = path.isAbsolute(configuredDatabasePath)
    ? configuredDatabasePath
    : path.resolve("/home/gnu/codex-cli-over-telegram", configuredDatabasePath);
  if (!existsSync(databasePath)) {
    return null;
  }

  let database: Database.Database | null = null;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    const currentPath = path.resolve(process.cwd());
    const bindings = database
      .prepare("SELECT chat_id AS chatId, repo_path AS repoPath FROM topic_bindings")
      .all() as Array<{ chatId: number; repoPath: string }>;
    const binding = bindings
      .filter((candidate) => pathContains(path.resolve(candidate.repoPath), currentPath))
      .sort((left, right) => right.repoPath.length - left.repoPath.length)[0];
    return binding?.chatId ?? null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
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

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}
