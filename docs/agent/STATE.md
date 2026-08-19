# Agent State

## Current Runtime

- Service: `codex-cli-over-telegram`
- Workspace: `/home/gnu/codex-cli-over-telegram`
- Backend: Codex app-server by default
- Health readiness requires both the local HTTP health server and Telegram long-polling startup. `/health` returns HTTP `503` with `telegramBotStarted: false` while the process is not yet receiving Telegram updates.
- Telegram topic bindings and run state are stored in `data/state.sqlite`.
- Dynamic Telegram chat/user allowlists are stored under `data/` and complement the static environment allowlists.
- Topic bindings can opt into folder restriction with `/restrict on`; restricted runs ignore global YOLO, stay within the bound folder write boundary, and do not receive the Telegram manager MCP bridge.
- App-server runs forward `MANAGER_BRIDGE_URL`, `MANAGER_BRIDGE_TOKEN`, and `MANAGER_BRIDGE_CHAT_ID` into the `telegram_manager` MCP server via `env_vars`, so bridge tools stay scoped to the current Telegram chat.
- Telegram outbound sends use bounded retries. Repeated transient send failures are logged and dropped so one failed message cannot block later bot replies forever.
- The Telegram API client forces IPv4 for Bot API requests because this host can reach `api.telegram.org` over IPv4 while IPv6 can fail, which previously left the service half-started with only `/health` listening.
- Source now treats dropped Telegram send-queue results as run-output delivery failures, so future deployments should not silently appear successful when the final reply was not accepted by Telegram. This source change was not live-deployed during the 2026-08-19 incident because authenticated Telegram Bot API calls from the host were timing out.

## 2026-08-08 W7S Topic Repair

- User attempted to bootstrap `/home/gnu/account-w7s-io` from the W7S group.
- The repo/deploy run completed, but the agent-reported topic creation failed because the `telegram_manager` MCP bridge did not receive the W7S chat id reliably.
- Live repair created and bound topic `account-w7s-io` as topic `#2208` in chat `-1004477958494`.

## 2026-07-07 Check

- Local health endpoint responded successfully on `http://127.0.0.1:8787/health`.
- Reported deployment metadata:
  - Branch: `main`
  - Commit: `4260140e23f5ab9ad0d71d91ce4391b6df9d07a2`
  - Deployed at: `2026-07-07T01:33:23Z`
- The service process was active under systemd.
- The ICL CODEX group was accepting incoming messages and creating runs.

## Known Operational Notes

- `topic_messages` currently records incoming Telegram messages used by manager tools; outbound bot replies are not stored there.
- Telegram may echo bot-authored messages as updates from the bot account, which can create noisy `unauthorized_message` audit entries for the bot user.
- The production unit is the system service `codex-cli-over-telegram.service`, not the inactive user unit with the same name.

## Telegram Groups

- `ROOT CODEX`: `-1004391890477`
- `ICL CODEX (old)`: `-1003947953517`
- `CODEX INGLESCONLIZA.COM`: `-1003696100403`

`CODEX INGLESCONLIZA.COM` was first observed as temporary group id `-5310780057`, then migrated by Telegram to forum supergroup id `-1003696100403`. Keep the supergroup id in the dynamic chat allowlist.

## 2026-07-08 Telegram Restart Loop

- Incident: the bot entered a restart loop while resuming LIFE cron run `#1095`.
- Cause: the LIFE group had migrated from chat id `-5568898498` to supergroup chat id `-1004361900873`; Telegram returned `migrate_to_chat_id`, and the send error was previously fatal.
- Recovery: cron job `#1` and current run `#1095` now point to binding `#32` / chat `-1004361900873`; stale duplicate run `#1048` was marked failed.
- Code fix: Telegram sends now retry once against Telegram's returned migrated chat id instead of crashing the process.

## 2026-07-09 Omattic Topic Correction

- `coach-omattic-com` was accidentally created in the InglesConLiza CODEX group as topic `559`.
- The accidental topic was deleted from chat `-1003696100403`.
- The correct OMATTIC CODEX topic is chat `-1003996402615`, topic `1407`, stored as binding `#101`.
- Root cause: `managerBridgeMcp` could infer `MANAGER_BRIDGE_CHAT_ID` from an arbitrary running Codex app-server process when the current tool process lacked a chat id, which is unsafe during concurrent multi-group runs.
- Guardrail: bridge tools now get their chat id only from the current run environment or the current repo path's binding, never from another running process.

## 2026-07-15 Server Restart Recovery

- Symptom: after host restart, the system unit was enabled and active, but the service repeatedly restarted during interrupted-run recovery.
- Verified systemd state: `codex-cli-over-telegram.service` was loaded from `/etc/systemd/system/codex-cli-over-telegram.service`, enabled, and active after systemd restarted it.
- Verified health before the fix: `http://127.0.0.1:8787/health` returned `branch=main`, `commitHash=475ec01eb49d214df9fcb14995dc7382afef8af2`, and `deployedAt=2026-07-13T16:52:07Z`.
- Immediate crash cause: queued cron run `#1252` for binding `#57` / topic `inglesconliza-manager` targeted chat `-1003996402615`, thread `515`; Telegram returned `400: Bad Request: message thread not found` when the restart notice was sent.
- Code fix: restart-resume notices are now best-effort, and unexpected run-queue task errors are logged instead of escaping the queue chain.
