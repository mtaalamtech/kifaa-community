"""Reboot Schedule CRUD + internal trigger endpoint."""
import json
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text

from api.database import engine, get_db
from api.services.auth import get_current_user

router = APIRouter(prefix="/reboot-schedules", tags=["Reboot Schedules"])


async def _get_platform_timezone() -> ZoneInfo:
    """Read the configured timezone from system_settings; fall back to UTC."""
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


def _calc_next_run(frequency, day_of_week, day_of_month, hour_local, minute_local, tz: ZoneInfo) -> datetime:
    """Compute the next UTC datetime when the schedule should fire.

    hour_local/minute_local are in the platform's configured timezone.
    Returns a UTC-aware datetime.
    """
    now_local = datetime.now(tz)
    h, m = int(hour_local), int(minute_local)

    if frequency == "daily":
        candidate = now_local.replace(hour=h, minute=m, second=0, microsecond=0)
        if candidate <= now_local:
            candidate += timedelta(days=1)
        return candidate.astimezone(timezone.utc)

    if frequency == "weekly":
        dow = int(day_of_week) if day_of_week is not None else 0  # 0=Mon
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

    return datetime.now(timezone.utc) + timedelta(days=1)


@router.get("/timezone")
async def get_schedule_timezone(_=Depends(get_current_user)):
    """Returns the platform timezone used for schedule time input."""
    tz = await _get_platform_timezone()
    return {"timezone": str(tz)}


@router.get("")
async def list_schedules(_=Depends(get_current_user)):
    async with engine.connect() as conn:
        rows = await conn.execute(text("""
            SELECT
                rs.id, rs.name, rs.target_type, rs.agent_id, rs.group_id,
                rs.frequency, rs.day_of_week, rs.day_of_month,
                rs.hour_utc, rs.minute_utc, rs.mode, rs.delay_seconds,
                rs.is_enabled, rs.last_run_at, rs.next_run_at, rs.created_at,
                COALESCE(a.hostname, ag.name) AS target_name
            FROM reboot_schedules rs
            LEFT JOIN agents a ON a.id = rs.agent_id
            LEFT JOIN agent_groups ag ON ag.id = rs.group_id
            ORDER BY rs.created_at DESC
        """))
        return [_row_to_dict(r) for r in rows.fetchall()]


@router.post("", status_code=201)
async def create_schedule(body: dict, _=Depends(get_current_user)):
    tz = await _get_platform_timezone()
    next_run = _calc_next_run(
        body.get("frequency", "daily"),
        body.get("day_of_week"),
        body.get("day_of_month"),
        body.get("hour_utc", 2),
        body.get("minute_utc", 0),
        tz,
    )
    async with engine.begin() as conn:
        row = await conn.execute(text("""
            INSERT INTO reboot_schedules
                (name, target_type, agent_id, group_id, frequency,
                 day_of_week, day_of_month, hour_utc, minute_utc,
                 mode, delay_seconds, is_enabled, next_run_at)
            VALUES
                (:name, :target_type, :agent_id, :group_id, :frequency,
                 :day_of_week, :day_of_month, :hour_utc, :minute_utc,
                 :mode, :delay_seconds, :is_enabled, :next_run_at)
            RETURNING id
        """), {
            "name": body["name"],
            "target_type": body["target_type"],
            "agent_id": body.get("agent_id") or None,
            "group_id": body.get("group_id") or None,
            "frequency": body.get("frequency", "daily"),
            "day_of_week": body.get("day_of_week"),
            "day_of_month": body.get("day_of_month"),
            "hour_utc": int(body.get("hour_utc", 2)),
            "minute_utc": int(body.get("minute_utc", 0)),
            "mode": body.get("mode", "announced"),
            "delay_seconds": int(body.get("delay_seconds", 60)),
            "is_enabled": body.get("is_enabled", True),
            "next_run_at": next_run,
        })
        new_id = row.fetchone()[0]

    async with engine.connect() as conn:
        r = await conn.execute(text("""
            SELECT rs.id, rs.name, rs.target_type, rs.agent_id, rs.group_id,
                   rs.frequency, rs.day_of_week, rs.day_of_month,
                   rs.hour_utc, rs.minute_utc, rs.mode, rs.delay_seconds,
                   rs.is_enabled, rs.last_run_at, rs.next_run_at, rs.created_at,
                   COALESCE(a.hostname, ag.name) AS target_name
            FROM reboot_schedules rs
            LEFT JOIN agents a ON a.id = rs.agent_id
            LEFT JOIN agent_groups ag ON ag.id = rs.group_id
            WHERE rs.id = :id
        """), {"id": new_id})
        return _row_to_dict(r.fetchone())


