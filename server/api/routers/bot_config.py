"""
Bot Configuration router — manages messaging bot users, audit log, settings, and internal command endpoints.
Platforms: Telegram, WhatsApp, Microsoft Teams.
"""
import json
import logging
from typing import Optional
from datetime import datetime, timezone

import bcrypt
import httpx
from fastapi import APIRouter, Depends, HTTPException, Header
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.database import get_db
from api.services.auth import get_current_user
from api.config import get_settings
from api.routers.compliance import (
    _patch_score, _vuln_score, _config_score, _protection_score, _license_score, _overall
)

router = APIRouter(prefix="/bot", tags=["Bot"])
logger = logging.getLogger(__name__)
settings = get_settings()


# ── Table setup ────────────────────────────────────────────────────────────────

async def _ensure_bot_tables(db: AsyncSession):
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS bot_users (
            id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            platform    TEXT NOT NULL,
            platform_id TEXT NOT NULL,
            display_name TEXT,
            hashed_pin  TEXT NOT NULL,
            is_active   BOOLEAN DEFAULT TRUE,
            created_at  TIMESTAMPTZ DEFAULT NOW(),
            updated_at  TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(platform, platform_id)
        )
    """))
    await db.execute(text("CREATE INDEX IF NOT EXISTS idx_bot_users_platform ON bot_users(platform, platform_id)"))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS bot_audit_log (
            id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            ts           TIMESTAMPTZ DEFAULT NOW(),
            platform     TEXT NOT NULL,
            platform_id  TEXT NOT NULL,
            display_name TEXT,
            command      TEXT NOT NULL,
            parsed_command TEXT,
            agent_id     UUID REFERENCES agents(id) ON DELETE SET NULL,
            result       TEXT NOT NULL,
            detail       JSONB DEFAULT '{}'
        )
    """))
    await db.execute(text("CREATE INDEX IF NOT EXISTS idx_bot_audit_ts    ON bot_audit_log(ts DESC)"))
    await db.execute(text("CREATE INDEX IF NOT EXISTS idx_bot_audit_pid   ON bot_audit_log(platform, platform_id)"))
    await db.execute(text("CREATE INDEX IF NOT EXISTS idx_bot_audit_agent ON bot_audit_log(agent_id)"))
    await db.commit()


# ── Auth dependencies ──────────────────────────────────────────────────────────

async def require_bot_secret(x_bot_secret: str = Header(..., alias="X-Bot-Secret")):
    if not settings.bot_secret or x_bot_secret != settings.bot_secret:
        raise HTTPException(status_code=403, detail="Invalid bot secret")


# ── Admin endpoints ────────────────────────────────────────────────────────────

