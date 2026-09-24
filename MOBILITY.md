# Kifaa Mobility — Messaging Bot Integration

Telegram, WhatsApp (free), and Microsoft Teams bots for remote RMM operations.

---

## What Was Built

### New Containers

| Container | Tech | Purpose |
|---|---|---|
| `kifaa-bot` | Python 3.11 + FastAPI | Telegram polling, Teams webhook receiver, WhatsApp inbound handler, command processor |
| `kifaa-whatsapp` | Node.js 20 + whatsapp-web.js | Free WhatsApp bridge via browser automation. QR setup, message send/receive |

### New Server Endpoints (`/api/v1/bot/`)

| Method | Path | Description |
|---|---|---|
| GET | `/bot/status` | Platform connection status |
| POST | `/bot/users` | Add a whitelisted bot user |
| GET | `/bot/users` | List all bot users |
| PUT | `/bot/users/{id}` | Update user (name, active, PIN) |
| DELETE | `/bot/users/{id}` | Remove user |
| POST | `/bot/users/{id}/reset-pin` | Reset PIN, force re-auth |
| GET | `/bot/audit-log` | Command audit log |
| GET | `/bot/whatsapp/qr` | Get WhatsApp QR code (proxied from bridge) |
| POST | `/bot/whatsapp/logout` | Disconnect WhatsApp session |
| POST | `/bot/internal/verify-user` | PIN auth (bot → API, X-Bot-Secret) |
| GET | `/bot/internal/check-user` | Whitelist check (bot → API) |
| POST | `/bot/internal/audit` | Write audit entry (bot → API) |
| GET | `/bot/internal/agents` | Agent list/search (bot → API) |
| GET | `/bot/internal/alerts` | Active alerts (bot → API) |
| GET | `/bot/internal/compliance` | Compliance scores (bot → API) |
| GET | `/bot/internal/patches/{agent_id}` | Pending patches (bot → API) |
| POST | `/bot/internal/command/restart` | Queue restart command |
| POST | `/bot/internal/command/patch-scan` | Queue patch scan |
| POST | `/bot/internal/command/service-control` | Queue service start/stop/restart |
| POST | `/bot/internal/command/unlock-user` | Queue AD user unlock |

### New DB Tables

```sql
-- Whitelisted bot users (all platforms)
bot_users (id, platform, platform_id, display_name, hashed_pin, is_active, created_at, updated_at)
UNIQUE(platform, platform_id)

-- Command audit trail
bot_audit_log (id, ts, platform, platform_id, display_name, command, parsed_command, agent_id, result, detail)
```

Session data, rate limits, and pending confirmations are stored in **Redis DB 3** (not PostgreSQL) with TTLs.

### New Frontend Page

**Bot & Messaging** (`/bot-config`) — accessible from the Admin section of the sidebar.

Tabs:
- **Status** — platform connection badges, WhatsApp QR scanner widget, Teams webhook URL to copy
- **Users** — add/remove/disable users per platform, reset PINs
- **Audit Log** — paginated command history with platform/user/result
- **Setup Guide** — step-by-step instructions for each platform

### Files Created

```
/opt/kifaa/bot/
  Dockerfile
  requirements.txt
  app/
    main.py          — FastAPI app + Telegram polling lifecycle
    config.py        — Pydantic settings from .env
    security.py      — Sessions, rate limiting, PIN failures, Teams HMAC
    commands.py      — Platform-agnostic command parser and dispatcher
    kifaa_client.py  — HTTP client to /api/v1/bot/internal/* endpoints
    platforms/
      telegram.py    — python-telegram-bot polling handler
      teams.py       — Teams outgoing webhook FastAPI router
      whatsapp.py    — WhatsApp inbound webhook + reply sender

/opt/kifaa/whatsapp/
  Dockerfile
  package.json
  src/
    index.js         — Express app: QR endpoint, /send API, inbound message handler

/opt/kifaa/server/api/routers/bot_config.py   — all bot API endpoints
/opt/kifaa/frontend/src/pages/BotConfig.jsx   — Bot & Messaging UI page
```

### Files Modified

