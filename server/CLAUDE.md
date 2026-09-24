# Kifaa Server — Backend API

## Framework & Runtime
- FastAPI (Python 3.11), uvicorn, SQLAlchemy (async), Celery
- Code lives at `/opt/kifaa/server/api/`
- Volume-mounted into container — changes apply on next request (no rebuild needed)
- Restart to pick up structural changes: `docker compose restart api`

## Router Files
| File | Prefix | Purpose |
|------|--------|---------|
| agents.py | /api/v1/agents | Agent heartbeat, patch scan/apply, RDP sessions, commands |
| patches.py | /api/v1/patches | Patch listing, CVE matching, WinRM apply |
| monitoring.py | /api/v1/service-monitor | Monitor checks, alert firing |
| settings.py | /api/v1/settings | Backup, system settings |
| bot_config.py | /api/v1/bot | Bot internal endpoints (verify-user, AD commands, patch summary) |
| quarterly.py | /api/v1/quarterly | Quarterly XLSX report (12 sheets) |
| rdp_report.py | /api/v1/rdp-report | RDP session XLSX report |
| agent_deploy.py | /api/v1/agent-deploy | Agent deploy/remove via SMB/SSH WebSocket |
| integration_proxmox.py | /api/v1/integrations/proxmox | Proxmox VM sync |
| integration_vmware.py | /api/v1/integrations/vmware | VMware ESXi sync |
| terminal.py | /api/v1/terminal | SSH web terminal + RDP file download |
| compliance.py | /api/v1/compliance | Compliance scoring |
| auth.py | /api/v1/auth | Login, token refresh |

## Database Access Pattern
```python
from api.database import get_db
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

@router.get("/something")
async def endpoint(db: AsyncSession = Depends(get_db)):
    rows = await db.execute(text("SELECT ..."), {"param": value})
    return rows.fetchall()
```

## Auth Dependencies
```python
from api.services.auth import get_current_user, require_admin
from api.routers.agents import get_current_agent

# User auth (JWT)
user = Depends(get_current_user)
# Admin only
user = Depends(require_admin)
# Agent auth (X-Agent-API-Key header)
agent = Depends(get_current_agent)
```

## Celery Tasks (workers/tasks.py)
- `sync_vmware` — VMware sync (soft_time_limit=180, time_limit=240)
- `sync_proxmox` — Proxmox sync (soft_time_limit=120, time_limit=180)
- `run_database_backup` — pg_dump (scheduled daily 2am)
- `prune_old_backups` — tiered retention (scheduled 3:30am)
- `mark_offline_agents` — marks agents offline after 5min no heartbeat

## Celery Beat Schedule (workers/celery_app.py)
- daily-backup: crontab(minute=0, hour=2)
- prune-backups: crontab(minute=30, hour=3)

## Key Models (models/models.py)
- `Agent` — endpoint agents (id, hostname, ip_address, status, last_seen, api_key)
- `User` — dashboard users (username, hashed_password, role)
- `Alert` — security alerts
- `PatchJob` — patch apply jobs (status: pending/running/success/failed)
- `RDPSession` — remote desktop sessions

## Important SQL Tables (init.sql)
```sql
agents, users, alerts, alert_rules
patch_jobs, agent_patches
rdp_sessions          -- RDP session data from Windows agents
monitoring_targets, monitoring_results
ad_configs, ad_action_log
metrics               -- TimescaleDB hypertable (90d retention → changed to 30d)
events, siem_events
```

## Backup Location
- `/opt/kifaa/data/backups/` — pg_dump files
- Retention: last 24h all, 1/day for 7 days, 1/week for 30 days, max 14 files
