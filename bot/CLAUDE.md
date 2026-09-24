# Kifaa Bot — Messaging Bot

## Overview
Python bot supporting Telegram, Microsoft Teams, and WhatsApp. All commands route through `app/commands.py`. The bot talks to the Kifaa API via `app/kifaa_client.py` using the `X-Bot-Secret` header.

## IMPORTANT: Bot requires image rebuild
The bot code is baked into the Docker image (no volume mount).
After any code change:
```bash
docker compose build kifaa-bot && docker compose up -d kifaa-bot
```

## Secrets Loading
`docker-entrypoint.sh` reads Docker secrets from `/run/secrets/` and exports:
- `TELEGRAM_TOKEN` → from `/run/secrets/telegram_token`
- `BOT_SECRET` → from `/run/secrets/bot_secret`
- `TEAMS_HMAC_SECRET` → from `/run/secrets/teams_hmac_secret`

## Key Files
| File | Purpose |
|------|---------|
| app/commands.py | All command processing logic |
| app/kifaa_client.py | HTTP client to Kifaa API (/api/v1/bot/internal/) |
| app/platforms/telegram.py | Telegram polling, inline keyboard menu |
| app/platforms/teams.py | Teams webhook handler |
| app/config.py | Settings (reads env vars) |
| app/main.py | App entrypoint, starts all platforms |

## Telegram Bot Structure
- `/start` and `/menu` → show welcome + MAIN_MENU inline keyboard
- Inline buttons: Agents, Alerts, Compliance, Patch Status, AD Unlock, Reset PW, Patch Scan, Restart, Help
- Guide buttons show usage instructions for destructive commands
- After info commands, menu is shown again for easy navigation
- Polling loop with exponential backoff retry (5s → 60s max)

## Command Flow (commands.py)
1. `process(platform, platform_id, text)` — entry point
2. Checks auth (PIN via `verify_user` or session via `check_user`)
3. Parses command name + args
4. Destructive commands (restart, patchscan, unlock, resetpassword) → require CONFIRM
5. Calls appropriate `kifaa_client` function
6. Returns formatted reply string

## Bot API Endpoints (bot_config.py)
All under `/api/v1/bot/internal/`:
- `POST /verify-user` — authenticate with PIN
- `GET /check-user` — check active session
- `GET /agents` — list online agents
- `GET /alerts` — active alerts
- `GET /compliance` — compliance score
- `GET /patch-summary` — patch compliance stats
- `POST /command/restart` — queue agent restart
- `POST /command/patch-scan` — queue patch scan
- `POST /command/unlock-user` — queue AD account unlock
- `POST /command/reset-password` — queue AD password reset
- `GET /command/ad-action-status/{action_id}` — poll AD action

## Auth Flow
Users must run `auth <PIN>` first. The PIN is stored in the Kifaa user record. Sessions stored in Redis (30min TTL).
