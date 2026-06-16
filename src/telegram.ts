import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import type { AppConfig } from "./config.js";
import type {
  CodexBackend,
  CodexRunEvent,
  InterruptedRunRecord,
  RunRecord,
  SandboxMode,
  ThreadTokenUsageSnapshot,
  TopicBinding,
} from "./types.js";
import { Storage } from "./storage.js";
import { RunQueue } from "./runQueue.js";
import { resolveAllowedRepoPath } from "./pathPolicy.js";
import { codeBlock, markdownV2Chunks, truncateText } from "./text.js";
import { commitAll, currentBranch, diffSummary, fullDiff, isGitRepository, pushHead, statusShort } from "./git.js";
import {
  listCodexModels,
  readCodexConfig,
  readCodexUsage,
  type CodexConfigSnapshot,
  type CodexModelInfo,
} from "./codexMetadata.js";
import { logger } from "./logger.js";
import { TelegramSendQueue } from "./telegramSendQueue.js";
import {
  saveTelegramFileToContext,
  saveTranscriptForAudio,
  transcribeStoredAudio,
  type StoredContextFile,
  type TelegramFileRef,
} from "./telegramMedia.js";

export interface TopicRef {
  chatId: number;
  messageThreadId: number;
}

interface SendOptions {
  notify?: boolean;
  replyToMessageId?: number | null;
}

interface TelegramFileLike {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
}

interface TelegramPhotoLike extends TelegramFileLike {
  width?: number;
  height?: number;
}

interface TelegramMessageWithFiles {
  message_id?: number;
  caption?: string;
  photo?: TelegramPhotoLike[];
  document?: TelegramFileLike;
  audio?: TelegramFileLike;
  video?: TelegramFileLike;
  animation?: TelegramFileLike;
  video_note?: TelegramFileLike;
  voice?: TelegramFileLike;
  sticker?: TelegramFileLike;
}

interface HandlePromptOptions {
  forceQueue?: boolean;
  contextFiles?: ContextFilePrompt[];
  includePendingContext?: boolean;
}

interface CreateTelegramBotOptions {
  recoverRuns?: InterruptedRunRecord[];
  queue?: RunQueue;
}

interface ContextFilePrompt {
  kind: string;
  relativePath: string;
  originalName: string | null;
  mimeType: string | null;
  fileSize: number;
}

const sendQueues = new WeakMap<AppConfig, TelegramSendQueue>();

