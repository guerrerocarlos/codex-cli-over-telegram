import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { logger } from "./logger.js";

type JsonRpcId = number | string;

interface JsonRpcResponse {
  id: JsonRpcId;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface JsonRpcServerRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

type NotificationHandler = (message: JsonRpcNotification) => void;
type ServerRequestHandler = (message: JsonRpcServerRequest, client: AppServerClient) => void;

export interface AppServerClientOptions {
  extraArgs?: string[];
  extraEnv?: NodeJS.ProcessEnv;
}

export class AppServerClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    JsonRpcId,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly serverRequestHandlers = new Set<ServerRequestHandler>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly codexBin: string, options: AppServerClientOptions = {}) {
    this.proc = spawn(codexBin, ["app-server", ...(options.extraArgs ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(options.extraEnv ?? {}) },
    });

    this.proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString("utf8").trim();
      if (text) {
        logger.debug("codex app-server stderr", { text });
      }
    });

    this.proc.once("error", (error) => {
      this.rejectAll(error);
    });

    this.proc.once("close", (code, signal) => {
      this.closed = true;
      this.rejectAll(new Error(`codex app-server closed with code ${code ?? "null"} signal ${signal ?? "null"}`));
    });

    const lines = readline.createInterface({
      input: this.proc.stdout,
      crlfDelay: Infinity,
    });

    lines.on("line", (line) => this.handleLine(line));
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "codex_over_telegram",
        title: "Codex over Telegram",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify("initialized");
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(handler: ServerRequestHandler): () => void {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("codex app-server is closed"));
    }

    const id = this.nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };
    this.write(payload);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: JsonRpcId, message: string, code = -32000): void {
    this.write({ id, error: { code, message } });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.proc.kill("SIGTERM");
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      logger.warn("failed to parse app-server json", { line, error: String(error) });
      return;
    }

    if (!message || typeof message !== "object") {
      return;
    }

    const candidate = message as Partial<JsonRpcResponse & JsonRpcNotification>;
    if (candidate.id !== undefined && (candidate.result !== undefined || candidate.error !== undefined) && !candidate.method) {
      this.handleResponse(candidate as JsonRpcResponse);
      return;
    }

    if (candidate.method && candidate.id !== undefined) {
      const request = candidate as JsonRpcServerRequest;
      for (const handler of this.serverRequestHandlers) {
        handler(request, this);
      }
      return;
    }

    if (candidate.method) {
      const notification = candidate as JsonRpcNotification;
      for (const handler of this.notificationHandlers) {
        handler(notification);
      }
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);

    if (response.error) {
      pending.reject(new Error(response.error.message ?? `JSON-RPC error ${response.error.code ?? ""}`));
      return;
    }

    pending.resolve(response.result);
  }

  private write(payload: unknown): void {
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
