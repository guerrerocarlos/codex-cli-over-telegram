import http from "node:http";
import type { AppConfig } from "./config.js";
import { logger } from "./logger.js";

export function startHealthServer(config: AppConfig): http.Server {
  const server = http.createServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "not found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        service: "telegram-codex-wrapper",
        branch: config.deployBranch,
        commitHash: config.deployCommitHash,
        deployedAt: config.deployedAt,
      }),
    );
  });

  server.listen(config.healthPort, config.healthHost, () => {
    logger.info("health server listening", {
      host: config.healthHost,
      port: config.healthPort,
    });
  });

  return server;
}
