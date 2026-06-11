import { AppServerClient } from "./appServerClient.js";

export interface CodexModelInfo {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  hidden: boolean;
}

export interface CodexConfigSnapshot {
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
}

export interface CodexUsageSnapshot {
  rateLimits: any | null;
  usage: any | null;
}

export async function listCodexModels(codexBin: string): Promise<CodexModelInfo[]> {
  return withMetadataClient(codexBin, async (client) => {
    const models: CodexModelInfo[] = [];
    let cursor: string | null = null;

    do {
      const response = (await client.request("model/list", {
        cursor,
        limit: 100,
        includeHidden: false,
      })) as any;
      const data = Array.isArray(response?.data) ? response.data : [];
      for (const model of data) {
        models.push({
          id: String(model.id ?? model.model ?? ""),
          model: String(model.model ?? model.id ?? ""),
          displayName: String(model.displayName ?? model.model ?? model.id ?? ""),
          description: String(model.description ?? ""),
          isDefault: Boolean(model.isDefault),
          hidden: Boolean(model.hidden),
        });
      }
      cursor = typeof response?.nextCursor === "string" ? response.nextCursor : null;
    } while (cursor);

    return models.filter((model) => model.model.length > 0);
  });
}

export async function readCodexConfig(
  codexBin: string,
  cwd?: string,
): Promise<CodexConfigSnapshot> {
  return withMetadataClient(codexBin, async (client) => {
    const response = (await client.request("config/read", {
      includeLayers: false,
      cwd: cwd ?? null,
    })) as any;
    const config = response?.config ?? {};
    return {
      model: stringOrNull(config.model),
      reasoningEffort: stringOrNull(config.model_reasoning_effort),
      serviceTier: stringOrNull(config.service_tier),
    };
  });
}

export async function readCodexUsage(codexBin: string): Promise<CodexUsageSnapshot> {
  return withMetadataClient(codexBin, async (client) => {
    const [rateLimits, usage] = await Promise.all([
      client.request("account/rateLimits/read").catch(() => null),
      client.request("account/usage/read").catch(() => null),
    ]);
    return { rateLimits, usage };
  });
}

async function withMetadataClient<T>(
  codexBin: string,
  callback: (client: AppServerClient) => Promise<T>,
): Promise<T> {
  const client = new AppServerClient(codexBin);
  client.onServerRequest((request, rpcClient) => {
    rpcClient.respondError(request.id, `Unsupported metadata request: ${request.method}`);
  });

  try {
    await client.initialize();
    return await callback(client);
  } finally {
    client.close();
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
