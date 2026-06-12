import { Bot, InputFile, type Context } from "grammy";
import type { AppConfig } from "./config.js";
import type { CodexBackend, CodexRunEvent, RunRecord, SandboxMode, TopicBinding } from "./types.js";
import { Storage } from "./storage.js";
import { RunQueue } from "./runQueue.js";
import { resolveAllowedRepoPath } from "./pathPolicy.js";
import { codeBlock, markdownV2Chunks, truncateText } from "./text.js";
import { commitAll, currentBranch, diffSummary, fullDiff, isGitRepository, pushHead, statusShort } from "./git.js";
import { listCodexModels, readCodexConfig, readCodexUsage, type CodexConfigSnapshot } from "./codexMetadata.js";
import { logger } from "./logger.js";
import { TelegramSendQueue } from "./telegramSendQueue.js";
import {
  saveTelegramFileToContext,
  saveTranscriptForAudio,
  transcribeStoredAudio,
  type StoredContextFile,
  type TelegramFileRef,
} from "./telegramMedia.js";

interface TopicRef {
  chatId: number;
  messageThreadId: number;
}

interface SendOptions {
  notify?: boolean;
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
}

interface CreateTelegramBotOptions {
  recoverRuns?: RunRecord[];
}

const sendQueues = new WeakMap<AppConfig, TelegramSendQueue>();

