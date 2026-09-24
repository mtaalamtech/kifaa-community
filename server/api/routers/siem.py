"""
SIEM event collection and query router.
Agent push: POST /agents/siem/events  (API key auth)
Query:      GET  /siem/events          (JWT auth)
Stats:      GET  /siem/stats           (JWT auth)
"""
import json
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.database import get_db
from api.services.auth import get_agent_by_api_key, get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(tags=["SIEM"])

_tables_ready = False


# ── DB schema ─────────────────────────────────────────────────────────────────

async def _ensure_siem_tables(db: AsyncSession):
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS siem_events (
            time        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            id          UUID NOT NULL DEFAULT uuid_generate_v4(),
            agent_id    UUID REFERENCES agents(id) ON DELETE SET NULL,
            source_ip   INET,
            log_source  TEXT NOT NULL DEFAULT 'unknown',
            level       TEXT NOT NULL DEFAULT 'info',
            event_id    INTEGER,
            channel     TEXT,
            message     TEXT NOT NULL DEFAULT '',
            raw_data    JSONB NOT NULL DEFAULT '{}',
            ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """))

    # Create hypertable if not already
    try:
        await db.execute(text(
            "SELECT create_hypertable('siem_events', 'time', if_not_exists => TRUE)"
        ))
    except Exception:
        pass  # Already a hypertable or TimescaleDB not available

    await db.execute(text(
        "CREATE INDEX IF NOT EXISTS idx_siem_agent_time ON siem_events (agent_id, time DESC)"
    ))
    await db.execute(text(
        "CREATE INDEX IF NOT EXISTS idx_siem_source_time ON siem_events (log_source, time DESC)"
    ))
    await db.execute(text(
        "CREATE INDEX IF NOT EXISTS idx_siem_level_time ON siem_events (level, time DESC)"
    ))
    await db.execute(text(
        "CREATE INDEX IF NOT EXISTS idx_siem_event_id ON siem_events (event_id) WHERE event_id IS NOT NULL"
    ))
    await db.commit()


async def _ensure_tables_once(db: AsyncSession):
    global _tables_ready
    if not _tables_ready:
        await _ensure_siem_tables(db)
        _tables_ready = True


# ── Agent auth helper ─────────────────────────────────────────────────────────

async def _get_agent(
    x_api_key: str = Header(..., alias="X-API-Key"),
    db: AsyncSession = Depends(get_db),
):
    agent = await get_agent_by_api_key(db, x_api_key)
    if not agent:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return agent


# ── Pydantic models ───────────────────────────────────────────────────────────

class SiemEventIn(BaseModel):
    time: Optional[datetime] = None
    log_source: str          # windows_security | windows_system | windows_app | journal | syslog
    level: str = "info"      # critical | error | warning | info | debug
    event_id: Optional[int] = None
    channel: Optional[str] = None
    message: str
    raw_data: Optional[dict] = None


# ── Agent event push endpoint ─────────────────────────────────────────────────

@router.post("/agents/siem/events", status_code=202)
async def push_siem_events(
    events: list[SiemEventIn],
    request: Request,
    agent=Depends(_get_agent),
    db: AsyncSession = Depends(get_db),
):
    """Agent pushes a batch of SIEM events (Windows Event Log / journal entries)."""
    await _ensure_tables_once(db)

    if len(events) > 1000:
        raise HTTPException(status_code=413, detail="Batch too large — max 1000 events per call")

    now = datetime.now(timezone.utc)
    source_ip = request.headers.get("X-Forwarded-For", request.client.host if request.client else "")
    rows = []
    for ev in events:
        rows.append({
            "time": (ev.time or now).isoformat(),
            "agent_id": str(agent.id),
            "source_ip": source_ip or None,
            "log_source": ev.log_source[:64],
            "level": ev.level.lower()[:16],
            "event_id": ev.event_id,
            "channel": ev.channel,
            "message": ev.message[:4000],
            "raw_data": json.dumps(ev.raw_data or {}),
        })

    if rows:
        await db.execute(text("""
            INSERT INTO siem_events
                (time, agent_id, source_ip, log_source, level,
                 event_id, channel, message, raw_data)
            SELECT
                r.time::TIMESTAMPTZ,
                r.agent_id::UUID,
                r.source_ip::INET,
                r.log_source, r.level, r.event_id::INTEGER,
                r.channel, r.message, r.raw_data::JSONB
            FROM jsonb_to_recordset(:rows::jsonb) AS r(
                time TEXT, agent_id TEXT, source_ip TEXT,
                log_source TEXT, level TEXT, event_id TEXT,
                channel TEXT, message TEXT, raw_data TEXT
            )
        """), {"rows": json.dumps(rows)})
        await db.commit()

    return {"accepted": len(rows)}


# ── Query endpoints ───────────────────────────────────────────────────────────

@router.get("/siem/events")
async def list_siem_events(
    from_time: Optional[str] = Query(None, alias="from"),
    to_time: Optional[str] = Query(None, alias="to"),
    agent_id: Optional[str] = None,
    log_source: Optional[str] = None,
    level: Optional[str] = None,
    event_id: Optional[int] = None,
    q: Optional[str] = None,
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    await _ensure_tables_once(db)

    now = datetime.now(timezone.utc)
    try:
        t_from = datetime.fromisoformat(from_time.replace("Z", "+00:00")) if from_time else (now - timedelta(hours=24))
        t_to = datetime.fromisoformat(to_time.replace("Z", "+00:00")) if to_time else now
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid time format — use ISO 8601")

    # Enforce max 7-day window
    if (t_to - t_from).total_seconds() > 7 * 86400:
        t_from = t_to - timedelta(days=7)

    filters = ["e.time >= :t_from", "e.time <= :t_to"]
    params: dict = {"t_from": t_from, "t_to": t_to, "limit": limit, "offset": offset}

    if agent_id:
        filters.append("e.agent_id = CAST(:agent_id AS UUID)")
        params["agent_id"] = agent_id
    if log_source:
        filters.append("e.log_source = :log_source")
        params["log_source"] = log_source
    if level:
        filters.append("e.level = :level")
        params["level"] = level.lower()
    if event_id is not None:
        filters.append("e.event_id = :event_id")
        params["event_id"] = event_id
    if q:
        filters.append("e.message ILIKE :q")
        params["q"] = f"%{q}%"

    where = "WHERE " + " AND ".join(filters)

    count_row = await db.execute(text(f"""
        SELECT COUNT(*) FROM siem_events e
        LEFT JOIN agents a ON a.id = e.agent_id
        {where}
          AND (e.agent_id IS NULL OR a.exclude_from_reports = FALSE OR a.id IS NULL)
    """), params)
    total = count_row.scalar() or 0

    rows = await db.execute(text(f"""
        SELECT e.time, e.id, e.agent_id, a.hostname,
               e.source_ip::TEXT, e.log_source, e.level,
               e.event_id, e.channel, e.message, e.raw_data
        FROM siem_events e
        LEFT JOIN agents a ON a.id = e.agent_id
        {where}
          AND (e.agent_id IS NULL OR a.exclude_from_reports = FALSE OR a.id IS NULL)
        ORDER BY e.time DESC
        LIMIT :limit OFFSET :offset
    """), params)

    events = []
    for r in rows.fetchall():
        events.append({
            "time": r.time.isoformat() if r.time else None,
            "id": str(r.id),
            "agent_id": str(r.agent_id) if r.agent_id else None,
            "hostname": r.hostname,
            "source_ip": r.source_ip,
            "log_source": r.log_source,
            "level": r.level,
            "event_id": r.event_id,
            "channel": r.channel,
            "message": r.message,
            "raw_data": r.raw_data,
        })

    return {"total": total, "events": events}


@router.get("/siem/stats")
async def siem_stats(
    from_time: Optional[str] = Query(None, alias="from"),
    to_time: Optional[str] = Query(None, alias="to"),
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    await _ensure_tables_once(db)

    now = datetime.now(timezone.utc)
    try:
        t_from = datetime.fromisoformat(from_time.replace("Z", "+00:00")) if from_time else (now - timedelta(hours=24))
        t_to = datetime.fromisoformat(to_time.replace("Z", "+00:00")) if to_time else now
    except Exception:
        t_from = now - timedelta(hours=24)
        t_to = now

    params = {"t_from": t_from, "t_to": t_to}

    total_row = await db.execute(text("""
        SELECT COUNT(*) FROM siem_events
        WHERE time >= :t_from AND time <= :t_to
    """), params)
    total = total_row.scalar() or 0

    level_rows = await db.execute(text("""
        SELECT level, COUNT(*) AS cnt
        FROM siem_events
        WHERE time >= :t_from AND time <= :t_to
        GROUP BY level ORDER BY cnt DESC
    """), params)
    by_level = {r.level: r.cnt for r in level_rows.fetchall()}

    source_rows = await db.execute(text("""
        SELECT log_source, COUNT(*) AS cnt
        FROM siem_events
        WHERE time >= :t_from AND time <= :t_to
        GROUP BY log_source ORDER BY cnt DESC
    """), params)
    by_source = {r.log_source: r.cnt for r in source_rows.fetchall()}

    agent_rows = await db.execute(text("""
        SELECT e.agent_id, a.hostname, COUNT(*) AS cnt
        FROM siem_events e
        JOIN agents a ON a.id = e.agent_id AND a.exclude_from_reports = FALSE
        WHERE e.time >= :t_from AND e.time <= :t_to
          AND e.agent_id IS NOT NULL
        GROUP BY e.agent_id, a.hostname
        ORDER BY cnt DESC LIMIT 10
    """), params)
    top_agents = [{"agent_id": str(r.agent_id), "hostname": r.hostname, "count": r.cnt}
                  for r in agent_rows.fetchall()]

    eid_rows = await db.execute(text("""
        SELECT event_id, COUNT(*) AS cnt
        FROM siem_events
        WHERE time >= :t_from AND time <= :t_to
          AND event_id IS NOT NULL
        GROUP BY event_id ORDER BY cnt DESC LIMIT 10
    """), params)
    top_event_ids = [{"event_id": r.event_id, "count": r.cnt}
                     for r in eid_rows.fetchall()]

    # Timeline bucketed by 1 hour
    try:
        tl_rows = await db.execute(text("""
            SELECT time_bucket('1 hour', time) AS bucket, COUNT(*) AS cnt
            FROM siem_events
            WHERE time >= :t_from AND time <= :t_to
            GROUP BY bucket ORDER BY bucket
        """), params)
        timeline = [{"bucket": r.bucket.isoformat(), "count": r.cnt}
                    for r in tl_rows.fetchall()]
    except Exception:
        # Fallback if time_bucket not available
        timeline = []

    return {
        "total_events": total,
        "by_level": by_level,
        "by_log_source": by_source,
        "top_agents": top_agents,
        "top_event_ids": top_event_ids,
        "timeline": timeline,
        "from": t_from.isoformat(),
        "to": t_to.isoformat(),
    }


@router.get("/siem/sources")
async def list_sources(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """List distinct log sources that have sent events."""
    await _ensure_tables_once(db)
    rows = await db.execute(text("""
        SELECT DISTINCT log_source FROM siem_events ORDER BY log_source
    """))
    return [r.log_source for r in rows.fetchall()]
