# Agent Decisions

## 2026-07-08: Quiet Run-Start Feedback

Normal Telegram prompts should not produce a verbose start dialog with repo, model, plan mode, and sandbox mode.

The runtime now uses Telegram-native feedback for immediate acknowledgement:

- Send a typing chat action when a non-queued run is accepted.
- Keep the existing silent pin of the originating message when the worker starts.
- Keep the explicit queued message when a run is behind another active or queued run.

This keeps topic history focused on user prompts, command/tool output, and final answers while still showing that the bot received the prompt.

## 2026-07-09: Batch Small Assistant Prose Messages

Telegram should not forward every tiny `agent_message` event as its own message. App-server can emit multiple assistant message items during a single turn, and forwarding each small item creates noisy short Telegram bubbles and increases rate-limit pressure.

Keep intermediate assistant prose visible, but batch consecutive short assistant messages before sending them. Substantial assistant messages should still send immediately. Tool/command/file-change messages may still be sent separately because they are operational progress, not prose chunks.

## 2026-07-13: Pack Markdown Segments Before Sending

Long assistant messages with many inline-code spans should be split by Telegram-safe size, not by individual Markdown segments. `markdownV2Chunks()` must pack rendered text, bold, inline-code, and code-block segments into full chunks before sending. Otherwise schema-like replies can become dozens of tiny bubbles such as one table name, dash, or field name per message.

## 2026-07-08: InglesConLiza Service Group Scope

The `CODEX INGLESCONLIZA.COM` Telegram group should contain only InglesConLiza.com service repos and direct service dependencies.

Use the current app/API/admin/auth/sync/drive/templates/mailer/media/meet/support/worker/public-blog surface. Do not add deprecated repos, experiments, empty placeholders, or generic marketing/content workspaces unless the scope changes explicitly.

## 2026-08-03: Per-Topic Folder Restriction

Some Telegram topics need a hard write boundary around the bound folder even when the service is globally configured with `CODEX_ALWAYS_YOLO=true`.

Use `/restrict on` to persist `restricted_to_repo=1` on the topic binding. Restricted topics ignore global YOLO for run sandbox selection: read-only bindings stay `read-only`, and write-capable bindings run as `workspace-write` with the topic folder as the workspace. Restricted app-server runs also omit the `telegram_manager` MCP bridge, so the agent cannot indirectly queue work, create topics, or edit work items in other topics through that bridge.

Use `/restrict off` to restore the normal `/mode` plus global YOLO behavior.

## 2026-08-08: Forward Manager Bridge Env To MCP

The app-server process injects `MANAGER_BRIDGE_URL`, `MANAGER_BRIDGE_TOKEN`, and `MANAGER_BRIDGE_CHAT_ID` per run. Codex stdio MCP servers do not reliably inherit arbitrary process environment unless the server config declares `env_vars`.

The `telegram_manager` MCP config must include `env_vars = ["MANAGER_BRIDGE_URL", "MANAGER_BRIDGE_TOKEN", "MANAGER_BRIDGE_CHAT_ID"]` for each app-server run. This keeps `create_topic`, `list_topics`, and queue tools scoped to the current Telegram chat even if the agent changes directories into a newly created, not-yet-bound workspace.

## 2026-08-16: Bound Telegram Send Retries

Telegram send failures must not block the global bot send queue forever. A single `sendMessage` network failure previously retried without a limit, which could keep later messages and run completion notices stuck behind it.

Transient send failures and repeated rate limits are now bounded. When the retry limit is reached, the bot logs the chat id, topic id, error, and a short message preview, drops that outbound message, and continues processing later sends.

## 2026-08-21: Surface App Permission Requests In Topic

Codex app-server `item/permissions/requestApproval` requests should not be silently denied. Plugin permission requests, including Google Drive functionality installs, are now sent to the active bound Telegram topic with Approve and Deny inline buttons.

Approving returns the requested permission profile with `scope: "turn"`. Denying or timing out returns an empty permission profile with `scope: "turn"`. This keeps plugin permission escalation visible to the topic while avoiding persistent grants from Telegram buttons.