@router.get("/status")
async def bot_status(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Returns current bot integration status."""
    await _ensure_bot_tables(db)
    # Check WhatsApp bridge status
    wa_status = "unknown"
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(
                "http://kifaa-whatsapp:3000/status",
                headers={"Authorization": f"Bearer {settings.whatsapp_bridge_secret or ''}"},
            )
            if r.status_code == 200:
                wa_status = r.json().get("status", "unknown")
    except Exception:
        wa_status = "disconnected"

    return {
        "telegram_enabled": bool(settings.telegram_token),
        "whatsapp_status": wa_status,
        "teams_webhook_url": f"{settings.server_base_url or 'https://kifaa.kenyanut.com'}/bot/teams/webhook",
    }


@router.post("/users")
async def create_bot_user(body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_bot_tables(db)
    platform = body.get("platform", "").lower()
    platform_id = (body.get("platform_id") or "").strip()
    display_name = body.get("display_name", "")
    pin = body.get("pin", "")

    if platform not in ("telegram", "whatsapp", "teams"):
        raise HTTPException(400, "platform must be telegram, whatsapp, or teams")
    if not platform_id:
        raise HTTPException(400, "platform_id is required")
    if not pin or len(pin) < 4:
        raise HTTPException(400, "PIN must be at least 4 characters")

    # Normalize WhatsApp number (digits only, no +)
    if platform == "whatsapp":
        platform_id = "".join(c for c in platform_id if c.isdigit())

    hashed = bcrypt.hashpw(pin.encode(), bcrypt.gensalt(rounds=12)).decode()
    try:
        row = await db.execute(text("""
            INSERT INTO bot_users (platform, platform_id, display_name, hashed_pin)
            VALUES (:p, :pid, :dn, :hp)
            RETURNING id, platform, platform_id, display_name, is_active, created_at
        """), {"p": platform, "pid": platform_id, "dn": display_name, "hp": hashed})
        r = row.fetchone()
        await db.commit()
        return dict(zip(["id", "platform", "platform_id", "display_name", "is_active", "created_at"], r))
    except Exception:
        await db.rollback()
        raise HTTPException(409, "User with this platform + ID already exists")


@router.get("/users")
async def list_bot_users(platform: Optional[str] = None, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_bot_tables(db)
    where = "1=1"
    params = {}
    if platform:
        where = "platform = :platform"
        params["platform"] = platform
    rows = await db.execute(text(f"""
        SELECT id, platform, platform_id, display_name, is_active, created_at, updated_at
        FROM bot_users WHERE {where} ORDER BY platform, display_name
    """), params)
    cols = ["id", "platform", "platform_id", "display_name", "is_active", "created_at", "updated_at"]
    return [dict(zip(cols, r)) for r in rows.fetchall()]


@router.put("/users/{user_id}")
async def update_bot_user(user_id: str, body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_bot_tables(db)
    sets = ["updated_at = NOW()"]
    params: dict = {"id": user_id}

    if "display_name" in body:
        sets.append("display_name = :dn")
        params["dn"] = body["display_name"]
    if "is_active" in body:
        sets.append("is_active = :active")
        params["active"] = bool(body["is_active"])
    if "pin" in body:
        pin = body["pin"]
        if len(pin) < 4:
            raise HTTPException(400, "PIN must be at least 4 characters")
        hashed = bcrypt.hashpw(pin.encode(), bcrypt.gensalt(rounds=12)).decode()
        sets.append("hashed_pin = :hp")
        params["hp"] = hashed

    row = await db.execute(text(f"""
        UPDATE bot_users SET {', '.join(sets)} WHERE id = CAST(:id AS uuid)
        RETURNING id, platform, platform_id, display_name, is_active, updated_at
    """), params)
    r = row.fetchone()
    if not r:
        raise HTTPException(404, "User not found")
    await db.commit()
    return dict(zip(["id", "platform", "platform_id", "display_name", "is_active", "updated_at"], r))


@router.delete("/users/{user_id}")
async def delete_bot_user(user_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_bot_tables(db)
    await db.execute(text("DELETE FROM bot_users WHERE id = CAST(:id AS uuid)"), {"id": user_id})
    await db.commit()
    return {"status": "deleted"}


@router.post("/users/{user_id}/reset-pin")
async def reset_bot_user_pin(user_id: str, body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_bot_tables(db)
    pin = body.get("new_pin", "")
    if len(pin) < 4:
        raise HTTPException(400, "PIN must be at least 4 characters")
    hashed = bcrypt.hashpw(pin.encode(), bcrypt.gensalt(rounds=12)).decode()
    row = await db.execute(text("""
        UPDATE bot_users SET hashed_pin = :hp, updated_at = NOW()
        WHERE id = CAST(:id AS uuid)
        RETURNING platform, platform_id
    """), {"hp": hashed, "id": user_id})
    r = row.fetchone()
    if not r:
        raise HTTPException(404, "User not found")
    await db.commit()
    return {"status": "ok", "note": "User must re-authenticate on their next command"}


@router.get("/audit-log")
async def get_audit_log(
    platform: Optional[str] = None,
    platform_id: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    await _ensure_bot_tables(db)
    where = ["1=1"]
    params: dict = {"limit": limit, "offset": offset}
    if platform:
        where.append("platform = :platform")
        params["platform"] = platform
    if platform_id:
        where.append("platform_id = :platform_id")
        params["platform_id"] = platform_id

    rows = await db.execute(text(f"""
        SELECT id, ts, platform, platform_id, display_name, command, parsed_command, agent_id, result, detail
        FROM bot_audit_log
        WHERE {' AND '.join(where)}
        ORDER BY ts DESC
        LIMIT :limit OFFSET :offset
    """), params)
    cols = ["id", "ts", "platform", "platform_id", "display_name", "command", "parsed_command", "agent_id", "result", "detail"]
    return [dict(zip(cols, r)) for r in rows.fetchall()]


# ── WhatsApp QR proxy ──────────────────────────────────────────────────────────

@router.get("/whatsapp/qr")
async def whatsapp_qr(_=Depends(get_current_user)):
    """Proxy the QR code request to the WhatsApp bridge (internal Docker network only)."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(
                "http://kifaa-whatsapp:3000/qr",
                headers={"Authorization": f"Bearer {settings.wa_admin_token or ''}"},
            )
            return r.json()
    except Exception as e:
        return {"status": "disconnected", "error": str(e)}