@router.put("/{schedule_id}")
async def update_schedule(schedule_id: str, body: dict, _=Depends(get_current_user)):
    async with engine.connect() as conn:
        r = await conn.execute(
            text("SELECT id FROM reboot_schedules WHERE id = :id"),
            {"id": schedule_id},
        )
        if not r.fetchone():
            raise HTTPException(404, "Schedule not found")

    # Build update fields
    fields = {}
    for f in ["name", "target_type", "agent_id", "group_id", "frequency",
              "day_of_week", "day_of_month", "hour_utc", "minute_utc",
              "mode", "delay_seconds", "is_enabled"]:
        if f in body:
            fields[f] = body[f]

    # Recalculate next_run_at
    tz = await _get_platform_timezone()
    next_run = _calc_next_run(
        fields.get("frequency", body.get("frequency", "daily")),
        fields.get("day_of_week", body.get("day_of_week")),
        fields.get("day_of_month", body.get("day_of_month")),
        fields.get("hour_utc", body.get("hour_utc", 2)),
        fields.get("minute_utc", body.get("minute_utc", 0)),
        tz,
    )
    fields["next_run_at"] = next_run
    fields["id"] = schedule_id

    set_clause = ", ".join(f"{k} = :{k}" for k in fields if k != "id")
    async with engine.begin() as conn:
        await conn.execute(
            text(f"UPDATE reboot_schedules SET {set_clause} WHERE id = :id"),
            fields,
        )

    async with engine.connect() as conn:
        r = await conn.execute(text("""
            SELECT rs.id, rs.name, rs.target_type, rs.agent_id, rs.group_id,
                   rs.frequency, rs.day_of_week, rs.day_of_month,
                   rs.hour_utc, rs.minute_utc, rs.mode, rs.delay_seconds,
                   rs.is_enabled, rs.last_run_at, rs.next_run_at, rs.created_at,
                   COALESCE(a.hostname, ag.name) AS target_name
            FROM reboot_schedules rs
            LEFT JOIN agents a ON a.id = rs.agent_id
            LEFT JOIN agent_groups ag ON ag.id = rs.group_id
            WHERE rs.id = :id
        """), {"id": schedule_id})
        return _row_to_dict(r.fetchone())


@router.delete("/{schedule_id}", status_code=204)
async def delete_schedule(schedule_id: str, _=Depends(get_current_user)):
    async with engine.begin() as conn:
        r = await conn.execute(
            text("DELETE FROM reboot_schedules WHERE id = :id RETURNING id"),
            {"id": schedule_id},
        )
        if not r.fetchone():
            raise HTTPException(404, "Schedule not found")


@router.post("/{schedule_id}/test")
async def test_schedule(schedule_id: str, _=Depends(get_current_user)):
    """Fire the reboot command immediately without advancing next_run_at."""
    async with engine.begin() as conn:
        r = await conn.execute(text("""
            SELECT target_type, agent_id, group_id, mode, delay_seconds
            FROM reboot_schedules WHERE id = :id
        """), {"id": schedule_id})
        row = r.fetchone()
        if not row:
            raise HTTPException(404, "Schedule not found")

        target_type, agent_id, group_id, mode, delay_seconds = row

        if target_type == "agent":
            agent_ids = [agent_id] if agent_id else []
        else:
            res = await conn.execute(text("""
                SELECT a.id FROM agents a
                JOIN agent_group_members agm ON agm.agent_id = a.id
                WHERE agm.group_id = :gid AND a.status = 'online'
            """), {"gid": group_id})
            agent_ids = [r[0] for r in res.fetchall()]

        if not agent_ids:
            raise HTTPException(400, "No online agents found for this schedule target")

        payload = json.dumps({"mode": mode, "delay_seconds": delay_seconds})
        fired = 0
        for aid in agent_ids:
            await conn.execute(text("""
                INSERT INTO agent_commands (agent_id, command_type, payload)
                VALUES (:agent_id, 'restart_machine', CAST(:payload AS jsonb))
            """), {"agent_id": aid, "payload": payload})
            fired += 1

    return {"fired": fired, "mode": mode, "delay_seconds": delay_seconds}


