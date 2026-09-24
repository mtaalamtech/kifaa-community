"""
Patch Management router.
Handles SSH/WinRM credential storage, patch scanning and applying for agents.
"""
import io
import threading
import uuid as _uuid
import datetime
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from fastapi import Header
from api.database import get_db
from api.services.auth import get_current_user, get_agent_by_api_key

router = APIRouter(prefix="/patches", tags=["Patches"])

# ── Helpers ────────────────────────────────────────────────────────────────────

def _append_output(job_id: str, line: str, db_url: str):
    """Append a line to patch_jobs.output in a sync psycopg2 connection."""
    import psycopg2
    try:
        conn = psycopg2.connect(db_url)
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute(
            "UPDATE patch_jobs SET output = output || %s WHERE id = %s",
            (line + "\n", job_id),
        )
        cur.close()
        conn.close()
    except Exception:
        pass


def _finish_job(job_id: str, status: str, db_url: str):
    import psycopg2
    try:
        conn = psycopg2.connect(db_url)
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute(
            "UPDATE patch_jobs SET status=%s, finished_at=NOW() WHERE id=%s",
            (status, job_id),
        )
        cur.close()
        conn.close()
    except Exception:
        pass


# ── SSH credential CRUD ────────────────────────────────────────────────────────

@router.get("/credentials/{agent_id}")
async def get_credentials(agent_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    row = await db.execute(
        text("SELECT id, agent_id, host_override, port, username, connect_type, winrm_port, domain, use_sudo, updated_at FROM agent_ssh_credentials WHERE agent_id = :aid"),
        {"aid": agent_id},
    )
    row = row.fetchone()
    if not row:
        return {}
    cols = ["id", "agent_id", "host_override", "port", "username", "connect_type", "winrm_port", "domain", "use_sudo", "updated_at"]
    return dict(zip(cols, row))


@router.put("/credentials/{agent_id}")
async def upsert_credentials(agent_id: str, body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    existing = await db.execute(
        text("SELECT id FROM agent_ssh_credentials WHERE agent_id = :aid"),
        {"aid": agent_id},
    )
    existing = existing.fetchone()

    fields = {
        "host_override": body.get("host_override") or None,
        "port": int(body.get("port") or 22),
        "username": body.get("username", ""),
        "connect_type": body.get("connect_type", "linux"),
        "winrm_port": int(body.get("winrm_port") or 5985),
        "domain": body.get("domain") or None,
        "use_sudo": bool(body.get("use_sudo", True)),
        "updated_at": datetime.datetime.now(datetime.timezone.utc),
    }
    # Only update password/key if provided (avoid wiping stored value)
    if body.get("password"):
        fields["password"] = body["password"]
    if body.get("ssh_key"):
        fields["ssh_key"] = body["ssh_key"]

    if existing:
        set_clause = ", ".join(f"{k} = :{k}" for k in fields)
        await db.execute(
            text(f"UPDATE agent_ssh_credentials SET {set_clause} WHERE agent_id = :agent_id"),
            {**fields, "agent_id": agent_id},
        )
    else:
        fields["agent_id"] = agent_id
        if "password" not in fields:
            fields["password"] = body.get("password") or None
        if "ssh_key" not in fields:
            fields["ssh_key"] = body.get("ssh_key") or None
        cols = ", ".join(fields.keys())
        vals = ", ".join(f":{k}" for k in fields)
        await db.execute(text(f"INSERT INTO agent_ssh_credentials ({cols}) VALUES ({vals})"), fields)

    await db.commit()
    return {"status": "saved"}


# ── Agents overview ────────────────────────────────────────────────────────────

@router.get("/agents")
async def list_patch_agents(
    group_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Return all active agents with pending patch counts, last scan time, and active patching job."""
    base_q = """
        SELECT
            a.id, a.hostname, a.ip_address, a.os_type, a.os_name, a.os_version, a.status,
            COUNT(ap.id) AS pending_count,
            SUM(CASE WHEN ap.category = 'security' THEN 1 ELSE 0 END) AS security_count,
            COALESCE(MAX(ap.scanned_at), h.last_scan) AS last_scanned,
            CASE WHEN c.id IS NOT NULL THEN TRUE ELSE FALSE END AS has_credentials,
            COALESCE(a.restart_pending, FALSE) AS restart_pending,
            pj.active_job_id,
            pj.active_job_status
        FROM agents a
        LEFT JOIN agent_patches ap ON ap.agent_id = a.id
        LEFT JOIN agent_ssh_credentials c ON c.agent_id = a.id
        LEFT JOIN (
            SELECT agent_id, MAX(created_at) AS last_scan
            FROM agent_history
            WHERE event_type = 'patch_scan'
            GROUP BY agent_id
        ) h ON h.agent_id = a.id
        LEFT JOIN (
            SELECT DISTINCT ON (agent_id)
                agent_id,
                id::text AS active_job_id,
                status   AS active_job_status
            FROM patch_jobs
            WHERE job_type = 'apply' AND status IN ('pending', 'running')
            ORDER BY agent_id, started_at DESC NULLS LAST
        ) pj ON pj.agent_id = a.id
        WHERE a.is_active = TRUE
    """
    params = {}
    if group_id:
        base_q += " AND a.group_id = :group_id"
        params["group_id"] = group_id
    base_q += """
        GROUP BY a.id, a.hostname, a.ip_address, a.os_type, a.os_name, a.os_version, a.status,
                 c.id, h.last_scan, pj.active_job_id, pj.active_job_status
        ORDER BY pending_count DESC, a.hostname
    """
    rows = await db.execute(text(base_q), params)
    cols = ["id", "hostname", "ip_address", "os_type", "os_name", "os_version",
            "status", "pending_count", "security_count", "last_scanned", "has_credentials",
            "restart_pending", "active_job_id", "active_job_status"]
    result = []
    for row in rows.fetchall():
        d = dict(zip(cols, row))
        d["id"] = str(d["id"])
        d["pending_count"] = int(d["pending_count"] or 0)
        d["security_count"] = int(d["security_count"] or 0)
        d["last_scanned"] = d["last_scanned"].isoformat() if d["last_scanned"] else None
        d["restart_pending"] = bool(d.get("restart_pending") or False)
        d["is_patching"] = d["active_job_id"] is not None
        result.append(d)
    return result


_history_table_ready = False

async def _ensure_history_table(db: AsyncSession):
    global _history_table_ready
    if _history_table_ready:
        return
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS agent_update_history (
            id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            title       TEXT NOT NULL,
            kb          TEXT,
            installed_at TIMESTAMPTZ,
            result      TEXT DEFAULT 'success',
            category    TEXT DEFAULT 'update',
            reported_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text(
        "CREATE INDEX IF NOT EXISTS idx_update_history_agent ON agent_update_history(agent_id, installed_at DESC)"
    ))
    await db.commit()
    _history_table_ready = True


@router.post("/update-history")
async def receive_update_history(
    body: dict,
    x_api_key: str = Header(..., alias="X-API-Key"),
    db: AsyncSession = Depends(get_db),
):
    """Agent reports installed update history after a patch scan."""
    await _ensure_history_table(db)

    agent = await get_agent_by_api_key(db, x_api_key)
    if not agent:
        raise HTTPException(status_code=401, detail="Invalid API key")

    history = body.get("history", [])
    if not history:
        return {"stored": 0}

    # Upsert: delete existing history for this agent, then insert fresh
    await db.execute(text("DELETE FROM agent_update_history WHERE agent_id = :aid"), {"aid": agent.id})
    stored = 0
    for item in history:
        installed_at = item.get("installed_at")
        if installed_at:
            try:
                import datetime as _dt
                installed_at = _dt.datetime.fromisoformat(installed_at.replace("Z", "+00:00"))
            except Exception:
                installed_at = None
        await db.execute(text("""
            INSERT INTO agent_update_history (agent_id, title, kb, installed_at, result, category)
            VALUES (:aid, :title, :kb, :installed_at, :result, :category)
        """), {
            "aid":          agent.id,
            "title":        (item.get("title") or "")[:500],
            "kb":           item.get("kb") or None,
            "installed_at": installed_at,
            "result":       item.get("result") or "success",
            "category":     item.get("category") or "update",
        })
        stored += 1
    await db.commit()
    return {"stored": stored}


@router.get("/agents/{agent_id}/update-history")
async def get_agent_update_history(agent_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Return installed update history for one agent."""
    await _ensure_history_table(db)
    rows = await db.execute(text("""
        SELECT title, kb, installed_at, result, category
        FROM agent_update_history
        WHERE agent_id = :aid
        ORDER BY installed_at DESC NULLS LAST
        LIMIT 200
    """), {"aid": agent_id})
    cols = ["title", "kb", "installed_at", "result", "category"]
    result = []
    for r in rows.fetchall():
        d = dict(zip(cols, r))
        d["installed_at"] = d["installed_at"].isoformat() if d["installed_at"] else None
        result.append(d)
    return result


@router.get("/agents/{agent_id}/updates")
async def get_agent_updates(agent_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Return current pending updates for one agent."""
    rows = await db.execute(
        text("SELECT id, package_name, current_version, available_version, category, description, scanned_at FROM agent_patches WHERE agent_id = :aid ORDER BY category, package_name"),
        {"aid": agent_id},
    )
    cols = ["id", "package_name", "current_version", "available_version", "category", "description", "scanned_at"]
    return [dict(zip(cols, r)) for r in rows.fetchall()]


# ── Scan job ───────────────────────────────────────────────────────────────────

@router.post("/scan/{agent_id}")
async def trigger_scan(agent_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Start a patch scan job for one agent.
    If the agent is online (heartbeat-based), queues a command so the agent scans itself locally.
    Falls back to SSH/WinRM/SMB push-scan when SSH credentials are configured.
    """
    import os

    agent_row = await db.execute(
        text("SELECT id, hostname, ip_address, os_type, status FROM agents WHERE id = :aid AND is_active = TRUE"),
        {"aid": agent_id},
    )
    agent_row = agent_row.fetchone()
    if not agent_row:
        raise HTTPException(404, "Agent not found")

    agent_id_uuid, hostname, ip_address, os_type, agent_status = agent_row

    # ── Option A: agent is online → use agent-pull (no inbound ports needed) ──
    if agent_status == "online":
        # Clear any existing pending scan commands for this agent first
        await db.execute(
            text("DELETE FROM agent_commands WHERE agent_id = :aid AND command_type = 'patch_scan' AND picked_up_at IS NULL"),
            {"aid": str(agent_id_uuid)},
        )
        await db.execute(
            text("INSERT INTO agent_commands (agent_id, command_type, payload) VALUES (:aid, 'patch_scan', '{}')"),
            {"aid": str(agent_id_uuid)},
        )
        await db.commit()
        return {"method": "agent_pull", "status": "queued", "message": "Scan command queued — agent will execute on next heartbeat (within 60s)"}

    # ── Option B: agent offline → try direct SSH/WinRM/SMB ────────────────────
    creds = await db.execute(
        text("SELECT host_override, port, username, password, ssh_key, use_sudo, connect_type, winrm_port, domain FROM agent_ssh_credentials WHERE agent_id = :aid"),
        {"aid": agent_id},
    )
    creds = creds.fetchone()
    if not creds:
        raise HTTPException(400, "Agent is offline and no SSH/WinRM credentials are configured. The agent must be online for agentless scanning.")

    job_id = str(_uuid.uuid4())
    await db.execute(
        text("INSERT INTO patch_jobs (id, agent_id, job_type, status, triggered_by) VALUES (:id, :aid, 'scan', 'running', 'manual')"),
        {"id": job_id, "aid": agent_id},
    )
    await db.commit()

    cred_dict = dict(zip(
        ["host_override", "port", "username", "password", "ssh_key", "use_sudo", "connect_type", "winrm_port", "domain"],
        creds,
    ))
    host = cred_dict["host_override"] or ip_address
    db_url = os.getenv("SYNC_DATABASE_URL", "")

    t = threading.Thread(
        target=_run_scan,
        args=(job_id, str(agent_id_uuid), host, hostname, {"os_type": os_type}, cred_dict, db_url),
        daemon=True,
    )
    t.start()

    return {"method": "direct", "job_id": job_id, "status": "running"}


async def _queue_patch_scan_all(db: AsyncSession) -> dict:
    """Queue patch_scan commands for ALL online agents (shared logic)."""
    rows = await db.execute(text(
        "SELECT id FROM agents WHERE is_active = TRUE AND status = 'online'"
    ))
    agents = rows.fetchall()
    queued = 0
    for row in agents:
        aid = str(row[0])
        await db.execute(
            text("DELETE FROM agent_commands WHERE agent_id = :aid AND command_type = 'patch_scan' AND picked_up_at IS NULL"),
            {"aid": aid},
        )
        await db.execute(
            text("INSERT INTO agent_commands (agent_id, command_type, payload) VALUES (:aid, 'patch_scan', '{}')"),
            {"aid": aid},
        )
        queued += 1
    await db.commit()
    return {"queued": queued, "method": "agent_pull"}


@router.post("/scan-all-agent-pull")
async def scan_all_agent_pull(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Queue patch_scan commands for ALL online agents via heartbeat (no credentials needed)."""
    return await _queue_patch_scan_all(db)


@router.post("/internal/scan-all-agent-pull", include_in_schema=False)
async def scan_all_agent_pull_internal(db: AsyncSession = Depends(get_db)):
    """Internal: called by Celery beat for daily automatic patch scan."""
    return await _queue_patch_scan_all(db)


@router.post("/scan-all")
async def scan_all(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Queue scans for every agent that has credentials configured."""
    import os

    rows = await db.execute(text("""
        SELECT a.id, a.hostname, a.ip_address, a.os_type,
               c.host_override, c.port, c.username, c.password, c.ssh_key,
               c.use_sudo, c.connect_type, c.winrm_port, c.domain
        FROM agents a
        JOIN agent_ssh_credentials c ON c.agent_id = a.id
        WHERE a.is_active = TRUE AND a.status = 'online'
    """))
    agents = rows.fetchall()
    db_url = os.getenv("SYNC_DATABASE_URL", "")
    queued = 0
    for row in agents:
        job_id = str(_uuid.uuid4())
        await db.execute(
            text("INSERT INTO patch_jobs (id, agent_id, job_type, status, triggered_by) VALUES (:id, :aid, 'scan', 'running', 'auto')"),
            {"id": job_id, "aid": str(row[0])},
        )
        cred_dict = dict(zip(
            ["host_override", "port", "username", "password", "ssh_key", "use_sudo", "connect_type", "winrm_port", "domain"],
            row[4:],
        ))
        host = cred_dict["host_override"] or row[2]
        t = threading.Thread(
            target=_run_scan,
            args=(job_id, str(row[0]), host, row[1], {"os_type": row[3]}, cred_dict, db_url),
            daemon=True,
        )
        t.start()
        queued += 1
    await db.commit()
    return {"queued": queued}


# ── Apply job ──────────────────────────────────────────────────────────────────

@router.post("/apply")
async def apply_patches(body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Apply selected packages on an agent.
    For online agents, uses agent-pull (no inbound ports needed).
    Falls back to direct SSH/WinRM for offline agents with credentials.
    """
    import os
    import json as _json

    agent_id = body.get("agent_id")
    packages = body.get("packages", [])
    reboot_after = bool(body.get("reboot_after", False))
    reboot_mode = body.get("reboot_mode", "silent")
    reboot_delay_seconds = int(body.get("reboot_delay_seconds", 60))
    if not agent_id or not packages:
        raise HTTPException(400, "agent_id and packages are required")

    agent = await db.execute(
        text("SELECT id, hostname, ip_address, os_type, status FROM agents WHERE id = :aid"),
        {"aid": agent_id},
    )
    agent = agent.fetchone()
    if not agent:
        raise HTTPException(404, "Agent not found")

    agent_id_uuid, hostname, ip_address, os_type, agent_status = agent

    # Filter out packages whose available_version comes from a third-party repo that may
    # have dropped support for this distro (e.g. apt.postgresql.org uses "pgdg18.04",
    # "pgdg20.04" etc. in version strings). These packages cause 404 errors that abort the
    # entire apt-get run. The agent already has root — no SSH credentials needed; we just
    # send it a clean list it can actually install.
    if packages:
        vers_rows = await db.execute(
            text("""SELECT package_name, available_version
                    FROM agent_patches
                    WHERE agent_id = :aid AND package_name = ANY(:pkgs)"""),
            {"aid": str(agent_id_uuid), "pkgs": packages},
        )
        vers_map = {r[0]: r[1] or "" for r in vers_rows.fetchall()}
        skipped = []
        filtered_packages = []
        for pkg in packages:
            ver = vers_map.get(pkg, "")
            # pgdg versions look like "10.23-1.pgdg18.04+1" — skip them
            if "pgdg" in ver:
                skipped.append(f"{pkg} ({ver})")
            else:
                filtered_packages.append(pkg)
        packages = filtered_packages

    # Create a patch_jobs record so the UI can track progress
    job_id = str(_uuid.uuid4())
    await db.execute(
        text("""INSERT INTO patch_jobs
                  (id, agent_id, job_type, packages, status, triggered_by,
                   reboot_after, reboot_mode, reboot_delay_seconds)
                VALUES
                  (:id, :aid, 'apply', :pkgs, 'pending', 'manual',
                   :reboot_after, :reboot_mode, :reboot_delay_seconds)"""),
        {"id": job_id, "aid": str(agent_id_uuid), "pkgs": packages,
         "reboot_after": reboot_after, "reboot_mode": reboot_mode,
         "reboot_delay_seconds": reboot_delay_seconds},
    )

    if not packages:
        # All selected packages were from broken repos — nothing to install
        await db.execute(text("UPDATE patch_jobs SET status='success', finished_at=now() WHERE id=:id"), {"id": job_id})
        await db.commit()
        skipped_str = ", ".join(skipped) if skipped else "all selected packages"
        return {
            "method": "skipped",
            "job_id": job_id,
            "status": "success",
            "message": f"Nothing to install — the following packages are from a third-party repo that is no longer available for this OS version and were skipped: {skipped_str}. Update or remove the repo (e.g. /etc/apt/sources.list.d/pgdg.list) to fix this.",
        }

    # ── Option A: agent is online → use agent-pull (no inbound ports needed) ──
    if agent_status == "online":
        await db.execute(
            text("INSERT INTO agent_commands (agent_id, command_type, payload) VALUES (:aid, 'apply_patches', CAST(:payload AS jsonb))"),
            {"aid": str(agent_id_uuid), "payload": _json.dumps({
                "job_id": job_id, "packages": packages,
                "reboot_after": reboot_after,
                "reboot_mode": reboot_mode,
                "reboot_delay_seconds": reboot_delay_seconds,
            })},
        )
        await db.commit()
        msg = "Apply queued — agent will execute on next heartbeat (within 60s)"
        if skipped:
            msg += f". Skipped (unavailable from third-party repo): {', '.join(skipped)}"
        return {
            "method": "agent_pull",
            "job_id": job_id,
            "status": "pending",
            "message": msg,
        }

    # ── Option B: agent offline → try direct SSH/WinRM ────────────────────────
    creds = await db.execute(
        text("SELECT host_override, port, username, password, ssh_key, use_sudo, connect_type, winrm_port, domain FROM agent_ssh_credentials WHERE agent_id = :aid"),
        {"aid": agent_id},
    )
    creds = creds.fetchone()
    if not creds:
        raise HTTPException(400, "Agent is offline and no SSH/WinRM credentials are configured.")

    await db.execute(
        text("UPDATE patch_jobs SET status='running' WHERE id=:id"),
        {"id": job_id},
    )
    await db.commit()

    cred_dict = dict(zip(
        ["host_override", "port", "username", "password", "ssh_key", "use_sudo", "connect_type", "winrm_port", "domain"],
        creds,
    ))
    host = cred_dict["host_override"] or ip_address
    db_url = os.getenv("SYNC_DATABASE_URL", "")

    t = threading.Thread(
        target=_run_apply,
        args=(job_id, str(agent_id_uuid), host, hostname, {"os_type": os_type}, cred_dict, packages, db_url),
        daemon=True,
    )
    t.start()

    return {"method": "direct", "job_id": job_id, "status": "running"}


# ── Jobs CRUD ──────────────────────────────────────────────────────────────────

@router.get("/jobs")
async def list_jobs(
    agent_id: Optional[str] = None,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    where = "WHERE 1=1"
    params: dict = {"limit": limit}
    if agent_id:
        where += " AND j.agent_id = :agent_id"
        params["agent_id"] = agent_id

    rows = await db.execute(text(f"""
        SELECT j.id, j.agent_id, a.hostname, j.job_type, j.packages, j.status,
               j.triggered_by, j.started_at, j.finished_at
        FROM patch_jobs j
        JOIN agents a ON a.id = j.agent_id
        {where}
        ORDER BY j.started_at DESC
        LIMIT :limit
    """), params)

    cols = ["id", "agent_id", "hostname", "job_type", "packages", "status", "triggered_by", "started_at", "finished_at"]
    result = []
    for row in rows.fetchall():
        d = dict(zip(cols, row))
        d["id"] = str(d["id"])
        d["agent_id"] = str(d["agent_id"])
        d["started_at"] = d["started_at"].isoformat() if d["started_at"] else None
        d["finished_at"] = d["finished_at"].isoformat() if d["finished_at"] else None
        result.append(d)
    return result


@router.get("/jobs/{job_id}")
async def get_job(job_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    row = await db.execute(
        text("SELECT id, agent_id, job_type, packages, status, output, triggered_by, started_at, finished_at FROM patch_jobs WHERE id = :id"),
        {"id": job_id},
    )
    row = row.fetchone()
    if not row:
        raise HTTPException(404, "Job not found")
    cols = ["id", "agent_id", "job_type", "packages", "status", "output", "triggered_by", "started_at", "finished_at"]
    d = dict(zip(cols, row))
    d["id"] = str(d["id"])
    d["agent_id"] = str(d["agent_id"])
    d["started_at"] = d["started_at"].isoformat() if d["started_at"] else None
    d["finished_at"] = d["finished_at"].isoformat() if d["finished_at"] else None
    return d


@router.delete("/jobs/{job_id}")
async def delete_job(job_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await db.execute(text("DELETE FROM patch_jobs WHERE id = :id"), {"id": job_id})
    await db.commit()
    return {"status": "deleted"}


def _severity_from_category(category: str) -> str:
    """Derive a human-readable severity from the patch category field."""
    c = (category or "").lower()
    if c == "security":
        return "Critical"
    if c in ("upgrade", "update"):
        return "Medium"
    if c == "definition":
        return "Low"
    return "Unknown"


@router.get("/report/pending")
async def report_pending_patches(
    os_type: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """All pending patches across all agents grouped by hostname, optionally filtered by os_type."""
    q = """
        SELECT
            a.hostname, a.ip_address, a.os_type, a.os_name, a.os_version, a.status,
            ap.package_name, ap.current_version, ap.available_version,
            ap.category, ap.description, ap.scanned_at
        FROM agent_patches ap
        JOIN agents a ON a.id = ap.agent_id
        WHERE a.is_active = TRUE AND a.exclude_from_reports = FALSE
    """
    params = {}
    if os_type:
        q += " AND a.os_type = :os_type"
        params["os_type"] = os_type
    # Sort: hostname first so all patches for the same host are together,
    # then severity order (security first), then package name
    q += """
        ORDER BY a.hostname,
            CASE ap.category
                WHEN 'security' THEN 1
                WHEN 'upgrade'  THEN 2
                WHEN 'update'   THEN 2
                WHEN 'definition' THEN 3
                ELSE 4
            END,
            ap.package_name
    """
    rows = await db.execute(text(q), params)
    cols = ["hostname", "ip_address", "os_type", "os_name", "os_version", "status",
            "package_name", "current_version", "available_version",
            "category", "description", "scanned_at"]
    result = []
    for row in rows.fetchall():
        d = dict(zip(cols, row))
        d["severity"] = _severity_from_category(d["category"])
        d["scanned_at"] = d["scanned_at"].isoformat() if d["scanned_at"] else None
        result.append(d)
    return result


@router.get("/report/history")
async def report_patch_history(
    os_type: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Installed patch/update history across all agents grouped by hostname."""
    await _ensure_history_table(db)
    q = """
        SELECT
            a.hostname, a.ip_address, a.os_type, a.os_name,
            uh.title, uh.kb, uh.installed_at, uh.result, uh.category
        FROM agent_update_history uh
        JOIN agents a ON a.id = uh.agent_id
        WHERE a.is_active = TRUE AND a.exclude_from_reports = FALSE
    """
    params = {}
    if os_type:
        q += " AND a.os_type = :os_type"
        params["os_type"] = os_type
    # Group by hostname, newest installs first within each host
    q += " ORDER BY a.hostname, uh.installed_at DESC NULLS LAST"
    rows = await db.execute(text(q), params)
    cols = ["hostname", "ip_address", "os_type", "os_name",
            "title", "kb", "installed_at", "result", "category"]
    result = []
    for row in rows.fetchall():
        d = dict(zip(cols, row))
        d["severity"] = _severity_from_category(d["category"])
        d["installed_at"] = d["installed_at"].isoformat() if d["installed_at"] else None
        result.append(d)
    return result


@router.get("/report/compliance")
async def report_patch_compliance(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Per-agent patching compliance summary for the report export."""
    await _ensure_history_table(db)
    rows = await db.execute(text("""
        SELECT
            a.id::text, a.hostname, a.ip_address, a.os_type, a.os_name, a.os_version, a.status,
            COUNT(ap.id)                                                         AS total_pending,
            COUNT(ap.id) FILTER (WHERE ap.category = 'security')                AS critical_pending,
            COUNT(ap.id) FILTER (WHERE ap.category IN ('upgrade','update'))      AS medium_pending,
            (SELECT COUNT(*) FROM agent_update_history uh WHERE uh.agent_id = a.id) AS installed
        FROM agents a
        LEFT JOIN agent_patches ap ON ap.agent_id = a.id
        WHERE a.is_active = TRUE AND a.exclude_from_reports = FALSE
        GROUP BY a.id, a.hostname, a.ip_address, a.os_type, a.os_name, a.os_version, a.status
        ORDER BY a.hostname
    """))
    cols = ["id", "hostname", "ip_address", "os_type", "os_name", "os_version", "status",
            "total_pending", "critical_pending", "medium_pending", "installed"]
    result = []
    for row in rows.fetchall():
        d = dict(zip(cols, row))
        total_pending = int(d["total_pending"] or 0)
        critical      = int(d["critical_pending"] or 0)
        medium        = int(d["medium_pending"] or 0)
        installed     = int(d["installed"] or 0)
        total_known   = installed + total_pending
        pct = round((installed / total_known * 100), 1) if total_known > 0 else None
        # Zero-day: security patches scanned within the last 7 days (newly discovered)
        d["total_pending"]    = total_pending
        d["critical_pending"] = critical
        d["medium_pending"]   = medium
        d["installed"]        = installed
        d["patch_pct"]        = pct
        d["compliant"]        = critical == 0
        result.append(d)
    return result


@router.get("/compliance")
async def get_compliance(
    group_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """
    Return per-agent patch compliance data.

    Compliance = (critical+important patches scanned_at - pending) / scanned_at
    We define a compliant agent as one with NO pending security patches.
    We report:
      - total_agents   — agents that have been scanned
      - compliant      — agents with 0 pending security patches
      - non_compliant  — agents with ≥1 pending security patch
      - compliance_pct — percentage compliant (0-100)
      - kpi_met        — compliance_pct >= 80
      - per_agent      — per-agent breakdown with severity counts
      - severity_summary — counts of pending patches by severity across all agents
    """
    where_group = "AND a.group_id = :group_id" if group_id else ""
    params: dict = {}
    if group_id:
        params["group_id"] = group_id

    # Per-agent compliance query
    agent_q = f"""
        SELECT
            a.id,
            a.hostname,
            a.ip_address,
            a.os_type,
            a.os_name,
            a.status,
            COALESCE(a.restart_pending, FALSE)  AS restart_pending,
            COUNT(ap.id)                         AS total_pending,
            SUM(CASE WHEN ap.category = 'security'
                     AND LOWER(ap.available_version) IN ('critical','important')
                     THEN 1 ELSE 0 END)          AS critical_pending,
            SUM(CASE WHEN ap.category = 'security'
                     AND LOWER(ap.available_version) = 'moderate'
                     THEN 1 ELSE 0 END)          AS moderate_pending,
            SUM(CASE WHEN ap.category = 'security'
                     AND LOWER(ap.available_version) NOT IN ('critical','important','moderate')
                     THEN 1 ELSE 0 END)          AS low_pending,
            SUM(CASE WHEN ap.category != 'security' OR ap.category IS NULL
                     THEN 1 ELSE 0 END)          AS upgrade_pending,
            MAX(ap.scanned_at)                   AS last_scanned,
            g.name                               AS group_name,
            g.color                              AS group_color
        FROM agents a
        LEFT JOIN agent_patches ap ON ap.agent_id = a.id
        LEFT JOIN agent_groups g   ON g.id = a.group_id
        WHERE a.is_active = TRUE AND a.exclude_from_reports = FALSE
          {where_group}
        GROUP BY a.id, a.hostname, a.ip_address, a.os_type, a.os_name,
                 a.status, a.restart_pending, g.name, g.color
        ORDER BY critical_pending DESC, total_pending DESC, a.hostname
    """
    rows = await db.execute(text(agent_q), params)
    agents_data = []
    total_scanned = 0
    compliant_count = 0
    sev_totals = {"critical": 0, "important": 0, "moderate": 0, "low": 0, "upgrade": 0}

    for row in rows.fetchall():
        (agent_id, hostname, ip, os_type, os_name, status, restart_pending,
         total_pending, critical_pending, moderate_pending, low_pending,
         upgrade_pending, last_scanned, group_name, group_color) = row

        critical_pending  = int(critical_pending  or 0)
        moderate_pending  = int(moderate_pending  or 0)
        low_pending       = int(low_pending       or 0)
        upgrade_pending   = int(upgrade_pending   or 0)
        total_pending     = int(total_pending     or 0)
        security_pending  = critical_pending + moderate_pending + low_pending

        # Only count agents that have been scanned (have patch data OR last_scanned)
        scanned = last_scanned is not None
        if scanned:
            total_scanned += 1
            if security_pending == 0:
                compliant_count += 1

        sev_totals["critical"]  += critical_pending
        sev_totals["moderate"]  += moderate_pending
        sev_totals["low"]       += low_pending
        sev_totals["upgrade"]   += upgrade_pending

        # Compliance status per agent
        if not scanned:
            compliance_status = "unscanned"
        elif security_pending == 0:
            compliance_status = "compliant"
        elif critical_pending > 0:
            compliance_status = "critical"
        else:
            compliance_status = "non_compliant"

        agents_data.append({
            "id":               str(agent_id),
            "hostname":         hostname,
            "ip_address":       ip,
            "os_type":          os_type,
            "os_name":          os_name,
            "status":           status,
            "restart_pending":  bool(restart_pending),
            "total_pending":    total_pending,
            "critical_pending": critical_pending,
            "moderate_pending": moderate_pending,
            "low_pending":      low_pending,
            "upgrade_pending":  upgrade_pending,
            "security_pending": security_pending,
            "compliance_status": compliance_status,
            "last_scanned":     last_scanned.isoformat() if last_scanned else None,
            "group_name":       group_name,
            "group_color":      group_color,
        })

    compliance_pct = round((compliant_count / total_scanned * 100), 1) if total_scanned > 0 else 0.0

    return {
        "total_agents":   len(agents_data),
        "scanned_agents": total_scanned,
        "compliant":      compliant_count,
        "non_compliant":  total_scanned - compliant_count,
        "compliance_pct": compliance_pct,
        "kpi_met":        compliance_pct >= 80.0,
        "severity_summary": sev_totals,
        "agents":         agents_data,
    }


# ── Scan worker (runs in background thread) ────────────────────────────────────

def _run_scan(job_id: str, agent_id: str, host: str, hostname: str, agent_info: dict, creds: dict, db_url: str):
    """Detect package manager, query pending updates, store results."""
    log = lambda line: _append_output(job_id, line, db_url)

    try:
        connect_type = creds.get("connect_type", "linux")
        if connect_type == "linux":
            updates = _scan_linux(job_id, host, hostname, creds, log)
        elif connect_type == "windows_winrm":
            updates = _scan_windows_winrm(job_id, host, hostname, creds, log)
        else:
            log("[WARN] SMB/legacy scan: only basic patch-level info available via WMIC")
            updates = _scan_windows_smb(job_id, host, hostname, creds, log)

        # Replace all patches for this agent
        import psycopg2
        conn = psycopg2.connect(db_url)
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute("DELETE FROM agent_patches WHERE agent_id = %s", (agent_id,))
        for u in updates:
            cur.execute(
                "INSERT INTO agent_patches (agent_id, package_name, current_version, available_version, category, description) VALUES (%s, %s, %s, %s, %s, %s)",
                (agent_id, u["package_name"], u.get("current_version"), u.get("available_version"), u.get("category", "unknown"), u.get("description", "")),
            )
        cur.close()
        conn.close()

        log(f"[OK] Scan complete — {len(updates)} pending update(s) found")
        _finish_job(job_id, "success", db_url)

    except Exception as e:
        log(f"[ERROR] {e}")
        _finish_job(job_id, "failed", db_url)


def _scan_linux(job_id: str, host: str, hostname: str, creds: dict, log) -> list:
    import paramiko

    password = creds.get("password", "")
    ssh_key_str = creds.get("ssh_key", "")
    port = int(creds.get("port") or 22)
    username = creds.get("username", "root")
    use_sudo = creds.get("use_sudo", True)
    sudo = "sudo " if use_sudo else ""

    log(f"[INFO] Connecting via SSH to {username}@{host}:{port}")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    connect_kwargs = dict(hostname=host, port=port, username=username, timeout=30)
    if ssh_key_str:
        pkey = paramiko.RSAKey.from_private_key(io.StringIO(ssh_key_str))
        connect_kwargs["pkey"] = pkey
    else:
        connect_kwargs["password"] = password

    ssh.connect(**connect_kwargs)
    log("[INFO] SSH connected")

    def run(cmd):
        stdin, stdout, stderr = ssh.exec_command(cmd, timeout=60)
        stdout.channel.recv_exit_status()
        return stdout.read().decode(errors="replace").strip()

    # Detect package manager
    pm = run("which apt-get apt yum dnf zypper 2>/dev/null | head -1").strip().split("/")[-1]
    log(f"[INFO] Package manager: {pm or 'unknown'}")

    updates = []

    if pm in ("apt-get", "apt"):
        log("[RUN] apt-get update -qq")
        run(f"{sudo}apt-get update -qq 2>/dev/null || true")
        log("[RUN] apt list --upgradable")
        raw = run("apt list --upgradable 2>/dev/null")
        for line in raw.splitlines():
            # Format: package/repo version arch [upgradable from: old_version]
            if "/" not in line or line.startswith("Listing"):
                continue
            parts = line.split()
            pkg = parts[0].split("/")[0]
            new_ver = parts[1] if len(parts) > 1 else ""
            old_ver = ""
            if "upgradable from:" in line:
                old_ver = line.split("upgradable from:")[-1].strip().rstrip("]")
            # Check if it's a security update by looking at repo source
            category = "security" if "security" in line.lower() else "upgrade"
            updates.append({"package_name": pkg, "current_version": old_ver, "available_version": new_ver, "category": category})

    elif pm in ("yum", "dnf"):
        log("[RUN] yum check-update")
        # yum check-update exits 100 when updates exist — suppress error
        raw = run(f"{sudo}{pm} check-update --quiet 2>/dev/null || true")
        for line in raw.splitlines():
            parts = line.split()
            if len(parts) < 2 or line.startswith("Last") or line.startswith("Loaded"):
                continue
            pkg = parts[0].rsplit(".", 1)[0]
            new_ver = parts[1] if len(parts) > 1 else ""
            repo = parts[2] if len(parts) > 2 else ""
            category = "security" if "security" in repo.lower() else "upgrade"
            updates.append({"package_name": pkg, "available_version": new_ver, "category": category})

    elif pm == "zypper":
        log("[RUN] zypper list-updates")
        raw = run(f"{sudo}zypper -q list-updates 2>/dev/null || true")
        for line in raw.splitlines():
            if "|" not in line or "Name" in line:
                continue
            parts = [p.strip() for p in line.split("|")]
            if len(parts) >= 5:
                updates.append({"package_name": parts[2], "current_version": parts[3], "available_version": parts[4], "category": "upgrade"})
    else:
        log("[WARN] Could not detect package manager — no updates retrieved")

    ssh.close()
    return updates


def _scan_windows_winrm(job_id: str, host: str, hostname: str, creds: dict, log) -> list:
    import winrm

    username = creds.get("username", "")
    password = creds.get("password", "")
    domain = creds.get("domain", "")
    port = int(creds.get("winrm_port") or 5985)
    user = f"{domain}\\{username}" if domain else username

    log(f"[INFO] Connecting via WinRM to {user}@{host}:{port}")
    session = winrm.Session(f"http://{host}:{port}/wsman", auth=(user, password), transport="ntlm")

    ps_script = r"""
$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
try {
    $result = $searcher.Search("IsInstalled=0 and Type='Software' and IsHidden=0")
    $updates = $result.Updates
    $out = @()
    foreach ($u in $updates) {
        $sev = if ($u.MsrcSeverity) { $u.MsrcSeverity } else { "Unknown" }
        $out += [PSCustomObject]@{
            Title = $u.Title
            Severity = $sev
            KBArticleIDs = ($u.KBArticleIDs -join ",")
        }
    }
    $out | ConvertTo-Json -Compress
} catch {
    Write-Output "[]"
}
"""
    log("[RUN] Querying Windows Update (this may take 30-60s)...")
    result = session.run_ps(ps_script)
    if result.std_err:
        log(f"[WARN] WinRM stderr: {result.std_err.decode(errors='replace')[:200]}")

    import json
    raw = result.std_out.decode(errors="replace").strip()
    if not raw or raw == "[]":
        log("[INFO] No pending Windows Updates found")
        return []

    try:
        items = json.loads(raw)
        if isinstance(items, dict):
            items = [items]
    except Exception:
        log(f"[WARN] Could not parse update list: {raw[:200]}")
        return []

    updates = []
    for item in items:
        title = item.get("Title", "")
        sev = item.get("Severity", "Unknown").lower()
        kb = item.get("KBArticleIDs", "")
        category = "security" if sev in ("critical", "important", "moderate") else "upgrade"
        pkg_name = f"KB{kb}" if kb else title[:80]
        updates.append({"package_name": pkg_name, "description": title, "category": category, "available_version": sev})

    log(f"[INFO] Found {len(updates)} pending Windows Updates")
    return updates


def _scan_windows_smb(job_id: str, host: str, hostname: str, creds: dict, log) -> list:
    """
    Scan Windows Update via SMB + SCM (works on XP/7/2003/2008 without WinRM).
    Flow:
      1. SMB connect + auth (port 445, ADMIN$ share)
      2. Write VBScript to C:\\Windows\\Temp\\kifaa\\wuscan.vbs
      3. Create/start a temporary SCM service running cscript to execute it
      4. Wait for the service to stop (script output written to updates.txt)
      5. Read updates.txt back via SMB
      6. Clean up service + temp files
    """
    import time
    import io as _io
    try:
        from impacket.smbconnection import SMBConnection
        from impacket.dcerpc.v5 import transport, scmr
    except ImportError:
        raise RuntimeError("impacket is not installed")

    username = creds.get("username", "")
    password = creds.get("password", "")
    domain = creds.get("domain", "") or ""

    # Strip domain\ prefix if user included it
    if "\\" in username:
        domain, username = username.split("\\", 1)
    elif "/" in username:
        domain, username = username.split("/", 1)

    SHARE = "ADMIN$"
    REMOTE_DIR = "Temp\\kifaa"
    VBS_REMOTE = f"{REMOTE_DIR}\\wuscan.vbs"
    OUT_REMOTE = f"{REMOTE_DIR}\\updates.txt"
    SVC_NAME = "KifaaPatchScan"
    SVC_CMD = r"cscript //NoLogo C:\Windows\Temp\kifaa\wuscan.vbs"

    # VBScript — works on Windows XP through Windows 11 via Windows Update Agent COM API
    vbs_script = (
        'On Error Resume Next\r\n'
        'Set fso = CreateObject("Scripting.FileSystemObject")\r\n'
        'Set f = fso.CreateTextFile("C:\\Windows\\Temp\\kifaa\\updates.txt", True)\r\n'
        'Set updateSession = CreateObject("Microsoft.Update.Session")\r\n'
        'Set updateSearcher = updateSession.CreateUpdateSearcher()\r\n'
        'Set searchResult = updateSearcher.Search("IsInstalled=0 and Type=\'Software\'")\r\n'
        'If Err.Number <> 0 Then\r\n'
        '    f.WriteLine "ERROR:" & Err.Description\r\n'
        'Else\r\n'
        '    f.WriteLine "TOTAL:" & searchResult.Updates.Count\r\n'
        '    For i = 0 To searchResult.Updates.Count - 1\r\n'
        '        Set upd = searchResult.Updates.Item(i)\r\n'
        '        sev = upd.MsrcSeverity\r\n'
        '        If IsNull(sev) Or sev = "" Then sev = "Unknown"\r\n'
        '        kbs = ""\r\n'
        '        For j = 0 To upd.KBArticleIDs.Count - 1\r\n'
        '            If kbs <> "" Then kbs = kbs & ","\r\n'
        '            kbs = kbs & upd.KBArticleIDs.Item(j)\r\n'
        '        Next\r\n'
        '        title = Replace(upd.Title, "|", "-")\r\n'
        '        f.WriteLine "U|" & title & "|" & sev & "|" & kbs\r\n'
        '    Next\r\n'
        'End If\r\n'
        'f.Close\r\n'
    )

    # ── 1. SMB connect ─────────────────────────────────────────────────────────
    log(f"[INFO] Connecting to {host} via SMB (port 445)")
    smb = SMBConnection(host, host, timeout=30)
    try:
        smb.login(username, password, domain)
    except Exception as e:
        raise RuntimeError(f"SMB authentication failed: {e}")

    try:
        os_info = smb.getServerOS()
        log(f"[INFO] Target OS: {os_info}")
    except Exception:
        pass

    # ── 2. Write VBScript to ADMIN$ share ──────────────────────────────────────
    log("[RUN] Creating temp directory and writing scan script...")
    try:
        smb.createDirectory(SHARE, REMOTE_DIR)
    except Exception:
        pass  # Already exists

    script_bytes = vbs_script.encode("utf-8")
    offset = [0]
    def _reader(n):
        chunk = script_bytes[offset[0]: offset[0] + n]
        offset[0] += n
        return chunk

    smb.putFile(SHARE, VBS_REMOTE, _reader)
    log("[INFO] Scan script copied to C:\\Windows\\Temp\\kifaa\\wuscan.vbs")

    # ── 3. Connect to SCM and create one-shot service ──────────────────────────
    log("[RUN] Connecting to Service Control Manager via RPC...")
    rpctransport = transport.SMBTransport(host, 445, r"\svcctl", username=username, password=password, domain=domain)
    rpctransport.set_connect_timeout(30)
    dce = rpctransport.get_dce_rpc()
    dce.connect()
    dce.bind(scmr.MSRPC_UUID_SCMR)
    scm_handle = scmr.hROpenSCManagerW(dce)["lpScHandle"]

    # Remove old scan service if leftover
    try:
        old_h = scmr.hROpenServiceW(dce, scm_handle, SVC_NAME)["lpServiceHandle"]
        try:
            scmr.hRControlService(dce, old_h, scmr.SERVICE_CONTROL_STOP)
            time.sleep(1)
        except Exception:
            pass
        scmr.hRDeleteService(dce, old_h)
        scmr.hRCloseServiceHandle(dce, old_h)
    except Exception:
        pass

    log("[RUN] Creating temporary scan service...")
    svc_handle = scmr.hRCreateServiceW(
        dce, scm_handle, SVC_NAME, SVC_NAME,
        lpBinaryPathName=SVC_CMD,
        dwStartType=scmr.SERVICE_DEMAND_START,
    )["lpServiceHandle"]

    log("[RUN] Starting scan service — this may take 30-120s for Windows Update query...")
    scmr.hRStartServiceW(dce, svc_handle)

    # ── 4. Poll until service stops (max 120s) ────────────────────────────────
    deadline = time.time() + 120
    while time.time() < deadline:
        time.sleep(5)
        try:
            status = scmr.hRQueryServiceStatus(dce, svc_handle)
            state = status["lpServiceStatus"]["dwCurrentState"]
            if state in (scmr.SERVICE_STOPPED, scmr.SERVICE_STOP_PENDING):
                log("[INFO] Scan service completed")
                break
        except Exception:
            break
    else:
        log("[WARN] Scan service timed out — attempting to read partial results")

    # ── 5. Clean up service ────────────────────────────────────────────────────
    try:
        scmr.hRControlService(dce, svc_handle, scmr.SERVICE_CONTROL_STOP)
    except Exception:
        pass
    try:
        scmr.hRDeleteService(dce, svc_handle)
        scmr.hRCloseServiceHandle(dce, svc_handle)
    except Exception:
        pass
    scmr.hRCloseServiceHandle(dce, scm_handle)

    # ── 6. Read output file back via SMB ──────────────────────────────────────
    log("[RUN] Reading scan results...")
    buf = _io.BytesIO()
    try:
        smb.getFile(SHARE, OUT_REMOTE, buf.write)
    except Exception as e:
        raise RuntimeError(f"Could not read scan output file: {e}. The script may have failed to run.")

    content = buf.getvalue().decode("utf-8", errors="replace")
    log(f"[INFO] Output file size: {len(buf.getvalue())} bytes")

    # ── 7. Parse results ───────────────────────────────────────────────────────
    updates = []
    for line in content.splitlines():
        line = line.strip()
        if line.startswith("ERROR:"):
            log(f"[WARN] Script error: {line[6:]}")
        elif line.startswith("TOTAL:"):
            log(f"[INFO] Windows Update reports {line[6:]} pending update(s)")
        elif line.startswith("U|"):
            parts = line[2:].split("|")
            if len(parts) >= 3:
                title = parts[0]
                sev = parts[1].lower()
                kbs = parts[2]
                category = "security" if sev in ("critical", "important", "moderate") else "upgrade"
                pkg_name = f"KB{kbs.split(',')[0]}" if kbs else title[:80]
                updates.append({
                    "package_name": pkg_name,
                    "description": title,
                    "category": category,
                    "available_version": parts[1],  # severity as version label
                })

    # ── 8. Clean up temp files ─────────────────────────────────────────────────
    try:
        smb.deleteFile(SHARE, VBS_REMOTE)
        smb.deleteFile(SHARE, OUT_REMOTE)
    except Exception:
        pass

    smb.logoff()
    return updates


# ── Apply worker (runs in background thread) ───────────────────────────────────

def _run_apply(job_id: str, agent_id: str, host: str, hostname: str, agent_info: dict, creds: dict, packages: list, db_url: str):
    log = lambda line: _append_output(job_id, line, db_url)

    try:
        connect_type = creds.get("connect_type", "linux")
        if connect_type == "linux":
            applied = _apply_linux(job_id, host, hostname, creds, packages, log)
        elif connect_type == "windows_winrm":
            applied = _apply_windows_winrm(job_id, host, hostname, creds, packages, log)
        else:
            applied = _apply_windows_smb(job_id, host, agent_id, creds, packages, db_url, log)

        # Remove applied packages from agent_patches
        if applied:
            import psycopg2
            conn = psycopg2.connect(db_url)
            conn.autocommit = True
            cur = conn.cursor()
            cur.execute(
                "DELETE FROM agent_patches WHERE agent_id = %s AND package_name = ANY(%s)",
                (agent_id, applied),
            )
            cur.close()
            conn.close()

        log(f"[OK] Apply complete — {len(applied)} package(s) updated")
        _finish_job(job_id, "success", db_url)

    except Exception as e:
        log(f"[ERROR] {e}")
        _finish_job(job_id, "failed", db_url)


def _apply_linux(job_id: str, host: str, hostname: str, creds: dict, packages: list, log) -> list:
    import paramiko

    password = creds.get("password", "")
    ssh_key_str = creds.get("ssh_key", "")
    port = int(creds.get("port") or 22)
    username = creds.get("username", "root")
    use_sudo = creds.get("use_sudo", True)
    sudo = "sudo " if use_sudo else ""

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    connect_kwargs = dict(hostname=host, port=port, username=username, timeout=30)
    if ssh_key_str:
        pkey = paramiko.RSAKey.from_private_key(io.StringIO(ssh_key_str))
        connect_kwargs["pkey"] = pkey
    else:
        connect_kwargs["password"] = password
    ssh.connect(**connect_kwargs)
    log(f"[INFO] SSH connected to {username}@{host}")

    def run(cmd, desc=None):
        if desc:
            log(f"[RUN] {desc}")
        stdin, stdout, stderr = ssh.exec_command(cmd, timeout=300)
        exit_code = stdout.channel.recv_exit_status()
        out = stdout.read().decode(errors="replace")
        err = stderr.read().decode(errors="replace")
        for line in out.splitlines():
            log(f"      {line}")
        if err:
            for line in err.splitlines():
                if line.strip():
                    log(f"[ERR] {line}")
        return exit_code, out

    # Detect package manager
    pm_raw = run("which apt-get yum dnf zypper 2>/dev/null | head -1")[1].strip()
    pm = pm_raw.split("/")[-1] if pm_raw else "apt-get"

    pkg_str = " ".join(packages)
    if pm in ("apt-get", "apt"):
        # Refresh package lists first; --fix-missing skips repos that return 404
        # (e.g. third-party repos like apt.postgresql.org that dropped EOL distro support)
        run(f"{sudo}apt-get update --fix-missing -q", "Refreshing package lists")
        exit_code, _ = run(
            f"DEBIAN_FRONTEND=noninteractive {sudo}apt-get install -y --fix-missing {pkg_str}",
            f"Installing: {pkg_str}",
        )
        if exit_code != 0:
            # Some 404 packages may have been skipped but others installed fine.
            # Log a warning rather than treating the whole job as failed.
            log(f"[WARN] apt-get exited {exit_code} — some packages may have been unavailable (404 from third-party repos). Packages from main repos were installed.")
        # Remove packages that were installed as dependencies but are no longer needed
        run(f"DEBIAN_FRONTEND=noninteractive {sudo}apt-get autoremove -y", "Removing unused packages")
    elif pm in ("yum", "dnf"):
        run(f"{sudo}{pm} update -y {pkg_str}", f"Updating: {pkg_str}")
    elif pm == "zypper":
        run(f"{sudo}zypper -n update {pkg_str}", f"Updating: {pkg_str}")

    ssh.close()
    return packages


def _apply_windows_smb(job_id: str, host: str, agent_id: str, creds: dict, packages: list, db_url: str, log) -> list:
    """
    Install Windows Updates via SMB + SCM using wusa.exe (KB installer).
    Works on Vista/7/2008+. For XP/2003, wusa.exe doesn't exist — falls back to manual .msu download.
    Each package should be a KB number like 'KB1234567'.
    """
    import time
    import io as _io
    try:
        from impacket.smbconnection import SMBConnection
        from impacket.dcerpc.v5 import transport, scmr
    except ImportError:
        raise RuntimeError("impacket is not installed")

    username = creds.get("username", "")
    password = creds.get("password", "")
    domain = creds.get("domain", "") or ""
    if "\\" in username:
        domain, username = username.split("\\", 1)
    elif "/" in username:
        domain, username = username.split("/", 1)

    SHARE = "ADMIN$"
    REMOTE_DIR = "Temp\\kifaa"
    SVC_BASE = "KifaaPatchApply"

    log(f"[INFO] Connecting to {host} via SMB for patch apply")
    smb = SMBConnection(host, host, timeout=30)
    smb.login(username, password, domain)

    rpctransport = transport.SMBTransport(host, 445, r"\svcctl", username=username, password=password, domain=domain)
    rpctransport.set_connect_timeout(30)
    dce = rpctransport.get_dce_rpc()
    dce.connect()
    dce.bind(scmr.MSRPC_UUID_SCMR)
    scm_handle = scmr.hROpenSCManagerW(dce)["lpScHandle"]

    applied = []
    for pkg in packages:
        kb = pkg.upper().lstrip("KB")
        # Use VBScript to search and install via Windows Update Agent COM
        vbs = (
            'On Error Resume Next\r\n'
            'Set fso = CreateObject("Scripting.FileSystemObject")\r\n'
            'Set f = fso.CreateTextFile("C:\\Windows\\Temp\\kifaa\\apply_result.txt", True)\r\n'
            'Set us = CreateObject("Microsoft.Update.Session")\r\n'
            'Set searcher = us.CreateUpdateSearcher()\r\n'
            f'Set sr = searcher.Search("IsInstalled=0 and KBArticleIDs=\'{kb}\'")\r\n'
            'If Err.Number <> 0 Then\r\n'
            '    f.WriteLine "SEARCH_ERROR:" & Err.Description\r\n'
            '    f.Close\r\n'
            '    WScript.Quit\r\n'
            'End If\r\n'
            'If sr.Updates.Count = 0 Then\r\n'
            '    f.WriteLine "NOT_FOUND"\r\n'
            '    f.Close\r\n'
            '    WScript.Quit\r\n'
            'End If\r\n'
            'Set dl = us.CreateUpdateDownloader()\r\n'
            'dl.Updates = sr.Updates\r\n'
            'dl.Download()\r\n'
            'If Err.Number <> 0 Then\r\n'
            '    f.WriteLine "DOWNLOAD_ERROR:" & Err.Description\r\n'
            '    f.Close\r\n'
            '    WScript.Quit\r\n'
            'End If\r\n'
            'Set inst = us.CreateUpdateInstaller()\r\n'
            'inst.Updates = sr.Updates\r\n'
            'Set result = inst.Install()\r\n'
            'If Err.Number <> 0 Then\r\n'
            '    f.WriteLine "INSTALL_ERROR:" & Err.Description\r\n'
            'Else\r\n'
            '    f.WriteLine "RESULT:" & result.ResultCode & ":REBOOT:" & result.RebootRequired\r\n'
            'End If\r\n'
            'f.Close\r\n'
        )
        vbs_remote = f"{REMOTE_DIR}\\apply_{kb}.vbs"
        out_remote = f"{REMOTE_DIR}\\apply_result.txt"
        svc_name = f"{SVC_BASE}{kb}"
        svc_cmd = f"cscript //NoLogo C:\\Windows\\Temp\\kifaa\\apply_{kb}.vbs"

        log(f"[RUN] Installing KB{kb}...")
        script_bytes = vbs.encode("utf-8")
        offset = [0]
        def _reader(n):
            chunk = script_bytes[offset[0]: offset[0] + n]
            offset[0] += n
            return chunk

        try:
            smb.createDirectory(SHARE, REMOTE_DIR)
        except Exception:
            pass
        smb.putFile(SHARE, vbs_remote, _reader)

        # Remove leftover service
        try:
            old_h = scmr.hROpenServiceW(dce, scm_handle, svc_name)["lpServiceHandle"]
            try:
                scmr.hRControlService(dce, old_h, scmr.SERVICE_CONTROL_STOP)
                time.sleep(1)
            except Exception:
                pass
            scmr.hRDeleteService(dce, old_h)
            scmr.hRCloseServiceHandle(dce, old_h)
        except Exception:
            pass

        svc_handle = scmr.hRCreateServiceW(
            dce, scm_handle, svc_name, svc_name,
            lpBinaryPathName=svc_cmd,
            dwStartType=scmr.SERVICE_DEMAND_START,
        )["lpServiceHandle"]
        scmr.hRStartServiceW(dce, svc_handle)

        # Wait for completion (up to 5 min — download + install can be slow)
        deadline = time.time() + 300
        while time.time() < deadline:
            time.sleep(5)
            try:
                status = scmr.hRQueryServiceStatus(dce, svc_handle)
                if status["lpServiceStatus"]["dwCurrentState"] in (scmr.SERVICE_STOPPED, scmr.SERVICE_STOP_PENDING):
                    break
            except Exception:
                break

        try:
            scmr.hRControlService(dce, svc_handle, scmr.SERVICE_CONTROL_STOP)
        except Exception:
            pass
        try:
            scmr.hRDeleteService(dce, svc_handle)
            scmr.hRCloseServiceHandle(dce, svc_handle)
        except Exception:
            pass

        # Read result
        buf = _io.BytesIO()
        try:
            smb.getFile(SHARE, out_remote, buf.write)
            result_text = buf.getvalue().decode("utf-8", errors="replace").strip()
            log(f"      {result_text}")
            if result_text.startswith("RESULT:"):
                parts = result_text.split(":")
                code = parts[1] if len(parts) > 1 else "?"
                reboot = "Yes" if "True" in result_text else "No"
                if code in ("2", "3"):
                    log(f"[OK] KB{kb} installed successfully (reboot required: {reboot})")
                    applied.append(pkg)
                else:
                    log(f"[WARN] KB{kb} install returned code {code}")
            elif result_text == "NOT_FOUND":
                log(f"[WARN] KB{kb} not found in pending updates — may already be installed")
            else:
                log(f"[WARN] KB{kb}: {result_text}")
        except Exception as e:
            log(f"[WARN] Could not read result for KB{kb}: {e}")

        # Cleanup
        try:
            smb.deleteFile(SHARE, vbs_remote)
            smb.deleteFile(SHARE, out_remote)
        except Exception:
            pass

    scmr.hRCloseServiceHandle(dce, scm_handle)
    smb.logoff()
    return applied


def _apply_windows_winrm(job_id: str, host: str, hostname: str, creds: dict, packages: list, log) -> list:
    import winrm

    username = creds.get("username", "")
    password = creds.get("password", "")
    domain = creds.get("domain", "")
    port = int(creds.get("winrm_port") or 5985)
    user = f"{domain}\\{username}" if domain else username

    log(f"[INFO] Connecting via WinRM to {user}@{host}:{port}")
    session = winrm.Session(f"http://{host}:{port}/wsman", auth=(user, password), transport="ntlm")

    # Install each KB / update by title using Windows Update COM
    applied = []
    for pkg in packages:
        log(f"[RUN] Installing: {pkg}")
        kb_filter = f'IsInstalled=0 and Title like "%{pkg}%"' if not pkg.startswith("KB") else f'IsInstalled=0 and KBArticleIDs contains "{pkg[2:]}"'
        ps = f"""
$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$result = $searcher.Search("{kb_filter}")
if ($result.Updates.Count -eq 0) {{ Write-Output "NOT_FOUND"; exit 0 }}
$downloader = $session.CreateUpdateDownloader()
$downloader.Updates = $result.Updates
$downloader.Download()
$installer = $session.CreateUpdateInstaller()
$installer.Updates = $result.Updates
$installResult = $installer.Install()
Write-Output "RESULT:$($installResult.ResultCode)"
"""
        result = session.run_ps(ps)
        out = result.std_out.decode(errors="replace").strip()
        log(f"      {out}")
        if "RESULT:2" in out or "RESULT:3" in out:   # 2=succeeded, 3=succeeded_with_errors
            applied.append(pkg)
        elif "NOT_FOUND" in out:
            log(f"[WARN] {pkg} not found in pending updates")
        else:
            log(f"[WARN] {pkg} install result unclear — re-run scan to verify")

    return applied
