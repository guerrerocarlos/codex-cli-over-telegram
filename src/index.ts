import { loadConfig } from "./config.js";
import { Storage } from "./storage.js";
import { CodexExecBackend } from "./codexExec.js";
import { createTelegramBot } from "./telegram.js";
import { startHealthServer } from "./health.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const storage = new Storage(config.databasePath);
  storage.resetInterruptedRuns();

  const healthServer = startHealthServer(config);
  const codex = new CodexExecBackend(config.codexBin);
  const bot = createTelegramBot(config, storage, codex);

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    healthServer.close();
    await bot.stop();
    storage.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await bot.init();
  logger.info("telegram bot starting", {
    botUsername: bot.botInfo.username,
    databasePath: config.databasePath,
    defaultSandboxMode: config.defaultSandboxMode,
  });
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
