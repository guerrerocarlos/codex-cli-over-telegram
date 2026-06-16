import type { CodexBackend, CodexRunEvent, CodexRunRequest } from "./types.js";

export class ProviderRouterBackend implements CodexBackend {
  constructor(
    private readonly openaiBackend: CodexBackend,
    private readonly xaiBackend: CodexBackend,
    private readonly claudeBackend: CodexBackend,
  ) {}

  run(request: CodexRunRequest): AsyncIterable<CodexRunEvent> {
    return this.backendFor(request).run(request);
  }

  interrupt(bindingId: number): Promise<boolean> {
    return Promise.all([
      this.openaiBackend.interrupt(bindingId),
      this.xaiBackend.interrupt(bindingId),
      this.claudeBackend.interrupt(bindingId),
    ]).then((results) => results.some(Boolean));
  }

  async steer(bindingId: number, prompt: string): Promise<boolean> {
    if (this.openaiBackend.steer && (await this.openaiBackend.steer(bindingId, prompt))) {
      return true;
    }
    if (this.xaiBackend.steer && (await this.xaiBackend.steer(bindingId, prompt))) {
      return true;
    }
    if (this.claudeBackend.steer && (await this.claudeBackend.steer(bindingId, prompt))) {
      return true;
    }
    return false;
  }

  async compactThread(threadId: string): Promise<void> {
    if (!this.openaiBackend.compactThread) {
      throw new Error("OpenAI backend does not support thread compaction.");
    }
    await this.openaiBackend.compactThread(threadId);
  }

  private backendFor(request: CodexRunRequest): CodexBackend {
    if (request.modelProvider === "xai") {
      return this.xaiBackend;
    }
    if (request.modelProvider === "claude") {
      return this.claudeBackend;
    }
    return this.openaiBackend;
  }
}
