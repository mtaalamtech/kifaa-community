"""Patch Schedule CRUD + Celery-callable execution logic."""
import json
import os
import uuid
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
from fastapi import APIRouter, Depends, HTTPException

from api.database import engine
from api.services.auth import get_current_user
from sqlalchemy import text

router = APIRouter(prefix="/patch-schedules", tags=["Patch Schedules"])


async def _get_platform_timezone() -> ZoneInfo:
    """Read configured timezone from system_settings; fall back to UTC."""
    try:
        async with engine.connect() as conn:
            r = await conn.execute(
                text("SELECT value FROM system_settings WHERE key = 'general'")
            )
            row = r.fetchone()
            if row:
                tz_name = (row[0] or {}).get("timezone", "UTC")
                return ZoneInfo(tz_name)
    except Exception:
        pass
    return ZoneInfo("UTC")


def _get_platform_timezone_sync(db_url: str) -> ZoneInfo:
    """Sync version for Celery / psycopg2 contexts."""
    try:
        import psycopg2
        conn = psycopg2.connect(db_url)
        cur = conn.cursor()
        cur.execute("SELECT value FROM system_settings WHERE key = 'general'")
        row = cur.fetchone()
        cur.close(); conn.close()
        if row:
            tz_name = (row[0] or {}).get("timezone", "UTC")
            return ZoneInfo(tz_name)
    except Exception:
        pass
    return ZoneInfo("UTC")

# ── Table bootstrap ─────────────────────────────────────────────────────────────

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS patch_schedules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    description TEXT,
    target_type TEXT NOT NULL DEFAULT 'all',
    agent_id UUID,
    group_id UUID,
    os_filter TEXT DEFAULT 'all',
    categories JSONB DEFAULT '["security"]',
    frequency TEXT NOT NULL DEFAULT 'weekly',
    scheduled_at TIMESTAMPTZ,
    day_of_week INT,
    day_of_month INT,
    hour_utc INT NOT NULL DEFAULT 2,
    minute_utc INT NOT NULL DEFAULT 0,
    reboot_after BOOLEAN DEFAULT FALSE,
    reboot_mode TEXT DEFAULT 'silent',
    reboot_delay_seconds INT DEFAULT 60,
    is_active BOOLEAN DEFAULT TRUE,
    last_run TIMESTAMPTZ,
    next_run TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS patch_schedule_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    schedule_id UUID NOT NULL,
    schedule_name TEXT,
    fired_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    status TEXT DEFAULT 'running',
    agents_targeted INT DEFAULT 0,
    agents_queued INT DEFAULT 0,
    total_jobs INT DEFAULT 0,
    success_count INT DEFAULT 0,
    failed_count INT DEFAULT 0,
    pending_count INT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule_id ON patch_schedule_runs(schedule_id);
