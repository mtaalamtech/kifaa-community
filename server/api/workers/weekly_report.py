"""
Weekly Server Health Status Report generator.
Produces a .docx matching the KNC template and emails it via SMTP notification channel.
"""
import io
import datetime
import smtplib
import logging
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email.mime.text import MIMEText
from email import encoders

logger = logging.getLogger(__name__)

# ── Thresholds ────────────────────────────────────────────────────────────────
CPU_WARN = 80
MEM_WARN = 85
DISK_WARN = 80


def _status_emoji(status: str) -> str:
    s = (status or "").lower()
    if s in ("online", "up", "healthy", "good"):
        return "🟢"
    if s in ("warning", "monitor", "degraded"):
        return "🟡"
    return "🔴"


def _pct_status(val) -> str:
    if val is None:
        return "N/A"
    if val >= DISK_WARN:
        return "Monitor"
    return "Healthy"


# ── Compliance scoring (pure psycopg2 — no asyncio, works anywhere) ──────────

def _compliance_scores_sync(cur) -> dict:
    try:
        # Patch score: % agents with zero pending security patches
        cur.execute("""
            SELECT
                COUNT(DISTINCT a.id) AS total,
                COUNT(DISTINCT a.id) FILTER (
                    WHERE NOT EXISTS (
                        SELECT 1 FROM agent_patches p
                        WHERE p.agent_id = a.id AND LOWER(p.category) = 'security'
                    )
                ) AS compliant
            FROM agents a
            WHERE a.is_active = TRUE AND a.status = 'online' AND a.exclude_from_reports = FALSE
        """)
        r = cur.fetchone()
        total, compliant = (r[0] or 0), (r[1] or 0)
        patch_s = round(compliant / total * 100, 1) if total > 0 else 100.0

        # Vuln score: penalise open critical/high CVEs
        cur.execute("""
            SELECT
                COUNT(*) FILTER (WHERE severity = 'critical') AS critical,
                COUNT(*) FILTER (WHERE severity = 'high') AS high
            FROM agent_vulnerabilities WHERE status = 'open'
        """)
        r = cur.fetchone()
        critical, high = (r[0] or 0), (r[1] or 0)
        vuln_s = min(100.0, max(0.0, round(100.0 - critical * 20 - high * 10, 1)))

        # Config score: misconfig pass rate
        cur.execute("SELECT COUNT(*) FILTER (WHERE status='pass'), COUNT(*) FROM agent_misconfigs")
        r = cur.fetchone()
        passed, total_mc = (r[0] or 0), (r[1] or 0)
        config_s = round(passed / total_mc * 100, 1) if total_mc > 0 else 100.0

        # Protection score: % Windows agents with AV
        cur.execute("""
            SELECT
                COUNT(DISTINCT a.id) AS total,
                COUNT(DISTINCT a.id) FILTER (WHERE s.av_installed = TRUE AND s.av_running = TRUE) AS protected
            FROM agents a
            LEFT JOIN agent_security_state s ON s.agent_id = a.id
            WHERE a.is_active = TRUE AND a.status = 'online'
              AND a.os_type = 'windows' AND a.exclude_from_reports = FALSE
        """)
        r = cur.fetchone()
        total_w, protected = (r[0] or 0), (r[1] or 0)
        prot_s = round(protected / total_w * 100, 1) if total_w > 0 else 100.0

        # License score: % activated licenses
        cur.execute("SELECT COUNT(*) FILTER (WHERE activation_status='activated'), COUNT(*) FROM agent_licenses")
        r = cur.fetchone()
        activated, total_lic = (r[0] or 0), (r[1] or 0)
        lic_s = round(activated / total_lic * 100, 1) if total_lic > 0 else 100.0

        overall = round(patch_s * 0.35 + vuln_s * 0.25 + config_s * 0.20 + prot_s * 0.10 + lic_s * 0.10, 1)
        return {"patch": patch_s, "vuln": vuln_s, "config": config_s,
                "protection": prot_s, "license": lic_s, "overall": overall}
    except Exception as e:
        logger.warning(f"Compliance score error: {e}")
        return {"patch": 0, "vuln": 0, "config": 0, "protection": 0, "license": 0, "overall": 0}


# ── Data collection (psycopg2 sync cursor) ───────────────────────────────────

