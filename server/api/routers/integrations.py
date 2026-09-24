"""
Plugin & Integrations hub router.
Manages plugin registry, credentials, enable/disable, test connections,
and manual sync triggers.
"""
import json
import logging
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.database import get_db
from api.services.auth import get_current_user

router = APIRouter(prefix="/integrations", tags=["Integrations"])
logger = logging.getLogger(__name__)

# Default plugin catalogue — seeded on first startup
_DEFAULT_PLUGINS = [
    {
        "plugin_type": "unitrends",
        "display_name": "Kaseya Unitrends",
        "description": "Backup & disaster recovery — backup jobs, storage, protected clients, alerts",
        "icon": "server",
    },
    {
        "plugin_type": "sophos",
        "display_name": "Sophos Central",
        "description": "Endpoint security — health status, threats, tamper protection, alerts",
        "icon": "shield",
    },
    {
        "plugin_type": "o365",
        "display_name": "Office 365",
        "description": "Microsoft 365 — user accounts, sign-in activity, license utilization",
        "icon": "cloud",
    },
    {
        "plugin_type": "sap",
        "display_name": "SAP",
        "description": "ERP — user accounts, active/inactive, last login, license assignments",
        "icon": "database",
    },
    {
        "plugin_type": "vmware",
        "display_name": "VMware vCenter",
        "description": "vSphere — VMs, ESXi hosts, clusters, datastores, resource pools",
        "icon": "cpu",
    },
    {
        "plugin_type": "proxmox",
        "display_name": "Proxmox VE",
        "description": "Proxmox — nodes, KVM VMs, LXC containers, storage pools, cluster health",
        "icon": "layers",
    },
    {
        "plugin_type": "nutanix",
        "display_name": "Nutanix Prism",
        "description": "HCI — clusters, VMs, hosts, storage containers, alerts",
        "icon": "hexagon",
    },
    {
        "plugin_type": "apc_ups",
        "display_name": "APC UPS",
        "description": "APC Smart-UPS — battery status, load, runtime, voltage via SNMP",
        "icon": "zap",
    },
]


