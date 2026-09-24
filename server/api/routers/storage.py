"""Storage monitoring — latest disk metrics per agent/mountpoint."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.database import get_db
from api.services.auth import get_current_user, require_admin

router = APIRouter(prefix="/storage", tags=["Storage"])


async def _ensure_volume_settings(db: AsyncSession):
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS disk_volume_settings (
            agent_id   UUID    NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            mountpoint TEXT    NOT NULL,
            exclude_from_reports BOOLEAN NOT NULL DEFAULT FALSE,
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (agent_id, mountpoint)
        )
    """))
    await db.commit()


@router.get("/overview")
async def storage_overview(
    group_id: str = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Return latest disk usage per (agent, mountpoint) pair."""
    await _ensure_volume_settings(db)
    group_filter = "AND a.group_id = :group_id" if group_id else ""

    # Latest disk_percent, used, free, total per agent+mountpoint
    # Uses DISTINCT ON (TimescaleDB / PostgreSQL) to get most recent row per partition
    rows = await db.execute(text(f"""
        WITH latest AS (
            SELECT DISTINCT ON (agent_id, tags->>'mountpoint')
                agent_id,
                tags->>'mountpoint'  AS mountpoint,
                tags->>'device'      AS device,
                tags->>'fstype'      AS fstype,
                time                 AS last_updated
            FROM metrics
            WHERE metric_name = 'disk_percent'
              AND time > NOW() - INTERVAL '30 minutes'
            ORDER BY agent_id, tags->>'mountpoint', time DESC
        ),
        disk_pct AS (
            SELECT DISTINCT ON (agent_id, tags->>'mountpoint')
                agent_id, tags->>'mountpoint' AS mountpoint, value AS pct
            FROM metrics
            WHERE metric_name = 'disk_percent' AND time > NOW() - INTERVAL '30 minutes'
            ORDER BY agent_id, tags->>'mountpoint', time DESC
        ),
        disk_used AS (
            SELECT DISTINCT ON (agent_id, tags->>'mountpoint')
                agent_id, tags->>'mountpoint' AS mountpoint, value AS used_gb
            FROM metrics
            WHERE metric_name = 'disk_used_gb' AND time > NOW() - INTERVAL '30 minutes'
            ORDER BY agent_id, tags->>'mountpoint', time DESC
        ),
        disk_free AS (
            SELECT DISTINCT ON (agent_id, tags->>'mountpoint')
                agent_id, tags->>'mountpoint' AS mountpoint, value AS free_gb
            FROM metrics
            WHERE metric_name = 'disk_free_gb' AND time > NOW() - INTERVAL '30 minutes'
            ORDER BY agent_id, tags->>'mountpoint', time DESC
        ),
        disk_total AS (
            SELECT DISTINCT ON (agent_id, tags->>'mountpoint')
                agent_id, tags->>'mountpoint' AS mountpoint, value AS total_gb
            FROM metrics
            WHERE metric_name = 'disk_total_gb' AND time > NOW() - INTERVAL '30 minutes'
            ORDER BY agent_id, tags->>'mountpoint', time DESC
        )
        SELECT
            a.id           AS agent_id,
            a.hostname,
            a.status       AS agent_status,
            ag.name        AS group_name,
            ag.color       AS group_color,
            l.mountpoint,
            l.device,
            l.fstype,
            ROUND(dp.pct::numeric, 1)           AS disk_percent,
            ROUND(du.used_gb::numeric, 2)        AS used_gb,
            ROUND(df.free_gb::numeric, 2)        AS free_gb,
            ROUND(dt.total_gb::numeric, 2)       AS total_gb,
            l.last_updated,
            COALESCE(dvs.exclude_from_reports, FALSE) AS exclude_from_reports
        FROM latest l
        JOIN agents a ON a.id = l.agent_id
        LEFT JOIN agent_groups ag ON ag.id = a.group_id
        LEFT JOIN disk_pct   dp ON dp.agent_id = l.agent_id AND dp.mountpoint = l.mountpoint
        LEFT JOIN disk_used  du ON du.agent_id = l.agent_id AND du.mountpoint = l.mountpoint
        LEFT JOIN disk_free  df ON df.agent_id = l.agent_id AND df.mountpoint = l.mountpoint
        LEFT JOIN disk_total dt ON dt.agent_id = l.agent_id AND dt.mountpoint = l.mountpoint
        LEFT JOIN disk_volume_settings dvs
               ON dvs.agent_id = l.agent_id AND dvs.mountpoint = COALESCE(l.mountpoint, '/')
        WHERE a.is_active = TRUE {group_filter}
        ORDER BY dp.pct DESC NULLS LAST, a.hostname, l.mountpoint
    """), {"group_id": group_id} if group_id else {})

    result = []
    for row in rows.fetchall():
        result.append({
            "agent_id":            str(row[0]),
            "hostname":            row[1],
            "agent_status":        row[2],
            "group_name":          row[3],
            "group_color":         row[4],
            "mountpoint":          row[5] or "/",
            "device":              row[6],
            "fstype":              row[7],
            "disk_percent":        float(row[8]) if row[8] is not None else None,
            "used_gb":             float(row[9]) if row[9] is not None else None,
            "free_gb":             float(row[10]) if row[10] is not None else None,
            "total_gb":            float(row[11]) if row[11] is not None else None,
            "last_updated":        row[12].isoformat() if row[12] else None,
            "exclude_from_reports": bool(row[13]),
        })
    return result


@router.get("/agent/{agent_id}/excludes")
async def get_agent_excludes(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Return a dict of {mountpoint: exclude_from_reports} for a specific agent."""
    await _ensure_volume_settings(db)
    rows = await db.execute(text("""
        SELECT mountpoint, exclude_from_reports
        FROM disk_volume_settings
        WHERE agent_id = CAST(:agent_id AS uuid)
    """), {"agent_id": agent_id})
    return {r[0]: bool(r[1]) for r in rows.fetchall()}


@router.post("/agent/{agent_id}/exclude")
async def toggle_volume_exclude(
    agent_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Set or clear the exclude_from_reports flag for a specific (agent, mountpoint) volume."""
    mountpoint = body.get("mountpoint", "/")
    exclude = bool(body.get("exclude", False))

    await _ensure_volume_settings(db)

    await db.execute(text("""
        INSERT INTO disk_volume_settings (agent_id, mountpoint, exclude_from_reports, updated_at)
        VALUES (CAST(:agent_id AS uuid), :mountpoint, :exclude, NOW())
        ON CONFLICT (agent_id, mountpoint) DO UPDATE
            SET exclude_from_reports = EXCLUDED.exclude_from_reports,
                updated_at           = NOW()
    """), {"agent_id": agent_id, "mountpoint": mountpoint, "exclude": exclude})
    await db.commit()

    return {"agent_id": agent_id, "mountpoint": mountpoint, "exclude_from_reports": exclude}


@router.get("/agent/{agent_id}/history")
async def storage_agent_history(
    agent_id: str,
    mount: str = "/",
    hours: int = 24,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Time-bucketed disk_percent history for sparklines."""
    rows = await db.execute(text("""
        SELECT
            time_bucket('30 minutes', time) AS bucket,
            ROUND(AVG(value)::numeric, 1)   AS avg_pct
        FROM metrics
        WHERE agent_id   = :aid
          AND metric_name = 'disk_percent'
          AND tags->>'mountpoint' = :mount
          AND time > NOW() - make_interval(hours => :hours)
        GROUP BY bucket
        ORDER BY bucket ASC
    """), {"aid": agent_id, "mount": mount, "hours": hours})

    return [{"time": r[0].isoformat(), "pct": float(r[1])} for r in rows.fetchall()]


@router.get("/summary")
async def storage_summary(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Counts for the summary cards."""
    row = await db.execute(text("""
        WITH latest_pct AS (
            SELECT DISTINCT ON (agent_id, tags->>'mountpoint')
                value AS pct
            FROM metrics
            WHERE metric_name = 'disk_percent'
              AND time > NOW() - INTERVAL '30 minutes'
            ORDER BY agent_id, tags->>'mountpoint', time DESC
        )
        SELECT
            COUNT(*)                                       AS total_volumes,
            COUNT(*) FILTER (WHERE pct >= 90)              AS critical,
            COUNT(*) FILTER (WHERE pct >= 80 AND pct < 90) AS warning,
            COUNT(*) FILTER (WHERE pct < 80)               AS healthy
        FROM latest_pct
    """))
    r = row.fetchone()
    return {
        "total_volumes": int(r[0] or 0),
        "critical":      int(r[1] or 0),
        "warning":       int(r[2] or 0),
        "healthy":       int(r[3] or 0),
    }
