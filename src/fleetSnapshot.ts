import Database from "better-sqlite3";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Storage } from "./storage.js";
import { nextCronRunAfter, validateCronExpression } from "./cron.js";

export interface FleetRepoSpec {
  name: string;
  remote: string;
  localPath: string;
  topicName?: string;
  topicId?: number;
  chatId?: number;
  agentStatePath?: string;
  runbookPath?: string;
  linkedRepos?: string[];
  healthChecks?: string[];
}

export interface FleetManifest {
  version: 1;
  name: string;
  managerRepo?: string;
  defaultChatId?: number;
  repos: FleetRepoSpec[];
}

interface ExportOptions {
  databasePath: string;
  outPath: string;
  manifestPath?: string;
  recentRuns: number;
}

interface RestoreOptions {
  databasePath: string;
  manifestPath: string;
  cloneRepos: boolean;
  createTopics: boolean;
  dryRun: boolean;
  botToken?: string;
}

interface BindingRow {
  id: number;
  chat_id: number;
  message_thread_id: number;
  topic_name: string | null;
  repo_path: string;
  codex_thread_id: string | null;
  model_provider: string | null;
  model: string | null;
  model_service_tier: string | null;
  plan_mode: number;
  sandbox_mode: string;
  approval_policy: string;
  status: string;
  updated_at: string;
}

interface CronRow {
  id: number;
  chat_id: number;
  binding_id: number;
  cron_expression: string;
  prompt: string;
  enabled: number;
  next_run_at: string;
  last_run_at: string | null;
  last_run_id: number | null;
  last_error: string | null;
  run_count: number;
}

interface RunRow {
  id: number;
  binding_id: number;
  prompt: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  final_message: string | null;
  error_message: string | null;
}

