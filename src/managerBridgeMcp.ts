#!/usr/bin/env node
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
  limit?: unknown;
}

const bridgeUrl = process.env.MANAGER_BRIDGE_URL ?? "";
const bridgeToken = process.env.MANAGER_BRIDGE_TOKEN ?? "";
const managerChatId = Number(process.env.MANAGER_BRIDGE_CHAT_ID ?? "");

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
  if (toolName !== "queue_topic" && toolName !== "list_topics" && toolName !== "read_topic_messages" && toolName !== "create_topic") {
    throw new Error(`Unknown tool: ${params?.name ?? "missing"}`);
  }

  const args = (params.arguments ?? {}) as ToolCallArguments;
  if (!bridgeUrl || !bridgeToken || !Number.isSafeInteger(managerChatId)) {
    throw new Error("Telegram bridge is not configured for this Codex run.");
  }

  const body: Record<string, unknown> = {
    chatId: managerChatId,
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

  const response = await fetch(bridgeUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bridgeToken}`,
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