def collect_report_data(cur) -> dict:
    # Set statement timeout to prevent hanging on large tables
    cur.execute("SET statement_timeout = '15s'")

    today = datetime.date.today()
    # Report covers the previous Mon–Sun week
    # If today is Monday (weekday=0), previous week ended yesterday (Sunday)
    # week_end = most recent Sunday, week_start = 6 days before that
    days_since_monday = today.weekday()  # 0=Mon … 6=Sun
    if days_since_monday == 0:
        # It's Monday — report covers last Mon→Sun
        week_end = today - datetime.timedelta(days=1)    # yesterday (Sunday)
    else:
        week_end = today - datetime.timedelta(days=days_since_monday + 1)  # last Sunday
    week_start = week_end - datetime.timedelta(days=6)   # the Monday before

    # ── Agents ───────────────────────────────────────────────────────────────
    cur.execute("""
        SELECT a.id::text, a.hostname, a.display_name, a.ip_address, a.os_type, a.os_name,
               a.status, a.last_seen, a.registered_at
        FROM agents a
        WHERE a.is_active = TRUE AND a.exclude_from_reports = FALSE
        ORDER BY a.hostname
    """)
    agents = [dict(zip([d[0] for d in cur.description], row)) for row in cur.fetchall()]

    # ── Latest metrics per agent (cpu/mem only) ─────────────────────────────
    metrics = {}
    try:
        cur.execute("""
            SELECT DISTINCT ON (agent_id, metric_name)
                agent_id::text, metric_name, ROUND(value::numeric, 1)
            FROM metrics
            WHERE time >= NOW() - INTERVAL '2 hours'
              AND metric_name IN ('cpu_percent', 'memory_percent')
            ORDER BY agent_id, metric_name, time DESC
        """)
        for agent_id, metric_name, val in cur.fetchall():
            if agent_id not in metrics:
                metrics[agent_id] = {}
            key = {"cpu_percent": "cpu", "memory_percent": "mem"}.get(metric_name, metric_name)
            metrics[agent_id][key] = float(val) if val is not None else None
    except Exception as e:
        logger.warning(f"Metrics query failed (table may be large): {e}")
        cur.execute("ROLLBACK")

    # ── Per-partition disk metrics ────────────────────────────────────────────
    disk_partitions = {}
    try:
        cur.execute("""
            WITH latest AS (
                SELECT DISTINCT ON (agent_id, metric_name, tags->>'mountpoint')
                    agent_id,
                    metric_name,
                    ROUND(value::numeric, 1) AS value,
                    tags->>'mountpoint' AS mountpoint
                FROM metrics
                WHERE time >= NOW() - INTERVAL '2 hours'
                  AND metric_name IN ('disk_percent', 'disk_total_gb', 'disk_used_gb')
                  AND tags->>'mountpoint' IS NOT NULL
                ORDER BY agent_id, metric_name, tags->>'mountpoint', time DESC
            )
            SELECT
                l.agent_id::text,
                l.mountpoint,
                MAX(CASE WHEN l.metric_name='disk_percent'  THEN l.value END) AS pct,
                MAX(CASE WHEN l.metric_name='disk_total_gb' THEN l.value END) AS total_gb,
                MAX(CASE WHEN l.metric_name='disk_used_gb'  THEN l.value END) AS used_gb
            FROM latest l
            LEFT JOIN disk_volume_settings dvs
                   ON dvs.agent_id = l.agent_id AND dvs.mountpoint = l.mountpoint
            WHERE COALESCE(dvs.exclude_from_reports, FALSE) = FALSE
            GROUP BY l.agent_id, l.mountpoint
            ORDER BY l.agent_id, l.mountpoint
        """)
        for agent_id, mountpoint, pct, total_gb, used_gb in cur.fetchall():
            if agent_id not in disk_partitions:
                disk_partitions[agent_id] = []
            disk_partitions[agent_id].append({
                "mountpoint": mountpoint or "?",
                "percent":  float(pct)      if pct      is not None else None,
                "total_gb": float(total_gb) if total_gb is not None else None,
                "used_gb":  float(used_gb)  if used_gb  is not None else None,
            })
        # Also store worst disk pct per agent in metrics dict (for risk checks)
        for agent_id, parts in disk_partitions.items():
            pcts = [p["percent"] for p in parts if p["percent"] is not None]
            if pcts:
                if agent_id not in metrics:
                    metrics[agent_id] = {}
                metrics[agent_id]["disk"] = max(pcts)
    except Exception as e:
        logger.warning(f"Disk partition query failed: {e}")
        cur.execute("ROLLBACK")

    # ── Uptime from monitor_results (last 7 days) ────────────────────────────
    cur.execute("""
        SELECT m.name, m.host,
               ROUND(SUM(CASE WHEN r.status='up' THEN 1 ELSE 0 END)::numeric /
                     NULLIF(COUNT(*),0) * 100, 1) AS uptime_pct
        FROM monitors m
        JOIN monitor_results r ON r.monitor_id = m.id
        WHERE r.time >= NOW() - INTERVAL '7 days'
          AND m.is_active = TRUE
        GROUP BY m.name, m.host
    """)
    uptime_by_host = {}
    for name, host, pct in cur.fetchall():
        uptime_by_host[host.lower()] = float(pct) if pct else None

    # ── Alerts / Incidents (last 7 days) ────────────────────────────────────
    cur.execute("""
        SELECT a.severity, ag.hostname, a.message, a.triggered_at, a.resolved_at
        FROM alerts a
        LEFT JOIN agents ag ON ag.id = a.agent_id
        WHERE a.triggered_at >= NOW() - INTERVAL '7 days'
        ORDER BY a.triggered_at DESC
        LIMIT 30
    """)
    alerts = [dict(zip([d[0] for d in cur.description], row)) for row in cur.fetchall()]

    # Build IP → hostname map for enriching monitor alerts that lack an agent join
    ip_to_hostname = {(ag["ip_address"] or "").lower(): ag.get("display_name") or ag["hostname"]
                      for ag in agents if ag.get("ip_address")}

    # ── Patch summary ─────────────────────────────────────────────────────────
    cur.execute("""
        SELECT
            a.hostname,
            COUNT(p.id) FILTER (WHERE LOWER(p.category)='security') AS security_patches,
            COUNT(p.id) AS total_patches
        FROM agents a
        LEFT JOIN agent_patches p ON p.agent_id = a.id
        WHERE a.is_active = TRUE AND a.exclude_from_reports = FALSE
        GROUP BY a.id, a.hostname
        ORDER BY a.hostname
    """)
    patch_by_agent = {row[0]: {"security": row[1] or 0, "total": row[2] or 0}
                      for row in cur.fetchall()}

    cur.execute("""
        SELECT
            COUNT(DISTINCT a.id) AS total,
            COUNT(DISTINCT a.id) FILTER (
                WHERE NOT EXISTS (SELECT 1 FROM agent_patches p WHERE p.agent_id = a.id AND LOWER(p.category)='security')
            ) AS fully_patched,
            COUNT(DISTINCT a.id) FILTER (
                WHERE EXISTS (SELECT 1 FROM agent_patches p WHERE p.agent_id = a.id)
            ) AS has_pending,
            COUNT(DISTINCT a.id) FILTER (WHERE a.restart_pending = TRUE) AS pending_reboot
        FROM agents a WHERE a.is_active = TRUE AND a.exclude_from_reports = FALSE
    """)
    r = cur.fetchone()
    patch_summary = {
        "total": r[0] or 0,
        "fully_patched": r[1] or 0,
        "pending_updates": r[2] or 0,
        "failed_updates": 0,  # not tracked separately
        "pending_reboot": r[3] or 0,
    }

    # Recent patch installs (last 7 days)
    # Exclude rows with clearly bad future timestamps (agent clock skew / parse error)
    recent_patches = []
    try:
        cur.execute("""
            SELECT ag.hostname, h.title, h.result, h.installed_at
            FROM agent_update_history h
            JOIN agents ag ON ag.id = h.agent_id
            WHERE h.installed_at >= NOW() - INTERVAL '7 days'
              AND h.installed_at <= NOW() + INTERVAL '1 year'
            ORDER BY h.installed_at DESC
            LIMIT 10
        """)
        recent_patches = [dict(zip([d[0] for d in cur.description], row)) for row in cur.fetchall()]
    except Exception as e:
        logger.warning(f"agent_update_history query failed: {e}")
        cur.execute("ROLLBACK")

    # ── Backup status — Unitrends jobs by VM instance ────────────────────────
    unitrends_backup_rows = []
    backup_by_agent = {}  # legacy fallback
    cur.execute("SELECT COUNT(*) FROM unitrends_backups WHERE start_time >= NOW() - INTERVAL '7 days'")
    if cur.fetchone()[0] > 0:
        cur.execute("""
            SELECT
                instance_name,
                backup_type,
                COUNT(*) AS total,
                SUM(CASE WHEN status IN ('success','successful') THEN 1 ELSE 0 END) AS ok,
                SUM(CASE WHEN status IN ('failure','failed') THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN status = 'warning' THEN 1 ELSE 0 END) AS warnings,
                MAX(CASE WHEN status IN ('success','successful') THEN end_time END) AS last_success
            FROM unitrends_backups
            WHERE start_time >= NOW() - INTERVAL '7 days'
            GROUP BY instance_name, backup_type
            ORDER BY instance_name, backup_type
        """)
        for row in cur.fetchall():
            instance, btype, total, ok, failed, warnings, last_success = row
            ok = ok or 0; failed = failed or 0; warnings = warnings or 0; total = total or 0
            if failed > 0 and ok == 0:
                status = "Failed"
            elif failed > 0:
                status = "Partial"
            elif warnings > 0 and ok == 0:
                status = "Warning"
            else:
                status = "Successful"
            unitrends_backup_rows.append({
                "instance": instance,
                "type": btype.capitalize() if btype else "–",
                "status": status,
                "total": total,
                "ok": ok,
                "failed": failed,
                "warnings": warnings,
                "last_success": last_success.strftime("%d/%m %H:%M") if last_success else "None",
            })
    else:
        # Fallback: backup_history table
        cur.execute("""
            SELECT ag.hostname, MAX(b.backup_date) AS last_bk,
                   SUM(CASE WHEN b.status='success' THEN 1 ELSE 0 END) AS ok,
                   COUNT(b.id) AS total
            FROM backup_history b
            JOIN agents ag ON ag.id = b.agent_id
            WHERE b.backup_date >= NOW() - INTERVAL '7 days'
            GROUP BY ag.hostname
        """)
        for row in cur.fetchall():
            name, last_bk, ok, total = row
            backup_by_agent[name] = {
                "status": "Successful" if (ok or 0) == (total or 1) else "Failed",
                "last_backup": last_bk.strftime("%d/%m/%Y") if last_bk else "No backup"
            }

    # ── Windows unactivated licenses ─────────────────────────────────────────
    unactivated_windows = []
    try:
        cur.execute("""
            SELECT DISTINCT a.hostname
            FROM agents a
            JOIN agent_licenses l ON l.agent_id = a.id
            WHERE l.activation_status IN ('not_activated', 'grace_period')
              AND l.software_name ILIKE '%Windows%'
              AND a.os_type = 'windows'
              AND a.is_active = TRUE AND a.exclude_from_reports = FALSE
            ORDER BY a.hostname
        """)
        unactivated_windows = [r[0] for r in cur.fetchall()]
    except Exception as e:
        logger.warning(f"Unactivated licenses query failed: {e}")
        cur.execute("ROLLBACK")

    # ── AD account lockouts (unlock actions this week) ────────────────────────
    ad_lockouts = []
    try:
        cur.execute("""
            SELECT target_user, COUNT(*) AS lockout_count
            FROM ad_action_log
            WHERE action = 'unlock'
              AND created_at >= NOW() - INTERVAL '7 days'
            GROUP BY target_user
            ORDER BY lockout_count DESC
        """)
        ad_lockouts = [{"user": r[0], "count": r[1]} for r in cur.fetchall()]
    except Exception as e:
        logger.warning(f"AD lockout query failed: {e}")
        cur.execute("ROLLBACK")

    # ── Sophos Central endpoint security data ────────────────────────────────
    sophos_summary = None
    sophos_eol = []
    sophos_stale = []
    sophos_unhealthy = []
    sophos_alerts_by_cat = []
    try:
        cur.execute("SELECT is_enabled FROM integration_plugins WHERE plugin_type='sophos'")
        row = cur.fetchone()
        if row and row[0]:
            cur.execute("""
                SELECT
                    COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE health_status='good') AS healthy,
                    COUNT(*) FILTER (WHERE health_status='suspicious') AS suspicious,
                    COUNT(*) FILTER (WHERE health_status='bad') AS bad,
                    COUNT(*) FILTER (WHERE last_seen IS NULL OR last_seen < NOW() - INTERVAL '7 days') AS stale,
                    COUNT(*) FILTER (WHERE os_name ILIKE ANY(ARRAY[
                        '%Windows 7%','%Windows XP%','%Windows Vista%',
                        '%Server 2003%','%Server 2008%','%Server 2012%','%Windows 8%'
                    ])) AS eol
                FROM sophos_endpoints
            """)
            r = cur.fetchone()
            if r:
                sophos_summary = {"total": r[0], "healthy": r[1], "suspicious": r[2],
                                  "bad": r[3], "stale": r[4], "eol": r[5]}
            cur.execute("""
                SELECT hostname, os_name, health_status, ip_address, last_seen
                FROM sophos_endpoints
                WHERE health_status IN ('bad','suspicious')
                ORDER BY CASE health_status WHEN 'bad' THEN 0 ELSE 1 END, hostname
            """)
            sophos_unhealthy = [{"hostname": r[0], "os_name": r[1], "health_status": r[2],
                                  "ip_address": r[3], "last_seen": r[4]} for r in cur.fetchall()]
            cur.execute("""
                SELECT hostname, os_name, health_status, last_seen
                FROM sophos_endpoints
                WHERE os_name ILIKE ANY(ARRAY[
                    '%Windows 7%','%Windows XP%','%Windows Vista%',
                    '%Server 2003%','%Server 2008%','%Server 2012%','%Windows 8%'
                ])
                ORDER BY os_name, hostname
            """)
            sophos_eol = [{"hostname": r[0], "os_name": r[1].strip() if r[1] else r[1],
                            "health_status": r[2], "last_seen": r[3]} for r in cur.fetchall()]
            cur.execute("""
                SELECT hostname, os_name, last_seen
                FROM sophos_endpoints
                WHERE last_seen IS NULL OR last_seen < NOW() - INTERVAL '7 days'
                ORDER BY last_seen NULLS FIRST, hostname
                LIMIT 25
            """)
            sophos_stale = [{"hostname": r[0], "os_name": r[1].strip() if r[1] else "",
                              "last_seen": r[2]} for r in cur.fetchall()]
            cur.execute("""
                SELECT category, COUNT(*) AS cnt
                FROM sophos_alerts
                WHERE raised_at >= NOW() - INTERVAL '7 days'
                GROUP BY category ORDER BY cnt DESC
            """)
            sophos_alerts_by_cat = [{"category": r[0] or "unknown", "count": r[1]}
                                     for r in cur.fetchall()]
    except Exception as e:
        logger.warning(f"Sophos data collection failed: {e}")
        try: cur.execute("ROLLBACK")
        except Exception: pass

    # ── Sophos license expiry data ────────────────────────────────────────────
    sophos_licenses = []
    try:
        cur.execute("SELECT COUNT(*) FROM sophos_licenses")
        if (cur.fetchone() or [0])[0] > 0:
            cur.execute("""
                SELECT
                    product_name, license_type, quantity, used_quantity,
                    starts_at, expires_at,
                    CASE
                        WHEN expires_at IS NULL THEN 'perpetual'
                        WHEN expires_at <= NOW() THEN 'expired'
                        WHEN expires_at <= NOW() + INTERVAL '30 days' THEN 'expiring_soon'
                        ELSE 'active'
                    END AS expiry_status,
                    CASE WHEN expires_at IS NOT NULL AND expires_at > NOW()
                         THEN EXTRACT(DAY FROM expires_at - NOW())::int
                         ELSE NULL
                    END AS days_remaining
                FROM sophos_licenses
                ORDER BY
                    CASE
                        WHEN expires_at IS NULL THEN 3
                        WHEN expires_at <= NOW() THEN 0
                        WHEN expires_at <= NOW() + INTERVAL '30 days' THEN 1
                        ELSE 2
                    END,
                    expires_at ASC NULLS LAST
            """)
            for row in cur.fetchall():
                sophos_licenses.append({
                    "product_name": row[0],
                    "license_type": row[1],
                    "quantity": row[2] or 0,
                    "used_quantity": row[3] or 0,
                    "starts_at": row[4],
                    "expires_at": row[5],
                    "expiry_status": row[6],
                    "days_remaining": row[7],
                })
    except Exception as e:
        logger.warning(f"Sophos license data collection failed: {e}")
        try: cur.execute("ROLLBACK")
        except Exception: pass

    # ── Agent EOL detection (Windows + Linux) ────────────────────────────────
    # Identifies managed servers running operating systems past their vendor end-of-life date.
    agent_eol = []
    try:
        cur.execute("""
            SELECT hostname, display_name, os_type, os_name, os_version, status
            FROM agents
            WHERE is_active = TRUE AND exclude_from_reports = FALSE
            ORDER BY os_type, os_name, hostname
        """)
        for row in cur.fetchall():
            hostname, display_name, os_type, os_name, os_ver, status = row
            os_lower = (os_name or "").lower()
            eol_reason = None

            if os_type == "windows":
                if any(x in os_lower for x in ("2003", "xp", "vista")):
                    eol_reason = "End-of-life since 2015 or earlier"
                elif any(x in os_lower for x in ("2008", "windows 7")):
                    eol_reason = "End-of-life since January 2020"
                elif any(x in os_lower for x in ("windows 8", "2012")):
                    eol_reason = "End-of-life since October 2023"
            elif os_type == "linux":
                if "ubuntu 18.04" in os_lower or "bionic" in os_lower:
                    eol_reason = "Standard support ended April 2023 (Ubuntu 18.04)"
                elif "ubuntu 16.04" in os_lower or "xenial" in os_lower:
                    eol_reason = "End-of-life since April 2021 (Ubuntu 16.04)"
                elif "ubuntu 14.04" in os_lower or "trusty" in os_lower:
                    eol_reason = "End-of-life since April 2019 (Ubuntu 14.04)"
                elif "centos linux 8" in os_lower or "centos 8" in os_lower:
                    eol_reason = "End-of-life since December 2021 (CentOS 8)"
                elif "centos linux 7" in os_lower or "centos 7" in os_lower:
                    eol_reason = "End-of-life since June 2024 (CentOS 7)"
                elif "centos linux 6" in os_lower or "centos 6" in os_lower:
                    eol_reason = "End-of-life since November 2020 (CentOS 6)"
                elif "rhel 6" in os_lower or "red hat enterprise linux 6" in os_lower:
                    eol_reason = "End-of-life since November 2020 (RHEL 6)"
                elif "debian 9" in os_lower or "stretch" in os_lower:
                    eol_reason = "End-of-life since June 2022 (Debian 9)"
                elif "debian 10" in os_lower or "buster" in os_lower:
                    eol_reason = "End-of-life since June 2024 (Debian 10)"
                elif "suse linux enterprise server 12" in os_lower or "sles 12" in os_lower:
                    eol_reason = "End-of-life since October 2027 (SLES 12 SP5 extended) — SP4 EOL Jun 2024"

            if eol_reason:
                agent_eol.append({
                    "hostname": display_name or hostname,
                    "os_name": os_name,
                    "os_type": os_type,
                    "eol_reason": eol_reason,
                    "status": status,
                })
    except Exception as e:
        logger.warning(f"Agent EOL detection failed: {e}")
        try: cur.execute("ROLLBACK")
        except Exception: pass

    # ── Compliance scores (pure SQL — works in both sync Celery and async FastAPI) ──
    compliance = _compliance_scores_sync(cur)

    # ── Risks ─────────────────────────────────────────────────────────────────
    risks = []
    for ag in agents:
        aid = ag["id"]
        m = metrics.get(aid, {})
        disk = m.get("disk")
        if disk and disk >= DISK_WARN:
            risks.append({
                "risk": f"{ag['hostname']} disk at {disk:.0f}%",
                "impact": "Potential service disruption if disk fills",
                "recommendation": "Free up space or expand storage capacity",
            })
        cpu = m.get("cpu")
        if cpu and cpu >= CPU_WARN:
            risks.append({
                "risk": f"{ag['hostname']} avg CPU at {cpu:.0f}%",
                "impact": "Performance degradation under load",
                "recommendation": "Review running processes and capacity",
            })
    if patch_summary["pending_updates"] > 0:
        risks.append({
            "risk": f"{patch_summary['pending_updates']} server(s) have pending security patches",
            "impact": "Exposure to known vulnerabilities",
            "recommendation": "Schedule patching during next maintenance window",
        })
    if sophos_summary and sophos_summary.get("eol", 0) > 0:
        risks.append({
            "risk": f"{sophos_summary['eol']} endpoint(s) running end-of-life OS (Windows 7 / Server 2008/2012)",
            "impact": "No security patches from Microsoft — high vulnerability exposure",
            "recommendation": "Plan OS upgrade or isolate EOL machines from production network",
        })
    if agent_eol:
        win_eol = [e for e in agent_eol if e["os_type"] == "windows"]
        lin_eol = [e for e in agent_eol if e["os_type"] == "linux"]
        if win_eol:
            names = ", ".join(e["hostname"] for e in win_eol[:4])
            risks.append({
                "risk": f"{len(win_eol)} managed server(s) running end-of-life Windows: {names}",
                "impact": "No security patches — unpatched vulnerabilities exploitable by ransomware and malware",
                "recommendation": "Upgrade to Windows Server 2022 or 2019; isolate from network if upgrade not immediate",
            })
        if lin_eol:
            names = ", ".join(e["hostname"] for e in lin_eol[:4])
            risks.append({
                "risk": f"{len(lin_eol)} managed server(s) running end-of-life Linux: {names}",
                "impact": "No vendor security updates — kernel and package vulnerabilities remain unpatched",
                "recommendation": "Upgrade to a supported distribution version or migrate workloads",
            })
    if sophos_summary and sophos_summary.get("bad", 0) > 0:
        risks.append({
            "risk": f"{sophos_summary['bad']} endpoint(s) in 'bad' health state in Sophos Central",
            "impact": "Active threat or compromised security posture",
            "recommendation": "Investigate immediately — check Sophos Central for threat details",
        })
    expired_lics = [l for l in sophos_licenses if l["expiry_status"] == "expired"]
    expiring_lics = [l for l in sophos_licenses if l["expiry_status"] == "expiring_soon"]
    if expired_lics:
        names = ", ".join(l["product_name"] for l in expired_lics[:3])
        risks.append({
            "risk": f"{len(expired_lics)} Sophos license(s) have expired: {names}",
            "impact": "Endpoint protection may be degraded or non-functional",
            "recommendation": "Renew expired Sophos licenses immediately",
        })
    if expiring_lics:
        soonest = min(l["days_remaining"] for l in expiring_lics if l["days_remaining"] is not None)
        names = ", ".join(l["product_name"] for l in expiring_lics[:3])
        risks.append({
            "risk": f"{len(expiring_lics)} Sophos license(s) expiring within 30 days (soonest: {soonest} days): {names}",
            "impact": "Loss of endpoint protection coverage after expiry",
            "recommendation": "Initiate license renewal process before expiry date",
        })
    if not risks:
        risks.append({
            "risk": "No significant risks identified",
            "impact": "–",
            "recommendation": "Continue routine monitoring",
        })

    # ── Summary counts ────────────────────────────────────────────────────────
    online = [a for a in agents if a["status"] == "online"]
    warnings = [a for a in agents if a["status"] in ("warning",)]
    critical = [a for a in agents if a["status"] in ("offline", "critical")]
    total_checks = len(online) + len(warnings) + len(critical)
    availability = round(len(online) / total_checks * 100, 1) if total_checks else 100.0

    return {
        "week_start": week_start,
        "week_end": week_end,
        "generated_at": datetime.datetime.now(),
        "agents": agents,
        "metrics": metrics,
        "uptime_by_host": uptime_by_host,
        "alerts": alerts,
        "patch_by_agent": patch_by_agent,
        "patch_summary": patch_summary,
        "recent_patches": recent_patches,
        "disk_partitions": disk_partitions,
        "backup_by_agent": backup_by_agent,
        "unitrends_backup_rows": unitrends_backup_rows,
        "sophos_summary": sophos_summary,
        "sophos_eol": sophos_eol,
        "sophos_stale": sophos_stale,
        "sophos_unhealthy": sophos_unhealthy,
        "sophos_alerts_by_cat": sophos_alerts_by_cat,
        "sophos_licenses": sophos_licenses,
        "agent_eol": agent_eol,
        "unactivated_windows": unactivated_windows,
        "ad_lockouts": ad_lockouts,
        "ip_to_hostname": ip_to_hostname,
        "compliance": compliance,
        "risks": risks,
        "summary": {
            "total": len(agents),
            "healthy": len(online),
            "warning": len(warnings),
            "critical": len(critical),
            "availability": availability,
            "incidents": len([a for a in alerts if a["severity"] in ("critical", "high")]),
        },
    }


