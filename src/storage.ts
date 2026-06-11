import Database from "better-sqlite3";
import type { RunRecord, RunStatus, SandboxMode, TopicBinding } from "./types.js";

interface BindingRow {
  id: number;
  chat_id: number;
  message_thread_id: number;
  topic_name: string | null;
  repo_path: string;
  codex_thread_id: string | null;
  model: string | null;
  sandbox_mode: SandboxMode;
  approval_policy: "never";
  status: string;
  created_by_user_id: number;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: number;
  binding_id: number;
  telegram_message_id: number | null;
  prompt: string;
  status: RunStatus;
  codex_run_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  exit_code: number | null;
  final_message: string | null;
  error_message: string | null;
}

function now(): string {
  return new Date().toISOString();
}

function mapBinding(row: BindingRow): TopicBinding {
  return {
    id: row.id,
    chatId: row.chat_id,
    messageThreadId: row.message_thread_id,
    topicName: row.topic_name,
    repoPath: row.repo_path,
    codexThreadId: row.codex_thread_id,
    model: row.model,
    sandboxMode: row.sandbox_mode,
    approvalPolicy: row.approval_policy,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    bindingId: row.binding_id,
    telegramMessageId: row.telegram_message_id,
    prompt: row.prompt,
    status: row.status,
    codexRunId: row.codex_run_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    exitCode: row.exit_code,
    finalMessage: row.final_message,
    errorMessage: row.error_message,
  };
}

