#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { Storage } from "./storage.js";
import { CodexAppServerBackend } from "./codexAppServer.js";
import { CodexExecBackend } from "./codexExec.js";
import { ClaudeAcpBackend, GrokAcpBackend } from "./grokAcp.js";
import { ProviderRouterBackend } from "./providerRouter.js";
import { RunQueue } from "./runQueue.js";
import { createTelegramBot, handleTelegramBridgeRequest, telegramCommandMenu } from "./telegram.js";
import { startHealthServer } from "./health.js";
import { logger } from "./logger.js";
import { CronScheduler } from "./cronScheduler.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const storage = new Storage(config.databasePath);
  const interruptedRuns = storage.prepareInterruptedRunsForResume();
  const queue = new RunQueue(config.maxParallelRuns);
  const openaiBackend =
    config.codexBackend === "app-server"
      ? new CodexAppServerBackend(config)
      : new CodexExecBackend(config);
  const codex = new ProviderRouterBackend(openaiBackend, new GrokAcpBackend(config), new ClaudeAcpBackend(config));
  const healthServer = startHealthServer(config, async (request) =>
    handleTelegramBridgeRequest({
      storage,
      bot,
      config,
      codex,
      queue,
      request,
    }),
  );
  const bot = createTelegramBot(config, storage, codex, { recoverRuns: interruptedRuns, queue });
  const cronScheduler = new CronScheduler({ storage, bot, config, codex, queue });

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    cronScheduler.stop();
    healthServer.close();
    await bot.stop();
    storage.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await bot.init();
  try {
    const commands = telegramCommandMenu();
    await bot.api.setMyCommands(commands);
    logger.info("telegram bot commands updated", { count: commands.length });
  } catch (error) {
    logger.warn("failed to update telegram bot commands", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  logger.info("telegram bot starting", {
    botUsername: bot.botInfo.username,
    databasePath: config.databasePath,
    codexBackend: config.codexBackend,
    defaultSandboxMode: config.defaultSandboxMode,
    alwaysYoloMode: config.alwaysYoloMode,
  });
  cronScheduler.start();
  await bot.start({
    drop_pending_updates: true,
    onStart: (info) => {
      logger.info("telegram bot started", { botUsername: info.username });
    },
  });
}

main().catch((error) => {
  logger.error("fatal startup error", {
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
  process.exit(1);
});