export function createTelegramBot(
  config: AppConfig,
  storage: Storage,
  codex: CodexBackend,
  options: CreateTelegramBotOptions = {},
): Bot {
  const bot = new Bot(config.telegramBotToken);
  const queue = new RunQueue(config.maxParallelRuns);
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
          `Mode:\n${codeBlock(effectiveSandboxMode(config, binding.sandboxMode))}`,
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
        `Model:\n${codeBlock(await modelLabel(config, binding))}`,
        `Plan mode:\n${codeBlock(formatPlanMode(binding.planMode))}`,
        `Mode:\n${codeBlock(effectiveSandboxMode(config, binding.sandboxMode))}`,
        `Codex session:\n${codeBlock(binding.codexThreadId ?? "(new)")}`,
        `Status:\n${codeBlock(binding.status)}`,
        "",
        `Git status:\n${codeBlock(status)}`,
      ].join("\n"),
      config,
    );
  });

  bot.command("models", async (ctx) => {
    try {
      const models = await listCodexModels(config.codexBin);
      if (models.length === 0) {
        await reply(ctx, "No Codex models were returned by app-server.", config);
        return;
      }
      await reply(
        ctx,
        [
          "Available models:",
          codeBlock(
            models
              .map((model) => `${model.model}${model.isDefault ? " (default)" : ""} - ${model.displayName}`)
              .join("\n"),
          ),
          "Set this topic with /model <model>.",
        ].join("\n"),
        config,
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
      await reply(
        ctx,
        [
          "Current model:",
          codeBlock(await modelLabel(config, binding)),
          "",
          "Use /models to list available models.",
          "Use /model <model> to set this topic.",
          "Use /model default to return to Codex config default.",
        ].join("\n"),
        config,
      );
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
        [`Topic model set to:`, codeBlock(match.model), "", "A fresh Codex session will start on the next run."].join("\n"),
        config,
      );
    } catch (error) {
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
        "A fresh Codex session will start on the next run.",
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
    await reply(ctx, "Started a fresh Codex session for this topic.", config);
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
          `Mode:\n${codeBlock(effectiveSandboxMode(config, binding.sandboxMode))}`,
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
    await handlePrompt(ctx, config, storage, codex, bot, queue, text);
  });

  bot.command("queue", async (ctx) => {
    const text = ctx.match.trim();
    if (!text) {
      await reply(ctx, "Usage: /queue what Codex should do after the current run", config);
      return;
    }
    await handlePrompt(ctx, config, storage, codex, bot, queue, text, { forceQueue: true });
  });

  bot.on("message:file", async (ctx) => {
    await handleFileMessage(ctx, config, storage, codex, bot, queue);
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

    await reply(ctx, uploadedFilesSavedText(storedFiles), config);
    await handlePrompt(
      ctx,
      config,
      storage,
      codex,
      bot,
      queue,
      uploadedFilesPrompt(storedFiles, instruction.text),
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

  const active = storage.getActiveRun(binding.id);
  if (!options.forceQueue && active && active.status === "running" && codex.steer) {
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
      [
        `Started run #${run.id}.`,
        `Repo:\n${codeBlock(binding.repoPath)}`,
        `Model:\n${codeBlock(await modelLabel(config, binding))}`,
        `Plan mode:\n${codeBlock(formatPlanMode(binding.planMode))}`,
        `Mode:\n${codeBlock(effectiveSandboxMode(config, binding.sandboxMode))}`,
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
    await executeRun(bot, config, storage, codex, freshBinding, run, text);
  });
}

async function resumeInterruptedRuns(
  bot: Bot,
  config: AppConfig,
  storage: Storage,
  codex: CodexBackend,
  queue: RunQueue,
  runs: RunRecord[],
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
        [
          `Service restarted while run #${run.id} was active or queued.`,
          "Resuming it now from the saved prompt.",
        ].join("\n"),
        { notify: true },
      );
      await executeRun(bot, config, storage, codex, freshBinding, run, run.prompt);
    });
  }
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
    const sandboxMode = effectiveSandboxMode(config, binding.sandboxMode);

    if (isWriteSandbox(sandboxMode)) {
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
    await pinRunMessage(bot, binding, run);
    storage.audit({
      telegramUserId: null,
      chatId: binding.chatId,
      messageThreadId: binding.messageThreadId,
      eventType: "run_started",
      details: { runId: run.id, repoPath: binding.repoPath, sandboxMode },
    });

    for await (const event of codex.run({
      bindingId: binding.id,
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
          { notify: true },
        );
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
      { notify: true },
    );
  } catch (error) {
    const message = errorMessage(error);
    storage.failRun(run.id, message);
    await sendText(bot, config, binding, `Run #${run.id} failed:\n${codeBlock(truncateText(message, 2500))}`, {
      notify: true,
    });
  } finally {
    if (lockAcquired) {
      storage.releaseLock(binding.repoPath, run.id);
    }
    await unpinRunMessage(bot, binding, run);
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

async function reply(
  ctx: Context,
  text: string,
  config: AppConfig,
  sendQueue = sendQueueFor(config),
): Promise<void> {
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

async function sendText(
  bot: Bot,
  config: AppConfig,
  binding: TopicBinding,
  text: string,
  options: SendOptions = {},
): Promise<void> {
  const chunks = markdownV2Chunks(text, config.maxTelegramMessageChars);
  for (const [index, chunk] of chunks.entries()) {
    await sendQueueFor(config).sendMessage(bot.api, binding.chatId, chunk, {
      message_thread_id: binding.messageThreadId,
      link_preview_options: { is_disabled: true },
      parse_mode: "MarkdownV2",
      disable_notification: !(options.notify === true && index === 0),
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

async function unpinRunMessage(bot: Bot, binding: TopicBinding, run: RunRecord): Promise<void> {
  if (run.telegramMessageId === null) {
    return;
  }

  try {
    await bot.api.unpinChatMessage(binding.chatId, run.telegramMessageId);
  } catch (error) {
    logger.warn("failed to unpin telegram run message", {
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

function uploadedFilesPrompt(files: StoredContextFile[], instruction: string): string {
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
    "/where - show repo, branch, mode, and git status",
    "/models - list available Codex models",
    "/model - show or set this topic's Codex model",
    "/plan - show or toggle plan mode for this topic",
    "/mode read - use read-only Codex sandbox",
    "/mode write - allow Codex workspace edits",
    "/topic - rename this Telegram topic to the bound folder name",
    "/new - start a fresh Codex session",
    "/status - show active queued/running task",
    "/stop - stop the active Codex process",
    "/diff - show diff summary and attach full diff when large",
    "/commit <message> - commit repo changes",
    "/push - push current HEAD to origin",
    "/unbind - remove this topic binding",
    "/ask <prompt> - send a Codex prompt as a command",
    "/queue <prompt> - queue the next Codex turn instead of steering the active run",
    "",
    "Any ordinary message in a bound topic is sent to Codex if Telegram privacy mode allows it. During an active app-server run, ordinary messages steer the current turn. Use /queue to force a follow-up turn, or /ask when privacy mode is enabled.",
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
