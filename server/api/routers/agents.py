from fastapi import APIRouter, Depends, HTTPException, Header, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, text
from sqlalchemy.orm import selectinload
from typing import Optional, List
from datetime import datetime, timezone, timedelta
import uuid

from api.database import get_db
from api.models.models import Agent, AgentGroup, HardwareInventory, SoftwareInventory, Service, AuditLog
from api.schemas.schemas import (
    AgentRegisterRequest, AgentRegisterResponse,
    HeartbeatRequest, HeartbeatResponse,
    AgentResponse, AgentDetailResponse,
    InventoryReport, DashboardStats,
)
from api.services.auth import generate_api_key, get_agent_by_api_key, get_current_user, require_operator, require_admin
from api.config import get_settings

settings = get_settings()
router = APIRouter(prefix="/agents", tags=["Agents"])


async def get_current_agent(
    x_api_key: str = Header(..., alias="X-API-Key"),
    db: AsyncSession = Depends(get_db)
) -> Agent:
    agent = await get_agent_by_api_key(db, x_api_key)
    if not agent:
        raise HTTPException(status_code=401, detail="Invalid or expired API key")
    return agent


# ─── Registration ────────────────────────────
@router.post("/register", response_model=AgentRegisterResponse, status_code=201)
async def register_agent(body: AgentRegisterRequest, request: Request, db: AsyncSession = Depends(get_db)):
    if body.registration_secret != settings.agent_registration_secret:
        raise HTTPException(status_code=403, detail="Invalid registration secret")

    # Check if agent already registered by hostname + IP
    result = await db.execute(
        select(Agent).where(
            Agent.hostname == body.hostname,
            Agent.is_active == True
        )
    )
    existing = result.scalar_one_or_none()

    if existing:
        # Re-registration: issue new API key
        existing.api_key = generate_api_key()
        existing.ip_address = body.ip_address or request.client.host
        existing.agent_version = body.agent_version
        existing.os_name = body.os_name
        existing.os_version = body.os_version
        existing.last_seen = datetime.now(timezone.utc)
        existing.status = "online"
        await db.commit()
        return AgentRegisterResponse(
            agent_id=str(existing.id),
            api_key=existing.api_key,
            message="Re-registered successfully",
            server_time=datetime.now(timezone.utc)
        )

    # Community edition: 25 agent limit
    count_result = await db.execute(text("SELECT COUNT(*) FROM agents WHERE is_active = TRUE"))
    if (count_result.scalar() or 0) >= 25:
        raise HTTPException(
            status_code=403,
            detail="Community edition limit reached: maximum 25 agents. Visit https://github.com/mtaalamtech/kifaa-community for upgrade options."
        )

    api_key = generate_api_key()
    agent_id = uuid.uuid4()
    agent = Agent(
        id=agent_id,
        hostname=body.hostname,
        display_name=body.hostname,
        ip_address=body.ip_address or (request.client.host if request.client else None),
        mac_address=body.mac_address,
        os_type=body.os_type,
        os_name=body.os_name,
        os_version=body.os_version,
        os_arch=body.os_arch,
        agent_version=body.agent_version,
        agent_type=body.agent_type,
        status="online",
        last_seen=datetime.now(timezone.utc),
        api_key=api_key,
        agent_metadata=body.metadata or {},
    )
    db.add(agent)

    log = AuditLog(
        agent_id=agent_id,
        action="agent_registered",
        resource_type="agent",
        resource_id=str(agent_id),
        ip_address=request.client.host if request.client else None,
        details={"hostname": body.hostname, "os": body.os_name}
    )
    db.add(log)
    await db.flush()  # persist agent + audit log so FK in agent_history is valid
    await _log_history(db, agent_id, "registered", details={"hostname": body.hostname, "os": body.os_name, "version": body.agent_version})
    await db.commit()

    return AgentRegisterResponse(
        agent_id=str(agent_id),
        api_key=api_key,
        message="Agent registered successfully",
        server_time=datetime.now(timezone.utc)
    )


# ─── Heartbeat ───────────────────────────────
@router.post("/heartbeat", response_model=HeartbeatResponse)
async def heartbeat(
    body: HeartbeatRequest,
    agent: Agent = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db)
):
    agent.last_seen = datetime.now(timezone.utc)
    old_status = agent.status
    old_ip = agent.ip_address
    old_version = agent.agent_version
    agent.status = "online"
    # Resolve any open offline alerts when the agent checks back in
    if old_status == "offline":
        await db.execute(text("""
            UPDATE alerts SET status = 'resolved', resolved_at = NOW()
            WHERE agent_id = CAST(:aid AS uuid)
              AND source = 'watchdog'
              AND status = 'open'
        """), {"aid": str(agent.id)})
    if body.ip_address:
        agent.ip_address = body.ip_address
    if body.agent_version and body.agent_version != agent.agent_version:
        agent.agent_version = body.agent_version
    if body.restart_pending is not None:
        agent.restart_pending = body.restart_pending
    if body.os_name and body.os_name != agent.os_name:
        agent.os_name = body.os_name
    if body.os_version and body.os_version != agent.os_version:
        agent.os_version = body.os_version
    if body.hostname and body.hostname != agent.hostname:
        await _log_history(db, agent.id, "hostname_change", field="hostname",
                           old_value=agent.hostname, new_value=body.hostname)
        # Also update display_name if it was never manually customised
        # (i.e. it still matches the old hostname)
        if agent.display_name == agent.hostname:
            agent.display_name = body.hostname
        agent.hostname = body.hostname

    # Write metrics to TimescaleDB via parameterized queries (prevents SQL injection)
    if body.metrics:
        import json as _json
        ts = body.timestamp or datetime.now(timezone.utc)
        for m in body.metrics:
            await db.execute(
                text(
                    "INSERT INTO metrics (time, agent_id, metric_name, value, tags) "
                    "VALUES (:ts, :aid, :name, :val, CAST(:tags AS jsonb))"
                ),
                {
                    "ts": ts,
                    "aid": str(agent.id),
                    "name": str(m.name)[:128],
                    "val": float(m.value),
                    "tags": _json.dumps(m.tags or {}),
                },
            )

    # Update services
    if body.services:
        for svc_data in body.services:
            result = await db.execute(
                select(Service).where(
                    Service.agent_id == agent.id,
                    Service.service_name == svc_data.service_name
                )
            )
            svc = result.scalar_one_or_none()
            if svc:
                svc.status = svc_data.status
                svc.pid = svc_data.pid
                svc.display_name = svc_data.display_name
                svc.last_updated = datetime.now(timezone.utc)
            else:
                svc = Service(
                    agent_id=agent.id,
                    service_name=svc_data.service_name,
                    display_name=svc_data.display_name,
                    status=svc_data.status,
                    startup_type=svc_data.startup_type,
                    pid=svc_data.pid,
                    exe_path=svc_data.exe_path,
                )
                db.add(svc)

    # Fetch any pending commands for this agent and mark them picked up
    pending_cmds_result = await db.execute(
        text("SELECT id, command_type, payload FROM agent_commands WHERE agent_id = :aid AND picked_up_at IS NULL ORDER BY created_at"),
        {"aid": agent.id},
    )
    pending_rows = pending_cmds_result.fetchall()
    commands = [{"id": str(r[0]), "type": r[1], "payload": r[2] or {}} for r in pending_rows]
    if pending_rows:
        ids = [str(r[0]) for r in pending_rows]
        await db.execute(
            text("UPDATE agent_commands SET picked_up_at = NOW() WHERE id = ANY(:ids)"),
            {"ids": ids},
        )
        # Mark any apply_patches jobs as running now that the agent has the command
        for r in pending_rows:
            if r[1] == "apply_patches":
                job_id = (r[2] or {}).get("job_id")
                if job_id:
                    await db.execute(
                        text("UPDATE patch_jobs SET status='running', started_at=NOW() WHERE id=:jid AND status='pending'"),
                        {"jid": job_id},
                    )

    # Detect restart comeback: if agent was marked as_restarting and is now sending heartbeat
    if agent.is_restarting:
        comeback_job_id = str(agent.restarting_job_id) if agent.restarting_job_id else ""
        comeback_hostname = agent.hostname
        # Fetch cycle name from maintenance history
        comeback_cycle = "Maintenance Cycle"
        try:
            if comeback_job_id:
                cycle_row = await db.execute(
                    text("""
                        SELECT COALESCE(mc.name, 'Maintenance Cycle')
                        FROM maintenance_history mh
                        LEFT JOIN maintenance_cycles mc ON mc.id = mh.cycle_id
                        WHERE mh.patch_job_id = CAST(:jid AS uuid)
                        LIMIT 1
                    """),
                    {"jid": comeback_job_id},
                )
                r = cycle_row.fetchone()
                if r:
                    comeback_cycle = r[0]
        except Exception:
            pass
        # Clear restart flag
        await db.execute(
            text("UPDATE agents SET is_restarting=FALSE, restarting_job_id=NULL WHERE id=:aid"),
            {"aid": str(agent.id)},
        )
        # Queue restart-done notification
        try:
            from api.workers.celery_app import celery_app as _celery
            _celery.send_task(
                "api.workers.tasks.notify_restart_done",
                kwargs={
                    "hostname":   comeback_hostname,
                    "cycle_name": comeback_cycle,
                    "job_id":     comeback_job_id,
                    "success":    True,
                },
            )
        except Exception:
            pass

    # Log significant state changes
    if old_status != "online":
        await _log_history(db, agent.id, "status_change", field="status", old_value=old_status, new_value="online")
    if body.ip_address and old_ip and old_ip != body.ip_address:
        await _log_history(db, agent.id, "ip_change", field="ip_address", old_value=old_ip, new_value=body.ip_address)
    if body.agent_version and old_version and body.agent_version != old_version:
        await _log_history(db, agent.id, "version_change", field="agent_version", old_value=old_version, new_value=body.agent_version)

    await db.commit()

    return HeartbeatResponse(
        status="ok",
        server_time=datetime.now(timezone.utc),
        pending_commands=commands,
    )


