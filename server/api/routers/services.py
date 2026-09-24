"""
Service control: start, stop, restart services on agents.
Service monitor: watch specific services and auto-restart them when stopped.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
import uuid, json as _json

from api.database import get_db
from api.models.models import Agent, Service
from api.services.auth import get_current_user, get_agent_by_api_key, require_operator
from fastapi import Header

async def get_current_agent(
    x_api_key: str = Header(..., alias="X-API-Key"),
    db: AsyncSession = Depends(get_db),
) -> Agent:
    agent = await get_agent_by_api_key(db, x_api_key)
    if not agent:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return agent

router = APIRouter()


# ─── Dispatch service control command (user-facing) ──────────────────────────

@router.post("/agents/{agent_id}/service-control")
async def service_control(
    agent_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    service_name = body.get("service_name", "").strip()
    action = body.get("action", "").strip()
    if not service_name or not action:
        raise HTTPException(status_code=400, detail="service_name and action required")
    if action not in ("start", "stop", "restart"):
        raise HTTPException(status_code=400, detail="action must be start, stop, or restart")

    # Verify agent exists
    row = await db.execute(text("SELECT id FROM agents WHERE id = CAST(:id AS uuid) AND is_active = TRUE"), {"id": agent_id})
    if not row.fetchone():
        raise HTTPException(status_code=404, detail="Agent not found")

    payload = _json.dumps({"service_name": service_name, "action": action})
    await db.execute(text("""
        INSERT INTO agent_commands (agent_id, command_type, payload)
        VALUES (CAST(:aid AS uuid), 'service_control', CAST(:payload AS jsonb))
    """), {"aid": agent_id, "payload": payload})
    await db.commit()
    return {"status": "queued", "service_name": service_name, "action": action}


# ─── Agent-facing: service control result ────────────────────────────────────

@router.post("/agents/service-control-result")
async def service_control_result(
    body: dict,
    db: AsyncSession = Depends(get_db),
    agent: Agent = Depends(get_current_agent),
):
    service_name = body.get("service_name", "")
    action = body.get("action", "")
    new_status = body.get("new_status", "")
    success = body.get("success", False)
    message = body.get("message", "")

    if service_name and new_status:
        status_map = {
            "running": "running", "stopped": "stopped", "failed": "failed",
            "starting": "starting", "stopping": "stopping",
        }
        db_status = status_map.get(new_status, new_status)
        await db.execute(text("""
            UPDATE services SET status = :status
            WHERE agent_id = CAST(:aid AS uuid) AND service_name = :svc
        """), {"status": db_status, "aid": str(agent.id), "svc": service_name})

    # For start actions on monitored services, log the outcome
    if service_name and action in ("start", "restart"):
        row = await db.execute(text("""
            SELECT display_name FROM services
            WHERE agent_id = CAST(:aid AS uuid) AND service_name = :svc AND monitored = TRUE
        """), {"aid": str(agent.id), "svc": service_name})
        svc_row = row.fetchone()
        if svc_row:
            display_name = svc_row[0]
            event_type = "start_succeeded" if success else "start_failed"
            await db.execute(text("""
                INSERT INTO service_monitor_events
                    (agent_id, service_name, display_name, event_type, old_status, success, message)
                VALUES (CAST(:aid AS uuid), :svc, :display, :etype, :old_status, :success, :message)
            """), {
                "aid": str(agent.id),
                "svc": service_name,
                "display": display_name,
                "etype": event_type,
                "old_status": new_status if not success else None,
                "success": success,
                "message": message or None,
            })

    await db.commit()
    return {"status": "ok", "success": success}


# ─── Service Monitor ─────────────────────────────────────────────────────────

@router.get("/service-monitor/monitored")
async def list_monitored_services(
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """List all services marked for monitoring, with current status and agent info."""
    rows = await db.execute(text("""
        SELECT s.id, s.service_name, s.display_name, s.status, s.startup_type,
               s.monitored, s.auto_restart, s.last_updated,
               a.id AS agent_id, a.hostname, a.display_name AS agent_display,
               a.os_type, a.status AS agent_status
        FROM services s
        JOIN agents a ON a.id = s.agent_id
        WHERE s.monitored = TRUE AND a.is_active = TRUE AND a.exclude_from_reports = FALSE
        ORDER BY a.hostname, s.display_name
    """))
    results = []
    for r in rows.fetchall():
        results.append({
            "id": str(r[0]),
            "service_name": r[1],
            "display_name": r[2],
            "status": r[3],
            "startup_type": r[4],
            "monitored": r[5],
            "auto_restart": r[6],
            "last_updated": r[7].isoformat() if r[7] else None,
            "agent_id": str(r[8]),
            "hostname": r[9],
            "agent_display": r[10],
            "os_type": r[11],
            "agent_status": r[12],
        })
    return results


@router.get("/service-monitor/events")
async def list_monitor_events(
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """Recent auto-restart events."""
    rows = await db.execute(text("""
        SELECT e.id, e.service_name, e.display_name, e.event_type, e.old_status,
               e.success, e.message, e.triggered_at,
               a.hostname, a.display_name AS agent_display
        FROM service_monitor_events e
        JOIN agents a ON a.id = e.agent_id AND a.exclude_from_reports = FALSE
        ORDER BY e.triggered_at DESC
        LIMIT :limit
    """), {"limit": limit})
    results = []
    for r in rows.fetchall():
        results.append({
            "id": str(r[0]),
            "service_name": r[1],
            "display_name": r[2],
            "event_type": r[3],
            "old_status": r[4],
            "success": r[5],
            "message": r[6],
            "triggered_at": r[7].isoformat() if r[7] else None,
            "hostname": r[8],
            "agent_display": r[9],
        })
    return results


@router.patch("/services/{service_id}/monitor")
async def update_service_monitor(
    service_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """Enable/disable monitoring and auto-restart for a service."""
    monitored = body.get("monitored")
    auto_restart = body.get("auto_restart")
    updates = {}
    if monitored is not None:
        updates["monitored"] = bool(monitored)
    if auto_restart is not None:
        updates["auto_restart"] = bool(auto_restart)
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")

    set_clause = ", ".join(f"{k} = :{k}" for k in updates)
    updates["sid"] = service_id
    await db.execute(
        text(f"UPDATE services SET {set_clause} WHERE id = CAST(:sid AS uuid)"),
        updates,
    )
    await db.commit()
    return {"status": "ok"}


@router.get("/services/search")
async def search_services(
    q: str = "",
    agent_id: str = "",
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """Search services by name across all agents (for adding to monitor)."""
    params: dict = {"q": f"%{q}%"}
    agent_filter = ""
    if agent_id:
        agent_filter = "AND a.id = CAST(:agent_id AS uuid)"
        params["agent_id"] = agent_id
    rows = await db.execute(text(f"""
        SELECT s.id, s.service_name, s.display_name, s.status, s.startup_type,
               s.monitored, s.auto_restart,
               a.id AS agent_id, a.hostname, a.display_name AS agent_display, a.os_type
        FROM services s
        JOIN agents a ON a.id = s.agent_id
        WHERE a.is_active = TRUE
          AND (s.service_name ILIKE :q OR s.display_name ILIKE :q)
          {agent_filter}
        ORDER BY a.hostname, s.display_name
        LIMIT 100
    """), params)
    results = []
    for r in rows.fetchall():
        results.append({
            "id": str(r[0]),
            "service_name": r[1],
            "display_name": r[2],
            "status": r[3],
            "startup_type": r[4],
            "monitored": r[5],
            "auto_restart": r[6],
            "agent_id": str(r[7]),
            "hostname": r[8],
            "agent_display": r[9],
            "os_type": r[10],
        })
    return results


@router.post("/service-monitor/internal/check")
async def internal_service_monitor_check(db: AsyncSession = Depends(get_db)):
    """
    Called by Celery every 2 minutes.
    For each monitored + auto_restart service that is 'stopped' on an online agent,
    queue a service_control start command (if one isn't already pending) and log the event.
    """
    rows = await db.execute(text("""
        SELECT s.id, s.service_name, s.display_name, s.agent_id
        FROM services s
        JOIN agents a ON a.id = s.agent_id
        WHERE s.monitored = TRUE
          AND s.auto_restart = TRUE
          AND s.status = 'stopped'
          AND a.is_active = TRUE
          AND a.status = 'online'
    """))
    services = rows.fetchall()
    queued = 0
    for svc in services:
        svc_id, svc_name, display_name, agent_id = svc
        aid = str(agent_id)

        # Skip if a start command is already pending for this service
        existing = await db.execute(text("""
            SELECT id FROM agent_commands
            WHERE agent_id = CAST(:aid AS uuid)
              AND command_type = 'service_control'
              AND payload->>'service_name' = :svc
              AND payload->>'action' = 'start'
              AND picked_up_at IS NULL
        """), {"aid": aid, "svc": svc_name})
        if existing.fetchone():
            continue

        # Queue start command
        await db.execute(text("""
            INSERT INTO agent_commands (agent_id, command_type, payload)
            VALUES (CAST(:aid AS uuid), 'service_control', CAST(:payload AS jsonb))
        """), {"aid": aid, "payload": _json.dumps({"service_name": svc_name, "action": "start"})})

        # Log the auto-restart event
        await db.execute(text("""
            INSERT INTO service_monitor_events (agent_id, service_name, display_name, event_type, old_status)
            VALUES (CAST(:aid AS uuid), :svc, :display, 'auto_restart', 'stopped')
        """), {"aid": aid, "svc": svc_name, "display": display_name})

        queued += 1

    await db.commit()
    return {"status": "ok", "restarted": queued}
