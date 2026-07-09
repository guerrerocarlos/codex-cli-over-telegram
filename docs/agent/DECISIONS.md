# Agent Decisions

## 2026-07-08: Quiet Run-Start Feedback

Normal Telegram prompts should not produce a verbose start dialog with repo, model, plan mode, and sandbox mode.

The runtime now uses Telegram-native feedback for immediate acknowledgement:

- Send a typing chat action when a non-queued run is accepted.
- Keep the existing silent pin of the originating message when the worker starts.
- Keep the explicit queued message when a run is behind another active or queued run.

This keeps topic history focused on user prompts, command/tool output, and final answers while still showing that the bot received the prompt.

## 2026-07-09: Send One Assistant Prose Reply Per Turn

Telegram should not forward every `agent_message` event as its own message. App-server can emit multiple assistant message items during a single turn, and forwarding each one creates many short Telegram bubbles and increases rate-limit pressure.

Keep the latest assistant prose in memory and send the final assistant response once when the turn completes. Tool/command/file-change messages may still be sent separately because they are operational progress, not prose chunks.

## 2026-07-08: InglesConLiza Service Group Scope

The `CODEX INGLESCONLIZA.COM` Telegram group should contain only InglesConLiza.com service repos and direct service dependencies.

Use the current app/API/admin/auth/sync/drive/templates/mailer/media/meet/support/worker/public-blog surface. Do not add deprecated repos, experiments, empty placeholders, or generic marketing/content workspaces unless the scope changes explicitly.