```
/opt/kifaa/server/api/config.py       — added bot_secret, telegram_token, teams_hmac_secret, whatsapp_bridge_secret, wa_admin_token
/opt/kifaa/server/api/main.py         — registered bot_config router, added _ensure_bot_tables to lifespan
/opt/kifaa/frontend/src/App.jsx       — added BotConfig import and /bot-config route
/opt/kifaa/frontend/src/components/Layout.jsx  — added Bot icon + "Bot & Messaging" nav item
/opt/kifaa/nginx/conf.d/kifaa.conf    — added /bot/ location block → kifaa-bot:8001
/opt/kifaa/docker-compose.yml         — added kifaa-bot and kifaa-whatsapp services
/opt/kifaa/.env                       — added bot env var placeholders (empty, need filling)
```

---

## Commands Available on All Platforms

```
auth <PIN>                              Authenticate. Required before any other command.
                                        Session lasts 4 hours. Inactivity resets the timer.

logout                                  End your session immediately.

help                                    Show all commands.

agents [online|all]                     List agents filtered by status. Default: online only.

agent <hostname_fragment>               Show details for one agent (status, IP, OS, last seen).

alerts [critical|warning|all]          Show open alerts filtered by severity.

compliance                              Show overall and per-category compliance scores.

patches <hostname_fragment>             List pending patches for an agent (security first).

patchscan <hostname_fragment>           Queue a patch scan on the agent.

restart <hostname_fragment>             Restart the endpoint.         [CONFIRM required]

unlock <agent_fragment> <ad_username>   Unlock an AD user account.    [CONFIRM required]

service <agent_fragment> <svc_name> start|stop|restart
                                        Control a Windows/Linux service. [CONFIRM required]

CONFIRM                                 Confirm a pending destructive action (60s window).

CANCEL                                  Cancel a pending confirmation.
```

**Hostname matching**: partial match against hostname and display name. If multiple agents match, the bot lists them and asks you to be more specific. Never auto-selects when ambiguous.

---

## Security Model

| Layer | Detail |
|---|---|
| Whitelist | Only users registered in Kifaa's Bot & Messaging page can send commands. Everyone else gets "You are not authorized." |
| PIN auth | Each user has a bcrypt-hashed PIN (min 4 chars). Must send `auth <PIN>` before any command. |
| Session TTL | Sessions expire after 4 hours of inactivity (Redis TTL, resets on each command). |
| Brute-force lockout | 5 wrong PIN attempts within 10 minutes locks the user. Admin must reset in the UI. |
| CONFIRM gate | Restart, unlock, and service commands require typing `CONFIRM` within 60 seconds. Redis TTL enforces the deadline. |
| Rate limiting | 5 commands per minute per user. Counter resets after 60s. |
| Teams HMAC | Every Teams POST is verified with SHA256 HMAC using the webhook secret. Requests without a valid signature are rejected with HTTP 401. |
| Bridge secrets | WhatsApp bridge and bot service share a Bearer token. The bridge's /send and /qr endpoints are not exposed via nginx — only reachable through the internal Docker network or via the Kifaa API proxy. |
| Audit log | Every command (including denied and rate-limited ones) is logged to `bot_audit_log` with platform, user, raw command, parsed command, result, and affected agent. |
| No sensitive data | The bot never echoes passwords, API keys, or stack traces. Errors return generic messages. |

---

## Setup Instructions

### Step 1 — Generate Secrets

Run these on the Kifaa server and fill in `/opt/kifaa/.env`:

```bash
echo "BOT_SECRET=$(openssl rand -hex 32)"
echo "WHATSAPP_BRIDGE_SECRET=$(openssl rand -hex 32)"
echo "WA_ADMIN_TOKEN=$(openssl rand -hex 32)"
```

Edit `.env`:

```env
BOT_SECRET=<paste openssl output>
WHATSAPP_BRIDGE_SECRET=<paste openssl output>
WA_ADMIN_TOKEN=<paste openssl output>
TELEGRAM_TOKEN=          # fill in after Step 2
TEAMS_HMAC_SECRET=       # fill in after Step 4
```

---

### Step 2 — Telegram Setup

1. Open Telegram and message **@BotFather**
2. Send `/newbot` — follow the prompts (give it a name like "Kifaa Bot")
3. Copy the API token (format: `1234567890:ABCdef...`)
4. Set in `.env`:
   ```env
   TELEGRAM_TOKEN=1234567890:ABCdef...
   ```
5. Rebuild and restart:
   ```bash
   sg docker -c "docker compose up -d --build --no-deps kifaa-bot"
   ```
6. Add yourself as a bot user in **Bot & Messaging → Users** tab
   - Platform: `telegram`
   - Platform ID: your numeric Telegram user ID
   - To find your ID: message **@userinfobot** in Telegram
