from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from datetime import datetime, timezone, timedelta
from typing import Optional

from api.database import get_db
from api.models.models import ScheduledReport
from api.services.auth import get_current_user

router = APIRouter(prefix="/report-schedules", tags=["Report Schedules"])


def _next_run(schedule: ScheduledReport) -> Optional[datetime]:
    """Calculate the next run time from now."""
    now = datetime.now(timezone.utc)
    h, m = schedule.hour, schedule.minute

    if schedule.frequency == "daily":
        candidate = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if candidate <= now:
            candidate += timedelta(days=1)
        return candidate

    if schedule.frequency == "weekly":
        dow = schedule.day_of_week or 0  # 0=Mon
        days_ahead = (dow - now.weekday()) % 7
        candidate = (now + timedelta(days=days_ahead)).replace(
            hour=h, minute=m, second=0, microsecond=0
        )
        if candidate <= now:
            candidate += timedelta(weeks=1)
        return candidate

    if schedule.frequency == "monthly":
        dom = schedule.day_of_month or 1
        try:
            candidate = now.replace(day=dom, hour=h, minute=m, second=0, microsecond=0)
        except ValueError:
            candidate = now.replace(day=28, hour=h, minute=m, second=0, microsecond=0)
        if candidate <= now:
            # Move to next month
            if now.month == 12:
                candidate = candidate.replace(year=now.year + 1, month=1)
            else:
                candidate = candidate.replace(month=now.month + 1)
        return candidate

    return None


