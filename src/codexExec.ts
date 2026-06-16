import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { describeCommandOutput } from "./commandOutput.js";
import type { AppConfig } from "./config.js";
import { codexProviderArgs, codexServiceTierArgs } from "./modelProviders.js";
import { PLAN_MODE_DEVELOPER_INSTRUCTIONS } from "./planMode.js";
import type { CodexBackend, CodexRunEvent, CodexRunRequest } from "./types.js";
import { logger } from "./logger.js";

interface JsonEvent {
  type?: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
    command?: string;
    path?: string;
    status?: string;
    stdout?: string;
    stderr?: string;
    output?: string;
    aggregatedOutput?: string;
    formattedOutput?: string;
    result?: unknown;
    exitCode?: number;
    exit_code?: number;
  };
  error?: string | { message?: string };
}

export class CodexExecBackend implements CodexBackend {
  private readonly active = new Map<number, ChildProcess>();

  constructor(private readonly config: AppConfig) {}

  async *run(request: CodexRunRequest): AsyncIterable<CodexRunEvent> {
    const args = [
      "exec",
      "--json",
      "--cd",
      request.repoPath,
      "--skip-git-repo-check",
      "--sandbox",
      request.sandboxMode,
      "-c",
      `approval_policy="${request.approvalPolicy}"`,
      ...codexProviderArgs(this.config, request.modelProvider),
      ...codexServiceTierArgs(request.modelProvider === "openai" ? request.modelServiceTier : null),
    ];

    if (request.model) {
      args.push("--model", request.model);
    }
    if (request.planMode) {
      args.push("-c", `developer_instructions=${JSON.stringify(PLAN_MODE_DEVELOPER_INSTRUCTIONS)}`);
    }

    if (request.codexThreadId) {
      args.push("resume", request.codexThreadId, request.prompt);
    } else {
      args.push(request.prompt);
    }

    const child = spawn(this.config.codexBin, args, {
      cwd: request.repoPath,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.active.set(request.bindingId, child);
    let finalMessage = "";
    let stderr = "";

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
      if (stderr.length > 20_000) {
        stderr = stderr.slice(-20_000);
      }
    });

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );

    child.once("error", (error) => {
      logger.error("codex process error", {
        bindingId: request.bindingId,
        error: error.message,
      });
    });

    yield { type: "started", text: `Started Codex in ${request.repoPath}` };

    const lines = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      let event: JsonEvent;
      try {
        event = JSON.parse(line) as JsonEvent;
      } catch {
        yield { type: "progress", text: line };
        continue;
      }

      const mapped = this.mapEvent(event);
      if (!mapped) {
        continue;
      }

      if (mapped.type === "agent_message") {
        finalMessage = mapped.text;
      }

      yield mapped;
    }

    const exit = await exitPromise;
    this.active.delete(request.bindingId);

    if (exit.signal) {
      yield { type: "failed", error: `Codex stopped by signal ${exit.signal}` };
      return;
    }

    if (exit.code && exit.code !== 0) {
      yield {
        type: "failed",
        error: stderr.trim() || `Codex exited with code ${exit.code}`,
        exitCode: exit.code,
      };
      return;
    }

    yield { type: "completed", finalMessage };
  }

  async interrupt(bindingId: number): Promise<boolean> {
    const child = this.active.get(bindingId);
    if (!child) {
      return false;
    }

    if (process.platform === "win32") {
      child.kill("SIGTERM");
    } else if (child.pid) {
      process.kill(-child.pid, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }

    this.active.delete(bindingId);
    return true;
  }

  private mapEvent(event: JsonEvent): CodexRunEvent | null {
    if (event.type === "thread.started" && event.thread_id) {
      return { type: "started", threadId: event.thread_id };
    }

    if (event.type === "turn.completed") {
      return { type: "progress", text: "Codex turn completed." };
    }

    if (event.type === "turn.failed") {
      return { type: "failed", error: "Codex turn failed." };
    }

    if (event.type === "error") {
      const error =
        typeof event.error === "string" ? event.error : event.error?.message ?? "Codex error";
      return { type: "failed", error };
    }

    if (!event.item) {
      return null;
    }

    const item = event.item;
    if (event.type === "item.started" && item.type === "command_execution" && item.command) {
      return { type: "command_started", text: item.command };
    }

    if (event.type === "item.completed" && item.type === "command_execution") {
      const text = describeCommandOutput(item);
      return text ? { type: "command_completed", text } : null;
    }

    if (event.type === "item.completed" && item.type === "agent_message" && item.text) {
      return { type: "agent_message", text: item.text };
    }

    if (event.type === "item.completed" && item.type === "file_change" && item.path) {
      return { type: "file_changed", text: item.path };
    }

    if (item.text && event.type?.startsWith("item.")) {
      return { type: "progress", text: item.text };
    }

    return null;
  }
}