export function createTelegramBot(
  config: AppConfig,
  storage: Storage,
  codex: CodexBackend,
  options: CreateTelegramBotOptions = {},
): Bot {
  const bot = new Bot(config.telegramBotToken);
  const queue = options.queue ?? new RunQueue(config.maxParallelRuns);
  const sendQueue = sendQueueFor(config);

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
      await reply(ctx, bootstrapSetupText(ctx, config), config, sendQueue);
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
        sendQueue,
      );
      return;
    }

    await next();
  });

  bot.command("help", async (ctx) => {
    await reply(ctx, helpText(), config, sendQueue);
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
        sandboxMode: effectiveSandboxMode(config, config.defaultSandboxMode),
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
          `Model:\n${codeBlock(await modelLabel(config, binding))}`,
          `Plan mode:\n${codeBlock(formatPlanMode(binding.planMode))}`,
          `Mode:\n${codeBlock(effectiveRunSandboxMode(config, binding))}`,
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

  bot.command("create", async (ctx) => {
    const topic = getTopicRef(ctx, config);
    if (!topic) {
      await reply(ctx, "Use /create from topic 0. Enable ALLOW_UNTHREADED_CHATS for the general topic.", config);
      return;
    }
    if (topic.messageThreadId !== 0) {
      await reply(ctx, "Use /create only from topic 0 so new workspaces are created from one place.", config);
      return;
    }

    const requestedFolder = ctx.match.trim();
    if (!requestedFolder) {
      await reply(ctx, "Usage: /create folder-name", config);
      return;
    }

    try {
      const repoPath = resolveNewWorkspacePath(requestedFolder, config.allowedRepoRoots);
      const topicName = topicNameForPath(repoPath);
      const directoryState = await ensureWorkspaceDirectory(repoPath);

      const createdTopic = await ctx.api.createForumTopic(topic.chatId, topicName);
      const binding = storage.upsertBinding({
        chatId: topic.chatId,
        messageThreadId: createdTopic.message_thread_id,
        topicName,
        repoPath,
        createdByUserId: ctx.from?.id ?? 0,
        sandboxMode: effectiveSandboxMode(config, config.defaultSandboxMode),
      });

      storage.audit({
        telegramUserId: ctx.from?.id ?? null,
        chatId: topic.chatId,
        messageThreadId: createdTopic.message_thread_id,
        eventType: "create_workspace_topic",
        details: { repoPath, topicName },
      });

      await reply(
        ctx,
        [
          "Created folder and topic:",
          codeBlock(repoPath),
          "",
          directoryState === "existed" ? "Folder already existed; topic and binding were created." : null,
          `Topic: ${topicName}`,
          `message_thread_id: ${createdTopic.message_thread_id}`,
        ]
          .filter(Boolean)
          .join("\n"),
        config,
      );
      await sendText(
        bot,
        config,
        binding,
        [
          "This topic is ready.",
          "",
          directoryState === "existed" ? "Bound existing folder:" : "Bound new folder:",
          codeBlock(repoPath),
          "",
          "Send a normal message here to start working in this folder.",
        ].join("\n"),
        { notify: true },
      );
    } catch (error) {
      await reply(ctx, `Could not create workspace topic:\n${codeBlock(errorMessage(error))}`, config);
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
        `Model:\n${codeBlock(await modelLabel(config, binding))}`,
        `Plan mode:\n${codeBlock(formatPlanMode(binding.planMode))}`,
        `Mode:\n${codeBlock(effectiveRunSandboxMode(config, binding))}`,
        `Codex session:\n${codeBlock(binding.codexThreadId ?? "(new)")}`,
        `Status:\n${codeBlock(binding.status)}`,
        "",
        `Git status:\n${codeBlock(status)}`,
      ].join("\n"),
      config,
    );
  });

  bot.command("models", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }

    try {
      const models = await listCodexModels(config.codexBin);
      if (models.length === 0) {
        await reply(ctx, "No Codex models were returned by app-server.", config);
        return;
      }
      await replyWithModelKeyboard(
        ctx,
        config,
        [
          "Available models:",
          "",
          `Current: ${await modelLabel(config, binding)}`,
          "Tap a button to set this topic's model.",
        ].join("\n"),
        modelKeyboard(models, binding.model),
      );
    } catch (error) {
      await reply(ctx, `Could not list models:\n${codeBlock(errorMessage(error))}`, config);
    }
  });

  bot.command("model", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }

    const requestedModel = ctx.match.trim();
    if (!requestedModel) {
      await sendModelSwitcher(ctx, config, binding);
      return;
    }

    if (requestedModel === "default" || requestedModel === "clear" || requestedModel === "reset") {
      storage.updateBindingModel(binding.id, null);
      storage.audit({
        telegramUserId: ctx.from?.id ?? null,
        chatId: binding.chatId,
        messageThreadId: binding.messageThreadId,
        eventType: "model",
        details: { model: null },
      });
      await reply(ctx, `Topic model reset to Codex config default:\n${codeBlock(await globalModelLabel(config, binding.repoPath))}`, config);
      return;
    }

    try {
      const models = await listCodexModels(config.codexBin);
      const match = models.find((model) => model.model === requestedModel || model.id === requestedModel);
      if (!match) {
        await reply(
          ctx,
          [`Unknown model:`, codeBlock(requestedModel), "", "Use /models to list available models."].join("\n"),
          config,
        );
        return;
      }

      storage.updateBindingModel(binding.id, match.model);
      storage.audit({
        telegramUserId: ctx.from?.id ?? null,
        chatId: binding.chatId,
        messageThreadId: binding.messageThreadId,
        eventType: "model",
        details: { model: match.model },
      });
      await reply(
        ctx,
        [`Topic model set to:`, codeBlock(match.model), "", "The next run will use the new model in this thread."].join("\n"),
        config,
      );
    } catch (error) {
      await reply(ctx, `Could not set model:\n${codeBlock(errorMessage(error))}`, config);
    }
  });

  bot.callbackQuery(/^model:(default|set:.+)$/, async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      await ctx.answerCallbackQuery({ text: "This topic is not bound.", show_alert: true });
      return;
    }

    const data = ctx.callbackQuery.data;
    if (data === "model:default") {
      storage.updateBindingModel(binding.id, null);
      storage.audit({
        telegramUserId: ctx.from?.id ?? null,
        chatId: binding.chatId,
        messageThreadId: binding.messageThreadId,
        eventType: "model",
        details: { model: null },
      });
      await ctx.answerCallbackQuery({ text: "Model reset to default." });
      await reply(ctx, `Topic model reset to Codex config default:\n${codeBlock(await globalModelLabel(config, binding.repoPath))}`, config);
      return;
    }

    const requestedModel = data.slice("model:set:".length);
    try {
      const models = await listCodexModels(config.codexBin);
      const match = models.find((model) => model.model === requestedModel || model.id === requestedModel);
      if (!match) {
        await ctx.answerCallbackQuery({ text: "Unknown model.", show_alert: true });
        await sendModelSwitcher(ctx, config, binding);
        return;
      }

      storage.updateBindingModel(binding.id, match.model);
      storage.audit({
        telegramUserId: ctx.from?.id ?? null,
        chatId: binding.chatId,
        messageThreadId: binding.messageThreadId,
        eventType: "model",
        details: { model: match.model },
      });
      await ctx.answerCallbackQuery({ text: `Model set to ${match.model}.` });
      await reply(
        ctx,
        [`Topic model set to:`, codeBlock(match.model), "", "The next run will use the new model in this thread."].join("\n"),
        config,
      );
    } catch (error) {
      await ctx.answerCallbackQuery({ text: "Could not set model.", show_alert: true });
      await reply(ctx, `Could not set model:\n${codeBlock(errorMessage(error))}`, config);
    }
  });

  bot.command("plan", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }

    const requestedState = parsePlanMode(ctx.match.trim());
    if (requestedState === null) {
      await reply(
        ctx,
        [
          `Plan mode is ${formatPlanMode(binding.planMode)}.`,
          "",
          "Usage:",
          codeBlock(["/plan on", "/plan off"].join("\n")),
        ].join("\n"),
        config,
      );
      return;
    }

    storage.updateBindingPlanMode(binding.id, requestedState);
    storage.audit({
      telegramUserId: ctx.from?.id ?? null,
      chatId: binding.chatId,
      messageThreadId: binding.messageThreadId,
      eventType: "plan_mode",
      details: { planMode: requestedState },
    });
    await reply(
      ctx,
      [
        `Plan mode ${requestedState ? "enabled" : "disabled"}.`,
        "The existing Codex session will continue on the next run.",
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
    await reply(
      ctx,
      config.alwaysYoloMode
        ? `Mode saved as ${mode}, but CODEX_ALWAYS_YOLO is enabled. Runs will use danger-full-access.`
        : `Mode set to ${mode}.`,
      config,
    );
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
    await reply(ctx, "Started a fresh Codex thread for this topic. The next prompt will use clean context.", config);
  });

  bot.command("compact", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }
    if (!(await ensureNoActiveRun(ctx, config, storage, binding))) {
      return;
    }
    if (!binding.codexThreadId) {
      await reply(ctx, "No Codex thread exists for this topic yet. Send a prompt first, or use /new for clean context.", config);
      return;
    }
    if (!codex.compactThread) {
      await reply(ctx, "This Codex backend does not support thread compaction.", config);
      return;
    }

    await reply(ctx, `Compacting Codex thread:\n${codeBlock(binding.codexThreadId)}`, config);
    try {
      await codex.compactThread(binding.codexThreadId);
      storage.audit({
        telegramUserId: ctx.from?.id ?? null,
        chatId: binding.chatId,
        messageThreadId: binding.messageThreadId,
        eventType: "thread_compacted",
        details: { bindingId: binding.id, threadId: binding.codexThreadId },
      });
      await reply(ctx, "Compacted this topic's Codex thread.", config);
    } catch (error) {
      await reply(ctx, `Compact failed:\n${codeBlock(errorMessage(error))}`, config);
    }
  });

  bot.command("dashboard", async (ctx) => {
    const topic = await requireTopicZero(ctx, config);
    if (!topic) {
      return;
    }
    storage.audit({
      telegramUserId: ctx.from?.id ?? null,
      chatId: topic.chatId,
      messageThreadId: topic.messageThreadId,
      eventType: "manager_dashboard",
      details: {},
    });
    await reply(ctx, managerDashboardText(storage, topic.chatId), config);
  });

  bot.command("topics", async (ctx) => {
    const topic = await requireTopicZero(ctx, config);
    if (!topic) {
      return;
    }
    await reply(ctx, managerTopicsText(storage, topic.chatId), config);
  });

  bot.command("todo", async (ctx) => {
    const topic = await requireTopicZero(ctx, config);
    if (!topic) {
      return;
    }
    await reply(ctx, managerTodoText(storage, topic.chatId), config);
  });

  bot.command("queue_topic", async (ctx) => {
    await handleManagerQueueTopicCommand(ctx, config, storage, codex, bot, queue, ctx.match.trim());
  });

  bot.command("assign", async (ctx) => {
    await handleManagerQueueTopicCommand(ctx, config, storage, codex, bot, queue, ctx.match.trim());
  });

  bot.command("status", async (ctx) => {
    const binding = await requireBinding(ctx, config, storage);
    if (!binding) {
      return;
    }
    const active = storage.getActiveRun(binding.id);
    const usage = await readStatusText(config);
    if (!active) {
      await reply(
        ctx,
        [
          `Idle.`,
          `Repo:\n${codeBlock(binding.repoPath)}`,
          `Model:\n${codeBlock(await modelLabel(config, binding))}`,
          `Plan mode:\n${codeBlock(formatPlanMode(binding.planMode))}`,
          `Mode:\n${codeBlock(effectiveRunSandboxMode(config, binding))}`,
          `Context:\n${codeBlock(formatThreadTokenUsage(binding.tokenUsage))}`,
          usage,
        ].join("\n"),
        config,
      );
      return;
    }
    await reply(
      ctx,
      [
        `Run #${active.id} is ${active.status}.`,
        `Model:\n${codeBlock(await modelLabel(config, binding))}`,
        `Plan mode:\n${codeBlock(formatPlanMode(binding.planMode))}`,
        `Context:\n${codeBlock(formatThreadTokenUsage(binding.tokenUsage))}`,
        `Prompt:\n${codeBlock(truncateText(active.prompt, 700))}`,
        usage,
      ].join("\n"),
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
        { message_thread_id: binding.messageThreadId, disable_notification: true },
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
    if (isTopicZero(ctx, config)) {
      await handleManagerPrompt(ctx, config, storage, codex, bot, queue, text);
      return;
    }
    await handlePrompt(ctx, config, storage, codex, bot, queue, text);
  });

  bot.command("queue", async (ctx) => {
    const text = ctx.match.trim();
    if (!text) {
      await reply(ctx, "Usage: /queue what Codex should do after the current run", config);
      return;
    }
    if (isTopicZero(ctx, config)) {
      await handleManagerPrompt(ctx, config, storage, codex, bot, queue, text, { forceQueue: true });
      return;
    }
    await handlePrompt(ctx, config, storage, codex, bot, queue, text, { forceQueue: true });
  });

  bot.on("message:file", async (ctx) => {
    await handleFileMessage(ctx, config, storage, codex, bot, queue);
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text) {
      return;
    }
    if (isTopicZero(ctx, config)) {
      const queueTopicAlias = parseQueueTopicAlias(text);
      if (queueTopicAlias !== null) {
        await handleManagerQueueTopicCommand(ctx, config, storage, codex, bot, queue, queueTopicAlias);
        return;
      }
    }
    if (isTopicZero(ctx, config)) {
      const queueTopicCommand = parseEmbeddedManagerQueueCommand(text);
      if (queueTopicCommand !== null) {
        await handleManagerQueueTopicCommand(ctx, config, storage, codex, bot, queue, queueTopicCommand);
        return;
      }
    }
    if (text.startsWith("/")) {
      return;
    }
    if (isTopicZero(ctx, config)) {
      await handleManagerPrompt(ctx, config, storage, codex, bot, queue, text);
      return;
    }
    await handlePrompt(ctx, config, storage, codex, bot, queue, text);
  });

  bot.catch((error) => {
    logger.error("telegram bot error", { error: String(error.error) });
  });

  if (options.recoverRuns?.length) {
    queueMicrotask(() => {
      void resumeInterruptedRuns(bot, config, storage, codex, queue, options.recoverRuns ?? []);
    });
  }

  return bot;
}

function sendQueueFor(config: AppConfig): TelegramSendQueue {
  const existing = sendQueues.get(config);
  if (existing) {
    return existing;
  }

  const queue = new TelegramSendQueue(config.telegramSendIntervalMs);
  sendQueues.set(config, queue);
  return queue;
}

