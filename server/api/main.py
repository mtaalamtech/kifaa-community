from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
import asyncio
import json
import logging
import os

from api.config import get_settings
from api.database import AsyncSessionLocal
from api.routers import auth, agents, ssl, alerts, monitoring, settings, admin, deployment, report_schedules, patches, tasks, groups, reboot_schedules, ad_plugin, software, services, terminal, agent_deploy, credentials, threats, licenses, compliance, patch_schedules, quarterly, watchdog, maintenance
from sqlalchemy import text
import secrets
import string

app_settings = get_settings()
logger = logging.getLogger(__name__)


async def _ad_auto_sync_loop():
    """Background task: auto-queue ad_sync for agents whose sync interval has elapsed.
    Checks every 30 seconds; respects each agent's configured sync_interval_seconds.
    Uses ON CONFLICT DO NOTHING so multiple uvicorn workers don't create duplicates."""
    import random
    await asyncio.sleep(10 + random.uniform(0, 5))  # jitter to spread worker startup
    while True:
        try:
            async with AsyncSessionLocal() as db:
                # Find active AD configs where sync is due and agent was seen recently
                result = await db.execute(text("""
                    SELECT c.agent_id, c.dc_host, c.base_dn, c.service_account,
                           c.service_password, c.max_pwd_age_days,
                           COALESCE(c.sync_interval_seconds, 300) AS interval_secs
                    FROM ad_configs c
                    JOIN agents a ON a.id = c.agent_id
                    WHERE c.is_active = TRUE
                      AND a.status = 'online'
                      AND (
                          c.last_sync_at IS NULL
                          OR EXTRACT(EPOCH FROM (NOW() - c.last_sync_at)) >= COALESCE(c.sync_interval_seconds, 300)
                      )
                """))
                rows = result.fetchall()

                for row in rows:
                    agent_id, dc_host, base_dn, service_account, service_password, max_pwd_age, interval_secs = row
                    payload = {
                        "dc_host": dc_host or "",
                        "base_dn": base_dn or "",
                        "username": service_account or "",
                        "password": service_password or "",
                        "use_ssl": False,
                        "max_pwd_age_days": max_pwd_age or 90,
                        "event_hours": max(int(interval_secs / 3600) + 1, 2),
                    }
                    await db.execute(text("""
                        INSERT INTO agent_commands (agent_id, command_type, payload)
                        VALUES (:aid, 'ad_sync', CAST(:payload AS jsonb))
                        ON CONFLICT (agent_id, command_type) WHERE picked_up_at IS NULL DO NOTHING
                    """), {"aid": agent_id, "payload": json.dumps(payload)})
                    logger.info(f"Auto-queued ad_sync for agent {agent_id}")

                await db.commit()
        except Exception as e:
            logger.warning(f"AD auto-sync loop error: {e}")

        await asyncio.sleep(30)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure patch_schedules table exists at startup
    try:
        from api.routers.patch_schedules import _ensure_table
        await _ensure_table()
    except Exception:
        pass

    # Add Let's Encrypt columns to ssl_certificates (idempotent migration)
    try:
        from api.database import AsyncSessionLocal
        async with AsyncSessionLocal() as db:
            for col, defn in [
                ("provider",   "VARCHAR(30) DEFAULT 'manual'"),
                ("auto_renew", "BOOLEAN DEFAULT FALSE"),
                ("le_email",   "TEXT"),
                ("le_staging", "BOOLEAN DEFAULT FALSE"),
            ]:
                await db.execute(text(
                    f"ALTER TABLE ssl_certificates ADD COLUMN IF NOT EXISTS {col} {defn}"
                ))
            await db.commit()
    except Exception:
        pass

    # Configure audit log: always writes to file + optional external syslog (TASK-17)
    from api.audit_log import configure_audit_logging
    configure_audit_logging(
        log_path="/app/logs/audit.log",
        syslog_host=app_settings.syslog_host,
        syslog_port=app_settings.syslog_port,
    )

    # On first startup (no users exist), create admin with a random temporary password
    try:
        async with AsyncSessionLocal() as db:
            result = await db.execute(text("SELECT COUNT(*) FROM users"))
            count = result.scalar()
            if count == 0:
                from api.services.auth import hash_password
                alphabet = string.ascii_letters + string.digits + "!@#$%^&*()"
                temp_password = (
                    secrets.choice(string.ascii_uppercase)
                    + secrets.choice(string.digits)
                    + secrets.choice("!@#$%^&*()")
                    + "".join(secrets.choice(alphabet) for _ in range(13))
                )
                hashed = hash_password(temp_password)
                await db.execute(text(
                    "INSERT INTO users (username, email, full_name, hashed_password, role, password_must_change) "
                    "VALUES ('admin', 'admin@kifaa.local', 'System Administrator', :pw, 'admin', TRUE)"
                ), {"pw": hashed})
                await db.commit()
                logger.warning("=" * 60)
                logger.warning("KIFAA FIRST STARTUP — TEMPORARY ADMIN PASSWORD")
                logger.warning(f"Username: admin")
                logger.warning(f"Password: {temp_password}")
                logger.warning("Change this password immediately after first login!")
                logger.warning("=" * 60)
    except Exception as e:
        logger.warning(f"Admin bootstrap warning: {e}")

    task = asyncio.create_task(_ad_auto_sync_loop())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