export class Storage {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topic_bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        message_thread_id INTEGER NOT NULL,
        topic_name TEXT,
        repo_path TEXT NOT NULL,
        codex_thread_id TEXT,
        model TEXT,
        sandbox_mode TEXT NOT NULL DEFAULT 'read-only',
        approval_policy TEXT NOT NULL DEFAULT 'never',
        status TEXT NOT NULL DEFAULT 'idle',
        created_by_user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (chat_id, message_thread_id)
      );

      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        binding_id INTEGER NOT NULL REFERENCES topic_bindings(id) ON DELETE CASCADE,
        telegram_message_id INTEGER,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        codex_run_id TEXT,
        started_at TEXT,
        completed_at TEXT,
        exit_code INTEGER,
        final_message TEXT,
        error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS repo_locks (
        repo_path TEXT PRIMARY KEY,
        run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        lock_mode TEXT NOT NULL,
        acquired_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        telegram_user_id INTEGER,
        chat_id INTEGER,
        message_thread_id INTEGER,
        event_type TEXT NOT NULL,
        details_json TEXT NOT NULL
      );
    `);

    this.addColumnIfMissing("topic_bindings", "model", "TEXT");
  }

  resetInterruptedRuns(): void {
    const timestamp = now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE runs SET status = 'failed', completed_at = ?, error_message = COALESCE(error_message, 'service restarted') WHERE status IN ('queued', 'running')",
        )
        .run(timestamp);
      this.db.prepare("DELETE FROM repo_locks").run();
      this.db.prepare("UPDATE topic_bindings SET status = 'idle', updated_at = ?").run(timestamp);
    });
    tx();
  }

  upsertBinding(input: {
    chatId: number;
    messageThreadId: number;
    topicName: string | null;
    repoPath: string;
    createdByUserId: number;
    sandboxMode: SandboxMode;
  }): TopicBinding {
    const timestamp = now();
    this.db
      .prepare(
        `
        INSERT INTO topic_bindings (
          chat_id, message_thread_id, topic_name, repo_path, sandbox_mode,
          approval_policy, status, created_by_user_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, 'never', 'idle', ?, ?, ?)
        ON CONFLICT(chat_id, message_thread_id) DO UPDATE SET
          topic_name = excluded.topic_name,
          repo_path = excluded.repo_path,
          sandbox_mode = excluded.sandbox_mode,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        input.chatId,
        input.messageThreadId,
        input.topicName,
        input.repoPath,
        input.sandboxMode,
        input.createdByUserId,
        timestamp,
        timestamp,
      );

    const binding = this.getBinding(input.chatId, input.messageThreadId);
    if (!binding) {
      throw new Error("Failed to load binding after upsert");
    }
    return binding;
  }

  getBinding(chatId: number, messageThreadId: number): TopicBinding | null {
    const row = this.db
      .prepare("SELECT * FROM topic_bindings WHERE chat_id = ? AND message_thread_id = ?")
      .get(chatId, messageThreadId) as BindingRow | undefined;
    return row ? mapBinding(row) : null;
  }

  getBindingById(bindingId: number): TopicBinding | null {
    const row = this.db
      .prepare("SELECT * FROM topic_bindings WHERE id = ?")
      .get(bindingId) as BindingRow | undefined;
    return row ? mapBinding(row) : null;
  }

  updateBindingMode(bindingId: number, sandboxMode: SandboxMode): void {
    this.db
      .prepare("UPDATE topic_bindings SET sandbox_mode = ?, updated_at = ? WHERE id = ?")
      .run(sandboxMode, now(), bindingId);
  }

  updateBindingModel(bindingId: number, model: string | null): void {
    this.db
      .prepare("UPDATE topic_bindings SET model = ?, codex_thread_id = NULL, updated_at = ? WHERE id = ?")
      .run(model, now(), bindingId);
  }

  updateBindingThread(bindingId: number, codexThreadId: string | null): void {
    this.db
      .prepare("UPDATE topic_bindings SET codex_thread_id = ?, updated_at = ? WHERE id = ?")
      .run(codexThreadId, now(), bindingId);
  }

  updateBindingStatus(bindingId: number, status: string): void {
    this.db
      .prepare("UPDATE topic_bindings SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now(), bindingId);
  }

  deleteBinding(bindingId: number): void {
    this.db.prepare("DELETE FROM topic_bindings WHERE id = ?").run(bindingId);
  }

  createRun(bindingId: number, telegramMessageId: number | null, prompt: string): RunRecord {
    const result = this.db
      .prepare(
        "INSERT INTO runs (binding_id, telegram_message_id, prompt, status) VALUES (?, ?, ?, 'queued')",
      )
      .run(bindingId, telegramMessageId, prompt);
    const run = this.getRun(Number(result.lastInsertRowid));
    if (!run) {
      throw new Error("Failed to load run after insert");
    }
    return run;
  }

  getRun(runId: number): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
      | RunRow
      | undefined;
    return row ? mapRun(row) : null;
  }

  getActiveRun(bindingId: number): RunRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM runs WHERE binding_id = ? AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1",
      )
      .get(bindingId) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  updateRunStarted(runId: number): void {
    this.db
      .prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?")
      .run(now(), runId);
  }

  updateRunCodexId(runId: number, codexRunId: string): void {
    this.db.prepare("UPDATE runs SET codex_run_id = ? WHERE id = ?").run(codexRunId, runId);
  }

  completeRun(runId: number, finalMessage: string | null, exitCode = 0): void {
    this.db
      .prepare(
        "UPDATE runs SET status = 'completed', completed_at = ?, exit_code = ?, final_message = ? WHERE id = ?",
      )
      .run(now(), exitCode, finalMessage, runId);
  }

  failRun(runId: number, errorMessage: string, exitCode: number | null = null): void {
    this.db
      .prepare(
        "UPDATE runs SET status = 'failed', completed_at = ?, exit_code = ?, error_message = ? WHERE id = ?",
      )
      .run(now(), exitCode, errorMessage, runId);
  }

  stopRun(runId: number): void {
    this.db
      .prepare("UPDATE runs SET status = 'stopped', completed_at = ?, error_message = ? WHERE id = ?")
      .run(now(), "stopped by user", runId);
  }

  acquireWriteLock(repoPath: string, runId: number): boolean {
    try {
      this.db
        .prepare(
          "INSERT INTO repo_locks (repo_path, run_id, lock_mode, acquired_at) VALUES (?, ?, 'write', ?)",
        )
        .run(repoPath, runId, now());
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        return false;
      }
      throw error;
    }
  }

  getRepoLock(repoPath: string): { repoPath: string; runId: number; lockMode: string; acquiredAt: string } | null {
    const row = this.db
      .prepare("SELECT repo_path, run_id, lock_mode, acquired_at FROM repo_locks WHERE repo_path = ?")
      .get(repoPath) as
      | { repo_path: string; run_id: number; lock_mode: string; acquired_at: string }
      | undefined;

    return row
      ? {
          repoPath: row.repo_path,
          runId: row.run_id,
          lockMode: row.lock_mode,
          acquiredAt: row.acquired_at,
        }
      : null;
  }

  releaseLock(repoPath: string, runId: number): void {
    this.db.prepare("DELETE FROM repo_locks WHERE repo_path = ? AND run_id = ?").run(repoPath, runId);
  }

  audit(input: {
    telegramUserId: number | null;
    chatId: number | null;
    messageThreadId: number | null;
    eventType: string;
    details: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `
        INSERT INTO audit_events (
          timestamp, telegram_user_id, chat_id, message_thread_id, event_type, details_json
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        now(),
        input.telegramUserId,
        input.chatId,
        input.messageThreadId,
        input.eventType,
        JSON.stringify(input.details),
      );
  }

  private addColumnIfMissing(tableName: string, columnName: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === columnName)) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  }
}
