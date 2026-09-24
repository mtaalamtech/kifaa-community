"""
SAP Business One integration data router.
Returns cached data from sap_users and sap_employees tables.
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.database import get_db
from api.services.auth import get_current_user

router = APIRouter(prefix="/integrations/sap", tags=["Integrations - SAP"])


@router.get("/dashboard")
async def sap_dashboard(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    plugin = await db.execute(text("""
        SELECT status, is_enabled, last_sync_at, last_error
        FROM integration_plugins WHERE plugin_type = 'sap'
    """))
    p = plugin.fetchone()

    user_stats = await db.execute(text("""
        SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE NOT locked AND active) AS active,
            COUNT(*) FILTER (WHERE locked) AS locked,
            COUNT(*) FILTER (WHERE superuser) AS superusers,
            COUNT(*) FILTER (WHERE license_type = 'professional') AS professional,
            COUNT(*) FILTER (WHERE license_type = 'financial') AS financial,
            COUNT(*) FILTER (WHERE license_type = 'logistics') AS logistics,
            COUNT(*) FILTER (WHERE license_type = 'unknown' OR license_type IS NULL) AS unknown_license
        FROM sap_users
    """))
    us = user_stats.fetchone()

    emp_stats = await db.execute(text("""
        SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE active) AS active,
            COUNT(*) FILTER (WHERE NOT active) AS inactive,
            COUNT(*) FILTER (WHERE sap_internal_key IS NOT NULL) AS with_sap_access,
            COUNT(*) FILTER (WHERE sap_internal_key IS NULL) AS no_sap_access
        FROM sap_employees
    """))
    es = emp_stats.fetchone()

    dept_breakdown = await db.execute(text("""
        SELECT department_name, COUNT(*) AS cnt
        FROM sap_users
        WHERE department_name IS NOT NULL AND department_name != ''
        GROUP BY department_name
        ORDER BY cnt DESC
        LIMIT 15
    """))

    inactive_users = await db.execute(text("""
        SELECT COUNT(*) AS cnt
        FROM sap_users
        WHERE active AND NOT locked
          AND last_logout_date IS NOT NULL
          AND last_logout_date < CURRENT_DATE - INTERVAL '90 days'
    """))
    inactive_cnt = inactive_users.fetchone()

    return {
        "plugin": {
            "status": p.status if p else "disconnected",
            "is_enabled": p.is_enabled if p else False,
            "last_sync_at": p.last_sync_at.isoformat() if p and p.last_sync_at else None,
            "last_error": p.last_error if p else None,
        },
        "users": {
            "total": us.total or 0,
            "active": us.active or 0,
            "locked": us.locked or 0,
            "superusers": us.superusers or 0,
            "inactive_90d": inactive_cnt.cnt or 0,
        },
        "licenses": {
            "professional": us.professional or 0,
            "financial": us.financial or 0,
            "logistics": us.logistics or 0,
            "unknown": us.unknown_license or 0,
        },
        "employees": {
            "total": es.total or 0,
            "active": es.active or 0,
            "inactive": es.inactive or 0,
            "with_sap_access": es.with_sap_access or 0,
            "no_sap_access": es.no_sap_access or 0,
        },
        "departments": [
            {"name": r.department_name, "count": r.cnt}
            for r in dept_breakdown.fetchall()
        ],
    }


@router.get("/users")
async def list_sap_users(
    search: str = None,
    license_type: str = None,
    locked: str = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    conditions = []
    params = {}
    if search:
        conditions.append("(user_code ILIKE :s OR user_name ILIKE :s OR email ILIKE :s OR department_name ILIKE :s)")
        params["s"] = f"%{search}%"
    if license_type:
        conditions.append("license_type = :lt")
        params["lt"] = license_type
    if locked == "true":
        conditions.append("locked = TRUE")
    elif locked == "false":
        conditions.append("locked = FALSE")

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    rows = await db.execute(text(f"""
        SELECT internal_key, user_code, user_name, email,
               locked, superuser, group_name, last_logout_date,
               department_id, department_name,
               employee_id, employee_first_name, employee_last_name,
               active, job_title, mobile_phone, license_type, synced_at
        FROM sap_users
        {where}
        ORDER BY
            CASE WHEN NOT active OR locked THEN 1 ELSE 0 END,
            user_name
        LIMIT 500
    """), params)
    return [
        {
            "internal_key": r.internal_key,
            "user_code": r.user_code,
            "user_name": r.user_name,
            "email": r.email,
            "locked": r.locked,
            "superuser": r.superuser,
            "group_name": r.group_name,
            "last_logout_date": r.last_logout_date.isoformat() if r.last_logout_date else None,
            "department_id": r.department_id,
            "department_name": r.department_name,
            "employee_id": r.employee_id,
            "employee_first_name": r.employee_first_name,
            "employee_last_name": r.employee_last_name,
            "active": r.active,
            "job_title": r.job_title,
            "mobile_phone": r.mobile_phone,
            "license_type": r.license_type or "unknown",
            "synced_at": r.synced_at.isoformat() if r.synced_at else None,
        }
        for r in rows.fetchall()
    ]


@router.put("/users/{internal_key}/license")
async def update_user_license(
    internal_key: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Manually override the license type for a SAP user."""
    body = await request.json()
    license_type = (body.get("license_type") or "").lower().strip()
    if license_type not in ("professional", "financial", "logistics", "unknown"):
        raise HTTPException(status_code=400, detail="Invalid license_type")
    result = await db.execute(text("""
        UPDATE sap_users SET license_type = :lt
        WHERE internal_key = :ik
    """), {"lt": license_type, "ik": internal_key})
    await db.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="User not found")
    return {"ok": True}


@router.get("/employees")
async def list_sap_employees(
    search: str = None,
    active: str = None,
    has_sap_access: str = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    conditions = []
    params = {}
    if search:
        conditions.append("(first_name ILIKE :s OR last_name ILIKE :s OR email ILIKE :s OR department_name ILIKE :s OR job_title ILIKE :s)")
        params["s"] = f"%{search}%"
    if active == "true":
        conditions.append("active = TRUE")
    elif active == "false":
        conditions.append("active = FALSE")
    if has_sap_access == "true":
        conditions.append("sap_internal_key IS NOT NULL")
    elif has_sap_access == "false":
        conditions.append("sap_internal_key IS NULL")

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    rows = await db.execute(text(f"""
        SELECT employee_id, first_name, last_name, email,
               department_id, department_name, job_title, active,
               start_date, termination_date, mobile_phone, office_phone,
               sap_user_code, sap_internal_key, synced_at
        FROM sap_employees
        {where}
        ORDER BY
            CASE WHEN NOT active THEN 1 ELSE 0 END,
            last_name, first_name
        LIMIT 500
    """), params)
    return [
        {
            "employee_id": r.employee_id,
            "first_name": r.first_name,
            "last_name": r.last_name,
            "email": r.email,
            "department_id": r.department_id,
            "department_name": r.department_name,
            "job_title": r.job_title,
            "active": r.active,
            "start_date": r.start_date.isoformat() if r.start_date else None,
            "termination_date": r.termination_date.isoformat() if r.termination_date else None,
            "mobile_phone": r.mobile_phone,
            "office_phone": r.office_phone,
            "sap_user_code": r.sap_user_code,
            "sap_internal_key": r.sap_internal_key,
            "has_sap_access": r.sap_internal_key is not None,
            "synced_at": r.synced_at.isoformat() if r.synced_at else None,
        }
        for r in rows.fetchall()
    ]