@router.post("/whatsapp/logout")
async def whatsapp_logout(_=Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.post(
                "http://kifaa-whatsapp:3000/logout",
                headers={"Authorization": f"Bearer {settings.wa_admin_token or ''}"},
            )
            return r.json()
    except Exception as e:
        raise HTTPException(502, f"WhatsApp bridge error: {e}")


# ── Internal endpoints (called by kifaa-bot, secured by BOT_SECRET) ────────────

@router.post("/internal/verify-user")
async def verify_bot_user(body: dict, db: AsyncSession = Depends(get_db), _=Depends(require_bot_secret)):
    await _ensure_bot_tables(db)
    platform = body.get("platform", "")
    platform_id = body.get("platform_id", "")
    pin = body.get("pin", "")

    row = await db.execute(text("""
        SELECT id, display_name, hashed_pin, is_active
        FROM bot_users WHERE platform = :p AND platform_id = :pid
    """), {"p": platform, "pid": platform_id})
    r = row.fetchone()
    if not r:
        return {"authenticated": False, "reason": "not_whitelisted"}
    if not r[3]:  # is_active
        return {"authenticated": False, "reason": "inactive"}

    try:
        match = bcrypt.checkpw(pin.encode(), r[2].encode())
    except Exception:
        match = False

    if not match:
        return {"authenticated": False, "reason": "wrong_pin"}
    return {"authenticated": True, "user_id": str(r[0]), "display_name": r[1] or platform_id}


@router.get("/internal/check-user")
async def check_bot_user(
    platform: str,
    platform_id: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_bot_secret),
):
    await _ensure_bot_tables(db)
    row = await db.execute(text("""
        SELECT id, display_name, is_active FROM bot_users
        WHERE platform = :p AND platform_id = :pid
    """), {"p": platform, "pid": platform_id})
    r = row.fetchone()
    if not r:
        return {"allowed": False}
    return {"allowed": bool(r[2]), "display_name": r[1] or platform_id}


@router.post("/internal/audit")
async def write_audit(body: dict, db: AsyncSession = Depends(get_db), _=Depends(require_bot_secret)):
    await _ensure_bot_tables(db)
    agent_id = body.get("agent_id") or None
    await db.execute(text("""
        INSERT INTO bot_audit_log (platform, platform_id, display_name, command, parsed_command, agent_id, result, detail)
        VALUES (:pl, :pid, :dn, :cmd, :pcmd, CAST(:aid AS uuid), :res, CAST(:det AS jsonb))
    """), {
        "pl": body.get("platform", ""),
        "pid": body.get("platform_id", ""),
        "dn": body.get("display_name", ""),
        "cmd": (body.get("command") or "")[:500],
        "pcmd": body.get("parsed_command") or None,
        "aid": agent_id,
        "res": body.get("result", "unknown"),
        "det": json.dumps(body.get("detail") or {}),
    })
    await db.commit()
    return {"status": "ok"}


