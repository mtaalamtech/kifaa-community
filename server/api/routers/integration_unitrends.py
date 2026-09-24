"""
Unitrends integration data router.
Returns cached data from the unitrends_* tables (populated by sync task).
"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.database import get_db
from api.services.auth import get_current_user

router = APIRouter(prefix="/integrations/unitrends", tags=["Integrations - Unitrends"])


@router.get("/dashboard")
async def unitrends_dashboard(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Summary stats for the Unitrends dashboard."""
    # Plugin status
    plugin = await db.execute(text("""
        SELECT status, last_sync_at, last_error, is_enabled
        FROM integration_plugins WHERE plugin_type = 'unitrends'
    """))
    p = plugin.fetchone()

    # Backup stats (last 24h)
    stats = await db.execute(text("""
        SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status = 'success') AS success_count,
            COUNT(*) FILTER (WHERE status = 'failure') AS failure_count,
            COUNT(*) FILTER (WHERE status = 'warning') AS warning_count,
            COUNT(*) FILTER (WHERE status = 'active') AS active_count,
            SUM(size_bytes) AS total_bytes
        FROM unitrends_backups
        WHERE start_time > NOW() - INTERVAL '24 hours'
    """))
    s = stats.fetchone()

    # All-time backup stats for success rate
    all_stats = await db.execute(text("""
        SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status = 'success') AS success_count
        FROM unitrends_backups
        WHERE start_time > NOW() - INTERVAL '7 days'
    """))
    a = all_stats.fetchone()

    success_rate = 0
    if a.total and a.total > 0:
        success_rate = round((a.success_count / a.total) * 100, 1)

    # Alert count
    alert_count = await db.execute(text("""
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE severity = 'critical') AS critical_count
        FROM unitrends_alerts WHERE acknowledged = FALSE
    """))
    ac = alert_count.fetchone()

    # Storage summary
    storage = await db.execute(text("""
        SELECT SUM(total_bytes) AS total, SUM(used_bytes) AS used, SUM(free_bytes) AS free
        FROM unitrends_storage
        WHERE synced_at = (SELECT MAX(synced_at) FROM unitrends_storage)
    """))
    st = storage.fetchone()
    storage_pct = 0
    if st.total and st.total > 0:
        storage_pct = round((st.used / st.total) * 100, 1)

    # Client count
    client_count = await db.execute(text("""
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE status = 'online') AS online_count
        FROM unitrends_clients
    """))
    cc = client_count.fetchone()

    return {
        "plugin": {
            "status": p.status if p else "disconnected",
            "is_enabled": p.is_enabled if p else False,
            "last_sync_at": p.last_sync_at.isoformat() if p and p.last_sync_at else None,
            "last_error": p.last_error if p else None,
        },
        "backups_24h": {
            "total": s.total or 0,
            "success": s.success_count or 0,
            "failed": s.failure_count or 0,
            "warning": s.warning_count or 0,
            "active": s.active_count or 0,
            "total_bytes": s.total_bytes or 0,
        },
        "success_rate_7d": success_rate,
        "alerts": {
            "total": ac.total or 0,
            "critical": ac.critical_count or 0,
        },
        "storage": {
            "total_bytes": st.total or 0,
            "used_bytes": st.used or 0,
            "free_bytes": st.free or 0,
            "usage_pct": storage_pct,
        },
        "clients": {
            "total": cc.total or 0,
            "online": cc.online_count or 0,
        },
    }


@router.get("/backups")
async def list_backups(
    status: str = None,
    client: str = None,
    days: int = Query(default=7, ge=1, le=90),
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    filters = ["start_time > NOW() - INTERVAL '1 day' * :days"]
    params: dict = {"days": days, "limit": limit}
    if status:
        filters.append("status = :status")
        params["status"] = status
    if client:
        filters.append("client_name ILIKE :client")
        params["client"] = f"%{client}%"

    where = " AND ".join(filters)
    rows = await db.execute(text(f"""
        SELECT backup_id, client_name, instance_name, backup_type, status,
               start_time, end_time, size_bytes, message
        FROM unitrends_backups
        WHERE {where}
        ORDER BY start_time DESC
        LIMIT :limit
    """), params)
    return [
        {
            "backup_id": r.backup_id,
            "client_name": r.client_name,
            "instance_name": r.instance_name,
            "backup_type": r.backup_type,
            "status": r.status,
            "start_time": r.start_time.isoformat() if r.start_time else None,
            "end_time": r.end_time.isoformat() if r.end_time else None,
            "size_bytes": r.size_bytes,
            "message": r.message,
            "duration_seconds": (
                int((r.end_time - r.start_time).total_seconds())
                if r.end_time and r.start_time else None
            ),
        }
        for r in rows.fetchall()
    ]


@router.get("/clients")
async def list_clients(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    rows = await db.execute(text("""
        SELECT client_id, client_name, os, ip_address, status, last_backup, total_backups
        FROM unitrends_clients
        ORDER BY client_name
    """))
    return [
        {
            "client_id": r.client_id,
            "client_name": r.client_name,
            "os": r.os,
            "ip_address": r.ip_address,
            "status": r.status,
            "last_backup": r.last_backup.isoformat() if r.last_backup else None,
            "total_backups": r.total_backups,
        }
        for r in rows.fetchall()
    ]


@router.get("/alerts")
async def list_alerts(
    unacknowledged_only: bool = True,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    where = "WHERE acknowledged = FALSE" if unacknowledged_only else ""
    rows = await db.execute(text(f"""
        SELECT alert_id, severity, message, alert_time, acknowledged
        FROM unitrends_alerts
        {where}
        ORDER BY alert_time DESC NULLS LAST
        LIMIT 100
    """))
    return [
        {
            "alert_id": r.alert_id,
            "severity": r.severity,
            "message": r.message,
            "alert_time": r.alert_time.isoformat() if r.alert_time else None,
            "acknowledged": r.acknowledged,
        }
        for r in rows.fetchall()
    ]


@router.get("/storage")
async def list_storage(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    rows = await db.execute(text("""
        SELECT device_name, total_bytes, used_bytes, free_bytes, usage_pct, synced_at
        FROM unitrends_storage
        WHERE synced_at = (SELECT MAX(synced_at) FROM unitrends_storage)
        ORDER BY device_name
    """))
    return [
        {
            "device_name": r.device_name,
            "total_bytes": r.total_bytes,
            "used_bytes": r.used_bytes,
            "free_bytes": r.free_bytes,
            "usage_pct": float(r.usage_pct) if r.usage_pct else 0,
            "synced_at": r.synced_at.isoformat() if r.synced_at else None,
        }
        for r in rows.fetchall()
    ]
