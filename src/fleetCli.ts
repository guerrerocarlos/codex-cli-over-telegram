#!/usr/bin/env node
import path from "node:path";
import { backupFleetState, exportFleetSnapshot, restoreFleet } from "./fleetSnapshot.js";

interface ParsedArgs {
  command: string;
  flags: Map<string, string | boolean>;
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!command || flags.has("help")) {
    printHelp();
    return;
  }

  if (command === "export") {
    const outPath = requiredFlag(flags, "out");
    const manifestPath = optionalStringFlag(flags, "manifest");
    await exportFleetSnapshot({
      databasePath: stringFlag(flags, "database", defaultDatabasePath()),
      ...(manifestPath ? { manifestPath } : {}),
      outPath,
      recentRuns: numberFlag(flags, "recent-runs", 5),
    });
    process.stdout.write(`Exported fleet snapshot to ${outPath}\n`);
    return;
  }

  if (command === "restore") {
    const botToken = optionalStringFlag(flags, "bot-token");
    await restoreFleet({
      databasePath: stringFlag(flags, "database", defaultDatabasePath()),
      manifestPath: requiredFlag(flags, "manifest"),
      cloneRepos: flags.has("clone"),
      createTopics: flags.has("create-topics"),
      dryRun: flags.has("dry-run"),
      ...(botToken ? { botToken } : {}),
    });
    return;
  }

  if (command === "backup") {
    const managerRepoPath = requiredFlag(flags, "manager-repo");
    const manifestPath = stringFlag(flags, "manifest", path.join(managerRepoPath, "fleet.json"));
    const latestPath = await backupFleetState({
      databasePath: stringFlag(flags, "database", defaultDatabasePath()),
      managerRepoPath,
      manifestPath,
      recentRuns: numberFlag(flags, "recent-runs", 5),
      commit: !flags.has("no-commit"),
      push: flags.has("push"),
    });
    process.stdout.write(`Backed up fleet state to ${latestPath}\n`);
    return;
  }

  throw new Error(`Unknown fleet command: ${command}`);
}

function parseArgs(args: string[]): ParsedArgs {
  const [command = "", ...rest] = args;
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags.set(key, true);
      continue;
    }
    flags.set(key, next);
    index += 1;
  }
  return { command, flags };
}

function requiredFlag(flags: Map<string, string | boolean>, name: string): string {
  const value = optionalStringFlag(flags, name);
  if (!value) {
    throw new Error(`Missing required --${name}.`);
  }
  return value;
}

function stringFlag(flags: Map<string, string | boolean>, name: string, fallback: string): string {
  return optionalStringFlag(flags, name) ?? fallback;
}

function optionalStringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberFlag(flags: Map<string, string | boolean>, name: string, fallback: number): number {
  const value = optionalStringFlag(flags, name);
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer.`);
  }
  return parsed;
}

function defaultDatabasePath(): string {
  return path.resolve(process.env.DATABASE_PATH ?? "./data/state.sqlite");
}

function printHelp(): void {
  process.stdout.write(`Fleet portability commands:

  fleet export --out <snapshot.json> [--manifest <fleet.json>] [--database <state.sqlite>]
  fleet restore --manifest <fleet.json> [--database <state.sqlite>] [--clone] [--create-topics] [--dry-run]
  fleet backup --manager-repo <path> [--manifest <fleet.json>] [--database <state.sqlite>] [--recent-runs <n>] [--push] [--no-commit]

Notes:
  - export writes sanitized Telegram/Codex binding state to JSON.
  - restore clones missing repos only with --clone and creates Telegram topics only with --create-topics.
  - codexThreadId is exported as soft state; repo-owned docs/agent context is the durable recovery path.
`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
