import Database from "better-sqlite3";
import type {
  CronJobRecord,
  InterruptedRunRecord,
  ModelProvider,
  RunRecord,
  RunStatus,
  SandboxMode,
  ThreadTokenUsageSnapshot,
  TopicBinding,
  WorkItemRecord,
  WorkItemStatus,
} from "./types.js";

interface BindingRow {
  id: number;
  chat_id: number;
  message_thread_id: number;
  topic_name: string | null;
  repo_path: string;
  codex_thread_id: string | null;
  model_provider: ModelProvider | null;
  model: string | null;
  model_service_tier: string | null;
  plan_mode: number;
  sandbox_mode: SandboxMode;
  approval_policy: "never";
  status: string;
  token_usage_json: string | null;
  created_by_user_id: number;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: number;
  binding_id: number;
  telegram_message_id: number | null;
  prompt: string;
  plan_mode: number;
  status: RunStatus;
  codex_run_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  exit_code: number | null;
  final_message: string | null;
  error_message: string | null;
}

interface PendingContextFileRow {
  id: number;
  binding_id: number;
  telegram_message_id: number | null;
  kind: string;
  relative_path: string;
  original_name: string | null;
  mime_type: string | null;
  file_size: number;
  created_at: string;
}

interface ManagerEventRow {
  id: number;
  chat_id: number;
  source_message_thread_id: number;
  binding_id: number | null;
  run_id: number | null;
  event_type: string;
  summary: string;
  details_json: string;
  created_at: string;
}

interface TopicMessageRow {
  id: number;
  chat_id: number;
  message_thread_id: number;
  telegram_message_id: number | null;
  direction: "in" | "out";
  author_id: number | null;
  author_name: string | null;
  text: string;
  created_at: string;
}

interface CronJobRow {
  id: number;
  chat_id: number;
  binding_id: number;
  created_by_user_id: number | null;
  cron_expression: string;
  prompt: string;
  enabled: number;
  next_run_at: string;
  last_run_at: string | null;
  last_run_id: number | null;
  last_error: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

interface WorkItemRow {
  id: number;
  chat_id: number;
  binding_id: number | null;
  created_by_user_id: number | null;
  title: string;
  detail: string | null;
  status: WorkItemStatus;
  priority: string;
  evidence: string | null;
  last_run_id: number | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface PendingContextFileRecord {
  id: number;
  bindingId: number;
  telegramMessageId: number | null;
  kind: string;
  relativePath: string;
  originalName: string | null;
  mimeType: string | null;
  fileSize: number;
  createdAt: string;
}

export interface ManagerEventRecord {
  id: number;
  chatId: number;
  sourceMessageThreadId: number;
  bindingId: number | null;
  runId: number | null;
  eventType: string;
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface TopicMessageRecord {
  id: number;
  chatId: number;
  messageThreadId: number;
  telegramMessageId: number | null;
  direction: "in" | "out";
  authorId: number | null;
  authorName: string | null;
  text: string;
  createdAt: string;
}

export interface PendingContextFileInput {
  kind: string;
  relativePath: string;
  originalName: string | null;
  mimeType: string | null;
  fileSize: number;
}

export interface TopicMessageInput {
  chatId: number;
  messageThreadId: number;
  telegramMessageId: number | null;
  direction: "in" | "out";
  authorId: number | null;
  authorName: string | null;
  text: string;
}

export interface ManagerEventInput {
  chatId: number;
  sourceMessageThreadId: number;
  bindingId: number | null;
  runId: number | null;
  eventType: string;
  summary: string;
  details: Record<string, unknown>;
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
    modelProvider: normalizeModelProvider(row.model_provider),
    model: row.model,
    modelServiceTier: row.model_service_tier,
    planMode: row.plan_mode === 1,
    sandboxMode: row.sandbox_mode,
    approvalPolicy: row.approval_policy,
    status: row.status,
    tokenUsage: parseTokenUsage(row.token_usage_json),
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeModelProvider(value: string | null): ModelProvider {
  if (value === "xai" || value === "claude") {
    return value;
  }
  return "openai";
}

function parseTokenUsage(value: string | null): ThreadTokenUsageSnapshot | null {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as ThreadTokenUsageSnapshot;
  } catch {
    return null;
  }
}

function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    bindingId: row.binding_id,
    telegramMessageId: row.telegram_message_id,
    prompt: row.prompt,
    planMode: row.plan_mode === 1,
    status: row.status,
    codexRunId: row.codex_run_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    exitCode: row.exit_code,
    finalMessage: row.final_message,
    errorMessage: row.error_message,
  };
}

function mapPendingContextFile(row: PendingContextFileRow): PendingContextFileRecord {
  return {
    id: row.id,
    bindingId: row.binding_id,
    telegramMessageId: row.telegram_message_id,
    kind: row.kind,
    relativePath: row.relative_path,
    originalName: row.original_name,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    createdAt: row.created_at,
  };
}

function mapTopicMessage(row: TopicMessageRow): TopicMessageRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    messageThreadId: row.message_thread_id,
    telegramMessageId: row.telegram_message_id,
    direction: row.direction,
    authorId: row.author_id,
    authorName: row.author_name,
    text: row.text,
    createdAt: row.created_at,
  };
}