# ─── Inventory Upload ────────────────────────
@router.post("/inventory")
async def upload_inventory(
    body: InventoryReport,
    agent: Agent = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db)
):
    if body.hardware:
        hw_data = body.hardware
        result = await db.execute(
            select(HardwareInventory).where(HardwareInventory.agent_id == agent.id)
        )
        hw = result.scalar_one_or_none()
        if hw:
            for field, val in hw_data.model_dump(exclude_none=True).items():
                setattr(hw, field, val)
        else:
            hw = HardwareInventory(agent_id=agent.id, **hw_data.model_dump(exclude_none=True))
            db.add(hw)

    if body.software:
        # Delete existing and re-insert for simplicity (can be optimised later)
        await db.execute(text("DELETE FROM software_inventory WHERE agent_id = :aid"), {"aid": str(agent.id)})
        for sw in body.software:
            sw_data = sw.model_dump(exclude_none=True)
            # Truncate to column limits to avoid DB errors on long strings
            if "name" in sw_data and sw_data["name"]:
                sw_data["name"] = sw_data["name"][:255]
            if "version" in sw_data and sw_data["version"]:
                sw_data["version"] = sw_data["version"][:100]
            if "publisher" in sw_data and sw_data["publisher"]:
                sw_data["publisher"] = sw_data["publisher"][:255]
            if "install_date" in sw_data and sw_data["install_date"]:
                sw_data["install_date"] = sw_data["install_date"][:20]
            item = SoftwareInventory(agent_id=agent.id, **sw_data)
            db.add(item)

    try:
        await db.commit()
    except Exception as exc:
        await db.rollback()
        import logging
        logging.getLogger(__name__).error("Inventory commit failed for agent %s: %s", agent.id, exc)
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail=f"Inventory save failed: {exc}")

    # Trigger CVE matching in background (non-blocking)
    if body.software:
        import asyncio
        from api.services.cve_matcher import match_agent_cves
        from api.database import AsyncSessionLocal
        async def _run_cve_match():
            async with AsyncSessionLocal() as bg_db:
                await match_agent_cves(str(agent.id), bg_db)
        asyncio.create_task(_run_cve_match())

    return {"status": "ok", "message": "Inventory updated"}