@router.post("/{schedule_id}/toggle")
async def toggle_schedule(schedule_id: str, _=Depends(get_current_user)):
    async with engine.begin() as conn:
        r = await conn.execute(
            text("""
                UPDATE reboot_schedules
                SET is_enabled = NOT is_enabled
                WHERE id = :id
                RETURNING is_enabled
            """),
            {"id": schedule_id},
        )
        row = r.fetchone()
        if not row:
            raise HTTPException(404, "Schedule not found")
        return {"is_enabled": row[0]}


@router.post("/internal/run-due", include_in_schema=False)
async def run_due():
    """Called by Celery beat every minute — fires restart_machine commands for due schedules."""
    now = datetime.now(timezone.utc)
    fired = 0
    errors = []

    async with engine.begin() as conn:
        due_rows = await conn.execute(text("""
            SELECT id, target_type, agent_id, group_id,
                   frequency, day_of_week, day_of_month,
                   hour_utc, minute_utc, mode, delay_seconds
            FROM reboot_schedules
            WHERE is_enabled = TRUE AND next_run_at <= :now
        """), {"now": now})
        due = due_rows.fetchall()

        for row in due:
            (sched_id, target_type, agent_id, group_id,
             frequency, day_of_week, day_of_month,
             hour_utc, minute_utc, mode, delay_seconds) = row

            # Resolve agent IDs
            if target_type == "agent":
                if agent_id:
                    agent_ids = [agent_id]
                else:
                    agent_ids = []
            else:
                # group — get all online agents in the group
                res = await conn.execute(text("""
                    SELECT a.id FROM agents a
                    JOIN agent_group_members agm ON agm.agent_id = a.id
                    WHERE agm.group_id = :gid AND a.status = 'online'
                """), {"gid": group_id})
                agent_ids = [r[0] for r in res.fetchall()]

            # Queue restart_machine command for each agent
            payload = json.dumps({"mode": mode, "delay_seconds": delay_seconds})
            for aid in agent_ids:
                try:
                    await conn.execute(text("""
                        INSERT INTO agent_commands (agent_id, command_type, payload)
                        VALUES (:agent_id, 'restart_machine', CAST(:payload AS jsonb))
                    """), {"agent_id": aid, "payload": payload})
                    fired += 1
                except Exception as e:
                    errors.append(str(e))

            # Advance schedule
            tz = await _get_platform_timezone()
            next_run = _calc_next_run(frequency, day_of_week, day_of_month, hour_utc, minute_utc, tz)
            await conn.execute(text("""
                UPDATE reboot_schedules
                SET last_run_at = :now, next_run_at = :next_run
                WHERE id = :id
            """), {"now": now, "next_run": next_run, "id": sched_id})

    return {"fired": fired, "schedules_processed": len(due), "errors": errors}


def _row_to_dict(row) -> dict:
    return {
        "id": str(row[0]),
        "name": row[1],
        "target_type": row[2],
        "agent_id": str(row[3]) if row[3] else None,
        "group_id": str(row[4]) if row[4] else None,
        "frequency": row[5],
        "day_of_week": row[6],
        "day_of_month": row[7],
        "hour_utc": row[8],
        "minute_utc": row[9],
        "mode": row[10],
        "delay_seconds": row[11],
        "is_enabled": row[12],
        "last_run_at": row[13].isoformat() if row[13] else None,
        "next_run_at": row[14].isoformat() if row[14] else None,
        "created_at": row[15].isoformat() if row[15] else None,
        "target_name": row[16],
    }
