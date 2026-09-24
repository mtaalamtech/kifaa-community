"""Nutanix Prism integration data router."""
from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.database import get_db
from api.services.auth import get_current_user

router = APIRouter(prefix="/integrations/nutanix", tags=["Integrations - Nutanix"])


@router.get("/dashboard")
async def nutanix_dashboard(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    plugin = await db.execute(text(
        "SELECT status, is_enabled, last_sync_at, last_error FROM integration_plugins WHERE plugin_type='nutanix'"
    ))
    p = plugin.fetchone()

    clusters = await db.execute(text("SELECT COUNT(*) AS total FROM nutanix_clusters"))
    cl = clusters.fetchone()

    vms = await db.execute(text("""
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE power_state = 'ON') AS powered_on,
               COUNT(*) FILTER (WHERE power_state = 'OFF') AS powered_off,
               SUM(num_vcpus) AS total_vcpus,
               SUM(memory_mb) AS total_memory_mb
        FROM nutanix_vms
    """))
    v = vms.fetchone()

    hosts = await db.execute(text("""
        SELECT COUNT(*) AS total,
               SUM(cpu_capacity_hz) AS total_cpu_hz,
               SUM(memory_capacity_mb) AS total_mem_mb
        FROM nutanix_hosts
    """))
    h = hosts.fetchone()

    alerts = await db.execute(text("""
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE severity = 'CRITICAL') AS critical,
               COUNT(*) FILTER (WHERE severity = 'WARNING') AS warning
        FROM nutanix_alerts
    """))
    al = alerts.fetchone()

    return {
        "plugin": {
            "status": p.status if p else "disconnected",
            "is_enabled": p.is_enabled if p else False,
            "last_sync_at": p.last_sync_at.isoformat() if p and p.last_sync_at else None,
            "last_error": p.last_error if p else None,
        },
        "clusters": {"total": cl.total or 0},
        "vms": {
            "total": v.total or 0,
            "powered_on": v.powered_on or 0,
            "powered_off": v.powered_off or 0,
            "total_vcpus": v.total_vcpus or 0,
            "total_memory_mb": v.total_memory_mb or 0,
        },
        "hosts": {
            "total": h.total or 0,
            "total_cpu_hz": h.total_cpu_hz or 0,
            "total_memory_mb": h.total_mem_mb or 0,
        },
        "alerts": {
            "total": al.total or 0,
            "critical": al.critical or 0,
            "warning": al.warning or 0,
        },
    }


@router.get("/clusters")
async def list_clusters(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    rows = await db.execute(text("""
        SELECT cluster_id, name, cluster_uuid, num_nodes, version, hypervisor
        FROM nutanix_clusters ORDER BY name
    """))
    return [dict(r._mapping) for r in rows.fetchall()]


@router.get("/vms")
async def list_vms(
    power_state: str = None,
    search: str = None,
    limit: int = Query(default=200, ge=1, le=1000),
    db: AsyncSession = Depends(get_db), _=Depends(get_current_user),
):
    filters, params = [], {"limit": limit}
    if power_state:
        filters.append("power_state = :ps")
        params["ps"] = power_state.upper()
    if search:
        filters.append("(name ILIKE :q OR cluster_name ILIKE :q OR host_name ILIKE :q)")
        params["q"] = f"%{search}%"
    where = ("WHERE " + " AND ".join(filters)) if filters else ""
    rows = await db.execute(text(f"""
        SELECT vm_id, name, power_state, num_vcpus, memory_mb,
               cluster_name, host_name, guest_os
        FROM nutanix_vms {where}
        ORDER BY power_state, name LIMIT :limit
    """), params)
    return [dict(r._mapping) for r in rows.fetchall()]


@router.get("/hosts")
async def list_hosts(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    rows = await db.execute(text("""
        SELECT host_id, name, ip_address, hypervisor_type,
               num_cpus, cpu_capacity_hz, memory_capacity_mb,
               cluster_name, num_vms
        FROM nutanix_hosts ORDER BY name
    """))
    return [dict(r._mapping) for r in rows.fetchall()]


@router.get("/alerts")
async def list_alerts(
    severity: str = None,
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_db), _=Depends(get_current_user),
):
    filters, params = [], {"limit": limit}
    if severity:
        filters.append("severity = :sev")
        params["sev"] = severity.upper()
    where = ("WHERE " + " AND ".join(filters)) if filters else ""
    rows = await db.execute(text(f"""
        SELECT alert_id, severity, title, message, entity_type,
               created_at, resolved
        FROM nutanix_alerts {where}
        ORDER BY created_at DESC LIMIT :limit
    """), params)
    return [dict(r._mapping) for r in rows.fetchall()]