async function handleFileMessage(
  ctx: Context,
  config: AppConfig,
  storage: Storage,
  codex: CodexBackend,
  bot: Bot,
  queue: RunQueue,
): Promise<void> {
  const binding = await requireBinding(ctx, config, storage);
  if (!binding) {
    return;
  }

  const instruction = captionInstruction(ctx);
  if (instruction.unsupportedCommand) {
    await reply(ctx, "Send bot commands as text messages. Use a plain caption as the instruction for uploaded files.", config);
    return;
  }

  const fileRefs = extractTelegramFileRefs(ctx);
  if (fileRefs.length === 0) {
    return;
  }

  if (fileRefs.length === 1 && fileRefs[0]?.kind === "voice") {
    await handleVoiceMessage(ctx, config, storage, codex, bot, queue, binding, fileRefs[0]);
    return;
  }

  try {
    const storedFiles: StoredContextFile[] = [];
    for (const fileRef of fileRefs) {
      const storedFile = await saveTelegramFileToContext(
        bot,
        config,
        binding.repoPath,
        fileRef,
        ctx.message?.message_id ?? null,
      );
      storedFiles.push(storedFile);
      storage.audit({
        telegramUserId: ctx.from?.id ?? null,
        chatId: binding.chatId,
        messageThreadId: binding.messageThreadId,
        eventType: "telegram_file_saved",
        details: {
          kind: storedFile.kind,
          path: storedFile.relativePath,
          size: storedFile.fileSize,
          mimeType: storedFile.mimeType,
        },
      });
    }

    if (!instruction.text) {
      storage.addPendingContextFiles(binding.id, ctx.message?.message_id ?? null, storedFiles);
      storage.audit({
        telegramUserId: ctx.from?.id ?? null,
        chatId: binding.chatId,
        messageThreadId: binding.messageThreadId,
        eventType: "telegram_file_staged",
        details: {
          count: storedFiles.length,
          paths: storedFiles.map((file) => file.relativePath),
        },
      });
      await reply(ctx, stagedFilesSavedText(storedFiles), config);
      return;
    }

    await reply(ctx, uploadedFilesSavedText(storedFiles), config);
    await handlePrompt(
      ctx,
      config,
      storage,
      codex,
      bot,
      queue,
      instruction.text,
      { contextFiles: storedFiles },
    );
  } catch (error) {
    await reply(ctx, `Could not save Telegram upload:\n${codeBlock(errorMessage(error))}`, config);
  }
}

async function handleVoiceMessage(
  ctx: Context,
  config: AppConfig,
  storage: Storage,
  codex: CodexBackend,
  bot: Bot,
  queue: RunQueue,
  binding: TopicBinding,
  fileRef: TelegramFileRef,
): Promise<void> {
  try {
    await reply(ctx, "Voice message received. Saving and transcribing it now.", config);
    const storedAudio = await saveTelegramFileToContext(
      bot,
      config,
      binding.repoPath,
      fileRef,
      ctx.message?.message_id ?? null,
    );
    const transcript = await transcribeStoredAudio(config, storedAudio);
    if (!transcript) {
      await reply(ctx, `Saved voice message to ${codeBlock(storedAudio.relativePath)} but transcription was empty.`, config);
      return;
    }

    const storedTranscript = await saveTranscriptForAudio(binding.repoPath, storedAudio, transcript);
    storage.audit({
      telegramUserId: ctx.from?.id ?? null,
      chatId: binding.chatId,
      messageThreadId: binding.messageThreadId,
      eventType: "telegram_voice_transcribed",
      details: {
        audioPath: storedAudio.relativePath,
        transcriptPath: storedTranscript.relativePath,
        audioSize: storedAudio.fileSize,
        transcriptSize: storedTranscript.fileSize,
      },
    });

    await reply(
      ctx,
      [
        "Voice message transcribed.",
        "",
        "Transcript:",
        codeBlock(transcript.trim()),
      ].join("\n"),
      config,
    );
    await handlePrompt(
      ctx,
      config,
      storage,
      codex,
      bot,
      queue,
      voiceTranscriptPrompt(transcript),
    );
  } catch (error) {
    await reply(ctx, `Could not transcribe Telegram voice message:\n${codeBlock(errorMessage(error))}`, config);
  }
}

async function handleManagerPrompt(
  ctx: Context,
  config: AppConfig,
  storage: Storage,
  codex: CodexBackend,
  bot: Bot,
  queue: RunQueue,
  text: string,
  options: HandlePromptOptions = {},
): Promise<void> {
  const topic = await requireTopicZero(ctx, config);
  if (!topic) {
    return;
  }

  ensureManagerBinding(ctx, config, storage, topic);
  await handlePrompt(
    ctx,
    config,
    storage,
    codex,
    bot,
    queue,
    managerPromptText(storage, topic.chatId, text),
    options,
  );
}

async function handleManagerQueueTopicCommand(
  ctx: Context,
  config: AppConfig,
  storage: Storage,
  codex: CodexBackend,
  bot: Bot,
  queue: RunQueue,
  input: string,
): Promise<void> {
  const topic = await requireTopicZero(ctx, config);
  if (!topic) {
    return;
  }

  const result = await queueManagerTopicRun({
    storage,
    bot,
    config,
    codex,
    queue,
    managerTopic: topic,
    telegramUserId: ctx.from?.id ?? null,
    input,
    replyToMessageId: null,
  });
  await reply(ctx, result.message, config);
}

export interface QueueManagerTopicRunInput {
  storage: Storage;
  bot: Bot;
  config: AppConfig;
  codex: CodexBackend;
  queue: RunQueue;
  managerTopic: TopicRef;
  telegramUserId: number | null;
  input: string;
  replyToMessageId: number | null;
}

export interface QueueManagerTopicRunResult {
  ok: boolean;
  message: string;
  runId?: number;
  topicId?: number;
  topicName?: string;
  repoPath?: string;
  queuedBehind?: number;
}

export async function queueManagerTopicRun(input: QueueManagerTopicRunInput): Promise<QueueManagerTopicRunResult> {
  const { storage, bot, config, codex, queue, managerTopic, telegramUserId } = input;
  const request = parseManagerQueueTopicRequest(input.input);
  if (!request) {
    return { ok: false, message: "Usage: /queue_topic <topic-id-or-name> <prompt>" };
  }

  const binding = findManagerTargetBinding(storage, managerTopic.chatId, request.selector);
  if (!binding) {
    return {
      ok: false,
      message: [
        `Could not find managed topic: ${request.selector}`,
        "",
        "Known topics:",
        codeBlock(managerTopicSelectorList(storage, managerTopic.chatId)),
      ].join("\n"),
    };
  }

  const key = topicKey(binding.chatId, binding.messageThreadId);
  const queuedBehind = queue.depth(key);
  const run = storage.createRun(binding.id, null, request.prompt);
  storage.addManagerEvent({
    chatId: binding.chatId,
    sourceMessageThreadId: binding.messageThreadId,
    bindingId: binding.id,
    runId: run.id,
    eventType: "run_queued",
    summary: managerEventSummary(
      binding,
      run,
      "queued",
      `Queued from topic zero${queuedBehind > 0 ? ` behind ${queuedBehind} active/queued run(s)` : ""}.`,
    ),
    details: {
      topicName: topicDisplayName(binding),
      repoPath: binding.repoPath,
      prompt: run.prompt,
      queuedBehind,
    },
  });
  storage.audit({
    telegramUserId,
    chatId: managerTopic.chatId,
    messageThreadId: managerTopic.messageThreadId,
    eventType: "manager_queue_topic",
    details: {
      targetMessageThreadId: binding.messageThreadId,
      targetTopicName: topicDisplayName(binding),
      runId: run.id,
      queuedBehind,
    },
  });

  await sendText(
    bot,
    config,
    binding,
    [
      `Manager queued run #${run.id}.`,
      "",
      "Prompt:",
      codeBlock(request.prompt),
    ].join("\n"),
    { notify: true, replyToMessageId: input.replyToMessageId },
  );

  queue.enqueue(key, async () => {
    const freshBinding = storage.getBindingById(binding.id);
    if (!freshBinding) {
      storage.failRun(run.id, "topic binding was removed before the manager-queued run started");
      return;
    }
    await executeRun(bot, config, storage, codex, freshBinding, run, request.prompt);
  });

  return {
    ok: true,
    message: [
      `Queued run #${run.id} in ${topicDisplayName(binding)}.`,
      `Topic: ${binding.messageThreadId}`,
      queuedBehind > 0 ? `Behind ${queuedBehind} active/queued run(s).` : "It will start when a worker slot is available.",
    ].join("\n"),
    runId: run.id,
    topicId: binding.messageThreadId,
    topicName: topicDisplayName(binding),
    repoPath: binding.repoPath,
    queuedBehind,
  };
}

interface ManagerQueueTopicRequest {
  selector: string;
  prompt: string;
}

