"""
Threats router — security misconfigurations, open ports, high-risk software,
and threat exceptions.  The agent POSTs a security report on every inventory
cycle; the server evaluates it against misconfig_rules and records findings.
"""
import re
import json
import uuid as _uuid
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Header
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.database import get_db
from api.services.auth import get_current_user, get_agent_by_api_key

router = APIRouter(prefix="/threats", tags=["Threats"])

# ── DB table bootstrap ────────────────────────────────────────────────────────

_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS agent_webconfig_findings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    server_type TEXT NOT NULL,
    config_file TEXT,
    finding_id TEXT NOT NULL,
    severity TEXT DEFAULT 'medium',
    title TEXT NOT NULL,
    detail TEXT,
    remediation TEXT,
    detected_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webconfig_agent ON agent_webconfig_findings(agent_id);

CREATE TABLE IF NOT EXISTS misconfig_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rule_id TEXT UNIQUE NOT NULL,
    category TEXT NOT NULL,
    platform TEXT DEFAULT 'all',
    title TEXT NOT NULL,
    description TEXT,
    severity TEXT DEFAULT 'medium',
    check_field TEXT NOT NULL,
    expected_value TEXT NOT NULL,
    remediation TEXT,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS agent_misconfigs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    rule_id TEXT NOT NULL,
    status TEXT DEFAULT 'fail',
    actual_value TEXT,
    detected_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    exception_id UUID
);

