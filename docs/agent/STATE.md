# Agent State

## Current Runtime

- Service: `codex-cli-over-telegram`
- Workspace: `/home/gnu/codex-cli-over-telegram`
- Backend: Codex app-server by default
- Telegram topic bindings and run state are stored in `data/state.sqlite`.
- Dynamic Telegram chat/user allowlists are stored under `data/` and complement the static environment allowlists.

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
