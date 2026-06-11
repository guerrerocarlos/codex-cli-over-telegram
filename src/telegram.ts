import { Bot, InputFile, type Context } from "grammy";
import type { AppConfig } from "./config.js";
import type { CodexBackend, CodexRunEvent, RunRecord, SandboxMode, TopicBinding } from "./types.js";
import { Storage } from "./storage.js";
import { RunQueue } from "./runQueue.js";
import { resolveAllowedRepoPath } from "./pathPolicy.js";
import { codeBlock, markdownV2Chunks, truncateText } from "./text.js";
import { commitAll, currentBranch, diffSummary, fullDiff, isGitRepository, pushHead, statusShort } from "./git.js";
import { logger } from "./logger.js";

interface TopicRef {
  chatId: number;
  messageThreadId: number;
}

export function createTelegramBot(
  config: AppConfig,
  storage: Storage,
  codex: CodexBackend,
): Bot {
  const bot = new Bot(config.telegramBotToken);
  const queue = new RunQueue(config.maxParallelRuns);

  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!fromId || !chatId) {
      return;
    }

    if (config.allowedTelegramUserIds.size === 0 || config.allowedTelegramChatIds.size === 0) {
      storage.audit({
        telegramUserId: fromId,
        chatId,
        messageThreadId: ctx.message?.message_thread_id ?? null,
        eventType: "bootstrap_setup_message",
        details: { username: ctx.from?.username ?? null },
      });
      await reply(ctx, bootstrapSetupText(ctx, config), config);
      return;
    }

    if (!config.allowedTelegramUserIds.has(fromId)) {
      storage.audit({
        telegramUserId: fromId,
        chatId,
        messageThreadId: ctx.message?.message_thread_id ?? null,
        eventType: "unauthorized_message",
        details: { username: ctx.from?.username ?? null },
      });
      return;
    }

    if (!config.allowedTelegramChatIds.has(chatId)) {
      storage.audit({
        telegramUserId: fromId,
        chatId,
        messageThreadId: ctx.message?.message_thread_id ?? null,
        eventType: "unauthorized_chat",
        details: { username: ctx.from?.username ?? null },
      });
      await reply(
        ctx,
        [
      "This chat is not authorized.",
      "",
      "Add this value to .env, then restart the bot:",
      "",
      codeBlock(`ALLOWED_TELEGRAM_CHAT_IDS=${chatId}`),
        ].join("\n"),
        config,
      );
      return;
    }

    await next();
  });

  bot.command("help", async (ctx) => {
    await reply(ctx, helpText(), config);
  });

  bot.command("bind", async (ctx) => {
    const topic = getTopicRef(ctx, config);
    if (!topic) {
      await reply(ctx, "This chat has no topic id. Use this command inside a Telegram forum topic.", config);
      return;
    }

    const requestedPath = ctx.match.trim();
    if (!requestedPath) {
      await reply(ctx, "Usage: /bind /absolute/path or /bind ~/path", config);
      return;
    }

    try {
      const repoPath = await resolveAllowedRepoPath(requestedPath, config.allowedRepoRoots);
      const topicName = topicNameForPath(repoPath);
      const isRepo = await isGitRepository(repoPath);

      const binding = storage.upsertBinding({
        chatId: topic.chatId,
        messageThreadId: topic.messageThreadId,
        topicName,
        repoPath,
        createdByUserId: ctx.from?.id ?? 0,
        sandboxMode: config.defaultSandboxMode,
      });
      storage.audit({
        telegramUserId: ctx.from?.id ?? null,
        chatId: topic.chatId,
        messageThreadId: topic.messageThreadId,
        eventType: "bind",
        details: { repoPath },
      });

      const branch = isRepo ? await currentBranch(repoPath) : "(not a git repository)";
      const renameResult = await renameForumTopicForBinding(ctx, binding, topicName);
      await reply(
        ctx,
        [
          `Bound this topic to:`,
          codeBlock(binding.repoPath),
          "",
          `Branch:\n${codeBlock(branch)}`,
          `Mode:\n${codeBlock(binding.sandboxMode)}`,
          isRepo ? null : "Git commands are unavailable until this path is initialized as a repo.",
          renameResult,
        ]
          .filter(Boolean)
          .join("\n"),
        config,
      );
    } catch (error) {
      await reply(ctx, error instanceof Error ? error.message : String(error), config);
    }
  });

  bot.command("where", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }

    const isRepo = await isGitRepository(binding.repoPath);
    const branch = isRepo ? await currentBranch(binding.repoPath) : "(not a git repository)";
    const status = isRepo ? await statusShort(binding.repoPath) : "not a git repository";
    await reply(
      ctx,
      [
        `Repo: ${binding.repoPath}`,
        codeBlock(binding.repoPath),
        `Branch:\n${codeBlock(branch)}`,
        `Mode:\n${codeBlock(binding.sandboxMode)}`,
        `Codex session:\n${codeBlock(binding.codexThreadId ?? "(new)")}`,
        `Status:\n${codeBlock(binding.status)}`,
        "",
        `Git status:\n${codeBlock(status)}`,
      ].join("\n"),
      config,
    );
  });

  bot.command("mode", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }

    const mode = parseMode(ctx.match.trim());
    if (!mode) {
      await reply(ctx, "Usage: /mode read or /mode write", config);
      return;
    }

    storage.updateBindingMode(binding.id, mode);
    storage.audit({
      telegramUserId: ctx.from?.id ?? null,
      chatId: binding.chatId,
      messageThreadId: binding.messageThreadId,
      eventType: "mode",
      details: { mode },
    });
    await reply(ctx, `Mode set to ${mode}.`, config);
  });

  bot.command("topic", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }
    const topicName = topicNameForPath(binding.repoPath);
    const renameResult = await renameForumTopicForBinding(ctx, binding, topicName);
    await reply(ctx, renameResult || `No forum topic to rename for ${binding.repoPath}.`, config);
  });

  bot.command("new", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }
    storage.updateBindingThread(binding.id, null);
    storage.audit({
      telegramUserId: ctx.from?.id ?? null,
      chatId: binding.chatId,
      messageThreadId: binding.messageThreadId,
      eventType: "new_thread",
      details: { bindingId: binding.id },
    });
    await reply(ctx, "Started a fresh Codex session for this topic.", config);
  });

  bot.command("status", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }
    const active = storage.getActiveRun(binding.id);
    if (!active) {
      await reply(
        ctx,
        [`Idle.`, `Repo:\n${codeBlock(binding.repoPath)}`, `Mode:\n${codeBlock(binding.sandboxMode)}`].join("\n"),
        config,
      );
      return;
    }
    await reply(
      ctx,
      `Run #${active.id} is ${active.status}.\nPrompt:\n${codeBlock(truncateText(active.prompt, 700))}`,
      config,
    );
  });

  bot.command("stop", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }

    const active = storage.getActiveRun(binding.id);
    const interrupted = await codex.interrupt(binding.id);
    if (active) {
      storage.stopRun(active.id);
      storage.updateBindingStatus(binding.id, "idle");
    }
    await reply(ctx, interrupted ? "Stopped active Codex run." : "No active Codex process found.", config);
  });

  bot.command("diff", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }
    if (!(await ensureGitRepository(ctx, config, binding))) {
      return;
    }
    const summary = await diffSummary(binding.repoPath);
    await reply(ctx, `Diff summary:\n${codeBlock(summary, "diff")}`, config);

    const diff = await fullDiff(binding.repoPath);
    if (diff.length > config.maxTelegramMessageChars) {
      await ctx.api.sendDocument(
        binding.chatId,
        new InputFile(Buffer.from(diff), "diff.patch"),
        { message_thread_id: binding.messageThreadId },
      );
    } else if (diff.trim()) {
      await reply(ctx, codeBlock(diff, "diff"), config);
    }
  });

  bot.command("commit", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }
    if (!(await ensureNoActiveRun(ctx, config, storage, binding))) {
      return;
    }
    if (!(await ensureGitRepository(ctx, config, binding))) {
      return;
    }
    const message = ctx.match.trim();
    if (!message) {
      await reply(ctx, "Usage: /commit Commit message", config);
      return;
    }

    try {
      const output = await commitAll(binding.repoPath, message);
      storage.audit({
        telegramUserId: ctx.from?.id ?? null,
        chatId: binding.chatId,
        messageThreadId: binding.messageThreadId,
        eventType: "commit",
        details: { message },
      });
      await reply(ctx, codeBlock(output), config);
    } catch (error) {
      await reply(ctx, `Commit failed:\n${codeBlock(errorMessage(error))}`, config);
    }
  });

  bot.command("push", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }
    if (!(await ensureNoActiveRun(ctx, config, storage, binding))) {
      return;
    }
    if (!(await ensureGitRepository(ctx, config, binding))) {
      return;
    }

    try {
      const output = await pushHead(binding.repoPath);
      storage.audit({
        telegramUserId: ctx.from?.id ?? null,
        chatId: binding.chatId,
        messageThreadId: binding.messageThreadId,
        eventType: "push",
        details: {},
      });
      await reply(ctx, codeBlock(output), config);
    } catch (error) {
      await reply(ctx, `Push failed:\n${codeBlock(errorMessage(error))}`, config);
    }
  });

  bot.command("unbind", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }
    storage.deleteBinding(binding.id);
    await reply(ctx, "Unbound this topic.", config);
  });

  bot.command("ask", async (ctx) => {
    const text = ctx.match.trim();
    if (!text) {
      await reply(ctx, "Usage: /ask what you want Codex to do", config);
      return;
    }
    await handlePrompt(ctx, config, storage, codex, bot, queue, text);
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith("/")) {
      return;
    }
    await handlePrompt(ctx, config, storage, codex, bot, queue, text);
  });

  bot.catch((error) => {
    logger.error("telegram bot error", { error: String(error.error) });
  });

  return bot;
}

