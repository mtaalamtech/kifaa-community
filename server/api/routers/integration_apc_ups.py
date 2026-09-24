"""APC UPS integration data router."""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.database import get_db
from api.services.auth import get_current_user

router = APIRouter(prefix="/integrations/apc-ups", tags=["Integrations - APC UPS"])

_tables_ready = False


async def _ensure_tables(db: AsyncSession):
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS apc_ups_devices (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            name TEXT NOT NULL,
            host TEXT NOT NULL UNIQUE,
            model TEXT,
            serial_number TEXT,
            firmware_version TEXT,
            snmp_community TEXT DEFAULT 'public',
            snmp_version TEXT DEFAULT '2c',
            status TEXT DEFAULT 'unknown',
            battery_capacity_pct INTEGER,
            battery_temp_c INTEGER,
            battery_runtime_seconds INTEGER,
            battery_status TEXT,
            input_voltage_v INTEGER,
            input_frequency_hz INTEGER,
            output_voltage_v INTEGER,
            output_frequency_hz INTEGER,
            output_load_pct INTEGER,
            output_current_a INTEGER,
            alarm_flags TEXT,
            last_polled_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS apc_ups_metrics (
            time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            device_id UUID REFERENCES apc_ups_devices(id) ON DELETE CASCADE,
            battery_capacity_pct INTEGER,
            battery_runtime_seconds INTEGER,
            input_voltage_v INTEGER,
            output_voltage_v INTEGER,
            output_load_pct INTEGER,
            output_current_a INTEGER,
            status TEXT
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS ups_shutdown_policies (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            name TEXT NOT NULL,
            device_id UUID REFERENCES apc_ups_devices(id) ON DELETE CASCADE,
            is_active BOOLEAN DEFAULT TRUE,
            trigger_runtime_seconds INTEGER DEFAULT 600,
            trigger_battery_pct INTEGER DEFAULT 20,
            trigger_mode TEXT DEFAULT 'any',
            cancel_window_seconds INTEGER DEFAULT 120,
            delay_between_agents_seconds INTEGER DEFAULT 30,
            notify_bot BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS ups_shutdown_policy_agents (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            policy_id UUID REFERENCES ups_shutdown_policies(id) ON DELETE CASCADE,
            agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
            shutdown_order INTEGER NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(policy_id, agent_id)
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS ups_shutdown_events (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            policy_id UUID REFERENCES ups_shutdown_policies(id) ON DELETE SET NULL,
            device_id UUID REFERENCES apc_ups_devices(id) ON DELETE SET NULL,
            device_name TEXT,
            policy_name TEXT,
            triggered_at TIMESTAMPTZ DEFAULT NOW(),
            trigger_reason TEXT,
            cancel_deadline TIMESTAMPTZ,
            status TEXT DEFAULT 'pending',
            cancelled_at TIMESTAMPTZ,
            cancelled_by TEXT,
            completed_at TIMESTAMPTZ,
            agents_total INTEGER DEFAULT 0,
            agents_shutdown INTEGER DEFAULT 0
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS ups_shutdown_event_agents (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            event_id UUID REFERENCES ups_shutdown_events(id) ON DELETE CASCADE,
            agent_id UUID,
            hostname TEXT,
            os_type TEXT,
            shutdown_order INTEGER,
            status TEXT DEFAULT 'pending',
            sent_at TIMESTAMPTZ,
            error TEXT
        )
    """))
    await db.commit()

    # Try to make apc_ups_metrics a TimescaleDB hypertable
    try:
        await db.execute(text(
            "SELECT create_hypertable('apc_ups_metrics', 'time', if_not_exists => TRUE)"
        ))
        await db.commit()
    except Exception:
        pass  # TimescaleDB not available or table already a hypertable — safe to ignore


async def _ensure_tables_once(db: AsyncSession):
    global _tables_ready
    if not _tables_ready:
        try:
            await _ensure_tables(db)
        except Exception:
            # Tables likely already exist (race between workers on restart).
            # Roll back the broken transaction so the session stays usable.
            try:
                await db.rollback()
            except Exception:
                pass
        _tables_ready = True


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/dashboard")
async def apc_ups_dashboard(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_tables_once(db)

    plugin = await db.execute(text(
        "SELECT status, is_enabled, last_sync_at, last_error FROM integration_plugins WHERE plugin_type='apc_ups'"
    ))
    p = plugin.fetchone()

    devices = await db.execute(text("""
        SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status = 'online')      AS online,
            COUNT(*) FILTER (WHERE status = 'on_battery')  AS on_battery,
            COUNT(*) FILTER (WHERE status = 'low_battery') AS low_battery,
            COUNT(*) FILTER (WHERE status = 'on_bypass')   AS on_bypass,
            COUNT(*) FILTER (WHERE status = 'offline' OR status = 'unknown') AS offline,
            AVG(output_load_pct) FILTER (WHERE output_load_pct IS NOT NULL) AS avg_load_pct,
            MIN(battery_runtime_seconds) FILTER (WHERE battery_runtime_seconds IS NOT NULL) AS lowest_runtime_seconds
        FROM apc_ups_devices
    """))
    d = devices.fetchone()

    return {
        "plugin": {
            "status": p.status if p else "disconnected",
            "is_enabled": p.is_enabled if p else False,
            "last_sync_at": p.last_sync_at.isoformat() if p and p.last_sync_at else None,
            "last_error": p.last_error if p else None,
        },
        "devices": {
            "total": d.total or 0,
            "online": d.online or 0,
            "on_battery": d.on_battery or 0,
            "low_battery": d.low_battery or 0,
            "on_bypass": d.on_bypass or 0,
            "offline": d.offline or 0,
            "avg_load_pct": round(float(d.avg_load_pct), 1) if d.avg_load_pct is not None else None,
            "lowest_runtime_seconds": d.lowest_runtime_seconds,
        },
    }


@router.get("/devices")
async def list_devices(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_tables_once(db)

    rows = await db.execute(text("""
        SELECT id, name, host, model, serial_number, firmware_version,
               snmp_community, snmp_version, status,
               battery_capacity_pct, battery_temp_c, battery_runtime_seconds, battery_status,
               input_voltage_v, input_frequency_hz,
               output_voltage_v, output_frequency_hz, output_load_pct, output_current_a,
               alarm_flags, last_polled_at, created_at, updated_at
        FROM apc_ups_devices
        ORDER BY name
    """))

    results = []
    for r in rows.fetchall():
        d = dict(r._mapping)
        for ts_field in ("last_polled_at", "created_at", "updated_at"):
            if d.get(ts_field):
                d[ts_field] = d[ts_field].isoformat()
        results.append(d)
    return results


@router.get("/devices/{device_id}")
async def get_device(device_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_tables_once(db)

    row = await db.execute(text("""
        SELECT id, name, host, model, serial_number, firmware_version,
               snmp_community, snmp_version, status,
               battery_capacity_pct, battery_temp_c, battery_runtime_seconds, battery_status,
               input_voltage_v, input_frequency_hz,
               output_voltage_v, output_frequency_hz, output_load_pct, output_current_a,
               alarm_flags, last_polled_at, created_at, updated_at
        FROM apc_ups_devices
        WHERE id = :id
    """), {"id": device_id})

    r = row.fetchone()
    if not r:
        raise HTTPException(status_code=404, detail="UPS device not found")

    d = dict(r._mapping)
    for ts_field in ("last_polled_at", "created_at", "updated_at"):
        if d.get(ts_field):
            d[ts_field] = d[ts_field].isoformat()

    # Parse alarm_flags into human-readable flags
    alarm_flags_str = d.get("alarm_flags") or ""
    parsed_alarms = _parse_alarm_flags(alarm_flags_str)
    d["parsed_alarms"] = parsed_alarms

    return d


@router.get("/devices/{device_id}/metrics")
async def get_device_metrics(
    device_id: str,
    hours: int = Query(default=24, ge=1, le=720),
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    await _ensure_tables_once(db)

    # Verify device exists
    dev = await db.execute(text(
        "SELECT id, name FROM apc_ups_devices WHERE id = :id"
    ), {"id": device_id})
    if not dev.fetchone():
        raise HTTPException(status_code=404, detail="UPS device not found")

    rows = await db.execute(text("""
        SELECT time, battery_capacity_pct, battery_runtime_seconds,
               input_voltage_v, output_voltage_v, output_load_pct, output_current_a, status
        FROM apc_ups_metrics
        WHERE device_id = :did
          AND time >= NOW() - INTERVAL ':hours hours'
        ORDER BY time ASC
    """.replace(":hours hours", f"{hours} hours")), {"did": device_id})

    return [
        {
            "time": r.time.isoformat() if r.time else None,
            "battery_capacity_pct": r.battery_capacity_pct,
            "battery_runtime_seconds": r.battery_runtime_seconds,
            "input_voltage_v": r.input_voltage_v,
            "output_voltage_v": r.output_voltage_v,
            "output_load_pct": r.output_load_pct,
            "output_current_a": r.output_current_a,
            "status": r.status,
        }
        for r in rows.fetchall()
    ]


@router.post("/devices")
async def create_device(body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Add a new UPS device."""
    await _ensure_tables_once(db)

    host = (body.get("host") or "").strip()
    name = (body.get("name") or "").strip()
    if not host or not name:
        raise HTTPException(status_code=400, detail="host and name are required")

    await db.execute(text("""
        INSERT INTO apc_ups_devices
            (name, host, snmp_community, snmp_version, status)
        VALUES (:name, :host, :community, :version, 'unknown')
        ON CONFLICT (host) DO UPDATE
            SET name           = EXCLUDED.name,
                snmp_community = EXCLUDED.snmp_community,
                snmp_version   = EXCLUDED.snmp_version,
                updated_at     = NOW()
    """), {
        "name":      name,
        "host":      host,
        "community": (body.get("snmp_community") or "public").strip(),
        "version":   (body.get("snmp_version") or "2c").strip(),
    })
    await db.commit()

    row = await db.execute(text("SELECT id FROM apc_ups_devices WHERE host = :host"), {"host": host})
    r = row.fetchone()
    return {"ok": True, "id": str(r[0]) if r else None}


@router.put("/devices/{device_id}")
async def update_device(device_id: str, body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Update an existing UPS device's name, host, or SNMP settings."""
    await _ensure_tables_once(db)

    updates = {}
    for field, col in [("name", "name"), ("host", "host"),
                        ("snmp_community", "snmp_community"), ("snmp_version", "snmp_version")]:
        if field in body and body[field] is not None:
            updates[col] = str(body[field]).strip()

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    set_clause = ", ".join(f"{k} = :{k}" for k in updates)
    updates["id"] = device_id
    await db.execute(
        text(f"UPDATE apc_ups_devices SET {set_clause}, updated_at=NOW() WHERE id = :id"),
        updates,
    )
    await db.commit()
    return {"ok": True}


@router.delete("/devices/{device_id}")
async def delete_device(device_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Remove a UPS device and its metrics."""
    await _ensure_tables_once(db)

    await db.execute(text("DELETE FROM apc_ups_devices WHERE id = :id"), {"id": device_id})
    await db.commit()
    return {"ok": True}


@router.post("/sync")
async def trigger_sync(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_tables_once(db)

    row = await db.execute(text(
        "SELECT is_enabled FROM integration_plugins WHERE plugin_type = 'apc_ups'"
    ))
    r = row.fetchone()
    if not r:
        raise HTTPException(status_code=404, detail="APC UPS plugin not configured")
    if not r.is_enabled:
        raise HTTPException(status_code=400, detail="APC UPS plugin is not enabled")

    from api.workers.celery_app import celery_app as _celery
    _celery.send_task("api.workers.tasks.sync_apc_ups")

    return {"ok": True, "message": "APC UPS sync queued"}


# ── Helpers ────────────────────────────────────────────────────────────────────

# ── Shutdown Policies ──────────────────────────────────────────────────────────

@router.get("/shutdown-policies")
async def list_shutdown_policies(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_tables_once(db)
    rows = await db.execute(text("""
        SELECT p.id, p.name, p.device_id, p.is_active,
               p.trigger_runtime_seconds, p.trigger_battery_pct, p.trigger_mode,
               p.cancel_window_seconds, p.delay_between_agents_seconds, p.notify_bot,
               p.created_at, p.updated_at,
               d.name AS device_name, d.host AS device_host,
               d.status AS device_status, d.battery_capacity_pct, d.battery_runtime_seconds,
               COUNT(pa.id) AS agent_count
        FROM ups_shutdown_policies p
        LEFT JOIN apc_ups_devices d ON d.id = p.device_id
        LEFT JOIN ups_shutdown_policy_agents pa ON pa.policy_id = p.id
        GROUP BY p.id, d.id
        ORDER BY p.created_at DESC
    """))
    results = []
    for r in rows.fetchall():
        d = dict(r._mapping)
        for ts in ("created_at", "updated_at"):
            if d.get(ts):
                d[ts] = d[ts].isoformat()
        d["id"] = str(d["id"])
        d["device_id"] = str(d["device_id"]) if d.get("device_id") else None
        results.append(d)
    return results


@router.post("/shutdown-policies")
async def create_shutdown_policy(body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_tables_once(db)
    name = (body.get("name") or "").strip()
    device_id = (body.get("device_id") or "").strip()
    if not name or not device_id:
        raise HTTPException(status_code=400, detail="name and device_id are required")
    await db.execute(text("""
        INSERT INTO ups_shutdown_policies
            (name, device_id, is_active, trigger_runtime_seconds, trigger_battery_pct,
             trigger_mode, cancel_window_seconds, delay_between_agents_seconds, notify_bot)
        VALUES (:name, CAST(:device_id AS uuid), :is_active, :runtime, :battery,
                :tmode, :cancel_window, :delay, :notify_bot)
    """), {
        "name": name,
        "device_id": device_id,
        "is_active": bool(body.get("is_active", True)),
        "runtime": int(body.get("trigger_runtime_seconds", 600)),
        "battery": int(body.get("trigger_battery_pct", 20)),
        "tmode": body.get("trigger_mode", "any"),
        "cancel_window": int(body.get("cancel_window_seconds", 120)),
        "delay": int(body.get("delay_between_agents_seconds", 30)),
        "notify_bot": bool(body.get("notify_bot", True)),
    })
    await db.commit()
    row = await db.execute(text(
        "SELECT id FROM ups_shutdown_policies WHERE name=:name AND device_id=CAST(:did AS uuid) ORDER BY created_at DESC LIMIT 1"
    ), {"name": name, "did": device_id})
    r = row.fetchone()
    return {"ok": True, "id": str(r[0]) if r else None}


@router.put("/shutdown-policies/{policy_id}")
async def update_shutdown_policy(policy_id: str, body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_tables_once(db)
    fields: dict = {}
    for k in ("name", "is_active", "trigger_runtime_seconds", "trigger_battery_pct",
              "trigger_mode", "cancel_window_seconds", "delay_between_agents_seconds", "notify_bot"):
        if k in body:
            fields[k] = body[k]
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")
    set_clause = ", ".join(f"{k} = :{k}" for k in fields)
    fields["id"] = policy_id
    await db.execute(text(f"UPDATE ups_shutdown_policies SET {set_clause}, updated_at=NOW() WHERE id=CAST(:id AS uuid)"), fields)
    await db.commit()
    return {"ok": True}


@router.delete("/shutdown-policies/{policy_id}")
async def delete_shutdown_policy(policy_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_tables_once(db)
    await db.execute(text("DELETE FROM ups_shutdown_policies WHERE id=CAST(:id AS uuid)"), {"id": policy_id})
    await db.commit()
    return {"ok": True}


@router.put("/shutdown-policies/{policy_id}/agents")
async def set_policy_agents(policy_id: str, body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_tables_once(db)
    agents = body.get("agents", [])
    await db.execute(text("DELETE FROM ups_shutdown_policy_agents WHERE policy_id=CAST(:pid AS uuid)"), {"pid": policy_id})
    for ag in agents:
        await db.execute(text("""
            INSERT INTO ups_shutdown_policy_agents (policy_id, agent_id, shutdown_order)
            VALUES (CAST(:pid AS uuid), CAST(:aid AS uuid), :order)
            ON CONFLICT (policy_id, agent_id) DO UPDATE SET shutdown_order=EXCLUDED.shutdown_order
        """), {"pid": policy_id, "aid": ag["agent_id"], "order": ag["shutdown_order"]})
    await db.commit()
    return {"ok": True}


@router.get("/shutdown-policies/{policy_id}/agents")
async def get_policy_agents(policy_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_tables_once(db)
    rows = await db.execute(text("""
        SELECT pa.agent_id, pa.shutdown_order, a.hostname, a.status, a.os_type, a.os_name
        FROM ups_shutdown_policy_agents pa
        JOIN agents a ON a.id = pa.agent_id
        WHERE pa.policy_id = CAST(:pid AS uuid)
        ORDER BY pa.shutdown_order
    """), {"pid": policy_id})
    return [
        {"agent_id": str(r.agent_id), "shutdown_order": r.shutdown_order,
         "hostname": r.hostname, "status": r.status, "os_type": r.os_type, "os_name": r.os_name}
        for r in rows.fetchall()
    ]


# ── Shutdown Events ────────────────────────────────────────────────────────────

@router.get("/shutdown-events")
async def list_shutdown_events(
    limit: int = Query(default=20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    await _ensure_tables_once(db)
    rows = await db.execute(text("""
        SELECT id, policy_id, device_id, device_name, policy_name,
               triggered_at, trigger_reason, cancel_deadline, status,
               cancelled_at, cancelled_by, completed_at,
               agents_total, agents_shutdown
        FROM ups_shutdown_events
        ORDER BY triggered_at DESC
        LIMIT :lim
    """), {"lim": limit})
    results = []
    for r in rows.fetchall():
        d = dict(r._mapping)
        for ts in ("triggered_at", "cancel_deadline", "cancelled_at", "completed_at"):
            if d.get(ts):
                d[ts] = d[ts].isoformat()
        d["id"] = str(d["id"])
        d["policy_id"] = str(d["policy_id"]) if d.get("policy_id") else None
        d["device_id"] = str(d["device_id"]) if d.get("device_id") else None
        results.append(d)
    return results


@router.get("/shutdown-events/{event_id}/agents")
async def get_event_agents(event_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_tables_once(db)
    rows = await db.execute(text("""
        SELECT agent_id, hostname, os_type, shutdown_order, status, sent_at, error
        FROM ups_shutdown_event_agents
        WHERE event_id = CAST(:eid AS uuid)
        ORDER BY shutdown_order
    """), {"eid": event_id})
    results = []
    for r in rows.fetchall():
        d = dict(r._mapping)
        if d.get("agent_id"):
            d["agent_id"] = str(d["agent_id"])
        if d.get("sent_at"):
            d["sent_at"] = d["sent_at"].isoformat()
        results.append(d)
    return results


@router.post("/shutdown-events/{event_id}/cancel")
async def cancel_shutdown_event(event_id: str, db: AsyncSession = Depends(get_db), user=Depends(get_current_user)):
    await _ensure_tables_once(db)
    row = await db.execute(text(
        "SELECT status FROM ups_shutdown_events WHERE id=CAST(:id AS uuid)"
    ), {"id": event_id})
    r = row.fetchone()
    if not r:
        raise HTTPException(status_code=404, detail="Event not found")
    if r.status != "pending":
        raise HTTPException(status_code=400, detail=f"Cannot cancel event with status '{r.status}'")
    username = getattr(user, "username", "user")
    await db.execute(text("""
        UPDATE ups_shutdown_events
        SET status='cancelled', cancelled_at=NOW(), cancelled_by=:who
        WHERE id=CAST(:id AS uuid)
    """), {"id": event_id, "who": username})
    await db.execute(text("""
        UPDATE ups_shutdown_event_agents SET status='cancelled'
        WHERE event_id=CAST(:eid AS uuid) AND status='pending'
    """), {"eid": event_id})
    await db.commit()
    return {"ok": True, "message": "Shutdown cancelled"}


def _parse_alarm_flags(alarm_flags_str: str) -> dict:
    """Parse APC upsAdvStateAbnormalConditions bit string into named flags."""
    s = alarm_flags_str.strip() if alarm_flags_str else ""

    def bit(pos: int) -> bool:
        return len(s) > pos and s[pos] == '1'

    return {
        "on_battery": bit(0),
        "low_battery": bit(1),
        "replace_battery": bit(2),
        "on_bypass": bit(3),
        "output_overloaded": bit(4),
        "in_shutdown": bit(5),
        "on_smart_boost": bit(6),
        "on_smart_trim": bit(7),
        "raw": s,
    }