export async function exportFleetSnapshot(options: ExportOptions): Promise<void> {
  const db = new Database(options.databasePath, { readonly: true });
  try {
    const manifest = options.manifestPath ? await readJsonFile<FleetManifest>(options.manifestPath) : null;
    const manifestRepoPaths = new Set((manifest?.repos ?? []).map((repo) => repo.localPath));
    const bindings = (db.prepare("SELECT * FROM topic_bindings ORDER BY chat_id, message_thread_id").all() as BindingRow[])
      .filter((binding) => manifestRepoPaths.size === 0 || manifestRepoPaths.has(binding.repo_path));
    const bindingIds = bindings.map((binding) => binding.id);
    const crons = listCronRows(db, bindingIds);
    const runs = listRecentRuns(db, bindingIds, options.recentRuns);
    const repos = await Promise.all(
      (manifest?.repos ?? bindings.map(bindingToRepoSpec)).map(async (repo) => ({
        ...repo,
        git: gitSnapshot(repo.localPath),
        binding: formatOptionalBinding(bindings.find((binding) => binding.repo_path === repo.localPath)),
      })),
    );

    const snapshot = {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: {
        databasePath: options.databasePath,
        manifestPath: options.manifestPath ?? null,
      },
      manifest: manifest
        ? {
            name: manifest.name,
            managerRepo: manifest.managerRepo ?? null,
            defaultChatId: manifest.defaultChatId ?? null,
          }
        : null,
      repos,
      topicBindings: bindings.map(formatBinding),
      cronJobs: crons.map(formatCron),
      recentRuns: runs.map(formatRun),
      notes: [
        "codexThreadId is soft state. Restore should prefer repo-owned docs/agent context when a thread cannot resume.",
        "This snapshot excludes Telegram bot tokens, env files, pending upload files, and raw topic_messages.",
      ],
    };

    await mkdir(path.dirname(options.outPath), { recursive: true });
    await writeFile(options.outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  } finally {
    db.close();
  }
}

export async function restoreFleet(options: RestoreOptions): Promise<void> {
  const manifest = await readJsonFile<FleetManifest>(options.manifestPath);
  validateManifest(manifest);
  const storage = new Storage(options.databasePath);
  try {
    for (const repo of manifest.repos) {
      await ensureRepo(repo, options);
      const chatId = repo.chatId ?? manifest.defaultChatId;
      if (!chatId) {
        logRestore(options, `skip binding for ${repo.name}: no chatId in repo or manifest`);
        continue;
      }

      let topicId = repo.topicId ?? null;
      if (!topicId && options.createTopics) {
        topicId = await createTelegramTopic(options, chatId, repo.topicName ?? repo.name);
      }
      if (!topicId) {
        logRestore(options, `skip binding for ${repo.name}: no topicId and --create-topics not used`);
        continue;
      }

      logRestore(options, `bind ${repo.name} -> chat ${chatId}, topic ${topicId}, path ${repo.localPath}`);
      if (!options.dryRun) {
        storage.upsertBinding({
          chatId,
          messageThreadId: topicId,
          topicName: repo.topicName ?? repo.name,
          repoPath: repo.localPath,
          createdByUserId: 0,
          sandboxMode: "read-only",
          modelProvider: "openai",
        });
      }
    }
  } finally {
    storage.close();
  }
}

export async function backupFleetState(options: {
  databasePath: string;
  managerRepoPath: string;
  manifestPath: string;
  commit: boolean;
  push: boolean;
}): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const latestPath = path.join(options.managerRepoPath, "snapshots", "telegram-state", "latest.json");
  const datedPath = path.join(options.managerRepoPath, "snapshots", "telegram-state", `${timestamp}.json`);
  await exportFleetSnapshot({
    databasePath: options.databasePath,
    manifestPath: options.manifestPath,
    outPath: latestPath,
    recentRuns: 5,
  });
  await exportFleetSnapshot({
    databasePath: options.databasePath,
    manifestPath: options.manifestPath,
    outPath: datedPath,
    recentRuns: 5,
  });

  if (options.commit) {
    runGit(["add", "snapshots/telegram-state"], options.managerRepoPath);
    const status = runGit(["status", "--short", "snapshots/telegram-state"], options.managerRepoPath, false);
    if (status.trim()) {
      runGit(["commit", "-m", "Backup Telegram fleet state"], options.managerRepoPath);
      if (options.push) {
        runGit(["push"], options.managerRepoPath);
      }
    }
  }

  return latestPath;
}

function listCronRows(db: Database.Database, bindingIds: number[]): CronRow[] {
  if (bindingIds.length === 0) {
    return [];
  }
  return db
    .prepare(`SELECT * FROM cron_jobs WHERE binding_id IN (${bindingIds.map(() => "?").join(",")}) ORDER BY id`)
    .all(...bindingIds) as CronRow[];
}

function listRecentRuns(db: Database.Database, bindingIds: number[], limitPerBinding: number): RunRow[] {
  if (bindingIds.length === 0 || limitPerBinding <= 0) {
    return [];
  }
  const stmt = db.prepare("SELECT * FROM runs WHERE binding_id = ? ORDER BY id DESC LIMIT ?");
  return bindingIds.flatMap((bindingId) => stmt.all(bindingId, limitPerBinding) as RunRow[]);
}

function bindingToRepoSpec(binding: BindingRow): FleetRepoSpec {
  return {
    name: path.basename(binding.repo_path),
    remote: gitRemote(binding.repo_path) ?? "",
    localPath: binding.repo_path,
    topicName: binding.topic_name ?? path.basename(binding.repo_path),
    topicId: binding.message_thread_id,
    chatId: binding.chat_id,
  };
}

function formatBinding(binding: BindingRow): Record<string, unknown> {
  return {
    chatId: binding.chat_id,
    topicId: binding.message_thread_id,
    topicName: binding.topic_name,
    repoPath: binding.repo_path,
    codexThreadId: binding.codex_thread_id,
    modelProvider: binding.model_provider ?? "openai",
    model: binding.model,
    modelServiceTier: binding.model_service_tier,
    planMode: binding.plan_mode === 1,
    sandboxMode: binding.sandbox_mode,
    approvalPolicy: binding.approval_policy,
    status: binding.status,
    updatedAt: binding.updated_at,
  };
}