# ── Word document builder ────────────────────────────────────────────────────

def build_docx(data: dict) -> bytes:
    from docx import Document
    from docx.shared import Pt, RGBColor, Inches, Cm
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    import copy

    doc = Document()

    # ── Page margins ──────────────────────────────────────────────────────────
    for section in doc.sections:
        section.top_margin = Cm(1.8)
        section.bottom_margin = Cm(1.8)
        section.left_margin = Cm(2.0)
        section.right_margin = Cm(2.0)

    # ── Colour palette ────────────────────────────────────────────────────────
    DARK_BLUE = RGBColor(0x1e, 0x29, 0x3b)
    MID_BLUE  = RGBColor(0x1d, 0x4e, 0xd8)
    LIGHT_BG  = RGBColor(0xf1, 0xf5, 0xf9)
    WHITE     = RGBColor(0xff, 0xff, 0xff)
    GREEN     = RGBColor(0x16, 0xa3, 0x4a)
    AMBER     = RGBColor(0xd9, 0x77, 0x06)
    RED       = RGBColor(0xdc, 0x26, 0x26)
    TEXT_GRAY = RGBColor(0x47, 0x55, 0x69)

    def _set_cell_bg(cell, rgb: RGBColor):
        tc = cell._tc
        tcPr = tc.get_or_add_tcPr()
        shd = OxmlElement('w:shd')
        shd.set(qn('w:val'), 'clear')
        shd.set(qn('w:color'), 'auto')
        shd.set(qn('w:fill'), f'{rgb[0]:02X}{rgb[1]:02X}{rgb[2]:02X}')
        tcPr.append(shd)

    def _set_cell_borders(cell, color="D1D5DB"):
        tc = cell._tc
        tcPr = tc.get_or_add_tcPr()
        tcBorders = OxmlElement('w:tcBorders')
        for side in ('top', 'left', 'bottom', 'right'):
            b = OxmlElement(f'w:{side}')
            b.set(qn('w:val'), 'single')
            b.set(qn('w:sz'), '4')
            b.set(qn('w:color'), color)
            tcBorders.append(b)
        tcPr.append(tcBorders)

    def _heading(text, level=1, color=DARK_BLUE):
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(14)
        p.paragraph_format.space_after = Pt(4)
        run = p.add_run(text)
        run.bold = True
        run.font.size = Pt(14 if level == 1 else 11)
        run.font.color.rgb = color
        return p

    def _para(text="", size=10, bold=False, color=TEXT_GRAY, italic=False):
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(2)
        p.paragraph_format.space_after = Pt(2)
        run = p.add_run(text)
        run.font.size = Pt(size)
        run.font.color.rgb = color
        run.bold = bold
        run.italic = italic
        return p

    def _table(headers, rows, col_widths=None):
        t = doc.add_table(rows=1, cols=len(headers))
        t.alignment = WD_TABLE_ALIGNMENT.LEFT
        t.style = 'Table Grid'
        # Header row
        hdr = t.rows[0]
        for i, h in enumerate(headers):
            cell = hdr.cells[i]
            cell.text = h
            cell.paragraphs[0].runs[0].bold = True
            cell.paragraphs[0].runs[0].font.size = Pt(9)
            cell.paragraphs[0].runs[0].font.color.rgb = WHITE
            cell.paragraphs[0].paragraph_format.space_before = Pt(3)
            cell.paragraphs[0].paragraph_format.space_after = Pt(3)
            _set_cell_bg(cell, DARK_BLUE)
        # Data rows
        for ri, row in enumerate(rows):
            tr = t.add_row()
            bg = LIGHT_BG if ri % 2 == 0 else WHITE
            for ci, val in enumerate(row):
                cell = tr.cells[ci]
                cell.text = str(val) if val is not None else "–"
                cell.paragraphs[0].runs[0].font.size = Pt(9)
                cell.paragraphs[0].runs[0].font.color.rgb = TEXT_GRAY
                cell.paragraphs[0].paragraph_format.space_before = Pt(2)
                cell.paragraphs[0].paragraph_format.space_after = Pt(2)
                _set_cell_bg(cell, bg)
                _set_cell_borders(cell)
        if col_widths:
            for i, w in enumerate(col_widths):
                for row in t.rows:
                    row.cells[i].width = Inches(w)
        doc.add_paragraph()
        return t

    import re as _re
    d = data
    s = d["summary"]
    agents = d["agents"]
    metrics = d["metrics"]
    disk_partitions = d.get("disk_partitions", {})
    ws = d["week_start"]
    we = d["week_end"]
    ip_to_hostname = d.get("ip_to_hostname", {})
    unactivated_windows = d.get("unactivated_windows", [])
    ad_lockouts = d.get("ad_lockouts", [])
    period = f"Week ending {we.strftime('%d %B %Y')} ({ws.strftime('%d %b')} – {we.strftime('%d %b %Y')})"

    # ══ TITLE ════════════════════════════════════════════════════════════════
    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = title.add_run("KNC SERVER HEALTH STATUS REPORT")
    run.bold = True
    run.font.size = Pt(18)
    run.font.color.rgb = DARK_BLUE

    sub = doc.add_paragraph()
    sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = sub.add_run(period)
    run.font.size = Pt(11)
    run.font.color.rgb = TEXT_GRAY
    run.italic = True

    meta = doc.add_paragraph()
    meta.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = meta.add_run(f"Prepared by: IT Operations  |  Generated: {d['generated_at'].strftime('%d %B %Y %H:%M')}")
    run.font.size = Pt(9)
    run.font.color.rgb = TEXT_GRAY

    doc.add_paragraph()

    # ══ 1. EXECUTIVE SUMMARY ════════════════════════════════════════════════
    _heading("1. Executive Summary")

    # Overall status badge
    if s["critical"] > 0:
        overall_status = "🔴 Critical"
    elif s["warning"] > 0:
        overall_status = "🟡 Warning"
    else:
        overall_status = "🟢 Healthy"

    _para(f"Overall Status: {overall_status}", size=11, bold=True, color=DARK_BLUE)

    summary_rows = [
        ["Total Servers Monitored", str(s["total"])],
        ["Healthy Servers",         str(s["healthy"])],
        ["Warning Status",          str(s["warning"])],
        ["Critical / Offline",      str(s["critical"])],
        ["Service Availability",    f"{s['availability']}%"],
        ["Major Incidents (week)",  str(s["incidents"])],
    ]
    _table(["Metric", "Value"], summary_rows, col_widths=[3.0, 1.5])

    _heading("Key Observations", level=2, color=MID_BLUE)
    obs = []
    if s["critical"] == 0:
        obs.append("All production servers remained operational during the reporting period.")
    else:
        obs.append(f"{s['critical']} server(s) were offline or in critical state during the reporting period.")
    for ag in agents:
        m = metrics.get(ag["id"], {})
        disk = m.get("disk")
        if disk and disk >= DISK_WARN:
            obs.append(f"Storage utilization on {ag['hostname']} reached {disk:.0f}%, approaching threshold.")
    if d["patch_summary"]["pending_updates"] > 0:
        obs.append(f"{d['patch_summary']['pending_updates']} server(s) have pending security patches awaiting installation.")
    if not d["alerts"]:
        obs.append("No critical alerts were raised during the reporting period.")
    else:
        critical_alerts = [a for a in d["alerts"] if a["severity"] in ("critical", "high")]
        if critical_alerts:
            obs.append(f"{len(critical_alerts)} high/critical alert(s) were triggered during the week.")
        else:
            obs.append("No critical alerts were raised. All alerts were informational or warnings.")
    # Windows activation
    if unactivated_windows:
        obs.append(
            f"Windows activation issue on {len(unactivated_windows)} server(s): "
            + ", ".join(unactivated_windows)
            + ". Licensing should be resolved to avoid service interruption."
        )
    # AD lockouts
    if ad_lockouts:
        lockout_parts = [f"{l['user']} ({l['count']} time{'s' if l['count'] != 1 else ''})" for l in ad_lockouts]
        obs.append(
            f"Active Directory account lockout(s) this week: {', '.join(lockout_parts)}. "
            "Review account security policies and investigate repeated lockouts."
        )
    # Sophos observations
    sophos_summary = d.get("sophos_summary")
    if sophos_summary:
        if sophos_summary.get("bad", 0) > 0:
            bad_hosts = [e["hostname"] for e in d.get("sophos_unhealthy", []) if e["health_status"] == "bad"]
            obs.append(
                f"Sophos Central: {sophos_summary['bad']} endpoint(s) in critical health state — "
                + (", ".join(bad_hosts[:5]) + ("…" if len(bad_hosts) > 5 else ""))
                + ". Immediate investigation recommended."
            )
        if sophos_summary.get("suspicious", 0) > 0:
            obs.append(f"Sophos Central: {sophos_summary['suspicious']} endpoint(s) flagged as suspicious — review threat details.")
        if sophos_summary.get("eol", 0) > 0:
            eol_hosts = [e["hostname"] for e in d.get("sophos_eol", [])]
            obs.append(
                f"{sophos_summary['eol']} endpoint(s) running end-of-life operating systems: "
                + ", ".join(eol_hosts[:6]) + ("…" if len(eol_hosts) > 6 else "")
                + ". Upgrade or isolate these machines."
            )
        if sophos_summary.get("stale", 0) > 0:
            obs.append(f"{sophos_summary['stale']} endpoint(s) have not reported to Sophos Central in over 7 days — verify agent connectivity.")
    agent_eol_list = d.get("agent_eol", [])
    if agent_eol_list:
        win_eol = [e for e in agent_eol_list if e["os_type"] == "windows"]
        lin_eol = [e for e in agent_eol_list if e["os_type"] == "linux"]
        if win_eol:
            names = ", ".join(e["hostname"] for e in win_eol[:5])
            obs.append(f"⚠ {len(win_eol)} managed server(s) running end-of-life Windows OS: {names}. No security patches available — upgrade required.")
        if lin_eol:
            names = ", ".join(e["hostname"] for e in lin_eol[:5])
            obs.append(f"⚠ {len(lin_eol)} managed server(s) running end-of-life Linux: {names}. Upgrade or migrate these systems.")
    sophos_lics = d.get("sophos_licenses", [])
    expired_lics = [l for l in sophos_lics if l["expiry_status"] == "expired"]
    expiring_lics = [l for l in sophos_lics if l["expiry_status"] == "expiring_soon"]
    if expired_lics:
        names = ", ".join(l["product_name"] for l in expired_lics[:3])
        obs.append(f"⚠ {len(expired_lics)} Sophos license(s) have expired: {names}. Endpoint protection may be at risk — renew immediately.")
    if expiring_lics:
        soonest = min(l["days_remaining"] for l in expiring_lics if l["days_remaining"] is not None)
        names = ", ".join(l["product_name"] for l in expiring_lics[:3])
        obs.append(f"{len(expiring_lics)} Sophos license(s) expiring within 30 days (soonest in {soonest} days): {names}. Initiate renewal.")
    if not obs:
        obs.append("No significant events recorded during this period.")

    for o in obs:
        p = doc.add_paragraph(style='List Bullet')
        p.paragraph_format.space_before = Pt(2)
        p.paragraph_format.space_after = Pt(2)
        run = p.add_run(o)
        run.font.size = Pt(10)
        run.font.color.rgb = TEXT_GRAY

    doc.add_paragraph()

    # ══ 2. SERVER STATUS OVERVIEW ════════════════════════════════════════════
    _heading("2. Server Status Overview")
    status_rows = []
    for ag in agents:
        m = metrics.get(ag["id"], {})
        disk = m.get("disk")
        host_key = (ag["ip_address"] or "").lower()
        uptime = d["uptime_by_host"].get(host_key) or d["uptime_by_host"].get(ag["hostname"].lower())
        uptime_str = f"{uptime:.1f}%" if uptime is not None else "N/A"
        status_rows.append([
            ag.get("display_name") or ag["hostname"],
            ag.get("os_name") or ag.get("os_type", "?"),
            _status_emoji(ag["status"]) + " " + ag["status"].capitalize(),
            uptime_str,
        ])
    _table(["Server", "OS", "Status", "Uptime (7d)"], status_rows, col_widths=[2.2, 2.2, 1.6, 1.2])

    # End-of-life OS sub-section (agent-based)
    agent_eol_list = d.get("agent_eol", [])
    if agent_eol_list:
        _heading("End-of-Life Operating Systems (Managed Servers)", level=2, color=MID_BLUE)
        _para(
            "The following managed servers are running operating systems that no longer receive "
            "security patches from their vendor. These represent a significant security risk.",
            size=9, italic=True, color=TEXT_GRAY,
        )
        eol_rows = []
        for e in agent_eol_list:
            eol_rows.append([
                e["hostname"],
                e["os_name"] or "—",
                e["os_type"].capitalize(),
                e["eol_reason"],
            ])
        tbl = _table(
            ["Server", "Operating System", "Type", "EOL Status"],
            eol_rows,
            col_widths=[1.8, 2.0, 0.8, 2.8],
        )
        # Colour all EOL rows red
        if tbl is not None:
            try:
                from docx.shared import RGBColor as _RGB
                RED = _RGB(0xC0, 0x39, 0x2B)
                for row_idx in range(1, len(tbl.rows)):
                    cell = tbl.rows[row_idx].cells[-1]
                    for para in cell.paragraphs:
                        for run in para.runs:
                            run.font.color.rgb = RED
                            run.font.bold = True
            except Exception:
                pass

    # ══ 3. RESOURCE UTILIZATION ══════════════════════════════════════════════
    _heading("3. Resource Utilization (Current)")
    _para("Thresholds: CPU > 80%  |  Memory > 85%  |  Disk > 80%", size=9, italic=True, color=TEXT_GRAY)

    def fmt_pct(v, warn):
        if v is None: return "N/A"
        flag = " ⚠" if v >= warn else ""
        return f"{v:.1f}%{flag}"

    res_rows = []
    for ag in agents:
        m = metrics.get(ag["id"], {})
        cpu = m.get("cpu")
        mem = m.get("mem")
        parts = disk_partitions.get(ag["id"], [])
        hostname = ag.get("display_name") or ag["hostname"]

        if not parts:
            overall = "Monitor" if (cpu and cpu >= CPU_WARN) or (mem and mem >= MEM_WARN) else "Healthy"
            res_rows.append([hostname, fmt_pct(cpu, CPU_WARN), fmt_pct(mem, MEM_WARN), "N/A", "N/A", overall])
        else:
            for i, p in enumerate(parts):
                label = hostname if i == 0 else ""
                cpu_str = fmt_pct(cpu, CPU_WARN) if i == 0 else ""
                mem_str = fmt_pct(mem, MEM_WARN) if i == 0 else ""
                disk_str = fmt_pct(p["percent"], DISK_WARN)
                mount = p["mountpoint"]
                pct = p["percent"]
                overall = "Monitor" if (pct and pct >= DISK_WARN) or (i == 0 and ((cpu and cpu >= CPU_WARN) or (mem and mem >= MEM_WARN))) else "Healthy"
                res_rows.append([label, cpu_str, mem_str, mount, disk_str, overall])

    _table(["Server", "CPU", "Memory", "Partition", "Disk Usage", "Status"],
           res_rows, col_widths=[1.8, 1.0, 1.0, 1.4, 1.2, 1.0])

    # ══ 4. SERVER AVAILABILITY ═══════════════════════════════════════════════
    _heading("4. Server Availability")
    avail_rows = []
    for ag in agents:
        host_key = (ag["ip_address"] or "").lower()
        uptime = d["uptime_by_host"].get(host_key) or d["uptime_by_host"].get(ag["hostname"].lower())
        # Planned/unplanned: derive from alerts
        unplanned = len([a for a in d["alerts"]
                         if (a.get("hostname") or "").lower() == ag["hostname"].lower()
                         and a["severity"] in ("critical", "high")])
        avail_rows.append([
            ag.get("display_name") or ag["hostname"],
            f"{uptime:.1f}%" if uptime is not None else "N/A",
            "0 hrs",
            f"{unplanned} event(s)" if unplanned else "0 hrs",
        ])
    _table(["Server", "Availability (7d)", "Planned Downtime", "Unplanned Events"],
           avail_rows, col_widths=[2.2, 1.6, 1.6, 1.8])

    # ══ 5. HARDWARE HEALTH ═══════════════════════════════════════════════════
    _heading("5. Hardware Health")
    hw_rows = []
    for ag in agents:
        hostname = ag.get("display_name") or ag["hostname"]
        parts = disk_partitions.get(ag["id"], [])
        if not parts:
            hw_rows.append([hostname, "–", "Healthy", "No disk data"])
        else:
            for i, p in enumerate(parts):
                label = hostname if i == 0 else ""
                pct = p["percent"]
                total = p["total_gb"]
                used = p["used_gb"]
                mount = p["mountpoint"]
                status = "⚠ Warning" if (pct and pct >= DISK_WARN) else "Healthy"
                if pct is not None and total is not None:
                    remark = f"{pct:.1f}% used ({used:.1f} GB / {total:.1f} GB)"
                    if pct >= DISK_WARN:
                        remark += " — approaching capacity"
                else:
                    remark = "No data"
                hw_rows.append([label, mount, status, remark])
    _table(["Server", "Partition", "Disk Status", "Details"], hw_rows, col_widths=[2.0, 1.2, 1.2, 3.0])

    # ══ 6. BACKUP STATUS ═════════════════════════════════════════════════════
    _heading("6. Backup Status")
    ut_rows = d.get("unitrends_backup_rows", [])
    if ut_rows:
        _para("Source: Kaseya Unitrends — jobs in last 7 days", size=9, italic=True, color=TEXT_GRAY)
        bk_rows = []
        for r in ut_rows:
            status = r["status"]
            # Prefix status icons
            if status == "Successful":
                status_str = "✅ Successful"
            elif status == "Failed":
                status_str = "❌ Failed"
            elif status == "Partial":
                status_str = f"⚠ Partial ({r['ok']}/{r['total']} OK)"
            elif status == "Warning":
                status_str = f"⚠ Warning ({r['warnings']})"
            else:
                status_str = status
            bk_rows.append([
                r["instance"],
                r["type"],
                status_str,
                str(r["total"]),
                str(r["failed"]) if r["failed"] else "0",
                r["last_success"],
            ])
        _table(["VM / Server", "Type", "Status", "Jobs", "Failed", "Last Success"],
               bk_rows, col_widths=[1.8, 1.0, 1.8, 0.6, 0.7, 1.5])
    elif d["backup_by_agent"]:
        bk_rows = []
        for ag in agents:
            bk = d["backup_by_agent"].get(ag.get("display_name") or ag["hostname"]) or \
                 d["backup_by_agent"].get(ag["hostname"])
            if bk:
                bk_rows.append([ag["hostname"], bk["status"], bk["last_backup"]])
            else:
                bk_rows.append([ag["hostname"], "Not monitored", "–"])
        _table(["Server", "Backup Status", "Last Successful Backup"],
               bk_rows, col_widths=[2.4, 1.8, 2.4])
    else:
        _para("No backup data available. Configure Kaseya Unitrends integration to populate this section.", italic=True)

    # ══ 7. ALERTS AND INCIDENTS ══════════════════════════════════════════════
    _heading("7. Alerts and Incidents")
    if d["alerts"]:
        al_rows = []
        _private_ip_re = _re.compile(
            r'\b(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)\b'
        )
        for al in d["alerts"][:15]:
            ts = al["triggered_at"]
            date_str = ts.strftime("%d/%m") if ts else "–"
            hostname = al.get("hostname") or ""
            if not hostname:
                # Try to resolve from message: match private IPs against known agents
                msg = al.get("message", "")
                for m in _private_ip_re.finditer(msg):
                    found = ip_to_hostname.get(m.group(0).lower())
                    if found:
                        hostname = found
                        break
            if not hostname:
                hostname = "–"
            status = "Resolved" if al.get("resolved_at") else "Open"
            al_rows.append([date_str, hostname, al.get("message", "")[:60], al["severity"].upper(), status])
        _table(["Date", "Server", "Alert / Incident", "Severity", "Status"],
               al_rows, col_widths=[0.7, 1.6, 3.0, 1.0, 0.9])
    else:
        _para("No alerts or incidents recorded during this reporting period.", italic=True)

    doc.add_paragraph()

    # ══ 8. PATCH MANAGEMENT ══════════════════════════════════════════════════
    _heading("8. Patch Management")

    # Compliance summary
    _heading("Patch Compliance Summary", level=2, color=MID_BLUE)
    comp = d["compliance"]
    comp_rows = [
        ["Overall",       f"{comp['overall']:.1f}%"],
        ["Patching",      f"{comp['patch']:.1f}%"],
        ["Vulnerability", f"{comp['vuln']:.1f}%"],
        ["Configuration", f"{comp['config']:.1f}%"],
        ["Protection",    f"{comp['protection']:.1f}%"],
        ["Licensing",     f"{comp['license']:.1f}%"],
    ]
    _table(["Category", "Score"], comp_rows, col_widths=[2.5, 1.2])

    # Patch summary counts
    _heading("Patch Summary", level=2, color=MID_BLUE)
    ps = d["patch_summary"]
    ps_rows = [
        ["Total Servers",    str(ps["total"])],
        ["Fully Patched",    str(ps["fully_patched"])],
        ["Pending Updates",  str(ps["pending_updates"])],
        ["Failed Updates",   str(ps["failed_updates"])],
        ["Pending Reboots",  str(ps["pending_reboot"])],
    ]
    _table(["Item", "Count"], ps_rows, col_widths=[2.5, 1.2])

    # Per-server patch status
    _heading("Per-Server Patch Status", level=2, color=MID_BLUE)
    patch_rows = []
    for ag in agents:
        pb = d["patch_by_agent"].get(ag["hostname"], {})
        sec = pb.get("security", 0)
        total = pb.get("total", 0)
        if sec == 0 and total == 0:
            patch_status = "Up-to-date"
            badge = "🟢"
        elif ag.get("restart_pending"):
            patch_status = "Pending Reboot"
            badge = "🟡"
        elif sec > 0:
            patch_status = f"{sec} security patch(es) pending"
            badge = "🟡"
        else:
            patch_status = f"{total} update(s) pending (non-security)"
            badge = "🟢"
        patch_rows.append([ag["hostname"], patch_status, badge])
    _table(["Server", "Patching Status", ""], patch_rows, col_widths=[2.4, 3.0, 0.5])

    # Recent patches installed
    if d["recent_patches"]:
        _heading("Recent Patches Installed (7 days)", level=2, color=MID_BLUE)
        rp_rows = []
        for rp in d["recent_patches"]:
            ts = rp.get("installed_at")
            raw_result = (rp.get("result") or "").lower()
            if raw_result in ("failed", "failure", "error"):
                status_str = "❌ Failed"
            elif raw_result in ("timeout", "timed out"):
                status_str = "⏱ Timeout"
            else:
                status_str = "✅ Installed"
            rp_rows.append([
                rp.get("hostname", "?"),
                rp.get("title") or rp.get("package_name") or "?",
                status_str,
                ts.strftime("%d/%m/%Y") if ts else "–",
            ])
        _table(["Server", "Update", "Status", "Date"],
               rp_rows, col_widths=[1.8, 3.0, 1.2, 1.2])

    # Remarks
    _heading("Remarks", level=2, color=MID_BLUE)
    remarks = []
    failed_patches = [rp for rp in d["recent_patches"]
                      if (rp.get("result") or "").lower() in ("failed", "failure", "error", "timeout", "timed out")]
    if ps["pending_updates"] == 0:
        remarks.append("All servers are fully patched — no outstanding security updates.")
    else:
        remarks.append(f"{ps['pending_updates']} server(s) have pending updates with maintenance windows to be scheduled.")
    if failed_patches:
        names = ", ".join({rp.get("hostname", "?") for rp in failed_patches})
        remarks.append(f"⚠ {len(failed_patches)} patch installation(s) failed or timed out on: {names}. Review and retry during next maintenance window.")
    else:
        remarks.append("No failed patch installations recorded.")
    if ps["pending_reboot"] > 0:
        remarks.append(f"{ps['pending_reboot']} server(s) are pending a reboot to complete patch installation.")
    for r in remarks:
        p = doc.add_paragraph(style='List Bullet')
        p.paragraph_format.space_before = Pt(2)
        p.paragraph_format.space_after = Pt(2)
        run = p.add_run(r)
        run.font.size = Pt(10)
        run.font.color.rgb = TEXT_GRAY

    doc.add_paragraph()

    # ══ 9. ENDPOINT SECURITY (SOPHOS CENTRAL) ═══════════════════════════════
    _heading("9. Endpoint Security (Sophos Central)")
    sophos_s = d.get("sophos_summary")
    if not sophos_s:
        _para("Sophos Central integration is not enabled. Enable it in the Integrations hub to populate this section.", italic=True)
    else:
        # Summary table
        _heading("Endpoint Health Summary", level=2, color=MID_BLUE)
        soph_sum_rows = [
            ["Total Endpoints",        str(sophos_s.get("total", 0))],
            ["Healthy",                str(sophos_s.get("healthy", 0))],
            ["Suspicious",             str(sophos_s.get("suspicious", 0))],
            ["Unhealthy (Bad)",        str(sophos_s.get("bad", 0))],
            ["Not Reporting (>7 days)",str(sophos_s.get("stale", 0))],
            ["End-of-Life OS",         str(sophos_s.get("eol", 0))],
        ]
        _table(["Metric", "Count"], soph_sum_rows, col_widths=[3.0, 1.0])

        # Alert categories
        sophos_cats = d.get("sophos_alerts_by_cat", [])
        if sophos_cats:
            _heading("Security Events This Week (by Category)", level=2, color=MID_BLUE)
            cat_rows = [[c["category"].replace("runtimeDetections","Runtime Detections").capitalize(),
                         str(c["count"])] for c in sophos_cats]
            _table(["Category", "Events"], cat_rows, col_widths=[3.0, 1.0])

        # Unhealthy endpoints
        sophos_uh = d.get("sophos_unhealthy", [])
        if sophos_uh:
            _heading("Endpoints Requiring Attention", level=2, color=MID_BLUE)
            uh_rows = []
            for ep in sophos_uh:
                ls = ep["last_seen"]
                ls_str = ls.strftime("%d/%m/%Y") if ls else "Never"
                uh_rows.append([
                    ep["hostname"],
                    ep["health_status"].capitalize(),
                    ep.get("os_name", "") or "—",
                    ep.get("ip_address", "") or "—",
                    ls_str,
                ])
            _table(["Hostname", "Health", "OS", "IP", "Last Seen"],
                   uh_rows, col_widths=[1.8, 1.0, 2.0, 1.4, 1.2])

        # End-of-life endpoints
        sophos_eol = d.get("sophos_eol", [])
        if sophos_eol:
            _heading("End-of-Life Operating Systems", level=2, color=MID_BLUE)
            _para("The following endpoints are running operating systems that no longer receive security updates from Microsoft.",
                  size=9, italic=True, color=TEXT_GRAY)
            eol_rows = []
            for ep in sophos_eol:
                ls = ep["last_seen"]
                ls_str = ls.strftime("%d/%m/%Y") if ls else "Never"
                eol_rows.append([ep["hostname"], ep.get("os_name", ""), ep["health_status"].capitalize(), ls_str])
            _table(["Hostname", "Operating System", "Health", "Last Seen"],
                   eol_rows, col_widths=[1.8, 2.4, 1.0, 1.2])

        # Not-reporting endpoints (cap at 15)
        sophos_stale = d.get("sophos_stale", [])
        if sophos_stale:
            _heading("Endpoints Not Reporting (>7 Days)", level=2, color=MID_BLUE)
            stale_rows = []
            for ep in sophos_stale[:15]:
                ls = ep["last_seen"]
                ls_str = ls.strftime("%d/%m/%Y") if ls else "Never"
                stale_rows.append([ep["hostname"], ep.get("os_name", "") or "—", ls_str])
            _table(["Hostname", "OS", "Last Seen"], stale_rows, col_widths=[2.2, 2.4, 1.8])
            if len(sophos_stale) > 15:
                _para(f"…and {len(sophos_stale) - 15} more. See Sophos Central dashboard for full list.", size=9, italic=True)

        # License status
        sophos_lics = d.get("sophos_licenses", [])
        if sophos_lics:
            _heading("License Status", level=2, color=MID_BLUE)
            lic_rows = []
            for lic in sophos_lics:
                exp_dt = lic["expires_at"]
                exp_str = exp_dt.strftime("%d/%m/%Y") if exp_dt else "Perpetual"
                days = lic["days_remaining"]
                status = lic["expiry_status"]
                if status == "expired":
                    status_str = "EXPIRED"
                elif status == "expiring_soon":
                    status_str = f"Expiring ({days}d)"
                elif status == "perpetual":
                    status_str = "Perpetual"
                else:
                    status_str = f"Active ({days}d)" if days is not None else "Active"
                seats = f"{lic['used_quantity']} / {lic['quantity']}" if lic["quantity"] else "—"
                lic_rows.append([
                    lic["product_name"] or "—",
                    (lic["license_type"] or "—").capitalize(),
                    seats,
                    exp_str,
                    status_str,
                ])
            tbl = _table(
                ["Product", "Type", "Seats Used / Total", "Expiry Date", "Status"],
                lic_rows,
                col_widths=[2.4, 1.0, 1.4, 1.2, 1.4],
            )
            # Colour expired/expiring rows red/amber
            if tbl is not None:
                try:
                    from docx.shared import RGBColor as _RGB
                    from docx.oxml.ns import qn as _qn
                    from docx.oxml import OxmlElement as _OE
                    RED   = _RGB(0xC0, 0x39, 0x2B)
                    AMBER = _RGB(0xD3, 0x7F, 0x00)
                    for i, lic in enumerate(sophos_lics):
                        row_idx = i + 1   # skip header row
                        if row_idx >= len(tbl.rows):
                            break
                        status = lic["expiry_status"]
                        if status not in ("expired", "expiring_soon"):
                            continue
                        color = RED if status == "expired" else AMBER
                        tbl_row = tbl.rows[row_idx]
                        # Colour only the Status cell (last column)
                        cell = tbl_row.cells[-1]
                        for para in cell.paragraphs:
                            for run in para.runs:
                                run.font.color.rgb = color
                                run.font.bold = True
                except Exception:
                    pass  # colour is cosmetic — never block the report
        elif sophos_s:
            _para("No license records found. Add licenses manually in the Sophos Central integration page.", italic=True, size=9)

    doc.add_paragraph()

    # ══ 10. RISKS AND RECOMMENDATIONS ════════════════════════════════════════
    _heading("10. Risks and Recommendations")
    risk_rows = []
    for risk in d["risks"]:
        risk_rows.append([risk["risk"], risk["impact"], risk["recommendation"]])
    _table(["Risk", "Impact", "Recommendation"], risk_rows, col_widths=[2.2, 2.0, 3.0])

    # ══ 11. OVERALL ASSESSMENT ══════════════════════════════════════════════
    _heading("11. Overall Assessment")
    if s["critical"] == 0 and s["warning"] <= 1:
        assessment = (
            "The server environment remains stable with no critical service interruptions during the "
            "reporting period. "
        )
        if s["warning"] == 1:
            assessment += "One server requires monitoring attention but poses no immediate operational risk. "
        assessment += "No immediate operational risks threaten service availability."
    else:
        assessment = (
            f"The server environment recorded {s['critical']} critical event(s) and {s['warning']} warning(s) "
            f"during the reporting period. Immediate attention is recommended for affected systems."
        )
    _para(assessment, size=10, color=TEXT_GRAY)

    footer_para = doc.add_paragraph()
    footer_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    footer_para.paragraph_format.space_before = Pt(20)
    run = footer_para.add_run(
        f"KNC IT Operations  |  Confidential  |  Generated {d['generated_at'].strftime('%d %B %Y')}"
    )
    run.font.size = Pt(8)
    run.font.color.rgb = TEXT_GRAY
    run.italic = True

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