async function handlePrompt(
  ctx: Context,
  config: AppConfig,
  storage: Storage,
  codex: CodexBackend,
  bot: Bot,
  queue: RunQueue,
  text: string,
): Promise<void> {
  const binding = await requireBinding(ctx, config, storage);
  if (!binding) {
    return;
  }

  const active = storage.getActiveRun(binding.id);
  if (active && active.status === "running" && codex.steer) {
    try {
      const steered = await codex.steer(binding.id, text);
      if (steered) {
        storage.audit({
          telegramUserId: ctx.from?.id ?? null,
          chatId: binding.chatId,
          messageThreadId: binding.messageThreadId,
          eventType: "run_steered",
          details: { runId: active.id },
        });
        await reply(ctx, `Sent steering note to run #${active.id}.`, config);
        return;
      }
    } catch (error) {
      await reply(ctx, `Could not steer active run; queued as a follow-up.\n${codeBlock(errorMessage(error))}`, config);
    }
  }

  const key = topicKey(binding.chatId, binding.messageThreadId);
  const queuedBehind = queue.depth(key);
  const run = storage.createRun(binding.id, ctx.message?.message_id ?? null, text);

  if (queuedBehind > 0) {
    await reply(ctx, `Queued run #${run.id} behind ${queuedBehind} active/queued run(s).`, config);
  } else {
    await reply(
      ctx,
      [`Started run #${run.id}.`, `Repo:\n${codeBlock(binding.repoPath)}`, `Mode:\n${codeBlock(binding.sandboxMode)}`].join(
        "\n",
      ),
      config,
    );
  }

  queue.enqueue(key, async () => {
    const freshBinding = storage.getBindingById(binding.id);
    if (!freshBinding) {
      storage.failRun(run.id, "topic binding was removed before the run started");
      return;
    }
    await executeRun(bot, config, storage, codex, freshBinding, run, text);
  });
}