limiter = Limiter(key_func=get_remote_address)

app = FastAPI(
    title="Kifaa Platform API",
    description="Central Endpoint Management Platform",
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

_ALLOWED_ORIGINS = [
    "https://kifaa.kenyanut.com",
    "http://kifaa.kenyanut.com",   # keep HTTP during transition; remove once HTTPS enforced
    "http://localhost:5173",        # Vite dev server
    "http://localhost:3000",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-API-Key"],
)

app.include_router(auth.router,             prefix="/api/v1")
app.include_router(agents.router,           prefix="/api/v1")
app.include_router(ssl.router,              prefix="/api/v1")
app.include_router(alerts.router,           prefix="/api/v1")
app.include_router(monitoring.router,       prefix="/api/v1")
app.include_router(settings.router,         prefix="/api/v1")
app.include_router(admin.router,            prefix="/api/v1")
app.include_router(deployment.router,       prefix="/api/v1")
app.include_router(report_schedules.router, prefix="/api/v1")
app.include_router(patches.router,          prefix="/api/v1")
app.include_router(tasks.router,            prefix="/api/v1")
app.include_router(groups.router,           prefix="/api/v1")
app.include_router(reboot_schedules.router, prefix="/api/v1")
app.include_router(ad_plugin.router,        prefix="/api/v1")
app.include_router(software.router,         prefix="/api/v1")
app.include_router(services.router,         prefix="/api/v1")
app.include_router(terminal.router,         prefix="/api/v1")
app.include_router(agent_deploy.router,     prefix="/api/v1")
app.include_router(credentials.router,      prefix="/api/v1")
app.include_router(threats.router,          prefix="/api/v1")
app.include_router(licenses.router,         prefix="/api/v1")
app.include_router(compliance.router,       prefix="/api/v1")
app.include_router(patch_schedules.router,  prefix="/api/v1")
app.include_router(quarterly.router,        prefix="/api/v1")
app.include_router(watchdog.router,         prefix="/api/v1")
app.include_router(maintenance.router,      prefix="/api/v1")

os.makedirs("/app/static/agent-builds", exist_ok=True)
os.makedirs("/app/static/deploy-packages", exist_ok=True)
app.mount("/downloads", StaticFiles(directory="/app/static/agent-builds"), name="downloads")
app.mount("/deploy-packages", StaticFiles(directory="/app/static/deploy-packages"), name="deploy-packages")


@app.get("/.well-known/acme-challenge/{token}", include_in_schema=False)
async def serve_acme_challenge(token: str):
    """Serve Let's Encrypt HTTP-01 challenge responses."""
    from fastapi.responses import PlainTextResponse
    from api.routers.ssl import _acme_challenges
    val = _acme_challenges.get(token)
    if val is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Challenge token not found")
    return PlainTextResponse(content=val)


@app.get("/api/health")
async def health():
    return {"status": "ok", "platform": "Kifaa", "edition": "community", "version": app_settings.app_version}


@app.get("/api/v1/info")
async def info():
    return {
        "platform": "Kifaa",
        "version": app_settings.app_version,
        "domain": app_settings.domain,
    }
