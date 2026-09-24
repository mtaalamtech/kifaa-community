"""
Quarterly Security Committee Report router.
Provides scorecard metrics, audit findings, security incidents, SLA config, and XLSX export.
"""
from __future__ import annotations

import io
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.database import get_db
from api.services.auth import get_current_user, require_admin

router = APIRouter(prefix="/quarterly", tags=["quarterly"])

# ---------------------------------------------------------------------------
# Table bootstrap
# ---------------------------------------------------------------------------
_TABLES_CREATED = False


async def _ensure_tables(db: AsyncSession) -> None:
    global _TABLES_CREATED
    if _TABLES_CREATED:
        return
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS security_incidents (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            title TEXT NOT NULL,
            description TEXT,
            severity TEXT NOT NULL DEFAULT 'medium',
            status TEXT NOT NULL DEFAULT 'open',
            detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            contained_at TIMESTAMPTZ,
            resolved_at TIMESTAMPTZ,
            reporter TEXT,
            notes TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS audit_findings (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            title TEXT NOT NULL,
            observation TEXT,
            source TEXT NOT NULL DEFAULT 'internal',
            area TEXT DEFAULT 'Other',
            year INT NOT NULL,
            due_date DATE,
            status TEXT NOT NULL DEFAULT 'pending',
            reason TEXT,
            risk_rating TEXT DEFAULT 'medium',
            risk_implication TEXT,
            recommendation TEXT,
            prev_management_comments TEXT,
            current_management_comments TEXT,
            rating_color TEXT,
            individual_responsible TEXT,
            implementation TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            closed_at TIMESTAMPTZ
        )
    """))
    # Rename old columns to new names (safe — fails silently if already renamed)
    for old_col, new_col in [
        ("description", "observation"),
        ("category", "area"),
        ("priority", "risk_rating"),
    ]:
        try:
            await db.execute(text(
                f"ALTER TABLE audit_findings RENAME COLUMN {old_col} TO {new_col}"
            ))
            await db.commit()
        except Exception:
            await db.rollback()
    # Add new columns that may not exist yet
    for col, defn in [
        ("risk_implication", "TEXT"),
        ("recommendation", "TEXT"),
        ("prev_management_comments", "TEXT"),
        ("current_management_comments", "TEXT"),
        ("rating_color", "TEXT"),
        ("individual_responsible", "TEXT"),
        ("implementation", "TEXT"),
        ("observation", "TEXT"),
        ("area", "TEXT"),
        ("risk_rating", "TEXT"),
    ]:
        try:
            await db.execute(text(f"ALTER TABLE audit_findings ADD COLUMN IF NOT EXISTS {col} {defn}"))
        except Exception:
            await db.rollback()
    for old_col in ["quarter", "auditor", "action_taken"]:
        try:
            await db.execute(text(f"ALTER TABLE audit_findings DROP COLUMN IF EXISTS {old_col}"))
        except Exception:
            await db.rollback()
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS audit_categories (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            name TEXT NOT NULL UNIQUE,
            description TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        INSERT INTO audit_categories (name) VALUES
            ('Patch Management'),('Vulnerability Management'),('Access Control'),
            ('Configuration'),('Process / Policy'),('Network Security'),
            ('Data Protection'),('Physical Security'),('Other')
        ON CONFLICT (name) DO NOTHING
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS quarterly_sla_config (
            severity TEXT PRIMARY KEY,
            contain_hours INT NOT NULL DEFAULT 24,
            resolve_hours INT NOT NULL DEFAULT 72,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        INSERT INTO quarterly_sla_config (severity, contain_hours, resolve_hours)
        VALUES
            ('critical', 4,  24),
            ('high',     8,  48),
            ('medium',   24, 72),
            ('low',      72, 168)
        ON CONFLICT (severity) DO NOTHING
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS quarterly_snapshots (
            quarter          INT  NOT NULL,
            year             INT  NOT NULL,
            -- Patch compliance
            patch_total      INT,
            patch_compliant  INT,
            patch_pct        NUMERIC(5,1),
            -- Endpoint protection
            ep_total         INT,
            ep_av_pass       INT,
            ep_av_pct        NUMERIC(5,1),
            ep_threat_free   INT,
            ep_threat_pct    NUMERIC(5,1),
            -- Metadata
            snapshot_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            snapshot_by      TEXT,
            PRIMARY KEY (quarter, year)
        )
    """))
    await db.commit()
    _TABLES_CREATED = True


# ---------------------------------------------------------------------------
# Quarter date helpers
# ---------------------------------------------------------------------------
def _quarter_dates(quarter: int, year: int):
    """Return (start_date, end_date) as date objects for the given quarter."""
    starts = {1: (1, 1), 2: (4, 1), 3: (7, 1), 4: (10, 1)}
    ends   = {1: (3, 31), 2: (6, 30), 3: (9, 30), 4: (12, 31)}
    sm, sd = starts[quarter]
    em, ed = ends[quarter]
    return date(year, sm, sd), date(year, em, ed)


# ---------------------------------------------------------------------------
# Helper: compute live patch + endpoint metrics
# ---------------------------------------------------------------------------
async def _compute_live_patch_endpoint(db: AsyncSession) -> tuple:
    """Returns (patch_dict, endpoint_dict) from the live tables."""
    # Patch
    r = await db.execute(text("""
        SELECT COUNT(*) FROM agents
        WHERE is_active = TRUE AND (exclude_from_reports IS NULL OR exclude_from_reports = FALSE)
    """))
    total_agents = r.scalar() or 0

    r = await db.execute(text("""
        SELECT COUNT(DISTINCT a.id)
        FROM agents a
        WHERE a.is_active = TRUE
          AND (a.exclude_from_reports IS NULL OR a.exclude_from_reports = FALSE)
          AND a.id NOT IN (
              SELECT DISTINCT agent_id FROM agent_patches
              WHERE LOWER(category) LIKE '%security%'
          )
    """))
    compliant_agents = r.scalar() or 0
    compliant_pct = round((compliant_agents / total_agents * 100), 1) if total_agents > 0 else 0.0
    patch = {
        "compliant_pct": compliant_pct,
        "total_agents": total_agents,
        "compliant_agents": compliant_agents,
        "target": 95,
        "live": True,
    }

    # Endpoint
    r = await db.execute(text("""
        SELECT
            COUNT(a.id)                                                               AS total,
            COUNT(CASE WHEN s.av_running = TRUE THEN 1 END)                           AS av_pass,
            COUNT(CASE WHEN s.av_running = TRUE AND s.av_installed = TRUE THEN 1 END) AS threat_free
        FROM agents a
        LEFT JOIN agent_security_state s ON s.agent_id = a.id
        WHERE a.is_active = TRUE
          AND (a.exclude_from_reports IS NULL OR a.exclude_from_reports = FALSE)
    """))
    row = r.fetchone()
    ep_total       = row[0] or 0
    ep_av_pass     = row[1] or 0
    ep_threat_free = row[2] or 0
    av_pct         = round(ep_av_pass / ep_total * 100, 1) if ep_total > 0 else 0.0
    threat_pct     = round(ep_threat_free / ep_total * 100, 1) if ep_total > 0 else 0.0
    endpoint = {
        "av_pct": av_pct,
        "threat_free_pct": threat_pct,
        "total": ep_total,
        "av_pass": ep_av_pass,
        "target": 100,
        "live": True,
    }
    return patch, endpoint


def _current_quarter_of(dt: date) -> tuple:
    """Return (quarter, year) for the given date."""
    m = dt.month
    q = (m - 1) // 3 + 1
    return q, dt.year