function parseQueueTopicAlias(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const idAlias = trimmed.match(/^#\s*([0-9]+)\s*[:\-]?\s*([\s\S]+)$/);
  if (idAlias) {
    const selector = idAlias[1] ?? "";
    const prompt = (idAlias[2] ?? "").trim();
    return prompt ? `${selector} ${prompt}` : null;
  }

  const quotedAlias = trimmed.match(/^(?:topic|to)\s+"([^"]+)"\s*[:\-]?\s*([\s\S]+)$/i);
  if (quotedAlias) {
    const selector = (quotedAlias[1] ?? "").trim();
    const prompt = (quotedAlias[2] ?? "").trim();
    return prompt ? `"${selector}" ${prompt}` : null;
  }

  const simpleAlias = trimmed.match(/^(?:topic|to)\s+([A-Za-z0-9._-]+)\s*[:\-]?\s*([\s\S]+)$/i);
  if (simpleAlias) {
    const selector = (simpleAlias[1] ?? "").trim();
    const prompt = (simpleAlias[2] ?? "").trim();
    return prompt ? `${selector} ${prompt}` : null;
  }

  return null;
}

function parseManagerQueueTopicRequest(input: string): ManagerQueueTopicRequest | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const quoted = trimmed.match(/^"([^"]+)"\s+([\s\S]+)\s*$/);
  if (quoted) {
    const selector = (quoted[1] ?? "").trim();
    const prompt = (quoted[2] ?? "").trim();
    return prompt ? { selector, prompt } : null;
  }

  const split = trimmed.match(/^(\S+)\s+([\s\S]+)\s*$/);
  if (!split) {
    return null;
  }

  const selector = (split[1] ?? "").trim();
  const prompt = (split[2] ?? "").trim();
  if (!selector || !prompt) {
    return null;
  }

  return { selector, prompt };
}

function parseEmbeddedManagerQueueCommand(text: string): string | null {
  const match = text.match(/(?:^|\s)\/(assign|queue_topic)\s+([\s\S]+)$/i);
  if (!match) {
    return null;
  }

  const extracted = (match[2] ?? "").trim();
  return extracted.length > 0 ? extracted : null;
}