"""

ALTER_PATCH_JOBS_SQL = """
ALTER TABLE patch_jobs ADD COLUMN IF NOT EXISTS schedule_run_id UUID;
ALTER TABLE patch_jobs ADD COLUMN IF NOT EXISTS reboot_after BOOLEAN DEFAULT FALSE;
ALTER TABLE patch_jobs ADD COLUMN IF NOT EXISTS reboot_mode TEXT DEFAULT 'silent';
ALTER TABLE patch_jobs ADD COLUMN IF NOT EXISTS reboot_delay_seconds INT DEFAULT 60;
"""


async def _ensure_table():
    """Execute each DDL statement individually — asyncpg rejects multi-statement strings."""
    all_sql = []
    for block in [CREATE_TABLE_SQL, ALTER_PATCH_JOBS_SQL]:
        for stmt in block.split(";"):
            stmt = stmt.strip()
            if stmt:
                all_sql.append(stmt)
    async with engine.begin() as conn:
        for stmt in all_sql:
            await conn.execute(text(stmt))


# ── next_run helpers ─────────────────────────────────────────────────────────────

async def _next_run(s: dict) -> datetime | None:
    """Compute next UTC fire time from schedule dict fields (async — reads platform timezone)."""
    tz = await _get_platform_timezone()
    return _next_run_from_row(
        s.get("frequency", "weekly"),
        s.get("day_of_week"),
        s.get("day_of_month"),
        s.get("hour_utc", 2),
        s.get("minute_utc", 0),
        s.get("scheduled_at"),
        tz,
    )


def _next_run_from_row(frequency, day_of_week, day_of_month, hour_local, minute_local, scheduled_at,
                       tz: ZoneInfo = None) -> datetime | None:
    """Pure function — importable by Celery task.

    hour_local/minute_local are expressed in the platform timezone (tz).
    Returns a UTC-aware datetime for when this schedule should next fire,
    or None if the schedule is 'once' and its time has already passed.
    """
    if tz is None:
        tz = ZoneInfo("UTC")
    now_local = datetime.now(tz)
    now_utc = datetime.now(timezone.utc)
    h = int(hour_local) if hour_local is not None else 2
    m = int(minute_local) if minute_local is not None else 0

    if frequency == "once":
        if scheduled_at is None:
            return None
        # Accept either a datetime object or ISO string
        if isinstance(scheduled_at, str):
            try:
                dt = datetime.fromisoformat(scheduled_at.replace("Z", "+00:00"))
            except ValueError:
                return None
        else:
            dt = scheduled_at
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt if dt > now_utc else None

    if frequency == "daily":
        candidate = now_local.replace(hour=h, minute=m, second=0, microsecond=0)
        if candidate <= now_local:
            candidate += timedelta(days=1)
        return candidate.astimezone(timezone.utc)

    if frequency == "weekly":
        dow = int(day_of_week) if day_of_week is not None else 0  # 0=Monday
        days_ahead = (dow - now_local.weekday()) % 7
        candidate = (now_local + timedelta(days=days_ahead)).replace(
            hour=h, minute=m, second=0, microsecond=0
        )
        if candidate <= now_local:
            candidate += timedelta(weeks=1)
        return candidate.astimezone(timezone.utc)

    if frequency == "monthly":
        dom = int(day_of_month) if day_of_month is not None else 1
        try:
            candidate = now_local.replace(day=dom, hour=h, minute=m, second=0, microsecond=0)
        except ValueError:
            candidate = now_local.replace(day=28, hour=h, minute=m, second=0, microsecond=0)
        if candidate <= now_local:
            if now_local.month == 12:
                candidate = candidate.replace(year=now_local.year + 1, month=1)
            else:
                candidate = candidate.replace(month=now_local.month + 1)
        return candidate.astimezone(timezone.utc)

    # Fallback
    return now_utc + timedelta(days=1)


# ── Serialisation helper ─────────────────────────────────────────────────────────

def _row_to_dict(row) -> dict:
    return {
        "id": str(row[0]),
        "name": row[1],
        "description": row[2],
        "target_type": row[3],
        "agent_id": str(row[4]) if row[4] else None,
        "group_id": str(row[5]) if row[5] else None,
        "os_filter": row[6],
        "categories": row[7] if row[7] is not None else ["security"],
        "frequency": row[8],
        "scheduled_at": row[9].isoformat() if row[9] else None,
        "day_of_week": row[10],
        "day_of_month": row[11],
        "hour_utc": row[12],
        "minute_utc": row[13],
        "reboot_after": row[14],
        "reboot_mode": row[15],
        "reboot_delay_seconds": row[16],
        "is_active": row[17],
        "last_run": row[18].isoformat() if row[18] else None,
        "next_run": row[19].isoformat() if row[19] else None,
        "created_at": row[20].isoformat() if row[20] else None,
        "target_name": row[21],
    }


SELECT_COLS = """
    ps.id, ps.name, ps.description, ps.target_type, ps.agent_id, ps.group_id,
    ps.os_filter, ps.categories, ps.frequency, ps.scheduled_at,
    ps.day_of_week, ps.day_of_month, ps.hour_utc, ps.minute_utc,
    ps.reboot_after, ps.reboot_mode, ps.reboot_delay_seconds,
    ps.is_active, ps.last_run, ps.next_run, ps.created_at,
    COALESCE(a.hostname, ag.name) AS target_name
