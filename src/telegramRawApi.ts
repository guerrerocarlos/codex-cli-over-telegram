export interface RichMessageOptions {
  messageThreadId?: number;
  disableNotification?: boolean;
}

export class TelegramRawApi {
  constructor(private readonly botToken: string) {}

  sendRichMessageDraft(input: {
    chatId: number;
    draftId: number;
    text: string;
    options?: RichMessageOptions;
  }): Promise<unknown> {
    return this.call("sendRichMessageDraft", {
      chat_id: input.chatId,
      draft_id: input.draftId,
      rich_message: plainRichMessage(input.text),
      ...(input.options?.messageThreadId ? { message_thread_id: input.options.messageThreadId } : {}),
    });
  }

  sendRichMessage(input: {
    chatId: number;
    text: string;
    options?: RichMessageOptions;
  }): Promise<unknown> {
    return this.call("sendRichMessage", {
      chat_id: input.chatId,
      rich_message: plainRichMessage(input.text),
      ...(input.options?.messageThreadId ? { message_thread_id: input.options.messageThreadId } : {}),
      ...(input.options?.disableNotification ? { disable_notification: true } : {}),
    });
  }

  private async call(method: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: unknown;
      description?: string;
      parameters?: { retry_after?: number };
    } | null;
    if (!response.ok || !result?.ok) {
      const retryAfter = result?.parameters?.retry_after;
      const suffix = retryAfter ? ` retry_after=${retryAfter}` : "";
      throw new Error(result?.description ? `${result.description}${suffix}` : `Telegram ${method} failed with HTTP ${response.status}`);
    }
    return result.result;
  }
}

function plainRichMessage(text: string): { markdown: string; skip_entity_detection: true } {
  return {
    markdown: text,
    skip_entity_detection: true,
  };
}