# ---------------------------------------------------------------------------
# POST /quarterly/snapshot  — save current live state for a quarter
# ---------------------------------------------------------------------------
@router.post("/snapshot")
async def save_snapshot(
    quarter: int = Query(..., ge=1, le=4),
    year: int    = Query(..., ge=2000, le=2100),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    try:
        patch, endpoint = await _compute_live_patch_endpoint(db)
    except Exception as exc:
        await db.rollback()
        raise HTTPException(500, detail=f"Failed to compute metrics: {exc}")

    username = getattr(_user, "username", None) or getattr(_user, "sub", None) or "system"
    await db.execute(text("""
        INSERT INTO quarterly_snapshots
            (quarter, year, patch_total, patch_compliant, patch_pct,
             ep_total, ep_av_pass, ep_av_pct, ep_threat_free, ep_threat_pct,
             snapshot_at, snapshot_by)
        VALUES
            (:q, :y, :pt, :pc, :pp, :et, :ea, :eap, :etf, :etp, NOW(), :by)
        ON CONFLICT (quarter, year) DO UPDATE SET
            patch_total     = EXCLUDED.patch_total,
            patch_compliant = EXCLUDED.patch_compliant,
            patch_pct       = EXCLUDED.patch_pct,
            ep_total        = EXCLUDED.ep_total,
            ep_av_pass      = EXCLUDED.ep_av_pass,
            ep_av_pct       = EXCLUDED.ep_av_pct,
            ep_threat_free  = EXCLUDED.ep_threat_free,
            ep_threat_pct   = EXCLUDED.ep_threat_pct,
            snapshot_at     = NOW(),
            snapshot_by     = EXCLUDED.snapshot_by
        RETURNING snapshot_at
    """), {
        "q": quarter, "y": year,
        "pt": patch["total_agents"], "pc": patch["compliant_agents"], "pp": patch["compliant_pct"],
        "et": endpoint["total"], "ea": endpoint["av_pass"], "eap": endpoint["av_pct"],
        "etf": endpoint["av_pass"], "etp": endpoint["threat_free_pct"],
        "by": username,
    })
    await db.commit()
    return {"saved": True, "quarter": quarter, "year": year,
            "patch": patch, "endpoint": endpoint}


# ---------------------------------------------------------------------------
# GET /quarterly/scorecard
# ---------------------------------------------------------------------------
@router.get("/scorecard")
async def get_scorecard(
    quarter: int = Query(..., ge=1, le=4),
    year: int    = Query(..., ge=2000, le=2100),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    start, end = _quarter_dates(quarter, year)
    start_dt = datetime(start.year, start.month, start.day, tzinfo=timezone.utc)
    end_dt   = datetime(end.year, end.month, end.day, 23, 59, 59, tzinfo=timezone.utc)

    today = date.today()
    cur_q, cur_y = _current_quarter_of(today)
    is_current_quarter = (quarter == cur_q and year == cur_y)

    result: Dict[str, Any] = {"quarter": quarter, "year": year}

    # ------------------------------------------------------------------
    # Patch compliance + Endpoint protection
    # Current quarter → compute live (and auto-save snapshot)
    # Past quarter     → load from snapshot; no_data if none exists
    # ------------------------------------------------------------------
    if is_current_quarter:
        try:
            patch, endpoint = await _compute_live_patch_endpoint(db)
            result["patch"] = patch
            result["endpoint"] = endpoint
            # Auto-save snapshot for current quarter so history is always fresh
            username = getattr(_user, "username", None) or "system"
            try:
                await db.execute(text("""
                    INSERT INTO quarterly_snapshots
                        (quarter, year, patch_total, patch_compliant, patch_pct,
                         ep_total, ep_av_pass, ep_av_pct, ep_threat_free, ep_threat_pct,
                         snapshot_at, snapshot_by)
                    VALUES
                        (:q, :y, :pt, :pc, :pp, :et, :ea, :eap, :etf, :etp, NOW(), :by)
                    ON CONFLICT (quarter, year) DO UPDATE SET
                        patch_total     = EXCLUDED.patch_total,
                        patch_compliant = EXCLUDED.patch_compliant,
                        patch_pct       = EXCLUDED.patch_pct,
                        ep_total        = EXCLUDED.ep_total,
                        ep_av_pass      = EXCLUDED.ep_av_pass,
                        ep_av_pct       = EXCLUDED.ep_av_pct,
                        ep_threat_free  = EXCLUDED.ep_threat_free,
                        ep_threat_pct   = EXCLUDED.ep_threat_pct,
                        snapshot_at     = NOW(),
                        snapshot_by     = EXCLUDED.snapshot_by
                """), {
                    "q": quarter, "y": year,
                    "pt": patch["total_agents"], "pc": patch["compliant_agents"], "pp": patch["compliant_pct"],
                    "et": endpoint["total"], "ea": endpoint["av_pass"], "eap": endpoint["av_pct"],
                    "etf": endpoint["av_pass"], "etp": endpoint["threat_free_pct"],
                    "by": username,
                })
                await db.commit()
            except Exception:
                await db.rollback()
        except Exception as exc:
            await db.rollback()
            result["patch"] = {"error": str(exc), "target": 95}
            result["endpoint"] = {"error": str(exc), "target": 100}
    else:
        # Past (or future) quarter — look for a saved snapshot
        r = await db.execute(text("""
            SELECT patch_total, patch_compliant, patch_pct,
                   ep_total, ep_av_pass, ep_av_pct, ep_threat_free, ep_threat_pct,
                   snapshot_at, snapshot_by
            FROM quarterly_snapshots
            WHERE quarter = :q AND year = :y
        """), {"q": quarter, "y": year})
        snap = r.fetchone()
        if snap:
            result["patch"] = {
                "compliant_pct":    float(snap[2]) if snap[2] is not None else 0.0,
                "total_agents":     snap[0] or 0,
                "compliant_agents": snap[1] or 0,
                "target": 95,
                "snapshot_at": snap[8].isoformat() if snap[8] else None,
                "snapshot_by": snap[9],
            }
            result["endpoint"] = {
                "av_pct":           float(snap[5]) if snap[5] is not None else 0.0,
                "threat_free_pct":  float(snap[7]) if snap[7] is not None else 0.0,
                "total":            snap[3] or 0,
                "av_pass":          snap[4] or 0,
                "target": 100,
                "snapshot_at": snap[8].isoformat() if snap[8] else None,
                "snapshot_by": snap[9],
            }
        else:
            result["patch"] = {"no_data": True, "target": 95,
                               "message": "No snapshot saved for this quarter"}
            result["endpoint"] = {"no_data": True, "target": 100,
                                  "message": "No snapshot saved for this quarter"}

    # ------------------------------------------------------------------
    # Vulnerability management  (both counts scoped to the quarter)
    # ------------------------------------------------------------------
    try:
        # Critical vulns first detected in this quarter that are still open
        r = await db.execute(text("""
            SELECT COUNT(*) FROM agent_vulnerabilities
            WHERE severity = 'critical' AND status = 'open'
              AND detected_at BETWEEN :start AND :end
        """), {"start": start_dt, "end": end_dt})
        critical_open = r.scalar() or 0

        # Avg days to remediate for items remediated within the quarter
        r = await db.execute(text("""
            SELECT AVG(EXTRACT(EPOCH FROM (remediated_at - detected_at)) / 86400.0)
            FROM agent_vulnerabilities
            WHERE status = 'remediated'
              AND remediated_at BETWEEN :start AND :end
        """), {"start": start_dt, "end": end_dt})
        avg_days = r.scalar()

        # Detect if there's truly no vuln data for this quarter
        r = await db.execute(text("""
            SELECT COUNT(*) FROM agent_vulnerabilities
            WHERE detected_at BETWEEN :start AND :end
        """), {"start": start_dt, "end": end_dt})
        total_detected = r.scalar() or 0

        result["vulnerability"] = {
            "critical_open": critical_open,
            "avg_days_to_remediate": round(float(avg_days), 1) if avg_days is not None else None,
            "target_days": 14,
            "no_data": total_detected == 0,
        }
    except Exception as exc:
        await db.rollback()
        result["vulnerability"] = {"error": str(exc), "target_days": 14}

    # ------------------------------------------------------------------
    # Phishing simulation  (only count COMPLETED campaigns as conducted)
    # ------------------------------------------------------------------
    try:
        # Completed campaigns in this quarter
        r = await db.execute(text("""
            SELECT
                COUNT(DISTINCT pc.id)                                   AS campaigns,
                COUNT(pt.campaign_id)                                   AS total_sent,
                COUNT(CASE WHEN pt.clicked_at IS NOT NULL THEN 1 END)  AS total_clicked
            FROM phishing_campaigns pc
            JOIN phishing_targets pt ON pt.campaign_id = pc.id
            WHERE pc.completed_at BETWEEN :start AND :end
        """), {"start": start_dt, "end": end_dt})
        row = r.fetchone()
        campaigns     = row[0] or 0
        total_sent    = row[1] or 0
        total_clicked = row[2] or 0
        click_pct = round(total_clicked / total_sent * 100, 1) if total_sent > 0 else 0.0
        result["phishing"] = {
            "click_pct": click_pct,
            "total_sent": total_sent,
            "total_clicked": total_clicked,
            "campaigns": campaigns,
            "target": 5,
        }
    except Exception as exc:
        await db.rollback()
        result["phishing"] = {"error": str(exc), "target": 5}

    # ------------------------------------------------------------------
    # Incidents
    # ------------------------------------------------------------------
    try:
        r = await db.execute(text("""
            SELECT severity, contain_hours FROM quarterly_sla_config
        """))
        sla_map = {row[0]: row[1] for row in r.fetchall()}

        r = await db.execute(text("""
            SELECT
                id,
                severity,
                detected_at,
                contained_at,
                EXTRACT(EPOCH FROM (contained_at - detected_at)) / 3600.0 AS contain_hours
            FROM security_incidents
            WHERE detected_at BETWEEN :start AND :end
        """), {"start": start_dt, "end": end_dt})
        rows = r.fetchall()
        total = len(rows)

        hours_list = [float(row[4]) for row in rows if row[3] is not None and row[4] is not None]
        avg_contain = round(sum(hours_list) / len(hours_list), 1) if hours_list else None

        within_sla_count = 0
        sla_denom = 0
        for row in rows:
            if row[3] is not None and row[4] is not None:
                sla_limit = sla_map.get(row[1], 24)
                sla_denom += 1
                if float(row[4]) <= sla_limit:
                    within_sla_count += 1
        within_sla_pct = round(within_sla_count / sla_denom * 100, 1) if sla_denom > 0 else None

        result["incidents"] = {
            "total": total,
            "avg_contain_hours": avg_contain,
            "within_sla_pct": within_sla_pct,
            "sla": sla_map,
        }
    except Exception as exc:
        await db.rollback()
        result["incidents"] = {"error": str(exc)}

    # ------------------------------------------------------------------
    # Audit findings
    # ------------------------------------------------------------------
    try:
        r = await db.execute(text("""
            SELECT
                COUNT(*)                                                                        AS total,
                COUNT(CASE WHEN status = 'closed' THEN 1 END)                                  AS closed_count,
                COUNT(CASE WHEN status = 'closed'
                           AND (due_date IS NULL OR closed_at::date <= due_date) THEN 1 END)   AS closed_on_time
            FROM audit_findings
        """))
        row = r.fetchone()
        total          = row[0] or 0
        closed_count   = row[1] or 0
        closed_on_time = row[2] or 0
        closure_pct = round(closed_on_time / total * 100, 1) if total > 0 else 0.0
        result["findings"] = {
            "total": total,
            "closed_count": closed_count,
            "closed_on_time": closed_on_time,
            "closure_pct": closure_pct,
            "target": 90,
        }
    except Exception as exc:
        await db.rollback()
        result["findings"] = {"error": str(exc), "target": 90}

    return result


# ---------------------------------------------------------------------------
# Audit Findings CRUD
# ---------------------------------------------------------------------------
_FINDING_COLS = ["id", "title", "observation", "source", "area", "year",
                 "due_date", "status", "reason", "risk_rating",
                 "risk_implication", "recommendation",
                 "prev_management_comments", "current_management_comments",
                 "rating_color", "individual_responsible", "implementation",
                 "created_at", "updated_at", "closed_at"]

_FINDING_SELECT = """
    SELECT id, title, observation, source, area, year,
           due_date, status, reason, risk_rating,
           risk_implication, recommendation,
           prev_management_comments, current_management_comments,
           rating_color, individual_responsible, implementation,
           created_at, updated_at, closed_at
    FROM audit_findings
"""

_FINDING_ORDER = """
    ORDER BY
        CASE risk_rating WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        created_at DESC
"""


@router.get("/findings")
async def list_findings(
    year:   Optional[int] = Query(None, ge=2000, le=2100),
    source: str = Query("all"),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    conditions = []
    params: Dict[str, Any] = {}
    if year is not None:
        conditions.append("year = :y")
        params["y"] = year
    if source != "all":
        conditions.append("source = :src")
        params["src"] = source
    where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
    r = await db.execute(text(_FINDING_SELECT + where + _FINDING_ORDER), params)
    return [dict(zip(_FINDING_COLS, row)) for row in r.fetchall()]


@router.post("/findings", status_code=201)
async def create_finding(
    body: Dict[str, Any],
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    for field in ["title", "year"]:
        if not body.get(field):
            raise HTTPException(400, detail=f"Field '{field}' is required")

    r = await db.execute(text("""
        INSERT INTO audit_findings
            (title, observation, source, area, year, due_date,
             status, reason, risk_rating, risk_implication, recommendation,
             prev_management_comments, current_management_comments,
             rating_color, individual_responsible, implementation)
        VALUES
            (:title, :observation, :source, :area, :year, :due_date,
             :status, :reason, :risk_rating, :risk_implication, :recommendation,
             :prev_management_comments, :current_management_comments,
             :rating_color, :individual_responsible, :implementation)
        RETURNING id, title, observation, source, area, year,
                  due_date, status, reason, risk_rating,
                  risk_implication, recommendation,
                  prev_management_comments, current_management_comments,
                  rating_color, individual_responsible, implementation,
                  created_at, updated_at, closed_at
    """), {
        "title":                    body["title"],
        "observation":              body.get("observation") or None,
        "source":                   body.get("source", "internal"),
        "area":                     body.get("area", "Other"),
        "year":                     int(body["year"]),
        "due_date":                 body.get("due_date") or None,
        "status":                   body.get("status", "pending"),
        "reason":                   body.get("reason") or None,
        "risk_rating":              body.get("risk_rating", "medium"),
        "risk_implication":         body.get("risk_implication") or None,
        "recommendation":           body.get("recommendation") or None,
        "prev_management_comments": body.get("prev_management_comments") or None,
        "current_management_comments": body.get("current_management_comments") or None,
        "rating_color":             body.get("rating_color") or None,
        "individual_responsible":   body.get("individual_responsible") or None,
        "implementation":           body.get("implementation") or None,
    })
    await db.commit()
    return dict(zip(_FINDING_COLS, r.fetchone()))


@router.patch("/findings/{finding_id}")
async def update_finding(
    finding_id: str,
    body: Dict[str, Any],
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    if body.get("status") == "not_achievable" and not body.get("reason"):
        raise HTTPException(400, detail="A reason is required when status is 'not_achievable'")

    allowed = {"title", "observation", "source", "area", "due_date",
               "status", "reason", "risk_rating", "risk_implication", "recommendation",
               "prev_management_comments", "current_management_comments",
               "rating_color", "individual_responsible", "implementation"}
    # Coerce empty strings to None for nullable fields
    nullable = {"observation", "due_date", "reason", "risk_implication", "recommendation",
                "prev_management_comments", "current_management_comments",
                "rating_color", "individual_responsible", "implementation"}
    updates: Dict[str, Any] = {k: (v or None if k in nullable else v)
                                for k, v in body.items() if k in allowed}
    if not updates:
        raise HTTPException(400, detail="No updatable fields provided")

    if updates.get("status") == "closed":
        updates["closed_at"] = datetime.now(timezone.utc)
    elif "status" in updates:
        updates["closed_at"] = None

    updates["updated_at"] = datetime.now(timezone.utc)
    set_clause = ", ".join(f"{k} = :{k}" for k in updates)
    updates["finding_id"] = finding_id

    r = await db.execute(text(f"""
        UPDATE audit_findings SET {set_clause} WHERE id = :finding_id
        RETURNING id, title, observation, source, area, year,
                  due_date, status, reason, risk_rating,
                  risk_implication, recommendation,
                  prev_management_comments, current_management_comments,
                  rating_color, individual_responsible, implementation,
                  created_at, updated_at, closed_at
    """), updates)
    await db.commit()
    row = r.fetchone()
    if not row:
        raise HTTPException(404, detail="Finding not found")
    return dict(zip(_FINDING_COLS, row))


@router.delete("/findings/{finding_id}")
async def delete_finding(
    finding_id: str,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_admin),
):
    await _ensure_tables(db)
    r = await db.execute(
        text("DELETE FROM audit_findings WHERE id = :id RETURNING id"),
        {"id": finding_id}
    )
    await db.commit()
    if not r.fetchone():
        raise HTTPException(404, detail="Finding not found")
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Audit Categories CRUD
# ---------------------------------------------------------------------------
@router.get("/categories")
async def list_categories(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    r = await db.execute(text(
        "SELECT id, name, description, created_at FROM audit_categories ORDER BY name"
    ))
    return [{"id": str(row[0]), "name": row[1], "description": row[2],
             "created_at": row[3].isoformat() if row[3] else None}
            for row in r.fetchall()]


@router.post("/categories", status_code=201)
async def create_category(
    body: Dict[str, Any],
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, detail="Category name is required")
    try:
        r = await db.execute(text("""
            INSERT INTO audit_categories (name, description)
            VALUES (:name, :desc)
            RETURNING id, name, description, created_at
        """), {"name": name, "desc": body.get("description")})
        await db.commit()
        row = r.fetchone()
        return {"id": str(row[0]), "name": row[1], "description": row[2],
                "created_at": row[3].isoformat() if row[3] else None}
    except Exception:
        await db.rollback()
        raise HTTPException(409, detail="Category already exists")


@router.delete("/categories/{category_id}")
async def delete_category(
    category_id: str,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_admin),
):
    await _ensure_tables(db)
    r = await db.execute(
        text("DELETE FROM audit_categories WHERE id = :id RETURNING id"),
        {"id": category_id}
    )
    await db.commit()
    if not r.fetchone():
        raise HTTPException(404, detail="Category not found")
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Security Incidents CRUD
# ---------------------------------------------------------------------------
_INCIDENT_COLS = ["id", "title", "description", "severity", "status",
                  "detected_at", "contained_at", "resolved_at",
                  "reporter", "notes", "created_at", "updated_at"]


@router.get("/incidents")
async def list_incidents(
    quarter: int = Query(..., ge=1, le=4),
    year: int    = Query(..., ge=2000, le=2100),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    start, end = _quarter_dates(quarter, year)
    start_dt = datetime(start.year, start.month, start.day, tzinfo=timezone.utc)
    end_dt   = datetime(end.year, end.month, end.day, 23, 59, 59, tzinfo=timezone.utc)

    r = await db.execute(text("""
        SELECT id, title, description, severity, status,
               detected_at, contained_at, resolved_at,
               reporter, notes, created_at, updated_at
        FROM security_incidents
        WHERE detected_at BETWEEN :start AND :end
        ORDER BY detected_at DESC
    """), {"start": start_dt, "end": end_dt})
    return [dict(zip(_INCIDENT_COLS, row)) for row in r.fetchall()]


@router.post("/incidents", status_code=201)
async def create_incident(
    body: Dict[str, Any],
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    if not body.get("title") or not body.get("severity"):
        raise HTTPException(400, detail="Fields 'title' and 'severity' are required")

    detected_at = body.get("detected_at")
    if detected_at:
        try:
            detected_at = datetime.fromisoformat(detected_at.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            raise HTTPException(400, detail="Invalid detected_at format; use ISO 8601")
    else:
        detected_at = datetime.now(timezone.utc)

    r = await db.execute(text("""
        INSERT INTO security_incidents
            (title, description, severity, status, detected_at, reporter, notes)
        VALUES
            (:title, :description, :severity, :status, :detected_at, :reporter, :notes)
        RETURNING id, title, description, severity, status,
                  detected_at, contained_at, resolved_at,
                  reporter, notes, created_at, updated_at
    """), {
        "title":       body["title"],
        "description": body.get("description"),
        "severity":    body["severity"],
        "status":      body.get("status", "open"),
        "detected_at": detected_at,
        "reporter":    body.get("reporter"),
        "notes":       body.get("notes"),
    })
    await db.commit()
    return dict(zip(_INCIDENT_COLS, r.fetchone()))


@router.patch("/incidents/{incident_id}")
async def update_incident(
    incident_id: str,
    body: Dict[str, Any],
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    allowed = {"title", "description", "severity", "status",
               "detected_at", "contained_at", "resolved_at", "reporter", "notes"}
    updates: Dict[str, Any] = {k: v for k, v in body.items() if k in allowed}

    if not updates:
        raise HTTPException(400, detail="No updatable fields provided")

    new_status = updates.get("status")
    now = datetime.now(timezone.utc)

    if new_status in ("contained",) and "contained_at" not in updates:
        updates["contained_at"] = now
    if new_status in ("resolved", "closed") and "resolved_at" not in updates:
        updates["resolved_at"] = now

    # Parse any ISO timestamps supplied by client
    for ts_field in ("detected_at", "contained_at", "resolved_at"):
        if ts_field in updates and isinstance(updates[ts_field], str):
            try:
                updates[ts_field] = datetime.fromisoformat(
                    updates[ts_field].replace("Z", "+00:00")
                )
            except ValueError:
                raise HTTPException(400, detail=f"Invalid {ts_field} format")

    updates["updated_at"] = now
    set_clause = ", ".join(f"{k} = :{k}" for k in updates)
    updates["incident_id"] = incident_id

    r = await db.execute(text(f"""
        UPDATE security_incidents
        SET {set_clause}
        WHERE id = :incident_id
        RETURNING id, title, description, severity, status,
                  detected_at, contained_at, resolved_at,
                  reporter, notes, created_at, updated_at
    """), updates)
    await db.commit()
    row = r.fetchone()
    if not row:
        raise HTTPException(404, detail="Incident not found")
    return dict(zip(_INCIDENT_COLS, row))


@router.delete("/incidents/{incident_id}")
async def delete_incident(
    incident_id: str,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    r = await db.execute(text(
        "DELETE FROM security_incidents WHERE id = :id RETURNING id"
    ), {"id": incident_id})
    await db.commit()
    if not r.fetchone():
        raise HTTPException(404, detail="Incident not found")
    return {"deleted": True}


# ---------------------------------------------------------------------------
# SLA Config
# ---------------------------------------------------------------------------
_SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}


@router.get("/sla")
async def get_sla(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    r = await db.execute(text(
        "SELECT severity, contain_hours, resolve_hours, updated_at FROM quarterly_sla_config"
    ))
    rows = r.fetchall()
    cols = ["severity", "contain_hours", "resolve_hours", "updated_at"]
    data = [dict(zip(cols, row)) for row in rows]
    data.sort(key=lambda x: _SEVERITY_ORDER.get(x["severity"], 99))
    return data


@router.patch("/sla")
async def update_sla(
    body: List[Dict[str, Any]],
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    await _ensure_tables(db)
    now = datetime.now(timezone.utc)
    for item in body:
        severity = item.get("severity")
        if not severity:
            continue
        await db.execute(text("""
            INSERT INTO quarterly_sla_config (severity, contain_hours, resolve_hours, updated_at)
            VALUES (:severity, :contain_hours, :resolve_hours, :now)
            ON CONFLICT (severity) DO UPDATE
            SET contain_hours = EXCLUDED.contain_hours,
                resolve_hours = EXCLUDED.resolve_hours,
                updated_at    = EXCLUDED.updated_at
        """), {
            "severity":      severity,
            "contain_hours": item.get("contain_hours", 24),
            "resolve_hours": item.get("resolve_hours", 72),
            "now":           now,
        })
    await db.commit()

    r = await db.execute(text(
        "SELECT severity, contain_hours, resolve_hours, updated_at FROM quarterly_sla_config"
    ))
    cols = ["severity", "contain_hours", "resolve_hours", "updated_at"]
    rows = [dict(zip(cols, row)) for row in r.fetchall()]
    rows.sort(key=lambda x: _SEVERITY_ORDER.get(x["severity"], 99))
    return rows


# ---------------------------------------------------------------------------
# XLSX Report Export
# ---------------------------------------------------------------------------
@router.get("/report/xlsx")
async def export_xlsx(
    quarter: int = Query(..., ge=1, le=4),
    year: int    = Query(..., ge=2000, le=2100),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    try:
        import openpyxl
        from openpyxl.styles import (
            Font, PatternFill, Alignment, Border, Side
        )
        from openpyxl.utils import get_column_letter
    except ImportError:
        raise HTTPException(500, detail="openpyxl is not installed")

    await _ensure_tables(db)

    # Fetch scorecard data
    scorecard_resp = await get_scorecard(quarter=quarter, year=year, db=db, _user=_user)

    # Fetch previous quarter scorecard for QoQ comparison
    prev_q = quarter - 1 if quarter > 1 else 4
    prev_y = year if quarter > 1 else year - 1
    try:
        prev_sc = await get_scorecard(quarter=prev_q, year=prev_y, db=db, _user=_user)
    except Exception:
        prev_sc = {}

    # Fetch findings & incidents
    start, end = _quarter_dates(quarter, year)
    start_dt = datetime(start.year, start.month, start.day, tzinfo=timezone.utc)
    end_dt   = datetime(end.year, end.month, end.day, 23, 59, 59, tzinfo=timezone.utc)

    findings_r = await db.execute(text("""
        SELECT title, area, risk_rating, status, risk_implication, recommendation,
               prev_management_comments, current_management_comments,
               rating_color, individual_responsible, implementation,
               year, due_date, closed_at
        FROM audit_findings
        ORDER BY year DESC,
                 CASE risk_rating WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
    """))
    findings = findings_r.fetchall()

    incidents_r = await db.execute(text("""
        SELECT title, severity, status, detected_at, contained_at,
               EXTRACT(EPOCH FROM (contained_at - detected_at))/3600.0 AS contain_hours,
               reporter, notes
        FROM security_incidents
        WHERE detected_at BETWEEN :start AND :end
        ORDER BY detected_at DESC
    """), {"start": start_dt, "end": end_dt})
    incidents = incidents_r.fetchall()

    sla_r = await db.execute(text(
        "SELECT severity, contain_hours FROM quarterly_sla_config"
    ))

    # Raw data for per-category sheets
    try:
        patch_agents_r = await db.execute(text("""
            SELECT a.hostname, a.display_name, a.os_type, a.ip_address, a.status,
                   COUNT(ap.id) AS pending_security_patches
            FROM agents a
            LEFT JOIN agent_patches ap ON ap.agent_id = a.id
                AND LOWER(ap.category) LIKE '%security%'
            WHERE a.is_active = TRUE
              AND (a.exclude_from_reports IS NULL OR a.exclude_from_reports = FALSE)
            GROUP BY a.id, a.hostname, a.display_name, a.os_type, a.ip_address, a.status
            ORDER BY pending_security_patches DESC, a.hostname
        """))
        patch_agents = patch_agents_r.fetchall()
    except Exception:
        await db.rollback()
        patch_agents = []

    try:
        endpoint_r = await db.execute(text("""
            SELECT a.hostname, a.display_name, a.os_type, a.ip_address, a.status,
                   CASE
                       WHEN a.os_type = 'linux' THEN COALESCE(NULLIF(s.av_product, ''), 'N/A (Linux)')
                       ELSE COALESCE(
                           NULLIF(s.av_product, ''),
                           (SELECT string_agg(DISTINCT si.name, ', ' ORDER BY si.name)
                            FROM software_inventory si
                            WHERE si.agent_id = a.id
                              AND (si.name ILIKE '%sophos%' OR si.name ILIKE '%crowdstrike%'
                                OR si.name ILIKE '%sentinelone%' OR si.name ILIKE '%bitdefender%'
                                OR si.name ILIKE '%kaspersky%' OR si.name ILIKE '%malwarebytes%'
                                OR si.name ILIKE '%mcafee%' OR si.name ILIKE '%trellix%'
                                OR si.name ILIKE '%trend micro%' OR si.name ILIKE '%symantec%'
                                OR si.name ILIKE '%norton%' OR si.name ILIKE '%webroot%'
                                OR si.name ILIKE '%eset%' OR si.name ILIKE '%f-secure%'
                                OR si.name ILIKE '% avg %' OR si.name ILIKE 'avg %' OR si.name ILIKE '% avg'
                                OR si.name ILIKE '%avast%'
                               )
                           )
                       )
                   END AS av_product,
                   CASE
                       WHEN a.os_type = 'linux' THEN TRUE
                       WHEN s.av_installed = TRUE THEN TRUE
                       WHEN EXISTS (
                           SELECT 1 FROM software_inventory si
                           WHERE si.agent_id = a.id
                             AND (si.name ILIKE '%sophos%' OR si.name ILIKE '%crowdstrike%'
                               OR si.name ILIKE '%sentinelone%' OR si.name ILIKE '%bitdefender%'
                               OR si.name ILIKE '%kaspersky%' OR si.name ILIKE '%malwarebytes%'
                               OR si.name ILIKE '%mcafee%' OR si.name ILIKE '%trellix%'
                               OR si.name ILIKE '%trend micro%' OR si.name ILIKE '%symantec%'
                               OR si.name ILIKE '%norton%' OR si.name ILIKE '%webroot%'
                               OR si.name ILIKE '%eset%' OR si.name ILIKE '%f-secure%'
                               OR si.name ILIKE '% avg %' OR si.name ILIKE 'avg %' OR si.name ILIKE '% avg'
                               OR si.name ILIKE '%avast%'
                              )
                       ) THEN TRUE
                       ELSE s.av_installed
                   END AS av_installed,
                   s.av_running, s.av_last_scan,
                   s.firewall_enabled, s.disk_encrypted, s.updated_at,
                   a.id::text AS agent_id
            FROM agents a
            LEFT JOIN agent_security_state s ON s.agent_id = a.id
            WHERE a.is_active = TRUE
              AND (a.exclude_from_reports IS NULL OR a.exclude_from_reports = FALSE)
            ORDER BY a.hostname
        """))
        endpoint_agents = endpoint_r.fetchall()
    except Exception:
        await db.rollback()
        endpoint_agents = []

    try:
        vulns_r = await db.execute(text("""
            SELECT a.hostname, v.cve_id, v.software_name, v.software_version,
                   v.severity, v.cvss_score, v.status,
                   v.detected_at, v.remediated_at,
                   ROUND(EXTRACT(EPOCH FROM (COALESCE(v.remediated_at, NOW()) - v.detected_at))
                         / 86400.0, 1) AS days_open
            FROM agent_vulnerabilities v
            JOIN agents a ON a.id = v.agent_id
            WHERE a.is_active = TRUE
            ORDER BY
                CASE v.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                                WHEN 'medium' THEN 2 ELSE 3 END,
                v.status, a.hostname
        """))
        vulns = vulns_r.fetchall()
    except Exception:
        await db.rollback()
        vulns = []

    try:
        phishing_r = await db.execute(text("""
            SELECT pc.name AS campaign, pt.email, pt.first_name, pt.last_name,
                   pt.department, pt.send_status, pt.sent_at, pt.opened_at,
                   pt.clicked_at, pt.reported_at,
                   CASE WHEN pt.clicked_at IS NOT NULL AND pt.sent_at IS NOT NULL THEN
                       ROUND(EXTRACT(EPOCH FROM (pt.clicked_at - pt.sent_at)) / 3600.0, 1)
                   END AS hours_to_click
            FROM phishing_campaigns pc
            JOIN phishing_targets pt ON pt.campaign_id = pc.id
            WHERE (pc.completed_at BETWEEN :start AND :end
                   OR (pc.completed_at IS NULL AND pc.started_at BETWEEN :start AND :end))
            ORDER BY pc.name, pt.clicked_at NULLS LAST, pt.email
        """), {"start": start_dt, "end": end_dt})
        phishing_targets = phishing_r.fetchall()
    except Exception:
        await db.rollback()
        phishing_targets = []
    sla_map = {row[0]: row[1] for row in sla_r.fetchall()}

    # ------------------------------------------------------------------
    # Theme colours
    # ------------------------------------------------------------------
    DARK_BG      = "0B1120"
    SECTION_BG   = "1E293B"
    WHITE        = "FFFFFF"
    GREEN        = "10B981"
    AMBER        = "F59E0B"
    RED          = "EF4444"
    LIGHT_GREEN  = "DCFCE7"
    LIGHT_AMBER  = "FEF3C7"
    LIGHT_RED    = "FDE8E8"
    HEADER_BLUE  = "1D4ED8"
    MED_SLATE    = "334155"
    LIGHT_SLATE  = "CBD5E1"

    def _fill(hex_color: str) -> PatternFill:
        return PatternFill("solid", fgColor=hex_color)

    def _font(bold=False, color=WHITE, size=10) -> Font:
        return Font(bold=bold, color=color, size=size, name="Calibri")

    def _border() -> Border:
        side = Side(style="thin", color="334155")
        return Border(left=side, right=side, top=side, bottom=side)

    def _center() -> Alignment:
        return Alignment(horizontal="center", vertical="center", wrap_text=True)

    def _left() -> Alignment:
        return Alignment(horizontal="left", vertical="center", wrap_text=True)

    # ------------------------------------------------------------------
    # RAG helpers
    # ------------------------------------------------------------------
    def _rag_patch(pct):
        if pct >= 95:  return "green"
        if pct >= 80:  return "amber"
        return "red"

    def _rag_endpoint(pct):
        if pct >= 100: return "green"
        if pct >= 90:  return "amber"
        return "red"

    def _rag_vulns(critical_open, avg_days):
        if critical_open == 0: return "green"
        if avg_days is None or avg_days <= 14: return "amber"
        return "red"

    def _rag_phishing(click_pct, campaigns):
        if campaigns == 0: return "amber"   # no data — don't claim "On Target"
        if click_pct < 5:  return "green"
        if click_pct < 10: return "amber"
        return "red"

    def _rag_incidents(within_sla_pct):
        if within_sla_pct is None: return "amber"
        if within_sla_pct >= 90: return "green"
        if within_sla_pct >= 70: return "amber"
        return "red"

    def _rag_findings(closure_pct):
        if closure_pct >= 90: return "green"
        if closure_pct >= 70: return "amber"
        return "red"

    RAG_BG   = {"green": LIGHT_GREEN,  "amber": LIGHT_AMBER,    "red": LIGHT_RED}
    RAG_FG   = {"green": "065F46",     "amber": "92400E",       "red": "991B1B"}
    RAG_TEXT = {"green": "✓ On Target", "amber": "⚠ Watch",     "red": "✗ Action Required"}
    RAG_TEXT_OVERRIDE: dict = {}   # keyed by (row, col) for special cases like "No Data"

    def _apply_rag(ws, row, col, rag, override_text=None):
        cell = ws.cell(row=row, column=col)
        cell.value = override_text if override_text else RAG_TEXT[rag]
        cell.fill  = _fill(RAG_BG[rag])
        cell.font  = _font(bold=True, color=RAG_FG[rag])
        cell.alignment = _center()
        cell.border = _border()

    def _write_qoq(ws, row_num, prev_display: str, curr_val, prev_val,
                   higher_is_better: bool = True, is_count: bool = False):
        """Write Prev Quarter (col 7) and Trend (col 8) cells."""
        # Prev quarter value cell
        prev_c = ws.cell(row=row_num, column=7, value=prev_display or "N/A")
        prev_c.fill = _fill(SECTION_BG)
        prev_c.font = _font(color=LIGHT_SLATE)
        prev_c.alignment = _center()
        prev_c.border = _border()

        # Compute trend
        if prev_val is None or curr_val is None:
            trend_text  = "N/A"
            trend_bg    = MED_SLATE
            trend_fg    = LIGHT_SLATE
        else:
            diff = float(curr_val) - float(prev_val)
            unit = "" if is_count else "%"
            threshold = 0.5 if not is_count else 0.5
            if abs(diff) < threshold:
                trend_text = "→ Stagnant"
                trend_bg   = MED_SLATE
                trend_fg   = LIGHT_SLATE
            elif higher_is_better:
                if diff > 0:
                    trend_text = f"↑ {round(abs(diff), 1)}{unit} Increasing"
                    trend_bg   = LIGHT_GREEN
                    trend_fg   = "065F46"
                else:
                    trend_text = f"↓ {round(abs(diff), 1)}{unit} Decreasing"
                    trend_bg   = LIGHT_RED
                    trend_fg   = "991B1B"
            else:
                if diff < 0:
                    trend_text = f"↓ {round(abs(diff), 1)}{unit} Improving"
                    trend_bg   = LIGHT_GREEN
                    trend_fg   = "065F46"
                else:
                    trend_text = f"↑ {round(abs(diff), 1)}{unit} Worsening"
                    trend_bg   = LIGHT_RED
                    trend_fg   = "991B1B"

        trend_c = ws.cell(row=row_num, column=8, value=trend_text)
        trend_c.fill = _fill(trend_bg)
        trend_c.font = _font(bold=True, color=trend_fg)
        trend_c.alignment = _center()
        trend_c.border = _border()

    # ------------------------------------------------------------------
    # Build workbook
    # ------------------------------------------------------------------
    wb = openpyxl.Workbook()

    # ======================== SHEET 1: Scorecard =======================
    ws1 = wb.active
    ws1.title = "Security Scorecard"

    col_widths = [22, 32, 52, 28, 20, 22, 28, 28]
    for i, w in enumerate(col_widths, 1):
        ws1.column_dimensions[get_column_letter(i)].width = w

    # Title row
    ws1.merge_cells("A1:H1")
    title_cell = ws1["A1"]
    title_cell.value = f"QUARTERLY SECURITY REPORT — Q{quarter} {year}"
    title_cell.fill  = _fill(DARK_BG)
    title_cell.font  = _font(bold=True, size=14)
    title_cell.alignment = _center()
    ws1.row_dimensions[1].height = 32

    # Header row
    headers = ["Category", "Area", "Metric", "Actual", "Target", "Status",
               f"Prev Quarter (Q{prev_q} {prev_y})", "Trend vs Prev Quarter"]
    for col, hdr in enumerate(headers, 1):
        c = ws1.cell(row=2, column=col, value=hdr)
        c.fill = _fill(HEADER_BLUE)
        c.font = _font(bold=True)
        c.alignment = _center()
        c.border = _border()
    ws1.row_dimensions[2].height = 24

    # Helper to write a data row
    def _write_row(ws, row_num, category, area, metric, actual, target, rag,
                   merge_cat=False, rag_override=None):
        data = [category, area, metric, actual, target, ""]
        for col, val in enumerate(data, 1):
            c = ws.cell(row=row_num, column=col, value=val)
            c.fill = _fill(SECTION_BG)
            c.font = _font(color=LIGHT_SLATE)
            c.alignment = _left() if col in (1, 2, 3) else _center()
            c.border = _border()
        _apply_rag(ws, row_num, 6, rag, override_text=rag_override)
        ws.row_dimensions[row_num].height = 36

    # --- Technical SC: Patch ---
    patch = scorecard_resp.get("patch", {})
    patch_pct   = patch.get("compliant_pct", 0)
    patch_total = patch.get("total_agents", 0)
    patch_comp  = patch.get("compliant_agents", 0)
    rag_patch = _rag_patch(patch_pct) if "error" not in patch else "red"
    prev_patch_pct = prev_sc.get("patch", {}).get("compliant_pct")

    _write_row(ws1, 3, "Technical SC", "Patch & Update Compliance",
               "% of devices fully patched (OS & critical updates)",
               f"{patch_pct}% ({patch_comp}/{patch_total} devices)",
               "≥ 95%", rag_patch)
    _write_qoq(ws1, 3,
               f"{prev_patch_pct}%" if prev_patch_pct is not None else "N/A",
               patch_pct, prev_patch_pct, higher_is_better=True)

    # --- Technical SC: Endpoint ---
    ep = scorecard_resp.get("endpoint", {})
    av_pct  = ep.get("av_pct", 0)
    thr_pct = ep.get("threat_free_pct", 0)
    rag_ep  = _rag_endpoint(min(av_pct, thr_pct)) if "error" not in ep else "red"
    prev_ep = prev_sc.get("endpoint", {})
    prev_ep_val = min(prev_ep.get("av_pct", 0), prev_ep.get("threat_free_pct", 0)) if "error" not in prev_ep and prev_ep else None

    _write_row(ws1, 4, "Technical SC", "Endpoint Protection",
               "% of devices with active AV; % reporting no critical threats",
               f"AV: {av_pct}% | Threat-free: {thr_pct}%",
               "100% protected", rag_ep)
    _write_qoq(ws1, 4,
               f"AV: {prev_ep.get('av_pct', 'N/A')}%" if prev_ep else "N/A",
               min(av_pct, thr_pct), prev_ep_val, higher_is_better=True)

    # --- Technical SC: Vulnerability ---
    vuln = scorecard_resp.get("vulnerability", {})
    crit_open = vuln.get("critical_open", 0)
    avg_days  = vuln.get("avg_days_to_remediate")
    rag_vuln  = _rag_vulns(crit_open, avg_days) if "error" not in vuln else "red"
    avg_str   = f"{avg_days}d avg remediation" if avg_days is not None else "N/A"
    prev_vuln = prev_sc.get("vulnerability", {})
    prev_crit = prev_vuln.get("critical_open") if prev_vuln and "error" not in prev_vuln else None

    _write_row(ws1, 5, "Technical SC", "Vulnerability Management",
               "No. of critical vulns open; Avg days to remediate",
               f"{crit_open} critical open | {avg_str}",
               "0 critical > 14 days", rag_vuln)
    _write_qoq(ws1, 5,
               f"{prev_crit} critical open" if prev_crit is not None else "N/A",
               crit_open, prev_crit, higher_is_better=False, is_count=True)

    # Merge Technical SC category
    ws1.merge_cells("A3:A5")
    cat_cell = ws1["A3"]
    cat_cell.value     = "Technical SC"
    cat_cell.fill      = _fill(MED_SLATE)
    cat_cell.font      = _font(bold=True, color=WHITE)
    cat_cell.alignment = _center()
    cat_cell.border    = _border()

    # --- User SC: Phishing ---
    phi = scorecard_resp.get("phishing", {})
    click_pct     = phi.get("click_pct", 0)
    total_sent    = phi.get("total_sent", 0)
    total_clicked = phi.get("total_clicked", 0)
    campaigns     = phi.get("campaigns", 0)
    rag_phi       = _rag_phishing(click_pct, campaigns) if "error" not in phi else "red"
    prev_phi = prev_sc.get("phishing", {})
    prev_click_pct = prev_phi.get("click_pct") if prev_phi and "error" not in prev_phi else None

    if campaigns == 0:
        phi_actual = "No simulation conducted this quarter"
        phi_rag_override = "⚠ Not Conducted"
    else:
        phi_actual = f"{click_pct}% click rate ({total_clicked}/{total_sent} users) — {campaigns} campaign(s)"
        phi_rag_override = None

    _write_row(ws1, 6, "User SC", "Phishing Simulation",
               "% of users who clicked simulated phishing email; campaigns run",
               phi_actual, "< 5% click rate", rag_phi, rag_override=phi_rag_override)
    _write_qoq(ws1, 6,
               f"{prev_click_pct}% click rate" if prev_click_pct is not None else "N/A",
               click_pct if campaigns > 0 else None,
               prev_click_pct, higher_is_better=False)

    # --- Governance: Incidents ---
    inc = scorecard_resp.get("incidents", {})
    inc_total   = inc.get("total", 0)
    avg_contain = inc.get("avg_contain_hours")
    sla_pct     = inc.get("within_sla_pct")
    rag_inc     = _rag_incidents(sla_pct) if "error" not in inc else "red"
    contain_str = f"{avg_contain}h avg" if avg_contain is not None else "N/A"
    sla_str     = f"{sla_pct}% within SLA" if sla_pct is not None else "N/A"
    prev_inc = prev_sc.get("incidents", {})
    prev_sla_pct = prev_inc.get("within_sla_pct") if prev_inc and "error" not in prev_inc else None

    _write_row(ws1, 7, "Governance & Audit SC", "Incident Reporting & Resolution",
               "Number of security incidents; Time to contain",
               f"{inc_total} incident(s) | {contain_str} | {sla_str}",
               "SLA per severity", rag_inc)
    _write_qoq(ws1, 7,
               f"{prev_inc.get('total', 'N/A')} incident(s) | {prev_sla_pct}% SLA" if prev_sla_pct is not None else "N/A",
               sla_pct, prev_sla_pct, higher_is_better=True)

    # --- Governance: Findings ---
    fnd = scorecard_resp.get("findings", {})
    fnd_total    = fnd.get("total", 0)
    fnd_closed   = fnd.get("closed_count", 0)
    closed_time  = fnd.get("closed_on_time", 0)
    closure_pct  = fnd.get("closure_pct", 0)
    fnd_open     = fnd_total - fnd_closed
    rag_fnd      = _rag_findings(closure_pct) if "error" not in fnd else "red"
    prev_fnd = prev_sc.get("findings", {})
    prev_closure_pct = prev_fnd.get("closure_pct") if prev_fnd and "error" not in prev_fnd else None

    _write_row(ws1, 8, "Governance & Audit SC", "Audit Findings",
               "Total findings tracked (all years); open vs closed; % closed within timeline",
               f"{fnd_total} total | {fnd_open} open | {fnd_closed} closed | {closure_pct}% on time",
               "90% closure within timeline", rag_fnd)
    _write_qoq(ws1, 8,
               f"{prev_fnd.get('total', 'N/A')} finding(s) | {prev_closure_pct}% closed" if prev_closure_pct is not None else "N/A",
               closure_pct, prev_closure_pct, higher_is_better=True)

    # Merge Governance category
    ws1.merge_cells("A7:A8")
    gov_cell = ws1["A7"]
    gov_cell.value     = "Governance & Audit SC"
    gov_cell.fill      = _fill(MED_SLATE)
    gov_cell.font      = _font(bold=True, color=WHITE)
    gov_cell.alignment = _center()
    gov_cell.border    = _border()

    # User SC single row — reformat category cell to match style
    user_cell = ws1["A6"]
    user_cell.value     = "User SC"
    user_cell.fill      = _fill(MED_SLATE)
    user_cell.font      = _font(bold=True, color=WHITE)
    user_cell.alignment = _center()
    user_cell.border    = _border()

    # ======================== SHEET 2: Audit Findings =================
    ws2 = wb.create_sheet("Audit Findings")
    f_col_widths = [35, 18, 12, 16, 10, 32, 32, 32, 32, 18, 18, 8, 14, 14]
    f_headers    = ["Finding Title", "Area", "Risk Rating", "Status",
                    "Rating Color", "Risk Implication", "Recommendation",
                    "Previous Mgmt Comments", "Current Mgmt Comments / Action Points",
                    "Individual Responsible", "Implementation", "Year", "Due Date", "Closed At"]
    for i, w in enumerate(f_col_widths, 1):
        ws2.column_dimensions[get_column_letter(i)].width = w

    # Sheet title
    ws2.merge_cells(f"A1:{get_column_letter(len(f_headers))}1")
    tc2 = ws2["A1"]
    tc2.value = f"Audit Findings — All Years (exported Q{quarter} {year})"
    tc2.fill  = _fill(DARK_BG)
    tc2.font  = _font(bold=True, size=13)
    tc2.alignment = _center()
    ws2.row_dimensions[1].height = 28

    for col, hdr in enumerate(f_headers, 1):
        c = ws2.cell(row=2, column=col, value=hdr)
        c.fill = _fill(HEADER_BLUE)
        c.font = _font(bold=True)
        c.alignment = _center()
        c.border = _border()

    STATUS_COLORS = {
        "pending":         ("64748B", "FFFFFF"),
        "started":         ("2563EB", "DBEAFE"),
        "in_progress":     ("D97706", "FEF3C7"),
        "closed":          ("059669", "D1FAE5"),
        "not_achievable":  ("DC2626", "FEE2E2"),
    }
    RISK_RATING_COLORS = {
        "low":      ("64748B", "F1F5F9"),
        "medium":   ("D97706", "FEF3C7"),
        "high":     ("EA580C", "FFF7ED"),
        "critical": ("DC2626", "FEE2E2"),
    }

    for row_idx, frow in enumerate(findings, 3):
        (title, area, risk_rating, status, risk_implication, recommendation,
         prev_mgmt, curr_mgmt, rating_color, individual_responsible,
         implementation, year_val, due_date, closed_at) = frow
        row_data = [
            title or "",
            area or "",
            risk_rating or "",
            status or "",
            rating_color or "",
            risk_implication or "",
            recommendation or "",
            prev_mgmt or "",
            curr_mgmt or "",
            individual_responsible or "",
            implementation or "",
            year_val,
            str(due_date) if due_date else "",
            str(closed_at)[:10] if closed_at else "",
        ]
        for col, val in enumerate(row_data, 1):
            c = ws2.cell(row=row_idx, column=col, value=val)
            c.fill = _fill("1E293B")
            c.font = _font(color=LIGHT_SLATE)
            c.alignment = _left()
            c.border = _border()
            # Color-code risk rating (col 3) and status (col 4)
            if col == 3:
                bg, fg = RISK_RATING_COLORS.get(str(risk_rating), ("475569", "FFFFFF"))
                c.fill = _fill(bg)
                c.font = _font(bold=True, color=fg)
                c.alignment = _center()
            if col == 4:
                bg, fg = STATUS_COLORS.get(str(status), ("475569", "FFFFFF"))
                c.fill = _fill(bg)
                c.font = _font(bold=True, color=fg)
                c.alignment = _center()
            # Rating color swatch (col 5) — use the stored color if it looks like a hex
            if col == 5 and rating_color:
                hex_color = rating_color.lstrip("#")
                if len(hex_color) == 6:
                    try:
                        c.fill = _fill(hex_color)
                        c.value = ""
                    except Exception:
                        pass
        ws2.row_dimensions[row_idx].height = 36

    # ======================== SHEET 3: Incidents ======================
    ws3 = wb.create_sheet("Security Incidents")
    i_col_widths = [35, 12, 14, 20, 20, 18, 14, 20, 35]
    i_headers    = ["Title", "Severity", "Status", "Detected", "Contained",
                    "Hours to Contain", "Within SLA", "Reporter", "Notes"]
    for i, w in enumerate(i_col_widths, 1):
        ws3.column_dimensions[get_column_letter(i)].width = w

    ws3.merge_cells(f"A1:{get_column_letter(len(i_headers))}1")
    tc3 = ws3["A1"]
    tc3.value = f"Security Incidents — Q{quarter} {year}"
    tc3.fill  = _fill(DARK_BG)
    tc3.font  = _font(bold=True, size=13)
    tc3.alignment = _center()
    ws3.row_dimensions[1].height = 28

    for col, hdr in enumerate(i_headers, 1):
        c = ws3.cell(row=2, column=col, value=hdr)
        c.fill = _fill(HEADER_BLUE)
        c.font = _font(bold=True)
        c.alignment = _center()
        c.border = _border()

    SEV_COLORS = {
        "low":      ("2563EB", "DBEAFE"),
        "medium":   ("D97706", "FEF3C7"),
        "high":     ("EA580C", "FFF7ED"),
        "critical": ("DC2626", "FEE2E2"),
    }
    INC_STATUS_COLORS = {
        "open":      ("DC2626", "FEE2E2"),
        "contained": ("D97706", "FEF3C7"),
        "resolved":  ("2563EB", "DBEAFE"),
        "closed":    ("059669", "D1FAE5"),
    }

    for row_idx, irow in enumerate(incidents, 3):
        title, severity, status, detected_at, contained_at, contain_hours, reporter, notes = irow
        det_str  = str(detected_at)[:16].replace("T", " ") if detected_at else ""
        con_str  = str(contained_at)[:16].replace("T", " ") if contained_at else ""
        hrs_str  = f"{round(float(contain_hours), 1)}h" if contain_hours is not None else "—"

        # Check within SLA
        within_sla = "—"
        if contain_hours is not None and severity in sla_map:
            within_sla = "Yes" if float(contain_hours) <= sla_map[severity] else "No"

        row_data = [title, severity, status, det_str, con_str,
                    hrs_str, within_sla, reporter or "", notes or ""]

        for col, val in enumerate(row_data, 1):
            c = ws3.cell(row=row_idx, column=col, value=val)
            c.fill = _fill("1E293B")
            c.font = _font(color=LIGHT_SLATE)
            c.alignment = _left()
            c.border = _border()
            if col == 2:
                bg, fg = SEV_COLORS.get(str(severity), ("475569", "FFFFFF"))
                c.fill = _fill(bg)
                c.font = _font(bold=True, color=fg)
                c.alignment = _center()
            if col == 3:
                bg, fg = INC_STATUS_COLORS.get(str(status), ("475569", "FFFFFF"))
                c.fill = _fill(bg)
                c.font = _font(bold=True, color=fg)
                c.alignment = _center()
            if col == 7:
                if within_sla == "Yes":
                    c.fill = _fill("D1FAE5"); c.font = _font(bold=True, color="065F46")
                elif within_sla == "No":
                    c.fill = _fill("FEE2E2"); c.font = _font(bold=True, color="991B1B")
                c.alignment = _center()
        ws3.row_dimensions[row_idx].height = 20

    # ======================== SHEET 4: Patch Compliance ==================
    ws4 = wb.create_sheet("Patch Compliance")
    p_col_widths = [26, 26, 14, 20, 14, 26, 18]
    p_headers    = ["Hostname", "Display Name", "OS Type", "IP Address",
                    "Agent Status", "Pending Security Patches", "Compliance %"]
    for i, w in enumerate(p_col_widths, 1):
        ws4.column_dimensions[get_column_letter(i)].width = w
    ws4.merge_cells(f"A1:{get_column_letter(len(p_headers))}1")
    tc4 = ws4["A1"]
    tc4.value = f"Patch Compliance — Q{quarter} {year}"
    tc4.fill  = _fill(DARK_BG); tc4.font = _font(bold=True, size=13)
    tc4.alignment = _center(); ws4.row_dimensions[1].height = 32
    for col, hdr in enumerate(p_headers, 1):
        c = ws4.cell(row=2, column=col, value=hdr)
        c.fill = _fill(HEADER_BLUE); c.font = _font(bold=True)
        c.alignment = _center(); c.border = _border()
    ws4.row_dimensions[2].height = 22

    # Compute total patches per agent for compliance %
    # We need all patches (not just security) for a fair compliance %
    # compliant = 0 pending security patches → 100%; otherwise scale down
    _total_agents_patch = len(patch_agents)
    _compliant_count = sum(1 for prow in patch_agents if prow[5] == 0)
    overall_patch_comp_pct = round(_compliant_count / _total_agents_patch * 100, 1) if _total_agents_patch else 0.0

    # Summary row at row 2 (insert before data)
    ws4.insert_rows(3)
    ws4.merge_cells(f"A3:{get_column_letter(len(p_headers))}3")
    sum_cell = ws4["A3"]
    sum_cell.value = (
        f"Overall Patch Compliance: {overall_patch_comp_pct}%  |  "
        f"{_compliant_count} of {_total_agents_patch} endpoints fully patched  |  "
        f"Target: ≥ 95%"
    )
    comp_bg = "D1FAE5" if overall_patch_comp_pct >= 95 else ("FEF3C7" if overall_patch_comp_pct >= 80 else "FEE2E2")
    comp_fg = "065F46" if overall_patch_comp_pct >= 95 else ("92400E" if overall_patch_comp_pct >= 80 else "991B1B")
    sum_cell.fill = _fill(comp_bg)
    sum_cell.font = Font(bold=True, color=comp_fg, size=11, name="Calibri")
    sum_cell.alignment = Alignment(horizontal="center", vertical="center")
    ws4.row_dimensions[3].height = 24

    for row_idx, prow in enumerate(patch_agents, 4):
        hostname, display_name, os_type, ip_address, status, pending = prow
        pending_int = int(pending or 0)
        compliant = pending_int == 0

        # Per-endpoint compliance %: 100% if fully patched, else show pending/total context
        # We use a simple binary: 100% if compliant, 0% if any pending security patches
        # (matches the scorecard definition)
        ep_comp_pct = 100 if compliant else 0
        ep_comp_str = f"{ep_comp_pct}%"

        row_data = [hostname or "", display_name or "", os_type or "",
                    ip_address or "", status or "", pending_int, ep_comp_str]
        for col, val in enumerate(row_data, 1):
            c = ws4.cell(row=row_idx, column=col, value=val)
            c.fill = _fill("1E293B"); c.font = _font(color=LIGHT_SLATE)
            c.alignment = _left() if col <= 4 else _center()
            c.border = _border()

        # Color agent status (col 5)
        st_cell = ws4.cell(row=row_idx, column=5)
        if (status or "").lower() == "online":
            st_cell.fill = _fill("D1FAE5"); st_cell.font = _font(bold=True, color="065F46")
        elif (status or "").lower() == "offline":
            st_cell.fill = _fill("FEE2E2"); st_cell.font = _font(bold=True, color="991B1B")

        # Color pending count (col 6)
        cnt_cell = ws4.cell(row=row_idx, column=6)
        if compliant:
            cnt_cell.fill = _fill("D1FAE5"); cnt_cell.font = _font(bold=True, color="065F46")
            cnt_cell.value = "✓ None"
        elif pending_int > 10:
            cnt_cell.fill = _fill("FEE2E2"); cnt_cell.font = _font(bold=True, color="991B1B")
        else:
            cnt_cell.fill = _fill("FEF3C7"); cnt_cell.font = _font(bold=True, color="92400E")

        # Color compliance % (col 7)
        comp_cell = ws4.cell(row=row_idx, column=7)
        if compliant:
            comp_cell.fill = _fill("D1FAE5"); comp_cell.font = _font(bold=True, color="065F46")
        else:
            comp_cell.fill = _fill("FEE2E2"); comp_cell.font = _font(bold=True, color="991B1B")

        ws4.row_dimensions[row_idx].height = 22

    ws4.freeze_panes = "A5"

    # ======================== SHEET 5: Sophos Reports ====================
    # Fetch Sophos agent versions from software inventory
    try:
        sophos_ver_r = await db.execute(text("""
            SELECT a.id::text,
                   MAX(si.version) FILTER (WHERE si.name = 'Sophos Endpoint Agent') AS agent_ver,
                   MAX(si.version) FILTER (WHERE si.name = 'Sophos Health')          AS health_ver,
                   bool_or(si.name ILIKE 'Sophos%') AS has_sophos
            FROM agents a
            LEFT JOIN software_inventory si ON si.agent_id = a.id
            WHERE a.is_active = TRUE
            GROUP BY a.id
        """))
        sophos_ver_map = {str(r[0]): {"agent_ver": r[1], "health_ver": r[2], "has_sophos": r[3]}
                         for r in sophos_ver_r.fetchall()}
    except Exception:
        await db.rollback()
        sophos_ver_map = {}

    # EOL detection (reused in this sheet)
    try:
        eol_r = await db.execute(text("""
            SELECT a.hostname, a.display_name, a.os_type, a.os_version, a.ip_address, a.status,
                CASE
                    WHEN a.os_type='windows' AND a.os_version ~ '^6\\.1\\.' THEN 'Windows Server 2008 R2 / Windows 7'
                    WHEN a.os_type='windows' AND a.os_version ~ '^6\\.2\\.' THEN 'Windows 8 / Server 2012'
                    WHEN a.os_type='windows' AND a.os_version ~ '^6\\.3\\.' THEN 'Windows 8.1 / Server 2012 R2'
                    WHEN a.os_type='linux'   AND a.os_version ~ '^18\\.04'  THEN 'Ubuntu 18.04 LTS'
                    WHEN a.os_type='linux'   AND a.os_version ~ '^7\\.'     THEN 'CentOS / RHEL 7'
                    WHEN a.os_type='linux'   AND a.os_version ~ '^8\\.'     THEN 'CentOS 8'
                    WHEN a.os_type='linux'   AND a.os_version ~ '^12\\.'    THEN 'SUSE Linux Enterprise 12'
                END AS os_name,
                CASE
                    WHEN a.os_type='windows' AND a.os_version ~ '^6\\.1\\.' THEN 'January 14, 2020'
                    WHEN a.os_type='windows' AND a.os_version ~ '^6\\.2\\.' THEN 'January 12, 2016'
                    WHEN a.os_type='windows' AND a.os_version ~ '^6\\.3\\.' THEN 'October 10, 2023'
                    WHEN a.os_type='linux'   AND a.os_version ~ '^18\\.04'  THEN 'April 2023'
                    WHEN a.os_type='linux'   AND a.os_version ~ '^7\\.'     THEN 'June 30, 2024'
                    WHEN a.os_type='linux'   AND a.os_version ~ '^8\\.'     THEN 'December 31, 2021'
                    WHEN a.os_type='linux'   AND a.os_version ~ '^12\\.'    THEN 'June 30, 2024'
                END AS eol_date,
                CASE
                    WHEN a.os_type='windows' AND a.os_version ~ '^6\\.1\\.' THEN 'Critical'
                    WHEN a.os_type='windows' AND a.os_version ~ '^6\\.2\\.' THEN 'Critical'
                    WHEN a.os_type='windows' AND a.os_version ~ '^6\\.3\\.' THEN 'High'
                    WHEN a.os_type='linux'   AND a.os_version ~ '^18\\.04'  THEN 'High'
                    WHEN a.os_type='linux'   AND a.os_version ~ '^7\\.'     THEN 'High'
                    WHEN a.os_type='linux'   AND a.os_version ~ '^8\\.'     THEN 'Critical'
                    WHEN a.os_type='linux'   AND a.os_version ~ '^12\\.'    THEN 'High'
                END AS risk_level
            FROM agents a
            WHERE a.is_active = TRUE
              AND (
                (a.os_type='windows' AND a.os_version ~ '^6\\.[123]\\.')
                OR (a.os_type='linux' AND (
                    a.os_version ~ '^18\\.04' OR a.os_version ~ '^7\\.'
                    OR a.os_version ~ '^8\\.' OR a.os_version ~ '^12\\.'))
              )
            ORDER BY
                CASE WHEN a.os_type='windows' AND a.os_version ~ '^6\\.1\\.' THEN 1
                     WHEN a.os_type='linux' AND a.os_version ~ '^8\\.' THEN 1
                     ELSE 2 END, a.hostname
        """))
        eol_endpoints = eol_r.fetchall()
    except Exception:
        await db.rollback()
        eol_endpoints = []

    # Fetch Sophos-only agents: only endpoints with Sophos software installed
    try:
        sophos_agents_r = await db.execute(text("""
            SELECT
                a.hostname, a.display_name, a.os_type, a.ip_address, a.status,
                -- Sophos product string: prefer agent_security_state, else build from inventory
                COALESCE(
                    NULLIF(s.av_product, ''),
                    (SELECT string_agg(DISTINCT si2.name, ', ' ORDER BY si2.name)
                     FROM software_inventory si2
                     WHERE si2.agent_id = a.id AND si2.name ILIKE 'Sophos%')
                ) AS av_product,
                s.av_running,
                s.firewall_enabled,
                a.id::text AS agent_id
            FROM agents a
            JOIN (
                SELECT DISTINCT agent_id FROM software_inventory WHERE name ILIKE 'Sophos%'
            ) sophos_agents ON sophos_agents.agent_id = a.id
            LEFT JOIN agent_security_state s ON s.agent_id = a.id
            WHERE a.is_active = TRUE
              AND (a.exclude_from_reports IS NULL OR a.exclude_from_reports = FALSE)
            ORDER BY a.hostname
        """))
        sophos_agents = sophos_agents_r.fetchall()
    except Exception:
        await db.rollback()
        sophos_agents = []

    # Build set of Sophos agent IDs for EOL cross-reference
    sophos_agent_ids = {row[-1] for row in sophos_agents}  # agent_id is last column

    ws5 = wb.create_sheet("Sophos Reports")
    s_col_widths = [24, 24, 10, 18, 12, 26, 20, 12, 12, 18]
    s_headers    = ["Hostname", "Display Name", "OS Type", "IP Address", "Status",
                    "Sophos Product", "Agent Version", "AV Running", "Firewall",
                    "Protection Status"]
    for i, w in enumerate(s_col_widths, 1):
        ws5.column_dimensions[get_column_letter(i)].width = w

    # Title
    ws5.merge_cells(f"A1:{get_column_letter(len(s_headers))}1")
    tc5 = ws5["A1"]
    tc5.value = f"Sophos Endpoint Protection Report — Q{quarter} {year}"
    tc5.fill  = _fill(DARK_BG); tc5.font = _font(bold=True, size=13)
    tc5.alignment = _center(); ws5.row_dimensions[1].height = 28

    PROT_STATUS = {
        "intercept": ("059669", "D1FAE5", "✓ Intercept X"),
        "legacy":    ("D97706", "FEF3C7", "⚠ Legacy Protection"),
    }

    # Classify agents for summary
    s_intercept_x = 0
    s_legacy = 0
    for srow in sophos_agents:
        agent_id = srow[-1]
        sv = sophos_ver_map.get(str(agent_id), {})
        agent_ver = sv.get("agent_ver") or ""
        # Intercept X: version 2025.x or 2026.x; Legacy: older version prefix
        if agent_ver.startswith("202"):
            s_intercept_x += 1
        else:
            s_legacy += 1

    ws5.merge_cells(f"A2:{get_column_letter(len(s_headers))}2")
    sum5 = ws5["A2"]
    sum5.value = (
        f"Total Sophos Endpoints: {len(sophos_agents)}  |  "
        f"Sophos Intercept X: {s_intercept_x}  |  "
        f"Sophos Legacy: {s_legacy}"
    )
    sum5.fill = _fill(MED_SLATE); sum5.font = _font(bold=True, color=LIGHT_SLATE, size=10)
    sum5.alignment = Alignment(horizontal="center", vertical="center")
    ws5.row_dimensions[2].height = 22

    # Header
    for col, hdr in enumerate(s_headers, 1):
        c = ws5.cell(row=3, column=col, value=hdr)
        c.fill = _fill(HEADER_BLUE); c.font = _font(bold=True)
        c.alignment = _center(); c.border = _border()
    ws5.row_dimensions[3].height = 22

    for row_idx, srow in enumerate(sophos_agents, 4):
        hostname, display_name, os_type, ip_address, status, \
            av_product, av_running, firewall_enabled, agent_id = srow

        sv = sophos_ver_map.get(str(agent_id), {})
        agent_ver_str = sv.get("agent_ver") or ""

        # Intercept X: agent version starts with 202x; Legacy: older
        if agent_ver_str.startswith("202"):
            prot_key = "intercept"
        else:
            prot_key = "legacy"
        prot_fg, prot_bg, prot_text = PROT_STATUS[prot_key]

        prod = av_product or "Sophos"
        row_data = [
            hostname or "", display_name or "", os_type or "", ip_address or "", status or "",
            prod, agent_ver_str,
            "Yes" if av_running else ("No" if av_running is False else "—"),
            "Yes" if firewall_enabled else ("No" if firewall_enabled is False else "—"),
            prot_text,
        ]
        for col, val in enumerate(row_data, 1):
            c = ws5.cell(row=row_idx, column=col, value=val)
            c.fill = _fill("1E293B"); c.font = _font(color=LIGHT_SLATE)
            c.alignment = _left() if col <= 5 else _center()
            c.border = _border()

        # Status (col 5)
        st_c = ws5.cell(row=row_idx, column=5)
        if (status or "").lower() == "online":
            st_c.fill = _fill("D1FAE5"); st_c.font = _font(bold=True, color="065F46")
        elif (status or "").lower() == "offline":
            st_c.fill = _fill("FEE2E2"); st_c.font = _font(bold=True, color="991B1B")
        st_c.alignment = _center()

        # AV Running (col 8)
        av_c = ws5.cell(row=row_idx, column=8)
        if av_running is True:
            av_c.fill = _fill("D1FAE5"); av_c.font = _font(bold=True, color="065F46")
        elif av_running is False:
            av_c.fill = _fill("FEE2E2"); av_c.font = _font(bold=True, color="991B1B")

        # Firewall (col 9)
        fw_c = ws5.cell(row=row_idx, column=9)
        if firewall_enabled is True:
            fw_c.fill = _fill("D1FAE5"); fw_c.font = _font(bold=True, color="065F46")
        elif firewall_enabled is False:
            fw_c.fill = _fill("FEE2E2"); fw_c.font = _font(bold=True, color="991B1B")

        # Protection status (col 10)
        ps_c = ws5.cell(row=row_idx, column=10)
        ps_c.fill = _fill(prot_bg); ps_c.font = _font(bold=True, color=prot_fg)
        ps_c.alignment = _center()

        ws5.row_dimensions[row_idx].height = 20

    ws5.freeze_panes = "A4"

    # ---- EOL section: only Sophos-managed endpoints that are EOL ----
    sophos_eol_endpoints = [e for e in eol_endpoints if str(e[0]) in
                            # match by hostname against sophos agent hostnames
                            {row[0] for row in sophos_agents}]

    eol_start = len(sophos_agents) + 6  # gap of 2 rows

    # Section divider
    ws5.merge_cells(f"A{eol_start - 1}:{get_column_letter(len(s_headers))}{eol_start - 1}")
    div = ws5[f"A{eol_start - 1}"]
    div.value = f"END OF LIFE ENDPOINTS  ({len(sophos_eol_endpoints)} Sophos-managed device(s) — no longer receiving security patches)"
    div.fill = _fill("7F1D1D"); div.font = _font(bold=True, color="FCA5A5", size=11)
    div.alignment = Alignment(horizontal="center", vertical="center")
    ws5.row_dimensions[eol_start - 1].height = 26

    # EOL headers
    eol_h = ["Hostname", "Display Name", "OS Type", "OS Version",
              "IP Address", "Status", "EOL OS Name", "EOL Date", "Risk Level", ""]
    for col, hdr in enumerate(eol_h, 1):
        c = ws5.cell(row=eol_start, column=col, value=hdr)
        c.fill = _fill("991B1B"); c.font = _font(bold=True, color="FEE2E2")
        c.alignment = _center(); c.border = _border()
    ws5.row_dimensions[eol_start].height = 20

    EOL_RISK_COLORS = {
        "Critical": ("DC2626", "FEE2E2"),
        "High":     ("EA580C", "FFF7ED"),
        "Medium":   ("D97706", "FEF3C7"),
    }

    for i, erow in enumerate(sophos_eol_endpoints, 1):
        r = eol_start + i
        hostname, display_name, os_type, os_version, ip_address, status, \
            os_name, eol_date, risk_level = erow
        row_data = [hostname or "", display_name or "", os_type or "", os_version or "",
                    ip_address or "", status or "", os_name or "", eol_date or "", risk_level or "", ""]
        for col, val in enumerate(row_data, 1):
            c = ws5.cell(row=r, column=col, value=val)
            c.fill = _fill("1E1010"); c.font = _font(color="FCA5A5")
            c.alignment = _left() if col <= 5 else _center()
            c.border = _border()
        # Status col
        st_c = ws5.cell(row=r, column=6)
        if (status or "").lower() == "online":
            st_c.fill = _fill("D1FAE5"); st_c.font = _font(bold=True, color="065F46")
        elif (status or "").lower() == "offline":
            st_c.fill = _fill("FEE2E2"); st_c.font = _font(bold=True, color="991B1B")
        st_c.alignment = _center()
        # EOL OS name col
        eol_c = ws5.cell(row=r, column=7)
        eol_c.fill = _fill("3B1515"); eol_c.font = _font(bold=True, color="FCA5A5")
        eol_c.alignment = _center()
        # Risk col
        risk_c = ws5.cell(row=r, column=9)
        bg, fg = EOL_RISK_COLORS.get(str(risk_level), ("475569", "FFFFFF"))
        risk_c.fill = _fill(bg); risk_c.font = _font(bold=True, color=fg)
        risk_c.alignment = _center()
        ws5.row_dimensions[r].height = 20

    if not sophos_eol_endpoints:
        r = eol_start + 1
        ws5.merge_cells(f"A{r}:{get_column_letter(len(s_headers))}{r}")
        nc = ws5[f"A{r}"]
        nc.value = "✓ No end-of-life Sophos-managed endpoints detected"
        nc.fill = _fill("D1FAE5"); nc.font = _font(bold=True, color="065F46")
        nc.alignment = Alignment(horizontal="center", vertical="center")

    # ── OS Lifecycle data ──────────────────────────────────────────────────────
    # Tuple: (display_name, release, mainstream_end, extended_end, esu_end, esm_ltss_end, status)
    # status: "Active" | "EOL" | "EOL+ESU" | "EOL+ESM" | "LTSS"
    _TODAY = date.today().isoformat()

    _WIN_LC = {
        "windows server 2003":    ("Windows Server 2003",      "2003-04-24","2010-07-13","2015-07-14",None,None,"EOL"),
        "windows server 2008 r2": ("Windows Server 2008 R2",   "2009-10-22","2015-01-13","2020-01-14","2024-01-09",None,"EOL"),
        "windows server 2008":    ("Windows Server 2008",      "2008-02-27","2015-01-13","2020-01-14",None,None,"EOL"),
        "windows server 2012 r2": ("Windows Server 2012 R2",   "2013-11-25","2018-10-09","2023-10-10","2026-10-13",None,"EOL+ESU"),
        "windows server 2012":    ("Windows Server 2012",      "2012-09-04","2018-10-09","2023-10-10","2026-10-13",None,"EOL+ESU"),
        "windows server 2016":    ("Windows Server 2016",      "2016-10-12","2022-01-11","2027-01-12",None,None,"Active"),
        "windows server 2019":    ("Windows Server 2019",      "2018-11-13","2024-01-09","2029-01-09",None,None,"Active"),
        "windows server 2022":    ("Windows Server 2022",      "2021-08-18","2026-10-13","2031-10-14",None,None,"Active"),
        "windows server 2025":    ("Windows Server 2025",      "2024-11-01","2029-10-09","2034-10-10",None,None,"Active"),
        "windows 7":              ("Windows 7",                "2009-10-22","2015-01-13","2020-01-14","2023-01-10",None,"EOL"),
        "windows 8.1":            ("Windows 8.1",              "2013-10-17","2018-01-09","2023-01-10",None,None,"EOL"),
        "windows 8":              ("Windows 8",                "2012-10-26","2016-01-12","2016-01-12",None,None,"EOL"),
        "windows 10 ltsb 2016":   ("Windows 10 LTSB 2016",    "2016-08-02",None,"2026-10-13",None,None,"Active"),
        "windows 10 ltsc 2019":   ("Windows 10 LTSC 2019",    "2018-11-13",None,"2029-01-09",None,None,"Active"),
        "windows 10 ltsc 2021":   ("Windows 10 LTSC 2021",    "2021-11-16",None,"2027-01-12",None,None,"Active"),
        "windows 10":             ("Windows 10",               "2015-07-29",None,"2025-10-14",None,None,"EOL"),
        "windows 11":             ("Windows 11",               "2021-10-05",None,"2026-10-14",None,None,"Active"),
    }
    _LIN_LC = {
        "ubuntu 14.04": ("Ubuntu 14.04 LTS (Trusty)","2014-04-17","2019-04-30","2024-04-30",None,"2024-04-30","EOL"),
        "ubuntu 16.04": ("Ubuntu 16.04 LTS (Xenial)","2016-04-21","2021-04-30",None,None,"2026-04-30","EOL+ESM"),
        "ubuntu 18.04": ("Ubuntu 18.04 LTS (Bionic)","2018-04-26","2023-04-30",None,None,"2028-04-30","EOL+ESM"),
        "ubuntu 20.04": ("Ubuntu 20.04 LTS (Focal)", "2020-04-23","2025-04-30",None,None,"2030-04-30","EOL+ESM"),
        "ubuntu 22.04": ("Ubuntu 22.04 LTS (Jammy)", "2022-04-21","2027-04-30",None,None,"2032-04-30","Active"),
        "ubuntu 24.04": ("Ubuntu 24.04 LTS (Noble)", "2024-04-25","2029-04-30",None,None,"2034-04-30","Active"),
        "centos 6":     ("CentOS Linux 6",           "2011-07-10","2020-11-30",None,None,None,"EOL"),
        "centos 7":     ("CentOS Linux 7",           "2014-07-07","2024-06-30",None,None,None,"EOL"),
        "centos 8":     ("CentOS Linux 8",           "2019-09-24","2021-12-31",None,None,None,"EOL"),
        "centos stream 9": ("CentOS Stream 9",       "2021-12-03","2027-05-31",None,None,None,"Active"),
        "rhel 7":       ("Red Hat Enterprise Linux 7","2014-06-10","2024-06-30",None,None,None,"EOL"),
        "rhel 8":       ("Red Hat Enterprise Linux 8","2019-05-07","2029-05-31",None,None,None,"Active"),
        "rhel 9":       ("Red Hat Enterprise Linux 9","2022-05-18","2032-05-31",None,None,None,"Active"),
        "suse 12":      ("SUSE Linux Enterprise 12", "2014-10-27","2024-10-31",None,None,"2027-10-31","LTSS"),
        "suse 15":      ("SUSE Linux Enterprise 15", "2018-07-16","2028-07-31",None,None,None,"Active"),
        "debian 9":     ("Debian 9 (Stretch)",       "2017-06-17","2022-06-30",None,None,"2025-06-30","EOL"),
        "debian 10":    ("Debian 10 (Buster)",       "2019-07-06","2024-06-30",None,None,"2026-06-30","EOL+ELTS"),
        "debian 11":    ("Debian 11 (Bullseye)",     "2021-08-14","2026-08-31",None,None,"2028-06-30","Active"),
        "debian 12":    ("Debian 12 (Bookworm)",     "2023-06-10","2028-06-10",None,None,"2030-06-10","Active"),
    }

    def _match_lc(os_name_s, os_ver_s=""):
        """Return lifecycle tuple for an OS name string, or None."""
        s = (os_name_s or "").lower()
        v = (os_ver_s or "").lower()
        if "windows" in s or "microsoft" in s:
            if "server 2025" in s: return _WIN_LC.get("windows server 2025")
            if "server 2022" in s: return _WIN_LC.get("windows server 2022")
            if "server 2019" in s: return _WIN_LC.get("windows server 2019")
            if "server 2016" in s: return _WIN_LC.get("windows server 2016")
            if "server 2012 r2" in s: return _WIN_LC.get("windows server 2012 r2")
            if "server 2012"    in s: return _WIN_LC.get("windows server 2012")
            if "server 2008 r2" in s or ("server 2008" in s and ("r2" in s or "6.1" in v)): return _WIN_LC.get("windows server 2008 r2")
            if "server 2008"    in s: return _WIN_LC.get("windows server 2008")
            if "server 2003"    in s: return _WIN_LC.get("windows server 2003")
            if "windows 11" in s: return _WIN_LC.get("windows 11")
            if "windows 10" in s or "10 pro" in s or "10 enterprise" in s or "10 home" in s:
                if "ltsb 2016" in s or "enterprise 2016 ltsb" in s: return _WIN_LC.get("windows 10 ltsb 2016")
                if "ltsc 2021" in s: return _WIN_LC.get("windows 10 ltsc 2021")
                if "ltsc 2019" in s: return _WIN_LC.get("windows 10 ltsc 2019")
                return _WIN_LC.get("windows 10")
            if "windows 8.1" in s: return _WIN_LC.get("windows 8.1")
            if "windows 8"   in s: return _WIN_LC.get("windows 8")
            if "windows 7"   in s or "6.1." in v: return _WIN_LC.get("windows 7")
        if "ubuntu" in s:
            for ver in ["24.04","22.04","20.04","18.04","16.04","14.04"]:
                if ver in s or ver in v: return _LIN_LC.get(f"ubuntu {ver}")
        if "centos" in s or "centos" in v:
            if "stream 9" in s: return _LIN_LC.get("centos stream 9")
            if "8" in s or v.startswith("8."): return _LIN_LC.get("centos 8")
            if "7" in s or v.startswith("7."): return _LIN_LC.get("centos 7")
            if "6" in s: return _LIN_LC.get("centos 6")
        if "rhel" in s or "red hat" in s:
            if "9" in s: return _LIN_LC.get("rhel 9")
            if "8" in s: return _LIN_LC.get("rhel 8")
            if "7" in s: return _LIN_LC.get("rhel 7")
        if "suse" in s:
            if "15" in s: return _LIN_LC.get("suse 15")
            if "12" in s: return _LIN_LC.get("suse 12")
        if "debian" in s:
            if "12" in s: return _LIN_LC.get("debian 12")
            if "11" in s: return _LIN_LC.get("debian 11")
            if "10" in s: return _LIN_LC.get("debian 10")
            if "9" in s:  return _LIN_LC.get("debian 9")
        return None

    def _effective_health(health_status, os_name_s, os_ver_s=""):
        """Override Sophos health status with EOL if the OS is past end-of-life."""
        lc = _match_lc(os_name_s, os_ver_s)
        if lc is None:
            return health_status or "unknown"
        st = lc[6]  # status string
        if st == "EOL":           return "end_of_life"
        if st == "EOL+ESU":       return "eol_esu"
        if st in ("EOL+ESM","EOL+ELTS"): return "eol_esm"
        if st == "LTSS":          return "ltss"
        return health_status or "unknown"

    HEALTH_COLORS = {
        "good":        ("059669", "D1FAE5", "✓ Good"),
        "bad":         ("DC2626", "FEE2E2", "✗ Bad"),
        "suspicious":  ("D97706", "FEF3C7", "⚠ Suspicious"),
        "unknown":     ("6B7280", "F3F4F6", "? Unknown"),
        "end_of_life": ("7F1D1D", "FEE2E2", "⛔ End of Life"),
        "eol_esu":     ("92400E", "FFF7ED", "⚠ EOL + ESU Active"),
        "eol_esm":     ("92400E", "FFF7ED", "⚠ EOL + ESM Active"),
        "ltss":        ("1D4ED8", "DBEAFE", "ℹ LTSS Active"),
    }

    def _write_sophos_sheet(wb_obj, sheet_title, banner_title, rows):
        """Render a Sophos agents sheet (endpoint or server) with EOL health override."""
        ws = wb_obj.create_sheet(sheet_title)
        col_widths = [26, 28, 16, 22, 20, 18, 22, 20]
        headers    = ["Hostname", "OS", "IP Address", "Health / EOL Status",
                      "Last Seen", "Tamper Protection", "Group", "Synced At"]
        for i, w in enumerate(col_widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = w

        ws.merge_cells(f"A1:{get_column_letter(len(headers))}1")
        tc = ws["A1"]
        tc.value = banner_title
        tc.fill = _fill(DARK_BG); tc.font = _font(bold=True, size=13)
        tc.alignment = _center(); ws.row_dimensions[1].height = 28

        # Count by effective health
        counts = {}
        for r in rows:
            eh = _effective_health(r[3], r[1])
            counts[eh] = counts.get(eh, 0) + 1

        summary_parts = [f"Total: {len(rows)}"]
        for key, label in [("good","Healthy"),("bad","Bad"),("suspicious","Suspicious"),
                           ("end_of_life","EOL"),("eol_esu","EOL+ESU"),
                           ("eol_esm","EOL+ESM"),("ltss","LTSS"),("unknown","Unknown")]:
            if counts.get(key, 0):
                summary_parts.append(f"{label}: {counts[key]}")

        ws.merge_cells(f"A2:{get_column_letter(len(headers))}2")
        s2 = ws["A2"]
        s2.value = "  |  ".join(summary_parts)
        s2.fill = _fill(MED_SLATE); s2.font = _font(bold=True, color=LIGHT_SLATE, size=10)
        s2.alignment = Alignment(horizontal="center", vertical="center")
        ws.row_dimensions[2].height = 22

        for col, hdr in enumerate(headers, 1):
            c = ws.cell(row=3, column=col, value=hdr)
            c.fill = _fill(HEADER_BLUE); c.font = _font(bold=True)
            c.alignment = _center(); c.border = _border()
        ws.row_dimensions[3].height = 22

        # Sort: EOL first, then bad, then suspicious, then good
        SORT_ORDER = {"end_of_life":0,"eol_esu":1,"eol_esm":1,"bad":2,"suspicious":3,"ltss":4,"unknown":5,"good":6}
        rows_sorted = sorted(rows, key=lambda r: SORT_ORDER.get(_effective_health(r[3], r[1]), 9))

        for row_idx, srow in enumerate(rows_sorted, 4):
            hostname, os_name_val, ip_address, health_status, last_seen, tamper, group, synced_at = srow
            eh = _effective_health(health_status, os_name_val)
            h_fg, h_bg, h_label = HEALTH_COLORS.get(eh, ("6B7280","F3F4F6","? Unknown"))
            last_seen_str = last_seen.strftime("%Y-%m-%d %H:%M") if last_seen else "—"
            synced_str    = synced_at.strftime("%Y-%m-%d %H:%M") if synced_at else "—"

            row_data = [
                hostname or "", os_name_val or "", ip_address or "",
                h_label, last_seen_str,
                "✓ Enabled" if tamper else "✗ Disabled",
                group or "—", synced_str,
            ]
            for col, val in enumerate(row_data, 1):
                c = ws.cell(row=row_idx, column=col, value=val)
                c.fill = _fill("1E293B"); c.font = _font(color=LIGHT_SLATE)
                c.alignment = _left() if col in (1,2,3,7) else _center()
                c.border = _border()

            # Health cell (col 4)
            hc = ws.cell(row=row_idx, column=4)
            hc.fill = _fill(h_bg); hc.font = _font(bold=True, color=h_fg)
            hc.alignment = _center()

            # Tamper protection (col 6)
            tp_c = ws.cell(row=row_idx, column=6)
            if tamper:
                tp_c.fill = _fill("D1FAE5"); tp_c.font = _font(bold=True, color="065F46")
            else:
                tp_c.fill = _fill("FEE2E2"); tp_c.font = _font(bold=True, color="991B1B")
            tp_c.alignment = _center()

            ws.row_dimensions[row_idx].height = 20

        ws.freeze_panes = "A4"
        return ws

    # Fetch all Sophos endpoints, split by Server vs Endpoint
    try:
        se_r = await db.execute(text("""
            SELECT hostname, os_name, ip_address, health_status,
                   last_seen, tamper_protection, group_name, synced_at
            FROM sophos_endpoints
            ORDER BY hostname
        """))
        se_all = se_r.fetchall()
    except Exception:
        await db.rollback()
        se_all = []

    se_endpoints = [r for r in se_all if "server" not in (r[1] or "").lower()]
    se_servers   = [r for r in se_all if "server"     in (r[1] or "").lower()]

    # ======================== SHEET 6: Sophos Endpoint Agents ===========
    _write_sophos_sheet(wb, "Sophos Endpoint Agents",
        f"Sophos Central — Endpoint Agents (Workstations) — Q{quarter} {year}",
        se_endpoints)

    # ======================== SHEET 7: Sophos Server Agents =============
    _write_sophos_sheet(wb, "Sophos Server Agents",
        f"Sophos Central — Server Agents — Q{quarter} {year}",
        se_servers)

    # ======================== SHEET 8: Sophos Incident Report ============
    try:
        sa_r = await db.execute(text("""
            SELECT severity, category, description, endpoint_hostname, raised_at
            FROM sophos_alerts
            ORDER BY
                CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                raised_at DESC
        """))
        sa_rows = sa_r.fetchall()
    except Exception:
        await db.rollback()
        sa_rows = []

    ws7 = wb.create_sheet("Sophos Incident Report")
    sa_col_widths = [12, 16, 80, 28, 20]
    sa_headers    = ["Severity", "Category", "Description", "Endpoint", "Raised At"]
    for i, w in enumerate(sa_col_widths, 1):
        ws7.column_dimensions[get_column_letter(i)].width = w

    ws7.merge_cells(f"A1:{get_column_letter(len(sa_headers))}1")
    tc7 = ws7["A1"]
    tc7.value = f"Sophos Central — Incident / Alert Report — Q{quarter} {year}"
    tc7.fill = _fill(DARK_BG); tc7.font = _font(bold=True, size=13)
    tc7.alignment = _center(); ws7.row_dimensions[1].height = 28

    # Summary banner
    sa_high   = sum(1 for r in sa_rows if (r[0] or "") == "high")
    sa_med    = sum(1 for r in sa_rows if (r[0] or "") == "medium")
    sa_low    = sum(1 for r in sa_rows if (r[0] or "") == "low")
    ws7.merge_cells(f"A2:{get_column_letter(len(sa_headers))}2")
    sum7 = ws7["A2"]
    sum7.value = (
        f"Total Alerts: {len(sa_rows)}  |  High: {sa_high}  |  "
        f"Medium: {sa_med}  |  Low: {sa_low}"
    )
    sum7.fill = _fill(MED_SLATE); sum7.font = _font(bold=True, color=LIGHT_SLATE, size=10)
    sum7.alignment = Alignment(horizontal="center", vertical="center")
    ws7.row_dimensions[2].height = 22

    for col, hdr in enumerate(sa_headers, 1):
        c = ws7.cell(row=3, column=col, value=hdr)
        c.fill = _fill(HEADER_BLUE); c.font = _font(bold=True)
        c.alignment = _center(); c.border = _border()
    ws7.row_dimensions[3].height = 22

    SEV_COLORS = {
        "high":   ("DC2626", "FEE2E2"),
        "medium": ("D97706", "FEF3C7"),
        "low":    ("2563EB", "DBEAFE"),
    }

    for row_idx, arow in enumerate(sa_rows, 4):
        severity, category, description, endpoint_hostname, raised_at = arow
        sev = (severity or "low").lower()
        raised_str = raised_at.strftime("%Y-%m-%d %H:%M") if raised_at else "—"

        row_data = [
            (severity or "low").title(),
            (category or "—").title(),
            description or "—",
            endpoint_hostname or "—",
            raised_str,
        ]
        for col, val in enumerate(row_data, 1):
            c = ws7.cell(row=row_idx, column=col, value=val)
            c.fill = _fill("1E293B"); c.font = _font(color=LIGHT_SLATE)
            c.alignment = _left() if col in (3, 4) else _center()
            c.border = _border()
            if col == 3:
                c.alignment = Alignment(horizontal="left", vertical="top", wrap_text=True)

        # Severity cell (col 1)
        sev_fg, sev_bg = SEV_COLORS.get(sev, ("6B7280", "F3F4F6"))
        sc = ws7.cell(row=row_idx, column=1)
        sc.fill = _fill(sev_bg); sc.font = _font(bold=True, color=sev_fg)
        sc.alignment = _center()

        ws7.row_dimensions[row_idx].height = 30

    if not sa_rows:
        ws7.merge_cells(f"A4:{get_column_letter(len(sa_headers))}4")
        nc = ws7["A4"]
        nc.value = "✓ No Sophos alerts recorded"
        nc.fill = _fill("D1FAE5"); nc.font = _font(bold=True, color="065F46")
        nc.alignment = Alignment(horizontal="center", vertical="center")

    ws7.freeze_panes = "A4"

    # ======================== SHEET 9: Windows Systems Lifecycle =========
    try:
        win_agents_r = await db.execute(text("""
            SELECT hostname, ip_address, os_name, os_version
            FROM agents
            WHERE os_type = 'windows' AND is_active = TRUE
            ORDER BY hostname
        """))
        win_agents_map = {r[0]: ("Kifaa", r[1], r[2], r[3]) for r in win_agents_r.fetchall() if r[0]}
    except Exception:
        await db.rollback()
        win_agents_map = {}

    try:
        win_sophos_r = await db.execute(text("""
            SELECT hostname, ip_address, os_name
            FROM sophos_endpoints
            WHERE LOWER(os_name) LIKE '%windows%' OR LOWER(os_name) LIKE '%microsoft%'
            ORDER BY hostname
        """))
        win_sophos_map = {r[0]: ("Sophos", r[1], r[2], "") for r in win_sophos_r.fetchall() if r[0]}
    except Exception:
        await db.rollback()
        win_sophos_map = {}

    win_merged = {}
    for h in sorted(set(win_agents_map) | set(win_sophos_map)):
        in_k, in_s = h in win_agents_map, h in win_sophos_map
        if in_k and in_s:
            ip   = win_sophos_map[h][1] or win_agents_map[h][1]
            os_n = win_sophos_map[h][2] or win_agents_map[h][2]
            os_v = win_agents_map[h][3]
            win_merged[h] = ("Both", ip, os_n, os_v)
        elif in_s:
            win_merged[h] = win_sophos_map[h]
        else:
            win_merged[h] = win_agents_map[h]

    STATUS_SORT = {"EOL": 0, "EOL+ESU": 1, "EOL+ESM": 1, "EOL+ELTS": 1, "LTSS": 2, "Unknown": 3, "Active": 4}
    STATUS_FILL = {
        "EOL":      ("7F1D1D", "FEE2E2"),
        "EOL+ESU":  ("92400E", "FFF7ED"),
        "EOL+ESM":  ("92400E", "FFF7ED"),
        "EOL+ELTS": ("92400E", "FFF7ED"),
        "LTSS":     ("1D4ED8", "DBEAFE"),
        "Active":   ("059669", "D1FAE5"),
        "Unknown":  ("6B7280", "F3F4F6"),
    }

    win_rows = []
    for hostname, (src, ip, os_n, os_v) in sorted(win_merged.items()):
        lc = _match_lc(os_n, os_v)
        if lc:
            display, release, mainstream, extended, esu, _esm, status = lc
        else:
            display = os_n or "Unknown"
            release = mainstream = extended = esu = "—"
            status = "Unknown"
        win_rows.append((hostname, ip or "—", display, os_n or "—", src,
                         release or "—", mainstream or "—", extended or "—",
                         esu or "—", status))
    win_rows.sort(key=lambda r: STATUS_SORT.get(r[9], 9))

    ws_win = wb.create_sheet("Windows Systems")
    win_col_widths = [26, 16, 32, 30, 8, 14, 20, 20, 14, 14]
    win_headers    = ["Hostname", "IP Address", "OS (Lifecycle)", "OS Detected",
                      "Source", "Release Date", "Mainstream Support End",
                      "Extended / EOL Date", "ESU End", "Status"]
    for i, w in enumerate(win_col_widths, 1):
        ws_win.column_dimensions[get_column_letter(i)].width = w

    ws_win.merge_cells(f"A1:{get_column_letter(len(win_headers))}1")
    tc_win = ws_win["A1"]
    tc_win.value = f"Windows Systems — Lifecycle & Support Dates — Q{quarter} {year}"
    tc_win.fill = _fill(DARK_BG); tc_win.font = _font(bold=True, size=13)
    tc_win.alignment = _center(); ws_win.row_dimensions[1].height = 28

    win_eol    = sum(1 for r in win_rows if r[9] in ("EOL", "EOL+ESU", "EOL+ESM"))
    win_active = sum(1 for r in win_rows if r[9] == "Active")
    ws_win.merge_cells(f"A2:{get_column_letter(len(win_headers))}2")
    s2_win = ws_win["A2"]
    s2_win.value = (
        f"Total: {len(win_rows)}  |  EOL / At Risk: {win_eol}  |  "
        f"Active Support: {win_active}  |  Sources: Sophos Central + Kifaa Agent inventory"
    )
    s2_win.fill = _fill(MED_SLATE); s2_win.font = _font(bold=True, color=LIGHT_SLATE, size=10)
    s2_win.alignment = Alignment(horizontal="center", vertical="center")
    ws_win.row_dimensions[2].height = 22

    for col, hdr in enumerate(win_headers, 1):
        c = ws_win.cell(row=3, column=col, value=hdr)
        c.fill = _fill(HEADER_BLUE); c.font = _font(bold=True)
        c.alignment = _center(); c.border = _border()
    ws_win.row_dimensions[3].height = 22

    for row_idx, wr in enumerate(win_rows, 4):
        hostname, ip, lc_display, os_raw, src, release, mainstream, extended, esu, status = wr
        for col, val in enumerate([hostname, ip, lc_display, os_raw, src,
                                    release, mainstream, extended, esu, status], 1):
            c = ws_win.cell(row=row_idx, column=col, value=val)
            c.fill = _fill("1E293B"); c.font = _font(color=LIGHT_SLATE)
            c.alignment = _left() if col in (1, 2, 3, 4) else _center()
            c.border = _border()
        st_fg, st_bg = STATUS_FILL.get(status, ("6B7280", "F3F4F6"))
        sc = ws_win.cell(row=row_idx, column=10)
        sc.fill = _fill(st_bg); sc.font = _font(bold=True, color=st_fg)
        sc.alignment = _center()
        ws_win.row_dimensions[row_idx].height = 20

    if not win_rows:
        ws_win.merge_cells(f"A4:{get_column_letter(len(win_headers))}4")
        nc = ws_win["A4"]
        nc.value = "No Windows systems found"
        nc.fill = _fill("D1FAE5"); nc.font = _font(bold=True, color="065F46")
        nc.alignment = Alignment(horizontal="center", vertical="center")

    ws_win.freeze_panes = "A4"

    # ======================== SHEET 10: Linux Systems Lifecycle ===========
    try:
        lin_agents_r = await db.execute(text("""
            SELECT hostname, ip_address, os_name, os_version
            FROM agents
            WHERE os_type = 'linux' AND is_active = TRUE
            ORDER BY hostname
        """))
        lin_agents_map = {r[0]: ("Kifaa", r[1], r[2], r[3]) for r in lin_agents_r.fetchall() if r[0]}
    except Exception:
        await db.rollback()
        lin_agents_map = {}

    try:
        lin_sophos_r = await db.execute(text("""
            SELECT hostname, ip_address, os_name
            FROM sophos_endpoints
            WHERE LOWER(os_name) NOT LIKE '%windows%'
              AND LOWER(os_name) NOT LIKE '%microsoft%'
            ORDER BY hostname
        """))
        lin_sophos_map = {r[0]: ("Sophos", r[1], r[2], "") for r in lin_sophos_r.fetchall() if r[0]}
    except Exception:
        await db.rollback()
        lin_sophos_map = {}

    lin_merged = {}
    for h in sorted(set(lin_agents_map) | set(lin_sophos_map)):
        in_k, in_s = h in lin_agents_map, h in lin_sophos_map
        if in_k and in_s:
            ip   = lin_sophos_map[h][1] or lin_agents_map[h][1]
            os_n = lin_sophos_map[h][2] or lin_agents_map[h][2]
            os_v = lin_agents_map[h][3]
            lin_merged[h] = ("Both", ip, os_n, os_v)
        elif in_s:
            lin_merged[h] = lin_sophos_map[h]
        else:
            lin_merged[h] = lin_agents_map[h]

    lin_rows = []
    for hostname, (src, ip, os_n, os_v) in sorted(lin_merged.items()):
        lc = _match_lc(os_n, os_v)
        if lc:
            display, release, mainstream, _ext, _esu, esm_ltss, status = lc
        else:
            display = os_n or "Unknown"
            release = mainstream = esm_ltss = "—"
            status = "Unknown"
        lin_rows.append((hostname, ip or "—", display, os_n or "—", src,
                         release or "—", mainstream or "—",
                         esm_ltss or "—", status))
    lin_rows.sort(key=lambda r: STATUS_SORT.get(r[8], 9))

    ws_lin = wb.create_sheet("Linux Systems")
    lin_col_widths = [26, 16, 32, 30, 8, 14, 22, 22, 14]
    lin_headers    = ["Hostname", "IP Address", "OS (Lifecycle)", "OS Detected",
                      "Source", "Release Date", "Standard Support End",
                      "ESM / LTSS / ELTS End", "Status"]
    for i, w in enumerate(lin_col_widths, 1):
        ws_lin.column_dimensions[get_column_letter(i)].width = w

    ws_lin.merge_cells(f"A1:{get_column_letter(len(lin_headers))}1")
    tc_lin = ws_lin["A1"]
    tc_lin.value = f"Linux Systems — Lifecycle & Support Dates — Q{quarter} {year}"
    tc_lin.fill = _fill(DARK_BG); tc_lin.font = _font(bold=True, size=13)
    tc_lin.alignment = _center(); ws_lin.row_dimensions[1].height = 28

    lin_eol    = sum(1 for r in lin_rows if r[8] in ("EOL", "EOL+ESM", "EOL+ELTS"))
    lin_active = sum(1 for r in lin_rows if r[8] == "Active")
    ws_lin.merge_cells(f"A2:{get_column_letter(len(lin_headers))}2")
    s2_lin = ws_lin["A2"]
    s2_lin.value = (
        f"Total: {len(lin_rows)}  |  EOL / At Risk: {lin_eol}  |  "
        f"Active Support: {lin_active}  |  Sources: Sophos Central + Kifaa Agent inventory"
    )
    s2_lin.fill = _fill(MED_SLATE); s2_lin.font = _font(bold=True, color=LIGHT_SLATE, size=10)
    s2_lin.alignment = Alignment(horizontal="center", vertical="center")
    ws_lin.row_dimensions[2].height = 22

    for col, hdr in enumerate(lin_headers, 1):
        c = ws_lin.cell(row=3, column=col, value=hdr)
        c.fill = _fill(HEADER_BLUE); c.font = _font(bold=True)
        c.alignment = _center(); c.border = _border()
    ws_lin.row_dimensions[3].height = 22

    for row_idx, lr in enumerate(lin_rows, 4):
        hostname, ip, lc_display, os_raw, src, release, mainstream, esm_ltss_val, status = lr
        for col, val in enumerate([hostname, ip, lc_display, os_raw, src,
                                    release, mainstream, esm_ltss_val, status], 1):
            c = ws_lin.cell(row=row_idx, column=col, value=val)
            c.fill = _fill("1E293B"); c.font = _font(color=LIGHT_SLATE)
            c.alignment = _left() if col in (1, 2, 3, 4) else _center()
            c.border = _border()
        st_fg, st_bg = STATUS_FILL.get(status, ("6B7280", "F3F4F6"))
        sc = ws_lin.cell(row=row_idx, column=9)
        sc.fill = _fill(st_bg); sc.font = _font(bold=True, color=st_fg)
        sc.alignment = _center()
        ws_lin.row_dimensions[row_idx].height = 20

    if not lin_rows:
        ws_lin.merge_cells(f"A4:{get_column_letter(len(lin_headers))}4")
        nc = ws_lin["A4"]
        nc.value = "No Linux systems found"
        nc.fill = _fill("D1FAE5"); nc.font = _font(bold=True, color="065F46")
        nc.alignment = Alignment(horizontal="center", vertical="center")

    ws_lin.freeze_panes = "A4"

    # ======================== SHEET 11: Vulnerability Management =========
    ws8 = wb.create_sheet("Vulnerability Management")
    v_col_widths = [22, 18, 30, 16, 10, 8, 12, 20, 20, 12]
    v_headers    = ["Hostname", "CVE ID", "Software", "Version",
                    "Severity", "CVSS", "Status",
                    "Detected", "Remediated", "Days Open"]
    for i, w in enumerate(v_col_widths, 1):
        ws8.column_dimensions[get_column_letter(i)].width = w
    ws8.merge_cells(f"A1:{get_column_letter(len(v_headers))}1")
    tc8 = ws8["A1"]
    tc8.value = f"Vulnerability Management — Q{quarter} {year}"
    tc8.fill  = _fill(DARK_BG); tc8.font = _font(bold=True, size=13)
    tc8.alignment = _center(); ws8.row_dimensions[1].height = 28
    for col, hdr in enumerate(v_headers, 1):
        c = ws8.cell(row=2, column=col, value=hdr)
        c.fill = _fill(HEADER_BLUE); c.font = _font(bold=True)
        c.alignment = _center(); c.border = _border()
    VULN_SEV_COLORS = {
        "low":      ("2563EB", "DBEAFE"),
        "medium":   ("D97706", "FEF3C7"),
        "high":     ("EA580C", "FFF7ED"),
        "critical": ("DC2626", "FEE2E2"),
    }
    for row_idx, vrow in enumerate(vulns, 3):
        hostname, cve_id, software_name, software_version, \
            severity, cvss_score, vstatus, detected_at, remediated_at, days_open = vrow
        row_data = [
            hostname or "", cve_id or "", software_name or "", software_version or "",
            severity or "", str(cvss_score) if cvss_score is not None else "",
            vstatus or "",
            str(detected_at)[:10] if detected_at else "",
            str(remediated_at)[:10] if remediated_at else "",
            str(days_open) if days_open is not None else "",
        ]
        for col, val in enumerate(row_data, 1):
            c = ws8.cell(row=row_idx, column=col, value=val)
            c.fill = _fill("1E293B"); c.font = _font(color=LIGHT_SLATE)
            c.alignment = _left() if col <= 3 else _center()
            c.border = _border()
        # Color severity (col 5)
        sev_c = ws8.cell(row=row_idx, column=5)
        bg, fg = VULN_SEV_COLORS.get(str(severity), ("475569", "FFFFFF"))
        sev_c.fill = _fill(bg); sev_c.font = _font(bold=True, color=fg)
        sev_c.alignment = _center()
        ws8.row_dimensions[row_idx].height = 18

    # ======================== SHEET 12: Phishing Simulation ==============
    ws9 = wb.create_sheet("Phishing Simulation")
    ph_col_widths = [28, 28, 14, 14, 16, 14, 20, 20, 20, 20, 16]
    ph_headers    = ["Campaign", "Email", "First Name", "Last Name", "Department",
                     "Send Status", "Sent At", "Opened At", "Clicked At",
                     "Reported At", "Hours to Click"]
    for i, w in enumerate(ph_col_widths, 1):
        ws9.column_dimensions[get_column_letter(i)].width = w
    ws9.merge_cells(f"A1:{get_column_letter(len(ph_headers))}1")
    tc9 = ws9["A1"]
    tc9.value = f"Phishing Simulation — Q{quarter} {year}"
    tc9.fill  = _fill(DARK_BG); tc9.font = _font(bold=True, size=13)
    tc9.alignment = _center(); ws9.row_dimensions[1].height = 28
    for col, hdr in enumerate(ph_headers, 1):
        c = ws9.cell(row=2, column=col, value=hdr)
        c.fill = _fill(HEADER_BLUE); c.font = _font(bold=True)
        c.alignment = _center(); c.border = _border()
    for row_idx, phrow in enumerate(phishing_targets, 3):
        campaign, email, first_name, last_name, department, send_status, \
            sent_at, opened_at, clicked_at, reported_at, hours_to_click = phrow
        row_data = [
            campaign or "", email or "", first_name or "", last_name or "",
            department or "", send_status or "",
            str(sent_at)[:16].replace("T", " ") if sent_at else "",
            str(opened_at)[:16].replace("T", " ") if opened_at else "",
            str(clicked_at)[:16].replace("T", " ") if clicked_at else "",
            str(reported_at)[:16].replace("T", " ") if reported_at else "",
            str(hours_to_click) if hours_to_click is not None else "",
        ]
        for col, val in enumerate(row_data, 1):
            c = ws9.cell(row=row_idx, column=col, value=val)
            c.fill = _fill("1E293B"); c.font = _font(color=LIGHT_SLATE)
            c.alignment = _left() if col <= 5 else _center()
            c.border = _border()
        # Highlight clicked (col 9) in red
        if clicked_at:
            cc = ws9.cell(row=row_idx, column=9)
            cc.fill = _fill("FEE2E2"); cc.font = _font(bold=True, color="991B1B")
        # Highlight reported (col 10) in green
        if reported_at:
            rc = ws9.cell(row=row_idx, column=10)
            rc.fill = _fill("D1FAE5"); rc.font = _font(bold=True, color="065F46")
        ws9.row_dimensions[row_idx].height = 18

    # ------------------------------------------------------------------
    # Stream output
    # ------------------------------------------------------------------
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    filename = f"quarterly_report_Q{quarter}_{year}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