# ─── Agents Report (with hardware + counts) ──
@router.get("/report")
async def agents_report(
    status: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Returns agents with hardware, software count and service count for reports."""
    q = """
        SELECT
            CAST(a.id AS text), a.hostname, a.display_name, a.description, a.ip_address, a.os_type,
            a.os_name, a.os_version, a.os_arch, a.agent_version, a.agent_type,
            a.status, a.last_seen, a.registered_at,
            h.cpu_model, h.cpu_cores, h.cpu_threads, h.ram_total_gb,
            h.disks, h.serial_number, h.asset_tag,
            h.bios_vendor, h.bios_version, h.motherboard_model,
            (SELECT COUNT(*) FROM software_inventory si WHERE si.agent_id = a.id) AS software_count,
            (SELECT COUNT(*) FROM services sv WHERE sv.agent_id = a.id) AS service_count,
            (SELECT COUNT(*) FROM services sv WHERE sv.agent_id = a.id AND sv.status = 'stopped') AS stopped_services
        FROM agents a
        LEFT JOIN hardware_inventory h ON h.agent_id = a.id
        WHERE a.is_active = TRUE AND a.exclude_from_reports = FALSE
    """
    params = {}
    if status:
        q += " AND a.status = :status"
        params["status"] = status
    q += " ORDER BY a.hostname"

    result = await db.execute(text(q), params)
    cols = ["id","hostname","display_name","description","ip_address","os_type","os_name","os_version",
            "os_arch","agent_version","agent_type","status","last_seen","registered_at",
            "cpu_model","cpu_cores","cpu_threads","ram_total_gb","disks","serial_number",
            "asset_tag","bios_vendor","bios_version","motherboard_model",
            "software_count","service_count","stopped_services"]
    agents = []
    for row in result.fetchall():
        d = dict(zip(cols, row))
        # Nest hardware fields
        d["hardware"] = {
            "cpu_model": d.pop("cpu_model"),
            "cpu_cores": d.pop("cpu_cores"),
            "cpu_threads": d.pop("cpu_threads"),
            "ram_total_gb": float(d.pop("ram_total_gb")) if d.get("ram_total_gb") else None,
            "disks": d.pop("disks") or [],
            "serial_number": d.pop("serial_number"),
            "asset_tag": d.pop("asset_tag"),
            "bios_vendor": d.pop("bios_vendor"),
            "bios_version": d.pop("bios_version"),
            "motherboard_model": d.pop("motherboard_model"),
        }
        d["last_seen"] = d["last_seen"].isoformat() if d["last_seen"] else None
        d["registered_at"] = d["registered_at"].isoformat() if d["registered_at"] else None
        agents.append(d)
    return agents


# ─── Fast Command Poll ───────────────────────────────────────────────────────

@router.get("/commands")
async def poll_commands(agent: Agent = Depends(get_current_agent), db: AsyncSession = Depends(get_db)):
    """Lightweight endpoint for agents to poll pending commands every 5 seconds.
    Returns pending commands without processing metrics, enabling near-immediate
    delivery of user actions (unlock, sync, etc.)."""
    result = await db.execute(
        text("SELECT id, command_type, payload FROM agent_commands WHERE agent_id = :aid AND picked_up_at IS NULL ORDER BY created_at"),
        {"aid": agent.id},
    )
    rows = result.fetchall()
    if not rows:
        return {"commands": []}

    commands = [{"id": str(r[0]), "type": r[1], "payload": r[2] or {}} for r in rows]
    ids = [str(r[0]) for r in rows]
    await db.execute(
        text("UPDATE agent_commands SET picked_up_at = NOW() WHERE id = ANY(:ids)"),
        {"ids": ids},
    )
    for r in rows:
        if r[1] == "apply_patches":
            job_id = (r[2] or {}).get("job_id")
            if job_id:
                await db.execute(
                    text("UPDATE patch_jobs SET status='running', started_at=NOW() WHERE id=:jid AND status='pending'"),
                    {"jid": job_id},
                )
    await db.commit()
    return {"commands": commands}


# ─── List Agents ─────────────────────────────
@router.get("", response_model=List[AgentResponse])
async def list_agents(
    status: Optional[str] = None,
    os_type: Optional[str] = None,
    group_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    q = """
        SELECT
            a.id, a.hostname, a.display_name, a.ip_address, a.os_type, a.os_name,
            a.os_version, a.os_arch, a.agent_version, a.agent_type, a.status,
            a.last_seen, a.registered_at, a.tags, a.group_id, a.asset_type,
            g.name AS group_name, g.color AS group_color,
            COALESCE(a.restart_pending, FALSE) AS restart_pending,
            a.description,
            COALESCE(a.exclude_from_reports, FALSE) AS exclude_from_reports
        FROM agents a
        LEFT JOIN agent_groups g ON g.id = a.group_id
        WHERE a.is_active = TRUE
    """
    params = {}
    if status:
        q += " AND a.status = :status"
        params["status"] = status
    if os_type:
        q += " AND a.os_type = :os_type"
        params["os_type"] = os_type
    if group_id:
        q += " AND a.group_id = :group_id"
        params["group_id"] = group_id
    q += " ORDER BY a.hostname"

    rows = await db.execute(text(q), params)
    cols = ["id", "hostname", "display_name", "ip_address", "os_type", "os_name",
            "os_version", "os_arch", "agent_version", "agent_type", "status",
            "last_seen", "registered_at", "tags", "group_id", "asset_type",
            "group_name", "group_color", "restart_pending", "description",
            "exclude_from_reports"]
    result = []
    for row in rows.fetchall():
        d = dict(zip(cols, row))
        d["id"] = d["id"]
        d["tags"] = d["tags"] or []
        result.append(AgentResponse(**d))
    return result


# ─── Get Agent ───────────────────────────────
@router.get("/{agent_id}", response_model=AgentDetailResponse)
async def get_agent(agent_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(
        select(Agent)
        .options(selectinload(Agent.hardware))
        .where(Agent.id == uuid.UUID(agent_id))
    )
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    sw_count = await db.execute(
        select(func.count()).where(SoftwareInventory.agent_id == agent.id)
    )
    svc_count = await db.execute(
        select(func.count()).where(Service.agent_id == agent.id)
    )

    # Build hardware dict before model_validate (avoids ORM object in Pydantic)
    hw_dict = None
    if agent.hardware:
        hw = agent.hardware
        hw_dict = {
            "cpu_model": hw.cpu_model,
            "cpu_cores": hw.cpu_cores,
            "cpu_threads": hw.cpu_threads,
            "ram_total_gb": float(hw.ram_total_gb) if hw.ram_total_gb else None,
            "disks": hw.disks or [],
            "nics": hw.nics or [],
            "gpu": hw.gpu or [],
            "serial_number": hw.serial_number,
            "asset_tag": hw.asset_tag,
            "bios_vendor": hw.bios_vendor,
            "bios_version": hw.bios_version,
            "motherboard_model": hw.motherboard_model,
        }

    # Fetch group info
    group_name = None
    group_color = None
    if agent.group_id:
        grp_row = await db.execute(
            text("SELECT name, color FROM agent_groups WHERE id = :id"),
            {"id": str(agent.group_id)},
        )
        grp = grp_row.fetchone()
        if grp:
            group_name, group_color = grp[0], grp[1]

    response = AgentDetailResponse(
        id=agent.id,
        hostname=agent.hostname,
        display_name=agent.display_name,
        ip_address=agent.ip_address,
        os_type=agent.os_type,
        os_name=agent.os_name,
        os_version=agent.os_version,
        os_arch=agent.os_arch,
        agent_version=agent.agent_version,
        agent_type=agent.agent_type,
        status=agent.status,
        last_seen=agent.last_seen,
        registered_at=agent.registered_at,
        tags=agent.tags or [],
        group_id=agent.group_id,
        group_name=group_name,
        group_color=group_color,
        asset_type=agent.asset_type,
        hardware=hw_dict,
        software_count=sw_count.scalar() or 0,
        service_count=svc_count.scalar() or 0,
        exclude_from_reports=agent.exclude_from_reports or False,
    )
    return response


# ─── Patch Agent ────────────────────────────
@router.patch("/{agent_id}")
async def patch_agent(
    agent_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_operator),
):
    """Update group_id, asset_type, display_name, description, and/or tags for an agent."""
    agent_row = await db.execute(
        text("SELECT id, group_id, display_name, asset_type, description, tags FROM agents WHERE id = :aid AND is_active = TRUE"),
        {"aid": agent_id},
    )
    agent_row = agent_row.fetchone()
    if not agent_row:
        raise HTTPException(status_code=404, detail="Agent not found")

    old_group_id = str(agent_row[1]) if agent_row[1] else None
    updates = {}

    if "group_id" in body:
        new_gid = body["group_id"]
        if new_gid is not None:
            # validate group exists
            grp = await db.execute(
                text("SELECT id FROM agent_groups WHERE id = :id"),
                {"id": new_gid},
            )
            if not grp.fetchone():
                raise HTTPException(status_code=400, detail="Group not found")
        updates["group_id"] = new_gid

    if "asset_type" in body:
        updates["asset_type"] = body["asset_type"]

    if "display_name" in body:
        updates["display_name"] = body["display_name"]

    if "description" in body:
        updates["description"] = body["description"] or None

    if "tags" in body:
        import json as _json
        updates["tags"] = _json.dumps(body["tags"] or [])

    if "exclude_from_reports" in body:
        updates["exclude_from_reports"] = bool(body["exclude_from_reports"])

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    set_parts = []
    params: dict = {"aid": agent_id}
    for k, v in updates.items():
        if k == "tags":
            set_parts.append(f"{k} = CAST(:{k} AS jsonb)")
        else:
            set_parts.append(f"{k} = :{k}")
        params[k] = v

    await db.execute(
        text(f"UPDATE agents SET {', '.join(set_parts)} WHERE id = :aid"),
        params,
    )

    # Log group_id change to agent_history
    if "group_id" in updates:
        new_gid = updates["group_id"]
        await _log_history(
            db, agent_id, "group_changed",
            field="group_id",
            old_value=old_group_id,
            new_value=str(new_gid) if new_gid else None,
            triggered_by="user",
        )

    await db.commit()
    return {"status": "ok", "updated": list(updates.keys())}


# ─── Dashboard Stats ─────────────────────────
@router.get("/stats/dashboard", response_model=DashboardStats)
async def dashboard_stats(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    total = await db.execute(select(func.count()).select_from(Agent).where(Agent.is_active == True))
    online = await db.execute(select(func.count()).select_from(Agent).where(Agent.status == "online", Agent.is_active == True))
    offline = await db.execute(select(func.count()).select_from(Agent).where(Agent.status == "offline", Agent.is_active == True))
    warning = await db.execute(select(func.count()).select_from(Agent).where(Agent.status == "warning", Agent.is_active == True))

    from api.models.models import Alert
    total_alerts = await db.execute(select(func.count()).select_from(Alert))
    open_alerts = await db.execute(select(func.count()).select_from(Alert).where(Alert.status == "open"))
    critical = await db.execute(select(func.count()).select_from(Alert).where(Alert.status == "open", Alert.severity == "critical"))

    # OS type breakdown
    os_result = await db.execute(text("""
        SELECT os_type, COUNT(*) AS cnt
        FROM agents
        WHERE is_active = TRUE
        GROUP BY os_type
    """))
    os_counts = {(r[0] or "unknown").lower(): r[1] for r in os_result.fetchall()}

    # Agent version breakdown
    ver_result = await db.execute(text("""
        SELECT
            os_type,
            COALESCE(agent_version, 'unknown') AS agent_version,
            COUNT(*) AS cnt
        FROM agents
        WHERE is_active = TRUE
        GROUP BY os_type, agent_version
        ORDER BY os_type, cnt DESC
    """))
    version_breakdown = [
        {"os_type": (r[0] or "unknown").lower(), "version": r[1], "count": r[2]}
        for r in ver_result.fetchall()
    ]

    result = DashboardStats(
        total_agents=total.scalar(),
        online_agents=online.scalar(),
        offline_agents=offline.scalar(),
        warning_agents=warning.scalar(),
        total_alerts=total_alerts.scalar(),
        open_alerts=open_alerts.scalar(),
        critical_alerts=critical.scalar(),
    )
    # Attach extra fields as dict (schema allows extra via model_config)
    return {
        **result.model_dump(),
        "windows_agents": os_counts.get("windows", 0),
        "linux_agents": os_counts.get("linux", 0),
        "version_breakdown": version_breakdown,
    }


# ─── Agent Metrics ───────────────────────────
@router.get("/{agent_id}/metrics")
async def get_agent_metrics(
    agent_id: str,
    metric: str = "cpu_percent",
    hours: int = 24,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    result = await db.execute(text("""
        SELECT time, value
        FROM metrics
        WHERE agent_id = :agent_id
          AND metric_name = :metric
          AND time > NOW() - (:hours * INTERVAL '1 hour')
        ORDER BY time ASC
        LIMIT 1000
    """), {"agent_id": agent_id, "metric": metric, "hours": hours})

    rows = result.fetchall()
    return {"metric": metric, "data": [{"time": str(r.time), "value": r.value} for r in rows]}


# ─── Agent Services ──────────────────────────
@router.get("/{agent_id}/services")
async def get_agent_services(agent_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(
        select(Service)
        .where(Service.agent_id == uuid.UUID(agent_id))
        .order_by(Service.service_name)
    )
    services = result.scalars().all()
    return [
        {
            "id": str(s.id),
            "service_name": s.service_name,
            "display_name": s.display_name,
            "status": s.status,
            "startup_type": s.startup_type,
            "pid": s.pid,
            "monitored": s.monitored,
            "last_updated": s.last_updated.isoformat() if s.last_updated else None,
        }
        for s in services
    ]


# ─── Agent Software ──────────────────────────
@router.get("/{agent_id}/software")
async def get_agent_software(agent_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(
        select(SoftwareInventory)
        .where(SoftwareInventory.agent_id == uuid.UUID(agent_id))
        .order_by(SoftwareInventory.name)
    )
    sw = result.scalars().all()
    return [
        {
            "id": str(s.id),
            "name": s.name,
            "version": s.version,
            "publisher": s.publisher,
            "install_date": s.install_date,
            "size_mb": float(s.size_mb) if s.size_mb else None,
        }
        for s in sw
    ]


# ─── Agent History ───────────────────────────
@router.get("/{agent_id}/history")
async def get_agent_history(agent_id: str, limit: int = 100, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    rows = await db.execute(text("""
        SELECT id, event_type, field, old_value, new_value, details, triggered_by, created_at
        FROM agent_history
        WHERE agent_id = :aid
        ORDER BY created_at DESC
        LIMIT :limit
    """), {"aid": agent_id, "limit": limit})
    cols = ["id", "event_type", "field", "old_value", "new_value", "details", "triggered_by", "created_at"]
    return [
        {**dict(zip(cols, r)), "id": str(r[0]), "created_at": r[7].isoformat() if r[7] else None}
        for r in rows.fetchall()
    ]


@router.get("/{agent_id}/queue")
async def get_agent_queue(
    agent_id: str,
    include_picked: bool = False,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Return queued commands for an agent (pending by default, or all recent)."""
    if include_picked:
        rows = await db.execute(text("""
            SELECT id, command_type, payload, created_at, picked_up_at
            FROM agent_commands
            WHERE agent_id = :aid
            ORDER BY created_at DESC
            LIMIT 100
        """), {"aid": agent_id})
    else:
        rows = await db.execute(text("""
            SELECT id, command_type, payload, created_at, picked_up_at
            FROM agent_commands
            WHERE agent_id = :aid AND picked_up_at IS NULL
            ORDER BY created_at DESC
        """), {"aid": agent_id})
    result = []
    for r in rows.fetchall():
        result.append({
            "id": str(r[0]),
            "command_type": r[1],
            "payload": r[2],
            "created_at": r[3].isoformat() if r[3] else None,
            "picked_up_at": r[4].isoformat() if r[4] else None,
            "status": "pending" if r[4] is None else "picked_up",
        })
    return result


@router.get("/{agent_id}/network")
async def get_agent_network(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Return network info (NICs, DNS, gateway) for an agent from hardware inventory."""
    row = await db.execute(text("""
        SELECT nics, dns_servers, default_gateway
        FROM hardware_inventory
        WHERE agent_id = :aid
    """), {"aid": agent_id})
    hw = row.fetchone()
    if not hw:
        return {"nics": [], "dns_servers": [], "default_gateway": None}
    nics, dns_raw, gateway = hw[0], hw[1], hw[2]

    # dns_servers may be stored as JSONB array or may not exist yet
    dns_servers = []
    if dns_raw is not None:
        if isinstance(dns_raw, list):
            dns_servers = dns_raw
        elif isinstance(dns_raw, str):
            import json as _j
            try:
                dns_servers = _j.loads(dns_raw)
            except Exception:
                pass

    return {
        "nics": nics or [],
        "dns_servers": dns_servers,
        "default_gateway": gateway,
    }


async def _log_history(db: AsyncSession, agent_id, event_type: str, field: str = None,
                       old_value: str = None, new_value: str = None, details: dict = None, triggered_by: str = "system"):
    """Insert a row into agent_history."""
    import json as _j
    await db.execute(text("""
        INSERT INTO agent_history (agent_id, event_type, field, old_value, new_value, details, triggered_by)
        VALUES (:aid, :et, :field, :old, :new, CAST(:details AS jsonb), :by)
    """), {
        "aid": str(agent_id), "et": event_type, "field": field,
        "old": old_value, "new": new_value,
        "details": _j.dumps(details or {}), "by": triggered_by,
    })


# ─── Trigger agent self-update ───────────────
@router.post("/{agent_id}/trigger-update")
async def trigger_agent_update(agent_id: str, db: AsyncSession = Depends(get_db), _=Depends(require_operator)):
    """Queue an update_agent command so the agent downloads and replaces its binary."""
    import json as _json
    agent = await db.execute(
        text("SELECT id, os_type FROM agents WHERE id = :aid AND is_active = TRUE"),
        {"aid": agent_id},
    )
    agent = agent.fetchone()
    if not agent:
        raise HTTPException(404, "Agent not found")

    os_type = agent[1] or "linux"
    settings_obj = get_settings()
    # Use HTTP (not HTTPS) — agents connect via HTTP and the TLS cert may not
    # be trusted by all agents. Internal IP is the most reliable target.
    base = f"http://{settings_obj.server_ip}"
    if os_type == "windows":
        url = f"{base}/downloads/kifaa-agent-windows-amd64.exe"
    else:
        url = f"{base}/downloads/kifaa-agent-linux-amd64"

    # Clear existing pending update commands
    await db.execute(
        text("DELETE FROM agent_commands WHERE agent_id = :aid AND command_type = 'update_agent' AND picked_up_at IS NULL"),
        {"aid": agent_id},
    )
    await db.execute(
        text("INSERT INTO agent_commands (agent_id, command_type, payload) VALUES (:aid, 'update_agent', CAST(:payload AS jsonb))"),
        {"aid": agent_id, "payload": _json.dumps({"url": url})},
    )
    await _log_history(db, agent_id, "update_queued", details={"url": url}, triggered_by="user")
    await db.commit()
    return {"status": "queued", "url": url}


# ─── Remote restart ──────────────────────────
@router.post("/{agent_id}/restart")
async def restart_agent(
    agent_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_operator),
):
    """Queue a restart_machine command for the agent.

    Body:
        mode: "silent" | "announced"  (default: "silent")
        delay_seconds: int             (default: 60, only used for announced)
    """
    import json as _json

    agent_row = await db.execute(
        text("SELECT id, hostname, status FROM agents WHERE id = :aid AND is_active = TRUE"),
        {"aid": agent_id},
    )
    agent_row = agent_row.fetchone()
    if not agent_row:
        raise HTTPException(404, "Agent not found")

    mode = body.get("mode", "silent")
    if mode not in ("silent", "announced"):
        raise HTTPException(400, "mode must be 'silent' or 'announced'")
    delay_seconds = int(body.get("delay_seconds", 60))

    # Clear existing pending restart commands for this agent
    await db.execute(
        text("DELETE FROM agent_commands WHERE agent_id = :aid AND command_type = 'restart_machine' AND picked_up_at IS NULL"),
        {"aid": agent_id},
    )
    await db.execute(
        text("INSERT INTO agent_commands (agent_id, command_type, payload) VALUES (:aid, 'restart_machine', CAST(:payload AS jsonb))"),
        {"aid": agent_id, "payload": _json.dumps({"mode": mode, "delay_seconds": delay_seconds})},
    )
    await _log_history(db, agent_id, "restart_queued", details={"mode": mode, "delay_seconds": delay_seconds}, triggered_by="user")
    await db.commit()
    return {"status": "queued", "mode": mode, "delay_seconds": delay_seconds}


@router.post("/{agent_id}/shutdown")
async def shutdown_agent(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_operator),
):
    """Queue a shutdown (poweroff) command for the agent."""
    import json as _json

    agent_row = await db.execute(
        text("SELECT id, hostname, status FROM agents WHERE id = :aid AND is_active = TRUE"),
        {"aid": agent_id},
    )
    agent_row = agent_row.fetchone()
    if not agent_row:
        raise HTTPException(404, "Agent not found")

    await db.execute(
        text("DELETE FROM agent_commands WHERE agent_id = :aid AND command_type = 'restart_machine' AND picked_up_at IS NULL"),
        {"aid": agent_id},
    )
    await db.execute(
        text("INSERT INTO agent_commands (agent_id, command_type, payload) VALUES (:aid, 'restart_machine', CAST(:payload AS jsonb))"),
        {"aid": agent_id, "payload": _json.dumps({"mode": "poweroff", "delay_seconds": 0})},
    )
    await _log_history(db, agent_id, "shutdown_queued", details={"mode": "poweroff"}, triggered_by="user")
    await db.commit()
    return {"status": "queued", "mode": "poweroff"}


# ─── Patch report from agent ─────────────────
@router.post("/patch-report")
async def patch_report(
    body: dict,
    agent: Agent = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db),
):
    """Receive patch scan results posted by the agent itself."""
    patches = body.get("patches") or []
    # Replace existing patches for this agent
    await db.execute(text("DELETE FROM agent_patches WHERE agent_id = :aid"), {"aid": agent.id})
    for p in patches:
        await db.execute(
            text("INSERT INTO agent_patches (agent_id, package_name, current_version, available_version, category, description) VALUES (:aid, :pkg, :cur, :avail, :cat, :desc)"),
            {
                "aid": agent.id,
                "pkg": p.get("package_name", ""),
                "cur": p.get("current_version"),
                "avail": p.get("available_version"),
                "cat": p.get("category", "unknown"),
                "desc": p.get("description", ""),
            },
        )
    security_count = sum(1 for p in patches if p.get("category") == "security")
    await _log_history(db, agent.id, "patch_scan", details={"total": len(patches), "security": security_count})
    await db.commit()
    return {"status": "ok", "stored": len(patches)}


@router.post("/patch-apply-result")
async def patch_apply_result(
    body: dict,
    agent: Agent = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db),
):
    """Receive patch apply output and final status from agent."""
    job_id = body.get("job_id")
    status = body.get("status", "success")
    output = body.get("output", "")

    if not job_id:
        raise HTTPException(status_code=400, detail="job_id is required")

    await db.execute(
        text("UPDATE patch_jobs SET status=:status, output=:output, finished_at=NOW() WHERE id=:id"),
        {"status": status, "output": output, "id": job_id},
    )

    # Keep maintenance_history in sync
    maint_status = "completed" if status == "success" else "failed"
    await db.execute(
        text("""
            UPDATE maintenance_history
            SET status = :ms
            WHERE patch_job_id = CAST(:jid AS uuid)
        """),
        {"ms": maint_status, "jid": job_id},
    )

    # If patching succeeded and the job has reboot_after=true, queue a restart command
    if status == "success":
        job_row = await db.execute(
            text("SELECT reboot_after, reboot_mode, reboot_delay_seconds FROM patch_jobs WHERE id=:id"),
            {"id": job_id},
        )
        job_row = job_row.fetchone()
        if job_row and job_row[0]:  # reboot_after is True
            import json as _json
            reboot_payload = _json.dumps({
                "mode": job_row[1] or "silent",
                "delay_seconds": job_row[2] or 60,
            })
            await db.execute(
                text("INSERT INTO agent_commands (agent_id, command_type, payload) VALUES (:aid, 'restart_machine', CAST(:payload AS jsonb))"),
                {"aid": str(agent.id), "payload": reboot_payload},
            )

    await db.commit()

    # Send notification for maintenance_cycle patch jobs
    try:
        job_info = (await db.execute(
            text("""
                SELECT pj.triggered_by, pj.packages, pj.reboot_after,
                       COALESCE(mc.name, 'Maintenance Cycle') AS cycle_name
                FROM patch_jobs pj
                LEFT JOIN maintenance_history mh ON mh.patch_job_id = pj.id
                LEFT JOIN maintenance_cycles mc ON mc.id = mh.cycle_id
                WHERE pj.id = :id
                LIMIT 1
            """),
            {"id": job_id},
        )).fetchone()

        if job_info and job_info[0] == "maintenance_cycle":
            from api.workers.celery_app import celery_app as _celery
            _celery.send_task(
                "api.workers.tasks.notify_patch_result",
                kwargs={
                    "job_id": job_id,
                    "hostname": agent.hostname,
                    "status": status,
                    "cycle_name": job_info[3] or "Maintenance Cycle",
                    "packages": job_info[1] or [],
                    "reboot_after": bool(job_info[2]),
                    "output": output,
                },
            )
    except Exception:
        pass  # notification failure must never break the result endpoint

    return {"status": "ok"}


@router.post("/restart-notice")
async def restart_notice(
    body: dict,
    agent: Agent = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db),
):
    """
    Agent calls this just before executing a restart_machine command.
    Records is_restarting=true on the agent and queues a notification email.
    """
    job_id      = body.get("job_id", "")
    delay_secs  = int(body.get("delay_seconds", 60))
    cycle_name  = body.get("cycle_name", "Maintenance Cycle")

    # Mark agent as restarting so the next heartbeat can detect comeback
    await db.execute(
        text("UPDATE agents SET is_restarting=TRUE, restarting_job_id=CAST(:jid AS uuid) WHERE id=:aid"),
        {"jid": job_id if job_id else None, "aid": str(agent.id)},
    )
    await db.commit()

    # Queue pre-restart notification email
    try:
        from api.workers.celery_app import celery_app as _celery
        _celery.send_task(
            "api.workers.tasks.notify_restart_scheduled",
            kwargs={
                "hostname":     agent.hostname,
                "delay_seconds": delay_secs,
                "cycle_name":   cycle_name,
                "job_id":       job_id,
            },
        )
    except Exception:
        pass

    return {"status": "ok"}


@router.post("/db-check-result")
async def db_check_result(
    body: dict,
    agent: Agent = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db),
):
    """Receive DB plugin check result from agent."""
    monitor_id = body.get("monitor_id")
    status = body.get("status", "unknown")
    latency_ms = body.get("latency_ms")
    message = body.get("message", "")

    if not monitor_id:
        raise HTTPException(status_code=400, detail="monitor_id required")

    # Write result into monitor_results
    await db.execute(
        text("INSERT INTO monitor_results (time, monitor_id, status, latency_ms, message) VALUES (NOW(), CAST(:mid AS uuid), :st, :lat, :msg)"),
        {"mid": monitor_id, "st": status, "lat": latency_ms, "msg": message},
    )

    # Update monitor last_status
    prev_row = await db.execute(
        text("SELECT last_status, consecutive_failures FROM monitors WHERE id = CAST(:mid AS uuid)"),
        {"mid": monitor_id},
    )
    prev = prev_row.fetchone()
    if prev:
        prev_status, consec = prev[0], prev[1] or 0
        new_consec = 0 if status == "up" else consec + 1
        await db.execute(
            text("""UPDATE monitors SET last_status=:st, last_checked=NOW(),
                    last_latency_ms=:lat, last_message=:msg, consecutive_failures=:cf
                    WHERE id=CAST(:mid AS uuid)"""),
            {"st": status, "lat": latency_ms, "msg": message, "cf": new_consec, "mid": monitor_id},
        )

    await db.commit()
    return {"status": "ok"}


# ─── Mark offline (background task) ─────────
@router.post("/maintenance/mark-offline")
async def mark_stale_offline(db: AsyncSession = Depends(get_db)):
    """Mark agents as offline if not seen in 5 minutes, and raise alerts."""
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=5)
    result = await db.execute(
        select(Agent).where(
            Agent.status == "online",
            Agent.last_seen < cutoff
        )
    )
    agents = result.scalars().all()
    for a in agents:
        a.status = "offline"
        await _log_history(db, a.id, "status_change", field="status", old_value="online", new_value="offline")
        # Create alert for agent going offline
        last_seen_str = a.last_seen.strftime('%Y-%m-%d %H:%M UTC') if a.last_seen else 'never'
        await db.execute(text("""
            INSERT INTO alerts (agent_id, severity, message, status, source, triggered_at)
            VALUES (CAST(:aid AS uuid), 'high',
                    :msg, 'open', 'watchdog', NOW())
        """), {
            "aid": str(a.id),
            "msg": f"Agent offline: {a.display_name or a.hostname} ({a.ip_address}) stopped reporting. Last seen: {last_seen_str}",
        })
    await db.commit()
    return {"marked_offline": len(agents)}


@router.post("/maintenance/sync-all")
async def sync_all_agents(db: AsyncSession = Depends(get_db), _=Depends(require_operator)):
    """Queue collect_inventory commands for all online agents (manual trigger)."""
    return await _queue_sync_all(db)


@router.post("/maintenance/update-all")
async def update_all_agents(db: AsyncSession = Depends(get_db), _=Depends(require_operator)):
    """Queue update_agent for all online agents."""
    import json as _json
    settings_obj = get_settings()
    base = f"http://{settings_obj.server_ip}"
    rows = await db.execute(text(
        "SELECT id, os_type FROM agents WHERE is_active = TRUE AND status = 'online'"
    ))
    agents = rows.fetchall()
    count = 0
    for agent in agents:
        agent_id = str(agent[0])
        os_type = agent[1] or "linux"
        url = f"{base}/downloads/kifaa-agent-windows-amd64.exe" if os_type == "windows" else f"{base}/downloads/kifaa-agent-linux-amd64"
        await db.execute(
            text("DELETE FROM agent_commands WHERE agent_id = :aid AND command_type = 'update_agent' AND picked_up_at IS NULL"),
            {"aid": agent_id},
        )
        await db.execute(
            text("INSERT INTO agent_commands (agent_id, command_type, payload) VALUES (:aid, 'update_agent', CAST(:payload AS jsonb))"),
            {"aid": agent_id, "payload": _json.dumps({"url": url})},
        )
        count += 1
    await db.commit()
    return {"status": "queued", "count": count}


@router.post("/internal/sync-all", include_in_schema=False)
async def sync_all_agents_internal(db: AsyncSession = Depends(get_db)):
    """Internal: called by Celery hourly beat to refresh inventory on all online agents."""
    return await _queue_sync_all(db)


async def _queue_sync_all(db: AsyncSession) -> dict:
    rows = await db.execute(text(
        "SELECT id FROM agents WHERE is_active = TRUE AND status = 'online'"
    ))
    agents = rows.fetchall()
    queued = 0
    for row in agents:
        aid = str(row[0])
        # Avoid duplicates — drop any pending collect_inventory not yet picked up
        await db.execute(
            text("DELETE FROM agent_commands WHERE agent_id = :aid AND command_type = 'collect_inventory' AND picked_up_at IS NULL"),
            {"aid": aid},
        )
        await db.execute(
            text("INSERT INTO agent_commands (agent_id, command_type, payload) VALUES (:aid, 'collect_inventory', '{}')"),
            {"aid": aid},
        )
        queued += 1
    await db.commit()
    return {"queued": queued}


# ─── AD Plugin Callbacks ──────────────────────

def _parse_ts(val):
    """Parse an ISO-8601 timestamp string into a datetime, or return None."""
    if not val:
        return None
    if isinstance(val, datetime):
        return val
    try:
        from datetime import timezone as _tz
        # Handle >6 decimal places (Windows FILETIME nanoseconds) by truncating
        s = str(val)
        if '.' in s:
            dot = s.index('.')
            # Find the end of fractional part (Z or +)
            end = len(s)
            for ch in ('Z', '+', '-'):
                idx = s.find(ch, dot)
                if idx != -1:
                    end = min(end, idx)
            frac = s[dot+1:end]
            if len(frac) > 6:
                s = s[:dot+1] + frac[:6] + s[end:]
        s = s.replace('Z', '+00:00')
        return datetime.fromisoformat(s)
    except Exception:
        return None


@router.post("/ad-sync-result")
async def ad_sync_result(body: dict, agent: Agent = Depends(get_current_agent), db: AsyncSession = Depends(get_db)):
    """Receive full AD sync result (users + groups) from agent."""
    agent_id = str(agent.id)
    result = body.get("result", {})
    users = result.get("users") or []
    groups = result.get("groups") or []
    stats = result.get("stats") or {}
    error = result.get("error", "")

    # Upsert users — columns match actual ad_users schema
    for u in users:
        sam = u.get("sam_account_name", "")
        if not sam:
            continue
        await db.execute(text("""
            INSERT INTO ad_users (
                agent_id, sam_account_name, upn, display_name, email, department,
                title, manager_dn, ou_path, distinguished_name,
                account_enabled, locked_out, lockout_time,
                password_expired, password_never_expires, password_last_set,
                password_expires_at, last_logon, created_at_ad,
                member_of, is_admin, is_service_account,
                days_since_logon, user_account_control, synced_at
            ) VALUES (
                CAST(:agent_id AS uuid), :sam, :upn, :display_name, :email, :dept,
                :title, :manager_dn, :ou_path, :dn,
                :account_enabled, :locked_out, :lockout_time,
                :pwd_expired, :pwd_never_expires, :pwd_last_set,
                :pwd_expires_at, :last_logon, :created_at_ad,
                :member_of, :is_admin, :is_svc,
                :days_since_logon, :uac, NOW()
            )
            ON CONFLICT (agent_id, sam_account_name) DO UPDATE SET
                upn=EXCLUDED.upn, display_name=EXCLUDED.display_name,
                email=EXCLUDED.email, department=EXCLUDED.department,
                title=EXCLUDED.title, manager_dn=EXCLUDED.manager_dn,
                ou_path=EXCLUDED.ou_path, distinguished_name=EXCLUDED.distinguished_name,
                account_enabled=EXCLUDED.account_enabled, locked_out=EXCLUDED.locked_out,
                lockout_time=EXCLUDED.lockout_time,
                password_expired=EXCLUDED.password_expired,
                password_never_expires=EXCLUDED.password_never_expires,
                password_last_set=EXCLUDED.password_last_set,
                password_expires_at=EXCLUDED.password_expires_at,
                last_logon=EXCLUDED.last_logon,
                member_of=EXCLUDED.member_of, is_admin=EXCLUDED.is_admin,
                is_service_account=EXCLUDED.is_service_account,
                days_since_logon=EXCLUDED.days_since_logon,
                user_account_control=EXCLUDED.user_account_control,
                synced_at=NOW()
        """), {
            "agent_id": agent_id,
            "sam": sam,
            "upn": u.get("upn", ""),
            "display_name": u.get("display_name", ""),
            "email": u.get("email", ""),
            "dept": u.get("department", ""),
            "title": u.get("title", ""),
            "manager_dn": u.get("manager_dn", ""),
            "ou_path": u.get("ou_path", ""),
            "dn": u.get("distinguished_name", ""),
            "account_enabled": u.get("account_enabled", False),
            "locked_out": u.get("locked_out", False),
            "lockout_time": _parse_ts(u.get("lockout_time")),
            "pwd_expired": u.get("password_expired", False),
            "pwd_never_expires": u.get("password_never_expires", False),
            "pwd_last_set": _parse_ts(u.get("password_last_set")),
            "pwd_expires_at": _parse_ts(u.get("password_expires_at")),
            "last_logon": _parse_ts(u.get("last_logon")),
            "created_at_ad": _parse_ts(u.get("created_at_ad")),
            "member_of": u.get("member_of") or [],
            "is_admin": u.get("is_admin", False),
            "is_svc": u.get("is_service_account", False),
            "days_since_logon": u.get("days_since_logon"),
            "uac": u.get("user_account_control", 0),
        })

    # Upsert groups — columns match actual ad_groups schema
    for g in groups:
        sam = g.get("sam_account_name", "")
        if not sam:
            continue
        await db.execute(text("""
            INSERT INTO ad_groups (
                agent_id, sam_account_name, display_name, description,
                group_type, group_scope, member_count, members,
                ou_path, is_privileged, synced_at
            ) VALUES (
                CAST(:agent_id AS uuid), :sam, :display_name, :desc,
                :gtype, :gscope, :cnt, :members,
                :ou_path, :is_priv, NOW()
            )
            ON CONFLICT (agent_id, sam_account_name) DO UPDATE SET
                display_name=EXCLUDED.display_name, description=EXCLUDED.description,
                group_type=EXCLUDED.group_type, group_scope=EXCLUDED.group_scope,
                member_count=EXCLUDED.member_count, members=EXCLUDED.members,
                ou_path=EXCLUDED.ou_path, is_privileged=EXCLUDED.is_privileged,
                synced_at=NOW()
        """), {
            "agent_id": agent_id,
            "sam": sam,
            "display_name": g.get("display_name", ""),
            "desc": g.get("description", ""),
            "gtype": g.get("group_type", ""),
            "gscope": g.get("group_scope", ""),
            "cnt": g.get("member_count", len(g.get("members") or [])),
            "members": g.get("members") or [],
            "ou_path": g.get("ou_path", ""),
            "is_priv": g.get("is_privileged", False),
        })

    # Save health snapshot — columns match actual ad_health_snapshots schema
    total_groups = len(groups)
    priv_groups = sum(1 for g in groups if g.get("is_privileged"))
    await db.execute(text("""
        INSERT INTO ad_health_snapshots (
            agent_id, total_users, enabled_users, disabled_users, locked_users,
            stale_users_30d, stale_users_90d, expiring_passwords_7d,
            expired_passwords, never_expire_passwords,
            admin_count, service_account_count,
            total_groups, privileged_groups_count, compliance_score
        ) VALUES (
            CAST(:agent_id AS uuid), :total, :enabled, :disabled, :locked,
            :stale30, :stale90, :expiring7,
            :expired, :never_exp,
            :admin_cnt, :svc_cnt,
            :total_grp, :priv_grp, :score
        )
    """), {
        "agent_id": agent_id,
        "total": stats.get("total_users", len(users)),
        "enabled": stats.get("enabled_users", 0),
        "disabled": stats.get("disabled_users", 0),
        "locked": stats.get("locked_users", 0),
        "stale30": stats.get("stale_users_30d", 0),
        "stale90": stats.get("stale_users_90d", 0),
        "expiring7": stats.get("expiring_passwords_7d", 0),
        "expired": stats.get("expired_passwords", 0),
        "never_exp": stats.get("never_expire_passwords", 0),
        "admin_cnt": stats.get("admin_count", 0),
        "svc_cnt": stats.get("service_account_count", 0),
        "total_grp": stats.get("total_groups", total_groups),
        "priv_grp": stats.get("privileged_groups", priv_groups),
        "score": stats.get("compliance_score", 0),
    })

    # Remove users/groups that no longer exist in AD (deleted directly in AD)
    if users:
        synced_sams = [u.get("sam_account_name", "") for u in users if u.get("sam_account_name")]
        await db.execute(text("""
            DELETE FROM ad_users
            WHERE agent_id = CAST(:agent_id AS uuid)
              AND sam_account_name != ALL(:sams)
        """), {"agent_id": agent_id, "sams": synced_sams})

    if groups:
        synced_group_sams = [g.get("sam_account_name", "") for g in groups if g.get("sam_account_name")]
        await db.execute(text("""
            DELETE FROM ad_groups
            WHERE agent_id = CAST(:agent_id AS uuid)
              AND sam_account_name != ALL(:sams)
        """), {"agent_id": agent_id, "sams": synced_group_sams})

    # Update last sync status on ad_configs
    await db.execute(text("""
        UPDATE ad_configs SET last_sync_at=NOW(), last_sync_status=:st, last_sync_error=:err
        WHERE agent_id = CAST(:aid AS uuid)
    """), {"aid": agent_id, "st": "error" if error else "ok", "err": error})

    await db.commit()
    return {"status": "ok", "users_synced": len(users), "groups_synced": len(groups)}


@router.post("/ad-events-result")
async def ad_events_result(body: dict, agent: Agent = Depends(get_current_agent), db: AsyncSession = Depends(get_db)):
    """Receive Windows Security Event Log entries from agent."""
    agent_id = str(agent.id)
    events = body.get("events") or []

    for ev in events:
        event_time = _parse_ts(ev.get("event_time"))
        if not event_time:
            continue
        await db.execute(text("""
            INSERT INTO ad_events
                (agent_id, event_id, event_time, target_user, target_domain,
                 calling_computer, calling_ip, dc_name, subject_user, description)
            VALUES (
                CAST(:agent_id AS uuid), :event_id, :event_time,
                :target_user, :target_domain, :calling_computer, :calling_ip,
                :dc_name, :subject_user, :description
            )
        """), {
            "agent_id": agent_id,
            "event_id": ev.get("event_id", 0),
            "event_time": event_time,
            "target_user": ev.get("target_user", ""),
            "target_domain": ev.get("target_domain", ""),
            "calling_computer": ev.get("calling_computer", ""),
            "calling_ip": ev.get("calling_ip", ""),
            "dc_name": ev.get("dc_name", ""),
            "subject_user": ev.get("subject_user", ""),
            "description": ev.get("description", ""),
        })

    await db.commit()
    return {"status": "ok", "events_stored": len(events)}


@router.post("/ad-action-result")
async def ad_action_result(body: dict, agent: Agent = Depends(get_current_agent), db: AsyncSession = Depends(get_db)):
    """Receive result of an AD user action — updates the pending ad_action_log row."""
    action_id = body.get("action_id", "")
    success = body.get("success", False)
    message = body.get("message", "")

    if action_id:
        # Strip null bytes — LDAP error messages sometimes contain \x00 which
        # PostgreSQL UTF-8 rejects, causing a 500 and leaving the action "pending".
        safe_message = (message or "").replace("\x00", "").strip()
        await db.execute(text("""
            UPDATE ad_action_log
            SET status = :st, error_message = :err, completed_at = NOW()
            WHERE action_id = :aid
        """), {
            "st": "completed" if success else "failed",
            "err": "" if success else safe_message,
            "aid": action_id,
        })
    await db.commit()
    return {"status": "ok"}


@router.post("/ad-test-result")
async def ad_test_result(body: dict, agent: Agent = Depends(get_current_agent), db: AsyncSession = Depends(get_db)):
    """Receive AD connectivity test result from agent."""
    command_id = body.get("command_id", "")
    success = body.get("success", False)
    message = body.get("message", "")
    latency_ms = body.get("latency_ms", 0)

    if command_id:
        await db.execute(text("""
            INSERT INTO ad_test_results (command_id, agent_id, success, message, latency_ms)
            VALUES (CAST(:cid AS uuid), CAST(:aid AS uuid), :ok, :msg, :lat)
            ON CONFLICT (command_id) DO UPDATE SET
                success=EXCLUDED.success, message=EXCLUDED.message,
                latency_ms=EXCLUDED.latency_ms, tested_at=NOW()
        """), {
            "cid": command_id,
            "aid": str(agent.id),
            "ok": success,
            "msg": message,
            "lat": latency_ms,
        })
        await db.commit()
    return {"status": "ok"}



@router.post("/rdp-sessions")
async def receive_rdp_sessions(
    body: dict,
    agent: Agent = Depends(get_current_agent),
    db: AsyncSession = Depends(get_db),
):
    """Receive RDP session data from Windows agent and upsert into rdp_sessions."""
    from datetime import datetime as _dt
    import logging as _logging
    _log = _logging.getLogger(__name__)

    def _parse_ts(val):
        """Parse ISO timestamp string to datetime, or return None."""
        if not val:
            return None
        if isinstance(val, _dt):
            return val
        try:
            return _dt.fromisoformat(str(val).replace("Z", "+00:00"))
        except Exception:
            return None

    sessions = body.get("sessions") or []
    inserted = 0
    skipped = 0
    for s in sessions:
        username = (s.get("username") or "").strip()
        logon_time = _parse_ts(s.get("logon_time"))
        if not logon_time or not username:
            skipped += 1
            continue
        logoff_time = _parse_ts(s.get("logoff_time"))
        duration = s.get("duration_seconds")
        try:
            await db.execute(text("""
                INSERT INTO rdp_sessions
                    (agent_id, username, domain, source_ip, session_id,
                     logon_time, logoff_time, duration_seconds, logoff_type)
                VALUES
                    (CAST(:aid AS uuid), :user, :domain, :src_ip, :sid,
                     :logon, :logoff, :dur, :logoff_type)
                ON CONFLICT (agent_id, username, session_id, logon_time) DO UPDATE SET
                    logoff_time      = EXCLUDED.logoff_time,
                    duration_seconds = EXCLUDED.duration_seconds,
                    logoff_type      = EXCLUDED.logoff_type
            """), {
                "aid": str(agent.id),
                "user": username,
                "domain": s.get("domain") or "",
                "src_ip": s.get("source_ip") or "",
                "sid": s.get("session_id") or 0,
                "logon": logon_time,
                "logoff": logoff_time,
                "dur": duration,
                "logoff_type": s.get("logoff_type") or "unknown",
            })
            inserted += 1
        except Exception as exc:
            _log.error("rdp_sessions insert error for %s/%s: %s", agent.hostname, username, exc)
            await db.rollback()
    await db.commit()
    return {"status": "ok", "stored": inserted, "skipped": skipped}


# ── Agent watchdog ────────────────────────────────────────────────────────────

@router.post("/internal/watchdog-check")
async def watchdog_check(db: AsyncSession = Depends(get_db)):
    """
    Find agents offline for 5-60 minutes that have stored credentials.
    Attempt to restart the KifaaAgent service via WinRM (Windows) or SSH (Linux).
    Resolves the offline alert when the restart succeeds.
    """
    import asyncio as _asyncio
    import subprocess as _subprocess

    now = datetime.now(timezone.utc)
    min_offline = now - timedelta(minutes=5)
    max_offline = now - timedelta(hours=1)  # don't keep hammering if down for >1h

    rows = await db.execute(text("""
        SELECT a.id, a.hostname, a.display_name, a.ip_address, a.os_type,
               c.username, c.password, c.winrm_port, c.connect_type, c.domain
        FROM agents a
        JOIN agent_ssh_credentials c ON c.agent_id = a.id
        WHERE a.status = 'offline'
          AND a.is_active = TRUE
          AND a.last_seen BETWEEN :max_off AND :min_off
        ORDER BY a.last_seen DESC
    """), {"min_off": min_offline, "max_off": max_offline})
    candidates = rows.fetchall()

    results = []
    for row in candidates:
        agent_id, hostname, display_name, ip, os_type, username, password, winrm_port, connect_type, domain = row
        name = display_name or hostname
        restarted = False
        error = ""

        try:
            if connect_type in ("windows", "windows_smb") or os_type == "windows":
                # WinRM restart
                try:
                    import winrm as _winrm
                    auth_user = f"{domain}\\{username}" if domain else username
                    s = _winrm.Session(ip, auth=(auth_user, password), transport="ntlm",
                                       read_timeout_sec=20, operation_timeout_sec=15)
                    r = s.run_cmd("sc stop KifaaAgent")
                    import time as _time; _time.sleep(3)
                    r2 = s.run_cmd("sc start KifaaAgent")
                    restarted = r2.status_code == 0
                    if not restarted:
                        error = r2.std_err.decode()[:200] or r2.std_out.decode()[:200]
                except Exception as e:
                    error = str(e)[:200]
            else:
                # SSH restart (Linux)
                try:
                    r = _subprocess.run(
                        ["sshpass", "-p", password, "ssh",
                         "-o", "StrictHostKeyChecking=no",
                         "-o", "ConnectTimeout=10",
                         f"{username}@{ip}",
                         "sudo systemctl restart kifaa-agent"],
                        capture_output=True, text=True, timeout=20
                    )
                    restarted = r.returncode == 0
                    error = r.stderr[:200] if not restarted else ""
                except Exception as e:
                    error = str(e)[:200]
        except Exception as e:
            error = str(e)[:200]

        if restarted:
            # Log the restart attempt
            await db.execute(text("""
                INSERT INTO alerts (agent_id, severity, message, status, source, triggered_at)
                VALUES (CAST(:aid AS uuid), 'low',
                        :msg, 'resolved', 'watchdog', NOW())
            """), {
                "aid": str(agent_id),
                "msg": f"Watchdog auto-restarted KifaaAgent on {name} ({ip})",
            })

        results.append({"agent": name, "ip": ip, "restarted": restarted, "error": error})

    await db.commit()
    return {"checked": len(candidates), "results": results}