@router.get("/internal/agents")
async def bot_get_agents(hostname: Optional[str] = None, limit: int = 5, db: AsyncSession = Depends(get_db), _=Depends(require_bot_secret)):
    where = "a.is_active = TRUE AND a.exclude_from_reports = FALSE"
    params: dict = {"limit": limit}
    if hostname:
        where += " AND (a.hostname ILIKE :h OR a.display_name ILIKE :h)"
        params["h"] = f"%{hostname}%"
    rows = await db.execute(text(f"""
        SELECT a.id, a.hostname, a.display_name, a.status, a.os_type, a.ip_address, a.last_seen
        FROM agents a WHERE {where}
        ORDER BY a.hostname LIMIT :limit
    """), params)
    cols = ["id", "hostname", "display_name", "status", "os_type", "ip_address", "last_seen"]
    return [dict(zip(cols, r)) for r in rows.fetchall()]


@router.get("/internal/alerts")
async def bot_get_alerts(severity: Optional[str] = None, limit: int = 10, db: AsyncSession = Depends(get_db), _=Depends(require_bot_secret)):
    where = "al.status = 'open'"
    params: dict = {"limit": limit}
    if severity:
        where += " AND al.severity = :sev"
        params["sev"] = severity
    try:
        rows = await db.execute(text(f"""
            SELECT al.id, al.severity, al.message, a.hostname, al.triggered_at
            FROM alerts al JOIN agents a ON a.id = al.agent_id
            WHERE {where} ORDER BY al.severity DESC, al.triggered_at DESC LIMIT :limit
        """), params)
        cols = ["id", "severity", "message", "hostname", "triggered_at"]
        return [dict(zip(cols, r)) for r in rows.fetchall()]
    except Exception:
        return []


@router.get("/internal/compliance")
async def bot_get_compliance(db: AsyncSession = Depends(get_db), _=Depends(require_bot_secret)):
    try:
        patch_s, _ = await _patch_score(db)
        vuln_s, _ = await _vuln_score(db)
        config_s, _ = await _config_score(db)
        prot_s, _ = await _protection_score(db)
        lic_s, _ = await _license_score(db)
        overall_s = _overall(patch_s, vuln_s, config_s, prot_s, lic_s)
        from datetime import date
        return {
            "overall": overall_s,
            "patch": patch_s,
            "vuln": vuln_s,
            "config": config_s,
            "protection": prot_s,
            "license": lic_s,
            "as_of": date.today().isoformat(),
        }
    except Exception as e:
        logger.error(f"bot_get_compliance error: {e}")
    return {"overall": 0, "patch": 0, "vuln": 0, "config": 0, "protection": 0, "license": 0}


@router.get("/internal/patches/{agent_id}")
async def bot_get_patches(agent_id: str, db: AsyncSession = Depends(get_db), _=Depends(require_bot_secret)):
    rows = await db.execute(text("""
        SELECT package_name, available_version, category, description
        FROM agent_patches WHERE agent_id = CAST(:aid AS uuid)
        ORDER BY CASE WHEN LOWER(category)='security' THEN 0 ELSE 1 END, package_name
        LIMIT 20
    """), {"aid": agent_id})
    cols = ["package_name", "available_version", "category", "description"]
    return [dict(zip(cols, r)) for r in rows.fetchall()]


