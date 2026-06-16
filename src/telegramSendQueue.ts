import type { Bot } from "grammy";
import { logger } from "./logger.js";

type TelegramApi = Bot["api"];
type SendMessageOptions = NonNullable<Parameters<TelegramApi["sendMessage"]>[2]>;
type SendMessageResult = Awaited<ReturnType<TelegramApi["sendMessage"]>>;

export class TelegramSendQueue {
  private queue: Promise<void> = Promise.resolve();
  private nextSendAt = 0;

  constructor(private readonly intervalMs: number) {}

  sendMessage(
    api: TelegramApi,
    chatId: number,
    text: string,
    options: SendMessageOptions,
  ): Promise<SendMessageResult> {
    const task = this.queue.then(() => this.sendWithRetry(api, chatId, text, options));
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async sendWithRetry(
    api: TelegramApi,
    chatId: number,
    text: string,
    options: SendMessageOptions,
  ): Promise<SendMessageResult> {
    for (;;) {
      await this.waitForSlot();

      try {
        const message = await api.sendMessage(chatId, text, options);
        this.nextSendAt = Date.now() + this.intervalMs;
        return message;
      } catch (error) {
        const retryAfterSeconds = telegramRetryAfterSeconds(error);
        if (retryAfterSeconds === null) {
          throw error;
        }

        const retryAfterMs = (retryAfterSeconds + 1) * 1000;
        this.nextSendAt = Date.now() + retryAfterMs;
        logger.warn("telegram send rate limited; retrying", {
          retryAfterSeconds,
          error: errorMessage(error),
        });
      }
    }
  }

  private async waitForSlot(): Promise<void> {
    const waitMs = Math.max(0, this.nextSendAt - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }
}

function telegramRetryAfterSeconds(error: unknown): number | null {
  const details = error as {
    error_code?: unknown;
    parameters?: { retry_after?: unknown };
    description?: unknown;
  };
  const retryAfter = details.parameters?.retry_after;
  if (details.error_code === 429 && typeof retryAfter === "number" && retryAfter > 0) {
    return retryAfter;
  }

  if (typeof details.description === "string") {
    const match = details.description.match(/retry after (\d+)/i);
    if (match?.[1]) {
      return Number(match[1]);
    }
  }

  return null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
