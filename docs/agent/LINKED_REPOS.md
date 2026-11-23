# Linked Repos

## LIFE Journal

- Telegram chat: LIFE, `-1004361900873`
- Topic: `Journal`, topic ID `5701`
- Repository: `/home/gnu/life-manager/Journal`, private GitHub repository `guerrerocarlos/journal`
- Contract: `journal.config.json` opts the binding into automatic media archival and requires `agentTrigger: "text-or-mention"`. Voice, audio, video, Telegram photos, and image documents are stored mechanically and never become agent context. Audio and video are transcribed, while images use `not_applicable` transcription status. Standalone text retains the normal agent path. A media caption starts an agent run only when it explicitly mentions the bot.
- `/home/gnu/journal-daemon` submits macOS-spooled audio to `POST /journal-daemon/v1/imports` through Tailscale HTTPS. Its explicit `chatId` and `messageThreadId` must match this binding. The private tailnet access policy and Tailscale Serve are the authorization boundary; there is no application bearer token.

## CODEX INGLESCONLIZA.COM Telegram Group

Chat id: `-1003696100403`

This group is limited to repos that are part of the InglesConLiza.com service surface or direct service dependencies.

| Topic id | Topic | Repo |
| --- | --- | --- |
| `0` | `inglesconliza-manager` | `/home/gnu/inglesconliza-manager` |
| `7` | `lovable-inglesconliza-com` | `/home/gnu/lovable-inglesconliza-com` |
| `8` | `inglesconliza-app` | `/home/gnu/inglesconliza-app` |
| `9` | `inglesconliza-api` | `/home/gnu/inglesconliza-api` |
| `10` | `inglesconliza-admin` | `/home/gnu/inglesconliza-admin` |
| `11` | `auth-inglesconliza-com` | `/home/gnu/auth-inglesconliza-com` |
| `12` | `account-inglesconliza-com` | `/home/gnu/account-inglesconliza-com` |
| `13` | `sync-inglesconliza-com` | `/home/gnu/sync-inglesconliza-com` |
| `14` | `drive-inglesconliza-com` | `/home/gnu/drive-inglesconliza-com` |
| `15` | `templates-inglesconliza-com` | `/home/gnu/templates-inglesconliza-com` |
| `16` | `mailer-inglesconliza-com` | `/home/gnu/mailer-inglesconliza-com` |
| `17` | `media-inglesconliza-com` | `/home/gnu/media-inglesconliza-com` |
| `18` | `meet-inglesconliza-com` | `/home/gnu/meet-inglesconliza-com` |
| `19` | `support-inglesconliza-com` | `/home/gnu/support-inglesconliza-com` |
| `20` | `support-api-inglesconliza-com` | `/home/gnu/support-api-inglesconliza-com` |
| `21` | `ffmpeg-inglesconliza-com` | `/home/gnu/ffmpeg-inglesconliza-com` |
| `22` | `websockets-inglesconliza-com` | `/home/gnu/websockets-inglesconliza-com` |
| `23` | `blog-inglesconliza-com` | `/home/gnu/blog-inglesconliza-com` |

Excluded from this service group on purpose:

- Deprecated or legacy checkouts: `/home/gnu/inglesconliza-support`, `/home/gnu/api.inglesconliza.com`, `/home/gnu/www.inglesconliza.com`
- Experiments and local workspaces: `icl-dashboard-*`, `/home/gnu/inglesconliza-beelink`, `/home/gnu/inglesconliza-pending`
- Non-service planning/content folders: `/home/gnu/inglesconliza-marketing`, `/home/gnu/inglesconliza-content`
