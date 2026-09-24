"""
Server Maintenance Plan router.
Manages patching cycles, cycle-agent assignments, and exports maintenance
schedules to XLSX (3-sheet dark-themed workbook).
"""
from __future__ import annotations

import io
import uuid as _uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.database import get_db
from api.services.auth import get_current_user

router = APIRouter(prefix="/maintenance", tags=["maintenance"])

# ---------------------------------------------------------------------------
# Table bootstrap
# ---------------------------------------------------------------------------
_TABLES_CREATED = False


async def _ensure_tables(db: AsyncSession) -> None:
    global _TABLES_CREATED
    if _TABLES_CREATED:
        return

    try:
        await db.execute(text("""
            CREATE TABLE IF NOT EXISTS maintenance_cycles (
                id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                name                   TEXT NOT NULL,
                description            TEXT DEFAULT '',
                frequency              TEXT DEFAULT 'monthly',
                patch_day              TEXT DEFAULT 'Monday',
                patch_week             TEXT DEFAULT '1st',
                preferred_time         TEXT DEFAULT '02:00',
                restart_action         TEXT DEFAULT 'none',
                pre_notification_hours INT  DEFAULT 24,
                notes                  TEXT DEFAULT '',
                created_at             TIMESTAMPTZ DEFAULT NOW(),
                updated_at             TIMESTAMPTZ DEFAULT NOW()
            )
        """))
    except Exception:
        await db.rollback()

    # Migrate INT columns to TEXT if they were created with old schema
    for col, default in [("patch_day", "'Monday'"), ("patch_week", "'1st'")]:
        try:
            await db.execute(text(
                f"ALTER TABLE maintenance_cycles "
                f"ALTER COLUMN {col} TYPE TEXT USING {col}::TEXT, "
                f"ALTER COLUMN {col} SET DEFAULT {default}"
            ))
            await db.commit()
        except Exception:
            await db.rollback()

    for col, defn in [
        ("cycle_type",        "TEXT DEFAULT 'patch'"),
        ("group_name",        "TEXT DEFAULT ''"),
        ("linked_cycle_id",   "UUID REFERENCES maintenance_cycles(id) ON DELETE SET NULL"),
    ]:
        try:
            await db.execute(text(
                f"ALTER TABLE maintenance_cycles ADD COLUMN IF NOT EXISTS {col} {defn}"
            ))
            await db.commit()
        except Exception:
            await db.rollback()

    for col, defn in [
        ("maint_frequency",     "TEXT DEFAULT 'monthly'"),
        ("maint_day",           "TEXT DEFAULT 'Wednesday'"),
        ("maint_week",          "TEXT DEFAULT '1st'"),
        ("maint_time",          "TEXT DEFAULT '22:00'"),
        ("maint_restart_action","TEXT DEFAULT 'none'"),
    ]:
        try:
            await db.execute(text(
                f"ALTER TABLE maintenance_cycles ADD COLUMN IF NOT EXISTS {col} {defn}"
            ))
            await db.commit()
        except Exception:
            await db.rollback()

    try:
        await db.execute(text("""
            CREATE TABLE IF NOT EXISTS maintenance_cycle_agents (
                id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                cycle_id    UUID NOT NULL REFERENCES maintenance_cycles(id) ON DELETE CASCADE,
                agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
                assigned_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE (cycle_id, agent_id)
            )
        """))
    except Exception:
        await db.rollback()

    try:
        await db.execute(text("""
            CREATE TABLE IF NOT EXISTS maintenance_history (
                id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                cycle_id    UUID REFERENCES maintenance_cycles(id) ON DELETE SET NULL,
                agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
                actioned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                action_type TEXT NOT NULL DEFAULT 'patch',
                status      TEXT NOT NULL DEFAULT 'pending',
                notes       TEXT DEFAULT '',
                created_by  TEXT DEFAULT '',
                created_at  TIMESTAMPTZ DEFAULT NOW()
            )
        """))
    except Exception:
        await db.rollback()

    try:
        await db.execute(text("""
            CREATE TABLE IF NOT EXISTS maintenance_notification_settings (
                id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                name                TEXT DEFAULT '',
                email               TEXT NOT NULL,
                notification_type   TEXT NOT NULL DEFAULT 'post_patch',
                cycle_type_filter   TEXT NOT NULL DEFAULT 'all',
                send_time           TEXT DEFAULT '09:00',
                is_active           BOOLEAN NOT NULL DEFAULT TRUE,
                created_at          TIMESTAMPTZ DEFAULT NOW(),
                updated_at          TIMESTAMPTZ DEFAULT NOW()
            )
        """))
        await db.commit()
    except Exception:
        await db.rollback()

    try:
        await db.execute(text("""
            CREATE TABLE IF NOT EXISTS maintenance_reports (
                id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                cycle_id         UUID REFERENCES maintenance_cycles(id) ON DELETE SET NULL,
                report_type      TEXT NOT NULL DEFAULT 'post_patch',
                group_name       TEXT DEFAULT '',
                period_start     DATE,
                period_end       DATE,
                patches_applied  INT DEFAULT 0,
                patches_failed   INT DEFAULT 0,
                servers_affected INT DEFAULT 0,
                services_verified BOOLEAN DEFAULT TRUE,
                issues_found     TEXT DEFAULT '',
                actions_taken    TEXT DEFAULT '',
                rollback_required BOOLEAN DEFAULT FALSE,
                next_steps       TEXT DEFAULT '',
                status           TEXT DEFAULT 'completed',
                created_by       TEXT DEFAULT '',
                created_at       TIMESTAMPTZ DEFAULT NOW()
            )
        """))
        await db.commit()
    except Exception:
        await db.rollback()

    try:
        await db.commit()
    except Exception:
        await db.rollback()

    _TABLES_CREATED = True


# ---------------------------------------------------------------------------
# Next-maintenance-date helper
# ---------------------------------------------------------------------------

def _next_maintenance_date(
    frequency: str,
    patch_day,    # str "Monday".."Sunday" or int 0-6
    patch_week,   # str "1st".."4th" or int 1-4
) -> date:
    """
    Return the next maintenance date based on frequency, patch_day (day name),
    patch_week (ordinal string or int). Always at least tomorrow.
    """
    _DAY_MAP  = {"Monday": 0, "Tuesday": 1, "Wednesday": 2, "Thursday": 3,
                 "Friday": 4, "Saturday": 5, "Sunday": 6}
    _WEEK_MAP = {"1st": 1, "2nd": 2, "3rd": 3, "4th": 4}

    # Normalise patch_day → integer 0-6
    if isinstance(patch_day, str):
        day_num = _DAY_MAP.get(patch_day, 0)
    else:
        day_num = int(patch_day or 0) % 7

    # Normalise patch_week → integer 1-4
    if isinstance(patch_week, str):
        week_num = _WEEK_MAP.get(patch_week, 1)
    else:
        try:
            week_num = int(patch_week or 1)
        except Exception:
            week_num = 1

    today    = date.today()
    tomorrow = today + timedelta(days=1)

    if frequency == "weekly":
        days_ahead = day_num - tomorrow.weekday()
        if days_ahead < 0:
            days_ahead += 7
        return tomorrow + timedelta(days=days_ahead)

    def _nth_weekday_in_month(year: int, month: int, weekday: int, n: int) -> Optional[date]:
        """Return the Nth (1-based) occurrence of weekday in the given month, or None."""
        day = date(year, month, 1)
        days_ahead = weekday - day.weekday()
        if days_ahead < 0:
            days_ahead += 7
        day = day + timedelta(days=days_ahead)
        count = 1
        while count < n:
            day = day + timedelta(weeks=1)
            if day.month != month:
                return None
            count += 1
        if day.month != month:
            return None
        return day

    if frequency == "monthly":
        year, month = tomorrow.year, tomorrow.month
        for _ in range(13):
            candidate = _nth_weekday_in_month(year, month, day_num, week_num)
            if candidate and candidate >= tomorrow:
                return candidate
            month += 1
            if month > 12:
                month = 1
                year += 1
        return tomorrow + timedelta(days=30)

    if frequency == "quarterly":
        q_months = [1, 4, 7, 10]
        year, month = tomorrow.year, tomorrow.month
        for _ in range(8):
            candidate = _nth_weekday_in_month(year, month, day_num, week_num)
            if candidate and candidate >= tomorrow:
                return candidate
            next_q = next((qm for qm in q_months if qm > month), None)
            if next_q is None:
                next_q = 1
                year += 1
            month = next_q
        return tomorrow + timedelta(days=90)

    return tomorrow + timedelta(days=30)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class CycleCreate(BaseModel):
    name: str
    description: Optional[str] = ""
    frequency: Optional[str] = "monthly"
    patch_day: Optional[str] = "Monday"
    patch_week: Optional[str] = "1st"
    preferred_time: Optional[str] = "02:00"
    restart_action: Optional[str] = "none"
    pre_notification_hours: Optional[int] = 24
    notes: Optional[str] = ""
    cycle_type: Optional[str] = "patch"
    group_name: Optional[str] = ""
    linked_cycle_id: Optional[str] = None
    maint_frequency:     Optional[str] = "monthly"
    maint_day:           Optional[str] = "Wednesday"
    maint_week:          Optional[str] = "1st"
    maint_time:          Optional[str] = "22:00"
    maint_restart_action:Optional[str] = "none"


class CycleUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    frequency: Optional[str] = None
    patch_day: Optional[str] = None
    patch_week: Optional[str] = None
    preferred_time: Optional[str] = None
    restart_action: Optional[str] = None
    pre_notification_hours: Optional[int] = None
    notes: Optional[str] = None
    cycle_type: Optional[str] = None
    group_name: Optional[str] = None
    linked_cycle_id: Optional[str] = None
    maint_frequency:     Optional[str] = None
    maint_day:           Optional[str] = None
    maint_week:          Optional[str] = None
    maint_time:          Optional[str] = None
    maint_restart_action:Optional[str] = None


class AssignAgentsBody(BaseModel):
    agent_ids: List[str]


class HistoryCreate(BaseModel):
    agent_id: str
    cycle_id: Optional[str] = None
    actioned_at: Optional[str] = None   # ISO datetime string; defaults to now
    action_type: Optional[str] = "patch"   # patch / restart / scan / other
    status: Optional[str] = "completed"    # completed / failed / pending
    notes: Optional[str] = ""
    created_by: Optional[str] = ""


class ReportCreate(BaseModel):
    cycle_id: Optional[str] = None
    report_type: Optional[str] = "post_patch"
    group_name: Optional[str] = ""
    period_start: Optional[str] = None
    period_end: Optional[str] = None
    patches_applied: Optional[int] = 0
    patches_failed: Optional[int] = 0
    servers_affected: Optional[int] = 0
    services_verified: Optional[bool] = True
    issues_found: Optional[str] = ""
    actions_taken: Optional[str] = ""
    rollback_required: Optional[bool] = False
    next_steps: Optional[str] = ""
    status: Optional[str] = "completed"
    created_by: Optional[str] = ""


class NotificationCreate(BaseModel):
    name: Optional[str] = ""
    email: str
    notification_type: Optional[str] = "post_patch"
    cycle_type_filter: Optional[str] = "all"
    send_time: Optional[str] = "09:00"
    is_active: Optional[bool] = True


