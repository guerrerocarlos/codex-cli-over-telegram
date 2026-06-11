import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

async function git(repoPath: string, args: string[], timeout = 30_000): Promise<CommandResult> {
  const result = await execFileAsync("git", args, {
    cwd: repoPath,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    stdout: result.stdout.trimEnd(),
    stderr: result.stderr.trimEnd(),
  };
}

export async function isGitRepository(repoPath: string): Promise<boolean> {
  try {
    const result = await git(repoPath, ["rev-parse", "--is-inside-work-tree"]);
    return result.stdout === "true";
  } catch {
    return false;
  }
}

export async function currentBranch(repoPath: string): Promise<string> {
  const result = await git(repoPath, ["branch", "--show-current"]);
  return result.stdout || "(detached)";
}

export async function statusShort(repoPath: string): Promise<string> {
  const result = await git(repoPath, ["status", "--short"]);
  return result.stdout || "clean";
}

export async function diffSummary(repoPath: string): Promise<string> {
  const [stat, shortstat] = await Promise.all([
    git(repoPath, ["diff", "--stat"]),
    git(repoPath, ["diff", "--shortstat"]),
  ]);
  const parts = [stat.stdout, shortstat.stdout].filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : "No unstaged diff.";
}

export async function fullDiff(repoPath: string): Promise<string> {
  const result = await git(repoPath, ["diff", "--binary"], 60_000);
  return result.stdout;
}

export async function commitAll(repoPath: string, message: string): Promise<string> {
  const before = await statusShort(repoPath);
  if (before === "clean") {
    return "No changes to commit.";
  }

  await git(repoPath, ["add", "-A", "--", "."]);
  const commit = await git(repoPath, ["commit", "-m", message], 120_000);
  const hash = await git(repoPath, ["rev-parse", "HEAD"]);
  return `${commit.stdout}\n\nCommit: ${hash.stdout}`.trim();
}

export async function pushHead(repoPath: string): Promise<string> {
  const result = await git(repoPath, ["push", "origin", "HEAD"], 120_000);
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim() || "Pushed HEAD to origin.";
}