7. Start a private chat with your new bot and send: `auth <your_pin>`

---

### Step 3 — WhatsApp Setup (Free)

WhatsApp-web.js automates WhatsApp Web in a headless browser. It is free but unofficial.
**Use a dedicated phone number** — not your personal or main business WhatsApp.

1. Get a SIM card or virtual number for the bot
2. Install WhatsApp on that phone and register the number
3. In Kifaa, go to **Bot & Messaging → Status** tab
4. Click **Show QR Code** — a QR image will appear (auto-refreshes every 3s)
5. On the dedicated phone: **WhatsApp → Linked Devices → Link a Device**
6. Scan the QR code shown in Kifaa
7. Status badge will change to **ready** — the bot is live
8. Add allowed users in the Users tab:
   - Platform: `whatsapp`
   - Platform ID: phone number in international format, digits only (e.g. `254712345678`)
9. The allowed user sends a WhatsApp message to the bot number: `auth <pin>`

**Session persistence**: The session is stored in `/opt/kifaa/data/whatsapp/` and survives container restarts. WhatsApp may invalidate it after a few months or if you log in on another device — re-scan the QR when that happens.

---

### Step 4 — Microsoft Teams Setup

Teams Outgoing Webhooks do not require Azure Bot Service registration — they work at channel level.

> **Important**: Teams requires HTTPS for outgoing webhooks. Enable SSL in Kifaa first (SSL Manager page).

1. In Teams, open the channel where you want the bot
2. Click **⋯** next to the channel name → **Manage channel** → **Edit**
3. In the channel settings, find **Connectors** → **Edit** → search for **Outgoing Webhook** → Configure
   - Alternatively: In the channel, click **+** (Add tab) → search for Outgoing Webhook
4. Fill in:
   - **Name**: `Kifaa Bot` (this is the @mention name)
   - **Callback URL**: copy from Kifaa **Bot & Messaging → Status** tab (format: `https://kifaa.kenyanut.com/bot/webhook/teams`)
   - **Description**: optional
5. Click **Create** — Teams shows a **Security Token** (base64 string)
6. Copy that token and set in `.env`:
   ```env
   TEAMS_HMAC_SECRET=<paste the security token from Teams>
   ```
7. Rebuild:
   ```bash
   sg docker -c "docker compose up -d --build --no-deps kifaa-bot"
   ```
8. Add allowed users in the Users tab:
   - Platform: `teams`
   - Platform ID: the user's **Azure AD Object ID** (aadObjectId)
   - To find it: Azure Portal → Users → select user → Object ID
   - Or use their UPN (email) as a fallback
9. In Teams, use the bot by typing `@KifaaBot auth <pin>` in the channel

---

### Step 5 — Add Users

In Kifaa: **Bot & Messaging → Users tab → Add User**

| Field | Notes |
|---|---|
| Platform | telegram / whatsapp / teams |
| Platform ID | Telegram: numeric user ID. WhatsApp: digits-only phone (254712345678). Teams: aadObjectId |
| Display Name | Friendly name shown in audit logs |
| PIN | Minimum 4 characters. Share securely (e.g. over a different channel). |

Users can be disabled without deleting (toggle the Active badge).
PIN resets force the user to re-authenticate on their next command.

---

### Step 6 — Full Rebuild (if starting fresh)

```bash
cd /opt/kifaa
sg docker -c "docker compose build api frontend kifaa-bot kifaa-whatsapp && docker compose up -d"
```

---

## Troubleshooting

### Bot not responding on Telegram
- Check `TELEGRAM_TOKEN` is set: `grep TELEGRAM_TOKEN /opt/kifaa/.env`
- Check bot logs: `sg docker -c "docker logs kifaa-bot --tail 30"`
- Ensure the bot container is running: `sg docker -c "docker ps | grep kifaa-bot"`

### WhatsApp QR not loading
- Check bridge logs: `sg docker -c "docker logs kifaa-whatsapp --tail 30"`
- Chromium may be slow to start — wait 30 seconds after container start
- If session is corrupted: `rm -rf /opt/kifaa/data/whatsapp/*` then restart container and re-scan

### Teams webhook returning 401
- The `TEAMS_HMAC_SECRET` in `.env` must match exactly the security token from Teams (case-sensitive, no extra spaces)
- Teams requires HTTPS — if running HTTP only, Teams will refuse to send requests
- Rebuild kifaa-bot after changing the secret

