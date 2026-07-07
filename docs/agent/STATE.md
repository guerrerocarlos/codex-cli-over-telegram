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