async function executeRun(
  bot: Bot,
  config: AppConfig,
  storage: Storage,
  codex: CodexBackend,
  binding: TopicBinding,
  run: RunRecord,
  prompt: string,
): Promise<void> {
  let lockAcquired = false;
  let finalMessage = "";
  let lastProgressAt = 0;

  try {
    if (binding.sandboxMode === "workspace-write") {
      lockAcquired = storage.acquireWriteLock(binding.repoPath, run.id);
      if (!lockAcquired) {
        const lock = storage.getRepoLock(binding.repoPath);
        const message = lock
          ? `Repo is busy. Write lock is held by run #${lock.runId} since ${lock.acquiredAt}.`
          : "Repo is busy.";
        storage.failRun(run.id, message);
        await sendText(bot, config, binding, message);
        return;
      }
    }

    storage.updateRunStarted(run.id);
    storage.updateBindingStatus(binding.id, "running");
    storage.audit({
      telegramUserId: null,
      chatId: binding.chatId,
      messageThreadId: binding.messageThreadId,
      eventType: "run_started",
      details: { runId: run.id, repoPath: binding.repoPath, sandboxMode: binding.sandboxMode },
    });

    for await (const event of codex.run({
      bindingId: binding.id,
      repoPath: binding.repoPath,
      prompt,
      codexThreadId: binding.codexThreadId,
      sandboxMode: binding.sandboxMode,
      approvalPolicy: binding.approvalPolicy,
    })) {
      if (event.type === "started" && event.threadId) {
        storage.updateBindingThread(binding.id, event.threadId);
        storage.updateRunCodexId(run.id, event.threadId);
        continue;
      }

      if (event.type === "agent_message") {
        finalMessage = event.text;
        continue;
      }

      if (event.type === "command_started") {
        await sendText(bot, config, binding, `Running:\n${codeBlock(truncateText(event.text, 900), "bash")}`);
        continue;
      }

      if (event.type === "file_changed") {
        await sendText(bot, config, binding, `Changed:\n${codeBlock(event.text)}`);
        continue;
      }

      if (event.type === "progress") {
        const nowMs = Date.now();
        if (nowMs - lastProgressAt > 20_000) {
          lastProgressAt = nowMs;
          await sendChatAction(bot, binding);
        }
        continue;
      }

      if (event.type === "failed") {
        storage.failRun(run.id, event.error, event.exitCode ?? null);
        await sendText(bot, config, binding, `Run #${run.id} failed:\n${codeBlock(truncateText(event.error, 2500))}`);
        return;
      }

      if (event.type === "completed") {
        finalMessage = event.finalMessage || finalMessage;
      }
    }

    storage.completeRun(run.id, finalMessage || "Codex completed without a final message.");
    await sendText(
      bot,
      config,
      binding,
      `Completed run #${run.id}.\n\n${codeBlock(finalMessage || "Codex completed without a final message.")}`,
    );
  } catch (error) {
    const message = errorMessage(error);
    storage.failRun(run.id, message);
    await sendText(bot, config, binding, `Run #${run.id} failed:\n${codeBlock(truncateText(message, 2500))}`);
  } finally {
    if (lockAcquired) {
      storage.releaseLock(binding.repoPath, run.id);
    }
    storage.updateBindingStatus(binding.id, "idle");
  }
}