function mapManagerEvent(row: ManagerEventRow): ManagerEventRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    sourceMessageThreadId: row.source_message_thread_id,
    bindingId: row.binding_id,
    runId: row.run_id,
    eventType: row.event_type,
    summary: row.summary,
    details: parseJsonObject(row.details_json),
    createdAt: row.created_at,
  };
}

function mapCronJob(row: CronJobRow): CronJobRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    bindingId: row.binding_id,
    createdByUserId: row.created_by_user_id,
    cronExpression: row.cron_expression,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastRunId: row.last_run_id,
    lastError: row.last_error,
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWorkItem(row: WorkItemRow): WorkItemRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    bindingId: row.binding_id,
    createdByUserId: row.created_by_user_id,
    title: row.title,
    detail: row.detail,
    status: row.status,
    priority: row.priority,
    evidence: row.evidence,
    lastRunId: row.last_run_id,
    dueAt: row.due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
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
        model_provider TEXT NOT NULL DEFAULT 'openai',
        model TEXT,
        model_service_tier TEXT,
        plan_mode INTEGER NOT NULL DEFAULT 0,
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
        plan_mode INTEGER NOT NULL DEFAULT 0,
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

      CREATE TABLE IF NOT EXISTS pending_context_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        binding_id INTEGER NOT NULL REFERENCES topic_bindings(id) ON DELETE CASCADE,
        telegram_message_id INTEGER,
        kind TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        original_name TEXT,
        mime_type TEXT,
        file_size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS manager_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        source_message_thread_id INTEGER NOT NULL,
        binding_id INTEGER REFERENCES topic_bindings(id) ON DELETE SET NULL,
        run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS topic_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        message_thread_id INTEGER NOT NULL,
        telegram_message_id INTEGER,
        direction TEXT NOT NULL,
        author_id INTEGER,
        author_name TEXT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS topic_messages_topic_idx
        ON topic_messages (chat_id, message_thread_id, id);

      CREATE TABLE IF NOT EXISTS cron_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        binding_id INTEGER NOT NULL REFERENCES topic_bindings(id) ON DELETE CASCADE,
        created_by_user_id INTEGER,
        cron_expression TEXT NOT NULL,
        prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at TEXT NOT NULL,
        last_run_at TEXT,
        last_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
        last_error TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS cron_jobs_due_idx
        ON cron_jobs (enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS cron_jobs_chat_idx
        ON cron_jobs (chat_id, id);

      CREATE TABLE IF NOT EXISTS work_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        binding_id INTEGER REFERENCES topic_bindings(id) ON DELETE SET NULL,
        created_by_user_id INTEGER,
        title TEXT NOT NULL,
        detail TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        priority TEXT NOT NULL DEFAULT 'normal',
        evidence TEXT,
        last_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
        due_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS work_items_chat_status_idx
        ON work_items (chat_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS work_items_binding_idx
        ON work_items (binding_id, status);
    `);

    this.addColumnIfMissing("topic_bindings", "model", "TEXT");
    this.addColumnIfMissing("topic_bindings", "model_provider", "TEXT NOT NULL DEFAULT 'openai'");
    this.addColumnIfMissing("topic_bindings", "model_service_tier", "TEXT");
    this.addColumnIfMissing("topic_bindings", "plan_mode", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("topic_bindings", "token_usage_json", "TEXT");
    this.addColumnIfMissing("runs", "plan_mode", "INTEGER NOT NULL DEFAULT 0");
  }

  createWorkItem(input: {
    chatId: number;
    bindingId: number | null;
    createdByUserId: number | null;
    title: string;
    detail?: string | null;
    priority?: string | null;
    dueAt?: string | null;
  }): WorkItemRecord {
    const timestamp = now();
    const result = this.db
      .prepare(
        `
        INSERT INTO work_items (
          chat_id, binding_id, created_by_user_id, title, detail, status, priority, due_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
      `,
      )
      .run(
        input.chatId,
        input.bindingId,
        input.createdByUserId,
        input.title,
        input.detail ?? null,
        input.priority?.trim() || "normal",
        input.dueAt ?? null,
        timestamp,
        timestamp,
      );
    const item = this.getWorkItem(Number(result.lastInsertRowid));
    if (!item) {
      throw new Error("Failed to load work item after insert");
    }
    return item;
  }

  getWorkItem(workItemId: number): WorkItemRecord | null {
    const row = this.db.prepare("SELECT * FROM work_items WHERE id = ?").get(workItemId) as
      | WorkItemRow
      | undefined;
    return row ? mapWorkItem(row) : null;
  }

  listWorkItemsForChat(chatId: number, options: { includeClosed?: boolean; limit?: number } = {}): WorkItemRecord[] {
    const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50)));
    const statusesClause = options.includeClosed ? "" : "AND status NOT IN ('done', 'canceled')";
    const rows = this.db
      .prepare(
        `
        SELECT * FROM work_items
        WHERE chat_id = ?
          ${statusesClause}
        ORDER BY
          CASE status
            WHEN 'in_progress' THEN 0
            WHEN 'blocked' THEN 1
            WHEN 'open' THEN 2
            WHEN 'done' THEN 3
            ELSE 4
          END,
          updated_at DESC,
          id DESC
        LIMIT ?
      `,
      )
      .all(chatId, limit) as WorkItemRow[];
    return rows.map(mapWorkItem);
  }

  updateWorkItemForChat(
    chatId: number,
    workItemId: number,
    input: {
      status?: WorkItemStatus;
      title?: string;
      detail?: string | null;
      priority?: string;
      evidence?: string | null;
      lastRunId?: number | null;
      dueAt?: string | null;
    },
  ): WorkItemRecord | null {
    const current = this.getWorkItem(workItemId);
    if (!current || current.chatId !== chatId) {
      return null;
    }

    const status = input.status ?? current.status;
    const completedAt =
      status === "done" || status === "canceled"
        ? current.completedAt ?? now()
        : status === "open" || status === "in_progress" || status === "blocked"
          ? null
          : current.completedAt;

    this.db
      .prepare(
        `
        UPDATE work_items
        SET title = ?,
            detail = ?,
            status = ?,
            priority = ?,
            evidence = ?,
            last_run_id = ?,
            due_at = ?,
            completed_at = ?,
            updated_at = ?
        WHERE chat_id = ? AND id = ?
      `,
      )
      .run(
        input.title?.trim() || current.title,
        input.detail !== undefined ? input.detail : current.detail,
        status,
        input.priority?.trim() || current.priority,
        input.evidence !== undefined ? input.evidence : current.evidence,
        input.lastRunId !== undefined ? input.lastRunId : current.lastRunId,
        input.dueAt !== undefined ? input.dueAt : current.dueAt,
        completedAt,
        now(),
        chatId,
        workItemId,
      );
    return this.getWorkItem(workItemId);
  }

  createCronJob(input: {
    chatId: number;
    bindingId: number;
    createdByUserId: number | null;
    cronExpression: string;
    prompt: string;
    nextRunAt: string;
  }): CronJobRecord {
    const timestamp = now();
    const result = this.db
      .prepare(
        `
        INSERT INTO cron_jobs (
          chat_id, binding_id, created_by_user_id, cron_expression, prompt,
          enabled, next_run_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
      `,
      )
      .run(
        input.chatId,
        input.bindingId,
        input.createdByUserId,
        input.cronExpression,
        input.prompt,
        input.nextRunAt,
        timestamp,
        timestamp,
      );
    const job = this.getCronJob(Number(result.lastInsertRowid));
    if (!job) {
      throw new Error("Failed to load cron job after insert");
    }
    return job;
  }

  getCronJob(cronJobId: number): CronJobRecord | null {
    const row = this.db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(cronJobId) as
      | CronJobRow
      | undefined;
    return row ? mapCronJob(row) : null;
  }

  listCronJobsForChat(chatId: number): CronJobRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM cron_jobs WHERE chat_id = ? ORDER BY enabled DESC, next_run_at ASC, id ASC")
      .all(chatId) as CronJobRow[];
    return rows.map(mapCronJob);
  }

  listDueCronJobs(nowIso: string, limit: number): CronJobRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM cron_jobs
        WHERE enabled = 1 AND next_run_at <= ?
        ORDER BY next_run_at ASC, id ASC
        LIMIT ?
      `,
      )
      .all(nowIso, limit) as CronJobRow[];
    return rows.map(mapCronJob);
  }

  updateCronJobAfterRun(cronJobId: number, input: { runId: number; nextRunAt: string }): void {
    this.db
      .prepare(
        `
        UPDATE cron_jobs
        SET last_run_at = ?,
            last_run_id = ?,
            last_error = NULL,
            run_count = run_count + 1,
            next_run_at = ?,
            updated_at = ?
        WHERE id = ?
      `,
      )
      .run(now(), input.runId, input.nextRunAt, now(), cronJobId);
  }

  updateCronJobError(cronJobId: number, error: string, nextRunAt: string): void {
    this.db
      .prepare("UPDATE cron_jobs SET last_error = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
      .run(error, nextRunAt, now(), cronJobId);
  }

  setCronJobEnabled(cronJobId: number, enabled: boolean): boolean {
    const result = this.db
      .prepare("UPDATE cron_jobs SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, now(), cronJobId);
    return result.changes > 0;
  }

  setCronJobEnabledForChat(chatId: number, cronJobId: number, enabled: boolean): boolean {
    const result = this.db
      .prepare("UPDATE cron_jobs SET enabled = ?, updated_at = ? WHERE chat_id = ? AND id = ?")
      .run(enabled ? 1 : 0, now(), chatId, cronJobId);
    return result.changes > 0;
  }

  prepareInterruptedRunsForResume(): InterruptedRunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE status IN ('queued', 'running') ORDER BY id ASC")
      .all() as RunRow[];
    if (rows.length === 0) {
      return [];
    }

    const timestamp = now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE runs
          SET status = 'queued',
              started_at = NULL,
              completed_at = NULL,
              exit_code = NULL,
              error_message = NULL
          WHERE status IN ('queued', 'running')
        `,
        )
        .run();
      this.db.prepare("DELETE FROM repo_locks").run();
      this.db.prepare("UPDATE topic_bindings SET status = 'idle', updated_at = ?").run(timestamp);
    });
    tx();

    return rows.map((row) => ({
      ...mapRun({
        ...row,
        status: "queued",
        started_at: null,
        completed_at: null,
        exit_code: null,
        error_message: null,
      }),
      interruptedStatus: row.status as InterruptedRunRecord["interruptedStatus"],
    }));
  }

  upsertBinding(input: {
    chatId: number;
    messageThreadId: number;
    topicName: string | null;
    repoPath: string;
    createdByUserId: number;
    sandboxMode: SandboxMode;
    modelProvider: ModelProvider;
  }): TopicBinding {
    const timestamp = now();
    this.db
      .prepare(
        `
        INSERT INTO topic_bindings (
          chat_id, message_thread_id, topic_name, repo_path, sandbox_mode, model_provider,
          approval_policy, status, created_by_user_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'never', 'idle', ?, ?, ?)
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
        input.modelProvider,
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

  listBindingsForChat(chatId: number): TopicBinding[] {
    const rows = this.db
      .prepare("SELECT * FROM topic_bindings WHERE chat_id = ? ORDER BY message_thread_id ASC")
      .all(chatId) as BindingRow[];
    return rows.map(mapBinding);
  }

  updateBindingMode(bindingId: number, sandboxMode: SandboxMode): void {
    this.db
      .prepare("UPDATE topic_bindings SET sandbox_mode = ?, updated_at = ? WHERE id = ?")
      .run(sandboxMode, now(), bindingId);
  }

  updateBindingModel(bindingId: number, model: string | null): void {
    this.db
      .prepare("UPDATE topic_bindings SET model = ?, model_service_tier = NULL, updated_at = ? WHERE id = ?")
      .run(model, now(), bindingId);
  }

  updateBindingModelSelection(
    bindingId: number,
    modelProvider: ModelProvider,
    model: string | null,
    modelServiceTier: string | null = null,
  ): void {
    this.db
      .prepare("UPDATE topic_bindings SET model_provider = ?, model = ?, model_service_tier = ?, updated_at = ? WHERE id = ?")
      .run(modelProvider, model, modelServiceTier, now(), bindingId);
  }

  updateBindingPlanMode(bindingId: number, planMode: boolean): void {
    this.db
      .prepare("UPDATE topic_bindings SET plan_mode = ?, updated_at = ? WHERE id = ?")
      .run(planMode ? 1 : 0, now(), bindingId);
  }

  updateBindingThread(bindingId: number, codexThreadId: string | null): void {
    if (codexThreadId) {
      this.db
        .prepare("UPDATE topic_bindings SET codex_thread_id = ?, updated_at = ? WHERE id = ?")
        .run(codexThreadId, now(), bindingId);
      return;
    }

    this.db
      .prepare("UPDATE topic_bindings SET codex_thread_id = NULL, token_usage_json = NULL, updated_at = ? WHERE id = ?")
      .run(now(), bindingId);
  }

  updateBindingTokenUsage(bindingId: number, tokenUsage: ThreadTokenUsageSnapshot): void {
    this.db
      .prepare("UPDATE topic_bindings SET token_usage_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(tokenUsage), now(), bindingId);
  }

  updateBindingStatus(bindingId: number, status: string): void {
    this.db
      .prepare("UPDATE topic_bindings SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now(), bindingId);
  }

  updateBindingRepoPath(bindingId: number, repoPath: string, topicName: string | null = null): void {
    this.db
      .prepare(
        "UPDATE topic_bindings SET repo_path = ?, topic_name = ?, codex_thread_id = NULL, token_usage_json = NULL, updated_at = ? WHERE id = ?",
      )
      .run(repoPath, topicName, now(), bindingId);
  }

  deleteBinding(bindingId: number): void {
    this.db.prepare("DELETE FROM topic_bindings WHERE id = ?").run(bindingId);
  }

  createRun(bindingId: number, telegramMessageId: number | null, prompt: string, planMode = false): RunRecord {
    const result = this.db
      .prepare(
        "INSERT INTO runs (binding_id, telegram_message_id, prompt, plan_mode, status) VALUES (?, ?, ?, ?, 'queued')",
      )
      .run(bindingId, telegramMessageId, prompt, planMode ? 1 : 0);
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

  getLatestRun(bindingId: number): RunRecord | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE binding_id = ? ORDER BY id DESC LIMIT 1")
      .get(bindingId) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  listActionableRunsForChat(chatId: number, limit: number): Array<{ binding: TopicBinding; run: RunRecord }> {
    const rows = this.db
      .prepare(
        `
        SELECT b.id AS binding_id, r.id AS run_id
        FROM runs r
        JOIN topic_bindings b ON b.id = r.binding_id
        WHERE b.chat_id = ?
          AND b.message_thread_id != 0
          AND r.status IN ('queued', 'running', 'failed')
        ORDER BY
          CASE r.status
            WHEN 'running' THEN 0
            WHEN 'queued' THEN 1
            ELSE 2
          END,
          r.id DESC
        LIMIT ?
      `,
      )
      .all(chatId, limit) as Array<{ binding_id: number; run_id: number }>;

    return rows.flatMap((row) => {
      const binding = this.getBindingById(row.binding_id);
      const run = this.getRun(row.run_id);
      return binding && run ? [{ binding, run }] : [];
    });
  }

  updateRunStarted(runId: number): void {
    this.db
      .prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?")
      .run(now(), runId);
  }

  updateRunCodexId(runId: number, codexRunId: string): void {
    this.db.prepare("UPDATE runs SET codex_run_id = ? WHERE id = ?").run(codexRunId, runId);
  }

  updateRunTelegramMessageId(runId: number, telegramMessageId: number): void {
    this.db.prepare("UPDATE runs SET telegram_message_id = ? WHERE id = ?").run(telegramMessageId, runId);
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

  addPendingContextFiles(
    bindingId: number,
    telegramMessageId: number | null,
    files: PendingContextFileInput[],
  ): void {
    if (files.length === 0) {
      return;
    }

    const timestamp = now();
    const insert = this.db.prepare(
      `
      INSERT INTO pending_context_files (
        binding_id, telegram_message_id, kind, relative_path, original_name, mime_type, file_size, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    );
    const tx = this.db.transaction(() => {
      for (const file of files) {
        insert.run(
          bindingId,
          telegramMessageId,
          file.kind,
          file.relativePath,
          file.originalName,
          file.mimeType,
          file.fileSize,
          timestamp,
        );
      }
    });
    tx();
  }

  listPendingContextFiles(bindingId: number): PendingContextFileRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM pending_context_files WHERE binding_id = ? ORDER BY id ASC")
      .all(bindingId) as PendingContextFileRow[];
    return rows.map(mapPendingContextFile);
  }

  consumePendingContextFiles(bindingId: number): PendingContextFileRecord[] {
    const tx = this.db.transaction(() => {
      const files = this.listPendingContextFiles(bindingId);
      if (files.length > 0) {
        this.db.prepare("DELETE FROM pending_context_files WHERE binding_id = ?").run(bindingId);
      }
      return files;
    });
    return tx();
  }

  addManagerEvent(input: ManagerEventInput): void {
    this.db
      .prepare(
        `
        INSERT INTO manager_events (
          chat_id, source_message_thread_id, binding_id, run_id, event_type, summary, details_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        input.chatId,
        input.sourceMessageThreadId,
        input.bindingId,
        input.runId,
        input.eventType,
        input.summary,
        JSON.stringify(input.details),
        now(),
      );
  }

  listManagerEvents(chatId: number, limit: number): ManagerEventRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM manager_events WHERE chat_id = ? ORDER BY id DESC LIMIT ?")
      .all(chatId, limit) as ManagerEventRow[];
    return rows.map(mapManagerEvent);
  }

  addTopicMessage(input: TopicMessageInput): void {
    if (!input.text.trim()) {
      return;
    }

    this.db
      .prepare(
        `
        INSERT INTO topic_messages (
          chat_id, message_thread_id, telegram_message_id, direction, author_id, author_name, text, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        input.chatId,
        input.messageThreadId,
        input.telegramMessageId,
        input.direction,
        input.authorId,
        input.authorName,
        input.text,
        now(),
      );
  }

  listTopicMessages(chatId: number, messageThreadId: number, limit: number): TopicMessageRecord[] {
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = this.db
      .prepare(
        `
        SELECT * FROM topic_messages
        WHERE chat_id = ? AND message_thread_id = ?
        ORDER BY id DESC
        LIMIT ?
      `,
      )
      .all(chatId, messageThreadId, boundedLimit) as TopicMessageRow[];
    return rows.reverse().map(mapTopicMessage);
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
