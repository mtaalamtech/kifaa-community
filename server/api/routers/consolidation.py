"""Server Consolidation Assessment — planning, auto-suggestion, and export data."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from collections import defaultdict
from typing import Optional
import datetime

from api.database import get_db
from api.services.auth import get_current_user

router = APIRouter(prefix="/consolidation", tags=["Consolidation"])

_table_ready = False


async def _ensure_table(db: AsyncSession):
    global _table_ready
    if _table_ready:
        return
    try:
        await db.execute(text("""
            CREATE TABLE IF NOT EXISTS consolidation_plans (
                id SERIAL PRIMARY KEY,
                agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
                server_role TEXT,
                recommended_action VARCHAR(50),
                confirmed_action VARCHAR(50),
                destination_server_id UUID REFERENCES agents(id),
                utilization_notes TEXT,
                dependency_notes TEXT,
                has_dependencies BOOLEAN DEFAULT FALSE,
                retention_months INTEGER,
                retention_notes TEXT,
                target_date DATE,
                rollback_plan TEXT,
                confirmed_by VARCHAR(100),
                status VARCHAR(30) DEFAULT 'draft',
                priority INTEGER DEFAULT 3,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(agent_id)
            )
        """))
        await db.commit()
    except Exception:
        try:
            await db.rollback()
        except Exception:
            pass
    _table_ready = True


# ── helpers ──────────────────────────────────────────────────────────────────

# Windows Internal Database — used by RDS licensing, WSUS, etc. NOT a real SQL Server.
_WID = 'mssql$microsoft##wid'

def _has_real_mssql(svc_lower: list[str]) -> bool:
    """True only if there is a real SQL Server instance (not WID)."""
    return any(
        ('mssqlserver' in s or ('mssql$' in s and _WID not in s))
        for s in svc_lower
    )

def _is_rds_server(svc_lower: list[str]) -> bool:
    """True if the server runs Remote Desktop Services (terminal / thin-client role)."""
    return (
        'termservice' in svc_lower and
        'umrdpservice' in svc_lower and
        'termservlicensing' in svc_lower
    )

def _is_ecommerce(svc_lower: list[str], os_type: str) -> bool:
    """Linux web server with MySQL/PHP = e-commerce stack."""
    has_web = any(s in svc_lower for s in ('nginx', 'apache2', 'apache2.4', 'httpd'))
    has_db  = any('mysql' in s for s in svc_lower)
    has_php = any('php' in s for s in svc_lower)
    return os_type == 'linux' and has_web and (has_db or has_php)

def _is_domino_mail(svc_lower: list[str], sw_lower: list[str], hostname: str) -> bool:
    """Detect IBM/HCL Lotus Domino mail server."""
    domino_svcs = any(s in svc_lower for s in ('domino', 'lotus', 'nhttp', 'ntaskldr', 'nrpc'))
    domino_sw   = any('domino' in s or 'lotus' in s or 'notes' in s for s in sw_lower)
    mail_host   = 'mail' in hostname.lower()
    return domino_svcs or domino_sw or mail_host


def _detect_role(
    services: list[str], software: list[str],
    os_type: str, asset_type: str, hostname: str = ''
) -> str:
    """Infer a plain-English server role from services, software, and hostname."""
    svc_lower = [s.lower() for s in services]
    sw_lower  = [s.lower() for s in software]

    if asset_type and 'desktop' in asset_type.lower():
        return 'Desktop'

    roles = []

    # Active Directory (must check before generic DNS)
    if any('ntds' in s or 'active directory domain services' in s for s in svc_lower):
        roles.append('Active Directory / DNS')

    # RDS / SAP thin-client terminal server
    if _is_rds_server(svc_lower):
        roles.append('SAP RDP / Terminal Server')

    # SAP Business One (real application server, not thin client)
    if any(s in svc_lower for s in ('saplocalhost', 'sapb1servertools', 'b1s_')):
        roles.append('SAP Business One')

    # Real MSSQL (exclude WID)
    if _has_real_mssql(svc_lower):
        instances = [s for s in svc_lower if ('mssqlserver' in s or 'mssql$' in s) and _WID not in s]
        roles.append(f'MSSQL ({len(instances)} instance{"s" if len(instances) > 1 else ""})')

    # MySQL
    if any('mysql' in s for s in svc_lower) or any('mysql' in s for s in sw_lower):
        roles.append('MySQL')

    # E-commerce web+DB stack
    if _is_ecommerce(svc_lower, os_type):
        roles.append('E-Commerce Web / MySQL')
    elif any(s in svc_lower for s in ('nginx', 'apache2', 'apache2.4', 'httpd', 'w3svc')):
        roles.append('Web Server')

    # Domino mail
    if _is_domino_mail(svc_lower, sw_lower, hostname):
        roles.append('Domino Mail Server')

    # WSUS / patch
    if any('wsus' in s or 'wuauserv' in s or 'updateservices' in s for s in svc_lower):
        roles.append('WSUS / Patch Server')

    if roles:
        return ', '.join(roles)
    return 'Linux Server' if os_type == 'linux' else 'Windows Server'


def _auto_suggest(
    os_version: str,
    os_type: str,
    asset_type: str,
    cpu_avg: Optional[float],
    ram_avg: Optional[float],
    roles: str,
    services: list[str],
    hostname: str = '',
) -> dict:
    """
    Return recommended_action, priority, utilization_notes, dependency_notes.

    Decision hierarchy (first match wins):
      1. Desktop           → decommission
      2. Active Directory  → keep (non-negotiable)
      3. SAP RDP + 2008R2  → decommission (replace with consolidated RDS farm)
      4. SAP RDP (modern)  → consolidate (reduce headcount)
      5. Domino mail       → migrate (convert to O365) then decommission
      6. E-commerce stack  → consolidate (merge PHP+MySQL sites onto one server)
      7. SAP Business One  → keep (production SAP app — do not touch without SAP team)
      8. Real MSSQL        → keep or migrate (data workload, needs planning)
      9. Legacy OS (2008)  → migrate (EOL)
      10. Linux EOL (CentOS 7) → migrate
      11. Low utilisation  → consolidate / virtualize
      12. Default          → keep
    """
    svc_lower = [s.lower() for s in services]
    roles_lower = roles.lower()

    util_notes = []
    dep_notes  = []

    def _ret(action, priority, util, dep, ret_months=None, ret_notes=''):
        return {
            'recommended_action': action,
            'priority': priority,
            'utilization_notes': util,
            'dependency_notes': dep,
            'retention_months': ret_months,
            'retention_notes': ret_notes,
        }

    util_str = (f'CPU {cpu_avg:.0f}%, RAM {ram_avg:.0f}%.'
                if cpu_avg is not None and ram_avg is not None
                else 'No utilisation data.')

    # ── 1. Desktop ──────────────────────────────────────────────────────────
    if asset_type and 'desktop' in asset_type.lower():
        return _ret('decommission', 3,
                    'Desktop — out of scope for server consolidation.', '',
                    ret_months=1,
                    ret_notes='Wipe and surplus hardware. No server data to retain.')

    # ── 2. Active Directory ─────────────────────────────────────────────────
    if 'active directory' in roles_lower:
        return _ret('keep', 1, util_str,
                    'Primary AD/DNS — critical infrastructure, must remain.')

    is_legacy_win = bool(os_version and ('2008' in os_version or '2003' in os_version or '2012' in os_version))
    is_eol_linux  = bool(os_version and ('7.' in os_version or 'centos' in (os_version or '').lower()) and os_type == 'linux')

    # ── 3 & 4. SAP RDP / Terminal Server ────────────────────────────────────
    if 'sap rdp' in roles_lower or 'terminal server' in roles_lower:
        if is_legacy_win:
            return _ret('decommission', 1, util_str,
                        f'Legacy OS ({os_version}) EOL — decommission after migrating users to consolidated modern RDS farm.',
                        ret_months=6,
                        ret_notes='Keep RDS CAL records and user profile backups for 6 months. '
                                  'Decommission hardware after confirming all users migrated to new RDS farm.')
        return _ret('consolidate', 2, util_str,
                    'SAP RDP thin-client — multiple servers serve the same role. '
                    'Reduce to 2–3 consolidated RDS hosts.')

    # ── 5. Domino mail server ────────────────────────────────────────────────
    if 'domino mail' in roles_lower:
        eol_note = ' CentOS 7 EOL (Jun 2024) — migration is urgent.' if is_eol_linux else ''
        return _ret('migrate', 1, util_str,
                    'IBM/HCL Domino mail server. Organisation is on Office 365. '
                    'Migrate mailboxes and Domino databases to O365/SharePoint, then decommission.' + eol_note,
                    ret_months=12,
                    ret_notes='Archive all Domino mail databases (.nsf files) to cold storage for 12 months '
                              'post-migration. Retain server image snapshot for 6 months in case of mail recovery requests. '
                              'Decommission CentOS server once migration verified.')

    # ── 6. E-commerce web+MySQL stack ────────────────────────────────────────
    if 'e-commerce' in roles_lower:
        return _ret('consolidate', 2, util_str,
                    'PHP/MySQL e-commerce stack. Merge shop.kenyanut.com, nutfields.co.ke, and '
                    'KNCMORENDATSVR onto a single consolidated web server to reduce licensing, '
                    'maintenance overhead, and resource cost.')

    # ── 7. SAP Business One (production app server) ──────────────────────────
    if 'sap business one' in roles_lower:
        return _ret('keep', 1, util_str,
                    'SAP Business One production — do not migrate without SAP partner sign-off.')

    # ── 8. Real MSSQL (not WID) ──────────────────────────────────────────────
    if _has_real_mssql(svc_lower):
        if is_legacy_win:
            return _ret('migrate', 1, util_str,
                        f'Legacy OS ({os_version}) EOL — migrate SQL databases to a supported server before 2027.',
                        ret_months=12,
                        ret_notes='Full SQL backup before migration. Retain old server in powered-off state for 12 months '
                                  'for emergency data recovery. Document all SQL jobs, linked servers, and logins before decommission.')
        return _ret('keep', 2, util_str,
                    'Has real MSSQL instance(s) — assess database workload before any change.')

    # ── 9. Legacy Windows OS (catch-all) ─────────────────────────────────────
    if is_legacy_win:
        return _ret('migrate', 1, util_str,
                    f'Legacy OS ({os_version}) — End of Life. Must be migrated before 2027.',
                    ret_months=6,
                    ret_notes='Retain full server backup for 6 months post-migration. '
                              'Document all installed applications and configurations before decommission.')

    # ── 10. EOL Linux (CentOS 7) ─────────────────────────────────────────────
    if is_eol_linux:
        return _ret('migrate', 2, util_str,
                    'CentOS 7 End-of-Life (Jun 2024) — migrate to Ubuntu 22.04/24.04 or RHEL.',
                    ret_months=6,
                    ret_notes='Retain data backup and configuration exports for 6 months. '
                              'Migrate to supported Ubuntu LTS before decommissioning.')

    # ── 11. Utilisation-based (general Linux/Windows, no critical role) ───────
    if cpu_avg is not None and ram_avg is not None:
        if cpu_avg > 70 or ram_avg > 80:
            return _ret('keep', 2,
                        f'High utilisation (CPU {cpu_avg:.0f}%, RAM {ram_avg:.0f}%) — keep as dedicated resource.',
                        '')
        if cpu_avg < 10 and ram_avg < 20:
            return _ret('virtualize', 3,
                        f'Very low utilisation (CPU {cpu_avg:.0f}%, RAM {ram_avg:.0f}%) — strong virtualisation candidate.',
                        '')
        if cpu_avg < 25 and ram_avg < 40:
            return _ret('consolidate', 3,
                        f'Low utilisation (CPU {cpu_avg:.0f}%, RAM {ram_avg:.0f}%) — candidate for consolidation.',
                        '')
        no_util = f'Moderate utilisation (CPU {cpu_avg:.0f}%, RAM {ram_avg:.0f}%) — review before decision.'
    else:
        no_util = 'No utilisation data — manual assessment required.'

    # ── 12. Default ──────────────────────────────────────────────────────────
    return _ret('keep', 3, no_util, '')


# ── endpoints ─────────────────────────────────────────────────────────────────

@router.get("/data")
async def consolidation_data(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """
    Returns all active servers with specs, disk, 24h utilization,
    key services detected, OS licenses, and existing consolidation plan entries.
    """
    await _ensure_table(db)

    # 1. Server specs
    specs_rows = await db.execute(text("""
        SELECT
            a.id::text            AS agent_id,
            COALESCE(a.display_name, a.hostname) AS name,
            a.hostname,
            a.ip_address,
            a.os_type,
            a.os_name,
            a.os_version,
            a.status,
            a.last_seen,
            a.asset_type,
            h.cpu_model,
            h.cpu_cores,
            h.cpu_threads,
            h.ram_total_gb,
            h.serial_number
        FROM agents a
        LEFT JOIN hardware_inventory h ON h.agent_id = a.id
        WHERE a.is_active = TRUE
          AND a.exclude_from_reports = FALSE
        ORDER BY a.os_type, a.hostname
    """))

    servers = {}
    for r in specs_rows.fetchall():
        d = dict(r._mapping)
        aid = d['agent_id']
        if d.get('last_seen'):
            d['last_seen'] = d['last_seen'].isoformat()
        servers[aid] = {**d, 'services': [], 'software': [], 'licenses': []}

    # 2. Disk (2-hour window, summed across mounts)
    disk_rows = await db.execute(text("""
        SELECT agent_id::text, metric_name, SUM(value) AS total_value
        FROM (
            SELECT agent_id, metric_name, tags->>'mount' AS mount, AVG(value) AS value
            FROM metrics
            WHERE metric_name IN ('disk_total_gb','disk_used_gb','disk_free_gb')
              AND time >= NOW() - INTERVAL '2 hours'
            GROUP BY agent_id, metric_name, tags->>'mount'
        ) sub
        GROUP BY agent_id, metric_name
    """))
    disk_map: dict = defaultdict(dict)
    for r in disk_rows.fetchall():
        disk_map[r.agent_id][r.metric_name] = round(float(r.total_value), 1)

    for aid, dm in disk_map.items():
        if aid in servers:
            total = dm.get('disk_total_gb')
            used  = dm.get('disk_used_gb')
            free  = dm.get('disk_free_gb')
            pct   = round(used / total * 100, 1) if total and total > 0 and used is not None else None
            servers[aid].update({
                'disk_total_gb': total,
                'disk_used_gb':  used,
                'disk_free_gb':  free,
                'disk_used_pct': pct,
            })

    # 3. CPU & RAM utilization (24h)
    util_rows = await db.execute(text("""
        SELECT
            agent_id::text,
            metric_name,
            ROUND(AVG(value)::numeric, 1) AS avg_val,
            ROUND(MAX(value)::numeric, 1) AS peak_val
        FROM metrics
        WHERE metric_name IN ('cpu_percent', 'memory_percent')
          AND time >= NOW() - INTERVAL '24 hours'
        GROUP BY agent_id, metric_name
    """))
    for r in util_rows.fetchall():
        if r.agent_id in servers:
            if r.metric_name == 'cpu_percent':
                servers[r.agent_id]['cpu_avg_pct']  = float(r.avg_val)  if r.avg_val  is not None else None
                servers[r.agent_id]['cpu_peak_pct'] = float(r.peak_val) if r.peak_val is not None else None
            elif r.metric_name == 'memory_percent':
                servers[r.agent_id]['ram_avg_pct']  = float(r.avg_val)  if r.avg_val  is not None else None
                servers[r.agent_id]['ram_peak_pct'] = float(r.peak_val) if r.peak_val is not None else None

    # 4. Key services per server (running services only)
    svc_rows = await db.execute(text("""
        SELECT s.agent_id::text, s.service_name
        FROM services s
        JOIN agents a ON a.id = s.agent_id
        WHERE s.status = 'running'
          AND s.service_name ~* '(dns|ntds|mssql|mysql|sap|nginx|apache|iis|wsus|w3svc|wuauserv|TermService|UmRdpService|TermServLicensing|domino|lotus|nhttp|php|updateservices)'
          AND a.is_active = TRUE
          AND a.exclude_from_reports = FALSE
        ORDER BY s.agent_id, s.service_name
    """))
    for r in svc_rows.fetchall():
        if r.agent_id in servers:
            servers[r.agent_id]['services'].append(r.service_name)

    # 5. Software inventory (top items for role detection)
    sw_rows = await db.execute(text("""
        SELECT si.agent_id::text, si.name
        FROM software_inventory si
        JOIN agents a ON a.id = si.agent_id
        WHERE a.is_active = TRUE
          AND a.exclude_from_reports = FALSE
          AND si.name ~* '(sql server|mysql|sap|nginx|apache|iis)'
        ORDER BY si.agent_id, si.name
    """))
    for r in sw_rows.fetchall():
        if r.agent_id in servers:
            servers[r.agent_id]['software'].append(r.name)

    # 6. Licenses
    lic_rows = await db.execute(text("""
        SELECT l.agent_id::text, l.software_name, l.license_type
        FROM agent_licenses l
        JOIN agents a ON a.id = l.agent_id
        WHERE a.is_active = TRUE
          AND a.exclude_from_reports = FALSE
          AND l.software_name NOT ILIKE '%ubuntu pro%'
    """))
    for r in lic_rows.fetchall():
        if r.agent_id in servers:
            servers[r.agent_id]['licenses'].append({
                'software_name': r.software_name,
                'license_type':  r.license_type,
            })

    # MSSQL database licenses
    dblic_rows = await db.execute(text("""
        SELECT si.agent_id::text, si.name AS software_name
        FROM software_inventory si
        JOIN agents a ON a.id = si.agent_id
        WHERE a.is_active = TRUE
          AND a.exclude_from_reports = FALSE
          AND si.name ~* '^Microsoft SQL Server 20[0-9]+ \(64-bit\)$'
    """))
    for r in dblic_rows.fetchall():
        if r.agent_id in servers:
            servers[r.agent_id]['licenses'].append({
                'software_name': r.software_name,
                'license_type':  'database',
            })

    # 7. Auto-detect role for each server
    for aid, s in servers.items():
        s['detected_role'] = _detect_role(
            s['services'], s['software'],
            s.get('os_type', ''), s.get('asset_type', '') or '',
            s.get('hostname', ''),
        )

    # 8. Existing consolidation plans
    plan_rows = await db.execute(text("""
        SELECT
            cp.agent_id::text,
            cp.server_role,
            cp.recommended_action,
            cp.confirmed_action,
            cp.destination_server_id::text,
            cp.utilization_notes,
            cp.dependency_notes,
            cp.has_dependencies,
            cp.retention_months,
            cp.retention_notes,
            cp.target_date,
            cp.rollback_plan,
            cp.confirmed_by,
            cp.status,
            cp.priority,
            cp.updated_at
        FROM consolidation_plans cp
        JOIN agents a ON a.id = cp.agent_id
        WHERE a.is_active = TRUE
          AND a.exclude_from_reports = FALSE
    """))
    for r in plan_rows.fetchall():
        d = dict(r._mapping)
        aid = d.pop('agent_id')
        if d.get('target_date'):
            d['target_date'] = d['target_date'].isoformat()
        if d.get('updated_at'):
            d['updated_at'] = d['updated_at'].isoformat()
        if aid in servers:
            servers[aid]['plan'] = d

    # Build name lookup for destination server resolution
    name_map = {aid: s['name'] for aid, s in servers.items()}

    return {
        'generated_at': datetime.datetime.utcnow().isoformat() + 'Z',
        'name_map': name_map,
        'servers': list(servers.values()),
    }


@router.post("/auto-suggest")
async def auto_suggest(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """
    Run auto-suggestion algorithm for all active servers.
    Upserts consolidation_plans with recommended_action, priority, and notes.
    Only fills fields that are not yet confirmed (confirmed_action is NULL).
    """
    await _ensure_table(db)

    # Fetch data needed for suggestion
    rows = await db.execute(text("""
        SELECT
            a.id::text AS agent_id,
            a.hostname,
            a.os_type,
            a.os_version,
            a.asset_type,
            (
                SELECT ROUND(AVG(m.value)::numeric, 1)
                FROM metrics m
                WHERE m.agent_id = a.id
                  AND m.metric_name = 'cpu_percent'
                  AND m.time >= NOW() - INTERVAL '24 hours'
            ) AS cpu_avg,
            (
                SELECT ROUND(AVG(m.value)::numeric, 1)
                FROM metrics m
                WHERE m.agent_id = a.id
                  AND m.metric_name = 'memory_percent'
                  AND m.time >= NOW() - INTERVAL '24 hours'
            ) AS ram_avg
        FROM agents a
        WHERE a.is_active = TRUE
          AND a.exclude_from_reports = FALSE
    """))
    agent_rows = rows.fetchall()

    # Fetch services and software for role detection
    all_ids = [r.agent_id for r in agent_rows]
    svc_rows = await db.execute(text("""
        SELECT s.agent_id::text, s.service_name
        FROM services s
        JOIN agents a ON a.id = s.agent_id
        WHERE s.status = 'running'
          AND s.service_name ~* '(dns|ntds|mssql|mysql|sap|nginx|apache|iis|wsus|TermService|UmRdpService|TermServLicensing|domino|lotus|nhttp|php|updateservices)'
          AND a.is_active = TRUE
          AND a.exclude_from_reports = FALSE
    """))
    svc_map: dict = defaultdict(list)
    for r in svc_rows.fetchall():
        svc_map[r.agent_id].append(r.service_name)

    sw_rows = await db.execute(text("""
        SELECT si.agent_id::text, si.name
        FROM software_inventory si
        JOIN agents a ON a.id = si.agent_id
        WHERE a.is_active = TRUE
          AND a.exclude_from_reports = FALSE
          AND si.name ~* '(sql server|mysql|sap|nginx|apache)'
    """))
    sw_map: dict = defaultdict(list)
    for r in sw_rows.fetchall():
        sw_map[r.agent_id].append(r.name)

    # Build hostname lookup
    hostname_map = {r.agent_id: (r.hostname or '') for r in agent_rows}

    updated = 0
    for row in agent_rows:
        aid = row.agent_id
        services = svc_map.get(aid, [])
        software = sw_map.get(aid, [])
        hostname = hostname_map.get(aid, '')
        role = _detect_role(services, software, row.os_type or '', row.asset_type or '', hostname)
        suggestion = _auto_suggest(
            row.os_version or '',
            row.os_type or '',
            row.asset_type or '',
            float(row.cpu_avg) if row.cpu_avg is not None else None,
            float(row.ram_avg) if row.ram_avg is not None else None,
            role,
            services,
            hostname,
        )

        await db.execute(text("""
            INSERT INTO consolidation_plans
                (agent_id, server_role, recommended_action, priority,
                 utilization_notes, dependency_notes,
                 retention_months, retention_notes,
                 status, updated_at)
            VALUES
                (:aid, :role, :action, :priority,
                 :util_notes, :dep_notes,
                 :ret_months, :ret_notes,
                 'draft', NOW())
            ON CONFLICT (agent_id) DO UPDATE SET
                server_role        = EXCLUDED.server_role,
                recommended_action = CASE
                    WHEN consolidation_plans.confirmed_action IS NULL
                    THEN EXCLUDED.recommended_action
                    ELSE consolidation_plans.recommended_action
                END,
                priority           = CASE
                    WHEN consolidation_plans.confirmed_action IS NULL
                    THEN EXCLUDED.priority
                    ELSE consolidation_plans.priority
                END,
                utilization_notes  = EXCLUDED.utilization_notes,
                dependency_notes   = EXCLUDED.dependency_notes,
                retention_months   = COALESCE(EXCLUDED.retention_months, consolidation_plans.retention_months),
                retention_notes    = CASE
                    WHEN EXCLUDED.retention_notes IS NOT NULL AND EXCLUDED.retention_notes != ''
                    THEN EXCLUDED.retention_notes
                    ELSE consolidation_plans.retention_notes
                END,
                updated_at         = NOW()
        """), {
            "aid":        aid,
            "role":       role,
            "action":     suggestion['recommended_action'],
            "priority":   suggestion['priority'],
            "util_notes": suggestion['utilization_notes'],
            "dep_notes":  suggestion['dependency_notes'],
            "ret_months": suggestion.get('retention_months'),
            "ret_notes":  suggestion.get('retention_notes', ''),
        })
        updated += 1

    await db.commit()
    return {"updated": updated, "message": f"Auto-suggested plans for {updated} servers."}


@router.put("/plans/{agent_id}")
async def upsert_plan(
    agent_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Create or update a consolidation plan entry for a specific server."""
    await _ensure_table(db)

    allowed = {
        'server_role', 'recommended_action', 'confirmed_action',
        'destination_server_id', 'utilization_notes', 'dependency_notes',
        'has_dependencies', 'retention_months', 'retention_notes',
        'target_date', 'rollback_plan', 'confirmed_by', 'status', 'priority',
    }
    fields = {k: v for k, v in body.items() if k in allowed}

    await db.execute(text("""
        INSERT INTO consolidation_plans (agent_id, updated_at, """ + ', '.join(fields.keys()) + """)
        VALUES (:agent_id, NOW(), """ + ', '.join(f':{k}' for k in fields) + """)
        ON CONFLICT (agent_id) DO UPDATE SET
            updated_at = NOW(),
            """ + ', '.join(f'{k} = :{k}' for k in fields) + """
    """), {"agent_id": agent_id, **fields})
    await db.commit()
    return {"ok": True}


@router.delete("/plans/{agent_id}")
async def delete_plan(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    await _ensure_table(db)
    await db.execute(text("DELETE FROM consolidation_plans WHERE agent_id = :aid::uuid"), {"aid": agent_id})
    await db.commit()
    return {"ok": True}


@router.get("/plans")
async def list_plans(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    await _ensure_table(db)
    rows = await db.execute(text("""
        SELECT cp.*, COALESCE(a.display_name, a.hostname) AS server_name,
               COALESCE(da.display_name, da.hostname) AS destination_name
        FROM consolidation_plans cp
        JOIN agents a ON a.id = cp.agent_id
        LEFT JOIN agents da ON da.id = cp.destination_server_id
        ORDER BY cp.priority, a.hostname
    """))
    result = []
    for r in rows.fetchall():
        d = dict(r._mapping)
        d['agent_id'] = str(d['agent_id'])
        if d.get('destination_server_id'):
            d['destination_server_id'] = str(d['destination_server_id'])
        for ts in ('target_date', 'created_at', 'updated_at'):
            if d.get(ts):
                d[ts] = d[ts].isoformat()
        result.append(d)
    return result