@router.post("/internal/command/restart")
async def bot_cmd_restart(body: dict, db: AsyncSession = Depends(get_db), _=Depends(require_bot_secret)):
    agent_id = body.get("agent_id")
    if not agent_id:
        raise HTTPException(400, "agent_id required")
    await db.execute(text("""
        INSERT INTO agent_commands (agent_id, command_type, payload)
        VALUES (CAST(:aid AS uuid), 'restart_machine', CAST(:payload AS jsonb))
        ON CONFLICT DO NOTHING
    """), {"aid": agent_id, "payload": '{"mode":"silent","delay_seconds":30}'})
    await db.commit()
    return {"status": "queued"}


@router.post("/internal/command/patch-scan")
async def bot_cmd_patch_scan(body: dict, db: AsyncSession = Depends(get_db), _=Depends(require_bot_secret)):
    agent_id = body.get("agent_id")
    if not agent_id:
        raise HTTPException(400, "agent_id required")
    await db.execute(text("""
        INSERT INTO agent_commands (agent_id, command_type, payload)
        VALUES (CAST(:aid AS uuid), 'patch_scan', '{}')
        ON CONFLICT DO NOTHING
    """), {"aid": agent_id})
    await db.commit()
    return {"status": "queued"}


@router.post("/internal/command/service-control")
async def bot_cmd_service(body: dict, db: AsyncSession = Depends(get_db), _=Depends(require_bot_secret)):
    agent_id = body.get("agent_id")
    service_name = body.get("service_name")
    action = body.get("action", "").lower()
    if not agent_id or not service_name or action not in ("start", "stop", "restart"):
        raise HTTPException(400, "agent_id, service_name and action (start/stop/restart) required")
    import json as _json
    payload = _json.dumps({"service_name": service_name, "action": action})
    await db.execute(text("""
        INSERT INTO agent_commands (agent_id, command_type, payload)
        VALUES (CAST(:aid AS uuid), 'service_control', CAST(:payload AS jsonb))
    """), {"aid": agent_id, "payload": payload})
    await db.commit()
    return {"status": "queued"}


@router.post("/internal/command/unlock-user")
async def bot_cmd_unlock(body: dict, db: AsyncSession = Depends(get_db), _=Depends(require_bot_secret)):
    import uuid as _uuid
    import json as _json

    agent_id = body.get("agent_id")
    username = body.get("username")
    if not agent_id or not username:
        raise HTTPException(400, "agent_id and username required")

    # Verify AD config exists for this agent; fall back to any active config
    row = await db.execute(text("""
        SELECT dc_host, base_dn, service_account, service_password
        FROM ad_configs WHERE agent_id = CAST(:aid AS uuid) AND is_active = TRUE LIMIT 1
    """), {"aid": agent_id})
    cfg = row.fetchone()
    if not cfg:
        row = await db.execute(text("""
            SELECT dc_host, base_dn, service_account, service_password
            FROM ad_configs WHERE is_active = TRUE LIMIT 1
        """))
        cfg = row.fetchone()
    if not cfg:
        raise HTTPException(404, "No Active Directory configuration found")

    # Generate a trackable action_id so we can poll for the result
    action_id = str(_uuid.uuid4())

    payload = _json.dumps({
        "action": "unlock",
        "sam_account_name": username,
        "action_id": action_id,
        "dc_host": cfg[0] or "",
        "base_dn": cfg[1] or "",
        "username": cfg[2] or "",
        "password": cfg[3] or "",
        "use_ssl": False,
    })
    await db.execute(text("""
        INSERT INTO agent_commands (agent_id, command_type, payload)
        VALUES (CAST(:aid AS uuid), 'ad_user_action', CAST(:payload AS jsonb))
    """), {"aid": agent_id, "payload": payload})

    # Pre-insert a tracking row in ad_action_log so we can poll it
    await db.execute(text("""
        INSERT INTO ad_action_log
            (agent_id, action, target_user, sam_account_name, status, action_id,
             performed_by_username, notes)
        VALUES
            (CAST(:aid AS uuid), 'unlock', :uname, :uname, 'pending', :actid,
             'bot', 'Queued via messaging bot')
        ON CONFLICT DO NOTHING
    """), {"aid": agent_id, "uname": username, "actid": action_id})

    await db.commit()
    return {"status": "queued", "action_id": action_id}


