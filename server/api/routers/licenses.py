"""
License Management router — tracks software activation status per agent.
Agents report license info on each inventory cycle.
"""
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Header
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.database import get_db
from api.services.auth import get_current_user, get_agent_by_api_key

router = APIRouter(prefix="/licenses", tags=["Licenses"])

async def _ensure_tables(db: AsyncSession):
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS agent_licenses (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            software_name TEXT NOT NULL, license_type TEXT, activation_status TEXT,
            partial_key TEXT, expiry_date TIMESTAMPTZ, license_channel TEXT,
            detected_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(agent_id, software_name)
        )
    """))
    # Patch stub tables that may be missing columns (added by compliance.py stubs previously)
    for col, defn in [
        ("license_type", "TEXT"),
        ("partial_key", "TEXT"),
        ("expiry_date", "TIMESTAMPTZ"),
        ("license_channel", "TEXT"),
        ("updated_at", "TIMESTAMPTZ DEFAULT NOW()"),
        ("detected_at", "TIMESTAMPTZ DEFAULT NOW()"),
    ]:
        try:
            await db.execute(text(f"ALTER TABLE agent_licenses ADD COLUMN IF NOT EXISTS {col} {defn}"))
        except Exception:
            await db.rollback()
    await db.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS agent_licenses_unique ON agent_licenses(agent_id, software_name)"))
    await db.execute(text("CREATE INDEX IF NOT EXISTS idx_agent_licenses_agent ON agent_licenses(agent_id)"))
    await db.execute(text("CREATE INDEX IF NOT EXISTS idx_agent_licenses_status ON agent_licenses(activation_status)"))
    await db.commit()


# ── Agent endpoint ─────────────────────────────────────────────────────────────

@router.post("/report")
async def receive_license_report(
    body: dict,
    x_api_key: str = Header(..., alias="X-API-Key"),
    db: AsyncSession = Depends(get_db),
):
    """Receive license data from an agent."""
    agent = await get_agent_by_api_key(db, x_api_key)
    if not agent:
        raise HTTPException(status_code=401, detail="Not authenticated")

    await _ensure_tables(db)

    licenses = body.get("licenses", [])
    for lic in licenses:
        expiry = lic.get("expiry_date") or None
        await db.execute(text("""
            INSERT INTO agent_licenses
                (agent_id, software_name, license_type, activation_status,
                 partial_key, expiry_date, license_channel, updated_at)
            VALUES (
                CAST(:agent_id AS uuid), :name, :type, :status,
                :key, CAST(NULLIF(:expiry, '') AS timestamptz), :channel, NOW()
            )
            ON CONFLICT (agent_id, software_name) DO UPDATE SET
                license_type = EXCLUDED.license_type,
                activation_status = EXCLUDED.activation_status,
                partial_key = EXCLUDED.partial_key,
                expiry_date = EXCLUDED.expiry_date,
                license_channel = EXCLUDED.license_channel,
                updated_at = NOW()
        """), {
            "agent_id": str(agent.id),
            "name": lic.get("software_name", ""),
            "type": lic.get("license_type", "unknown"),
            "status": lic.get("activation_status", "unknown"),
            "key": lic.get("partial_key") or "",
            "expiry": expiry or "",
            "channel": lic.get("license_channel") or "",
        })

    await db.commit()
    return {"status": "ok", "licenses_stored": len(licenses)}


# ── Query endpoints ────────────────────────────────────────────────────────────

@router.get("")
async def list_licenses(
    agent_id: Optional[str] = None,
    status: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """List all licenses across all agents, or for a specific agent."""
    await _ensure_tables(db)

    where = ["1=1"]
    params = {}
    if agent_id:
        where.append("l.agent_id = CAST(:agent_id AS uuid)")
        params["agent_id"] = agent_id
    if status:
        where.append("l.activation_status = :status")
        params["status"] = status

    result = await db.execute(text(f"""
        SELECT
            l.id, l.agent_id, a.hostname, a.display_name, a.ip_address, a.os_type,
            l.software_name, l.license_type, l.activation_status,
            l.partial_key, l.expiry_date, l.license_channel, l.updated_at
        FROM agent_licenses l
        JOIN agents a ON a.id = l.agent_id
        WHERE a.exclude_from_reports = FALSE AND {' AND '.join(where)}
        ORDER BY a.hostname, l.software_name
    """), params)

    cols = ["id", "agent_id", "hostname", "display_name", "ip_address", "os_type",
            "software_name", "license_type", "activation_status",
            "partial_key", "expiry_date", "license_channel", "updated_at"]
    return [dict(zip(cols, row)) for row in result.fetchall()]


@router.get("/summary")
async def license_summary(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Counts by activation status + expiring soon."""
    await _ensure_tables(db)

    result = await db.execute(text("""
        SELECT
            activation_status,
            COUNT(*) AS total,
            COUNT(DISTINCT agent_id) AS agents
        FROM agent_licenses
        GROUP BY activation_status
        ORDER BY activation_status
    """))
    rows = result.fetchall()
    by_status = {r[0]: {"total": r[1], "agents": r[2]} for r in rows}

    # Expiring within 30 days
    exp_result = await db.execute(text("""
        SELECT COUNT(*) FROM agent_licenses
        WHERE expiry_date IS NOT NULL
          AND expiry_date > NOW()
          AND expiry_date <= NOW() + INTERVAL '30 days'
    """))
    expiring_soon = exp_result.scalar() or 0

    # Already expired
    expired_result = await db.execute(text("""
        SELECT COUNT(*) FROM agent_licenses
        WHERE expiry_date IS NOT NULL AND expiry_date < NOW()
    """))
    already_expired = expired_result.scalar() or 0

    return {
        "by_status": by_status,
        "expiring_soon": expiring_soon,
        "already_expired": already_expired,
        "total": sum(r[1] for r in rows),
    }


@router.get("/{agent_id}")
async def list_licenses_for_agent(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    return await list_licenses(agent_id=agent_id, db=db, _=_)
