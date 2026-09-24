"""
Office 365 integration data router.
Returns cached data from o365_users and o365_licenses tables.
"""
from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.database import get_db
from api.services.auth import get_current_user

router = APIRouter(prefix="/integrations/o365", tags=["Integrations - O365"])


@router.get("/dashboard")
async def o365_dashboard(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    plugin = await db.execute(text("""
        SELECT status, is_enabled, last_sync_at, last_error
        FROM integration_plugins WHERE plugin_type = 'o365'
    """))
    p = plugin.fetchone()

    users = await db.execute(text("""
        SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE account_enabled = TRUE) AS active,
            COUNT(*) FILTER (WHERE account_enabled = FALSE) AS disabled,
            COUNT(*) FILTER (WHERE
                account_enabled = TRUE AND
                (last_sign_in IS NULL OR last_sign_in < NOW() - INTERVAL '30 days')
            ) AS inactive_30d
        FROM o365_users
    """))
    u = users.fetchone()

    licenses = await db.execute(text("""
        SELECT SUM(total_units) AS total, SUM(consumed_units) AS consumed
        FROM o365_licenses
    """))
    lc = licenses.fetchone()

    return {
        "plugin": {
            "status": p.status if p else "disconnected",
            "is_enabled": p.is_enabled if p else False,
            "last_sync_at": p.last_sync_at.isoformat() if p and p.last_sync_at else None,
            "last_error": p.last_error if p else None,
        },
        "users": {
            "total": u.total or 0,
            "active": u.active or 0,
            "disabled": u.disabled or 0,
            "inactive_30d": u.inactive_30d or 0,
        },
        "licenses": {
            "total": int(lc.total or 0),
            "consumed": int(lc.consumed or 0),
            "unused": int((lc.total or 0) - (lc.consumed or 0)),
        },
    }


@router.get("/users")
async def list_users(
    enabled_only: bool = False,
    inactive_only: bool = False,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    filters = []
    if enabled_only:
        filters.append("account_enabled = TRUE")
    if inactive_only:
        filters.append("(last_sign_in IS NULL OR last_sign_in < NOW() - INTERVAL '30 days')")
        filters.append("account_enabled = TRUE")
    where = ("WHERE " + " AND ".join(filters)) if filters else ""
    rows = await db.execute(text(f"""
        SELECT user_id, display_name, email, account_enabled,
               last_sign_in, assigned_licenses
        FROM o365_users
        {where}
        ORDER BY display_name
        LIMIT 1000
    """))
    return [
        {
            "user_id": r.user_id,
            "display_name": r.display_name,
            "email": r.email,
            "account_enabled": r.account_enabled,
            "last_sign_in": r.last_sign_in.isoformat() if r.last_sign_in else None,
            "assigned_licenses": r.assigned_licenses or [],
        }
        for r in rows.fetchall()
    ]


@router.get("/licenses")
async def list_licenses(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    rows = await db.execute(text("""
        SELECT sku_id, sku_name, total_units, consumed_units,
               CASE WHEN total_units > 0
                    THEN ROUND((consumed_units::numeric / total_units) * 100, 1)
                    ELSE 0 END AS usage_pct
        FROM o365_licenses
        ORDER BY consumed_units DESC
    """))
    return [
        {
            "sku_id": r.sku_id,
            "sku_name": r.sku_name,
            "total_units": r.total_units,
            "consumed_units": r.consumed_units,
            "unused": (r.total_units or 0) - (r.consumed_units or 0),
            "usage_pct": float(r.usage_pct or 0),
        }
        for r in rows.fetchall()
    ]