@router.get("/internal/command/unlock-status/{action_id}")
async def bot_unlock_status(action_id: str, db: AsyncSession = Depends(get_db), _=Depends(require_bot_secret)):
    """Poll for the result of a bot-queued unlock action."""
    row = await db.execute(text("""
        SELECT status, error_message, completed_at
        FROM ad_action_log WHERE action_id = :aid
    """), {"aid": action_id})
    r = row.fetchone()
    if not r:
        return {"status": "unknown"}
    return {
        "status": r[0],          # pending | completed | failed
        "error": r[1] or "",
        "completed_at": r[2],
    }


@router.post("/internal/command/reset-password")
async def bot_cmd_reset_password(body: dict, db: AsyncSession = Depends(get_db), _=Depends(require_bot_secret)):
    """Reset an AD user's password to a generated temp password and force change on next login."""
    import uuid as _uuid
    import json as _json
    import random, string

    agent_id = body.get("agent_id")
    username = body.get("username")
    if not agent_id or not username:
        raise HTTPException(400, "agent_id and username required")

    row = await db.execute(text("""
        SELECT dc_host, base_dn, service_account, service_password
        FROM ad_configs WHERE agent_id = CAST(:aid AS uuid) AND is_active = TRUE LIMIT 1
    """), {"aid": agent_id})
    cfg = row.fetchone()
    if not cfg:
        row = await db.execute(text("""
            SELECT dc_host, base_dn, service_account, service_password
            FROM ad_configs WHERE is_active = TRUE LIMIT 1
        """))
        cfg = row.fetchone()
    if not cfg:
        raise HTTPException(404, "No Active Directory configuration found")

    # Generate a secure temp password: Temp@ + 10 random chars (upper+lower+digit)
    chars = string.ascii_uppercase + string.ascii_lowercase + string.digits
    temp_pw = "Temp@" + "".join(random.SystemRandom().choices(chars, k=10))

    action_id = str(_uuid.uuid4())
    payload = _json.dumps({
        "action": "change_password",
        "sam_account_name": username,
        "new_password": temp_pw,
        "action_id": action_id,
        "dc_host": cfg[0] or "",
        "base_dn": cfg[1] or "",
        "username": cfg[2] or "",
        "password": cfg[3] or "",
        "use_ssl": True,
        "force_change_on_next_login": True,
    })
    await db.execute(text("""
        INSERT INTO agent_commands (agent_id, command_type, payload)
        VALUES (CAST(:aid AS uuid), 'ad_user_action', CAST(:payload AS jsonb))
    """), {"aid": agent_id, "payload": payload})

    await db.execute(text("""
        INSERT INTO ad_action_log
            (agent_id, action, target_user, sam_account_name, status, action_id,
             performed_by_username, notes)
        VALUES
            (CAST(:aid AS uuid), 'change_password', :uname, :uname, 'pending', :actid,
             'bot', 'Password reset via messaging bot')
        ON CONFLICT DO NOTHING
    """), {"aid": agent_id, "uname": username, "actid": action_id})

    await db.commit()
    return {"status": "queued", "action_id": action_id, "temp_password": temp_pw}


@router.get("/internal/command/ad-action-status/{action_id}")
async def bot_ad_action_status(action_id: str, db: AsyncSession = Depends(get_db), _=Depends(require_bot_secret)):
    row = await db.execute(text("""
        SELECT status, error_message, completed_at
        FROM ad_action_log WHERE action_id = :aid
    """), {"aid": action_id})
    r = row.fetchone()
    if not r:
        return {"status": "unknown"}
    return {"status": r[0], "error": r[1] or "", "completed_at": r[2]}