CREATE INDEX IF NOT EXISTS idx_agent_misconfigs_agent ON agent_misconfigs(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_misconfigs_rule ON agent_misconfigs(rule_id);

CREATE TABLE IF NOT EXISTS agent_open_ports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    port INT NOT NULL,
    protocol TEXT DEFAULT 'tcp',
    process_name TEXT,
    process_pid INT,
    bind_address TEXT,
    state TEXT,
    first_seen TIMESTAMPTZ DEFAULT NOW(),
    last_seen TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_ports_agent ON agent_open_ports(agent_id);

CREATE TABLE IF NOT EXISTS high_risk_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    match_type TEXT NOT NULL,
    match_pattern TEXT NOT NULL,
    severity TEXT DEFAULT 'high',
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS agent_high_risk_software (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    rule_id UUID NOT NULL REFERENCES high_risk_rules(id) ON DELETE CASCADE,
    software_name TEXT NOT NULL,
    software_version TEXT,
    match_type TEXT NOT NULL,
    severity TEXT DEFAULT 'high',
    detected_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_high_risk_agent ON agent_high_risk_software(agent_id);

CREATE TABLE IF NOT EXISTS threat_exceptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    exception_type TEXT NOT NULL,
    match_value TEXT NOT NULL,
    agent_id UUID,
    reason TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT TRUE
);
"""

# ── Seed data ─────────────────────────────────────────────────────────────────

_MISCONFIG_RULES = [
    # Firewall
    {"rule_id": "FIREWALL_DISABLED", "category": "network", "platform": "all", "title": "Firewall is disabled",
     "severity": "critical", "check_field": "firewall_enabled", "expected_value": "true",
     "remediation": "Enable the system firewall. On Windows: netsh advfirewall set allprofiles state on. On Linux: ufw enable or systemctl start firewalld."},
    # Windows-specific
    {"rule_id": "RDP_ENABLED", "category": "network", "platform": "windows", "title": "Remote Desktop (RDP) is enabled",
     "severity": "high", "check_field": "rdp_enabled", "expected_value": "false",
     "remediation": "Disable RDP if not required: System Properties → Remote → uncheck 'Allow Remote Assistance'. Or via registry: set fDenyTSConnections=1."},
    {"rule_id": "GUEST_ACCOUNT_ACTIVE", "category": "access", "platform": "windows", "title": "Guest account is enabled",
     "severity": "high", "check_field": "guest_account_enabled", "expected_value": "false",
     "remediation": "Disable the Guest account: net user Guest /active:no"},
    {"rule_id": "SMB1_ENABLED", "category": "network", "platform": "windows", "title": "SMBv1 protocol is enabled",
     "severity": "critical", "check_field": "smb1_enabled", "expected_value": "false",
     "remediation": "Disable SMBv1: Set-SmbServerConfiguration -EnableSMB1Protocol $false (PowerShell) or via registry: LanmanServer\\Parameters\\SMB1=0"},
    {"rule_id": "NO_AUDIT_POLICY", "category": "os", "platform": "windows", "title": "Audit policy is not configured",
     "severity": "medium", "check_field": "audit_policy_enabled", "expected_value": "true",
     "remediation": "Configure audit policy via Local Security Policy or: auditpol /set /category:'Logon/Logoff' /success:enable /failure:enable"},
    {"rule_id": "AUTO_UPDATES_OFF", "category": "os", "platform": "all", "title": "Automatic updates are disabled",
     "severity": "high", "check_field": "auto_updates_enabled", "expected_value": "true",
     "remediation": "Enable automatic updates. Windows: Settings → Windows Update → Automatic. Linux: install and enable unattended-upgrades or dnf-automatic."},
    {"rule_id": "NO_DISK_ENCRYPTION", "category": "encryption", "platform": "all", "title": "Disk encryption is not enabled",
     "severity": "medium", "check_field": "disk_encrypted", "expected_value": "true",
     "remediation": "Enable disk encryption. Windows: Enable BitLocker on C: drive. Linux: Use LUKS encryption."},
    {"rule_id": "NO_AV_INSTALLED", "category": "antivirus", "platform": "windows", "title": "No antivirus software detected",
     "severity": "critical", "check_field": "av_installed", "expected_value": "true",
     "remediation": "Install and configure antivirus/endpoint protection software."},
    {"rule_id": "AV_NOT_RUNNING", "category": "antivirus", "platform": "windows", "title": "Antivirus real-time protection is off",
     "severity": "critical", "check_field": "av_running", "expected_value": "true",
     "remediation": "Enable real-time protection in your antivirus product."},
    # Linux-specific
    {"rule_id": "SSH_ROOT_LOGIN", "category": "access", "platform": "linux", "title": "SSH root login is permitted",
     "severity": "high", "check_field": "ssh_root_login", "expected_value": "false",
     "remediation": "Set PermitRootLogin no in /etc/ssh/sshd_config, then: systemctl restart sshd"},
    {"rule_id": "SSH_PASSWORD_AUTH", "category": "access", "platform": "linux", "title": "SSH password authentication is enabled",
     "severity": "medium", "check_field": "ssh_password_auth", "expected_value": "false",
     "remediation": "Set PasswordAuthentication no in /etc/ssh/sshd_config. Ensure key-based auth is set up first."},
    {"rule_id": "SELINUX_DISABLED", "category": "os", "platform": "linux", "title": "SELinux/AppArmor is not enabled",
     "severity": "medium", "check_field": "selinux_enabled", "expected_value": "true",
     "remediation": "Enable SELinux (RHEL/CentOS): set SELINUX=enforcing in /etc/selinux/config. Or enable AppArmor (Ubuntu/Debian)."},
    {"rule_id": "WEAK_PASSWORD_POLICY", "category": "access", "platform": "windows", "title": "Weak password policy (min length < 8)",
     "severity": "high", "check_field": "password_min_length", "expected_value": ">= 8",
     "remediation": "Set minimum password length to 8+ characters via Local Security Policy → Account Policies → Password Policy."},
    {"rule_id": "NO_PASSWORD_COMPLEXITY", "category": "access", "platform": "windows", "title": "Password complexity requirements disabled",
     "severity": "medium", "check_field": "password_complexity", "expected_value": "true",
     "remediation": "Enable password complexity requirements via Local Security Policy → Account Policies → Password Policy → Password must meet complexity requirements."},
]

_HIGH_RISK_RULES = [
    # EOL operating systems — matched against agent os_name
    {"match_type": "eol", "match_pattern": r"(?i)windows\s*(xp|me|vista|2000)", "severity": "critical",
     "description": "End-of-life Windows version (no security patches available)"},
    {"match_type": "eol", "match_pattern": r"(?i)windows\s*7\b", "severity": "critical",
     "description": "Windows 7 - End of Life (Jan 2020). No longer receives security updates."},
    {"match_type": "eol", "match_pattern": r"(?i)windows server\s*(2003|2008)\b(?! R2)", "severity": "critical",
     "description": "End-of-life Windows Server version"},
    # EOL software
    {"match_type": "eol", "match_pattern": r"(?i)^python\s+2\.", "severity": "high",
     "description": "Python 2.x - End of Life (Jan 2020)"},
    {"match_type": "eol", "match_pattern": r"(?i)^(java|jdk|jre)\s+[67]\b", "severity": "high",
     "description": "End-of-life Java version (Java 6/7)"},
    {"match_type": "eol", "match_pattern": r"(?i)adobe\s+flash", "severity": "critical",
     "description": "Adobe Flash Player - End of Life (Dec 2020). Known vulnerability vector."},
    {"match_type": "eol", "match_pattern": r"(?i)^php\s+[5-7]\.", "severity": "high",
     "description": "End-of-life PHP version (PHP 5.x/7.x). Upgrade to PHP 8.x."},
    {"match_type": "eol", "match_pattern": r"(?i)^internet\s+explorer", "severity": "high",
     "description": "Internet Explorer - End of Life (Jun 2022). Use Edge or Chrome."},
    {"match_type": "eol", "match_pattern": r"(?i)^silverlight", "severity": "medium",
     "description": "Microsoft Silverlight - End of Life (2021)"},
    # P2P clients
    {"match_type": "p2p", "match_pattern": r"(?i)^utorrent|^bittorrent\b", "severity": "high",
     "description": "P2P torrent client — potential for unauthorized file sharing and malware distribution"},
    {"match_type": "p2p", "match_pattern": r"(?i)^qbittorrent", "severity": "high",
     "description": "P2P torrent client"},
    {"match_type": "p2p", "match_pattern": r"(?i)^(vuze|azureus|emule|limewire|frostwire|ares\s+galaxy)", "severity": "high",
     "description": "P2P file sharing client — policy violation risk"},
    # Remote access / remote desktop
    {"match_type": "remote_desktop", "match_pattern": r"(?i)^teamviewer", "severity": "medium",
     "description": "TeamViewer remote access tool — verify authorization"},
    {"match_type": "remote_desktop", "match_pattern": r"(?i)^anydesk", "severity": "medium",
     "description": "AnyDesk remote access tool — verify authorization"},
    {"match_type": "remote_desktop", "match_pattern": r"(?i)^(ammyy\s+admin|screenconnect|splashtop|logmein)", "severity": "medium",
     "description": "Remote desktop sharing tool — verify authorization"},
    # Security/hacking tools on non-IT servers
    {"match_type": "unauthorized", "match_pattern": r"(?i)^wireshark", "severity": "high",
     "description": "Wireshark network analyzer — may indicate unauthorized packet capture"},
    {"match_type": "unauthorized", "match_pattern": r"(?i)^nmap", "severity": "high",
     "description": "Nmap network scanner — unauthorized use is a compliance risk"},
    {"match_type": "unauthorized", "match_pattern": r"(?i)^(metasploit|armitage|cobalt\s+strike)", "severity": "critical",
     "description": "Penetration testing/exploitation framework — requires authorization"},
]


async def _ensure_tables(db: AsyncSession):
    """Create threat tables if they don't exist and seed default rules."""
    # asyncpg requires each DDL statement to be executed separately
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS agent_webconfig_findings (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            server_type TEXT NOT NULL, config_file TEXT, finding_id TEXT NOT NULL,
            severity TEXT DEFAULT 'medium', title TEXT NOT NULL, detail TEXT,
            remediation TEXT, detected_at TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("CREATE INDEX IF NOT EXISTS idx_webconfig_agent ON agent_webconfig_findings(agent_id)"))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS misconfig_rules (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            rule_id TEXT UNIQUE NOT NULL, category TEXT NOT NULL,
            platform TEXT DEFAULT 'all', title TEXT NOT NULL, description TEXT,
            severity TEXT DEFAULT 'medium', check_field TEXT NOT NULL,
            expected_value TEXT NOT NULL, remediation TEXT, is_active BOOLEAN DEFAULT TRUE
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS agent_misconfigs (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            rule_id TEXT NOT NULL, status TEXT DEFAULT 'fail', actual_value TEXT,
            detected_at TIMESTAMPTZ DEFAULT NOW(), resolved_at TIMESTAMPTZ, exception_id UUID
        )
    """))
    # Patch stub tables missing columns
    for col, defn in [
        ("actual_value", "TEXT"),
        ("detected_at", "TIMESTAMPTZ DEFAULT NOW()"),
        ("resolved_at", "TIMESTAMPTZ"),
        ("exception_id", "UUID"),
    ]:
        try:
            await db.execute(text(f"ALTER TABLE agent_misconfigs ADD COLUMN IF NOT EXISTS {col} {defn}"))
        except Exception:
            await db.rollback()
    await db.execute(text("CREATE INDEX IF NOT EXISTS idx_agent_misconfigs_agent ON agent_misconfigs(agent_id)"))
    await db.execute(text("CREATE INDEX IF NOT EXISTS idx_agent_misconfigs_rule ON agent_misconfigs(rule_id)"))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS agent_open_ports (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            port INT NOT NULL, protocol TEXT DEFAULT 'tcp', process_name TEXT,
            process_pid INT, bind_address TEXT, state TEXT,
            first_seen TIMESTAMPTZ DEFAULT NOW(), last_seen TIMESTAMPTZ DEFAULT NOW()
        )
    """))
    await db.execute(text("CREATE INDEX IF NOT EXISTS idx_agent_ports_agent ON agent_open_ports(agent_id)"))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS high_risk_rules (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            match_type TEXT NOT NULL, match_pattern TEXT NOT NULL,
            severity TEXT DEFAULT 'high', description TEXT, is_active BOOLEAN DEFAULT TRUE
        )
    """))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS agent_high_risk_software (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            rule_id UUID NOT NULL REFERENCES high_risk_rules(id) ON DELETE CASCADE,
            software_name TEXT NOT NULL, software_version TEXT,
            match_type TEXT NOT NULL, severity TEXT DEFAULT 'high',
            detected_at TIMESTAMPTZ DEFAULT NOW(), resolved_at TIMESTAMPTZ
        )
    """))
    await db.execute(text("CREATE INDEX IF NOT EXISTS idx_agent_high_risk_agent ON agent_high_risk_software(agent_id)"))
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS threat_exceptions (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            exception_type TEXT NOT NULL, match_value TEXT NOT NULL, agent_id UUID,
            reason TEXT, created_by UUID REFERENCES users(id),
            created_at TIMESTAMPTZ DEFAULT NOW(), expires_at TIMESTAMPTZ,
            is_active BOOLEAN DEFAULT TRUE
        )
    """))

    # Seed misconfig rules (upsert)
    for rule in _MISCONFIG_RULES:
        await db.execute(text("""
            INSERT INTO misconfig_rules (rule_id, category, platform, title, severity, check_field, expected_value, remediation)
            VALUES (:rule_id, :category, :platform, :title, :severity, :check_field, :expected_value, :remediation)
            ON CONFLICT (rule_id) DO NOTHING
        """), rule)

    # Seed high-risk rules (only if table empty)
    count = await db.execute(text("SELECT COUNT(*) FROM high_risk_rules"))
    if count.scalar() == 0:
        for rule in _HIGH_RISK_RULES:
            await db.execute(text("""
                INSERT INTO high_risk_rules (match_type, match_pattern, severity, description)
                VALUES (:match_type, :match_pattern, :severity, :description)
            """), rule)

    await db.commit()


# ── Misconfig evaluation ───────────────────────────────────────────────────────

def _check_field(security: dict, field: str, expected: str) -> tuple[bool, str]:
    """
    Evaluate a single rule against the security state dict.
    Returns (passes, actual_value_str).
    """
    val = security.get(field)
    actual = str(val).lower() if val is not None else "null"

    if expected == "true":
        passes = str(val).lower() in ("true", "1", "yes")
    elif expected == "false":
        passes = str(val).lower() in ("false", "0", "no")
    elif expected.startswith(">= "):
        try:
            threshold = int(expected[3:])
            passes = int(val or 0) >= threshold
        except (ValueError, TypeError):
            passes = False
    elif expected.startswith("> "):
        try:
            threshold = int(expected[2:])
            passes = int(val or 0) > threshold
        except (ValueError, TypeError):
            passes = False
    else:
        passes = str(val).lower() == expected.lower()

    return passes, actual


async def _evaluate_misconfigs(db: AsyncSession, agent_id: str, os_type: str, security: dict):
    """
    Run all active misconfig rules against the security state and upsert results.
    """
    platform = "linux" if (os_type or "").lower() in ("linux",) else "windows"

    rules_result = await db.execute(text("""
        SELECT rule_id, platform, check_field, expected_value
        FROM misconfig_rules
        WHERE is_active = TRUE
          AND (platform = 'all' OR platform = :platform)
    """), {"platform": platform})
    rules = rules_result.fetchall()

    for rule_id, rule_platform, check_field, expected_value in rules:
        # Skip AV rules on Linux — absence of AV is not a finding on Linux
        # (Linux agents report av_installed=False when no AV found, which is expected)
        if platform == "linux" and rule_id in ("NO_AV_INSTALLED", "AV_NOT_RUNNING"):
            continue
        # Skip AV_NOT_RUNNING if no AV installed (Windows with no AV — already caught by NO_AV_INSTALLED)
        if rule_id == "AV_NOT_RUNNING" and not security.get("av_installed"):
            continue

        passes, actual_value = _check_field(security, check_field, expected_value)
        status = "pass" if passes else "fail"

        # Check for active exception
        exc_result = await db.execute(text("""
            SELECT id FROM threat_exceptions
            WHERE exception_type = 'misconfig'
              AND match_value = :rule_id
              AND is_active = TRUE
              AND (agent_id IS NULL OR agent_id = CAST(:agent_id AS uuid))
              AND (expires_at IS NULL OR expires_at > NOW())
            LIMIT 1
        """), {"rule_id": rule_id, "agent_id": agent_id})
        exc_row = exc_result.fetchone()
        if exc_row:
            status = "excepted"

        # Upsert: one row per (agent_id, rule_id) — update on change
        existing = await db.execute(text("""
            SELECT id, status FROM agent_misconfigs
            WHERE agent_id = CAST(:agent_id AS uuid) AND rule_id = :rule_id
        """), {"agent_id": agent_id, "rule_id": rule_id})
        existing_row = existing.fetchone()

        if existing_row:
            row_id, prev_status = existing_row
            if status == "pass" and prev_status != "pass":
                await db.execute(text("""
                    UPDATE agent_misconfigs
                    SET status = :status, actual_value = :actual, resolved_at = NOW()
                    WHERE id = CAST(:id AS uuid)
                """), {"status": status, "actual": actual_value, "id": str(row_id)})
            else:
                await db.execute(text("""
                    UPDATE agent_misconfigs
                    SET status = :status, actual_value = :actual
                    WHERE id = CAST(:id AS uuid)
                """), {"status": status, "actual": actual_value, "id": str(row_id)})
        else:
            await db.execute(text("""
                INSERT INTO agent_misconfigs (agent_id, rule_id, status, actual_value)
                VALUES (CAST(:agent_id AS uuid), :rule_id, :status, :actual)
            """), {"agent_id": agent_id, "rule_id": rule_id, "status": status, "actual": actual_value})


async def _evaluate_high_risk_software(db: AsyncSession, agent_id: str):
    """
    Match the agent's software inventory against high_risk_rules using regex.
    Called after inventory is uploaded (via software router), also triggered on security report.
    """
    # Get current software inventory for agent
    sw_result = await db.execute(text("""
        SELECT name, version FROM software_inventory
        WHERE agent_id = CAST(:agent_id AS uuid)
    """), {"agent_id": agent_id})
    software_list = sw_result.fetchall()

    if not software_list:
        return

    # Get active high-risk rules
    rules_result = await db.execute(text("""
        SELECT id, match_type, match_pattern, severity FROM high_risk_rules WHERE is_active = TRUE
    """))
    rules = rules_result.fetchall()

    # Clear existing findings, rebuild fresh
    await db.execute(text("""
        DELETE FROM agent_high_risk_software WHERE agent_id = CAST(:agent_id AS uuid)
    """), {"agent_id": agent_id})

    for sw_name, sw_version in software_list:
        for rule_id, match_type, pattern, severity in rules:
            try:
                if re.search(pattern, sw_name or ""):
                    # Check for exception
                    exc_result = await db.execute(text("""
                        SELECT id FROM threat_exceptions
                        WHERE exception_type = 'software'
                          AND match_value ILIKE :name
                          AND is_active = TRUE
                          AND (agent_id IS NULL OR agent_id = CAST(:agent_id AS uuid))
                          AND (expires_at IS NULL OR expires_at > NOW())
                        LIMIT 1
                    """), {"name": sw_name, "agent_id": agent_id})
                    if exc_result.fetchone():
                        continue

                    await db.execute(text("""
                        INSERT INTO agent_high_risk_software
                            (agent_id, rule_id, software_name, software_version, match_type, severity)
                        VALUES (CAST(:agent_id AS uuid), CAST(:rule_id AS uuid), :name, :version, :match_type, :severity)
                    """), {
                        "agent_id": agent_id, "rule_id": str(rule_id),
                        "name": sw_name, "version": sw_version or "",
                        "match_type": match_type, "severity": severity,
                    })
            except re.error:
                pass


async def _upsert_open_ports(db: AsyncSession, agent_id: str, ports: list):
    """Replace open ports for an agent (mark previous, insert current)."""
    # Remove old entries for this agent
    await db.execute(text("""
        DELETE FROM agent_open_ports WHERE agent_id = CAST(:agent_id AS uuid)
    """), {"agent_id": agent_id})

    for port in ports:
        await db.execute(text("""
            INSERT INTO agent_open_ports
                (agent_id, port, protocol, process_name, process_pid, bind_address, state)
            VALUES (CAST(:agent_id AS uuid), :port, :proto, :name, :pid, :bind, :state)
        """), {
            "agent_id": agent_id,
            "port": port.get("port", 0),
            "proto": port.get("protocol", "tcp"),
            "name": port.get("process_name") or "",
            "pid": port.get("pid") or None,
            "bind": port.get("bind_address") or "",
            "state": port.get("state") or "",
        })


# ── Agent endpoint ─────────────────────────────────────────────────────────────

@router.post("/security-report")
async def receive_security_report(
    body: dict,
    x_api_key: str = Header(..., alias="X-API-Key"),
    db: AsyncSession = Depends(get_db),
):
    """Receive security state + open ports from an agent."""
    from api.services.auth import get_agent_by_api_key
    agent = await get_agent_by_api_key(db, x_api_key)
    if not agent:
        raise HTTPException(status_code=401, detail="Not authenticated")

    await _ensure_tables(db)

    security = body.get("security", {})
    ports = body.get("open_ports", [])

    os_type = (agent.os_type or "").lower()

    await _evaluate_misconfigs(db, str(agent.id), os_type, security)
    await _upsert_open_ports(db, str(agent.id), ports)
    await _evaluate_high_risk_software(db, str(agent.id))
    await _upsert_security_state(db, str(agent.id), security)

    await db.commit()
    return {"status": "ok"}


async def _upsert_security_state(db: AsyncSession, agent_id: str, security: dict):
    """Persist raw security state fields for AV dashboard queries."""
    try:
        await db.execute(text("""
            INSERT INTO agent_security_state
                (agent_id, av_installed, av_product, av_running, av_last_scan,
                 firewall_enabled, firewall_product, disk_encrypted, encryption_method,
                 auto_updates_enabled, updated_at)
            VALUES
                (:aid, :av_installed, :av_product, :av_running, :av_last_scan,
                 :fw_enabled, :fw_product, :disk_enc, :enc_method,
                 :auto_upd, NOW())
            ON CONFLICT (agent_id) DO UPDATE SET
                av_installed        = EXCLUDED.av_installed,
                av_product          = EXCLUDED.av_product,
                av_running          = EXCLUDED.av_running,
                av_last_scan        = EXCLUDED.av_last_scan,
                firewall_enabled    = EXCLUDED.firewall_enabled,
                firewall_product    = EXCLUDED.firewall_product,
                disk_encrypted      = EXCLUDED.disk_encrypted,
                encryption_method   = EXCLUDED.encryption_method,
                auto_updates_enabled = EXCLUDED.auto_updates_enabled,
                updated_at          = NOW()
        """), {
            "aid":        agent_id,
            "av_installed": bool(security.get("av_installed", False)),
            "av_product":   security.get("av_product") or None,
            "av_running":   bool(security.get("av_running", False)),
            "av_last_scan": security.get("av_last_scan") or None,
            "fw_enabled":   bool(security.get("firewall_enabled", False)),
            "fw_product":   security.get("firewall_product") or None,
            "disk_enc":     bool(security.get("disk_encrypted", False)),
            "enc_method":   security.get("encryption_method") or None,
            "auto_upd":     bool(security.get("auto_updates_enabled", False)),
        })
    except Exception:
        pass  # non-critical — misconfig evaluation already happened


# ── Dashboard summary ──────────────────────────────────────────────────────────

@router.get("/dashboard")
async def threats_dashboard(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Summary stats for all threat categories."""
    await _ensure_tables(db)

    # Misconfig stats (exclude agents marked exclude_from_reports)
    mc_result = await db.execute(text("""
        SELECT
            COUNT(*) FILTER (WHERE status = 'fail') AS total_fail,
            COUNT(*) FILTER (WHERE status = 'fail' AND r.severity = 'critical') AS critical_fail,
            COUNT(*) FILTER (WHERE status = 'fail' AND r.severity = 'high') AS high_fail,
            COUNT(*) FILTER (WHERE status = 'pass') AS total_pass
        FROM agent_misconfigs m
        JOIN misconfig_rules r ON r.rule_id = m.rule_id
        JOIN agents a ON a.id = m.agent_id AND a.exclude_from_reports = FALSE
    """))
    mc = mc_result.fetchone()

    # High-risk software stats
    hr_result = await db.execute(text("""
        SELECT h.match_type, COUNT(*) AS cnt
        FROM agent_high_risk_software h
        JOIN agents a ON a.id = h.agent_id AND a.exclude_from_reports = FALSE
        GROUP BY h.match_type
    """))
    hr_rows = hr_result.fetchall()
    hr_by_type = {row[0]: row[1] for row in hr_rows}

    # Port stats
    port_result = await db.execute(text("""
        SELECT COUNT(*) FROM agent_open_ports p
        JOIN agents a ON a.id = p.agent_id AND a.exclude_from_reports = FALSE
    """))
    total_ports = port_result.scalar() or 0

    # Dangerous ports (bound to 0.0.0.0)
    danger_result = await db.execute(text("""
        SELECT COUNT(*) FROM agent_open_ports p
        JOIN agents a ON a.id = p.agent_id AND a.exclude_from_reports = FALSE
        WHERE p.bind_address IN ('0.0.0.0', '::')
          AND p.port IN (21, 23, 445, 3389, 1433, 3306, 5432, 4444, 5900, 6379)
    """))
    dangerous_ports = danger_result.scalar() or 0

    # CVE stats (graceful fallback if table doesn't exist yet)
    vuln_critical = 0
    vuln_high = 0
    vuln_zero_day = 0
    try:
        vuln_result = await db.execute(text("""
            SELECT
                COUNT(*) FILTER (WHERE v.severity = 'critical') AS critical,
                COUNT(*) FILTER (WHERE v.severity = 'high') AS high,
                COUNT(*) FILTER (WHERE c.is_zero_day = TRUE) AS zero_day
            FROM agent_vulnerabilities v
            JOIN agents a ON a.id = v.agent_id AND a.exclude_from_reports = FALSE
            LEFT JOIN cve_database c ON c.cve_id = v.cve_id
            WHERE v.status = 'open'
        """))
        vr = vuln_result.fetchone()
        vuln_critical = vr[0] or 0
        vuln_high = vr[1] or 0
        vuln_zero_day = vr[2] or 0
    except Exception:
        pass

    return {
        "misconfigs": {
            "total_fail": mc[0] or 0,
            "critical_fail": mc[1] or 0,
            "high_fail": mc[2] or 0,
            "total_pass": mc[3] or 0,
        },
        "high_risk_software": {
            "eol": hr_by_type.get("eol", 0),
            "p2p": hr_by_type.get("p2p", 0),
            "remote_desktop": hr_by_type.get("remote_desktop", 0),
            "unauthorized": hr_by_type.get("unauthorized", 0),
            "total": sum(hr_by_type.values()),
        },
        "ports": {
            "total": total_ports,
            "dangerous": dangerous_ports,
        },
        "vulnerabilities": {
            "critical": vuln_critical,
            "high": vuln_high,
            "zero_day": vuln_zero_day,
        },
    }