function formatOptionalBinding(binding: BindingRow | undefined): Record<string, unknown> | null {
  return binding ? formatBinding(binding) : null;
}

function formatCron(cron: CronRow): Record<string, unknown> {
  return {
    id: cron.id,
    chatId: cron.chat_id,
    bindingId: cron.binding_id,
    cronExpression: cron.cron_expression,
    prompt: cron.prompt,
    enabled: cron.enabled === 1,
    nextRunAt: cron.next_run_at,
    lastRunAt: cron.last_run_at,
    lastRunId: cron.last_run_id,
    lastError: cron.last_error,
    runCount: cron.run_count,
  };
}

function formatRun(run: RunRow): Record<string, unknown> {
  return {
    id: run.id,
    bindingId: run.binding_id,
    prompt: truncate(run.prompt, 2000),
    status: run.status,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    finalMessage: run.final_message ? truncate(run.final_message, 4000) : null,
    errorMessage: run.error_message ? truncate(run.error_message, 4000) : null,
  };
}

function gitSnapshot(repoPath: string): Record<string, unknown> {
  return {
    remote: gitRemote(repoPath),
    branch: gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], repoPath),
    commitHash: gitOutput(["rev-parse", "HEAD"], repoPath),
    statusShort: gitOutput(["status", "--short"], repoPath),
  };
}

function gitRemote(repoPath: string): string | null {
  return gitOutput(["remote", "get-url", "origin"], repoPath);
}

function gitOutput(args: string[], cwd: string): string | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

async function ensureRepo(repo: FleetRepoSpec, options: RestoreOptions): Promise<void> {
  if (existsSync(repo.localPath)) {
    logRestore(options, `repo exists: ${repo.localPath}`);
    return;
  }
  logRestore(options, `clone ${repo.remote} -> ${repo.localPath}`);
  if (!options.cloneRepos || options.dryRun) {
    return;
  }
  await mkdir(path.dirname(repo.localPath), { recursive: true });
  const result = spawnSync("git", ["clone", repo.remote, repo.localPath], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git clone failed for ${repo.name}: ${result.stderr || result.stdout}`);
  }
}

async function createTelegramTopic(options: RestoreOptions, chatId: number, topicName: string): Promise<number | null> {
  const token = options.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("--create-topics requires TELEGRAM_BOT_TOKEN or --bot-token.");
  }
  logRestore(options, `create Telegram topic "${topicName}" in chat ${chatId}`);
  if (options.dryRun) {
    return null;
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/createForumTopic`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, name: topicName }),
  });
  const body = await response.json() as { ok?: boolean; result?: { message_thread_id?: number }; description?: string };
  if (!response.ok || !body.ok || !body.result?.message_thread_id) {
    throw new Error(`Telegram createForumTopic failed: ${body.description ?? response.statusText}`);
  }
  return body.result.message_thread_id;
}

function validateManifest(manifest: FleetManifest): void {
  if (manifest.version !== 1 || !Array.isArray(manifest.repos)) {
    throw new Error("Unsupported fleet manifest. Expected version 1 with repos array.");
  }
  for (const repo of manifest.repos) {
    if (!repo.name || !repo.remote || !repo.localPath) {
      throw new Error("Each repo needs name, remote, and localPath.");
    }
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function runGit(args: string[], cwd: string, throwOnError = true): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0 && throwOnError) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function logRestore(options: RestoreOptions, message: string): void {
  process.stdout.write(`${options.dryRun ? "[dry-run] " : ""}${message}\n`);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

export function nextRunForCronExpression(expression: string): string {
  return nextCronRunAfter(validateCronExpression(expression), new Date()).toISOString();
}