@router.get("/internal/patch-summary")
async def bot_patch_summary(db: AsyncSession = Depends(get_db), _=Depends(require_bot_secret)):
    """Overall patch compliance stats + top agents needing patches."""
    try:
        r = await db.execute(text("""
            SELECT
                COUNT(DISTINCT a.id)                                           AS total_agents,
                COUNT(DISTINCT CASE WHEN p.agent_id IS NULL THEN a.id END)     AS fully_patched,
                COUNT(DISTINCT CASE WHEN p.agent_id IS NOT NULL THEN a.id END) AS needs_patches,
                COUNT(p.id)                                                    AS total_pending,
                COUNT(CASE WHEN LOWER(p.category) = 'security' THEN 1 END)    AS security_pending
            FROM agents a
            LEFT JOIN agent_patches p ON p.agent_id = a.id
            WHERE a.is_active = TRUE
              AND (a.exclude_from_reports IS NULL OR a.exclude_from_reports = FALSE)
        """))
        row = r.fetchone()
        total = row[0] or 0
        fully = row[1] or 0
        compliance_pct = round(fully / total * 100, 1) if total else 0.0

        # Top 8 agents with most pending patches
        top_r = await db.execute(text("""
            SELECT a.hostname, COUNT(p.id) AS patch_count,
                   COUNT(CASE WHEN LOWER(p.category)='security' THEN 1 END) AS sec_count
            FROM agents a
            JOIN agent_patches p ON p.agent_id = a.id
            WHERE a.is_active = TRUE
            GROUP BY a.hostname ORDER BY patch_count DESC LIMIT 8
        """))
        top = [{"hostname": r[0], "total": r[1], "security": r[2]} for r in top_r.fetchall()]

        return {
            "total_agents": total,
            "fully_patched": fully,
            "needs_patches": row[2] or 0,
            "total_pending": row[3] or 0,
            "security_pending": row[4] or 0,
            "compliance_pct": compliance_pct,
            "top_agents": top,
        }
    except Exception as e:
        logger.error(f"bot_patch_summary error: {e}")
        return {"total_agents": 0, "fully_patched": 0, "needs_patches": 0,
                "total_pending": 0, "security_pending": 0, "compliance_pct": 0, "top_agents": []}


# ── Send message to user ───────────────────────────────────────────────────────

@router.post("/users/{user_id}/send-message")
async def send_message_to_user(
    user_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Send an admin message to a bot user on their platform."""
    await _ensure_bot_tables(db)

    message = (body.get("message") or "").strip()
    if not message:
        raise HTTPException(400, "message is required")

    # Look up the user
    row = await db.execute(text("""
        SELECT platform, platform_id, display_name FROM bot_users
        WHERE id = CAST(:id AS uuid) AND is_active = TRUE
    """), {"id": user_id})
    user = row.fetchone()
    if not user:
        raise HTTPException(404, "Bot user not found or inactive")

    platform, platform_id, display_name = user

    # Proxy send to kifaa-bot service
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                "http://kifaa-bot:8001/send",
                json={
                    "platform": platform,
                    "platform_id": platform_id,
                    "message": message,
                    "bot_secret": settings.bot_secret,
                },
            )
            result = r.json()
            if r.status_code != 200:
                raise HTTPException(502, result.get("detail", "Send failed"))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Bot service unreachable: {e}")

    # Log it
    await db.execute(text("""
        INSERT INTO bot_audit_log (platform, platform_id, display_name, command, parsed_command, result, detail)
        VALUES (:pl, :pid, :dn, :cmd, 'admin_message', 'success', CAST(:det AS jsonb))
    """), {
        "pl": platform,
        "pid": platform_id,
        "dn": display_name,
        "cmd": f"[Admin message] {message[:200]}",
        "det": json.dumps({"message": message[:500]}),
    })
    await db.commit()

    return {"status": "sent", "platform": platform, "to": display_name or platform_id}