# ── Email sender ─────────────────────────────────────────────────────────────

def send_report_email(docx_bytes: bytes, filename: str, recipients: list, subject: str, smtp_cfg: dict):
    from_address = smtp_cfg.get("from_address", "kifaa@localhost")
    msg = MIMEMultipart()
    msg["Subject"] = subject
    msg["From"] = f"Kifaa IT Operations <{from_address}>"
    msg["To"] = ", ".join(recipients)

    body = (
        f"Please find attached the weekly KNC Server Health Status Report.\n\n"
        f"This report covers the period ending {datetime.date.today().strftime('%d %B %Y')}.\n\n"
        f"Report generated automatically by the Kifaa monitoring platform.\n"
    )
    msg.attach(MIMEText(body, "plain"))

    part = MIMEBase("application", "vnd.openxmlformats-officedocument.wordprocessingml.document")
    part.set_payload(docx_bytes)
    encoders.encode_base64(part)
    part.add_header("Content-Disposition", f'attachment; filename="{filename}"')
    msg.attach(part)

    smtp_host = smtp_cfg.get("host", "localhost")
    smtp_port = int(smtp_cfg.get("port", 587))
    use_tls = smtp_cfg.get("use_tls", True)
    with smtplib.SMTP(smtp_host, smtp_port, timeout=30) as server:
        server.ehlo()
        if use_tls:
            server.starttls()
            server.ehlo()
        if smtp_cfg.get("username"):
            server.login(smtp_cfg["username"], smtp_cfg.get("password", ""))
        server.sendmail(from_address, recipients, msg.as_string())