async def _ensure_tables(db: AsyncSession):
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS integration_plugins (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            plugin_type TEXT UNIQUE NOT NULL,
            display_name TEXT NOT NULL,
            description TEXT,
            icon TEXT DEFAULT 'plug',
            is_enabled BOOLEAN DEFAULT FALSE,
            config JSONB DEFAULT '{}',
            credentials JSONB DEFAULT '{}',
            status TEXT DEFAULT 'disconnected',
            last_sync_at TIMESTAMPTZ,
            last_error TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS integration_sync_log (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            plugin_type TEXT NOT NULL,
            started_at TIMESTAMPTZ DEFAULT NOW(),
            completed_at TIMESTAMPTZ,
            status TEXT DEFAULT 'running',
            records_synced INT DEFAULT 0,
            error_message TEXT
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS unitrends_backups (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            backup_id TEXT,
            client_name TEXT,
            instance_name TEXT,
            backup_type TEXT,
            status TEXT,
            start_time TIMESTAMPTZ,
            end_time TIMESTAMPTZ,
            size_bytes BIGINT,
            message TEXT,
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS unitrends_clients (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            client_id TEXT UNIQUE,
            client_name TEXT,
            os TEXT,
            ip_address TEXT,
            status TEXT,
            last_backup TIMESTAMPTZ,
            total_backups INT DEFAULT 0,
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS unitrends_alerts (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            alert_id TEXT UNIQUE,
            severity TEXT,
            message TEXT,
            alert_time TIMESTAMPTZ,
            acknowledged BOOLEAN DEFAULT FALSE,
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS unitrends_storage (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            device_name TEXT,
            total_bytes BIGINT,
            used_bytes BIGINT,
            free_bytes BIGINT,
            usage_pct NUMERIC(5,1),
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS sophos_endpoints (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            endpoint_id TEXT UNIQUE,
            hostname TEXT,
            health_status TEXT,
            os_name TEXT,
            ip_address TEXT,
            last_seen TIMESTAMPTZ,
            tamper_protection BOOLEAN DEFAULT FALSE,
            group_name TEXT,
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS sophos_alerts (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            alert_id TEXT UNIQUE,
            severity TEXT,
            category TEXT,
            description TEXT,
            endpoint_hostname TEXT,
            raised_at TIMESTAMPTZ,
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS sophos_licenses (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            license_id TEXT UNIQUE,
            product_name TEXT,
            license_type TEXT,
            starts_at TIMESTAMPTZ,
            expires_at TIMESTAMPTZ,
            quantity INT DEFAULT 0,
            used_quantity INT DEFAULT 0,
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS sap_users (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            internal_key INT UNIQUE,
            user_code TEXT,
            user_name TEXT,
            email TEXT,
            locked BOOLEAN DEFAULT FALSE,
            superuser BOOLEAN DEFAULT FALSE,
            group_name TEXT,
            last_logout_date DATE,
            department_id INT,
            department_name TEXT,
            employee_id INT,
            employee_first_name TEXT,
            employee_last_name TEXT,
            active BOOLEAN DEFAULT TRUE,
            job_title TEXT,
            mobile_phone TEXT,
            license_type TEXT DEFAULT 'unknown',
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS sap_employees (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            employee_id INT UNIQUE,
            first_name TEXT,
            last_name TEXT,
            email TEXT,
            department_id INT,
            department_name TEXT,
            job_title TEXT,
            active BOOLEAN DEFAULT TRUE,
            start_date DATE,
            termination_date DATE,
            mobile_phone TEXT,
            office_phone TEXT,
            sap_user_code TEXT,
            sap_internal_key INT,
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS o365_users (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            user_id TEXT UNIQUE,
            display_name TEXT,
            email TEXT,
            account_enabled BOOLEAN,
            last_sign_in TIMESTAMPTZ,
            assigned_licenses JSONB DEFAULT '[]',
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS o365_licenses (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            sku_id TEXT UNIQUE,
            sku_name TEXT,
            total_units INT,
            consumed_units INT,
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))

    # ── VMware vCenter tables ──────────────────────────────────────────────────
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS vmware_vms (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            vm_id TEXT UNIQUE,
            name TEXT,
            power_state TEXT,
            cpu_count INT,
            memory_mb INT,
            guest_os TEXT,
            ip_address TEXT,
            host_name TEXT,
            cluster_name TEXT,
            datastore_name TEXT,
            cpu_usage_mhz INT,
            memory_usage_mb INT,
            tools_status TEXT,
            tools_version TEXT,
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS vmware_hosts (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            host_id TEXT UNIQUE,
            name TEXT,
            connection_state TEXT,
            power_state TEXT,
            cpu_cores INT,
            cpu_threads INT,
            cpu_mhz INT,
            cpu_usage_mhz INT,
            memory_mb BIGINT,
            memory_usage_mb BIGINT,
            vm_count INT DEFAULT 0,
            cluster_name TEXT,
            version TEXT,
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS vmware_datastores (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            ds_id TEXT UNIQUE,
            name TEXT,
            ds_type TEXT,
            capacity_mb BIGINT,
            free_mb BIGINT,
            accessible BOOLEAN DEFAULT TRUE,
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS vmware_clusters (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            cluster_id TEXT UNIQUE,
            name TEXT,
            ha_enabled BOOLEAN DEFAULT FALSE,
            drs_enabled BOOLEAN DEFAULT FALSE,
            host_count INT DEFAULT 0,
            vm_count INT DEFAULT 0,
            cpu_cores INT,
            memory_mb BIGINT,
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))

    # ── Proxmox VE tables ─────────────────────────────────────────────────────
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS proxmox_nodes (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            node_id TEXT UNIQUE,
            name TEXT,
            status TEXT,
            cpu_usage NUMERIC(8,4) DEFAULT 0,
            maxcpu INT DEFAULT 0,
            mem BIGINT DEFAULT 0,
            maxmem BIGINT DEFAULT 0,
            disk BIGINT DEFAULT 0,
            maxdisk BIGINT DEFAULT 0,
            uptime_seconds BIGINT DEFAULT 0,
            pve_version TEXT,
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS proxmox_vms (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            vm_id TEXT UNIQUE,
            vmid INT,
            name TEXT,
            type TEXT,
            status TEXT,
            node_name TEXT,
            cpu_usage NUMERIC(8,4) DEFAULT 0,
            cpus INT DEFAULT 0,
            mem BIGINT DEFAULT 0,
            maxmem BIGINT DEFAULT 0,
            disk BIGINT DEFAULT 0,
            maxdisk BIGINT DEFAULT 0,
            uptime_seconds BIGINT DEFAULT 0,
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS proxmox_storage (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            stor_id TEXT UNIQUE,
            name TEXT,
            node_name TEXT,
            storage_type TEXT,
            total_bytes BIGINT DEFAULT 0,
            used_bytes BIGINT DEFAULT 0,
            avail_bytes BIGINT DEFAULT 0,
            enabled BOOLEAN DEFAULT TRUE,
            shared BOOLEAN DEFAULT FALSE,
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))

    # ── Nutanix Prism tables ──────────────────────────────────────────────────
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS nutanix_clusters (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            cluster_id TEXT UNIQUE,
            name TEXT,
            cluster_uuid TEXT,
            num_nodes INT DEFAULT 0,
            version TEXT,
            hypervisor TEXT,
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS nutanix_vms (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            vm_id TEXT UNIQUE,
            name TEXT,
            power_state TEXT,
            num_vcpus INT DEFAULT 0,
            memory_mb INT DEFAULT 0,
            host_name TEXT,
            cluster_name TEXT,
            guest_os TEXT,
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS nutanix_hosts (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            host_id TEXT UNIQUE,
            name TEXT,
            ip_address TEXT,
            hypervisor_type TEXT,
            num_cpus INT DEFAULT 0,
            cpu_capacity_hz BIGINT DEFAULT 0,
            memory_capacity_mb BIGINT DEFAULT 0,
            cluster_name TEXT,
            num_vms INT DEFAULT 0,
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS nutanix_alerts (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            alert_id TEXT UNIQUE,
            severity TEXT,
            title TEXT,
            message TEXT,
            entity_type TEXT,
            created_at TIMESTAMPTZ,
            resolved BOOLEAN DEFAULT FALSE,
            synced_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.commit()

    # Seed default plugin rows
    for p in _DEFAULT_PLUGINS:
        await db.execute(text("""
            INSERT INTO integration_plugins (plugin_type, display_name, description, icon)
            VALUES (:pt, :dn, :desc, :icon)
            ON CONFLICT (plugin_type) DO NOTHING
        """), {"pt": p["plugin_type"], "dn": p["display_name"],
               "desc": p["description"], "icon": p["icon"]})
    await db.commit()


# ── Startup table creation ─────────────────────────────────────────────────────

_tables_ready = False

async def ensure_tables_once(db: AsyncSession):
    global _tables_ready
    if not _tables_ready:
        await _ensure_tables(db)
        _tables_ready = True


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("")
async def list_plugins(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    await ensure_tables_once(db)
    rows = await db.execute(text("""
        SELECT plugin_type, display_name, description, icon,
               is_enabled, status, last_sync_at, last_error, config
        FROM integration_plugins
        ORDER BY display_name
    """))
    results = []
    for r in rows.fetchall():
        cfg = r.config or {}
        results.append({
            "plugin_type": r.plugin_type,
            "display_name": r.display_name,
            "description": r.description,
            "icon": r.icon,
            "is_enabled": r.is_enabled,
            "status": r.status,
            "last_sync_at": r.last_sync_at.isoformat() if r.last_sync_at else None,
            "last_error": r.last_error,
            "has_credentials": bool(cfg.get("_has_creds")),
        })
    return results


@router.get("/{plugin_type}/config")
async def get_plugin_config(
    plugin_type: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    await ensure_tables_once(db)
    row = await db.execute(text("""
        SELECT plugin_type, display_name, is_enabled, status, last_sync_at,
               last_error, config
        FROM integration_plugins WHERE plugin_type = :pt
    """), {"pt": plugin_type})
    r = row.fetchone()
    if not r:
        raise HTTPException(status_code=404, detail="Plugin not found")
    cfg = dict(r.config or {})
    # Return config without secrets
    safe_cfg = {k: v for k, v in cfg.items() if k not in ("password", "client_secret", "_has_creds")}
    # Strip passwords from standalone_esxi entries
    if "standalone_esxi" in safe_cfg:
        safe_cfg["standalone_esxi"] = [
            {k2: v2 for k2, v2 in e.items() if k2 != "password"}
            for e in (safe_cfg["standalone_esxi"] or [])
        ]
    return {
        "plugin_type": r.plugin_type,
        "display_name": r.display_name,
        "is_enabled": r.is_enabled,
        "status": r.status,
        "last_sync_at": r.last_sync_at.isoformat() if r.last_sync_at else None,
        "last_error": r.last_error,
        "config": safe_cfg,
    }


@router.put("/{plugin_type}/config")
async def update_plugin_config(
    plugin_type: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Update plugin config + credentials. Pass is_enabled to toggle."""
    await ensure_tables_once(db)

    row = await db.execute(text(
        "SELECT config FROM integration_plugins WHERE plugin_type = :pt"
    ), {"pt": plugin_type})
    r = row.fetchone()
    if not r:
        raise HTTPException(status_code=404, detail="Plugin not found")

    existing = dict(r.config or {})

    # Merge new config fields (keep existing secrets if not provided)
    new_cfg = {**existing}
    for key in ("host", "port", "verify_ssl", "tenant_id", "client_id",
                "username", "password", "client_secret", "sync_interval_minutes",
                "company_db"):
        if key in body and body[key] is not None and body[key] != "":
            val = body[key]
            # Strip accidental whitespace from string credential fields
            if isinstance(val, str):
                val = val.strip()
            new_cfg[key] = val

    # Handle standalone_esxi array — preserve passwords for entries where field is blank
    if "standalone_esxi" in body:
        existing_esxi = existing.get("standalone_esxi", [])
        merged = []
        for i, entry in enumerate(body["standalone_esxi"] or []):
            merged_entry = dict(entry)
            # If password is blank, preserve existing password for same-position host
            if not merged_entry.get("password") and i < len(existing_esxi):
                merged_entry["password"] = existing_esxi[i].get("password", "")
            merged.append(merged_entry)
        new_cfg["standalone_esxi"] = merged
        if any(e.get("password") for e in merged):
            new_cfg["_has_creds"] = True

    # Mark that credentials have been set
    if any(k in body for k in ("password", "client_secret")):
        new_cfg["_has_creds"] = True

    is_enabled = body.get("is_enabled", None)

    updates = ["config = CAST(:cfg AS jsonb)", "updated_at = NOW()"]
    params: dict = {"pt": plugin_type, "cfg": json.dumps(new_cfg)}
    if is_enabled is not None:
        updates.append("is_enabled = :enabled")
        params["enabled"] = is_enabled

    await db.execute(text(
        f"UPDATE integration_plugins SET {', '.join(updates)} WHERE plugin_type = :pt"
    ), params)
    await db.commit()
    return {"ok": True}


@router.post("/{plugin_type}/test")
async def test_plugin_connection(
    plugin_type: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Test the connection to the external service using saved credentials."""
    await ensure_tables_once(db)
    row = await db.execute(text(
        "SELECT config FROM integration_plugins WHERE plugin_type = :pt AND is_enabled = TRUE"
    ), {"pt": plugin_type})
    r = row.fetchone()
    if not r:
        raise HTTPException(status_code=400, detail="Plugin not found or not enabled")

    cfg = dict(r.config or {})

    if plugin_type == "unitrends":
        from api.services.unitrends_client import UnitrendsClient
        try:
            client = UnitrendsClient(
                host=cfg.get("host", ""),
                username=cfg.get("username", "root"),
                password=cfg.get("password", ""),
                verify_ssl=cfg.get("verify_ssl", False),
            )
            info = client.test_connection()
            await db.execute(text("""
                UPDATE integration_plugins
                SET status = 'connected', last_error = NULL, updated_at = NOW()
                WHERE plugin_type = 'unitrends'
            """))
            await db.commit()
            return {"ok": True, "message": "Connected successfully", "info": info}
        except Exception as e:
            await db.execute(text("""
                UPDATE integration_plugins
                SET status = 'error', last_error = :err, updated_at = NOW()
                WHERE plugin_type = 'unitrends'
            """), {"err": str(e)})
            await db.commit()
            return {"ok": False, "message": str(e)}

    elif plugin_type == "sophos":
        from api.services.sophos_client import SophosClient
        try:
            client = SophosClient(
                client_id=cfg.get("client_id", ""),
                client_secret=cfg.get("client_secret", ""),
            )
            info = client.test_connection()
            await db.execute(text("""
                UPDATE integration_plugins SET status = 'connected', last_error = NULL, updated_at = NOW()
                WHERE plugin_type = 'sophos'
            """))
            await db.commit()
            return {"ok": True, "message": "Connected successfully", "info": info}
        except Exception as e:
            await db.execute(text("""
                UPDATE integration_plugins SET status = 'error', last_error = :err, updated_at = NOW()
                WHERE plugin_type = 'sophos'
            """), {"err": str(e)})
            await db.commit()
            return {"ok": False, "message": str(e)}

    elif plugin_type == "o365":
        from api.services.o365_client import O365Client
        try:
            client = O365Client(
                tenant_id=cfg.get("tenant_id", ""),
                client_id=cfg.get("client_id", ""),
                client_secret=cfg.get("client_secret", ""),
            )
            info = client.test_connection()
            await db.execute(text("""
                UPDATE integration_plugins SET status = 'connected', last_error = NULL, updated_at = NOW()
                WHERE plugin_type = 'o365'
            """))
            await db.commit()
            return {"ok": True, "message": "Connected successfully", "info": info}
        except Exception as e:
            await db.execute(text("""
                UPDATE integration_plugins SET status = 'error', last_error = :err, updated_at = NOW()
                WHERE plugin_type = 'o365'
            """), {"err": str(e)})
            await db.commit()
            return {"ok": False, "message": str(e)}

    elif plugin_type == "vmware":
        from api.services.vmware_client import VMwareClient
        try:
            client = VMwareClient(
                host=cfg.get("host", ""),
                username=cfg.get("username", ""),
                password=cfg.get("password", ""),
                verify_ssl=cfg.get("verify_ssl", False),
            )
            info = client.test_connection()
            await db.execute(text("""
                UPDATE integration_plugins SET status = 'connected', last_error = NULL, updated_at = NOW()
                WHERE plugin_type = 'vmware'
            """))
            await db.commit()
            return {"ok": True, "message": "Connected successfully", "info": info}
        except Exception as e:
            await db.execute(text("""
                UPDATE integration_plugins SET status = 'error', last_error = :err, updated_at = NOW()
                WHERE plugin_type = 'vmware'
            """), {"err": str(e)})
            await db.commit()
            return {"ok": False, "message": str(e)}

    elif plugin_type == "proxmox":
        from api.services.proxmox_client import ProxmoxClient
        try:
            client = ProxmoxClient(
                host=cfg.get("host", ""),
                username=cfg.get("username", "root@pam"),
                password=cfg.get("password", ""),
                token_id=cfg.get("token_id", ""),
                token_secret=cfg.get("token_secret", ""),
                verify_ssl=cfg.get("verify_ssl", False),
            )
            info = client.test_connection()
            await db.execute(text("""
                UPDATE integration_plugins SET status = 'connected', last_error = NULL, updated_at = NOW()
                WHERE plugin_type = 'proxmox'
            """))
            await db.commit()
            return {"ok": True, "message": "Connected successfully", "info": info}
        except Exception as e:
            await db.execute(text("""
                UPDATE integration_plugins SET status = 'error', last_error = :err, updated_at = NOW()
                WHERE plugin_type = 'proxmox'
            """), {"err": str(e)})
            await db.commit()
            return {"ok": False, "message": str(e)}

    elif plugin_type == "nutanix":
        from api.services.nutanix_client import NutanixClient
        try:
            client = NutanixClient(
                host=cfg.get("host", ""),
                username=cfg.get("username", "admin"),
                password=cfg.get("password", ""),
                verify_ssl=cfg.get("verify_ssl", False),
            )
            info = client.test_connection()
            await db.execute(text("""
                UPDATE integration_plugins SET status = 'connected', last_error = NULL, updated_at = NOW()
                WHERE plugin_type = 'nutanix'
            """))
            await db.commit()
            return {"ok": True, "message": "Connected successfully", "info": info}
        except Exception as e:
            await db.execute(text("""
                UPDATE integration_plugins SET status = 'error', last_error = :err, updated_at = NOW()
                WHERE plugin_type = 'nutanix'
            """), {"err": str(e)})
            await db.commit()
            return {"ok": False, "message": str(e)}

    elif plugin_type == "sap":
        from api.services.sap_client import SAPClient
        try:
            client = SAPClient(
                host=cfg.get("host", ""),
                username=cfg.get("username", ""),
                password=cfg.get("password", ""),
                company_db=cfg.get("company_db", ""),
            )
            info = client.test_connection()
            client.close()
            await db.execute(text("""
                UPDATE integration_plugins SET status = 'connected', last_error = NULL, updated_at = NOW()
                WHERE plugin_type = 'sap'
            """))
            await db.commit()
            return {"ok": True, "message": "Connected successfully", "info": info}
        except Exception as e:
            await db.execute(text("""
                UPDATE integration_plugins SET status = 'error', last_error = :err, updated_at = NOW()
                WHERE plugin_type = 'sap'
            """), {"err": str(e)})
            await db.commit()
            return {"ok": False, "message": str(e)}

    return {"ok": False, "message": f"Test not implemented for {plugin_type}"}


@router.post("/vmware/test-esxi")
async def test_esxi_connection(
    request: Request,
    _=Depends(get_current_user),
):
    """Test a standalone ESXi connection with provided credentials (not saved config)."""
    body = await request.json()
    host = (body.get("host") or "").strip()
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    verify_ssl = body.get("verify_ssl", False)

    if not host or not username:
        return {"ok": False, "message": "Host and username are required"}

    from api.services.vmware_client import VMwareClient
    try:
        client = VMwareClient(host=host, username=username, password=password,
                              verify_ssl=verify_ssl, is_esxi=True)
        info = client.test_connection()
        client.close()
        return {"ok": True, "message": f"Connected to {host}", "info": info}
    except Exception as e:
        return {"ok": False, "message": str(e)}


@router.post("/{plugin_type}/sync")
async def trigger_sync(
    plugin_type: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Trigger an immediate sync for the given plugin."""
    await ensure_tables_once(db)
    row = await db.execute(text(
        "SELECT is_enabled FROM integration_plugins WHERE plugin_type = :pt"
    ), {"pt": plugin_type})
    r = row.fetchone()
    if not r:
        raise HTTPException(status_code=404, detail="Plugin not found")
    if not r.is_enabled:
        raise HTTPException(status_code=400, detail="Plugin is not enabled")

    task_map = {
        "unitrends": "api.workers.tasks.sync_unitrends",
        "sophos": "api.workers.tasks.sync_sophos",
        "o365": "api.workers.tasks.sync_o365",
        "vmware": "api.workers.tasks.sync_vmware",
        "proxmox": "api.workers.tasks.sync_proxmox",
        "nutanix": "api.workers.tasks.sync_nutanix",
        "sap": "api.workers.tasks.sync_sap",
        "apc_ups": "api.workers.tasks.sync_apc_ups",
    }
    task_name = task_map.get(plugin_type)
    if task_name:
        from api.workers.celery_app import celery_app
        celery_app.send_task(task_name)

    return {"ok": True, "message": f"Sync queued for {plugin_type}"}


@router.get("/sync-log/{plugin_type}")
async def get_sync_log(
    plugin_type: str,
    limit: int = 20,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    await ensure_tables_once(db)
    rows = await db.execute(text("""
        SELECT plugin_type, started_at, completed_at, status, records_synced, error_message
        FROM integration_sync_log
        WHERE plugin_type = :pt
        ORDER BY started_at DESC
        LIMIT :lim
    """), {"pt": plugin_type, "lim": limit})
    return [
        {
            "plugin_type": r.plugin_type,
            "started_at": r.started_at.isoformat() if r.started_at else None,
            "completed_at": r.completed_at.isoformat() if r.completed_at else None,
            "status": r.status,
            "records_synced": r.records_synced,
            "error_message": r.error_message,
        }
        for r in rows.fetchall()
    ]