@router.get("")
async def list_schedules(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(
        select(ScheduledReport).order_by(ScheduledReport.created_at.desc())
    )
    return [_dict(s) for s in result.scalars().all()]


@router.post("", status_code=201)
async def create_schedule(
    body: dict,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    s = ScheduledReport(
        name=body["name"],
        report_type=body.get("report_type", "agents"),
        format=body.get("format", "pdf"),
        frequency=body.get("frequency", "daily"),
        hour=int(body.get("hour", 8)),
        minute=int(body.get("minute", 0)),
        day_of_week=body.get("day_of_week"),
        day_of_month=body.get("day_of_month"),
        email_to=body.get("email_to", []),
        channel_ids=body.get("channel_ids", []),
        status_filter=body.get("status_filter", "all"),
        is_active=body.get("is_active", True),
    )
    s.next_run = _next_run(s)
    db.add(s)
    await db.commit()
    await db.refresh(s)
    return _dict(s)


@router.put("/{schedule_id}")
async def update_schedule(
    schedule_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    result = await db.execute(
        select(ScheduledReport).where(ScheduledReport.id == schedule_id)
    )
    s = result.scalar_one_or_none()
    if not s:
        raise HTTPException(404, "Schedule not found")

    for field in ["name", "report_type", "format", "frequency", "hour", "minute",
                  "day_of_week", "day_of_month", "email_to", "channel_ids",
                  "status_filter", "is_active"]:
        if field in body:
            setattr(s, field, body[field])

    s.next_run = _next_run(s)
    await db.commit()
    return _dict(s)


@router.delete("/{schedule_id}", status_code=204)
async def delete_schedule(
    schedule_id: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    result = await db.execute(
        select(ScheduledReport).where(ScheduledReport.id == schedule_id)
    )
    s = result.scalar_one_or_none()
    if not s:
        raise HTTPException(404, "Schedule not found")
    await db.delete(s)
    await db.commit()


@router.post("/{schedule_id}/run-now")
async def run_now(
    schedule_id: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Trigger an immediate run of this schedule (fires Celery task)."""
    result = await db.execute(
        select(ScheduledReport).where(ScheduledReport.id == schedule_id)
    )
    s = result.scalar_one_or_none()
    if not s:
        raise HTTPException(404, "Schedule not found")

    from api.workers.tasks import run_scheduled_report
    run_scheduled_report.delay(str(s.id))
    return {"queued": True}


# ── Internal endpoint called by Celery ────────────────────────────────────────

@router.post("/internal/run-due", include_in_schema=False)
async def run_due_schedules(db: AsyncSession = Depends(get_db)):
    """Find all due schedules and queue them."""
    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(ScheduledReport).where(
            ScheduledReport.is_active == True,
            ScheduledReport.next_run <= now,
        )
    )
    due = result.scalars().all()

    queued = 0
    from api.workers.tasks import run_scheduled_report
    for s in due:
        run_scheduled_report.delay(str(s.id))
        s.last_run = now
        s.next_run = _next_run(s)
        queued += 1

    await db.commit()
    return {"queued": queued}


def _dict(s: ScheduledReport) -> dict:
    return {
        "id": str(s.id),
        "name": s.name,
        "report_type": s.report_type,
        "format": s.format,
        "frequency": s.frequency,
        "hour": s.hour,
        "minute": s.minute,
        "day_of_week": s.day_of_week,
        "day_of_month": s.day_of_month,
        "email_to": s.email_to or [],
        "channel_ids": s.channel_ids or [],
        "status_filter": s.status_filter,
        "is_active": s.is_active,
        "last_run": s.last_run.isoformat() if s.last_run else None,
        "next_run": s.next_run.isoformat() if s.next_run else None,
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }


# ── Weekly Health Report endpoints ────────────────────────────────────────────

@router.get("/weekly-health-report/config")
async def get_weekly_report_config(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Get weekly health report recipients."""
    from sqlalchemy import text
    import json
    r = await db.execute(text("SELECT value FROM system_settings WHERE key = 'weekly_report_recipients'"))
    row = r.fetchone()
    recipients = []
    if row and row[0]:
        val = row[0]
        if isinstance(val, str):
            try: val = json.loads(val)
            except Exception: pass
        if isinstance(val, list):
            recipients = val
    return {"recipients": recipients, "schedule": "Every Monday at 08:00 EAT"}


@router.put("/weekly-health-report/config")
async def update_weekly_report_config(body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Set weekly health report recipients."""
    from sqlalchemy import text
    import json
    recipients = body.get("recipients", [])
    if not isinstance(recipients, list):
        raise HTTPException(400, "recipients must be a list of email addresses")
    import json
    val = json.dumps(recipients)
    await db.execute(text("""
        INSERT INTO system_settings (key, value) VALUES ('weekly_report_recipients', CAST(:v AS jsonb))
        ON CONFLICT (key) DO UPDATE SET value = CAST(EXCLUDED.value AS jsonb)
    """), {"v": val})
    await db.commit()
    return {"recipients": recipients}


@router.post("/weekly-health-report/send-now")
async def trigger_weekly_report_now(_=Depends(get_current_user)):
    """Trigger the weekly health report immediately."""
    from api.workers.tasks import send_weekly_health_report
    task = send_weekly_health_report.delay()
    return {"status": "queued", "task_id": task.id}


@router.get("/weekly-health-report/preview")
async def preview_weekly_report(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Return the report data as JSON for preview (no email sent)."""
    import psycopg2, os
    from api.workers.weekly_report import collect_report_data
    # Use a dedicated sync psycopg2 connection — collect_report_data is sync
    # and uses only psycopg2 SQL (no asyncio.run), so this is safe in async context
    sync_url = os.getenv("SYNC_DATABASE_URL", "")
    conn = psycopg2.connect(sync_url)
    conn.autocommit = True
    cur = conn.cursor()
    try:
        import datetime
        today = datetime.date.today()
        week_start = today - datetime.timedelta(days=today.weekday())
        data = collect_report_data(cur)
        return {
            "period": f"{data['week_start'].strftime('%d %b %Y')} – {data['week_end'].strftime('%d %b %Y')}",
            "summary": data["summary"],
            "compliance": data["compliance"],
            "patch_summary": data["patch_summary"],
            "agent_count": len(data["agents"]),
            "alert_count": len(data["alerts"]),
            "risk_count": len(data["risks"]),
        }
    except Exception as e:
        raise HTTPException(500, f"Preview failed: {e}")
    finally:
        try: cur.close(); conn.close()
        except Exception: pass
