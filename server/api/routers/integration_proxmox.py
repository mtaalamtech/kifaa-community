"""Proxmox VE integration data router."""
from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.database import get_db
from api.services.auth import get_current_user

router = APIRouter(prefix="/integrations/proxmox", tags=["Integrations - Proxmox"])


@router.get("/dashboard")
async def proxmox_dashboard(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    plugin = await db.execute(text(
        "SELECT status, is_enabled, last_sync_at, last_error FROM integration_plugins WHERE plugin_type='proxmox'"
    ))
    p = plugin.fetchone()

    nodes = await db.execute(text("""
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE status = 'online') AS online,
               SUM(maxcpu) AS total_cpus,
               SUM(maxmem) AS total_mem_bytes,
               SUM(mem) AS used_mem_bytes,
               SUM(maxdisk) AS total_disk_bytes,
               SUM(disk) AS used_disk_bytes
        FROM proxmox_nodes
    """))
    n = nodes.fetchone()

    vms = await db.execute(text("""
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE type = 'qemu') AS vms,
               COUNT(*) FILTER (WHERE type = 'lxc') AS containers,
               COUNT(*) FILTER (WHERE status = 'running') AS running,
               COUNT(*) FILTER (WHERE status = 'stopped') AS stopped
        FROM proxmox_vms
    """))
    v = vms.fetchone()

    storage = await db.execute(text("""
        SELECT COUNT(*) AS total,
               SUM(total_bytes) AS total_bytes,
               SUM(used_bytes) AS used_bytes
        FROM proxmox_storage
    """))
    s = storage.fetchone()

    mem_pct = 0
    disk_pct = 0
    if n.total_mem_bytes and n.total_mem_bytes > 0:
        mem_pct = round((n.used_mem_bytes or 0) / n.total_mem_bytes * 100, 1)
    if n.total_disk_bytes and n.total_disk_bytes > 0:
        disk_pct = round((n.used_disk_bytes or 0) / n.total_disk_bytes * 100, 1)

    stor_pct = 0
    if s.total_bytes and s.total_bytes > 0:
        stor_pct = round((s.used_bytes or 0) / s.total_bytes * 100, 1)

    return {
        "plugin": {
            "status": p.status if p else "disconnected",
            "is_enabled": p.is_enabled if p else False,
            "last_sync_at": p.last_sync_at.isoformat() if p and p.last_sync_at else None,
            "last_error": p.last_error if p else None,
        },
        "nodes": {
            "total": n.total or 0,
            "online": n.online or 0,
            "total_cpus": n.total_cpus or 0,
            "memory_usage_pct": mem_pct,
            "disk_usage_pct": disk_pct,
        },
        "vms": {
            "total": v.total or 0,
            "vms": v.vms or 0,
            "containers": v.containers or 0,
            "running": v.running or 0,
            "stopped": v.stopped or 0,
        },
        "storage": {
            "total": s.total or 0,
            "total_bytes": s.total_bytes or 0,
            "used_bytes": s.used_bytes or 0,
            "usage_pct": stor_pct,
        },
    }


@router.get("/nodes")
async def list_nodes(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    rows = await db.execute(text("""
        SELECT node_id, name, status, cpu_usage, maxcpu, mem, maxmem, disk, maxdisk,
               uptime_seconds, pve_version,
               CASE WHEN maxcpu > 0 THEN ROUND(cpu_usage::numeric * 100, 1) ELSE 0 END AS cpu_usage_pct,
               CASE WHEN maxmem > 0 THEN ROUND(mem::numeric / maxmem * 100, 1) ELSE 0 END AS mem_usage_pct,
               CASE WHEN maxdisk > 0 THEN ROUND(disk::numeric / maxdisk * 100, 1) ELSE 0 END AS disk_usage_pct
        FROM proxmox_nodes ORDER BY name
    """))
    return [dict(r._mapping) for r in rows.fetchall()]


@router.get("/vms")
async def list_vms(
    vm_type: str = None,
    status: str = None,
    search: str = None,
    node: str = None,
    limit: int = Query(default=200, ge=1, le=1000),
    db: AsyncSession = Depends(get_db), _=Depends(get_current_user),
):
    filters, params = [], {"limit": limit}
    if vm_type:
        filters.append("type = :vtype")
        params["vtype"] = vm_type.lower()
    if status:
        filters.append("status = :status")
        params["status"] = status.lower()
    if node:
        filters.append("node_name = :node")
        params["node"] = node
    if search:
        filters.append("(name ILIKE :q OR node_name ILIKE :q)")
        params["q"] = f"%{search}%"
    where = ("WHERE " + " AND ".join(filters)) if filters else ""
    rows = await db.execute(text(f"""
        SELECT vm_id, vmid, name, type, status, node_name,
               cpu_usage, cpus, mem, maxmem, disk, maxdisk, uptime_seconds,
               CASE WHEN maxmem > 0 THEN ROUND(mem::numeric / maxmem * 100, 1) ELSE 0 END AS mem_usage_pct
        FROM proxmox_vms {where}
        ORDER BY status, name LIMIT :limit
    """), params)
    return [dict(r._mapping) for r in rows.fetchall()]


@router.get("/storage")
async def list_storage(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    rows = await db.execute(text("""
        SELECT stor_id, name, node_name, storage_type, total_bytes, used_bytes,
               avail_bytes, enabled, shared,
               CASE WHEN total_bytes > 0
                    THEN ROUND(used_bytes::numeric / total_bytes * 100, 1)
                    ELSE 0 END AS usage_pct
        FROM proxmox_storage ORDER BY node_name, name
    """))
    return [dict(r._mapping) for r in rows.fetchall()]