function getTopicRef(ctx: Context, config: AppConfig): TopicRef | null {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return null;
  }

  const messageThreadId = ctx.message?.message_thread_id;
  if (typeof messageThreadId === "number") {
    return { chatId, messageThreadId };
  }

  if (config.allowUnthreadedChats) {
    return { chatId, messageThreadId: 0 };
  }

  return null;
}

async function requireBinding(
  ctx: Context,
  config: AppConfig,
  storage: Storage,
): Promise<TopicBinding | null> {
  const topic = getTopicRef(ctx, config);
  if (!topic) {
    await reply(ctx, "Use this inside a Telegram forum topic, or enable ALLOW_UNTHREADED_CHATS.", config);
    return null;
  }

  const binding = storage.getBinding(topic.chatId, topic.messageThreadId);
  if (!binding) {
    await reply(ctx, "This topic is not bound. Use /bind /absolute/path/to/repo first.", config);
    return null;
  }

  return binding;
}

async function ensureNoActiveRun(
  ctx: Context,
  config: AppConfig,
  storage: Storage,
  binding: TopicBinding,
): Promise<boolean> {
  const active = storage.getActiveRun(binding.id);
  if (!active) {
    return true;
  }

  await reply(
    ctx,
    `Run #${active.id} is ${active.status}. Use /status or /stop before git write operations.`,
    config,
  );
  return false;
}

async function ensureGitRepository(
  ctx: Context,
  config: AppConfig,
  binding: TopicBinding,
): Promise<boolean> {
  if (await isGitRepository(binding.repoPath)) {
    return true;
  }

  await reply(
    ctx,
    [
      `This path is not a git repository:`,
      codeBlock(binding.repoPath),
      "",
      "Codex can still work here. Ask it to initialize git if that is what you want:",
      "",
      codeBlock("/ask initialize this directory as a git repository"),
    ].join("\n"),
    config,
  );
  return false;
}