# ── Misconfig endpoints ────────────────────────────────────────────────────────

@router.get("/misconfigs")
async def list_misconfigs(
    agent_id: Optional[str] = None,
    severity: Optional[str] = None,
    status: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    await _ensure_tables(db)

    where = ["1=1"]
    params = {}
    if agent_id:
        where.append("m.agent_id = CAST(:agent_id AS uuid)")
        params["agent_id"] = agent_id
    if severity:
        where.append("r.severity = :severity")
        params["severity"] = severity
    if status:
        where.append("m.status = :status")
        params["status"] = status
    else:
        where.append("m.status != 'pass'")  # default: show only failures

    result = await db.execute(text(f"""
        SELECT
            m.id, m.agent_id, a.hostname, a.display_name, a.ip_address, a.os_type,
            m.rule_id, r.title, r.category, r.severity, r.platform,
            r.remediation, m.status, m.actual_value, r.expected_value,
            m.detected_at, m.resolved_at
        FROM agent_misconfigs m
        JOIN misconfig_rules r ON r.rule_id = m.rule_id
        JOIN agents a ON a.id = m.agent_id
        WHERE a.exclude_from_reports = FALSE AND {' AND '.join(where)}
        ORDER BY
            CASE r.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
            a.hostname, r.title
    """), params)

    cols = ["id", "agent_id", "hostname", "display_name", "ip_address", "os_type",
            "rule_id", "title", "category", "severity", "platform",
            "remediation", "status", "actual_value", "expected_value",
            "detected_at", "resolved_at"]
    return [dict(zip(cols, row)) for row in result.fetchall()]


@router.get("/misconfigs/{agent_id}")
async def list_misconfigs_for_agent(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    return await list_misconfigs(agent_id=agent_id, db=db, _=_)


# ── Misconfig rules management ────────────────────────────────────────────────

@router.get("/misconfig-rules")
async def list_misconfig_rules(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_tables(db)
    result = await db.execute(text("""
        SELECT id, rule_id, category, platform, title, description, severity,
               check_field, expected_value, remediation, is_active
        FROM misconfig_rules
        ORDER BY
            CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
            category, title
    """))
    cols = ["id", "rule_id", "category", "platform", "title", "description", "severity",
            "check_field", "expected_value", "remediation", "is_active"]
    return [dict(zip(cols, row)) for row in result.fetchall()]


@router.put("/misconfig-rules/{rule_id}")
async def update_misconfig_rule(
    rule_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    allowed = {"is_active", "severity", "remediation", "description"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields to update")

    set_clauses = ", ".join(f"{k} = :{k}" for k in updates)
    updates["rule_id"] = rule_id
    await db.execute(text(f"UPDATE misconfig_rules SET {set_clauses} WHERE rule_id = :rule_id"), updates)
    await db.commit()
    return {"status": "ok"}


# ── Port endpoints ─────────────────────────────────────────────────────────────

@router.get("/ports")
async def list_ports(
    agent_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    await _ensure_tables(db)

    where = ["1=1"]
    params = {}
    if agent_id:
        where.append("p.agent_id = CAST(:agent_id AS uuid)")
        params["agent_id"] = agent_id

    result = await db.execute(text(f"""
        SELECT p.id, p.agent_id, a.hostname, a.display_name, a.ip_address,
               p.port, p.protocol, p.process_name, p.process_pid,
               p.bind_address, p.state, p.first_seen, p.last_seen
        FROM agent_open_ports p
        JOIN agents a ON a.id = p.agent_id
        WHERE a.exclude_from_reports = FALSE AND {' AND '.join(where)}
        ORDER BY a.hostname, p.port
    """), params)

    cols = ["id", "agent_id", "hostname", "display_name", "ip_address",
            "port", "protocol", "process_name", "process_pid",
            "bind_address", "state", "first_seen", "last_seen"]
    return [dict(zip(cols, row)) for row in result.fetchall()]


@router.get("/ports/{agent_id}")
async def list_ports_for_agent(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    return await list_ports(agent_id=agent_id, db=db, _=_)


# ── High-risk software endpoints ───────────────────────────────────────────────

@router.get("/high-risk")
async def list_high_risk(
    agent_id: Optional[str] = None,
    match_type: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    await _ensure_tables(db)

    where = ["1=1"]
    params = {}
    if agent_id:
        where.append("h.agent_id = CAST(:agent_id AS uuid)")
        params["agent_id"] = agent_id
    if match_type:
        where.append("h.match_type = :match_type")
        params["match_type"] = match_type

    result = await db.execute(text(f"""
        SELECT h.id, h.agent_id, a.hostname, a.display_name, a.ip_address,
               h.software_name, h.software_version, h.match_type, h.severity, h.detected_at
        FROM agent_high_risk_software h
        JOIN agents a ON a.id = h.agent_id
        WHERE a.exclude_from_reports = FALSE AND {' AND '.join(where)}
        ORDER BY
            CASE h.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
            a.hostname, h.software_name
    """), params)

    cols = ["id", "agent_id", "hostname", "display_name", "ip_address",
            "software_name", "software_version", "match_type", "severity", "detected_at"]
    return [dict(zip(cols, row)) for row in result.fetchall()]


@router.post("/high-risk/{finding_id}/uninstall")
async def uninstall_high_risk(
    finding_id: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Queue a software_uninstall command for a high-risk software finding."""
    result = await db.execute(text("""
        SELECT h.agent_id, h.software_name, h.software_version
        FROM agent_high_risk_software h
        WHERE h.id = CAST(:id AS uuid)
    """), {"id": finding_id})
    row = result.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Finding not found")

    agent_id, sw_name, sw_version = row

    payload = json.dumps({"name": sw_name, "version": sw_version or ""})
    await db.execute(text("""
        INSERT INTO agent_commands (agent_id, command_type, payload)
        VALUES (:agent_id, 'software_uninstall', CAST(:payload AS jsonb))
    """), {"agent_id": agent_id, "payload": payload})
    await db.commit()
    return {"status": "queued", "software": sw_name}


# ── Exceptions endpoints ───────────────────────────────────────────────────────

@router.get("/exceptions")
async def list_exceptions(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_tables(db)
    result = await db.execute(text("""
        SELECT e.id, e.exception_type, e.match_value, e.agent_id,
               a.hostname, e.reason, e.created_at, e.expires_at, e.is_active
        FROM threat_exceptions e
        LEFT JOIN agents a ON a.id = e.agent_id
        ORDER BY e.created_at DESC
    """))
    cols = ["id", "exception_type", "match_value", "agent_id",
            "hostname", "reason", "created_at", "expires_at", "is_active"]
    return [dict(zip(cols, row)) for row in result.fetchall()]


@router.post("/exceptions")
async def create_exception(
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    await _ensure_tables(db)

    exc_type = body.get("exception_type")
    match_value = body.get("match_value")
    if not exc_type or not match_value:
        raise HTTPException(status_code=400, detail="exception_type and match_value required")

    await db.execute(text("""
        INSERT INTO threat_exceptions
            (exception_type, match_value, agent_id, reason, created_by, expires_at)
        VALUES (
            :etype, :match,
            CAST(NULLIF(:agent_id, '') AS uuid),
            :reason,
            CAST(:user_id AS uuid),
            CAST(NULLIF(:expires_at, '') AS timestamptz)
        )
    """), {
        "etype": exc_type,
        "match": match_value,
        "agent_id": body.get("agent_id") or "",
        "reason": body.get("reason") or "",
        "user_id": str(current_user.id),
        "expires_at": body.get("expires_at") or "",
    })
    await db.commit()
    return {"status": "created"}


@router.delete("/exceptions/{exception_id}")
async def delete_exception(
    exception_id: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    await db.execute(text("""
        UPDATE threat_exceptions SET is_active = FALSE WHERE id = CAST(:id AS uuid)
    """), {"id": exception_id})
    await db.commit()
    return {"status": "deleted"}


# ── Compliance data for misconfigs ────────────────────────────────────────────

@router.get("/compliance-summary")
async def compliance_summary(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Per-agent compliance summary (pass/fail counts, endpoint protection status)."""
    await _ensure_tables(db)

    result = await db.execute(text("""
        SELECT
            a.id, a.hostname, a.display_name, a.ip_address, a.os_type,
            COUNT(*) FILTER (WHERE m.status = 'fail') AS fail_count,
            COUNT(*) FILTER (WHERE m.status = 'pass') AS pass_count,
            COUNT(*) FILTER (WHERE m.status = 'fail' AND r.severity = 'critical') AS critical_fail,
            COUNT(*) FILTER (WHERE m.status = 'fail' AND r.severity = 'high') AS high_fail,
            -- Endpoint protection: AV running + firewall enabled
            BOOL_OR(m.rule_id = 'NO_AV_INSTALLED' AND m.status = 'pass') AS av_ok,
            BOOL_OR(m.rule_id = 'FIREWALL_DISABLED' AND m.status = 'pass') AS fw_ok
        FROM agents a
        LEFT JOIN agent_misconfigs m ON m.agent_id = a.id
        LEFT JOIN misconfig_rules r ON r.rule_id = m.rule_id
        WHERE a.is_active = TRUE AND a.exclude_from_reports = FALSE
        GROUP BY a.id, a.hostname, a.display_name, a.ip_address, a.os_type
        ORDER BY a.hostname
    """))

    rows = result.fetchall()
    cols = ["id", "hostname", "display_name", "ip_address", "os_type",
            "fail_count", "pass_count", "critical_fail", "high_fail", "av_ok", "fw_ok"]

    agents = []
    for row in rows:
        d = dict(zip(cols, row))
        total = (d["pass_count"] or 0) + (d["fail_count"] or 0)
        d["config_score"] = round((d["pass_count"] or 0) / total * 100, 1) if total > 0 else None
        d["endpoint_protected"] = bool(d["av_ok"] and d["fw_ok"])
        agents.append(d)

    return agents


# ── CVE / Vulnerability endpoints ─────────────────────────────────────────────

@router.get("/vulnerabilities")
async def list_vulnerabilities(
    agent_id: Optional[str] = None,
    severity: Optional[str] = None,
    status: Optional[str] = None,
    zero_day_only: bool = False,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """List software vulnerabilities (CVEs) per agent."""
    from api.services.cve_matcher import ensure_cve_tables
    await ensure_cve_tables(db)

    where = ["v.status != 'excepted'"]
    params = {}

    if agent_id:
        where.append("v.agent_id = CAST(:agent_id AS uuid)")
        params["agent_id"] = agent_id
    if severity:
        where.append("v.severity = :severity")
        params["severity"] = severity
    if status:
        where.append("v.status = :status")
        params["status"] = status
    else:
        where.append("v.status = 'open'")
    if zero_day_only:
        where.append("c.is_zero_day = TRUE")

    result = await db.execute(text(f"""
        SELECT
            v.id, v.agent_id, a.hostname, a.display_name, a.ip_address,
            v.cve_id, v.software_name, v.software_version,
            v.severity, v.cvss_score, v.status, v.detected_at, v.remediated_at,
            c.description, c.is_zero_day, c.published_date, c."references"
        FROM agent_vulnerabilities v
        JOIN agents a ON a.id = v.agent_id
        LEFT JOIN cve_database c ON c.cve_id = v.cve_id
        WHERE a.exclude_from_reports = FALSE AND {' AND '.join(where)}
        ORDER BY
            CASE v.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
            v.cvss_score DESC NULLS LAST,
            a.hostname, v.cve_id
    """), params)

    cols = ["id", "agent_id", "hostname", "display_name", "ip_address",
            "cve_id", "software_name", "software_version",
            "severity", "cvss_score", "status", "detected_at", "remediated_at",
            "description", "is_zero_day", "published_date", "references"]
    rows = []
    for row in result.fetchall():
        d = dict(zip(cols, row))
        if d.get("cvss_score") is not None:
            d["cvss_score"] = float(d["cvss_score"])
        rows.append(d)
    return rows


@router.get("/vulnerabilities/cve-view")
async def cve_centric_view(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """CVE-centric view: each CVE grouped with all affected agents."""
    from api.services.cve_matcher import ensure_cve_tables
    await ensure_cve_tables(db)

    result = await db.execute(text("""
        SELECT
            v.cve_id,
            c.description, c.severity, c.cvss_score, c.is_zero_day,
            c.published_date, c."references",
            COUNT(DISTINCT v.agent_id) AS agent_count,
            STRING_AGG(DISTINCT a.hostname, ', ' ORDER BY a.hostname) AS hostnames,
            STRING_AGG(DISTINCT v.software_name, ', ' ORDER BY v.software_name) AS software_names
        FROM agent_vulnerabilities v
        LEFT JOIN cve_database c ON c.cve_id = v.cve_id
        JOIN agents a ON a.id = v.agent_id AND a.exclude_from_reports = FALSE
        WHERE v.status = 'open'
        GROUP BY v.cve_id, c.description, c.severity, c.cvss_score, c.is_zero_day, c.published_date, c."references"
        ORDER BY
            CASE c.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
            c.cvss_score DESC NULLS LAST,
            v.cve_id
    """))

    cols = ["cve_id", "description", "severity", "cvss_score", "is_zero_day",
            "published_date", "references", "agent_count", "hostnames", "software_names"]
    rows = []
    for row in result.fetchall():
        d = dict(zip(cols, row))
        if d.get("cvss_score") is not None:
            d["cvss_score"] = float(d["cvss_score"])
        rows.append(d)
    return rows


@router.get("/vulnerabilities/zero-day")
async def list_zero_day_vulns(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Zero-day vulnerabilities: open, critical/high, published within 30 days, no fix available."""
    return await list_vulnerabilities(zero_day_only=True, db=db, _=_)


@router.post("/vulnerabilities/{vuln_id}/mark-remediated")
async def mark_remediated(
    vuln_id: str,
    body: dict = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    notes = (body or {}).get("notes", "Manually marked as remediated")
    await db.execute(text("""
        UPDATE agent_vulnerabilities
        SET status = 'remediated', remediated_at = NOW(), remediation_notes = :notes
        WHERE id = CAST(:id AS uuid)
    """), {"id": vuln_id, "notes": notes})
    await db.commit()
    return {"status": "ok"}


@router.post("/vulnerabilities/{vuln_id}/except")
async def except_vulnerability(
    vuln_id: str,
    body: dict = None,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Add an exception for a specific CVE finding."""
    result = await db.execute(text("""
        SELECT agent_id, cve_id FROM agent_vulnerabilities WHERE id = CAST(:id AS uuid)
    """), {"id": vuln_id})
    row = result.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Vulnerability not found")

    agent_id, cve_id = row
    reason = (body or {}).get("reason", "")

    await db.execute(text("""
        INSERT INTO threat_exceptions (exception_type, match_value, agent_id, reason, created_by)
        VALUES ('cve', :cve_id, :agent_id, :reason, CAST(:user_id AS uuid))
    """), {"cve_id": cve_id, "agent_id": agent_id, "reason": reason, "user_id": str(current_user.id)})

    await db.execute(text("""
        UPDATE agent_vulnerabilities SET status = 'excepted' WHERE id = CAST(:id AS uuid)
    """), {"id": vuln_id})

    await db.commit()
    return {"status": "ok"}


@router.post("/vulnerabilities/rescan/{agent_id}")
async def rescan_cves(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Trigger a CVE rescan for a specific agent (fire-and-forget)."""
    import asyncio
    from api.services.cve_matcher import match_agent_cves
    from api.database import AsyncSessionLocal

    async def _run():
        async with AsyncSessionLocal() as bg_db:
            await match_agent_cves(agent_id, bg_db)

    asyncio.create_task(_run())
    return {"status": "scan_queued", "agent_id": agent_id}


@router.get("/vulnerabilities/summary")
async def vuln_summary(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Per-severity counts for open vulnerabilities."""
    from api.services.cve_matcher import ensure_cve_tables
    await ensure_cve_tables(db)

    result = await db.execute(text("""
        SELECT
            severity,
            COUNT(*) AS total,
            COUNT(DISTINCT agent_id) AS agents_affected,
            COUNT(*) FILTER (WHERE c.is_zero_day = TRUE) AS zero_day_count
        FROM agent_vulnerabilities v
        LEFT JOIN cve_database c ON c.cve_id = v.cve_id
        WHERE v.status = 'open'
        GROUP BY severity
        ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END
    """))

    rows = result.fetchall()
    return {
        "by_severity": [{"severity": r[0], "total": r[1], "agents_affected": r[2], "zero_day": r[3]} for r in rows],
        "total_open": sum(r[1] for r in rows),
        "total_zero_day": sum(r[3] for r in rows),
        "critical_open": next((r[1] for r in rows if r[0] == "critical"), 0),
        "high_open": next((r[1] for r in rows if r[0] == "high"), 0),
    }


# ── Web Server Misconfiguration endpoints ─────────────────────────────────────

@router.post("/webconfig-report")
async def receive_webconfig_report(
    body: dict,
    x_api_key: str = Header(..., alias="X-API-Key"),
    db: AsyncSession = Depends(get_db),
):
    """Receive web server misconfiguration findings from an agent."""
    agent = await get_agent_by_api_key(db, x_api_key)
    if not agent:
        raise HTTPException(status_code=401, detail="Not authenticated")

    await _ensure_tables(db)

    findings = body.get("findings") or []

    # Replace existing findings for this agent
    await db.execute(text("""
        DELETE FROM agent_webconfig_findings WHERE agent_id = CAST(:agent_id AS uuid)
    """), {"agent_id": str(agent.id)})

    for f in (findings or []):
        await db.execute(text("""
            INSERT INTO agent_webconfig_findings
                (agent_id, server_type, config_file, finding_id, severity, title, detail, remediation)
            VALUES (CAST(:agent_id AS uuid), :server_type, :config_file, :finding_id, :severity, :title, :detail, :remediation)
        """), {
            "agent_id": str(agent.id),
            "server_type": f.get("server_type", ""),
            "config_file": f.get("config_file", ""),
            "finding_id": f.get("finding_id", ""),
            "severity": f.get("severity", "medium"),
            "title": f.get("title", ""),
            "detail": f.get("detail", ""),
            "remediation": f.get("remediation", ""),
        })

    await db.commit()
    return {"status": "ok", "findings_stored": len(findings)}


@router.get("/webconfig")
async def list_webconfig_findings(
    agent_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """List web server misconfiguration findings across all agents."""
    await _ensure_tables(db)

    where = ["1=1"]
    params = {}
    if agent_id:
        where.append("w.agent_id = CAST(:agent_id AS uuid)")
        params["agent_id"] = agent_id

    result = await db.execute(text(f"""
        SELECT w.id, w.agent_id, a.hostname, a.display_name, a.ip_address,
               w.server_type, w.config_file, w.finding_id, w.severity,
               w.title, w.detail, w.remediation, w.detected_at
        FROM agent_webconfig_findings w
        JOIN agents a ON a.id = w.agent_id AND a.exclude_from_reports = FALSE
        WHERE {' AND '.join(where)}
        ORDER BY
            CASE w.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
            a.hostname, w.server_type
    """), params)

    cols = ["id", "agent_id", "hostname", "display_name", "ip_address",
            "server_type", "config_file", "finding_id", "severity",
            "title", "detail", "remediation", "detected_at"]
    return [dict(zip(cols, row)) for row in result.fetchall()]


@router.get("/webconfig/{agent_id}")
async def list_webconfig_for_agent(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    return await list_webconfig_findings(agent_id=agent_id, db=db, _=_)


# ── AV Status dashboard ────────────────────────────────────────────────────────

@router.get("/av-status")
async def av_status(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Per-agent AV status with version from software inventory."""

    # Main query: join agents + security state
    result = await db.execute(text("""
        SELECT
            a.id::text,
            a.hostname,
            a.display_name,
            a.ip_address,
            a.os_type,
            a.os_name,
            a.status,
            a.agent_version,
            s.av_installed,
            s.av_product,
            s.av_running,
            s.av_last_scan,
            s.updated_at
        FROM agents a
        LEFT JOIN agent_security_state s ON s.agent_id = a.id
        WHERE a.is_active = TRUE AND a.exclude_from_reports = FALSE
        ORDER BY a.os_type, a.hostname
    """))
    rows = result.fetchall()
    cols = ["id","hostname","display_name","ip_address","os_type","os_name","status",
            "agent_version","av_installed","av_product","av_running","av_last_scan","updated_at"]

    # AV keywords for software inventory lookup — used both for version matching
    # and as fallback detection when Security Center doesn't register the product
    # (common with Sophos Endpoint, CrowdStrike, and other managed/EDR products)
    AV_KEYWORDS = [
        "defender", "sophos", "eset", "kaspersky", "symantec", "norton",
        "mcafee", "trellix", "trend micro", "bitdefender", "avg", "avast",
        "malwarebytes", "crowdstrike", "sentinelone", "carbon black",
        "cylance", "f-secure", "clamav", "panda", "webroot", "vipre",
        "comodo", "bullguard", "g data", "emsisoft",
    ]
    # Deduplicate component noise — these sub-packages are included in a
    # product and shouldn't generate separate rows in the AV table
    AV_COMPONENT_NOISE = [
        "amsi protection", "autoupdate", "diagnostic", "standalone engine",
        "ml engine", "health", "exploit prevention", "file integrity",
        "file scanner", "self help", "endpoint defense", "endpoint firewall",
        "network threat", "management communications",
    ]

    kw_conditions = " OR ".join(
        f"LOWER(si.name) LIKE '%{kw}%'" for kw in AV_KEYWORDS
    )
    sw_result = await db.execute(text(f"""
        SELECT DISTINCT ON (si.agent_id, si.name)
            si.agent_id::text,
            si.name,
            si.version,
            si.publisher
        FROM software_inventory si
        WHERE {kw_conditions}
        ORDER BY si.agent_id, si.name, si.version DESC NULLS LAST
    """))

    # Build map: agent_id -> list of {name, version, publisher}
    sw_by_agent: dict = {}
    for sw_row in sw_result.fetchall():
        aid, sw_name, sw_ver, sw_pub = sw_row[0], sw_row[1], sw_row[2], sw_row[3]
        # Skip sub-component noise entries
        name_lower = (sw_name or "").lower()
        if any(noise in name_lower for noise in AV_COMPONENT_NOISE):
            continue
        sw_by_agent.setdefault(aid, []).append({
            "name": sw_name,
            "version": sw_ver,
            "publisher": sw_pub,
        })

    def _group_sw_products(sw_list):
        """Group SW inventory AV entries by publisher/product family."""
        # Consolidate Sophos components into one entry with the main version
        grouped = {}
        for sw in sw_list:
            name_lower = (sw["name"] or "").lower()
            pub_lower  = (sw["publisher"] or "").lower()
            # Determine product family key
            if "sophos" in name_lower or "sophos" in pub_lower:
                key = "Sophos"
            elif "avg" in name_lower or "gen digital" in pub_lower:
                key = "AVG"
            elif "avast" in name_lower:
                key = "Avast"
            elif "crowdstrike" in name_lower or "crowdstrike" in pub_lower:
                key = "CrowdStrike Falcon"
            elif "sentinelone" in name_lower:
                key = "SentinelOne"
            elif "malwarebytes" in name_lower:
                key = "Malwarebytes"
            elif "eset" in name_lower:
                key = "ESET"
            elif "kaspersky" in name_lower:
                key = "Kaspersky"
            elif "bitdefender" in name_lower:
                key = "Bitdefender"
            elif "mcafee" in name_lower or "trellix" in name_lower:
                key = "McAfee / Trellix"
            elif "trend micro" in name_lower:
                key = "Trend Micro"
            elif "symantec" in name_lower or "norton" in name_lower:
                key = "Symantec / Norton"
            else:
                key = sw["name"]  # keep as-is for unknown entries

            # Keep highest-versioned entry per family, prefer "Agent" entries
            if key not in grouped:
                grouped[key] = sw
            else:
                # Prefer the entry whose name contains "Agent" or "Endpoint"
                existing_name = (grouped[key]["name"] or "").lower()
                new_name = (sw["name"] or "").lower()
                if ("agent" in new_name or "endpoint" in new_name) and \
                   ("agent" not in existing_name and "endpoint" not in existing_name):
                    grouped[key] = sw

        return [{"name": k, "version": v["version"], "publisher": v["publisher"]}
                for k, v in grouped.items()]

    agents_out = []
    for row in rows:
        d = dict(zip(cols, row))
        aid = d["id"]
        os_type = (d["os_type"] or "").lower()
        sc2_installed = d["av_installed"]   # from Security Center 2
        sc2_product   = d["av_product"] or ""
        sc2_running   = d["av_running"]
        sw_matches    = sw_by_agent.get(aid, [])
        sw_products   = _group_sw_products(sw_matches)

        # ── Detection source logic ────────────────────────────────────────────
        # sc2_installed=True  → Security Center detected AV (Windows)
        # sc2_installed=False but sw_products exist → AV found in SW inventory
        #   (common for Sophos Intercept, CrowdStrike, managed EDR products
        #    that don't register in SecurityCenter2)
        # sc2_installed=None  → agent hasn't sent a security report yet

        if os_type == "linux":
            # Linux: AV is optional — only report if actually found
            if sw_products:
                av_source    = "software_inventory"
                av_installed = True
                av_running   = None
                av_product   = ", ".join(s["name"] for s in sw_products)
                av_versions  = [{"name": s["name"], "version": s["version"]} for s in sw_products]
            elif sc2_installed:  # linux agent somehow sent AV data
                av_source    = "security_center"
                av_installed = bool(sc2_installed)
                av_running   = bool(sc2_running)
                av_product   = sc2_product or None
                av_versions  = []
            else:
                av_source    = "not_applicable"
                av_installed = None
                av_running   = None
                av_product   = None
                av_versions  = []

        elif sc2_installed:
            sc2_names_raw = [p.strip() for p in sc2_product.split(",") if p.strip()]

            # Detect "Defender displacement": SC2 only reports Windows Defender
            # as disabled, but another AV in SW inventory has displaced it.
            # This happens because Defender auto-disables when a 3rd-party AV is active.
            only_disabled_defender = (
                len(sc2_names_raw) == 1
                and "defender" in sc2_names_raw[0].lower()
                and not sc2_running
            )
            # Filter non-Defender products from SW inventory
            sw_non_defender = [s for s in sw_products if "defender" not in (s["name"] or "").lower()]

            if only_disabled_defender and sw_non_defender:
                # Another AV displaced Defender — use SW inventory as primary source
                av_source    = "software_inventory"
                av_installed = True
                av_running   = None   # services confirm it's running but SC2 can't tell us
                av_product   = ", ".join(s["name"] for s in sw_non_defender)
                av_versions  = [{"name": s["name"], "version": s["version"]} for s in sw_non_defender]
            else:
                # Normal SC2 data — use it, augment versions from SW inventory
                av_source    = "security_center"
                av_installed = True
                av_running   = bool(sc2_running)

                sc2_names = sc2_names_raw
                # Remove Defender if other products also registered (it coexists)
                if len(sc2_names) > 1:
                    sc2_names = [n for n in sc2_names if "defender" not in n.lower()]

                av_product = ", ".join(sc2_names) if sc2_names else sc2_product

                sc2_lower = [n.lower() for n in sc2_names]
                av_versions = []
                for swp in sw_products:
                    swp_lower = (swp["name"] or "").lower()
                    if any(kw in swp_lower or swp_lower in sc2n
                           for sc2n in sc2_lower
                           for kw in sc2n.split()):
                        av_versions.append({"name": swp["name"], "version": swp["version"]})
                if not av_versions:
                    av_versions = [{"name": s["name"], "version": s["version"]} for s in sw_products]

        elif sw_products:
            # Security Center missed it — found via software inventory
            av_source    = "software_inventory"
            av_installed = True
            av_running   = None   # can't determine run state from SW inventory alone
            av_product   = ", ".join(s["name"] for s in sw_products)
            av_versions  = [{"name": s["name"], "version": s["version"]} for s in sw_products]

        else:
            # Nothing found
            av_source    = "none" if sc2_installed is not None else "no_report"
            av_installed = False if sc2_installed is not None else None
            av_running   = False if sc2_installed is not None else None
            av_product   = None
            av_versions  = []

        agents_out.append({
            "id": aid,
            "hostname": d["hostname"],
            "display_name": d["display_name"] or d["hostname"],
            "ip_address": d["ip_address"],
            "os_type": os_type,
            "os_name": d["os_name"],
            "status": d["status"],
            "agent_version": d["agent_version"],
            "av_installed": av_installed,
            "av_product": av_product,
            "av_running": av_running,
            "av_source": av_source,   # "security_center" | "software_inventory" | "none" | "no_report"
            "av_last_scan": str(d["av_last_scan"]) if d["av_last_scan"] else None,
            "av_versions": av_versions,
            "security_updated_at": d["updated_at"].isoformat() if d["updated_at"] else None,
        })

    # Summary stats — Windows only (Linux AV is optional/not required)
    total = len(agents_out)
    windows_agents  = [a for a in agents_out if a["os_type"] == "windows"]
    linux_agents    = [a for a in agents_out if a["os_type"] == "linux"]

    # "protected" = SC2 confirmed running OR detected via SW inventory (services confirm)
    win_protected   = sum(1 for a in windows_agents
                          if a["av_running"] is True or a["av_source"] == "software_inventory")
    win_installed   = sum(1 for a in windows_agents if a["av_installed"] is True)
    win_no_av       = sum(1 for a in windows_agents if a["av_installed"] is False)
    linux_with_av   = sum(1 for a in linux_agents if a["av_source"] in ("security_center", "software_inventory"))

    return {
        "summary": {
            "total_agents": total,
            "windows_total": len(windows_agents),
            "linux_total": len(linux_agents),
            "windows_protected": win_protected,
            "windows_av_installed": win_installed,
            "windows_no_av": win_no_av,
            "linux_with_av": linux_with_av,
            "not_yet_reported": sum(1 for a in windows_agents if a["av_source"] == "no_report"),
        },
        "agents": agents_out,
    }
