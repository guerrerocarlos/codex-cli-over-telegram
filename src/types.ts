export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type ModelProvider = "openai" | "xai";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "stopped";

export interface TopicBinding {
  id: number;
  chatId: number;
  messageThreadId: number;
  topicName: string | null;
  repoPath: string;
  codexThreadId: string | null;
  modelProvider: ModelProvider;
  model: string | null;
  planMode: boolean;
  sandboxMode: SandboxMode;
  approvalPolicy: "never";
  status: string;
  tokenUsage: ThreadTokenUsageSnapshot | null;
  createdByUserId: number;
  createdAt: string;
  updatedAt: string;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsageSnapshot {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface RunRecord {
  id: number;
  bindingId: number;
  telegramMessageId: number | null;
  prompt: string;
  status: RunStatus;
  codexRunId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  finalMessage: string | null;
  errorMessage: string | null;
}

export interface InterruptedRunRecord extends RunRecord {
  interruptedStatus: Extract<RunStatus, "queued" | "running">;
}

export interface CodexRunRequest {
  bindingId: number;
  chatId: number;
  messageThreadId: number;
  repoPath: string;
  prompt: string;
  codexThreadId: string | null;
  modelProvider: ModelProvider;
  model: string | null;
  planMode: boolean;
  sandboxMode: SandboxMode;
  approvalPolicy: "never";
}

export type CodexRunEvent =
  | { type: "started"; threadId?: string; text?: string }
  | { type: "token_usage"; tokenUsage: ThreadTokenUsageSnapshot }
  | { type: "progress"; text: string }
  | { type: "command_started"; text: string }
  | { type: "command_completed"; text: string }
  | { type: "file_changed"; text: string }
  | { type: "agent_message"; text: string }
  | { type: "completed"; finalMessage?: string }
  | { type: "failed"; error: string; exitCode?: number };

export interface CodexBackend {
  run(request: CodexRunRequest): AsyncIterable<CodexRunEvent>;
  interrupt(bindingId: number): Promise<boolean>;
  steer?(bindingId: number, prompt: string): Promise<boolean>;
  compactThread?(threadId: string): Promise<void>;
}