"""

SELECT_JOINS = """
    FROM patch_schedules ps
    LEFT JOIN agents a ON a.id = ps.agent_id
    LEFT JOIN agent_groups ag ON ag.id = ps.group_id
"""


# ── Endpoints ────────────────────────────────────────────────────────────────────

@router.get("")
async def list_schedules(_=Depends(get_current_user)):
    await _ensure_table()
    async with engine.connect() as conn:
        rows = await conn.execute(text(f"""
            SELECT {SELECT_COLS} {SELECT_JOINS}
            ORDER BY ps.created_at DESC
        """))
        return [_row_to_dict(r) for r in rows.fetchall()]


@router.post("", status_code=201)
async def create_schedule(body: dict, _=Depends(get_current_user)):
    await _ensure_table()
    nr = await _next_run(body)
    async with engine.begin() as conn:
        row = await conn.execute(text("""
            INSERT INTO patch_schedules
                (name, description, target_type, agent_id, group_id, os_filter,
                 categories, frequency, scheduled_at, day_of_week, day_of_month,
                 hour_utc, minute_utc, reboot_after, reboot_mode, reboot_delay_seconds,
                 is_active, next_run)
            VALUES
                (:name, :description, :target_type, :agent_id, :group_id, :os_filter,
                 CAST(:categories AS jsonb), :frequency, :scheduled_at,
                 :day_of_week, :day_of_month, :hour_utc, :minute_utc,
                 :reboot_after, :reboot_mode, :reboot_delay_seconds, :is_active, :next_run)
            RETURNING id
        """), {
            "name": body["name"],
            "description": body.get("description"),
            "target_type": body.get("target_type", "all"),
            "agent_id": body.get("agent_id") or None,
            "group_id": body.get("group_id") or None,
            "os_filter": body.get("os_filter", "all"),
            "categories": json.dumps(body.get("categories", ["security"])),
            "frequency": body.get("frequency", "weekly"),
            "scheduled_at": body.get("scheduled_at") or None,
            "day_of_week": body.get("day_of_week"),
            "day_of_month": body.get("day_of_month"),
            "hour_utc": int(body.get("hour_utc", 2)),
            "minute_utc": int(body.get("minute_utc", 0)),
            "reboot_after": bool(body.get("reboot_after", False)),
            "reboot_mode": body.get("reboot_mode", "silent"),
            "reboot_delay_seconds": int(body.get("reboot_delay_seconds", 60)),
            "is_active": bool(body.get("is_active", True)),
            "next_run": nr,
        })
        new_id = row.fetchone()[0]

    async with engine.connect() as conn:
        r = await conn.execute(text(f"""
            SELECT {SELECT_COLS} {SELECT_JOINS}
            WHERE ps.id = :id
        """), {"id": new_id})
        return _row_to_dict(r.fetchone())


@router.put("/{schedule_id}")
async def update_schedule(schedule_id: str, body: dict, _=Depends(get_current_user)):
    await _ensure_table()
    async with engine.connect() as conn:
        r = await conn.execute(
            text("SELECT id FROM patch_schedules WHERE id = :id"),
            {"id": schedule_id},
        )
        if not r.fetchone():
            raise HTTPException(404, "Schedule not found")

    fields = {}
    for f in ["name", "description", "target_type", "agent_id", "group_id",
              "os_filter", "frequency", "scheduled_at", "day_of_week", "day_of_month",
              "hour_utc", "minute_utc", "reboot_after", "reboot_mode",
              "reboot_delay_seconds", "is_active"]:
        if f in body:
            fields[f] = body[f]

    nr = await _next_run({**fields, **{k: body.get(k) for k in body if k not in fields}})
    fields["next_run"] = nr
    fields["id"] = schedule_id

    # categories needs special cast
    categories_val = None
    if "categories" in body:
        categories_val = json.dumps(body["categories"])

    set_parts = []
    for k in fields:
        if k == "id":
            continue
        set_parts.append(f"{k} = :{k}")

    if categories_val is not None:
        set_parts = [p for p in set_parts if not p.startswith("categories")]
        # We'll handle categories separately via a direct param
        fields["categories_json"] = categories_val
        set_parts.append("categories = CAST(:categories_json AS jsonb)")

    set_clause = ", ".join(set_parts)
    async with engine.begin() as conn:
        await conn.execute(
            text(f"UPDATE patch_schedules SET {set_clause} WHERE id = :id"),
            fields,
        )

    async with engine.connect() as conn:
        r = await conn.execute(text(f"""
            SELECT {SELECT_COLS} {SELECT_JOINS}
            WHERE ps.id = :id
        """), {"id": schedule_id})
        return _row_to_dict(r.fetchone())


@router.delete("/{schedule_id}", status_code=204)
async def delete_schedule(schedule_id: str, _=Depends(get_current_user)):
    await _ensure_table()
    async with engine.begin() as conn:
        r = await conn.execute(
            text("DELETE FROM patch_schedules WHERE id = :id RETURNING id"),
            {"id": schedule_id},
        )
        if not r.fetchone():
            raise HTTPException(404, "Schedule not found")


@router.post("/{schedule_id}/run-now")
async def run_now(schedule_id: str, _=Depends(get_current_user)):
    """Trigger immediate execution of a patch schedule."""
    await _ensure_table()
    async with engine.connect() as conn:
        r = await conn.execute(
            text("SELECT id FROM patch_schedules WHERE id = :id"),
            {"id": schedule_id},
        )
        if not r.fetchone():
            raise HTTPException(404, "Schedule not found")

    db_url = os.getenv("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    tz = _get_platform_timezone_sync(db_url)
    agents_queued = _execute_schedule_sync(schedule_id, db_url, tz)
    return {"agents_queued": agents_queued}


@router.get("/{schedule_id}/history")
async def get_schedule_history(schedule_id: str, limit: int = 50, _=Depends(get_current_user)):
    """Return run history for a schedule, with per-job success/fail counts refreshed from patch_jobs."""
    await _ensure_table()
    async with engine.connect() as conn:
        # Verify schedule exists
        r = await conn.execute(
            text("SELECT id FROM patch_schedules WHERE id = :id"),
            {"id": schedule_id},
        )
        if not r.fetchone():
            raise HTTPException(404, "Schedule not found")

        # Fetch runs ordered by most recent first
        rows = await conn.execute(text("""
            SELECT
                r.id, r.schedule_id, r.schedule_name, r.fired_at, r.completed_at,
                r.status, r.agents_targeted, r.agents_queued,
                -- Live job counts from patch_jobs
                COUNT(j.id) AS total_jobs,
                COUNT(j.id) FILTER (WHERE j.status = 'success') AS success_count,
                COUNT(j.id) FILTER (WHERE j.status = 'failed') AS failed_count,
                COUNT(j.id) FILTER (WHERE j.status = 'pending') AS pending_count,
                COUNT(j.id) FILTER (WHERE j.status = 'running') AS running_count,
                COUNT(j.id) FILTER (WHERE j.status = 'timed_out') AS timed_out_count
            FROM patch_schedule_runs r
            LEFT JOIN patch_jobs j ON j.schedule_run_id = r.id
            WHERE r.schedule_id = :sid
            GROUP BY r.id
            ORDER BY r.fired_at DESC
            LIMIT :lim
        """), {"sid": schedule_id, "lim": limit})

        results = []
        for r in rows.fetchall():
            total = r.total_jobs or 0
            success = r.success_count or 0
            failed = r.failed_count or 0
            pending = r.pending_count or 0
            running = r.running_count or 0
            timed_out = r.timed_out_count or 0

            # Determine effective status
            if r.status == 'running' and running == 0 and pending == 0:
                effective_status = 'completed'
            elif total > 0 and failed == 0 and pending == 0 and running == 0:
                effective_status = 'success'
            elif total > 0 and failed > 0 and pending == 0 and running == 0:
                effective_status = 'failed' if success == 0 else 'partial'
            else:
                effective_status = r.status

            results.append({
                "id": str(r.id),
                "schedule_id": str(r.schedule_id),
                "schedule_name": r.schedule_name,
                "fired_at": r.fired_at.isoformat() if r.fired_at else None,
                "completed_at": r.completed_at.isoformat() if r.completed_at else None,
                "status": effective_status,
                "agents_targeted": r.agents_targeted or 0,
                "agents_queued": r.agents_queued or 0,
                "total_jobs": total,
                "success_count": success,
                "failed_count": failed,
                "pending_count": pending,
                "running_count": running,
                "timed_out_count": timed_out,
            })
        return results


@router.get("/{schedule_id}/history/{run_id}/jobs")
async def get_run_jobs(schedule_id: str, run_id: str, _=Depends(get_current_user)):
    """Return individual patch_jobs for a specific schedule run."""
    await _ensure_table()
    async with engine.connect() as conn:
        rows = await conn.execute(text("""
            SELECT j.id, a.hostname, j.packages, j.status, j.output,
                   j.started_at, j.finished_at
            FROM patch_jobs j
            JOIN agents a ON a.id = j.agent_id
            WHERE j.schedule_run_id = :run_id
            ORDER BY a.hostname
        """), {"run_id": run_id})
        return [
            {
                "job_id": str(r.id),
                "hostname": r.hostname,
                "packages": r.packages or [],
                "status": r.status,
                "output": r.output or "",
                "started_at": r.started_at.isoformat() if r.started_at else None,
                "finished_at": r.finished_at.isoformat() if r.finished_at else None,
            }
            for r in rows.fetchall()
        ]


@router.get("/timezone")
async def get_timezone(_=Depends(get_current_user)):
    """Return the platform timezone name for display in the UI."""
    tz = await _get_platform_timezone()
    return {"timezone": str(tz)}


@router.post("/internal/run-due", include_in_schema=False)
async def run_due():
    """Called by Celery beat every minute — fires patch commands for due schedules."""
    await _ensure_table()
    now = datetime.now(timezone.utc)
    db_url = os.getenv("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    tz = _get_platform_timezone_sync(db_url)

    import psycopg2
    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    cur = conn.cursor()
    fired = 0
    errors = []

    try:
        cur.execute(
            "SELECT id::text FROM patch_schedules WHERE is_active=TRUE AND next_run <= %s",
            (now,),
        )
        due = [r[0] for r in cur.fetchall()]

        for sid in due:
            try:
                _execute_schedule_sync(sid, db_url, tz)
                cur.execute(
                    "SELECT frequency, day_of_week, day_of_month, hour_utc, minute_utc, scheduled_at "
                    "FROM patch_schedules WHERE id=%s",
                    (sid,),
                )
                row = cur.fetchone()
                if row:
                    next_r = _next_run_from_row(*row, tz)
                    cur.execute(
                        "UPDATE patch_schedules SET last_run=%s, next_run=%s WHERE id=%s",
                        (now, next_r, sid),
                    )
                fired += 1
            except Exception as e:
                errors.append(f"{sid}: {e}")
    finally:
        try:
            cur.close()
            conn.close()
        except Exception:
            pass

    return {"fired": fired, "errors": errors}


# ── Core sync execution (called by Celery task directly) ─────────────────────────

def _execute_schedule_sync(schedule_id: str, db_url: str, tz: ZoneInfo = None) -> int:
    """
    Pure psycopg2 sync function.
    Fetches the schedule, resolves target agents, queries their pending patches,
    and inserts patch_jobs + agent_commands rows.
    Records a patch_schedule_runs entry for history tracking.
    Returns the number of agents queued.
    """
    import psycopg2

    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    cur = conn.cursor()

    run_id = str(uuid.uuid4())

    try:
        # 1. Fetch schedule
        cur.execute("""
            SELECT id, name, target_type, agent_id, group_id, os_filter,
                   categories, reboot_after, reboot_mode, reboot_delay_seconds
            FROM patch_schedules
            WHERE id = %s
        """, (schedule_id,))
        row = cur.fetchone()
        if not row:
            return 0

        (sched_id, sched_name, target_type, sched_agent_id, sched_group_id, os_filter,
         categories, reboot_after, reboot_mode, reboot_delay_seconds) = row

        # categories comes back as a list from psycopg2 (json column)
        if isinstance(categories, str):
            categories = json.loads(categories)
        if not categories:
            categories = ["security"]

        # 1b. Create a run record
        cur.execute("""
            INSERT INTO patch_schedule_runs (id, schedule_id, schedule_name, status)
            VALUES (%s, %s, %s, 'running')
        """, (run_id, str(sched_id), sched_name))

        # 2. Build agent query
        conditions = ["is_active = TRUE", "status = 'online'"]
        params: list = []

        if os_filter and os_filter != "all":
            conditions.append("os_type = %s")
            params.append(os_filter)

        if target_type == "agent" and sched_agent_id:
            conditions.append("id = %s")
            params.append(str(sched_agent_id))
        elif target_type == "group" and sched_group_id:
            conditions.append("id IN (SELECT agent_id FROM agent_group_members WHERE group_id = %s)")
            params.append(str(sched_group_id))

        where = " AND ".join(conditions)
        cur.execute(f"SELECT id::text, hostname FROM agents WHERE {where}", params)
        agents = cur.fetchall()

        agents_queued = 0
        for (agent_id, hostname) in agents:
            # 3. Get pending patches for this agent matching categories
            cur.execute("""
                SELECT package_name
                FROM agent_patches
                WHERE agent_id = %s
                  AND category = ANY(%s)
            """, (agent_id, categories))
            packages = [r[0] for r in cur.fetchall()]

            if not packages:
                continue

            # 4. Insert patch_jobs (tag with schedule_run_id)
            job_id = str(uuid.uuid4())
            cur.execute("""
                INSERT INTO patch_jobs
                    (id, agent_id, job_type, packages, status, triggered_by,
                     reboot_after, reboot_mode, reboot_delay_seconds, schedule_run_id)
                VALUES
                    (%s, %s, 'apply', %s, 'pending', 'scheduled',
                     %s, %s, %s, %s)
            """, (
                job_id, agent_id, packages,
                bool(reboot_after), reboot_mode or "silent",
                int(reboot_delay_seconds) if reboot_delay_seconds else 60,
                run_id,
            ))

            # 5. Queue command for agent
            payload = json.dumps({
                "job_id": job_id,
                "packages": packages,
                "reboot_after": bool(reboot_after),
                "reboot_mode": reboot_mode or "silent",
                "reboot_delay_seconds": int(reboot_delay_seconds) if reboot_delay_seconds else 60,
            })
            cur.execute("""
                INSERT INTO agent_commands (agent_id, command_type, payload)
                VALUES (%s, 'apply_patches', CAST(%s AS jsonb))
            """, (agent_id, payload))

            agents_queued += 1

        # 6. Update run record with final counts
        cur.execute("""
            UPDATE patch_schedule_runs SET
                completed_at = NOW(),
                status = CASE WHEN %s > 0 THEN 'queued' ELSE 'skipped' END,
                agents_targeted = %s,
                agents_queued = %s,
                total_jobs = %s,
                pending_count = %s
            WHERE id = %s
        """, (agents_queued, len(agents), agents_queued, agents_queued, agents_queued, run_id))

        return agents_queued

    except Exception:
        # Mark run as failed
        try:
            cur.execute("""
                UPDATE patch_schedule_runs SET completed_at = NOW(), status = 'failed'
                WHERE id = %s
            """, (run_id,))
        except Exception:
            pass
        raise

    finally:
        try:
            cur.close()
            conn.close()
        except Exception:
            pass
