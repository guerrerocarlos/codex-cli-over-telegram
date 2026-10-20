import type { CodexBackend, CodexRunEvent, CodexRunRequest } from "./types.js";

// Match only the observed pre-execution account/model rejection, not generic 400s.
export function rejectedChatGptModel(error: string): string | null {
  let message = error;
  try {
    const value = JSON.parse(error) as { type?: string; status?: number; error?: { type?: string; message?: string } };
    if (value.type !== "error" || value.status !== 400 || value.error?.type !== "invalid_request_error") return null;
    message = value.error.message ?? "";
  } catch {
    // app-server can expose the inner message without its transport envelope.
  }
  return /^The '([^']+)' model is not supported when using Codex with a ChatGPT account\.$/.exec(message)?.[1] ?? null;
}

export async function* runWithModelFallback(
  backend: CodexBackend,
  original: CodexRunRequest,
  resolveDefault: () => Promise<string | null>,
  persistSelection: (model: string, rejectedModel: string) => Promise<void>,
): AsyncIterable<CodexRunEvent> {
  let request = original;
  let workObserved = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    let failure: Extract<CodexRunEvent, { type: "failed" }> | null = null;
    try {
      for await (const event of backend.run(request)) {
        if (event.type === "started" && event.threadId) request = { ...request, codexThreadId: event.threadId };
        if (event.type === "failed") {
          failure = event;
          break; // Close the first backend stream before starting another attempt.
        }
        // Treat unknown progress, tools, output, approvals and usage conservatively as work.
        const harmless = event.type === "started" || (event.type === "progress" &&
          (event.text === "Codex turn started." || rejectedChatGptModel(event.text) !== null));
        if (!harmless) workObserved = true;
        yield event;
      }
    } catch (error) {
      failure = { type: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    if (!failure) return;
    const rejected = rejectedChatGptModel(failure.error);
    if (attempt !== 0 || workObserved || request.modelProvider !== "openai" || !rejected) {
      yield failure;
      return;
    }
    let fallback: string | null;
    try {
      fallback = await resolveDefault();
    } catch {
      yield failure;
      return;
    }
    if (!fallback || fallback === rejected || fallback === request.model) {
      yield failure;
      return;
    }
    await persistSelection(fallback, rejected);
    request = { ...request, model: fallback, modelServiceTier: null };
    yield { type: "progress", text: `Model ${rejected} is unavailable for this account. Retrying once with configured model ${fallback}.` };
  }
}
