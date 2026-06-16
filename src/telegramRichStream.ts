import type { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { TelegramRawApi } from "./telegramRawApi.js";
import type { TopicBinding } from "./types.js";

export class TelegramRichDraftStreamer {
  private readonly rawApi: TelegramRawApi;
  private readonly draftId: number;
  private text = "";
  private lastFlushedText = "";
  private lastFlushAt = 0;
  private disabled = false;

  constructor(
    config: AppConfig,
    private readonly binding: TopicBinding,
  ) {
    this.rawApi = new TelegramRawApi(config.telegramBotToken);
    this.draftId = Math.floor(Date.now() % 2_000_000_000) + 1;
    this.flushIntervalMs = config.telegramStreamFlushMs;
    this.minChars = config.telegramStreamMinChars;
  }

  private readonly flushIntervalMs: number;
  private readonly minChars: number;

  append(delta: string): void {
    if (!delta) {
      return;
    }
    this.text += delta;
  }

  currentText(): string {
    return this.text;
  }

  async flush(force = false): Promise<boolean> {
    if (this.disabled || !this.text.trim()) {
      return false;
    }
    const now = Date.now();
    const changedChars = this.text.length - this.lastFlushedText.length;
    if (!force && changedChars < this.minChars && now - this.lastFlushAt < this.flushIntervalMs) {
      return true;
    }

    try {
      await this.rawApi.sendRichMessageDraft({
        chatId: this.binding.chatId,
        draftId: this.draftId,
        text: truncateRichText(this.text),
        options: { messageThreadId: this.binding.messageThreadId },
      });
      this.lastFlushedText = this.text;
      this.lastFlushAt = now;
      return true;
    } catch (error) {
      this.disabled = true;
      logger.warn("telegram rich draft streaming disabled after failure", {
        chatId: this.binding.chatId,
        messageThreadId: this.binding.messageThreadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async finish(finalText: string): Promise<boolean> {
    const text = finalText.trim() ? finalText : this.text;
    if (this.disabled || !text.trim()) {
      return false;
    }

    try {
      await this.rawApi.sendRichMessage({
        chatId: this.binding.chatId,
        text: truncateRichText(text),
        options: {
          messageThreadId: this.binding.messageThreadId,
          disableNotification: true,
        },
      });
      return true;
    } catch (error) {
      this.disabled = true;
      logger.warn("telegram rich message finalization failed", {
        chatId: this.binding.chatId,
        messageThreadId: this.binding.messageThreadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

function truncateRichText(text: string): string {
  return text.length > 3900 ? `${text.slice(0, 3890)}\n...` : text;
}
