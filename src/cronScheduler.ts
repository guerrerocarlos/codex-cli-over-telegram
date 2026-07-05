import type { Bot } from "grammy";
import type { AppConfig } from "./config.js";
import { nextCronRunAfter } from "./cron.js";
import type { CodexBackend } from "./types.js";
import { RunQueue } from "./runQueue.js";
import { Storage } from "./storage.js";
import { queueManagerTopicRun } from "./telegram.js";
import { logger } from "./logger.js";

const POLL_INTERVAL_MS = 60_000;
const DUE_JOB_LIMIT = 25;

export class CronScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly input: {
      storage: Storage;
      bot: Bot;
      config: AppConfig;
      codex: CodexBackend;
      queue: RunQueue;
    },
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const dueJobs = this.input.storage.listDueCronJobs(new Date().toISOString(), DUE_JOB_LIMIT);
      for (const job of dueJobs) {
        await this.queueCronJob(job.id);
      }
    } catch (error) {
      logger.warn("cron scheduler tick failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  private async queueCronJob(jobId: number): Promise<void> {
    const { storage, bot, config, codex, queue } = this.input;
    const job = storage.getCronJob(jobId);
    if (!job || !job.enabled) {
      return;
    }

    let nextRunAt: string;
    try {
      nextRunAt = nextCronRunAfter(job.cronExpression, new Date()).toISOString();
    } catch (error) {
      storage.updateCronJobError(job.id, error instanceof Error ? error.message : String(error), nextHourIso());
      return;
    }

    const binding = storage.getBindingById(job.bindingId);
    if (!binding) {
      storage.updateCronJobError(job.id, "target topic binding was removed", nextRunAt);
      return;
    }

    try {
      const result = await queueManagerTopicRun({
        storage,
        bot,
        config,
        codex,
        queue,
        managerTopic: { chatId: job.chatId, messageThreadId: 0 },
        telegramUserId: job.createdByUserId,
        input: `${binding.messageThreadId} ${cronRunPrompt(job.id, job.prompt)}`,
        replyToMessageId: null,
        notify: false,
        source: "cron",
      });
      if (!result.ok || result.runId === undefined) {
        storage.updateCronJobError(job.id, result.message, nextRunAt);
        return;
      }
      storage.updateCronJobAfterRun(job.id, { runId: result.runId, nextRunAt });
      logger.info("cron job queued", {
        cronJobId: job.id,
        runId: result.runId,
        topicId: binding.messageThreadId,
        nextRunAt,
      });
    } catch (error) {
      storage.updateCronJobError(job.id, error instanceof Error ? error.message : String(error), nextRunAt);
    }
  }
}

function cronRunPrompt(cronJobId: number, prompt: string): string {
  return [
    `Scheduled cron job #${cronJobId} fired.`,
    "",
    prompt,
  ].join("\n");
}

function nextHourIso(): string {
  const next = new Date();
  next.setMinutes(next.getMinutes() + 60, 0, 0);
  return next.toISOString();
}
