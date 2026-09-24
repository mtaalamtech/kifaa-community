"""Server Inventory Report — per-agent specs, storage, utilization, licenses."""
from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from collections import defaultdict
import datetime

from api.database import get_db
from api.services.auth import get_current_user

router = APIRouter(prefix="/reports", tags=["Reports"])


@router.get("/server-inventory")
async def server_inventory_report(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """
    Returns structured JSON for the Server Inventory Excel report.
    Sheets: Summary, Server Specs (with disk usage), CPU & RAM (24h), Licenses.
    All queries are index-backed and complete in < 1 second.
    """

    # ── 1. Disk usage per agent — sum across all mount points (last 2 hours) ─
    disk_rows = await db.execute(text("""
        SELECT
            agent_id::text,
            metric_name,
            SUM(value) AS total_value
        FROM (
            SELECT agent_id, metric_name, tags->>'mount' AS mount, AVG(value) AS value
            FROM metrics
            WHERE metric_name IN ('disk_total_gb', 'disk_used_gb', 'disk_free_gb', 'disk_percent')
              AND time >= NOW() - INTERVAL '2 hours'
            GROUP BY agent_id, metric_name, tags->>'mount'
        ) sub
        WHERE metric_name IN ('disk_total_gb', 'disk_used_gb', 'disk_free_gb')
        GROUP BY agent_id, metric_name
    """))
    # disk_percent is not summable — compute from totals instead
    disk_map: dict = defaultdict(dict)
    for r in disk_rows.fetchall():
        disk_map[r.agent_id][r.metric_name] = round(float(r.total_value), 1)

    # ── 2. Server Specs + Hardware Inventory ──────────────────────────────────
    specs_rows = await db.execute(text("""
        SELECT
            a.id::text            AS agent_id,
            COALESCE(a.display_name, a.hostname) AS name,
            a.hostname,
            a.ip_address,
            a.os_type,
            a.os_name,
            a.os_version,
            a.os_arch,
            a.status,
            a.last_seen,
            a.registered_at,
            a.asset_type,
            h.cpu_model,
            h.cpu_cores,
            h.cpu_threads,
            h.ram_total_gb,
            h.bios_vendor,
            h.bios_version,
            h.bios_date,
            h.motherboard_vendor,
            h.motherboard_model,
            h.serial_number,
            h.asset_tag,
            h.default_gateway,
            h.nics
        FROM agents a
        LEFT JOIN hardware_inventory h ON h.agent_id = a.id
        WHERE a.is_active = TRUE
          AND a.exclude_from_reports = FALSE
        ORDER BY a.os_type, a.hostname
    """))

    servers = []
    # name map uses same COALESCE logic as Server Specs sheet
    id_to_name: dict = {}

    for r in specs_rows.fetchall():
        d = dict(r._mapping)
        agent_id = d["agent_id"]
        id_to_name[agent_id] = d["name"]

        nics = d.pop("nics") or []
        primary_mac = ""
        if nics and isinstance(nics[0], dict):
            primary_mac = nics[0].get("mac", "")

        for ts in ("last_seen", "registered_at"):
            if d.get(ts):
                d[ts] = d[ts].isoformat()

        # Attach disk summary (from metrics, summed across mounts)
        dm = disk_map.get(agent_id, {})
        total_gb = dm.get("disk_total_gb")
        used_gb  = dm.get("disk_used_gb")
        free_gb  = dm.get("disk_free_gb")
        used_pct = None
        if total_gb and total_gb > 0 and used_gb is not None:
            used_pct = round(used_gb / total_gb * 100, 1)

        servers.append({
            **d,
            "primary_mac":    primary_mac,
            "nic_count":      len(nics),
            "disk_total_gb":  total_gb,
            "disk_used_gb":   used_gb,
            "disk_free_gb":   free_gb,
            "disk_used_pct":  used_pct,
        })

    # ── 3. CPU & RAM utilization — 24-hour avg + peak ────────────────────────
    util_rows = await db.execute(text("""
        SELECT
            agent_id::text,
            metric_name,
            ROUND(AVG(value)::numeric, 1) AS avg_val,
            ROUND(MAX(value)::numeric, 1) AS peak_val
        FROM metrics
        WHERE metric_name IN ('cpu_percent', 'memory_percent', 'swap_percent')
          AND time >= NOW() - INTERVAL '24 hours'
        GROUP BY agent_id, metric_name
    """))

    util_map: dict = defaultdict(dict)
    for r in util_rows.fetchall():
        util_map[r.agent_id][r.metric_name] = {
            "avg":  float(r.avg_val)  if r.avg_val  is not None else None,
            "peak": float(r.peak_val) if r.peak_val is not None else None,
        }

    utilization = []
    for agent_id, metrics in util_map.items():
        cpu  = metrics.get("cpu_percent",    {})
        mem  = metrics.get("memory_percent", {})
        swap = metrics.get("swap_percent",   {})
        utilization.append({
            "agent_id":     agent_id,
            "name":         id_to_name.get(agent_id, agent_id),  # same name as Server Specs
            "cpu_avg_pct":  cpu.get("avg"),
            "cpu_peak_pct": cpu.get("peak"),
            "ram_avg_pct":  mem.get("avg"),
            "ram_peak_pct": mem.get("peak"),
            "swap_avg_pct": swap.get("avg"),
        })

    # ── 4. Licenses — OS + software + database ────────────────────────────────

    # 4a. OS/software licenses from agent_licenses (exclude Ubuntu Pro)
    lic_rows = await db.execute(text("""
        SELECT
            l.agent_id::text,
            l.software_name,
            l.license_type,
            l.activation_status,
            l.partial_key        AS license_key,
            l.expiry_date,
            l.license_channel,
            l.detected_at
        FROM agent_licenses l
        JOIN agents a ON a.id = l.agent_id
        WHERE a.is_active = TRUE
          AND a.exclude_from_reports = FALSE
          AND l.software_name NOT ILIKE '%ubuntu pro%'
        ORDER BY a.hostname, l.software_name
    """))

    licenses = []
    for r in lic_rows.fetchall():
        d = dict(r._mapping)
        d["name"] = id_to_name.get(d["agent_id"], d["agent_id"])
        d["source"] = "OS / Software"
        for ts in ("expiry_date", "detected_at"):
            if d.get(ts):
                d[ts] = d[ts].isoformat()
        licenses.append(d)

    # 4b. Database licenses from software_inventory (MSSQL installs)
    db_lic_rows = await db.execute(text("""
        SELECT
            si.agent_id::text,
            si.name        AS software_name,
            si.version,
            si.publisher,
            si.install_date
        FROM software_inventory si
        JOIN agents a ON a.id = si.agent_id
        WHERE a.is_active = TRUE
          AND a.exclude_from_reports = FALSE
          AND si.name ~* '^Microsoft SQL Server 20[0-9]+ \(64-bit\)$'
        ORDER BY a.hostname, si.name
    """))

    for r in db_lic_rows.fetchall():
        d = dict(r._mapping)
        licenses.append({
            "agent_id":         d["agent_id"],
            "name":             id_to_name.get(d["agent_id"], d["agent_id"]),
            "software_name":    d["software_name"],
            "license_type":     "database",
            "activation_status": "installed",
            "license_key":      "",
            "expiry_date":      "",
            "license_channel":  "",
            "detected_at":      "",
            "source":           "Database",
            "version":          d["version"] or "",
            "publisher":        d["publisher"] or "",
            "install_date":     d["install_date"] or "",
        })

    # Sort combined list by server name then software
    licenses.sort(key=lambda x: (x["name"], x["software_name"]))

    return {
        "generated_at":  datetime.datetime.utcnow().isoformat() + "Z",
        "id_to_name":    id_to_name,
        "servers":       servers,
        "utilization":   utilization,
        "licenses":      licenses,
    }
