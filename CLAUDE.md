# Kifaa Platform — Claude Code Context

## Project Overview
Kifaa is a self-hosted IT security management platform. It manages Windows/Linux endpoints via lightweight Go agents, provides patch management, compliance scoring, AD integration, monitoring, and reporting.

## Infrastructure
- **Current server:** 192.168.0.7 (production)
- **New server:** 192.168.0.64 (user: mtunzi, password: Onesha@123!)
- **Domain:** kifaa.kenyanut.com
- **Install path:** /opt/kifaa

## Stack
| Component | Technology | Container |
|-----------|------------|-----------|
| Backend API | FastAPI (Python 3.11) | kifaa-api |
| Task queue | Celery + Redis | kifaa-worker, kifaa-beat |
| Database | TimescaleDB (PostgreSQL 16) | kifaa-db |
| Frontend | React + Vite + Tailwind | kifaa-frontend |
| Reverse proxy | Nginx | kifaa-nginx |
| Bot | Python (Telegram + Teams + WhatsApp) | kifaa-bot |
| RDP proxy | Apache Guacamole | kifaa-guacd |
| WhatsApp bridge | whatsapp-web.js | kifaa-whatsapp |
| Mail relay | Postfix | kifaa-mailrelay |
| Agents | Go 1.22 (cross-compiled) | — runs on endpoints |

## Directory Structure
```
/opt/kifaa/
├── agent/
│   ├── builds/          ← compiled agent binaries (mounted into kifaa-api)
│   └── modern/          ← Go agent source code
│       ├── cmd/kifaa-agent/main.go
│       └── internal/
│           ├── collector/   ← data collectors (patches, RDP, security, etc.)
│           └── reporter/    ← HTTP client that posts data to server
├── bot/
│   └── app/
│       ├── commands.py      ← all bot command logic
│       ├── platforms/telegram.py
│       └── kifaa_client.py  ← HTTP client to Kifaa API
├── frontend/
│   └── src/
│       ├── pages/       ← React page components
│       ├── components/  ← shared components (Layout.jsx has sidebar nav)
│       └── api/client.js
├── server/
│   └── api/
│       ├── main.py      ← FastAPI app + router registration
│       ├── config.py    ← Settings (pydantic)
│       ├── database.py
│       ├── models/models.py
│       ├── routers/     ← API route handlers
│       ├── services/    ← auth, external API clients
│       ├── workers/     ← Celery tasks and scheduler
│       └── sql/init.sql ← DB schema (all tables)
├── nginx/conf.d/kifaa.conf
├── secrets/             ← Docker secrets (chmod 700, files 600)
├── ssl/                 ← TLS certificates
├── data/                ← persistent volumes (postgres, redis, backups)
├── .env                 ← non-secret config
├── docker-compose.yml
├── setup.sh             ← fresh server setup script
└── sync-to-server.sh    ← rsync + run setup on new server
```

## Key Development Rules

### Server code changes take effect immediately
- `server/` is volume-mounted into kifaa-api, kifaa-worker, kifaa-beat
- Python changes: NO restart needed for most changes (uvicorn auto-reloads in dev; in prod restart api)
- To restart: `docker compose restart api worker beat`

### Bot container requires rebuild
- `bot/` code is baked into the image at build time (no volume mount)
- After editing bot code: `docker compose build kifaa-bot && docker compose up -d kifaa-bot`

### Frontend requires build
- After editing frontend: `cd frontend && npm run build`
- The built `dist/` is mounted into nginx — no container restart needed

### Agent binaries require recompile
- After editing Go agent code:
  ```bash
  cd /opt/kifaa/agent/modern
  GOOS=windows GOARCH=amd64 go build -o ../builds/kifaa-agent-windows-amd64.exe ./cmd/kifaa-agent/
  GOOS=linux   GOARCH=amd64 go build -o ../builds/kifaa-agent-linux-amd64       ./cmd/kifaa-agent/
  ```
- New binary is immediately available to agents (served via nginx /downloads/)

### Adding a new API endpoint
1. Create or edit file in `server/api/routers/`
2. Register router in `server/api/main.py` (import + `app.include_router(...)`)
3. If new DB table needed, add to `server/sql/init.sql` AND run the CREATE TABLE manually on the running DB

### Adding a new frontend page
1. Create `frontend/src/pages/NewPage.jsx`
2. Import and add route in `frontend/src/App.jsx`
3. Add nav link in `frontend/src/components/Layout.jsx`
4. Run `npm run build`

### Adding a new agent data collector (Go)
1. Create `agent/modern/internal/collector/feature_windows.go` (build tag `//go:build windows`)
2. Create `agent/modern/internal/collector/feature_others.go` (build tag `//go:build !windows`) with stub
3. Add reporter method to `agent/modern/internal/reporter/reporter.go`
4. Wire into `sendInventory()` in `agent/modern/cmd/kifaa-agent/main.go`
5. Create API endpoint to receive the data
6. Rebuild agent binaries

## Secrets (stored in /opt/kifaa/secrets/)
| File | Purpose |
|------|---------|
| postgres_password | DB password |
| api_secret_key | JWT signing key |
| agent_registration_secret | Agent install token |
| fernet_key | Credential encryption (Fernet) |
| bot_secret | Bot API auth header (X-Bot-Secret) |
| telegram_token | Telegram bot token |
| teams_hmac_secret | Teams webhook HMAC |
| whatsapp_bridge_secret | WhatsApp bridge auth |
| wa_admin_token | WhatsApp admin token |

## Database
- Container: `kifaa-db` (TimescaleDB / PostgreSQL 16)
- Database: `kifaa`, User: `kifaa`
- Connect: `docker exec kifaa-db psql -U kifaa -d kifaa`
- Schema: `/opt/kifaa/server/sql/init.sql`
- Time-series tables (hypertables): `metrics`, `service_status_log`, `uptime_checks`, `events`

## Auth Patterns
- **Frontend → API:** JWT Bearer token (`Authorization: Bearer <token>`)
- **Agent → API:** API key header (`X-Agent-API-Key: <key>`)
- **Bot → API:** Bot secret header (`X-Bot-Secret: <secret>`)
- FastAPI dependencies: `get_current_user` (JWT), `get_current_agent` (agent key), `require_admin`

## Common Operations
```bash
# View logs
docker compose logs -f api
docker compose logs -f kifaa-bot
docker compose logs -f worker

# Restart services
docker compose restart api worker beat
docker compose restart kifaa-bot

# DB shell
docker exec -it kifaa-db psql -U kifaa -d kifaa

# Run Celery task manually
docker exec kifaa-worker celery -A api.workers.celery_app call api.workers.tasks.sync_proxmox

# Purge stuck task queue
docker exec kifaa-redis redis-cli -n 1 FLUSHDB

# Check active Celery tasks
docker exec kifaa-worker celery -A api.workers.celery_app inspect active
```

## Known Issues & Fixes Applied
- **Proxmox auth:** Auto-appends `@pam` if username has no `@`
- **VMware sync timeout:** `connectionPoolTimeout=30` added to SmartConnect
- **Monitor duplicate alerts:** Use `scalars().first()` not `scalar_one_or_none()`
- **Celery worker exhaustion:** VMware/Proxmox tasks have `soft_time_limit=180, time_limit=240`
- **Windows agent TLS:** `insecure_skip_verify: true` needed with self-signed cert
- **Bot secrets:** docker-entrypoint.sh reads `/run/secrets/` before starting bot
- **Patch result code -1:** "No pending update found" treated as success (not error)
