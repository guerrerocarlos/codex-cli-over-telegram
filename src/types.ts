export type SandboxMode = "read-only" | "workspace-write";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "stopped";

export interface TopicBinding {
  id: number;
  chatId: number;
  messageThreadId: number;
  topicName: string | null;
  repoPath: string;
  codexThreadId: string | null;
  sandboxMode: SandboxMode;
  approvalPolicy: "never";
  status: string;
  createdByUserId: number;
  createdAt: string;
  updatedAt: string;
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

export interface CodexRunRequest {
  bindingId: number;
  repoPath: string;
  prompt: string;
  codexThreadId: string | null;
  sandboxMode: SandboxMode;
  approvalPolicy: "never";
}

export type CodexRunEvent =
  | { type: "started"; threadId?: string; text?: string }
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
}
