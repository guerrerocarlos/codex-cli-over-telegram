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
    let transientFailures = 0;
    let effectiveChatId = chatId;
    for (;;) {
      await this.waitForSlot();

      try {
        const message = await api.sendMessage(effectiveChatId, text, options);
        this.nextSendAt = Date.now() + this.intervalMs;
        return message;
      } catch (error) {
        const migrateToChatId = telegramMigrateToChatId(error);
        if (migrateToChatId !== null && migrateToChatId !== effectiveChatId) {
          logger.warn("telegram chat migrated; retrying send with new chat id", {
            oldChatId: effectiveChatId,
            newChatId: migrateToChatId,
            error: errorMessage(error),
          });
          effectiveChatId = migrateToChatId;
          transientFailures = 0;
          this.nextSendAt = Date.now() + this.intervalMs;
          continue;
        }

        const retryAfterSeconds = telegramRetryAfterSeconds(error);
        if (retryAfterSeconds === null) {
          if (!isTransientTelegramSendError(error)) {
            throw error;
          }

          transientFailures += 1;
          const retryAfterMs = Math.min(30_000, 1000 * 2 ** Math.min(transientFailures, 5));
          this.nextSendAt = Date.now() + retryAfterMs;
          logger.warn("telegram send transient failure; retrying", {
            retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
            error: errorMessage(error),
          });
          continue;
        }

        transientFailures = 0;
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

function telegramMigrateToChatId(error: unknown): number | null {
  const details = error as {
    error_code?: unknown;
    parameters?: { migrate_to_chat_id?: unknown };
  };
  const migrateToChatId = details.parameters?.migrate_to_chat_id;
  if (details.error_code === 400 && typeof migrateToChatId === "number") {
    return migrateToChatId;
  }
  return null;
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

function isTransientTelegramSendError(error: unknown): boolean {
  const values = new Set<string>();
  collectStringFields(error, values);
  return ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"].some((code) =>
    values.has(code),
  );
}

function collectStringFields(value: unknown, output: Set<string>, seen = new Set<unknown>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);

  for (const item of Object.values(value as Record<string, unknown>)) {
    if (typeof item === "string") {
      output.add(item);
    } else if (item && typeof item === "object") {
      collectStringFields(item, output, seen);
    }
  }
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