### "You are not authorized" on a valid user
- Check the platform_id is correct (Telegram: numeric ID, WhatsApp: digits only, no +)
- Check `is_active = true` in Bot & Messaging → Users
- Check the correct platform is selected

### Commands not executing
- Verify `BOT_SECRET` in `.env` matches between the bot container and the API
- Check API logs: `sg docker -c "docker logs kifaa-api --tail 20 | grep bot"`
- Test the internal endpoint directly:
  ```bash
  sg docker -c "docker exec kifaa-bot curl -s -H 'X-Bot-Secret: YOUR_BOT_SECRET' http://api:8000/api/v1/bot/internal/agents"
  ```

### AD unlock not working
- The agent specified must have an Active Directory configuration set up (Active Directory page in Kifaa)
- Syntax: `unlock SERVER1 jsmith` where SERVER1 is the agent with the AD config, jsmith is the SAM account name

---

## Architecture Overview

```
User (Telegram/WhatsApp/Teams)
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│  Public Internet / LAN                                    │
│                                                           │
│  Telegram: Bot polls api.telegram.org (outbound only)     │
│  WhatsApp: User → bot number → whatsapp-web.js bridge     │
│  Teams:    teams.microsoft.com → POST https://kifaa/bot/  │
└───────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────┐
│  nginx (kifaa-nginx)            │
│  /bot/ → kifaa-bot:8001         │
└─────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│  kifaa-bot (Python FastAPI + python-telegram-bot)           │
│                                                             │
│  security.py  — whitelist, PIN, session (Redis DB 3),       │
│                 rate limit, CONFIRM gate, Teams HMAC        │
│  commands.py  — parse + dispatch                           │
│  kifaa_client.py — HTTP → api:8000/api/v1/bot/internal/*   │
│                    (X-Bot-Secret auth)                      │
│                                                             │
│  ← receives inbound from kifaa-whatsapp:3000/callback       │
│  → sends outbound to kifaa-whatsapp:3000/send               │
└─────────────────────────────────────────────────────────────┘
        │ X-Bot-Secret
        ▼
┌─────────────────────────────────────────────────────────────┐
│  kifaa-api (FastAPI)                                        │
│  /api/v1/bot/internal/* endpoints                          │
│                                                             │
│  Reads: agents, alerts, compliance, patches                 │
│  Writes: agent_commands (restart/patch/scan/unlock)         │
│          bot_audit_log                                      │
└─────────────────────────────────────────────────────────────┘
        │ Redis DB 3
        ▼
┌──────────────┐
│  kifaa-redis │  bot:session:*    (4h TTL)
│              │  bot:confirm:*    (60s TTL)
│              │  bot:ratelimit:*  (60s TTL)
│              │  bot:authfail:*   (10m TTL)
└──────────────┘

┌─────────────────────────────────────────────────────────────┐
│  kifaa-whatsapp (Node.js + whatsapp-web.js + Puppeteer)     │
│                                                             │
│  GET  /qr      → returns QR PNG (admin only, WA_ADMIN_TOKEN)│
│  POST /send    → sends WA message (WHATSAPP_BRIDGE_SECRET)  │
│  POST /logout  → disconnects session (admin only)           │
│                                                             │
│  on message → POST http://kifaa-bot:8001/webhook/whatsapp   │
│  Session files persisted in /data/session (host volume)     │
└─────────────────────────────────────────────────────────────┘
```

---

## Operational Notes

- **WhatsApp is unofficial**: whatsapp-web.js automates a real WhatsApp Web session. WhatsApp may block accounts that send too many automated messages. Keep usage reasonable and use a dedicated number.
- **Teams needs HTTPS**: Microsoft will not send outgoing webhook requests to an HTTP endpoint. SSL must be enabled in Kifaa.
- **Telegram is the simplest**: No QR, no HTTPS requirement, no external account. Best starting point.
- **Session storage**: WhatsApp sessions survive container restarts (host volume). If the container is recreated and the volume is gone, re-scan the QR.
- **PIN management**: PINs are bcrypt-hashed (rounds=12). Nobody — including admins — can see the plain PIN after creation. Use the Reset PIN button to change it.
- **Agent commands are queued**: The bot inserts into `agent_commands`. The agent picks it up on its next 5-second poll. There is typically a 5–30 second delay between the bot confirming and the action executing on the endpoint.