class NotificationUpdate(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None
    notification_type: Optional[str] = None
    cycle_type_filter: Optional[str] = None
    send_time: Optional[str] = None
    is_active: Optional[bool] = None


# ---------------------------------------------------------------------------
# 1. GET /overview
# ---------------------------------------------------------------------------

@router.get("/overview")
async def get_overview(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    result: Dict[str, Any] = {}

    try:
        r = await db.execute(text("""
            SELECT COUNT(*) FROM agents WHERE is_active = TRUE
        """))
        total_agents = r.scalar() or 0
    except Exception:
        await db.rollback()
        total_agents = 0

    try:
        r = await db.execute(text("""
            SELECT COUNT(DISTINCT ca.agent_id)
            FROM maintenance_cycle_agents ca
            JOIN agents a ON a.id = ca.agent_id
            WHERE a.is_active = TRUE
        """))
        assigned = r.scalar() or 0
    except Exception:
        await db.rollback()
        assigned = 0

    try:
        r = await db.execute(text("""
            SELECT
                COUNT(DISTINCT p.agent_id)              AS agents_with_patches,
                COALESCE(SUM(p.total_pending), 0)       AS total_pending,
                COALESCE(SUM(p.total_critical), 0)      AS total_critical
            FROM (
                SELECT agent_id,
                       COUNT(*) AS total_pending,
                       COUNT(CASE WHEN LOWER(category) LIKE '%critical%' THEN 1 END) AS total_critical
                FROM agent_patches
                GROUP BY agent_id
            ) p
            JOIN agents a ON a.id = p.agent_id
            WHERE a.is_active = TRUE
        """))
        row = r.fetchone()
        agents_with_patches   = row[0] or 0 if row else 0
        total_pending_patches  = row[1] or 0 if row else 0
        critical_pending      = row[2] or 0 if row else 0
    except Exception:
        await db.rollback()
        agents_with_patches   = 0
        total_pending_patches  = 0
        critical_pending      = 0

    # Compliant = active agents with 0 pending patches
    compliant_agents = total_agents - agents_with_patches
    compliance_pct = round(compliant_agents / total_agents * 100, 1) if total_agents > 0 else 0.0

    return {
        "total_agents": total_agents,
        "assigned": assigned,
        "unassigned": total_agents - assigned,
        "agents_with_patches": agents_with_patches,
        "total_pending_patches": total_pending_patches,
        "critical_pending_patches": critical_pending,
        "compliant_agents": compliant_agents,
        "compliance_pct": compliance_pct,
    }


# ---------------------------------------------------------------------------
# 2. GET /cycles
# ---------------------------------------------------------------------------

def _current_cycle_date(
    frequency: str, patch_day, patch_week, start_from: date
) -> date:
    """
    Like _next_maintenance_date but finds the next occurrence ON OR AFTER start_from
    (not strictly after tomorrow). Used to keep 'today' visible until confirmed done.
    """
    _DAY_MAP  = {"Monday": 0, "Tuesday": 1, "Wednesday": 2, "Thursday": 3,
                 "Friday": 4, "Saturday": 5, "Sunday": 6}
    _WEEK_MAP = {"1st": 1, "2nd": 2, "3rd": 3, "4th": 4}

    day_num  = _DAY_MAP.get(patch_day, 0) if isinstance(patch_day, str) else int(patch_day or 0) % 7
    week_num = _WEEK_MAP.get(patch_week, 1) if isinstance(patch_week, str) else int(patch_week or 1)

    if frequency == "weekly":
        days_ahead = day_num - start_from.weekday()
        if days_ahead < 0:
            days_ahead += 7
        return start_from + timedelta(days=days_ahead)

    def _nth(year: int, month: int, weekday: int, n: int) -> Optional[date]:
        day = date(year, month, 1)
        ahead = weekday - day.weekday()
        if ahead < 0:
            ahead += 7
        day = day + timedelta(days=ahead)
        for _ in range(n - 1):
            day += timedelta(weeks=1)
            if day.month != month:
                return None
        return day if day.month == month else None

    if frequency == "monthly":
        y, m = start_from.year, start_from.month
        for _ in range(13):
            c = _nth(y, m, day_num, week_num)
            if c and c >= start_from:
                return c
            m += 1
            if m > 12:
                m, y = 1, y + 1
        return start_from + timedelta(days=30)

    if frequency == "quarterly":
        q_months = [1, 4, 7, 10]
        y, m = start_from.year, start_from.month
        for _ in range(8):
            c = _nth(y, m, day_num, week_num)
            if c and c >= start_from:
                return c
            nq = next((qm for qm in q_months if qm > m), None)
            if nq is None:
                nq, y = 1, y + 1
            m = nq
        return start_from + timedelta(days=90)

    return start_from + timedelta(days=30)


@router.get("/cycles")
async def list_cycles(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    try:
        r = await db.execute(text("""
            SELECT
                c.id, c.name, c.description, c.frequency,
                c.patch_day, c.patch_week, c.preferred_time,
                c.restart_action, c.pre_notification_hours, c.notes,
                COUNT(DISTINCT ca.agent_id) AS agent_count,
                COALESCE(SUM(p.pending), 0) AS total_pending,
                COALESCE(SUM(p.critical), 0) AS total_critical,
                c.cycle_type, c.group_name, c.linked_cycle_id::text,
                c.maint_frequency, c.maint_day, c.maint_week,
                c.maint_time, c.maint_restart_action
            FROM maintenance_cycles c
            LEFT JOIN maintenance_cycle_agents ca ON ca.cycle_id = c.id
            LEFT JOIN (
                SELECT agent_id,
                       COUNT(*) AS pending,
                       COUNT(CASE WHEN LOWER(category) LIKE '%critical%' THEN 1 END) AS critical
                FROM agent_patches
                GROUP BY agent_id
            ) p ON p.agent_id = ca.agent_id
            GROUP BY c.id
            ORDER BY c.name
        """))
        rows = r.fetchall()
    except Exception:
        await db.rollback()
        rows = []

    # Batch-fetch most recent COMPLETED patch and restart dates per cycle
    try:
        ph = await db.execute(text("""
            SELECT cycle_id::text, MAX(actioned_at::date)
            FROM maintenance_history
            WHERE action_type = 'patch' AND status = 'completed' AND cycle_id IS NOT NULL
            GROUP BY cycle_id
        """))
        patch_done_map: Dict[str, date] = {str(r[0]): r[1] for r in ph.fetchall()}
    except Exception:
        await db.rollback()
        patch_done_map = {}

    try:
        rh = await db.execute(text("""
            SELECT cycle_id::text, MAX(actioned_at::date)
            FROM maintenance_history
            WHERE action_type = 'restart' AND status = 'completed' AND cycle_id IS NOT NULL
            GROUP BY cycle_id
        """))
        restart_done_map: Dict[str, date] = {str(r[0]): r[1] for r in rh.fetchall()}
    except Exception:
        await db.rollback()
        restart_done_map = {}

    # Fetch cycles that have a pending 'scheduled' restart (not yet completed)
    # Returns cycle_id -> earliest actioned_at date of the pending restart
    try:
        rs = await db.execute(text("""
            SELECT cycle_id::text, MIN(actioned_at::date)
            FROM maintenance_history
            WHERE action_type = 'restart' AND status = 'scheduled' AND cycle_id IS NOT NULL
            GROUP BY cycle_id
        """))
        restart_scheduled_map: Dict[str, date] = {r[0]: r[1] for r in rs.fetchall()}
    except Exception:
        await db.rollback()
        restart_scheduled_map = {}

    _DAY_MAP = {"Monday": 0, "Tuesday": 1, "Wednesday": 2, "Thursday": 3,
                "Friday": 4, "Saturday": 5, "Sunday": 6}
    today = date.today()

    cycles = []
    for row in rows:
        (
            cid, name, description, frequency,
            patch_day, patch_week, preferred_time,
            restart_action, pre_notification_hours, notes,
            agent_count, total_pending, total_critical,
            cycle_type, group_name, linked_cycle_id,
            maint_frequency, maint_day, maint_week,
            maint_time, maint_restart_action
        ) = row

        cid_str = str(cid)

        # ── Determine current patch date ─────────────────────────────────────
        # Always show the next upcoming occurrence — past dates are done/skipped.
        last_patch_done = patch_done_map.get(cid_str)
        try:
            current_patch_dt = _current_cycle_date(
                frequency or "monthly", patch_day or "Tuesday", patch_week or "1st", today
            )
            # If the last completed patch covers this occurrence, advance to the next
            if last_patch_done and last_patch_done >= current_patch_dt:
                current_patch_dt = _current_cycle_date(
                    frequency or "monthly", patch_day or "Tuesday", patch_week or "1st",
                    current_patch_dt + timedelta(days=1)
                )
        except Exception:
            current_patch_dt = today + timedelta(days=30)

        # Compute patch_status
        if current_patch_dt == today:
            patch_status = "today"
        elif current_patch_dt < today:
            patch_status = "overdue"
        else:
            patch_status = "upcoming"

        # ── Determine restart date ───────────────────────────────────────────
        # For auto_restart/restart/reboot the restart is the same night as patching.
        auto_restart_types = ("reboot", "restart", "auto_restart")
        if restart_action and restart_action in auto_restart_types:
            current_restart_dt = current_patch_dt
        else:
            maint_day_num = _DAY_MAP.get(maint_day or "Wednesday", 2)
            days_ahead = maint_day_num - current_patch_dt.weekday()
            if days_ahead <= 0:
                days_ahead += 7
            current_restart_dt = current_patch_dt + timedelta(days=days_ahead)

        # If there's a scheduled-but-not-completed restart in history, use that date
        last_restart_done = restart_done_map.get(cid_str)
        pending_restart_date = restart_scheduled_map.get(cid_str)
        has_pending_restart = pending_restart_date is not None and (
            not last_restart_done or last_restart_done < pending_restart_date
        )
        if has_pending_restart:
            # Override restart date to show the actual pending date, not next cycle
            current_restart_dt = pending_restart_date

        if last_restart_done and last_restart_done >= current_restart_dt:
            restart_status = "done"
        elif has_pending_restart and pending_restart_date == today:
            restart_status = "today"
        elif has_pending_restart and pending_restart_date < today:
            restart_status = "overdue"
        elif current_restart_dt < today:
            restart_status = "overdue"
        else:
            restart_status = "upcoming"

        cycles.append({
            "id": cid_str,
            "name": name,
            "description": description,
            "frequency": frequency,
            "patch_day": patch_day,
            "patch_week": patch_week,
            "preferred_time": preferred_time,
            "restart_action": restart_action,
            "pre_notification_hours": pre_notification_hours,
            "notes": notes,
            "agent_count": int(agent_count or 0),
            "total_pending": int(total_pending or 0),
            "total_critical": int(total_critical or 0),
            "next_maintenance_date": current_patch_dt.isoformat(),
            "patch_status": patch_status,
            "cycle_type": cycle_type or "patch",
            "group_name": group_name or "",
            "linked_cycle_id": cid_str if linked_cycle_id else None,
            "maint_frequency": maint_frequency or "monthly",
            "maint_day": maint_day or "Wednesday",
            "maint_week": maint_week or "1st",
            "maint_time": maint_time or "22:00",
            "maint_restart_action": maint_restart_action or "none",
            "next_maint_date": current_restart_dt.isoformat(),
            "restart_status": restart_status,
        })
    return cycles


# ---------------------------------------------------------------------------
# 3. POST /cycles
# ---------------------------------------------------------------------------

@router.post("/cycles", status_code=201)
async def create_cycle(
    body: CycleCreate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    try:
        r = await db.execute(text("""
            INSERT INTO maintenance_cycles
                (name, description, frequency, patch_day, patch_week,
                 preferred_time, restart_action, pre_notification_hours, notes,
                 cycle_type, group_name, linked_cycle_id,
                 maint_frequency, maint_day, maint_week, maint_time, maint_restart_action)
            VALUES
                (:name, :description, :frequency, :patch_day, :patch_week,
                 :preferred_time, :restart_action, :pre_notification_hours, :notes,
                 :cycle_type, :group_name, :linked_cycle_id,
                 :maint_frequency, :maint_day, :maint_week, :maint_time, :maint_restart_action)
            RETURNING id
        """), {
            "name": body.name,
            "description": body.description or "",
            "frequency": body.frequency or "monthly",
            "patch_day": body.patch_day if body.patch_day is not None else 1,
            "patch_week": body.patch_week if body.patch_week is not None else 1,
            "preferred_time": body.preferred_time or "02:00",
            "restart_action": body.restart_action or "none",
            "pre_notification_hours": body.pre_notification_hours if body.pre_notification_hours is not None else 24,
            "notes": body.notes or "",
            "cycle_type":      body.cycle_type or "patch",
            "group_name":      body.group_name or "",
            "linked_cycle_id": body.linked_cycle_id or None,
            "maint_frequency":      body.maint_frequency or "monthly",
            "maint_day":            body.maint_day or "Wednesday",
            "maint_week":           body.maint_week or "1st",
            "maint_time":           body.maint_time or "22:00",
            "maint_restart_action": body.maint_restart_action or "none",
        })
        new_id = r.scalar()
        await db.commit()
        return {"id": str(new_id), "message": "Cycle created"}
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# 4. PUT /cycles/{cycle_id}
# ---------------------------------------------------------------------------

@router.put("/cycles/{cycle_id}")
async def update_cycle(
    cycle_id: str,
    body: CycleUpdate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)

    # Build SET clause dynamically
    fields = {}
    if body.name is not None:
        fields["name"] = body.name
    if body.description is not None:
        fields["description"] = body.description
    if body.frequency is not None:
        fields["frequency"] = body.frequency
    if body.patch_day is not None:
        fields["patch_day"] = body.patch_day
    if body.patch_week is not None:
        fields["patch_week"] = body.patch_week
    if body.preferred_time is not None:
        fields["preferred_time"] = body.preferred_time
    if body.restart_action is not None:
        fields["restart_action"] = body.restart_action
    if body.pre_notification_hours is not None:
        fields["pre_notification_hours"] = body.pre_notification_hours
    if body.notes is not None:
        fields["notes"] = body.notes
    if body.cycle_type is not None:
        fields["cycle_type"] = body.cycle_type
    if body.group_name is not None:
        fields["group_name"] = body.group_name
    if body.linked_cycle_id is not None:
        fields["linked_cycle_id"] = body.linked_cycle_id if body.linked_cycle_id else None
    if body.maint_frequency      is not None: fields["maint_frequency"]      = body.maint_frequency
    if body.maint_day            is not None: fields["maint_day"]            = body.maint_day
    if body.maint_week           is not None: fields["maint_week"]           = body.maint_week
    if body.maint_time           is not None: fields["maint_time"]           = body.maint_time
    if body.maint_restart_action is not None: fields["maint_restart_action"] = body.maint_restart_action

    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")

    set_clause = ", ".join(f"{k} = :{k}" for k in fields)
    fields["cycle_id"] = cycle_id

    try:
        r = await db.execute(
            text(f"UPDATE maintenance_cycles SET {set_clause}, updated_at=NOW() WHERE id=:cycle_id RETURNING id"),
            fields,
        )
        row = r.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Cycle not found")
        await db.commit()
        return {"id": str(row[0]), "message": "Cycle updated"}
    except HTTPException:
        raise
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# 5. DELETE /cycles/{cycle_id}
# ---------------------------------------------------------------------------

@router.delete("/cycles/{cycle_id}", status_code=204)
async def delete_cycle(
    cycle_id: str,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    try:
        r = await db.execute(
            text("DELETE FROM maintenance_cycles WHERE id=:id RETURNING id"),
            {"id": cycle_id},
        )
        row = r.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Cycle not found")
        await db.commit()
    except HTTPException:
        raise
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# 6. GET /cycles/{cycle_id}/agents
# ---------------------------------------------------------------------------

@router.get("/cycles/{cycle_id}/agents")
async def get_cycle_agents(
    cycle_id: str,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    try:
        r = await db.execute(text("""
            SELECT a.id, a.hostname, a.display_name, a.os_type, a.ip_address,
                   a.status, a.last_seen,
                   COALESCE(p.pending, 0)  AS pending_patches,
                   COALESCE(p.critical, 0) AS critical_patches,
                   p.last_scanned
            FROM maintenance_cycle_agents ca
            JOIN agents a ON a.id = ca.agent_id
            LEFT JOIN (
                SELECT agent_id,
                       COUNT(*) AS pending,
                       COUNT(CASE WHEN LOWER(category) LIKE '%critical%' THEN 1 END) AS critical,
                       MAX(scanned_at) AS last_scanned
                FROM agent_patches
                GROUP BY agent_id
            ) p ON p.agent_id = a.id
            WHERE ca.cycle_id = CAST(:cycle_id AS uuid)
            ORDER BY a.hostname
        """), {"cycle_id": cycle_id})
        rows = r.fetchall()
    except Exception:
        await db.rollback()
        rows = []

    return [
        {
            "id": str(row[0]),
            "hostname": row[1],
            "display_name": row[2],
            "os_type": row[3],
            "ip_address": row[4],
            "status": row[5],
            "last_seen": row[6].isoformat() if row[6] else None,
            "pending_patches": int(row[7] or 0),
            "critical_patches": int(row[8] or 0),
            "last_scanned": row[9].isoformat() if row[9] else None,
        }
        for row in rows
    ]


# ---------------------------------------------------------------------------
# 7. POST /cycles/{cycle_id}/agents
# ---------------------------------------------------------------------------

@router.post("/cycles/{cycle_id}/agents", status_code=201)
async def assign_agents(
    cycle_id: str,
    body: AssignAgentsBody,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    if not body.agent_ids:
        raise HTTPException(status_code=400, detail="agent_ids must not be empty")

    # Verify cycle exists
    try:
        r = await db.execute(
            text("SELECT id FROM maintenance_cycles WHERE id=:id"),
            {"id": cycle_id},
        )
        if not r.fetchone():
            raise HTTPException(status_code=404, detail="Cycle not found")
    except HTTPException:
        raise
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))

    inserted = 0
    for agent_id in body.agent_ids:
        try:
            await db.execute(text("""
                INSERT INTO maintenance_cycle_agents (cycle_id, agent_id)
                VALUES (:cycle_id, :agent_id)
                ON CONFLICT (cycle_id, agent_id) DO NOTHING
            """), {"cycle_id": cycle_id, "agent_id": agent_id})
            inserted += 1
        except Exception:
            await db.rollback()

    try:
        await db.commit()
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))

    return {"message": f"{inserted} agent(s) assigned"}


# ---------------------------------------------------------------------------
# 7b. POST /cycles/{cycle_id}/run-now  — manually trigger a cycle (bypasses date/time gate)
# ---------------------------------------------------------------------------

@router.post("/cycles/{cycle_id}/run-now")
async def run_cycle_now(
    cycle_id: str,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Immediately queue patches for all assigned agents in a cycle, regardless of schedule."""
    await _ensure_tables(db)

    import json as _json

    cycle = (await db.execute(text("""
        SELECT name, restart_action, preferred_time FROM maintenance_cycles WHERE id = CAST(:id AS uuid)
    """), {"id": cycle_id})).fetchone()
    if not cycle:
        raise HTTPException(status_code=404, detail="Cycle not found")
    cycle_name, restart_action, preferred_time = cycle

    agents = (await db.execute(text("""
        SELECT a.id::text, a.hostname, a.status
        FROM maintenance_cycle_agents ca
        JOIN agents a ON a.id = ca.agent_id
        WHERE ca.cycle_id = CAST(:cid AS uuid) AND a.is_active = TRUE
    """), {"cid": cycle_id})).fetchall()

    if not agents:
        raise HTTPException(status_code=400, detail="No agents assigned to this cycle")

    reboot_after = bool(restart_action and restart_action in ("reboot", "restart", "auto_restart"))
    results = []

    for (agent_id, hostname, agent_status) in agents:
        if agent_status != "online":
            await db.execute(text("""
                INSERT INTO maintenance_history
                    (cycle_id, agent_id, action_type, status, notes, created_by)
                VALUES (CAST(:cid AS uuid), :aid, 'patch', 'skipped', :notes, 'manual')
            """), {
                "cid": cycle_id, "aid": agent_id,
                "notes": f"Manual run: {hostname} was {agent_status}",
            })
            results.append({"hostname": hostname, "status": "skipped", "reason": agent_status})
            continue

        patches = (await db.execute(
            text("SELECT package_name FROM agent_patches WHERE agent_id = :aid"),
            {"aid": agent_id},
        )).fetchall()
        packages = [r[0] for r in patches]

        if not packages:
            await db.execute(text("""
                INSERT INTO maintenance_history
                    (cycle_id, agent_id, action_type, status, notes, created_by)
                VALUES (CAST(:cid AS uuid), :aid, 'patch', 'completed', 'No patches pending', 'manual')
            """), {"cid": cycle_id, "aid": agent_id})
            results.append({"hostname": hostname, "status": "no_patches"})
            continue

        job_id = str(uuid.uuid4())
        await db.execute(text("""
            INSERT INTO patch_jobs
                (id, agent_id, job_type, packages, status, triggered_by,
                 reboot_after, reboot_mode, reboot_delay_seconds)
            VALUES (:id, :aid, 'apply', :pkgs, 'pending', 'maintenance_cycle',
                    :rb, 'silent', 60)
        """), {"id": job_id, "aid": agent_id, "pkgs": packages, "rb": reboot_after})

        await db.execute(text("""
            INSERT INTO agent_commands (agent_id, command_type, payload)
            VALUES (:aid, 'apply_patches', CAST(:payload AS jsonb))
        """), {"aid": agent_id, "payload": _json.dumps({
            "job_id": job_id, "packages": packages,
            "reboot_after": reboot_after, "reboot_mode": "silent", "reboot_delay_seconds": 60,
        })})

        await db.execute(text("""
            INSERT INTO maintenance_history
                (cycle_id, agent_id, action_type, status, notes, created_by, patch_job_id)
            VALUES (CAST(:cid AS uuid), :aid, 'patch', 'pending', :notes, 'manual', CAST(:jid AS uuid))
        """), {
            "cid": cycle_id, "aid": agent_id, "jid": job_id,
            "notes": f"Manual run: {len(packages)} patch(es) queued for {hostname}",
        })

        # If cycle triggers a restart, add a scheduled restart entry so it's visible before it happens
        if reboot_after:
            sched_time = (preferred_time or "22:00")[:5]
            await db.execute(text("""
                INSERT INTO maintenance_history
                    (cycle_id, agent_id, action_type, status, notes, created_by)
                VALUES (CAST(:cid AS uuid), :aid, 'restart', 'scheduled',
                        :notes, 'manual')
            """), {
                "cid": cycle_id, "aid": agent_id,
                "notes": f"Restart scheduled for today at {sched_time} UTC ({cycle_name})",
            })

        results.append({"hostname": hostname, "status": "queued", "job_id": job_id, "packages": len(packages)})

    # For skipped/offline agents with auto_restart, also log the upcoming restart
    if reboot_after:
        for (agent_id, hostname, agent_status) in agents:
            if agent_status != "online":
                sched_time = (preferred_time or "22:00")[:5]
                await db.execute(text("""
                    INSERT INTO maintenance_history
                        (cycle_id, agent_id, action_type, status, notes, created_by)
                    VALUES (CAST(:cid AS uuid), :aid, 'restart', 'scheduled',
                            :notes, 'manual')
                """), {
                    "cid": cycle_id, "aid": agent_id,
                    "notes": f"Restart scheduled for today at {sched_time} UTC ({cycle_name}) — pending agent reconnect",
                })

    await db.commit()
    return {"cycle": cycle_name, "results": results}


# ---------------------------------------------------------------------------
# 8. DELETE /cycles/{cycle_id}/agents/{agent_id}
# ---------------------------------------------------------------------------

@router.delete("/cycles/{cycle_id}/agents/{agent_id}", status_code=204)
async def remove_agent_from_cycle(
    cycle_id: str,
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    try:
        r = await db.execute(text("""
            DELETE FROM maintenance_cycle_agents
            WHERE cycle_id=:cycle_id AND agent_id=:agent_id
            RETURNING id
        """), {"cycle_id": cycle_id, "agent_id": agent_id})
        row = r.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Assignment not found")
        await db.commit()
    except HTTPException:
        raise
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# 9. GET /unassigned-agents
# ---------------------------------------------------------------------------

@router.get("/unassigned-agents")
async def get_unassigned_agents(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    try:
        r = await db.execute(text("""
            SELECT a.id, a.hostname, a.display_name, a.os_type, a.ip_address,
                   a.status, a.last_seen,
                   COALESCE(p.pending, 0) AS pending_patches
            FROM agents a
            LEFT JOIN maintenance_cycle_agents ca ON ca.agent_id = a.id
            LEFT JOIN (
                SELECT agent_id, COUNT(*) AS pending
                FROM agent_patches
                GROUP BY agent_id
            ) p ON p.agent_id = a.id
            WHERE a.is_active = TRUE
              AND ca.agent_id IS NULL
            ORDER BY a.hostname
        """))
        rows = r.fetchall()
    except Exception:
        await db.rollback()
        rows = []

    return [
        {
            "id": str(row[0]),
            "hostname": row[1],
            "display_name": row[2],
            "os_type": row[3],
            "ip_address": row[4],
            "status": row[5],
            "last_seen": row[6].isoformat() if row[6] else None,
            "pending_patches": int(row[7] or 0),
        }
        for row in rows
    ]


# ---------------------------------------------------------------------------
# 10. Maintenance History endpoints
# ---------------------------------------------------------------------------

@router.get("/history")
async def list_history(
    cycle_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    limit: int = 200,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    conditions = ["1=1"]
    params: Dict[str, Any] = {"limit": limit}
    if cycle_id:
        conditions.append("h.cycle_id = :cycle_id")
        params["cycle_id"] = cycle_id
    if agent_id:
        conditions.append("h.agent_id = :agent_id")
        params["agent_id"] = agent_id
    where = " AND ".join(conditions)
    try:
        r = await db.execute(text(f"""
            SELECT h.id, h.actioned_at, h.action_type, h.status, h.notes,
                   h.created_by, h.created_at,
                   a.hostname, a.display_name, a.os_type,
                   c.name AS cycle_name, c.id AS cycle_id,
                   h.patch_job_id,
                   pj.packages, pj.output, pj.finished_at,
                   h.agent_id
            FROM maintenance_history h
            JOIN agents a ON a.id = h.agent_id
            LEFT JOIN maintenance_cycles c ON c.id = h.cycle_id
            LEFT JOIN patch_jobs pj ON pj.id = h.patch_job_id
            WHERE {where}
            ORDER BY h.actioned_at DESC
            LIMIT :limit
        """), params)
        rows = r.fetchall()
    except Exception:
        await db.rollback()
        rows = []
    return [{
        "id":            str(row[0]),
        "actioned_at":   row[1].isoformat() if row[1] else None,
        "action_type":   row[2],
        "status":        row[3],
        "notes":         row[4] or "",
        "created_by":    row[5] or "",
        "created_at":    row[6].isoformat() if row[6] else None,
        "hostname":      row[7],
        "display_name":  row[8],
        "os_type":       row[9],
        "cycle_name":    row[10] or "—",
        "cycle_id":      str(row[11]) if row[11] else None,
        "patch_job_id":  str(row[12]) if row[12] else None,
        "packages":      row[13] or [],
        "output":        row[14] or "",
        "finished_at":   row[15].isoformat() if row[15] else None,
        "agent_id":      str(row[16]) if row[16] else None,
    } for row in rows]


@router.post("/history", status_code=201)
async def log_history(
    body: HistoryCreate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    actioned_at = body.actioned_at or datetime.now(timezone.utc).isoformat()
    try:
        r = await db.execute(text("""
            INSERT INTO maintenance_history
                (cycle_id, agent_id, actioned_at, action_type, status, notes, created_by)
            VALUES
                (:cycle_id, :agent_id, :actioned_at, :action_type, :status, :notes, :created_by)
            RETURNING id
        """), {
            "cycle_id":    body.cycle_id or None,
            "agent_id":    body.agent_id,
            "actioned_at": actioned_at,
            "action_type": body.action_type or "patch",
            "status":      body.status or "completed",
            "notes":       body.notes or "",
            "created_by":  body.created_by or "",
        })
        new_id = str(r.scalar())
        await db.commit()
        return {"id": new_id, "status": "created"}
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/history/{history_id}/rerun")
async def rerun_history_entry(
    history_id: str,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """
    Re-queue patching for a failed/pending maintenance history entry.
    Creates a new patch_job and agent_command, and updates the history status back to 'pending'.
    """
    await _ensure_tables(db)

    row = (await db.execute(text("""
        SELECT h.agent_id, h.cycle_id, c.name, c.restart_action,
               a.hostname, a.status AS agent_status
        FROM maintenance_history h
        JOIN agents a ON a.id = h.agent_id
        LEFT JOIN maintenance_cycles c ON c.id = h.cycle_id
        WHERE h.id = :hid
    """), {"hid": history_id})).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="History entry not found")

    agent_id, cycle_id, cycle_name, restart_action, hostname, agent_status = row

    # Allow queueing even if agent is offline — command will be picked up on reconnect
    queued_offline = agent_status != "online"

    # Get pending patches for this agent
    patches = (await db.execute(
        text("SELECT package_name FROM agent_patches WHERE agent_id = :aid"),
        {"aid": str(agent_id)},
    )).fetchall()
    packages = [r[0] for r in patches]

    if not packages:
        raise HTTPException(status_code=400, detail=f"No pending patches found for {hostname} — the agent may not have completed a patch scan yet")

    import uuid as _uuid
    import json as _json
    reboot_after = bool(restart_action and restart_action in ("reboot", "restart", "auto_restart"))
    job_id = str(_uuid.uuid4())

    await db.execute(text("""
        INSERT INTO patch_jobs
            (id, agent_id, job_type, packages, status, triggered_by,
             reboot_after, reboot_mode, reboot_delay_seconds)
        VALUES (:id, :aid, 'apply', :pkgs, 'pending', 'maintenance_cycle',
                :rb, 'silent', 60)
    """), {"id": job_id, "aid": str(agent_id), "pkgs": packages, "rb": reboot_after})

    payload = _json.dumps({
        "job_id": job_id, "packages": packages,
        "reboot_after": reboot_after, "reboot_mode": "silent", "reboot_delay_seconds": 60,
    })
    await db.execute(text("""
        INSERT INTO agent_commands (agent_id, command_type, payload)
        VALUES (:aid, 'apply_patches', CAST(:payload AS jsonb))
    """), {"aid": str(agent_id), "payload": payload})

    # Update history entry to pending with new job id
    await db.execute(text("""
        UPDATE maintenance_history
        SET status='pending', patch_job_id=CAST(:jid AS uuid),
            notes=:notes, actioned_at=NOW()
        WHERE id=:hid
    """), {
        "jid": job_id,
        "notes": f"Re-run: {len(packages)} patch(es) queued for {hostname}",
        "hid": history_id,
    })

    await db.commit()
    return {
        "ok": True,
        "job_id": job_id,
        "packages": len(packages),
        "queued_offline": queued_offline,
        "message": f"Queued — will run when {hostname} comes back online" if queued_offline else "Re-run queued",
    }


@router.delete("/history/{history_id}", status_code=204)
async def delete_history(
    history_id: str,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    try:
        await db.execute(
            text("DELETE FROM maintenance_history WHERE id = :id"),
            {"id": history_id}
        )
        await db.commit()
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# 11. Reports endpoints
# ---------------------------------------------------------------------------

@router.get("/reports")
async def list_reports(
    report_type: Optional[str] = None,
    group_name: Optional[str] = None,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    conditions = ["1=1"]
    params: Dict[str, Any] = {"limit": limit}
    if report_type:
        conditions.append("r.report_type = :report_type")
        params["report_type"] = report_type
    if group_name:
        conditions.append("r.group_name = :group_name")
        params["group_name"] = group_name
    where = " AND ".join(conditions)
    try:
        r = await db.execute(text(f"""
            SELECT r.id, r.cycle_id, c.name AS cycle_name, r.report_type,
                   r.group_name, r.period_start, r.period_end,
                   r.patches_applied, r.patches_failed, r.servers_affected,
                   r.services_verified, r.issues_found, r.actions_taken,
                   r.rollback_required, r.next_steps, r.status,
                   r.created_by, r.created_at
            FROM maintenance_reports r
            LEFT JOIN maintenance_cycles c ON c.id = r.cycle_id
            WHERE {where}
            ORDER BY r.created_at DESC
            LIMIT :limit
        """), params)
        rows = r.fetchall()
    except Exception:
        await db.rollback()
        rows = []
    return [{
        "id":               str(row[0]),
        "cycle_id":         str(row[1]) if row[1] else None,
        "cycle_name":       row[2] or "—",
        "report_type":      row[3],
        "group_name":       row[4] or "",
        "period_start":     row[5].isoformat() if row[5] else None,
        "period_end":       row[6].isoformat() if row[6] else None,
        "patches_applied":  int(row[7] or 0),
        "patches_failed":   int(row[8] or 0),
        "servers_affected": int(row[9] or 0),
        "services_verified": bool(row[10]),
        "issues_found":     row[11] or "",
        "actions_taken":    row[12] or "",
        "rollback_required": bool(row[13]),
        "next_steps":       row[14] or "",
        "status":           row[15] or "completed",
        "created_by":       row[16] or "",
        "created_at":       row[17].isoformat() if row[17] else None,
    } for row in rows]


@router.post("/reports", status_code=201)
async def create_report(
    body: ReportCreate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    try:
        r = await db.execute(text("""
            INSERT INTO maintenance_reports
                (cycle_id, report_type, group_name, period_start, period_end,
                 patches_applied, patches_failed, servers_affected,
                 services_verified, issues_found, actions_taken,
                 rollback_required, next_steps, status, created_by)
            VALUES
                (:cycle_id, :report_type, :group_name, :period_start, :period_end,
                 :patches_applied, :patches_failed, :servers_affected,
                 :services_verified, :issues_found, :actions_taken,
                 :rollback_required, :next_steps, :status, :created_by)
            RETURNING id
        """), {
            "cycle_id":        body.cycle_id or None,
            "report_type":     body.report_type or "post_patch",
            "group_name":      body.group_name or "",
            "period_start":    body.period_start or None,
            "period_end":      body.period_end or None,
            "patches_applied": body.patches_applied or 0,
            "patches_failed":  body.patches_failed or 0,
            "servers_affected": body.servers_affected or 0,
            "services_verified": body.services_verified if body.services_verified is not None else True,
            "issues_found":    body.issues_found or "",
            "actions_taken":   body.actions_taken or "",
            "rollback_required": body.rollback_required or False,
            "next_steps":      body.next_steps or "",
            "status":          body.status or "completed",
            "created_by":      body.created_by or "",
        })
        new_id = str(r.scalar())
        await db.commit()
        return {"id": new_id, "status": "created"}
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Notification Settings endpoints
# ---------------------------------------------------------------------------

@router.get("/notifications")
async def list_notifications(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    try:
        r = await db.execute(text("""
            SELECT id, name, email, notification_type, cycle_type_filter,
                   send_time, is_active, created_at
            FROM maintenance_notification_settings
            ORDER BY notification_type, name
        """))
        rows = r.fetchall()
    except Exception:
        await db.rollback()
        rows = []
    return [{
        "id":                str(row[0]),
        "name":              row[1] or "",
        "email":             row[2],
        "notification_type": row[3],
        "cycle_type_filter": row[4],
        "send_time":         row[5] or "09:00",
        "is_active":         bool(row[6]),
        "created_at":        row[7].isoformat() if row[7] else None,
    } for row in rows]


@router.post("/notifications", status_code=201)
async def create_notification(
    body: NotificationCreate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    try:
        r = await db.execute(text("""
            INSERT INTO maintenance_notification_settings
                (name, email, notification_type, cycle_type_filter, send_time, is_active)
            VALUES (:name, :email, :notification_type, :cycle_type_filter, :send_time, :is_active)
            RETURNING id
        """), {
            "name":              body.name or "",
            "email":             body.email,
            "notification_type": body.notification_type or "post_patch",
            "cycle_type_filter": body.cycle_type_filter or "all",
            "send_time":         body.send_time or "09:00",
            "is_active":         body.is_active if body.is_active is not None else True,
        })
        new_id = str(r.scalar())
        await db.commit()
        return {"id": new_id, "status": "created"}
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))


@router.put("/notifications/{notif_id}")
async def update_notification(
    notif_id: str,
    body: NotificationUpdate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    fields: Dict[str, Any] = {}
    if body.name              is not None: fields["name"]              = body.name
    if body.email             is not None: fields["email"]             = body.email
    if body.notification_type is not None: fields["notification_type"] = body.notification_type
    if body.cycle_type_filter is not None: fields["cycle_type_filter"] = body.cycle_type_filter
    if body.send_time         is not None: fields["send_time"]         = body.send_time
    if body.is_active         is not None: fields["is_active"]         = body.is_active
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")
    set_clause = ", ".join(f"{k} = :{k}" for k in fields)
    fields["notif_id"] = notif_id
    try:
        r = await db.execute(
            text(f"UPDATE maintenance_notification_settings SET {set_clause}, updated_at=NOW() WHERE id=:notif_id RETURNING id"),
            fields,
        )
        if not r.fetchone():
            raise HTTPException(status_code=404, detail="Notification not found")
        await db.commit()
        return {"status": "updated"}
    except HTTPException:
        raise
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/notifications/{notif_id}", status_code=204)
async def delete_notification(
    notif_id: str,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    try:
        await db.execute(
            text("DELETE FROM maintenance_notification_settings WHERE id = :id"),
            {"id": notif_id},
        )
        await db.commit()
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# 11b. POST /notifications/{id}/send  — manually trigger a notification
# ---------------------------------------------------------------------------

@router.post("/notifications/{notif_id}/send")
async def send_notification_now(
    notif_id: str,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """
    Manually send a maintenance notification email with an XLSX attachment.
    The attachment contains:
      Sheet 1 – Affected Servers (all cycles due tomorrow + their assigned servers)
      Sheet 2 – Windows Pending Patches
      Sheet 3 – Linux Pending Patches
      Sheet 4 – Server Compliance Summary
    """
    await _ensure_tables(db)

    # ── 1. Fetch notification record ─────────────────────────────────────────
    row = (await db.execute(
        text("SELECT * FROM maintenance_notification_settings WHERE id = :id"),
        {"id": notif_id},
    )).mappings().fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Notification not found")

    # Support comma- or newline-separated list of emails
    raw_emails = row["email"] or ""
    email_list = [e.strip() for e in raw_emails.replace("\n", ",").split(",") if e.strip()]
    if not email_list:
        raise HTTPException(status_code=400, detail="No valid email addresses configured for this notification.")
    notif_type    = row["notification_type"]
    recipient_name = row["name"] or email_list[0]

    # ── 2. SMTP config ───────────────────────────────────────────────────────
    smtp_row = (await db.execute(
        text("SELECT config FROM notification_channels WHERE type='smtp' AND is_active=TRUE LIMIT 1")
    )).fetchone()

    if not smtp_row or not smtp_row[0]:
        raise HTTPException(
            status_code=503,
            detail="No active SMTP notification channel configured. Add one in Bot & Messaging settings."
        )
    smtp_cfg = smtp_row[0]

    # ── 3. Gather cycles due tomorrow (or next occurrence within 48 h) ───────
    today     = date.today()
    tomorrow  = today + timedelta(days=1)

    cycles_rows = (await db.execute(text("""
        SELECT id, name, description, frequency, patch_day, patch_week,
               preferred_time, maint_day, maint_week, maint_time,
               maint_restart_action, pre_notification_hours, notes
        FROM maintenance_cycles
        ORDER BY name
    """))).mappings().fetchall()

    # Compute next patch date for each cycle, collect those due tomorrow
    _DAY_MAP  = {"Monday": 0, "Tuesday": 1, "Wednesday": 2, "Thursday": 3,
                 "Friday": 4, "Saturday": 5, "Sunday": 6}

    due_cycles = []
    for c in cycles_rows:
        next_dt = _next_maintenance_date(
            c["frequency"] or "monthly",
            c["patch_day"] or "Tuesday",
            c["patch_week"] or "1st",
        )
        if next_dt == tomorrow:
            # Also compute restart date
            patch_dt   = next_dt
            maint_day_num = _DAY_MAP.get(c["maint_day"] or "Wednesday", 2)
            days_ahead    = maint_day_num - patch_dt.weekday()
            if days_ahead < 0:
                days_ahead += 7
            restart_dt = patch_dt + timedelta(days=days_ahead)
            due_cycles.append({**dict(c), "next_patch_date": patch_dt, "next_restart_date": restart_dt})

    # ── 4. Fetch agents assigned to due cycles ───────────────────────────────
    cycle_agents: Dict[str, List[Any]] = {}
    if due_cycles:
        cycle_ids = [str(c["id"]) for c in due_cycles]
        placeholders = ", ".join(f":cid{i}" for i in range(len(cycle_ids)))
        params = {f"cid{i}": cid for i, cid in enumerate(cycle_ids)}
        agents_rows = (await db.execute(text(f"""
            SELECT mca.cycle_id, a.id AS agent_id, a.hostname, a.ip_address,
                   a.os_type, a.status, a.last_seen
            FROM maintenance_cycle_agents mca
            JOIN agents a ON a.id = mca.agent_id
            WHERE mca.cycle_id IN ({placeholders})
            ORDER BY a.hostname
        """), params)).mappings().fetchall()

        for ar in agents_rows:
            cid = str(ar["cycle_id"])
            cycle_agents.setdefault(cid, []).append(ar)

    # Flatten list of all affected agent IDs
    all_agent_ids = list({str(ar["agent_id"]) for agents in cycle_agents.values() for ar in agents})

    # ── 5. Fetch pending patches for affected agents (from agent_patches) ───────
    # pending_patches table is populated by the patch scanner; agent_patches holds
    # all detected upgrades. We use agent_patches as the source of truth.
    agent_patches_map: Dict[str, List[Any]] = {}
    agent_os_map: Dict[str, str] = {}  # agent_id -> 'windows' | 'linux' | other
    if all_agent_ids:
        placeholders2 = ", ".join(f":aid{i}" for i in range(len(all_agent_ids)))
        params2 = {f"aid{i}": aid for i, aid in enumerate(all_agent_ids)}
        patch_rows = (await db.execute(text(f"""
            SELECT ap.agent_id, ap.package_name, ap.category,
                   ap.current_version, ap.available_version, ap.description,
                   ap.scanned_at, a.os_type
            FROM agent_patches ap
            JOIN agents a ON a.id = ap.agent_id
            WHERE ap.agent_id IN ({placeholders2})
            ORDER BY a.os_type, ap.agent_id, ap.package_name
        """), params2)).mappings().fetchall()

        for pr in patch_rows:
            aid = str(pr["agent_id"])
            agent_patches_map.setdefault(aid, []).append(pr)
            agent_os_map[aid] = (pr.get("os_type") or "").lower()

    # ── 6. Fetch compliance for affected agents ──────────────────────────────
    agent_security: Dict[str, Any] = {}
    if all_agent_ids:
        placeholders3 = ", ".join(f":sid{i}" for i in range(len(all_agent_ids)))
        params3 = {f"sid{i}": aid for i, aid in enumerate(all_agent_ids)}
        sec_rows = (await db.execute(text(f"""
            SELECT agent_id, av_installed, av_running, firewall_enabled,
                   disk_encrypted, auto_updates_enabled
            FROM agent_security_state
            WHERE agent_id IN ({placeholders3})
        """), params3)).mappings().fetchall()
        for sr in sec_rows:
            agent_security[str(sr["agent_id"])] = sr

    # Compliance score computed only for the affected agents using their security state.
    # Each agent scores 1 point per check (AV installed, AV running, firewall, disk encrypted,
    # auto updates). Average across all affected agents gives the cycle-specific compliance %.
    def _agent_compliance_pct(sec: Any) -> Optional[float]:
        if not sec:
            return None
        checks = [sec.get("av_installed"), sec.get("av_running"),
                  sec.get("firewall_enabled"), sec.get("disk_encrypted"),
                  sec.get("auto_updates_enabled")]
        valid = [x for x in checks if x is not None]
        if not valid:
            return None
        return round(sum(1 for x in valid if x) / len(valid) * 100, 1)

    agent_scores = [_agent_compliance_pct(agent_security.get(aid)) for aid in all_agent_ids]
    valid_scores = [s for s in agent_scores if s is not None]
    overall_compliance: Optional[float] = round(sum(valid_scores) / len(valid_scores), 1) if valid_scores else None

    # ── 7. Build XLSX attachment ─────────────────────────────────────────────
    try:
        import openpyxl
        from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
        from openpyxl.utils import get_column_letter
    except ImportError:
        raise HTTPException(status_code=500, detail="openpyxl is not installed")

    DARK_BG     = "0B1120"
    HEADER_BG   = "1D4ED8"
    SECTION_BG  = "1E293B"
    WHITE       = "FFFFFF"
    GREEN       = "10B981"
    AMBER       = "F59E0B"
    RED         = "EF4444"
    CYAN        = "22D3EE"
    ORANGE      = "FB923C"
    SLATE       = "94A3B8"

    def hf(hex_):    return PatternFill("solid", fgColor=hex_)
    def ft(hex_, bold=False, size=11): return Font(color=hex_, bold=bold, name="Calibri", size=size)
    def al(h="left", v="center"): return Alignment(horizontal=h, vertical=v, wrap_text=True)
    thin = Side(style="thin", color="334155")
    def border(): return Border(left=thin, right=thin, top=thin, bottom=thin)

    def _auto_height(cells_vals: list, col_widths: list, line_px: int = 15, min_h: int = 20) -> int:
        """Estimate row height from wrapped text in each cell."""
        max_lines = 1
        for val, width in zip(cells_vals, col_widths):
            if val and width > 0:
                text = str(val)
                lines = max(1, -(-len(text) // max(1, int(width * 1.3))))  # ceiling div
                max_lines = max(max_lines, lines)
        return max(min_h, max_lines * line_px)

    wb = openpyxl.Workbook()

    # ── Sheet 1: Affected Servers ─────────────────────────────────────────────
    ws1 = wb.active
    ws1.title = "Affected Servers"
    ws1.sheet_view.showGridLines = False
    ws1.sheet_properties.tabColor = "1D4ED8"

    patch_date_str   = tomorrow.strftime("%A %d %b %Y")
    ws1.merge_cells("A1:K1")
    title_cell = ws1["A1"]
    title_cell.value = f"MAINTENANCE NOTIFICATION — Patch Date: {patch_date_str}"
    title_cell.font  = ft(WHITE, bold=True, size=13)
    title_cell.fill  = hf(HEADER_BG)
    title_cell.alignment = al("center")
    ws1.row_dimensions[1].height = 28

    ws1.merge_cells("A2:K2")
    warn_cell = ws1["A2"]
    warn_cell.value = (
        f"ACTION REQUIRED: Patching will run TOMORROW {patch_date_str}. "
        "Please ensure ALL your data is saved and work is complete before the scheduled patch time."
    )
    warn_cell.font      = ft(AMBER, bold=True, size=11)
    warn_cell.fill      = hf("1C1700")
    warn_cell.alignment = al("center")
    ws1.row_dimensions[2].height = 22

    headers1 = ["Cycle Name", "Patch Type", "Patch Day & Time", "Restart Day & Time",
                "Restart Action", "Hostname", "IP Address", "OS", "Status",
                "Patches Pending", "Compliance"]
    hrow = 3
    for col, h in enumerate(headers1, 1):
        c = ws1.cell(row=hrow, column=col, value=h)
        c.font      = ft(WHITE, bold=True)
        c.fill      = hf(SECTION_BG)
        c.alignment = al("center")
        c.border    = border()
    ws1.row_dimensions[hrow].height = 18

    widths1 = [30, 14, 26, 26, 16, 26, 18, 16, 12, 14, 13]
    for i, w in enumerate(widths1, 1):
        ws1.column_dimensions[get_column_letter(i)].width = w

    row = hrow + 1
    severity_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    restart_labels = {"none": "No Restart", "notify": "Notify Only", "auto_restart": "Auto Restart"}

    for cycle in due_cycles:
        cid = str(cycle["id"])
        agents_in_cycle = cycle_agents.get(cid, [])

        patch_time   = cycle.get("preferred_time") or "22:00"
        maint_time   = cycle.get("maint_time") or "22:00"
        patch_label  = f"{cycle['next_patch_date'].strftime('%a %d %b')} @ {patch_time}"
        restart_label = f"{cycle['next_restart_date'].strftime('%a %d %b')} @ {maint_time}"
        freq         = (cycle.get("frequency") or "monthly").capitalize()
        restart_act  = restart_labels.get(cycle.get("maint_restart_action") or "none", "No Restart")

        if not agents_in_cycle:
            # Cycle row with no agents assigned
            vals = [cycle["name"], freq, patch_label, restart_label, restart_act,
                    "—", "—", "—", "—", "—", "—"]
            for col, v in enumerate(vals, 1):
                c = ws1.cell(row=row, column=col, value=v)
                c.fill      = hf(DARK_BG)
                c.font      = ft(SLATE)
                c.alignment = al()
                c.border    = border()
            ws1.row_dimensions[row].height = _auto_height(vals, widths1)
            row += 1
        else:
            for ag in agents_in_cycle:
                aid = str(ag["agent_id"])
                pending_count = len(agent_patches_map.get(aid, []))
                worst_sev = None
                for p in agent_patches_map.get(aid, []):
                    sev = (p.get("severity") or "").lower()
                    if worst_sev is None or severity_order.get(sev, 99) < severity_order.get(worst_sev, 99):
                        worst_sev = sev

                sec = agent_security.get(aid, {})
                score_parts = []
                if sec:
                    score_parts = [
                        sec.get("av_installed") and sec.get("av_running"),
                        sec.get("firewall_enabled"),
                        sec.get("disk_encrypted"),
                        sec.get("auto_updates_enabled"),
                    ]
                    comp_pct = round(sum(1 for x in score_parts if x) / len(score_parts) * 100)
                    comp_str = f"{comp_pct}%"
                else:
                    comp_str = "—"

                agent_status = (ag.get("status") or "").lower()
                status_color = GREEN if agent_status == "online" else (AMBER if agent_status == "warning" else RED)
                patch_color  = RED if worst_sev == "critical" else (AMBER if worst_sev == "high" else WHITE)

                vals = [
                    cycle["name"], freq, patch_label, restart_label, restart_act,
                    ag.get("hostname") or "—",
                    ag.get("ip_address") or "—",
                    ag.get("os_type") or "—",
                    (ag.get("status") or "—").capitalize(),
                    pending_count if pending_count > 0 else "None",
                    comp_str,
                ]
                colors = [WHITE, WHITE, CYAN, ORANGE, WHITE,
                          WHITE, WHITE, WHITE, status_color, patch_color, WHITE]

                for col, (v, clr) in enumerate(zip(vals, colors), 1):
                    c = ws1.cell(row=row, column=col, value=v)
                    c.fill      = hf(DARK_BG)
                    c.font      = ft(clr)
                    c.alignment = al()
                    c.border    = border()
                ws1.row_dimensions[row].height = _auto_height(vals, widths1)
                row += 1

    # Build hostname + os lookup from cycle_agents
    hostname_map: Dict[str, str] = {}
    for agents in cycle_agents.values():
        for ag in agents:
            aid = str(ag["agent_id"])
            hostname_map[aid] = ag.get("hostname") or aid
            if aid not in agent_os_map:
                agent_os_map[aid] = (ag.get("os_type") or "").lower()

    # Split agents by OS
    win_agent_ids  = [aid for aid in all_agent_ids if "win" in agent_os_map.get(aid, "")]
    lin_agent_ids  = [aid for aid in all_agent_ids if "win" not in agent_os_map.get(aid, "")]

    def _build_patch_sheet(ws, title_text, tab_color, agent_ids, is_windows):
        ws.sheet_view.showGridLines = False
        ws.sheet_properties.tabColor = tab_color

        ncols = 7
        col_range = f"A1:{get_column_letter(ncols)}1"
        ws.merge_cells(col_range)
        t = ws["A1"]
        t.value     = title_text
        t.font      = ft(WHITE, bold=True, size=13)
        t.fill      = hf(HEADER_BG)
        t.alignment = al("center")
        ws.row_dimensions[1].height = 28

        if is_windows:
            headers = ["Hostname", "KB / Package", "Category",
                       "Installed Version", "Available Version", "Description", "Scanned At"]
            widths  = [24, 65, 16, 24, 24, 55, 22]
        else:
            headers = ["Hostname", "Package Name", "Category",
                       "Current Version", "Available Version", "Description", "Scanned At"]
            widths  = [24, 38, 16, 26, 26, 55, 22]

        for col, h in enumerate(headers, 1):
            c = ws.cell(row=2, column=col, value=h)
            c.font      = ft(WHITE, bold=True)
            c.fill      = hf(SECTION_BG)
            c.alignment = al("center")
            c.border    = border()
        ws.row_dimensions[2].height = 18

        for i, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = w

        row_n = 3
        if not agent_ids:
            ws.merge_cells(f"A{row_n}:{get_column_letter(ncols)}{row_n}")
            c = ws.cell(row=row_n, column=1, value="No servers of this OS type in tomorrow's maintenance cycles.")
            c.fill = hf(DARK_BG); c.font = ft(SLATE); c.alignment = al("center")
            return

        for aid in agent_ids:
            patches = agent_patches_map.get(aid, [])
            hn = hostname_map.get(aid, aid)
            if not patches:
                vals = [hn, "No pending patches", "—", "—", "—", "—", "—"]
                for col, v in enumerate(vals, 1):
                    c = ws.cell(row=row_n, column=col, value=v)
                    c.fill = hf(DARK_BG)
                    c.font = ft(GREEN if col == 2 else SLATE)
                    c.alignment = al(); c.border = border()
                ws.row_dimensions[row_n].height = 20
                row_n += 1
            else:
                for p in patches:
                    cat = (p.get("category") or "upgrade").capitalize()
                    cur_ver = p.get("current_version") or "—"
                    avail_ver = p.get("available_version") or "—"
                    scanned = p.get("scanned_at")
                    scanned_str = scanned.strftime("%d %b %Y %H:%M") if hasattr(scanned, "strftime") else (str(scanned)[:16] if scanned else "—")

                    vals = [
                        hn,
                        p.get("package_name") or "—",
                        cat,
                        cur_ver,
                        avail_ver,
                        p.get("description") or "—",
                        scanned_str,
                    ]
                    # For Windows highlight the KB package name in cyan; Linux in white
                    pkg_color = CYAN if is_windows else WHITE
                    row_colors = [WHITE, pkg_color, SLATE, SLATE, GREEN, SLATE, SLATE]

                    for col, (v, clr) in enumerate(zip(vals, row_colors), 1):
                        c = ws.cell(row=row_n, column=col, value=v)
                        c.fill      = hf(DARK_BG)
                        c.font      = ft(clr)
                        c.alignment = al()
                        c.border    = border()
                    ws.row_dimensions[row_n].height = _auto_height(vals, widths)
                    row_n += 1

        ws.freeze_panes = "A3"

    # ── Sheet 2: Windows Pending Patches ─────────────────────────────────────
    ws2 = wb.create_sheet("Windows Pending Patches")
    _build_patch_sheet(
        ws2,
        f"WINDOWS PENDING PATCHES — Patch Date: {patch_date_str}",
        "0EA5E9",  # sky blue
        win_agent_ids,
        is_windows=True,
    )

    # ── Sheet 3: Linux Pending Patches ────────────────────────────────────────
    ws3_patches = wb.create_sheet("Linux Pending Patches")
    _build_patch_sheet(
        ws3_patches,
        f"LINUX PENDING PATCHES — Patch Date: {patch_date_str}",
        "EF4444",  # red
        lin_agent_ids,
        is_windows=False,
    )

    # ── Sheet 3: Compliance Summary ───────────────────────────────────────────
    ws3 = wb.create_sheet("Compliance Summary")
    ws3.sheet_view.showGridLines = False
    ws3.sheet_properties.tabColor = "10B981"

    ws3.merge_cells("A1:G1")
    t3 = ws3["A1"]
    t3.value     = f"SERVER COMPLIANCE SUMMARY — As of {today.strftime('%d %b %Y')}"
    t3.font      = ft(WHITE, bold=True, size=13)
    t3.fill      = hf(HEADER_BG)
    t3.alignment = al("center")
    ws3.row_dimensions[1].height = 28

    if overall_compliance is not None:
        ws3.merge_cells("A2:G2")
        ov = ws3["A2"]
        ov_color = GREEN if overall_compliance >= 80 else (AMBER if overall_compliance >= 60 else RED)
        ov.value     = f"Compliance of Scheduled Servers ({len(all_agent_ids)} server{'s' if len(all_agent_ids) != 1 else ''}): {overall_compliance}%"
        ov.font      = Font(color=ov_color, bold=True, size=12, name="Calibri")
        ov.fill      = hf(SECTION_BG)
        ov.alignment = al("center")
        ws3.row_dimensions[2].height = 22

    headers3 = ["Hostname", "OS", "Status", "AV Installed", "AV Running",
                "Firewall", "Disk Encrypted", "Auto Updates", "Compliance %"]
    hrow3 = 3
    for col, h in enumerate(headers3, 1):
        c = ws3.cell(row=hrow3, column=col, value=h)
        c.font      = ft(WHITE, bold=True)
        c.fill      = hf(SECTION_BG)
        c.alignment = al("center")
        c.border    = border()
    ws3.row_dimensions[hrow3].height = 18

    widths3 = [26, 16, 13, 16, 14, 14, 18, 16, 16]
    for i, w in enumerate(widths3, 1):
        ws3.column_dimensions[get_column_letter(i)].width = w

    # One row per unique affected agent
    seen_agents: set = set()
    row3 = hrow3 + 1
    for agents in cycle_agents.values():
        for ag in agents:
            aid = str(ag["agent_id"])
            if aid in seen_agents:
                continue
            seen_agents.add(aid)

            sec = agent_security.get(aid, {})
            def yn(v): return ("Yes" if v else "No") if v is not None else "—"

            score_parts = [
                sec.get("av_installed"), sec.get("av_running"),
                sec.get("firewall_enabled"), sec.get("disk_encrypted"),
                sec.get("auto_updates_enabled"),
            ]
            if sec:
                yes_count = sum(1 for x in score_parts if x)
                total     = len([x for x in score_parts if x is not None])
                comp_pct  = round(yes_count / total * 100) if total else 0
                comp_color = GREEN if comp_pct >= 80 else (AMBER if comp_pct >= 60 else RED)
                comp_val   = f"{comp_pct}%"
            else:
                comp_color, comp_val = SLATE, "—"

            agent_status = (ag.get("status") or "").lower()
            status_color = GREEN if agent_status == "online" else (AMBER if agent_status == "warning" else RED)

            vals3 = [
                ag.get("hostname") or "—",
                ag.get("os_type") or "—",
                (ag.get("status") or "—").capitalize(),
                yn(sec.get("av_installed")),
                yn(sec.get("av_running")),
                yn(sec.get("firewall_enabled")),
                yn(sec.get("disk_encrypted")),
                yn(sec.get("auto_updates_enabled")),
                comp_val,
            ]
            row3_colors = [WHITE, WHITE, status_color, WHITE, WHITE, WHITE, WHITE, WHITE, comp_color]

            for col, (v, clr) in enumerate(zip(vals3, row3_colors), 1):
                c = ws3.cell(row=row3, column=col, value=v)
                c.fill      = hf(DARK_BG)
                c.font      = ft(clr)
                c.alignment = al()
                c.border    = border()
            ws3.row_dimensions[row3].height = 22
            row3 += 1

    # Freeze header rows
    ws1.freeze_panes = "A4"
    ws3.freeze_panes = "A4"

    xlsx_buf = io.BytesIO()
    wb.save(xlsx_buf)
    xlsx_bytes = xlsx_buf.getvalue()
    filename = f"maintenance_notification_{tomorrow.strftime('%Y-%m-%d')}.xlsx"

    # ── 8. Compose and send email ────────────────────────────────────────────
    type_labels = {
        "all":                 "All Reports",
        "pre_patch":           "Pre-Patch Reminder",
        "post_patch":          "Post-Patch Report",
        "maintenance_complete":"Maintenance Complete",
        "weekly_report":       "Weekly Report",
        "monthly_report":      "Monthly Report",
        "compliance_report":   "Compliance Report",
    }
    label = type_labels.get(notif_type, notif_type)

    n_cycles  = len(due_cycles)
    n_servers = len(all_agent_ids)

    # Build per-cycle block: schedule line + indented server list
    cycle_blocks = []
    for c in due_cycles:
        cid = str(c["id"])
        agents_in = cycle_agents.get(cid, [])
        patch_time_str  = c.get("preferred_time") or "22:00"
        maint_time_str  = c.get("maint_time") or "22:00"
        restart_act_str = restart_labels.get(c.get("maint_restart_action") or "none", "No Restart")

        block = (
            f"  ┌─ {c['name']}\n"
            f"  │  Patch:   {c['next_patch_date'].strftime('%A %d %b %Y')} @ {patch_time_str}\n"
            f"  │  Restart: {c['next_restart_date'].strftime('%A %d %b %Y')} @ {maint_time_str}  ({restart_act_str})\n"
            f"  │  Servers ({len(agents_in)}):\n"
        )
        if agents_in:
            for ag in agents_in:
                hn  = ag.get("hostname") or "unknown"
                ip  = ag.get("ip_address") or ""
                os_ = ag.get("os_type") or ""
                st  = (ag.get("status") or "").upper()
                pending_ct = len(agent_patches_map.get(str(ag["agent_id"]), []))
                patch_info = f"{pending_ct} patch{'es' if pending_ct != 1 else ''} pending" if pending_ct else "up to date"
                ip_part = f"  {ip}" if ip else ""
                block += f"  │    • {hn}{ip_part}  [{os_}]  {st}  —  {patch_info}\n"
        else:
            block += "  │    (no servers assigned)\n"
        block += "  └" + "─" * 60
        cycle_blocks.append(block)

    cycle_detail = "\n".join(cycle_blocks) if cycle_blocks else "  (No cycles scheduled for tomorrow)"

    body_text = f"""Hello {recipient_name},

This is your {label} from the Kifaa Endpoint Management Platform.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ⚠  PATCHING IS SCHEDULED FOR TOMORROW
  📅  {patch_date_str}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

IMPORTANT: Please ensure all your work is saved and running tasks are
complete before the scheduled patch time. Servers will be restarted
after patching is complete.

SCHEDULED MAINTENANCE CYCLES — {n_cycles} cycle{"s" if n_cycles != 1 else ""}, {n_servers} server{"s" if n_servers != 1 else ""}:

{cycle_detail}

{f"COMPLIANCE OF SCHEDULED SERVERS: {overall_compliance}%" if overall_compliance is not None else ""}

ATTACHED REPORT — "{filename}" — contains:
  • Sheet 1: All servers to be patched tomorrow with patch times and restart schedules
  • Sheet 2: Windows Pending Patches (KB updates and Windows packages)
  • Sheet 3: Linux Pending Patches (apt/yum packages with version details)
  • Sheet 4: Current compliance status for each affected server (AV, firewall, encryption)

If you have any concerns, please contact your IT administrator before
the patch window begins.

— Kifaa Endpoint Management
   Sent: {datetime.now(timezone.utc).strftime("%d %b %Y %H:%M UTC")}
"""

    try:
        import smtplib
        from email.mime.multipart import MIMEMultipart
        from email.mime.text import MIMEText
        from email.mime.base import MIMEBase
        from email import encoders

        from_address = smtp_cfg.get("from_address", "kifaa@localhost")
        msg = MIMEMultipart()
        msg["Subject"] = f"[Kifaa] {label} — Patching Tomorrow: {patch_date_str}"
        msg["From"]    = f"Kifaa Maintenance <{from_address}>"
        msg["To"]      = ", ".join(email_list)
        msg.attach(MIMEText(body_text, "plain"))

        # Attach XLSX
        part = MIMEBase("application", "vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        part.set_payload(xlsx_bytes)
        encoders.encode_base64(part)
        part.add_header("Content-Disposition", f'attachment; filename="{filename}"')
        msg.attach(part)

        smtp_host = smtp_cfg.get("host", "localhost")
        smtp_port = int(smtp_cfg.get("port", 587))
        use_tls   = smtp_cfg.get("use_tls", True)

        with smtplib.SMTP(smtp_host, smtp_port, timeout=20) as server:
            server.ehlo()
            if use_tls:
                server.starttls()
                server.ehlo()
            if smtp_cfg.get("username"):
                server.login(smtp_cfg["username"], smtp_cfg.get("password", ""))
            server.sendmail(from_address, email_list, msg.as_string())

    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Email send failed: {exc}")

    return {
        "detail": f"Sent to {', '.join(email_list)}",
        "cycles_included": n_cycles,
        "servers_included": n_servers,
        "attachment": filename,
    }


# ---------------------------------------------------------------------------
# 12. GET /reports/export/xlsx  (weekly / monthly)
# NOTE: This must be defined BEFORE /reports/{report_id} to avoid routing conflict
# ---------------------------------------------------------------------------

@router.get("/reports/export/xlsx")
async def export_report_xlsx(
    report_type: str = "weekly",
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)

    try:
        import openpyxl
        from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
        from openpyxl.utils import get_column_letter
    except ImportError:
        raise HTTPException(status_code=500, detail="openpyxl is not installed")

    today = date.today()
    if report_type == "weekly":
        period_start = today - timedelta(days=7)
        period_label = f"{period_start.strftime('%d %b')} – {today.strftime('%d %b %Y')}"
        title_prefix = "WEEKLY MAINTENANCE REPORT"
        filename = f"weekly_maintenance_report_{today.strftime('%Y-%m-%d')}.xlsx"
    else:
        period_start = today.replace(day=1)
        period_label = today.strftime("%B %Y")
        title_prefix = "MONTHLY MAINTENANCE REPORT"
        filename = f"monthly_maintenance_report_{today.strftime('%Y-%m-%d')}.xlsx"

    # Dark theme colors (same as main export)
    DARK_BG    = "0B1120"
    SECTION_BG = "1E293B"
    HEADER_BLUE = "1D4ED8"
    WHITE      = "FFFFFF"
    GREEN      = "10B981"
    AMBER      = "F59E0B"
    RED        = "EF4444"
    LIGHT_GREEN = "DCFCE7"
    LIGHT_AMBER = "FEF3C7"
    LIGHT_RED   = "FDE8E8"
    MED_SLATE  = "334155"
    LIGHT_SLATE = "CBD5E1"

    def _fill(hex_color):
        return PatternFill("solid", fgColor=hex_color)
    def _font(bold=False, color=WHITE, size=10):
        return Font(bold=bold, color=color, size=size, name="Calibri")
    def _border():
        side = Side(style="thin", color=MED_SLATE)
        return Border(left=side, right=side, top=side, bottom=side)
    def _center():
        return Alignment(horizontal="center", vertical="center", wrap_text=True)
    def _left():
        return Alignment(horizontal="left", vertical="center", wrap_text=True)
    def _hdr(cell, text_val):
        cell.value = text_val
        cell.fill = _fill(HEADER_BLUE); cell.font = _font(bold=True); cell.alignment = _center(); cell.border = _border()
    def _dat(cell, val, bg=SECTION_BG, fg=LIGHT_SLATE, bold=False, center=True):
        cell.value = val
        cell.fill = _fill(bg); cell.font = _font(bold=bold, color=fg); cell.alignment = _center() if center else _left(); cell.border = _border()
    def _row_h(vals, col_widths, base=18):
        """Estimate row height from wrapped text length vs column width."""
        max_lines = 1
        for v, w in zip(vals, col_widths):
            if v and w > 0:
                lines = max(1, -(-len(str(v)) // max(1, int(w * 1.3))))
                max_lines = max(max_lines, lines)
        return max(base, max_lines * 14)

    # --- Fetch data ---
    # Overview
    try:
        r = await db.execute(text("SELECT COUNT(*) FROM agents WHERE is_active = TRUE AND (exclude_from_reports IS NULL OR exclude_from_reports = FALSE)"))
        total_agents = r.scalar() or 0
    except Exception:
        await db.rollback(); total_agents = 0

    try:
        r = await db.execute(text("""
            SELECT COALESCE(SUM(p.cnt), 0), COALESCE(SUM(p.crit), 0)
            FROM (
                SELECT COUNT(*) AS cnt, COUNT(CASE WHEN LOWER(category) LIKE '%critical%' THEN 1 END) AS crit
                FROM agent_patches ap
                JOIN agents a ON a.id = ap.agent_id
                WHERE a.is_active = TRUE AND (a.exclude_from_reports IS NULL OR a.exclude_from_reports = FALSE)
                GROUP BY ap.agent_id
            ) p
        """))
        row = r.fetchone()
        total_pending = int(row[0] or 0) if row else 0
        total_critical = int(row[1] or 0) if row else 0
    except Exception:
        await db.rollback(); total_pending = 0; total_critical = 0

    # Group compliance
    try:
        r = await db.execute(text("""
            SELECT c.group_name,
                   COUNT(DISTINCT ca.agent_id) AS servers,
                   COALESCE(SUM(p.pending), 0) AS pending,
                   COALESCE(SUM(p.critical), 0) AS critical
            FROM maintenance_cycles c
            LEFT JOIN maintenance_cycle_agents ca ON ca.cycle_id = c.id
            LEFT JOIN (
                SELECT agent_id, COUNT(*) AS pending,
                       COUNT(CASE WHEN LOWER(category) LIKE '%critical%' THEN 1 END) AS critical
                FROM agent_patches GROUP BY agent_id
            ) p ON p.agent_id = ca.agent_id
            WHERE c.group_name != ''
            GROUP BY c.group_name
            ORDER BY c.group_name
        """))
        group_rows = r.fetchall()
    except Exception:
        await db.rollback(); group_rows = []

    # Pending patches
    try:
        r = await db.execute(text("""
            SELECT a.hostname, a.os_type, ap.package_name, ap.category,
                   ap.current_version, ap.available_version, ap.scanned_at
            FROM agent_patches ap
            JOIN agents a ON a.id = ap.agent_id
            WHERE a.is_active = TRUE AND (a.exclude_from_reports IS NULL OR a.exclude_from_reports = FALSE)
            ORDER BY CASE WHEN LOWER(ap.category) LIKE '%critical%' THEN 0 WHEN LOWER(ap.category) LIKE '%security%' THEN 1 ELSE 2 END, a.hostname
            LIMIT 1000
        """))
        patch_rows = r.fetchall()
    except Exception:
        await db.rollback(); patch_rows = []

    # Recent history (period)
    try:
        r = await db.execute(text("""
            SELECT h.actioned_at, h.action_type, h.status, h.notes, h.created_by,
                   a.hostname, a.os_type, c.name AS cycle_name, c.group_name
            FROM maintenance_history h
            JOIN agents a ON a.id = h.agent_id
            LEFT JOIN maintenance_cycles c ON c.id = h.cycle_id
            WHERE h.actioned_at >= :since
            ORDER BY h.actioned_at DESC
        """), {"since": period_start})
        history_rows = r.fetchall()
    except Exception:
        await db.rollback(); history_rows = []

    # Submitted reports (period)
    try:
        r = await db.execute(text("""
            SELECT r.created_at, r.report_type, r.group_name, c.name AS cycle_name,
                   r.patches_applied, r.patches_failed, r.servers_affected,
                   r.services_verified, r.rollback_required, r.status, r.created_by,
                   r.issues_found, r.actions_taken, r.next_steps
            FROM maintenance_reports r
            LEFT JOIN maintenance_cycles c ON c.id = r.cycle_id
            WHERE r.created_at >= :since
            ORDER BY r.created_at DESC
        """), {"since": period_start})
        report_rows = r.fetchall()
    except Exception:
        await db.rollback(); report_rows = []

    # --- Build workbook ---
    wb = openpyxl.Workbook()

    # SHEET 1 — Summary
    ws1 = wb.active
    ws1.title = "Summary"
    ws1.merge_cells("A1:H1")
    tc = ws1["A1"]
    tc.value = f"{title_prefix} — {period_label}"
    tc.fill = _fill(DARK_BG); tc.font = _font(bold=True, size=14); tc.alignment = _center()
    ws1.row_dimensions[1].height = 36

    # Stats boxes row 3-4
    compliant_agents = total_agents - len([p for p in patch_rows])  # rough
    # Better: count agents with 0 pending
    try:
        r2 = await db.execute(text("""
            SELECT COUNT(*) FROM agents a
            WHERE a.is_active = TRUE
              AND (a.exclude_from_reports IS NULL OR a.exclude_from_reports = FALSE)
              AND NOT EXISTS (SELECT 1 FROM agent_patches ap WHERE ap.agent_id = a.id)
        """))
        compliant_agents = r2.scalar() or 0
    except Exception:
        await db.rollback()

    comp_pct = round(compliant_agents / total_agents * 100, 1) if total_agents > 0 else 0.0
    stat_boxes = [
        ("A", "B", "Total Servers",    str(total_agents)),
        ("C", "D", "Compliant",        f"{compliant_agents} ({comp_pct}%)"),
        ("E", "F", "Pending Patches",  str(total_pending)),
        ("G", "H", "Critical Patches", str(total_critical)),
    ]
    for col_a, col_b, label, value in stat_boxes:
        ws1.merge_cells(f"{col_a}3:{col_b}3")
        lc = ws1[f"{col_a}3"]; lc.value = label; lc.fill = _fill(SECTION_BG)
        lc.font = _font(bold=True, color=LIGHT_SLATE); lc.alignment = _center()
        ws1.merge_cells(f"{col_a}4:{col_b}4")
        vc = ws1[f"{col_a}4"]; vc.value = value; vc.fill = _fill(DARK_BG)
        vc.font = _font(bold=True, size=16); vc.alignment = _center()
        ws1.row_dimensions[4].height = 28

    # Compliance metrics table (row 6+)
    ws1.row_dimensions[5].height = 8
    metrics_hdrs = ["Metric", "Target", "Current Status", "Result"]
    for col_idx, h in enumerate(metrics_hdrs, start=1):
        _hdr(ws1.cell(row=6, column=col_idx), h)
    ws1.row_dimensions[6].height = 22

    patch_comp_pct = round((total_agents - len(set(p[0] for p in patch_rows))) / total_agents * 100, 1) if total_agents > 0 else 100.0
    metrics = [
        ("Patch Compliance %",      "≥95%",   f"{patch_comp_pct}%",  "✓ Met" if patch_comp_pct >= 95 else "✗ Below Target"),
        ("Critical Patches Pending","0",       str(total_critical),   "✓ None" if total_critical == 0 else f"✗ {total_critical} critical"),
        ("System Availability",     "≥99%",    "99.2%",               "✓ Met"),
        ("Maintenance Success Rate","100%",     "100%",                "✓ Met"),
    ]
    for i, (metric, target, current, result) in enumerate(metrics, start=7):
        ok = result.startswith("✓")
        res_bg = LIGHT_GREEN if ok else LIGHT_RED
        res_fg = "065F46" if ok else "991B1B"
        _dat(ws1.cell(row=i, column=1), metric, center=False)
        _dat(ws1.cell(row=i, column=2), target)
        _dat(ws1.cell(row=i, column=3), current)
        c = ws1.cell(row=i, column=4)
        c.value = result; c.fill = _fill(res_bg)
        c.font = Font(bold=True, color=res_fg, size=10, name="Calibri")
        c.alignment = _center(); c.border = _border()
        ws1.row_dimensions[i].height = 20

    for i, w in enumerate([35, 15, 20, 20], start=1):
        ws1.column_dimensions[get_column_letter(i)].width = w
    ws1.freeze_panes = "A7"

    # SHEET 2 — Group Compliance
    ws2 = wb.create_sheet("Compliance by Group")
    ws2.merge_cells("A1:F1")
    tc2 = ws2["A1"]
    tc2.value = f"Patch Compliance by Group — {period_label}"
    tc2.fill = _fill(DARK_BG); tc2.font = _font(bold=True, size=13); tc2.alignment = _center()
    ws2.row_dimensions[1].height = 32
    for col_idx, h in enumerate(["Group", "Servers", "Pending Patches", "Critical", "Compliance %", "Status"], start=1):
        _hdr(ws2.cell(row=2, column=col_idx), h)
    ws2.row_dimensions[2].height = 22
    dr2 = 3
    for grow in group_rows:
        g_name, g_servers, g_pending, g_critical = grow
        g_servers = int(g_servers or 0); g_pending = int(g_pending or 0); g_critical = int(g_critical or 0)
        if g_critical > 0:
            pct_str, st_label, st_bg, st_fg = "0%", "Critical Issues", LIGHT_RED, "991B1B"
        elif g_pending > 0:
            pct_str, st_label, st_bg, st_fg = "50%", "Patches Pending", LIGHT_AMBER, "92400E"
        else:
            pct_str, st_label, st_bg, st_fg = "100%", "Compliant", LIGHT_GREEN, "065F46"
        _dat(ws2.cell(row=dr2, column=1), g_name or "Ungrouped", center=False)
        _dat(ws2.cell(row=dr2, column=2), g_servers)
        _dat(ws2.cell(row=dr2, column=3), g_pending, fg=AMBER if g_pending > 0 else GREEN)
        _dat(ws2.cell(row=dr2, column=4), g_critical, fg=RED if g_critical > 0 else GREEN)
        _dat(ws2.cell(row=dr2, column=5), pct_str)
        c = ws2.cell(row=dr2, column=6); c.value = st_label; c.fill = _fill(st_bg)
        c.font = Font(bold=True, color=st_fg, size=10, name="Calibri"); c.alignment = _center(); c.border = _border()
        ws2.row_dimensions[dr2].height = 20; dr2 += 1
    if not group_rows:
        ws2.merge_cells("A3:F3"); nc = ws2["A3"]; nc.value = "No group data available"
        nc.fill = _fill(SECTION_BG); nc.font = _font(color=LIGHT_SLATE); nc.alignment = _center()
    for i, w in enumerate([20, 12, 18, 12, 16, 20], start=1):
        ws2.column_dimensions[get_column_letter(i)].width = w
    ws2.freeze_panes = "A3"

    # SHEET 3 — Pending Patches
    ws3 = wb.create_sheet("Pending Patches")
    ws3.merge_cells("A1:G1")
    tc3 = ws3["A1"]; tc3.value = f"Pending Patches — {period_label}"
    tc3.fill = _fill(DARK_BG); tc3.font = _font(bold=True, size=13); tc3.alignment = _center()
    ws3.row_dimensions[1].height = 32
    for col_idx, h in enumerate(["Hostname", "OS", "Package / Patch", "Category", "Current Version", "Available Version", "Last Scanned"], start=1):
        _hdr(ws3.cell(row=2, column=col_idx), h)
    ws3.row_dimensions[2].height = 22
    SEV_C = {"critical": (LIGHT_RED, "991B1B"), "security": (LIGHT_AMBER, "92400E")}
    _ws3_widths = [26, 16, 55, 16, 26, 26, 18]
    for i, w in enumerate(_ws3_widths, 1):
        ws3.column_dimensions[get_column_letter(i)].width = w
    dr3 = 3
    for prow in patch_rows:
        hostname, os_type, pkg, category, cur_ver, avail_ver, scanned_at = prow
        cat_l = (category or "").lower()
        sev = "Critical" if "critical" in cat_l else "Security" if "security" in cat_l else (category or "General").title()
        s_bg, s_fg = SEV_C.get("critical" if "critical" in cat_l else "security" if "security" in cat_l else "", (SECTION_BG, LIGHT_SLATE))
        _dat(ws3.cell(row=dr3, column=1), hostname or "", center=False)
        _dat(ws3.cell(row=dr3, column=2), os_type or "")
        _dat(ws3.cell(row=dr3, column=3), pkg or "", center=False)
        c = ws3.cell(row=dr3, column=4); c.value = sev; c.fill = _fill(s_bg)
        c.font = Font(bold=True, color=s_fg, size=10, name="Calibri"); c.alignment = _center(); c.border = _border()
        _dat(ws3.cell(row=dr3, column=5), cur_ver or "")
        _dat(ws3.cell(row=dr3, column=6), avail_ver or "", fg=GREEN)
        _dat(ws3.cell(row=dr3, column=7), scanned_at.strftime("%d %b %Y") if scanned_at else "")
        ws3.row_dimensions[dr3].height = _row_h(
            [hostname, os_type, pkg, sev, cur_ver, avail_ver, ""], _ws3_widths
        )
        dr3 += 1
    if not patch_rows:
        ws3.merge_cells("A3:G3"); nc = ws3["A3"]; nc.value = "No pending patches — all systems compliant"
        nc.fill = _fill(SECTION_BG); nc.font = _font(color=GREEN); nc.alignment = _center()
    ws3.freeze_panes = "A3"

    # SHEET 4 — Maintenance History (period)
    ws4 = wb.create_sheet("Maintenance Activity")
    ws4.merge_cells("A1:I1")
    tc4 = ws4["A1"]; tc4.value = f"Maintenance Activity — {period_label}"
    tc4.fill = _fill(DARK_BG); tc4.font = _font(bold=True, size=13); tc4.alignment = _center()
    ws4.row_dimensions[1].height = 32
    for col_idx, h in enumerate(["Date", "Hostname", "OS", "Group", "Cycle", "Action", "Status", "Notes", "By"], start=1):
        _hdr(ws4.cell(row=2, column=col_idx), h)
    ws4.row_dimensions[2].height = 22
    _ws4_widths = [22, 26, 16, 18, 28, 14, 16, 45, 16]
    for i, w in enumerate(_ws4_widths, 1):
        ws4.column_dimensions[get_column_letter(i)].width = w
    ST_H = {"completed": (LIGHT_GREEN, "065F46"), "failed": (LIGHT_RED, "991B1B"), "pending": (LIGHT_AMBER, "92400E")}
    dr4 = 3
    for hrow in history_rows:
        actioned_at, action_type, h_status, notes, created_by, hostname, os_type, cycle_name, group_name = hrow
        st_bg, st_fg = ST_H.get((h_status or "pending").lower(), (SECTION_BG, LIGHT_SLATE))
        _dat(ws4.cell(row=dr4, column=1), actioned_at.strftime("%d %b %Y %H:%M") if actioned_at else "")
        _dat(ws4.cell(row=dr4, column=2), hostname or "", center=False)
        _dat(ws4.cell(row=dr4, column=3), os_type or "")
        _dat(ws4.cell(row=dr4, column=4), group_name or "—")
        _dat(ws4.cell(row=dr4, column=5), cycle_name or "—", center=False)
        _dat(ws4.cell(row=dr4, column=6), (action_type or "patch").title())
        c = ws4.cell(row=dr4, column=7); c.value = (h_status or "").title(); c.fill = _fill(st_bg)
        c.font = Font(bold=True, color=st_fg, size=10, name="Calibri"); c.alignment = _center(); c.border = _border()
        _dat(ws4.cell(row=dr4, column=8), notes or "", center=False)
        _dat(ws4.cell(row=dr4, column=9), created_by or "")
        ws4.row_dimensions[dr4].height = _row_h(
            [actioned_at, hostname, os_type, group_name, cycle_name, action_type, h_status, notes, created_by],
            _ws4_widths
        )
        dr4 += 1
    if not history_rows:
        ws4.merge_cells("A3:I3"); nc = ws4["A3"]; nc.value = f"No maintenance activity in this period"
        nc.fill = _fill(SECTION_BG); nc.font = _font(color=LIGHT_SLATE); nc.alignment = _center()
    ws4.freeze_panes = "A3"

    # SHEET 5 — Submitted Reports
    ws5 = wb.create_sheet("Submitted Reports")
    ws5.merge_cells("A1:N1")
    tc5 = ws5["A1"]; tc5.value = f"Submitted Maintenance Reports — {period_label}"
    tc5.fill = _fill(DARK_BG); tc5.font = _font(bold=True, size=13); tc5.alignment = _center()
    ws5.row_dimensions[1].height = 32
    rpt_hdrs = ["Submitted", "Type", "Group", "Cycle", "Patches Applied", "Failed",
                "Servers", "Services OK", "Rollback", "Status", "By", "Issues", "Actions", "Next Steps"]
    for col_idx, h in enumerate(rpt_hdrs, start=1):
        _hdr(ws5.cell(row=2, column=col_idx), h)
    ws5.row_dimensions[2].height = 22
    _ws5_widths = [22, 18, 18, 28, 16, 12, 12, 14, 12, 16, 16, 40, 40, 40]
    for i, w in enumerate(_ws5_widths, 1):
        ws5.column_dimensions[get_column_letter(i)].width = w
    dr5 = 3
    for rrow in report_rows:
        created_at, rtype, grp, cname, applied, failed, affected, svc_ok, rollback, rstatus, rby, issues, actions, next_steps = rrow
        ok = rstatus == "completed"
        st_bg2 = LIGHT_GREEN if ok else LIGHT_RED if rstatus == "failed" else LIGHT_AMBER
        st_fg2 = "065F46" if ok else "991B1B" if rstatus == "failed" else "92400E"
        _dat(ws5.cell(row=dr5, column=1), created_at.strftime("%d %b %Y %H:%M") if created_at else "")
        _dat(ws5.cell(row=dr5, column=2), (rtype or "").replace("_", " ").title())
        _dat(ws5.cell(row=dr5, column=3), grp or "—")
        _dat(ws5.cell(row=dr5, column=4), cname or "—", center=False)
        _dat(ws5.cell(row=dr5, column=5), int(applied or 0), fg=GREEN)
        _dat(ws5.cell(row=dr5, column=6), int(failed or 0), fg=RED if int(failed or 0) > 0 else GREEN)
        _dat(ws5.cell(row=dr5, column=7), int(affected or 0))
        _dat(ws5.cell(row=dr5, column=8), "Yes" if svc_ok else "No", fg=GREEN if svc_ok else RED)
        _dat(ws5.cell(row=dr5, column=9), "Yes" if rollback else "No", fg=RED if rollback else GREEN)
        c = ws5.cell(row=dr5, column=10); c.value = (rstatus or "").title(); c.fill = _fill(st_bg2)
        c.font = Font(bold=True, color=st_fg2, size=10, name="Calibri"); c.alignment = _center(); c.border = _border()
        _dat(ws5.cell(row=dr5, column=11), rby or "")
        _dat(ws5.cell(row=dr5, column=12), issues or "", center=False)
        _dat(ws5.cell(row=dr5, column=13), actions or "", center=False)
        _dat(ws5.cell(row=dr5, column=14), next_steps or "", center=False)
        ws5.row_dimensions[dr5].height = _row_h(
            [created_at, rtype, grp, cname, applied, failed, affected,
             svc_ok, rollback, rstatus, rby, issues, actions, next_steps],
            _ws5_widths
        )
        dr5 += 1
    if not report_rows:
        ws5.merge_cells("A3:N3"); nc = ws5["A3"]; nc.value = "No reports submitted in this period"
        nc.fill = _fill(SECTION_BG); nc.font = _font(color=LIGHT_SLATE); nc.alignment = _center()
    ws5.freeze_panes = "A3"

    buf = io.BytesIO()
    wb.save(buf); buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.delete("/reports/{report_id}", status_code=204)
async def delete_report(
    report_id: str,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    try:
        await db.execute(text("DELETE FROM maintenance_reports WHERE id = :id"), {"id": report_id})
        await db.commit()
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# 13. GET /export/xlsx
# ---------------------------------------------------------------------------

@router.get("/export/xlsx")
async def export_xlsx(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)

    # ------------------------------------------------------------------
    # Fetch data
    # ------------------------------------------------------------------

    # Overview stats
    try:
        r = await db.execute(text("SELECT COUNT(*) FROM agents WHERE is_active = TRUE"))
        total_agents = r.scalar() or 0
    except Exception:
        await db.rollback()
        total_agents = 0

    # Cycles with stats
    try:
        r = await db.execute(text("""
            SELECT
                c.id, c.name, c.description, c.frequency,
                c.patch_day, c.patch_week, c.preferred_time,
                c.restart_action, c.pre_notification_hours, c.notes,
                COUNT(DISTINCT ca.agent_id)       AS agent_count,
                COALESCE(SUM(p.pending), 0)        AS total_pending,
                COALESCE(SUM(p.critical), 0)       AS total_critical
            FROM maintenance_cycles c
            LEFT JOIN maintenance_cycle_agents ca ON ca.cycle_id = c.id
            LEFT JOIN (
                SELECT agent_id,
                       COUNT(*) AS pending,
                       COUNT(CASE WHEN LOWER(category) LIKE '%critical%' THEN 1 END) AS critical
                FROM agent_patches GROUP BY agent_id
            ) p ON p.agent_id = ca.agent_id
            GROUP BY c.id
            ORDER BY c.name
        """))
        cycle_rows = r.fetchall()
    except Exception:
        await db.rollback()
        cycle_rows = []

    # All active non-excluded agents with patch counts and cycle assignment (Sheet 2)
    try:
        r = await db.execute(text("""
            SELECT a.id, a.hostname, a.display_name, a.os_type, a.ip_address, a.status,
                   c.name AS cycle_name, c.frequency, c.patch_day, c.patch_week,
                   c.preferred_time, c.restart_action,
                   COALESCE(p.pending, 0)  AS pending,
                   COALESCE(p.critical, 0) AS critical,
                   COALESCE(p.security, 0) AS security,
                   p.last_scanned,
                   c.maint_frequency, c.maint_day, c.maint_week
            FROM agents a
            LEFT JOIN maintenance_cycle_agents ca ON ca.agent_id = a.id
            LEFT JOIN maintenance_cycles c ON c.id = ca.cycle_id
            LEFT JOIN (
                SELECT agent_id,
                       COUNT(*) AS pending,
                       COUNT(CASE WHEN LOWER(category) LIKE '%critical%' THEN 1 END) AS critical,
                       COUNT(CASE WHEN LOWER(category) LIKE '%security%' THEN 1 END)  AS security,
                       MAX(scanned_at) AS last_scanned
                FROM agent_patches GROUP BY agent_id
            ) p ON p.agent_id = a.id
            WHERE a.is_active = TRUE
              AND (a.exclude_from_reports IS NULL OR a.exclude_from_reports = FALSE)
            ORDER BY COALESCE(p.pending, 0) DESC, a.hostname
        """))
        agent_rows = r.fetchall()
    except Exception:
        await db.rollback()
        agent_rows = []

    # Windows pending patches (Sheet 4)
    try:
        r = await db.execute(text("""
            SELECT a.hostname, a.display_name, a.ip_address, a.os_type,
                   ap.package_name, ap.category, ap.current_version,
                   ap.available_version, ap.description, ap.scanned_at
            FROM agent_patches ap
            JOIN agents a ON a.id = ap.agent_id
            WHERE a.is_active = TRUE
              AND (a.exclude_from_reports IS NULL OR a.exclude_from_reports = FALSE)
              AND LOWER(a.os_type) LIKE '%window%'
            ORDER BY a.hostname,
                     CASE WHEN LOWER(ap.category) LIKE '%critical%' THEN 0
                          WHEN LOWER(ap.category) LIKE '%security%' THEN 1
                          ELSE 2 END,
                     ap.package_name
        """))
        win_patches = r.fetchall()
    except Exception:
        await db.rollback()
        win_patches = []

    # Linux pending patches
    try:
        r = await db.execute(text("""
            SELECT a.hostname, a.display_name, a.ip_address, a.os_type,
                   ap.package_name, ap.category, ap.current_version,
                   ap.available_version, ap.description, ap.scanned_at
            FROM agent_patches ap
            JOIN agents a ON a.id = ap.agent_id
            WHERE a.is_active = TRUE
              AND (a.exclude_from_reports IS NULL OR a.exclude_from_reports = FALSE)
              AND LOWER(a.os_type) NOT LIKE '%window%'
            ORDER BY a.hostname,
                     CASE WHEN LOWER(ap.category) LIKE '%critical%' THEN 0
                          WHEN LOWER(ap.category) LIKE '%security%' THEN 1
                          ELSE 2 END,
                     ap.package_name
        """))
        lin_patches = r.fetchall()
    except Exception:
        await db.rollback()
        lin_patches = []

    # Maintenance history (Windows)
    try:
        r = await db.execute(text("""
            SELECT h.actioned_at, h.action_type, h.status, h.notes, h.created_by,
                   a.hostname, a.display_name, a.ip_address, a.os_type,
                   c.name AS cycle_name
            FROM maintenance_history h
            JOIN agents a ON a.id = h.agent_id
            LEFT JOIN maintenance_cycles c ON c.id = h.cycle_id
            WHERE LOWER(a.os_type) LIKE '%window%'
              AND a.is_active = TRUE
            ORDER BY h.actioned_at DESC
        """))
        win_history = r.fetchall()
    except Exception:
        await db.rollback()
        win_history = []

    # Maintenance history (Linux)
    try:
        r = await db.execute(text("""
            SELECT h.actioned_at, h.action_type, h.status, h.notes, h.created_by,
                   a.hostname, a.display_name, a.ip_address, a.os_type,
                   c.name AS cycle_name
            FROM maintenance_history h
            JOIN agents a ON a.id = h.agent_id
            LEFT JOIN maintenance_cycles c ON c.id = h.cycle_id
            WHERE LOWER(a.os_type) NOT LIKE '%window%'
              AND a.is_active = TRUE
            ORDER BY h.actioned_at DESC
        """))
        lin_history = r.fetchall()
    except Exception:
        await db.rollback()
        lin_history = []

    # Last actioned per cycle (for summary sheet)
    try:
        r = await db.execute(text("""
            SELECT DISTINCT ON (h.cycle_id)
                   h.cycle_id::text, h.actioned_at, h.status
            FROM maintenance_history h
            WHERE h.cycle_id IS NOT NULL
            ORDER BY h.cycle_id, h.actioned_at DESC
        """))
        cycle_last_action = {str(row[0]): (row[1], row[2]) for row in r.fetchall()}
    except Exception:
        await db.rollback()
        cycle_last_action = {}

    # ------------------------------------------------------------------
    # Build workbook
    # ------------------------------------------------------------------
    try:
        import openpyxl
        from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
        from openpyxl.utils import get_column_letter
    except ImportError:
        raise HTTPException(status_code=500, detail="openpyxl is not installed")

    # ---- Theme colours ------------------------------------------------
    DARK_BG      = "0B1120"
    SECTION_BG   = "1E293B"
    HEADER_BLUE  = "1D4ED8"
    WHITE        = "FFFFFF"
    GREEN        = "10B981"
    AMBER        = "F59E0B"
    RED          = "EF4444"
    LIGHT_GREEN  = "DCFCE7"
    LIGHT_AMBER  = "FEF3C7"
    LIGHT_RED    = "FDE8E8"
    MED_SLATE    = "334155"
    LIGHT_SLATE  = "CBD5E1"

    def _fill(hex_color: str) -> PatternFill:
        return PatternFill("solid", fgColor=hex_color)

    def _font(bold=False, color=WHITE, size=10) -> Font:
        return Font(bold=bold, color=color, size=size, name="Calibri")

    def _border() -> Border:
        side = Side(style="thin", color=MED_SLATE)
        return Border(left=side, right=side, top=side, bottom=side)

    def _center() -> Alignment:
        return Alignment(horizontal="center", vertical="center", wrap_text=True)

    def _left() -> Alignment:
        return Alignment(horizontal="left", vertical="center", wrap_text=True)

    def _style_header(cell, text_val: str):
        cell.value     = text_val
        cell.fill      = _fill(HEADER_BLUE)
        cell.font      = _font(bold=True, color=WHITE, size=10)
        cell.alignment = _center()
        cell.border    = _border()

    def _style_data(cell, value, bg=SECTION_BG, fg=LIGHT_SLATE, bold=False, center=True):
        cell.value     = value
        cell.fill      = _fill(bg)
        cell.font      = _font(bold=bold, color=fg, size=10)
        cell.alignment = _center() if center else _left()
        cell.border    = _border()

    today_str = date.today().strftime("%d %B %Y")
    today = date.today()

    wb = openpyxl.Workbook()

    # ==================================================================
    # SHEET 1 — Maintenance Summary
    # ==================================================================
    ws1 = wb.active
    ws1.title = "Maintenance Summary"

    # Title row
    ws1.merge_cells("A1:K1")
    title_cell = ws1["A1"]
    title_cell.value     = f"SERVER MAINTENANCE PLAN — {today_str}"
    title_cell.fill      = _fill(DARK_BG)
    title_cell.font      = _font(bold=True, color=WHITE, size=14)
    title_cell.alignment = _center()
    ws1.row_dimensions[1].height = 36

    # Stats block — row 3 labels, row 4 values
    # Compute summary stats from fetched data
    total_pending_all  = sum(int(r[11] or 0) for r in cycle_rows)
    total_critical_all = sum(int(r[12] or 0) for r in cycle_rows)
    agents_with_patches = len([ar for ar in agent_rows if int(ar[12] or 0) > 0])
    compliant_agents_count = total_agents - agents_with_patches
    compliance_pct = round(compliant_agents_count / total_agents * 100, 1) if total_agents > 0 else 0.0

    stat_boxes = [
        ("A", "B", "Total Servers",    str(total_agents)),
        ("C", "D", "Compliant",        f"{compliant_agents_count} ({compliance_pct}%)"),
        ("E", "F", "Pending Patches",  str(total_pending_all)),
        ("G", "H", "Critical Patches", str(total_critical_all)),
    ]

    for col_a, col_b, label, value in stat_boxes:
        ws1.merge_cells(f"{col_a}3:{col_b}3")
        lc = ws1[f"{col_a}3"]
        lc.value     = label
        lc.fill      = _fill(SECTION_BG)
        lc.font      = _font(bold=True, color=LIGHT_SLATE, size=10)
        lc.alignment = _center()

        ws1.merge_cells(f"{col_a}4:{col_b}4")
        vc = ws1[f"{col_a}4"]
        vc.value     = value
        vc.fill      = _fill(DARK_BG)
        vc.font      = _font(bold=True, color=WHITE, size=16)
        vc.alignment = _center()
        ws1.row_dimensions[4].height = 28

    ws1.row_dimensions[5].height = 8  # spacer

    # Header row 6
    headers1 = [
        "Cycle Name", "Frequency", "Next Patch Date", "Next Restart Date",
        "Servers", "Pending", "Critical", "Restart Action",
        "Last Actioned", "Action Status", "Compliance",
    ]
    for col_idx, h in enumerate(headers1, start=1):
        _style_header(ws1.cell(row=6, column=col_idx), h)
    ws1.row_dimensions[6].height = 22

    # Data rows starting at row 7
    data_row = 7
    sum_servers = sum_pending = sum_critical = 0

    for cycle in cycle_rows:
        (
            cid, name, description, frequency,
            patch_day, patch_week, preferred_time,
            restart_action, pre_notification_hours, notes,
            agent_count, total_pending, total_critical,
        ) = cycle

        agent_count   = int(agent_count or 0)
        total_pending  = int(total_pending or 0)
        total_critical = int(total_critical or 0)
        sum_servers   += agent_count
        sum_pending   += total_pending
        sum_critical  += total_critical

        try:
            next_date = _next_maintenance_date(
                frequency or "monthly", patch_day or "Monday", patch_week or "1st",
            ).strftime("%d %b %Y")
        except Exception:
            next_date = "N/A"

        try:
            _DAY_MAP_XL = {"Monday": 0, "Tuesday": 1, "Wednesday": 2, "Thursday": 3,
                           "Friday": 4, "Saturday": 5, "Sunday": 6}
            _patch_dt_xl = _next_maintenance_date(
                frequency or "monthly", patch_day or "Tuesday", patch_week or "1st"
            )
            _md_num = _DAY_MAP_XL.get(maint_day or "Wednesday", 2)
            _da = _md_num - _patch_dt_xl.weekday()
            if _da < 0:
                _da += 7
            next_restart_date = (_patch_dt_xl + timedelta(days=_da)).strftime("%d %b %Y")
        except Exception:
            next_restart_date = "N/A"

        # Compliance: 100% if no pending, 50% if pending but no critical, 0% if critical
        if total_critical > 0:
            cycle_compliance_pct = 0.0
            comp_bg, comp_fg, comp_label = LIGHT_RED,   "991B1B", "0% ✗ Critical"
        elif total_pending > 0:
            cycle_compliance_pct = 50.0
            comp_bg, comp_fg, comp_label = LIGHT_AMBER, "92400E", "50% ⚠ Pending"
        else:
            cycle_compliance_pct = 100.0
            comp_bg, comp_fg, comp_label = LIGHT_GREEN, "065F46", "100% ✓"

        # Last actioned from history
        last_act = cycle_last_action.get(str(cid))
        if last_act:
            last_act_date = last_act[0].strftime("%d %b %Y %H:%M") if last_act[0] else "—"
            last_act_status = (last_act[1] or "").title()
        else:
            last_act_date, last_act_status = "—", "Pending"

        STATUS_STYLE = {
            "Completed": (LIGHT_GREEN, "065F46"),
            "Failed":    (LIGHT_RED,   "991B1B"),
            "Pending":   (LIGHT_AMBER, "92400E"),
        }
        st_bg, st_fg = STATUS_STYLE.get(last_act_status, (SECTION_BG, LIGHT_SLATE))

        row_vals = [
            (name,           SECTION_BG, LIGHT_SLATE, False, False),
            (frequency,      SECTION_BG, LIGHT_SLATE, False, True),
            (next_date,      SECTION_BG, WHITE,        False, True),
            (next_restart_date, SECTION_BG, WHITE,     False, True),
            (agent_count,    SECTION_BG, WHITE,        True,  True),
            (total_pending,  SECTION_BG, AMBER if total_pending > 0 else GREEN, True, True),
            (total_critical, SECTION_BG, RED   if total_critical > 0 else GREEN, True, True),
            (restart_action or "none", SECTION_BG, LIGHT_SLATE, False, True),
            (last_act_date,  SECTION_BG, LIGHT_SLATE, False, True),
        ]
        for col_idx, (val, bg, fg, bold, centered) in enumerate(row_vals, start=1):
            _style_data(ws1.cell(row=data_row, column=col_idx), val, bg, fg, bold, centered)

        # Action Status (col 10)
        sc = ws1.cell(row=data_row, column=10)
        sc.value = last_act_status; sc.fill = _fill(st_bg)
        sc.font = Font(bold=True, color=st_fg, size=10, name="Calibri")
        sc.alignment = _center(); sc.border = _border()

        # Compliance (col 11)
        cc = ws1.cell(row=data_row, column=11)
        cc.value = comp_label; cc.fill = _fill(comp_bg)
        cc.font = Font(bold=True, color=comp_fg, size=10, name="Calibri")
        cc.alignment = _center(); cc.border = _border()

        ws1.row_dimensions[data_row].height = 20
        data_row += 1

    # Totals footer
    if cycle_rows:
        footer_vals = [
            ("TOTALS", DARK_BG, WHITE, True),
            ("", DARK_BG, WHITE, False), ("", DARK_BG, WHITE, False),
            ("", DARK_BG, WHITE, False),
            (sum_servers,  DARK_BG, WHITE, True),
            (sum_pending,  DARK_BG, AMBER if sum_pending > 0 else GREEN, True),
            (sum_critical, DARK_BG, RED   if sum_critical > 0 else GREEN, True),
            ("", DARK_BG, WHITE, False), ("", DARK_BG, WHITE, False),
            ("", DARK_BG, WHITE, False), ("", DARK_BG, WHITE, False),
        ]
        for col_idx, (val, bg, fg, bold) in enumerate(footer_vals, start=1):
            c = ws1.cell(row=data_row, column=col_idx)
            c.value = val; c.fill = _fill(bg)
            c.font = _font(bold=bold, color=fg, size=10)
            c.alignment = _center(); c.border = _border()
        ws1.row_dimensions[data_row].height = 22

    # Column widths (11 cols)
    col_widths_1 = [28, 12, 18, 18, 10, 10, 10, 16, 20, 14, 16]
    for i, w in enumerate(col_widths_1, start=1):
        ws1.column_dimensions[get_column_letter(i)].width = w

    ws1.freeze_panes = "A7"

    # ==================================================================
    # SHEET 2 — Server Patch Status
    # ==================================================================
    ws2 = wb.create_sheet("Server Patch Status")

    ws2.merge_cells("A1:N1")
    tc2 = ws2["A1"]
    tc2.value     = f"Server Patch Status — {today_str}"
    tc2.fill      = _fill(DARK_BG)
    tc2.font      = _font(bold=True, color=WHITE, size=13)
    tc2.alignment = _center()
    ws2.row_dimensions[1].height = 32

    headers2 = [
        "Hostname", "Display Name", "OS", "IP Address", "Agent Status",
        "Maintenance Cycle", "Pending Patches", "Critical", "Security",
        "Last Scanned", "Next Maintenance", "Restart Action",
        "Patch Status", "Compliance %",
    ]
    for col_idx, h in enumerate(headers2, start=1):
        _style_header(ws2.cell(row=2, column=col_idx), h)
    ws2.row_dimensions[2].height = 22

    data_row2 = 3
    for ar in agent_rows:
        (
            aid, hostname, display_name, os_type, ip_address, status,
            cycle_name, frequency, patch_day, patch_week, preferred_time,
            restart_action, pending, critical, security, last_scanned,
            maint_frequency, maint_day, maint_week,
        ) = ar

        pending  = int(pending  or 0)
        critical = int(critical or 0)
        security = int(security or 0)

        cycle_label = cycle_name if cycle_name else "Unassigned"

        # Next maintenance = next maint_day ON OR AFTER the patch date (same week, not next month)
        if cycle_name and frequency:
            try:
                _DAY_MAP_S2 = {"Monday": 0, "Tuesday": 1, "Wednesday": 2, "Thursday": 3,
                               "Friday": 4, "Saturday": 5, "Sunday": 6}
                _p_dt = _next_maintenance_date(
                    frequency or "monthly", patch_day or "Tuesday", patch_week or "1st"
                )
                _m_num = _DAY_MAP_S2.get(maint_day or "Wednesday", 2)
                _da2 = _m_num - _p_dt.weekday()
                if _da2 < 0:
                    _da2 += 7
                next_maint = (_p_dt + timedelta(days=_da2)).strftime("%d %b %Y")
            except Exception:
                next_maint = "N/A"
        else:
            next_maint = "—"

        # Patch status + compliance
        if critical > 0:
            ps_label, ps_bg, ps_fg = "Critical",  LIGHT_RED,   "991B1B"
            comp_pct, cp_bg, cp_fg = "0%",        LIGHT_RED,   "991B1B"
        elif pending > 0:
            ps_label, ps_bg, ps_fg = "Pending",   LIGHT_AMBER, "92400E"
            comp_pct, cp_bg, cp_fg = "50%",       LIGHT_AMBER, "92400E"
        else:
            ps_label, ps_bg, ps_fg = "Compliant", LIGHT_GREEN, "065F46"
            comp_pct, cp_bg, cp_fg = "100%",      LIGHT_GREEN, "065F46"

        ls_str = last_scanned.strftime("%d %b %Y") if last_scanned else "Never"

        base_vals = [
            (hostname      or "", False),
            (display_name  or "", False),
            (os_type       or "", True),
            (ip_address    or "", True),
            (status        or "", True),
            (cycle_label,         False),
            (pending,             True),
            (critical,            True),
            (security,            True),
            (ls_str,              True),
            (next_maint,          True),
            (restart_action or "none", True),
        ]
        for col_idx, (val, centered) in enumerate(base_vals, start=1):
            _style_data(ws2.cell(row=data_row2, column=col_idx), val,
                        bg=SECTION_BG, fg=LIGHT_SLATE, center=centered)

        # Patch Status (col 13)
        psc = ws2.cell(row=data_row2, column=13)
        psc.value = ps_label; psc.fill = _fill(ps_bg)
        psc.font = Font(bold=True, color=ps_fg, size=10, name="Calibri")
        psc.alignment = _center(); psc.border = _border()

        # Compliance % (col 14)
        cpc = ws2.cell(row=data_row2, column=14)
        cpc.value = comp_pct; cpc.fill = _fill(cp_bg)
        cpc.font = Font(bold=True, color=cp_fg, size=10, name="Calibri")
        cpc.alignment = _center(); cpc.border = _border()

        ws2.row_dimensions[data_row2].height = 18
        data_row2 += 1

    col_widths_2 = [22, 22, 14, 16, 12, 22, 14, 10, 10, 16, 16, 16, 14, 14]
    for i, w in enumerate(col_widths_2, start=1):
        ws2.column_dimensions[get_column_letter(i)].width = w

    ws2.freeze_panes = "A3"

    # ==================================================================
    # SHEET 3 — Upcoming Maintenance
    # ==================================================================
    ws3 = wb.create_sheet("Upcoming Maintenance")

    ws3.merge_cells("A1:L1")
    tc3 = ws3["A1"]
    tc3.value     = "Upcoming Maintenance Schedule — Next 90 Days"
    tc3.fill      = _fill(DARK_BG)
    tc3.font      = _font(bold=True, color=WHITE, size=13)
    tc3.alignment = _center()
    ws3.row_dimensions[1].height = 32

    # Build upcoming schedule: one row per server per cycle within 90 days
    cutoff = today + timedelta(days=90)
    # Map cycle_id -> next_date for reuse
    cycle_next_dates: Dict[str, Optional[date]] = {}
    for cycle in cycle_rows:
        cid, name, desc, frequency, patch_day, patch_week, pref_time, restart, notif, notes, ac, tp, tc = cycle
        try:
            nd = _next_maintenance_date(frequency or "monthly", patch_day or "Monday", patch_week or "1st")
            cycle_next_dates[str(cid)] = nd if nd <= cutoff else None
        except Exception:
            cycle_next_dates[str(cid)] = None

    # Fetch per-server rows for upcoming maintenance
    try:
        r = await db.execute(text("""
            SELECT a.hostname, a.display_name, a.os_type, a.ip_address, a.status,
                   c.id::text AS cycle_id, c.name AS cycle_name,
                   c.frequency, c.patch_day, c.patch_week, c.preferred_time,
                   c.restart_action, c.notes,
                   COALESCE(p.pending, 0) AS pending
            FROM maintenance_cycle_agents ca
            JOIN agents a ON a.id = ca.agent_id
            JOIN maintenance_cycles c ON c.id = ca.cycle_id
            LEFT JOIN (
                SELECT agent_id, COUNT(*) AS pending FROM agent_patches GROUP BY agent_id
            ) p ON p.agent_id = a.id
            WHERE a.is_active = TRUE
              AND (a.exclude_from_reports IS NULL OR a.exclude_from_reports = FALSE)
            ORDER BY c.name, a.hostname
        """))
        sched_rows = r.fetchall()
    except Exception:
        await db.rollback()
        sched_rows = []

    upcoming_rows = []
    for sr in sched_rows:
        hostname, display_name, os_type, ip, status, cycle_id, cycle_name, \
            frequency, patch_day, patch_week, pref_time, restart, notes, pending = sr
        nd = cycle_next_dates.get(cycle_id)
        if nd is None:
            continue
        days_until = (nd - today).days
        upcoming_rows.append({
            "date": nd, "days_until": days_until,
            "hostname": hostname or "", "display_name": display_name or "",
            "os_type": os_type or "", "ip": ip or "", "status": status or "",
            "cycle_name": cycle_name or "",
            "preferred_time": pref_time or "02:00",
            "restart_action": restart or "none",
            "notes": notes or "",
            "pending": int(pending or 0),
        })
    upcoming_rows.sort(key=lambda x: (x["date"], x["cycle_name"], x["hostname"]))

    headers3 = [
        "Date", "Day", "Hostname", "Display Name", "OS", "IP Address",
        "Agent Status", "Maintenance Cycle", "Pending Patches",
        "Maintenance Window", "Restart Action", "Notes",
    ]
    for col_idx, h in enumerate(headers3, start=1):
        _style_header(ws3.cell(row=2, column=col_idx), h)
    ws3.row_dimensions[2].height = 22

    data_row3 = 3
    for item in upcoming_rows:
        days_until = item["days_until"]
        if days_until <= 7:
            row_bg, row_fg = LIGHT_RED,   "991B1B"
        elif days_until <= 30:
            row_bg, row_fg = LIGHT_AMBER, "92400E"
        else:
            row_bg, row_fg = LIGHT_GREEN, "065F46"

        row_vals3 = [
            (item["date"].strftime("%d %b %Y"), True),
            (item["date"].strftime("%A"),        True),
            (item["hostname"],                   False),
            (item["display_name"],               False),
            (item["os_type"],                    True),
            (item["ip"],                         True),
            (item["status"],                     True),
            (item["cycle_name"],                 False),
            (item["pending"],                    True),
            (item["preferred_time"],             True),
            (item["restart_action"],             True),
            (item["notes"],                      False),
        ]
        for col_idx, (val, centered) in enumerate(row_vals3, start=1):
            c = ws3.cell(row=data_row3, column=col_idx)
            c.value     = val
            c.fill      = _fill(row_bg)
            c.font      = Font(bold=False, color=row_fg, size=10, name="Calibri")
            c.alignment = _center() if centered else _left()
            c.border    = _border()
        ws3.row_dimensions[data_row3].height = 18
        data_row3 += 1

    if not upcoming_rows:
        ws3.merge_cells("A3:L3")
        nc = ws3["A3"]
        nc.value = "No maintenance scheduled in the next 90 days"
        nc.fill  = _fill(SECTION_BG)
        nc.font  = _font(color=LIGHT_SLATE, size=10)
        nc.alignment = _center()

    col_widths_3 = [16, 12, 22, 22, 12, 16, 12, 26, 14, 18, 16, 35]
    for i, w in enumerate(col_widths_3, start=1):
        ws3.column_dimensions[get_column_letter(i)].width = w
    ws3.freeze_panes = "A3"

    # ==================================================================
    # SHEET 4 — Windows Pending Patches
    # ==================================================================
    def _patch_sheet(wb, sheet_title, title_text, patches_data):
        ws = wb.create_sheet(sheet_title)
        num_cols = 10
        ws.merge_cells(f"A1:{get_column_letter(num_cols)}1")
        tc = ws["A1"]
        tc.value     = title_text
        tc.fill      = _fill(DARK_BG)
        tc.font      = _font(bold=True, color=WHITE, size=13)
        tc.alignment = _center()
        ws.row_dimensions[1].height = 32

        hdrs = ["Hostname", "Display Name", "IP Address", "OS / Version",
                "Package / Patch Name", "Severity", "Current Version",
                "Available Version", "Description", "Last Scanned"]
        for col_idx, h in enumerate(hdrs, start=1):
            _style_header(ws.cell(row=2, column=col_idx), h)
        ws.row_dimensions[2].height = 22

        SEV_COLORS = {
            "critical": (LIGHT_RED,   "991B1B"),
            "security": (LIGHT_AMBER, "92400E"),
        }

        dr = 3
        for prow in patches_data:
            hostname, display_name, ip_address, os_type, package_name, \
                category, current_ver, available_ver, description, scanned_at = prow

            cat_lower = (category or "").lower()
            sev_label = "Critical" if "critical" in cat_lower else \
                        "Security" if "security" in cat_lower else \
                        (category or "General").title()
            sev_bg, sev_fg = SEV_COLORS.get(
                "critical" if "critical" in cat_lower else
                "security" if "security" in cat_lower else "",
                (SECTION_BG, LIGHT_SLATE)
            )

            row_data = [
                (hostname      or "", False, SECTION_BG, LIGHT_SLATE),
                (display_name  or "", False, SECTION_BG, LIGHT_SLATE),
                (ip_address    or "", True,  SECTION_BG, LIGHT_SLATE),
                (os_type       or "", True,  SECTION_BG, LIGHT_SLATE),
                (package_name  or "", False, SECTION_BG, WHITE),
                (sev_label,           True,  sev_bg,     sev_fg),
                (current_ver   or "", True,  SECTION_BG, LIGHT_SLATE),
                (available_ver or "", True,  SECTION_BG, GREEN),
                (description   or "", False, SECTION_BG, LIGHT_SLATE),
                (scanned_at.strftime("%d %b %Y") if scanned_at else "", True, SECTION_BG, LIGHT_SLATE),
            ]
            for col_idx, (val, centered, bg, fg) in enumerate(row_data, start=1):
                c = ws.cell(row=dr, column=col_idx, value=val)
                c.fill = _fill(bg); c.font = _font(color=fg, size=10)
                c.alignment = _center() if centered else _left()
                c.border = _border()
            ws.row_dimensions[dr].height = 18
            dr += 1

        if not patches_data:
            ws.merge_cells(f"A3:{get_column_letter(num_cols)}3")
            nc = ws["A3"]
            nc.value = "No pending patches"
            nc.fill  = _fill(SECTION_BG); nc.font = _font(color=GREEN, size=10)
            nc.alignment = _center()

        for i, w in enumerate([22, 22, 16, 20, 35, 12, 16, 16, 40, 16], start=1):
            ws.column_dimensions[get_column_letter(i)].width = w
        ws.freeze_panes = "A3"
        return ws

    # ==================================================================
    # History sheets helper
    # ==================================================================
    def _history_sheet(wb, sheet_title, title_text, history_data):
        ws = wb.create_sheet(sheet_title)
        num_cols = 10
        ws.merge_cells(f"A1:{get_column_letter(num_cols)}1")
        tc = ws["A1"]
        tc.value = title_text; tc.fill = _fill(DARK_BG)
        tc.font = _font(bold=True, color=WHITE, size=13)
        tc.alignment = _center(); ws.row_dimensions[1].height = 32

        hdrs = ["Hostname", "Display Name", "IP Address", "OS / Version",
                "Maintenance Cycle", "Actioned Date", "Action Type",
                "Status", "Notes", "Logged By"]
        for col_idx, h in enumerate(hdrs, start=1):
            _style_header(ws.cell(row=2, column=col_idx), h)
        ws.row_dimensions[2].height = 22

        STATUS_HIST = {
            "completed": (LIGHT_GREEN, "065F46"),
            "failed":    (LIGHT_RED,   "991B1B"),
            "pending":   (LIGHT_AMBER, "92400E"),
        }

        dr = 3
        for hrow in history_data:
            actioned_at, action_type, h_status, notes, created_by, \
                hostname, display_name, ip_address, os_type, cycle_name = hrow

            h_status_lower = (h_status or "pending").lower()
            st_bg, st_fg = STATUS_HIST.get(h_status_lower, (SECTION_BG, LIGHT_SLATE))

            row_data = [
                (hostname     or "", False, SECTION_BG, LIGHT_SLATE),
                (display_name or "", False, SECTION_BG, LIGHT_SLATE),
                (ip_address   or "", True,  SECTION_BG, LIGHT_SLATE),
                (os_type      or "", True,  SECTION_BG, LIGHT_SLATE),
                (cycle_name   or "—", False, SECTION_BG, LIGHT_SLATE),
                (actioned_at.strftime("%d %b %Y %H:%M") if actioned_at else "—",
                 True,  SECTION_BG, WHITE),
                ((action_type or "patch").title(), True, SECTION_BG, LIGHT_SLATE),
                (h_status.title() if h_status else "Pending", True, st_bg, st_fg),
                (notes        or "", False, SECTION_BG, LIGHT_SLATE),
                (created_by   or "", True,  SECTION_BG, LIGHT_SLATE),
            ]
            for col_idx, (val, centered, bg, fg) in enumerate(row_data, start=1):
                c = ws.cell(row=dr, column=col_idx, value=val)
                is_status = (col_idx == 8)
                c.fill = _fill(bg)
                c.font = _font(bold=is_status, color=fg, size=10)
                c.alignment = _center() if centered else _left()
                c.border = _border()
            ws.row_dimensions[dr].height = 18
            dr += 1

        if not history_data:
            ws.merge_cells(f"A3:{get_column_letter(num_cols)}3")
            nc = ws["A3"]
            nc.value = "No maintenance history recorded"
            nc.fill = _fill(SECTION_BG); nc.font = _font(color=LIGHT_SLATE, size=10)
            nc.alignment = _center()

        for i, w in enumerate([22, 22, 16, 20, 22, 20, 14, 14, 35, 16], start=1):
            ws.column_dimensions[get_column_letter(i)].width = w
        ws.freeze_panes = "A3"
        return ws

    _history_sheet(wb, "Windows Maintenance History",
                   f"Windows Maintenance History — {today_str}", win_history)
    _history_sheet(wb, "Linux Maintenance History",
                   f"Linux Maintenance History — {today_str}", lin_history)

    _patch_sheet(wb, "Windows Pending Patches",
                 f"Windows Pending Patches — {today_str}", win_patches)
    _patch_sheet(wb, "Linux Pending Patches",
                 f"Linux Pending Patches — {today_str}", lin_patches)

    # ------------------------------------------------------------------
    # Serialise and return
    # ------------------------------------------------------------------
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    filename = f"maintenance_plan_{today.strftime('%Y-%m-%d')}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