function findManagerTargetBinding(storage: Storage, chatId: number, selector: string): TopicBinding | null {
  const bindings = storage.listBindingsForChat(chatId).filter((binding) => binding.messageThreadId !== 0);
  if (bindings.length === 0) {
    return null;
  }

  const normalizedSelector = selector.trim().toLowerCase();
  const numericMatch = normalizedSelector.match(/^\s*#?(\d+)\s*$/);
  if (numericMatch) {
    const targetThreadId = Number.parseInt(numericMatch[1] ?? "", 10);
    return bindings.find((binding) => binding.messageThreadId === targetThreadId) ?? null;
  }

  const topicNameMatch = bindings.find((binding) =>
    topicDisplayName(binding).toLowerCase() === normalizedSelector,
  );
  if (topicNameMatch) {
    return topicNameMatch;
  }

  const repoNameMatch = bindings.find((binding) =>
    path.basename(binding.repoPath).toLowerCase() === normalizedSelector,
  );
  if (repoNameMatch) {
    return repoNameMatch;
  }

  const startsWithMatches = bindings.filter(
    (binding) =>
      topicDisplayName(binding).toLowerCase().startsWith(normalizedSelector) ||
      path.basename(binding.repoPath).toLowerCase().startsWith(normalizedSelector),
  );
  if (startsWithMatches.length === 1) {
    return startsWithMatches[0] ?? null;
  }

  return null;
}

function managerTopicSelectorList(storage: Storage, chatId: number): string {
  const bindings = storage.listBindingsForChat(chatId).filter((binding) => binding.messageThreadId !== 0);
  if (bindings.length === 0) {
    return "No worker topics are currently bound.";
  }

  return bindings
    .map(
      (binding) =>
        `#${binding.messageThreadId}: ${topicDisplayName(binding)} (${path.basename(binding.repoPath)})`,
    )
    .join("\n");
}

async function handlePrompt(
  ctx: Context,
  config: AppConfig,
  storage: Storage,
  codex: CodexBackend,
  bot: Bot,
  queue: RunQueue,
  text: string,
  options: HandlePromptOptions = {},
): Promise<void> {
  const binding = await requireBinding(ctx, config, storage);
  if (!binding) {
    return;
  }

  const promptContextFiles = [
    ...(options.includePendingContext === false ? [] : storage.consumePendingContextFiles(binding.id)),
    ...(options.contextFiles ?? []),
  ];
  const promptText = promptContextFiles.length > 0 ? uploadedFilesPrompt(promptContextFiles, text) : text;

  const active = storage.getActiveRun(binding.id);
  if (!options.forceQueue && active && active.status === "running" && codex.steer) {
    try {
      const steered = await codex.steer(binding.id, promptText);
      if (steered) {
        storage.audit({
          telegramUserId: ctx.from?.id ?? null,
          chatId: binding.chatId,
          messageThreadId: binding.messageThreadId,
          eventType: "run_steered",
          details: { runId: active.id, contextFileCount: promptContextFiles.length },
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
  const run = storage.createRun(binding.id, ctx.message?.message_id ?? null, promptText);

  if (queuedBehind > 0) {
    await reply(ctx, `Queued run #${run.id} behind ${queuedBehind} active/queued run(s).`, config);
    await sendManagerRunReport(storage, bot, config, binding, run, "queued", `Queued behind ${queuedBehind} active/queued run(s).`);
  } else {
    await reply(
      ctx,
      [
        `Started run #${run.id}.`,
        `Repo:\n${codeBlock(binding.repoPath)}`,
        `Model:\n${codeBlock(await modelLabel(config, binding))}`,
        `Plan mode:\n${codeBlock(formatPlanMode(binding.planMode))}`,
        `Mode:\n${codeBlock(effectiveRunSandboxMode(config, binding))}`,
      ].join("\n"),
      config,
    );
  }

  queue.enqueue(key, async () => {
    const freshBinding = storage.getBindingById(binding.id);
    if (!freshBinding) {
      storage.failRun(run.id, "topic binding was removed before the run started");
      return;
    }
    await executeRun(bot, config, storage, codex, freshBinding, run, promptText);
  });
}

async function resumeInterruptedRuns(
  bot: Bot,
  config: AppConfig,
  storage: Storage,
  codex: CodexBackend,
  queue: RunQueue,
  runs: InterruptedRunRecord[],
): Promise<void> {
  for (const run of runs) {
    const binding = storage.getBindingById(run.bindingId);
    if (!binding) {
      storage.failRun(run.id, "topic binding was removed before the service could resume the run");
      continue;
    }

    const key = topicKey(binding.chatId, binding.messageThreadId);
    queue.enqueue(key, async () => {
      const freshBinding = storage.getBindingById(run.bindingId);
      if (!freshBinding) {
        storage.failRun(run.id, "topic binding was removed before the service could resume the run");
        return;
      }

      storage.audit({
        telegramUserId: null,
        chatId: freshBinding.chatId,
        messageThreadId: freshBinding.messageThreadId,
        eventType: "run_resumed_after_restart",
        details: { runId: run.id, repoPath: freshBinding.repoPath },
      });

      await sendText(
        bot,
        config,
        freshBinding,
        resumeNoticeText(run),
        { notify: true },
      );
      await executeRun(bot, config, storage, codex, freshBinding, run, resumePromptForRun(run));
    });
  }
}

function resumeNoticeText(run: InterruptedRunRecord): string {
  if (run.interruptedStatus === "running") {
    return [
      `Service restarted while run #${run.id} was running.`,
      "Resuming the saved Codex thread with a continue prompt.",
    ].join("\n");
  }

  return [
    `Service restarted while run #${run.id} was queued.`,
    "Starting the saved prompt now.",
  ].join("\n");
}

function resumePromptForRun(run: InterruptedRunRecord): string {
  if (run.interruptedStatus === "queued") {
    return run.prompt;
  }

  return [
    "The Codex CLI over Telegram service restarted while the previous turn was running.",
    "Continue the interrupted work from the existing thread and current workspace state.",
    "Do not restart from scratch unless that is necessary to recover safely.",
    "",
    "Original saved prompt for reference:",
    run.prompt,
  ].join("\n");
}

function terminalRunSendOptions(run: RunRecord): SendOptions {
  return {
    notify: true,
    replyToMessageId: run.telegramMessageId,
  };
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
  let lastSentAgentMessage = "";
  let lastProgressAt = 0;

  try {
    const sandboxMode = effectiveRunSandboxMode(config, binding);

    if (isWriteSandbox(sandboxMode)) {
      lockAcquired = storage.acquireWriteLock(binding.repoPath, run.id);
      if (!lockAcquired) {
        const lock = storage.getRepoLock(binding.repoPath);
        const message = lock
          ? `Repo is busy. Write lock is held by run #${lock.runId} since ${lock.acquiredAt}.`
          : "Repo is busy.";
        storage.failRun(run.id, message);
        await sendText(bot, config, binding, message, terminalRunSendOptions(run));
        await sendManagerRunReport(storage, bot, config, binding, run, "failed", message);
        return;
      }
    }

    storage.updateRunStarted(run.id);
    storage.updateBindingStatus(binding.id, "running");
    await pinRunMessage(bot, binding, run);
    storage.audit({
      telegramUserId: null,
      chatId: binding.chatId,
      messageThreadId: binding.messageThreadId,
      eventType: "run_started",
      details: { runId: run.id, repoPath: binding.repoPath, sandboxMode },
    });
    await sendManagerRunReport(storage, bot, config, binding, run, "started", `Repo:\n${binding.repoPath}`);

    for await (const event of codex.run({
      bindingId: binding.id,
      chatId: binding.chatId,
      messageThreadId: binding.messageThreadId,
      repoPath: binding.repoPath,
      prompt,
      codexThreadId: binding.codexThreadId,
      sandboxMode,
      approvalPolicy: binding.approvalPolicy,
      model: binding.model,
      planMode: binding.planMode,
    })) {
      if (event.type === "started" && event.threadId) {
        storage.updateBindingThread(binding.id, event.threadId);
        storage.updateRunCodexId(run.id, event.threadId);
        continue;
      }

      if (event.type === "token_usage") {
        storage.updateBindingTokenUsage(binding.id, event.tokenUsage);
        continue;
      }

      if (event.type === "agent_message") {
        finalMessage = event.text;
        if (event.text.trim() && event.text !== lastSentAgentMessage) {
          await sendText(bot, config, binding, event.text);
          lastSentAgentMessage = event.text;
        }
        continue;
      }

      if (event.type === "command_started") {
        await sendText(bot, config, binding, codeBlock(truncateText(event.text, 900), "bash"));
        continue;
      }

      if (event.type === "command_completed") {
        if (event.text.trim()) {
          await sendText(bot, config, binding, codeBlock(truncateText(event.text, 1200)));
        }
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
        await sendText(
          bot,
          config,
          binding,
          `Run #${run.id} failed:\n${codeBlock(truncateText(event.error, 2500))}`,
          terminalRunSendOptions(run),
        );
        await sendManagerRunReport(storage, bot, config, binding, run, "failed", truncateText(event.error, 1200));
        return;
      }

      if (event.type === "completed") {
        finalMessage = event.finalMessage || finalMessage;
      }
    }

    const completionMessage = finalMessage || "Codex completed without a final message.";
    storage.completeRun(run.id, completionMessage);
    await sendText(
      bot,
      config,
      binding,
      completionMessage === lastSentAgentMessage ? "Done." : completionMessage,
      terminalRunSendOptions(run),
    );
    await sendManagerRunReport(storage, bot, config, binding, run, "completed", truncateText(completionMessage, 1200));
  } catch (error) {
    const message = errorMessage(error);
    storage.failRun(run.id, message);
    await sendText(bot, config, binding, `Run #${run.id} failed:\n${codeBlock(truncateText(message, 2500))}`, {
      notify: true,
      replyToMessageId: run.telegramMessageId,
    });
    await sendManagerRunReport(storage, bot, config, binding, run, "failed", truncateText(message, 1200));
  } finally {
    if (lockAcquired) {
      storage.releaseLock(binding.repoPath, run.id);
    }
    storage.updateBindingStatus(binding.id, "idle");
  }
}

function getTopicRef(ctx: Context, config: AppConfig): TopicRef | null {
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
  if (!chatId) {
    return null;
  }

  const messageThreadId = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;
  if (typeof messageThreadId === "number") {
    return { chatId, messageThreadId };
  }

  if (config.allowUnthreadedChats) {
    return { chatId, messageThreadId: 0 };
  }

  return null;
}

function isTopicZero(ctx: Context, config: AppConfig): boolean {
  return getTopicRef(ctx, config)?.messageThreadId === 0;
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

async function requireTopicZero(ctx: Context, config: AppConfig): Promise<TopicRef | null> {
  const topic = getTopicRef(ctx, config);
  if (!topic) {
    await reply(ctx, "Use this inside topic zero, or enable ALLOW_UNTHREADED_CHATS for the general topic.", config);
    return null;
  }

  if (topic.messageThreadId !== 0) {
    await reply(ctx, "Use this manager command from topic zero.", config);
    return null;
  }

  return topic;
}

function ensureManagerBinding(
  ctx: Context,
  config: AppConfig,
  storage: Storage,
  topic: TopicRef,
): TopicBinding {
  const existing = storage.getBinding(topic.chatId, topic.messageThreadId);
  if (existing) {
    if (existing.repoPath !== config.managerRepoPath || existing.topicName !== "manager") {
      storage.updateBindingRepoPath(existing.id, config.managerRepoPath, "manager");
      storage.audit({
        telegramUserId: ctx.from?.id ?? null,
        chatId: topic.chatId,
        messageThreadId: topic.messageThreadId,
        eventType: "manager_binding_repo_updated",
        details: {
          previousRepoPath: existing.repoPath,
          previousTopicName: existing.topicName,
          repoPath: config.managerRepoPath,
          topicName: "manager",
        },
      });
      const updated = storage.getBindingById(existing.id) ?? existing;
      existing.repoPath = updated.repoPath;
      existing.topicName = updated.topicName;
      existing.codexThreadId = updated.codexThreadId;
      existing.tokenUsage = updated.tokenUsage;
    }
    if (existing.sandboxMode !== "read-only") {
      storage.updateBindingMode(existing.id, "read-only");
      return storage.getBindingById(existing.id) ?? existing;
    }
    return existing;
  }

  const binding = storage.upsertBinding({
    chatId: topic.chatId,
    messageThreadId: topic.messageThreadId,
    topicName: "manager",
    repoPath: config.managerRepoPath,
    createdByUserId: ctx.from?.id ?? 0,
    sandboxMode: "read-only",
  });
  storage.audit({
    telegramUserId: ctx.from?.id ?? null,
    chatId: topic.chatId,
    messageThreadId: topic.messageThreadId,
    eventType: "manager_binding_created",
    details: { repoPath: binding.repoPath },
  });
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

async function reply(
  ctx: Context,
  text: string,
  config: AppConfig,
  sendQueue = sendQueueFor(config),
): Promise<void> {
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
  if (!chatId) {
    return;
  }
  const messageThreadId = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;
  for (const chunk of markdownV2Chunks(text, config.maxTelegramMessageChars)) {
    const options =
      typeof messageThreadId === "number"
        ? {
            message_thread_id: messageThreadId,
            link_preview_options: { is_disabled: true },
            parse_mode: "MarkdownV2" as const,
            disable_notification: true,
          }
        : {
            link_preview_options: { is_disabled: true },
            parse_mode: "MarkdownV2" as const,
            disable_notification: true,
          };
    await sendQueue.sendMessage(ctx.api, chatId, chunk, options);
  }
}

async function replyWithModelKeyboard(
  ctx: Context,
  config: AppConfig,
  text: string,
  keyboard: InlineKeyboard,
  sendQueue = sendQueueFor(config),
): Promise<void> {
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
  if (!chatId) {
    return;
  }
  const messageThreadId = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;
  const chunks = markdownV2Chunks(text, config.maxTelegramMessageChars);
  const first = chunks[0] ?? "";
  const options = {
    ...(typeof messageThreadId === "number" ? { message_thread_id: messageThreadId } : {}),
    link_preview_options: { is_disabled: true },
    parse_mode: "MarkdownV2" as const,
    disable_notification: true,
    reply_markup: keyboard,
  };
  await sendQueue.sendMessage(ctx.api, chatId, first, options);

  for (const chunk of chunks.slice(1)) {
    const followupOptions = {
      ...(typeof messageThreadId === "number" ? { message_thread_id: messageThreadId } : {}),
      link_preview_options: { is_disabled: true },
      parse_mode: "MarkdownV2" as const,
      disable_notification: true,
    };
    await sendQueue.sendMessage(ctx.api, chatId, chunk, followupOptions);
  }
}

async function sendText(
  bot: Bot,
  config: AppConfig,
  binding: TopicBinding,
  text: string,
  options: SendOptions = {},
): Promise<void> {
  await sendTextToTopic(bot, config, binding.chatId, binding.messageThreadId, text, options);
}

async function sendTextToTopic(
  bot: Bot,
  config: AppConfig,
  chatId: number,
  messageThreadId: number,
  text: string,
  options: SendOptions = {},
): Promise<void> {
  const chunks = markdownV2Chunks(text, config.maxTelegramMessageChars);
  for (const [index, chunk] of chunks.entries()) {
    const sendOptions = {
      link_preview_options: { is_disabled: true },
      parse_mode: "MarkdownV2",
      disable_notification: !(options.notify === true && index === 0),
      ...(messageThreadId > 0 ? { message_thread_id: messageThreadId } : {}),
      ...(options.replyToMessageId
        ? {
            reply_parameters: {
              message_id: options.replyToMessageId,
              allow_sending_without_reply: true,
            },
          }
        : {}),
    } as const;
    await sendQueueFor(config).sendMessage(bot.api, chatId, chunk, sendOptions);
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

async function sendModelSwitcher(ctx: Context, config: AppConfig, binding: TopicBinding): Promise<void> {
  try {
    const models = await listCodexModels(config.codexBin);
    if (models.length === 0) {
      await reply(ctx, "No Codex models were returned by app-server.", config);
      return;
    }

    await replyWithModelKeyboard(
      ctx,
      config,
      [
        "Choose model for this topic.",
        "",
        `Current: ${await modelLabel(config, binding)}`,
        "The next run will use the selected model in this thread.",
      ].join("\n"),
      modelKeyboard(models, binding.model),
    );
  } catch (error) {
    await reply(ctx, `Could not list models:\n${codeBlock(errorMessage(error))}`, config);
  }
}

function modelKeyboard(models: CodexModelInfo[], currentModel: string | null): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  keyboard.text(`${currentModel === null ? "Default (current)" : "Default"}`, "model:default").row();

  for (const model of models) {
    const callbackData = `model:set:${model.model}`;
    if (callbackData.length > 64) {
      continue;
    }
    const label = `${model.displayName || model.model}${currentModel === model.model ? " (current)" : ""}`;
    keyboard.text(label.slice(0, 56), callbackData).row();
  }

  return keyboard;
}

async function sendManagerRunReport(
  storage: Storage,
  bot: Bot,
  config: AppConfig,
  binding: TopicBinding,
  run: RunRecord,
  status: string,
  details: string,
): Promise<void> {
  if (binding.messageThreadId === 0) {
    return;
  }

  storage.addManagerEvent({
    chatId: binding.chatId,
    sourceMessageThreadId: binding.messageThreadId,
    bindingId: binding.id,
    runId: run.id,
    eventType: `run_${status}`,
    summary: managerEventSummary(binding, run, status, details),
    details: {
      topicName: topicDisplayName(binding),
      repoPath: binding.repoPath,
      prompt: run.prompt,
      details,
    },
  });

  try {
    await sendTextToTopic(bot, config, binding.chatId, 0, managerRunReportText(binding, run, status, details));
  } catch (error) {
    logger.warn("failed to send manager run report", {
      chatId: binding.chatId,
      messageThreadId: binding.messageThreadId,
      runId: run.id,
      status,
      error: errorMessage(error),
    });
  }
}

function managerEventSummary(binding: TopicBinding, run: RunRecord, status: string, details: string): string {
  const detail = details.trim() ? ` - ${oneLine(details, 160)}` : "";
  return `${topicDisplayName(binding)} run #${run.id} ${status}: ${oneLine(run.prompt, 180)}${detail}`;
}

function managerRunReportText(binding: TopicBinding, run: RunRecord, status: string, details: string): string {
  return [
    `Manager report: ${topicDisplayName(binding)}`,
    "",
    `Run #${run.id}: ${status}`,
    `Thread: ${binding.messageThreadId}`,
    `Repo:\n${codeBlock(binding.repoPath)}`,
    `Prompt:\n${codeBlock(truncateText(run.prompt, 700))}`,
    details.trim() ? `Details:\n${codeBlock(truncateText(details, 1400))}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function pinRunMessage(bot: Bot, binding: TopicBinding, run: RunRecord): Promise<void> {
  if (run.telegramMessageId === null) {
    return;
  }

  try {
    await bot.api.pinChatMessage(binding.chatId, run.telegramMessageId, {
      disable_notification: true,
    });
  } catch (error) {
    logger.warn("failed to pin telegram run message", {
      chatId: binding.chatId,
      messageThreadId: binding.messageThreadId,
      runId: run.id,
      telegramMessageId: run.telegramMessageId,
      error: errorMessage(error),
    });
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

function parsePlanMode(input: string): boolean | null {
  if (["on", "true", "yes", "1", "plan"].includes(input)) {
    return true;
  }
  if (["off", "false", "no", "0", "default"].includes(input)) {
    return false;
  }
  return null;
}

function formatPlanMode(planMode: boolean): string {
  return planMode ? "on" : "off";
}

function effectiveSandboxMode(config: AppConfig, sandboxMode: SandboxMode): SandboxMode {
  return config.alwaysYoloMode ? "danger-full-access" : sandboxMode;
}

function effectiveRunSandboxMode(config: AppConfig, binding: TopicBinding): SandboxMode {
  return binding.messageThreadId === 0 ? binding.sandboxMode : effectiveSandboxMode(config, binding.sandboxMode);
}

function isWriteSandbox(sandboxMode: SandboxMode): boolean {
  return sandboxMode === "workspace-write" || sandboxMode === "danger-full-access";
}

function extractTelegramFileRefs(ctx: Context): TelegramFileRef[] {
  const message = ctx.message as TelegramMessageWithFiles | undefined;
  if (!message) {
    return [];
  }

  const refs: TelegramFileRef[] = [];
  if (message.photo?.length) {
    const photo = [...message.photo].sort((left, right) => {
      const leftPixels = (left.width ?? 0) * (left.height ?? 0);
      const rightPixels = (right.width ?? 0) * (right.height ?? 0);
      return rightPixels - leftPixels;
    })[0];
    if (photo) {
      refs.push(fileRef("photo", photo, "telegram-photo.jpg"));
    }
  }

  pushFileRef(refs, "document", message.document);
  pushFileRef(refs, "audio", message.audio);
  pushFileRef(refs, "video", message.video);
  pushFileRef(refs, "animation", message.animation);
  pushFileRef(refs, "video_note", message.video_note, "telegram-video-note.mp4");
  pushFileRef(refs, "voice", message.voice, "telegram-voice.oga");
  pushFileRef(refs, "sticker", message.sticker, "telegram-sticker.webp");

  return refs;
}

function pushFileRef(
  refs: TelegramFileRef[],
  kind: string,
  value: TelegramFileLike | undefined,
  fallbackName: string | null = null,
): void {
  if (!value) {
    return;
  }
  refs.push(fileRef(kind, value, fallbackName));
}

function fileRef(kind: string, value: TelegramFileLike, fallbackName: string | null): TelegramFileRef {
  return {
    kind,
    fileId: value.file_id,
    fileUniqueId: value.file_unique_id,
    originalName: value.file_name ?? fallbackName,
    mimeType: value.mime_type ?? null,
    fileSize: value.file_size ?? null,
  };
}

function captionInstruction(ctx: Context): { text: string; unsupportedCommand: boolean } {
  const message = ctx.message as TelegramMessageWithFiles | undefined;
  const caption = message?.caption?.trim() ?? "";
  if (!caption) {
    return { text: "", unsupportedCommand: false };
  }

  const askMatch = caption.match(/^\/ask(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (askMatch) {
    return { text: askMatch[1]?.trim() ?? "", unsupportedCommand: false };
  }

  return { text: caption, unsupportedCommand: caption.startsWith("/") };
}

function uploadedFilesSavedText(files: StoredContextFile[]): string {
  return ["Saved Telegram upload to:", codeBlock(files.map((file) => file.relativePath).join("\n"))].join("\n");
}

function stagedFilesSavedText(files: ContextFilePrompt[]): string {
  return [
    "Saved Telegram upload for the next prompt:",
    codeBlock(files.map((file) => file.relativePath).join("\n")),
    "",
    "Send text in this topic, or send another upload with a caption, to include the saved file(s).",
  ].join("\n");
}

function uploadedFilesPrompt(files: ContextFilePrompt[], instruction: string): string {
  const lines = [
    "Telegram uploaded file(s) were saved under this repository's .context folder.",
    "",
    "Saved file(s):",
    files
      .map((file) =>
        [
          `- ${file.relativePath}`,
          `kind=${file.kind}`,
          file.mimeType ? `mime=${file.mimeType}` : null,
          `size=${file.fileSize} bytes`,
          file.originalName ? `original=${file.originalName}` : null,
        ]
          .filter(Boolean)
          .join(" "),
      )
      .join("\n"),
  ];

  if (instruction) {
    lines.push("", "User caption/instructions:", instruction);
  } else {
    lines.push(
      "",
      "No explicit caption/instructions were included. Inspect the saved file(s) if useful, summarize what is available, and ask what the user wants done next if the next action is unclear.",
    );
  }

  lines.push("", "Use these local paths as context. Copy or move files only if the user asked for that.");
  return lines.join("\n");
}

function voiceTranscriptPrompt(transcript: string): string {
  return [
    "A Telegram voice message was transcribed.",
    "",
    "Transcript:",
    "",
    transcript,
  ].join("\n");
}

function managerDashboardText(storage: Storage, chatId: number): string {
  const bindings = storage.listBindingsForChat(chatId);
  const workerBindings = bindings.filter((binding) => binding.messageThreadId !== 0);
  const actionable = storage.listActionableRunsForChat(chatId, 12);
  const running = actionable.filter((item) => item.run.status === "running").length;
  const queued = actionable.filter((item) => item.run.status === "queued").length;
  const failed = actionable.filter((item) => item.run.status === "failed").length;

  return [
    "Manager dashboard",
    "",
    "Summary:",
    codeBlock(
      [
        `worker topics: ${workerBindings.length}`,
        `running: ${running}`,
        `queued: ${queued}`,
        `failed needing review: ${failed}`,
      ].join("\n"),
    ),
    "Active work:",
    actionable.length > 0
      ? codeBlock(actionable.map(({ binding, run }) => formatManagerRunLine(binding, run)).join("\n"))
      : codeBlock("none"),
    "",
    "Use /topics for all bindings and /todo for actionable runs.",
  ].join("\n");
}

function managerTopicsText(storage: Storage, chatId: number): string {
  const bindings = storage.listBindingsForChat(chatId);
  if (bindings.length === 0) {
    return "No bound topics in this chat yet. Use /create from topic zero or /bind inside a worker topic.";
  }

  return [
    "Managed topics:",
    codeBlock(
      bindings
        .map((binding) => {
          const active = storage.getActiveRun(binding.id);
          const latest = storage.getLatestRun(binding.id);
          const runLabel = active
            ? `active #${active.id} ${active.status}`
            : latest
              ? `latest #${latest.id} ${latest.status}`
              : "no runs";
          return [
            `${binding.messageThreadId === 0 ? "topic zero" : `topic ${binding.messageThreadId}`}: ${topicDisplayName(binding)}`,
            `  status: ${binding.status}; ${runLabel}`,
            `  repo: ${binding.repoPath}`,
          ].join("\n");
        })
        .join("\n\n"),
    ),
  ].join("\n");
}

function managerTodoText(storage: Storage, chatId: number): string {
  const actionable = storage.listActionableRunsForChat(chatId, 20);
  if (actionable.length === 0) {
    return [
      "Manager todo:",
      codeBlock("No queued, running, or failed runs found."),
      "",
      "Explicit work-item tracking is the next layer; this view currently derives todo state from run status.",
    ].join("\n");
  }

  const grouped = [
    ["Running", actionable.filter((item) => item.run.status === "running")],
    ["Queued", actionable.filter((item) => item.run.status === "queued")],
    ["Needs review", actionable.filter((item) => item.run.status === "failed")],
  ] as const;

  return [
    "Manager todo:",
    ...grouped.flatMap(([label, items]) =>
      items.length > 0
        ? [
            "",
            `${label}:`,
            codeBlock(items.map(({ binding, run }) => formatManagerRunLine(binding, run)).join("\n")),
          ]
        : [],
    ),
  ].join("\n");
}

function managerPromptText(storage: Storage, chatId: number, userText: string): string {
  const bindings = storage.listBindingsForChat(chatId).filter((binding) => binding.messageThreadId !== 0);
  const actionable = storage.listActionableRunsForChat(chatId, 20);
  const events = storage.listManagerEvents(chatId, 40);

  return [
    "You are the topic-zero manager for Codex CLI over Telegram.",
    "Help organize work across worker topics, identify blockers, suggest priorities, and summarize what has happened.",
    "If the user asks you to assign or queue work and one managed topic is a clear target, call the telegram_manager.queue_topic tool. Do not tell the user to run /queue_topic or /assign when the tool is available.",
    "Do not claim you changed worker topics unless the provided context or tool result says that happened.",
    "",
    "Current user request:",
    userText,
    "",
    "Managed worker topics:",
    bindings.length > 0
      ? bindings.map((binding) => formatManagerTopicContext(storage, binding)).join("\n")
      : "No worker topics are currently bound.",
    "",
    "Actionable runs:",
    actionable.length > 0
      ? actionable.map(({ binding, run }) => formatManagerRunContext(binding, run)).join("\n")
      : "No queued, running, or failed worker runs.",
    "",
    "Recent manager event log:",
    events.length > 0
      ? events.map((event) => formatManagerEventContext(event)).join("\n")
      : "No manager events recorded yet.",
  ].join("\n");
}

function formatManagerTopicContext(storage: Storage, binding: TopicBinding): string {
  const active = storage.getActiveRun(binding.id);
  const latest = storage.getLatestRun(binding.id);
  const run = active ?? latest;
  const runSummary = run ? `run #${run.id} ${run.status}: ${oneLine(run.prompt, 120)}` : "no runs";
  return `- ${topicDisplayName(binding)} (topic ${binding.messageThreadId}) repo=${binding.repoPath} status=${binding.status}; ${runSummary}`;
}

function formatManagerRunContext(binding: TopicBinding, run: RunRecord): string {
  const result = run.finalMessage ?? run.errorMessage ?? "";
  const suffix = result ? ` result=${oneLine(result, 180)}` : "";
  return `- #${run.id} ${run.status} topic=${topicDisplayName(binding)} prompt=${oneLine(run.prompt, 180)}${suffix}`;
}

function formatManagerEventContext(event: { createdAt: string; eventType: string; sourceMessageThreadId: number; runId: number | null; summary: string }): string {
  const runPart = event.runId === null ? "" : ` run=#${event.runId}`;
  return `- ${event.createdAt} ${event.eventType} topic=${event.sourceMessageThreadId}${runPart}: ${oneLine(event.summary, 220)}`;
}

function formatManagerRunLine(binding: TopicBinding, run: RunRecord): string {
  return `#${run.id} ${run.status.padEnd(9)} ${topicDisplayName(binding)} - ${oneLine(run.prompt, 90)}`;
}

function topicDisplayName(binding: TopicBinding): string {
  return binding.topicName || path.basename(binding.repoPath) || `topic ${binding.messageThreadId}`;
}

function oneLine(value: string, maxLength: number): string {
  return truncateText(value.replace(/\s+/g, " ").trim(), maxLength);
}

async function modelLabel(config: AppConfig, binding: TopicBinding): Promise<string> {
  if (binding.model) {
    return `${binding.model} (topic)`;
  }
  return globalModelLabel(config, binding.repoPath);
}

async function globalModelLabel(config: AppConfig, cwd?: string): Promise<string> {
  try {
    const snapshot = await readCodexConfig(config.codexBin, cwd);
    return formatConfigModel(snapshot);
  } catch {
    return "(Codex config default)";
  }
}

function formatConfigModel(snapshot: CodexConfigSnapshot): string {
  const parts = [snapshot.model ?? "(Codex config default)"];
  if (snapshot.reasoningEffort) {
    parts.push(`effort=${snapshot.reasoningEffort}`);
  }
  if (snapshot.serviceTier) {
    parts.push(`tier=${snapshot.serviceTier}`);
  }
  return parts.join(" ");
}

async function readStatusText(config: AppConfig): Promise<string> {
  try {
    const usage = await readCodexUsage(config.codexBin);
    return [
      "Account:",
      codeBlock([formatRateLimits(usage.rateLimits), formatTokenUsage(usage.usage)].filter(Boolean).join("\n")),
    ].join("\n");
  } catch (error) {
    return `Account:\n${codeBlock(`unavailable: ${errorMessage(error)}`)}`;
  }
}

function formatThreadTokenUsage(tokenUsage: ThreadTokenUsageSnapshot | null): string {
  if (!tokenUsage) {
    return "unavailable until Codex reports token usage for this thread";
  }

  const totalTokens = tokenUsage.total.totalTokens;
  const contextWindow = tokenUsage.modelContextWindow;
  const lines = [
    contextWindow
      ? `used: ${formatNumber(totalTokens)} / ${formatNumber(contextWindow)} tokens (${formatPercent((totalTokens / contextWindow) * 100)})`
      : `used: ${formatNumber(totalTokens)} tokens`,
  ];

  if (contextWindow) {
    lines.push(`remaining: ${formatNumber(Math.max(0, contextWindow - totalTokens))} tokens`);
  }

  lines.push(
    `last turn: ${formatNumber(tokenUsage.last.totalTokens)} total, ${formatNumber(tokenUsage.last.inputTokens)} input, ${formatNumber(tokenUsage.last.outputTokens)} output`,
  );
  if (tokenUsage.last.reasoningOutputTokens > 0) {
    lines.push(`last reasoning output: ${formatNumber(tokenUsage.last.reasoningOutputTokens)}`);
  }
  if (tokenUsage.last.cachedInputTokens > 0) {
    lines.push(`last cached input: ${formatNumber(tokenUsage.last.cachedInputTokens)}`);
  }

  return lines.join("\n");
}

function formatRateLimits(response: any): string {
  const snapshot = response?.rateLimits ?? response?.rate_limits ?? response;
  if (!snapshot) {
    return "rate limits unavailable";
  }

  const lines = [
    snapshot.planType || snapshot.plan_type ? `plan: ${snapshot.planType ?? snapshot.plan_type}` : null,
    snapshot.limitName || snapshot.limit_name || snapshot.limitId || snapshot.limit_id
      ? `limit: ${snapshot.limitName ?? snapshot.limit_name ?? snapshot.limitId ?? snapshot.limit_id}`
      : null,
    snapshot.rateLimitReachedType || snapshot.rate_limit_reached_type
      ? `reached: ${snapshot.rateLimitReachedType ?? snapshot.rate_limit_reached_type}`
      : null,
    formatRateLimitWindow("primary", snapshot.primary),
    formatRateLimitWindow("secondary", snapshot.secondary),
    formatCredits(snapshot.credits),
    formatSpendLimit(snapshot.individualLimit ?? snapshot.individual_limit),
  ].filter(Boolean);

  return lines.length > 0 ? lines.join("\n") : "rate limits unavailable";
}

function formatRateLimitWindow(label: string, window: any): string | null {
  if (!window) {
    return null;
  }
  const used = typeof window.usedPercent === "number" ? window.usedPercent : window.used_percent;
  const duration = window.windowDurationMins ?? window.window_duration_mins;
  const resetsAt = typeof window.resetsAt === "number" ? window.resetsAt : window.resets_at;
  const parts = [`${label}: ${formatPercent(used)} used`];
  if (duration) {
    parts.push(`${duration}m window`);
  }
  if (resetsAt) {
    parts.push(`resets ${formatUnixSeconds(resetsAt)}`);
  }
  return parts.join(", ");
}

function formatCredits(credits: any): string | null {
  if (!credits) {
    return null;
  }
  if (credits.unlimited) {
    return "credits: unlimited";
  }
  if (credits.balance !== null && credits.balance !== undefined) {
    return `credits: ${credits.balance}`;
  }
  return typeof credits.hasCredits === "boolean" ? `credits: ${credits.hasCredits ? "available" : "none"}` : null;
}

function formatSpendLimit(limit: any): string | null {
  if (!limit) {
    return null;
  }
  const lines = [`spend remaining: ${formatPercent(limit.remainingPercent ?? limit.remaining_percent)}`];
  if (limit.resetsAt ?? limit.resets_at) {
    lines.push(`resets ${formatUnixSeconds(limit.resetsAt ?? limit.resets_at)}`);
  }
  return lines.join(", ");
}

function formatTokenUsage(response: any): string {
  const summary = response?.summary;
  if (!summary) {
    return "usage unavailable";
  }
  const lines = [
    `lifetime tokens: ${formatNumber(summary.lifetimeTokens ?? summary.lifetime_tokens)}`,
    summary.peakDailyTokens ?? summary.peak_daily_tokens
      ? `peak daily tokens: ${formatNumber(summary.peakDailyTokens ?? summary.peak_daily_tokens)}`
      : null,
    summary.currentStreakDays ?? summary.current_streak_days
      ? `current streak: ${formatNumber(summary.currentStreakDays ?? summary.current_streak_days)}d`
      : null,
  ].filter(Boolean);
  return lines.join("\n");
}

function formatPercent(value: unknown): string {
  return typeof value === "number" ? `${Math.round(value)}%` : "unknown";
}

function formatNumber(value: unknown): string {
  if (value === null || value === undefined) {
    return "unknown";
  }
  const numberValue = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(numberValue) ? new Intl.NumberFormat("en-US").format(numberValue) : String(value);
}

function formatUnixSeconds(value: unknown): string {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return "unknown";
  }
  return new Date(numberValue * 1000).toISOString();
}

function topicKey(chatId: number, messageThreadId: number): string {
  return `${chatId}:${messageThreadId}`;
}

function helpText(): string {
  return [
    "Codex over Telegram commands:",
    "",
    "/bind <absolute_repo_path> - bind this topic to a git repo",
    "/create <folder> - from topic 0, create a folder, topic, and binding",
    "/where - show repo, branch, mode, and git status",
    "/models - list available Codex models",
    "/model - show or set this topic's Codex model",
    "/plan - show or toggle plan mode for this topic",
    "/mode read - use read-only Codex sandbox",
    "/mode write - allow Codex workspace edits",
    "/topic - rename this Telegram topic to the bound folder name",
    "/new - start a fresh Codex thread with clean context",
    "/compact - compact this topic's Codex thread",
    "/dashboard - from topic zero, show all worker-topic activity",
    "/topics - from topic zero, list all bound topics",
    "/todo - from topic zero, show running, queued, and failed work",
    "/status - show active task and context usage",
    "/stop - stop the active Codex process",
    "/diff - show diff summary and attach full diff when large",
    "/commit <message> - commit repo changes",
    "/push - push current HEAD to origin",
    "/unbind - remove this topic binding",
    "/ask <prompt> - send a Codex prompt as a command",
    "/queue <prompt> - queue the next Codex turn instead of steering the active run",
    "/queue_topic <topic-id-or-name> <prompt> - queue prompt for a worker topic",
    "/assign <topic-id-or-name> <prompt> - alias for /queue_topic",
    "",
    "Any ordinary message in a bound topic is sent to Codex if Telegram privacy mode allows it. During an active app-server run, ordinary messages steer the current turn. Use /queue to force a follow-up turn, or /ask when privacy mode is enabled.",
  ].join("\n");
}

export function telegramCommandMenu(): Array<{ command: string; description: string }> {
  return [
    { command: "bind", description: "Bind this topic to a folder" },
    { command: "create", description: "Create a folder and topic from topic 0" },
    { command: "where", description: "Show this topic binding and status" },
    { command: "models", description: "List available Codex models" },
    { command: "model", description: "Show or set this topic model" },
    { command: "plan", description: "Show or toggle plan mode" },
    { command: "mode", description: "Set read or write sandbox mode" },
    { command: "topic", description: "Rename this Telegram topic" },
    { command: "new", description: "Start a fresh Codex thread" },
    { command: "compact", description: "Compact this topic's Codex thread" },
    { command: "dashboard", description: "Topic zero manager dashboard" },
    { command: "topics", description: "List managed topic bindings" },
    { command: "todo", description: "Show manager todo from run state" },
    { command: "status", description: "Show task and context usage" },
    { command: "stop", description: "Stop the active Codex process" },
    { command: "diff", description: "Show git diff summary" },
    { command: "commit", description: "Commit repo changes" },
    { command: "push", description: "Push current HEAD" },
    { command: "unbind", description: "Remove this topic binding" },
    { command: "ask", description: "Send a Codex prompt as a command" },
    { command: "queue", description: "Queue the next Codex turn" },
    { command: "queue_topic", description: "Queue a prompt for a worker topic" },
    { command: "assign", description: "Alias for /queue_topic" },
  ];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const maybe = error as Error & { stderr?: string; stdout?: string };
    return [error.message, maybe.stderr, maybe.stdout].filter(Boolean).join("\n");
  }
  return String(error);
}

function resolveNewWorkspacePath(requestedFolder: string, allowedRoots: string[]): string {
  if (allowedRoots.length === 0) {
    throw new Error("ALLOWED_REPO_ROOTS must contain at least one root.");
  }

  const expanded = expandCreateWorkspacePath(requestedFolder);
  const repoPath = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(allowedRoots[0] ?? "", path.normalize(expanded));

  const insideAllowedRoot = allowedRoots.some((root) => {
    const relative = path.relative(root, repoPath);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
  if (!insideAllowedRoot) {
    throw new Error(`Folder must stay inside allowed roots: ${allowedRoots.join(", ")}`);
  }

  return repoPath;
}

function expandCreateWorkspacePath(requestedFolder: string): string {
  if (requestedFolder === "~") {
    return os.homedir();
  }
  if (requestedFolder.startsWith("~/")) {
    return path.join(os.homedir(), requestedFolder.slice(2));
  }
  if (requestedFolder.startsWith("~")) {
    throw new Error("Only ~ and ~/ paths are supported; ~user expansion is not supported.");
  }

  const normalized = path.normalize(requestedFolder);
  if (normalized === "." || normalized.startsWith("..")) {
    throw new Error("Use a folder path inside an allowed root.");
  }

  return normalized;
}

async function ensureWorkspaceDirectory(repoPath: string): Promise<"created" | "existed"> {
  try {
    await mkdir(repoPath);
    return "created";
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;
    if (maybeNodeError.code !== "EEXIST") {
      throw error;
    }

    const existing = await stat(repoPath);
    if (!existing.isDirectory()) {
      throw new Error(`Path already exists and is not a directory: ${repoPath}`);
    }
    return "existed";
  }
}

function topicNameForPath(repoPath: string): string {
  const trimmedPath = repoPath.replace(/\/+$/, "");
  const folderName = trimmedPath.split("/").filter(Boolean).pop() ?? trimmedPath;
  return (folderName || repoPath).slice(0, 128);
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