function bootstrapSetupText(ctx: Context, config: AppConfig): string {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const messageThreadId = ctx.message?.message_thread_id;
  const missing = [
    config.allowedTelegramUserIds.size === 0 ? "ALLOWED_TELEGRAM_USER_IDS" : null,
    config.allowedTelegramChatIds.size === 0 ? "ALLOWED_TELEGRAM_CHAT_IDS" : null,
  ].filter(Boolean);

  return [
    "Bot setup is incomplete.",
    "",
    `Missing: ${missing.join(", ")}`,
    "",
    "Add these values to .env, then restart the bot:",
    "",
    codeBlock(
      [
        `ALLOWED_TELEGRAM_USER_IDS=${userId ?? ""}`,
        `ALLOWED_TELEGRAM_CHAT_IDS=${chatId ?? ""}`,
        typeof messageThreadId === "number" ? `# Current topic message_thread_id=${messageThreadId}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    "",
    "For forum groups, the chat ID authorizes the whole group. Topic IDs are discovered per message and do not go in ALLOWED_TELEGRAM_CHAT_IDS.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

async function reply(ctx: Context, text: string, config: AppConfig): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }
  const messageThreadId = ctx.message?.message_thread_id;
  for (const chunk of markdownV2Chunks(text, config.maxTelegramMessageChars)) {
    const options =
      typeof messageThreadId === "number"
        ? {
            message_thread_id: messageThreadId,
            link_preview_options: { is_disabled: true },
            parse_mode: "MarkdownV2" as const,
          }
        : {
            link_preview_options: { is_disabled: true },
            parse_mode: "MarkdownV2" as const,
          };
    await ctx.api.sendMessage(chatId, chunk, options);
  }
}

async function sendText(
  bot: Bot,
  config: AppConfig,
  binding: TopicBinding,
  text: string,
): Promise<void> {
  for (const chunk of markdownV2Chunks(text, config.maxTelegramMessageChars)) {
    await bot.api.sendMessage(binding.chatId, chunk, {
      message_thread_id: binding.messageThreadId,
      link_preview_options: { is_disabled: true },
      parse_mode: "MarkdownV2",
    });
  }
}

async function sendChatAction(bot: Bot, binding: TopicBinding): Promise<void> {
  try {
    await bot.api.sendChatAction(binding.chatId, "typing", {
      message_thread_id: binding.messageThreadId,
    });
  } catch (error) {
    logger.warn("failed to send chat action", { error: errorMessage(error) });
  }
}

function parseMode(input: string): SandboxMode | null {
  if (input === "read" || input === "read-only") {
    return "read-only";
  }
  if (input === "write" || input === "workspace-write") {
    return "workspace-write";
  }
  return null;
}

function topicKey(chatId: number, messageThreadId: number): string {
  return `${chatId}:${messageThreadId}`;
}

function helpText(): string {
  return [
    "Codex over Telegram commands:",
    "",
    "/bind <absolute_repo_path> - bind this topic to a git repo",
    "/where - show repo, branch, mode, and git status",
    "/mode read - use read-only Codex sandbox",
    "/mode write - allow Codex workspace edits",
    "/topic - rename this Telegram topic to the bound repo path",
    "/new - start a fresh Codex session",
    "/status - show active queued/running task",
    "/stop - stop the active Codex process",
    "/diff - show diff summary and attach full diff when large",
    "/commit <message> - commit repo changes",
    "/push - push current HEAD to origin",
    "/unbind - remove this topic binding",
    "/ask <prompt> - send a Codex prompt as a command",
    "",
    "Any ordinary message in a bound topic is sent to Codex if Telegram privacy mode allows it. Use /ask when privacy mode is enabled.",
  ].join("\n");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const maybe = error as Error & { stderr?: string; stdout?: string };
    return [error.message, maybe.stderr, maybe.stdout].filter(Boolean).join("\n");
  }
  return String(error);
}

function topicNameForPath(repoPath: string): string {
  if (repoPath.length <= 128) {
    return repoPath;
  }

  const parts = repoPath.split("/").filter(Boolean);
  let suffix = parts.pop() ?? repoPath.slice(-120);

  while (parts.length > 0 && suffix.length < 120) {
    const next = parts.pop();
    if (!next) {
      break;
    }
    const candidate = `${next}/${suffix}`;
    if (candidate.length > 120) {
      break;
    }
    suffix = candidate;
  }

  return `.../${suffix}`.slice(0, 128);
}

async function renameForumTopicForBinding(
  ctx: Context,
  binding: TopicBinding,
  topicName: string,
): Promise<string | null> {
  if (binding.messageThreadId <= 0) {
    return null;
  }

  try {
    await ctx.api.editForumTopic(binding.chatId, binding.messageThreadId, { name: topicName });
    return `Topic renamed to: ${topicName}`;
  } catch (error) {
    logger.warn("failed to rename telegram topic", {
      chatId: binding.chatId,
      messageThreadId: binding.messageThreadId,
      topicName,
      error: errorMessage(error),
    });
    return `Topic rename failed: ${errorMessage(error)}`;
  }
}
