"""
Agent Watchdog — detects offline agents and automatically restarts the Kifaa
agent service when the machine is still reachable.

Status classifications:
  - online      : agent reporting normally
  - agent_down  : machine reachable, restart attempted (success/fail logged)
  - offline     : machine not reachable on the network
  - unknown     : no IP address recorded

Windows restart: impacket SMB/SCM using AD credentials from ad_configs.
Linux restart:   SSH using per-agent credentials from agent_ssh_credentials.
No extra credential setup required — uses what's already configured.
"""
import socket
import time
import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text

from api.database import get_db
from api.services.auth import get_current_user
from api.config import get_settings


def _decrypt(value):
    """Decrypt a Fernet-encrypted credential. Falls back to plaintext if not encrypted."""
    if not value:
        return value
    key = get_settings().fernet_key
    if not key:
        return value
    try:
        from cryptography.fernet import Fernet
        return Fernet(key.encode() if isinstance(key, str) else key).decrypt(value.encode()).decode()
    except Exception:
        return value  # already plaintext or unencryptable

logger      = logging.getLogger(__name__)
router      = APIRouter()

_TCP_TIMEOUT     = 3    # seconds for reachability probe
_RESTART_TIMEOUT = 15   # seconds for SCM / SSH operations
_COOLDOWN_MIN    = 10   # minutes between restart attempts per agent
_SMB_PORT        = 445
_SSH_PORT        = 22


# ── Low-level helpers ─────────────────────────────────────────────────────────

def _is_reachable(ip: str, port: int) -> bool:
    try:
        with socket.create_connection((ip, port), timeout=_TCP_TIMEOUT):
            return True
    except Exception:
        return False


def _restart_windows_agent(ip: str, username: str, password: str, domain: str) -> tuple[bool, str]:
    """Start KifaaAgent on a remote Windows host via SMB/SCM (impacket)."""
    try:
        from impacket.dcerpc.v5 import transport, scmr as scmr_rpc

        rpctransport = transport.DCERPCTransportFactory(f"ncacn_np:{ip}[\\pipe\\svcctl]")
        rpctransport.set_credentials(username, password, domain, "", "", None)
        rpctransport.setRemoteHost(ip)
        rpctransport.set_connect_timeout(_RESTART_TIMEOUT)

        dce = rpctransport.get_dce_rpc()
        dce.connect()
        dce.bind(scmr_rpc.MSRPC_UUID_SCMR)

        scm = scmr_rpc.hROpenSCManagerW(dce)["lpScHandle"]
        try:
            svc = scmr_rpc.hROpenServiceW(dce, scm, "KifaaAgent")["lpServiceHandle"]
        except Exception as e:
            return False, f"KifaaAgent service not found on {ip}: {e}"

        # Stop first if somehow in a broken state
        try:
            st = scmr_rpc.hRQueryServiceStatus(dce, svc)["lpServiceStatus"]["dwCurrentState"]
            if st == scmr_rpc.SERVICE_RUNNING:
                scmr_rpc.hRControlService(dce, svc, scmr_rpc.SERVICE_CONTROL_STOP)
                time.sleep(2)
        except Exception:
            pass

        scmr_rpc.hRStartServiceW(dce, svc)
        scmr_rpc.hRCloseServiceHandle(dce, svc)
        scmr_rpc.hRCloseServiceHandle(dce, scm)
        dce.disconnect()
        return True, "KifaaAgent started via SMB/SCM"

    except Exception as exc:
        return False, str(exc)


def _restart_linux_agent(ip: str, username: str, password: str,
                          ssh_key: str, port: int, use_sudo: bool) -> tuple[bool, str]:
    """Start kifaa-agent on a remote Linux host via SSH (paramiko)."""
    try:
        import paramiko, io

        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

        kwargs: dict = {"hostname": ip, "port": port, "username": username,
                        "timeout": _RESTART_TIMEOUT}
        if ssh_key:
            for cls in (paramiko.RSAKey, paramiko.Ed25519Key, paramiko.ECDSAKey):
                try:
                    kwargs["pkey"] = cls.from_private_key(io.StringIO(ssh_key))
                    break
                except Exception:
                    continue
        elif password:
            kwargs["password"] = password
        else:
            return False, "No SSH credentials configured for this agent"

        client.connect(**kwargs)
        prefix = "sudo " if use_sudo else ""
        _, stdout, stderr = client.exec_command(f"{prefix}systemctl start kifaa-agent")
        code = stdout.channel.recv_exit_status()
        err  = stderr.read().decode().strip()
        client.close()

        if code == 0:
            return True, "kifaa-agent started via SSH"
        return False, err or f"systemctl exited {code}"

    except Exception as exc:
        return False, str(exc)


# ── Internal endpoint (called by Celery every 5 minutes) ─────────────────────

@router.post("/agents/internal/watchdog-check")
async def internal_watchdog_check(db: AsyncSession = Depends(get_db)):
    """
    For each offline agent:
      1. TCP probe (port 445 Windows / 22 Linux)
      2. If reachable → attempt to start KifaaAgent/kifaa-agent remotely
      3. Log the outcome
    Uses AD credentials (Windows) or per-agent SSH credentials (Linux) — no
    additional credential setup required beyond what is already configured.
    """
    rows = await db.execute(text("""
        SELECT id, hostname, ip_address, os_type
        FROM agents
        WHERE is_active = TRUE
          AND status = 'offline'
          AND watchdog_enabled = TRUE
    """))
    offline_agents = rows.fetchall()

    if not offline_agents:
        return {"status": "ok", "checked": 0}

    # Cooldown: skip agents where a restart was attempted recently
    cooldown_rows = await db.execute(text(f"""
        SELECT DISTINCT ON (agent_id) agent_id
        FROM agent_watchdog_events
        WHERE action_taken = 'restart_attempted'
          AND triggered_at > NOW() - INTERVAL '{_COOLDOWN_MIN} minutes'
    """))
    on_cooldown = {str(r[0]) for r in cooldown_rows.fetchall()}

    # AD credentials for Windows restarts (from existing ad_configs)
    ad_row = await db.execute(text("""
        SELECT service_account, service_password, domain_fqdn
        FROM ad_configs WHERE is_active = TRUE LIMIT 1
    """))
    ad_cfg   = ad_row.fetchone()
    win_user = win_pass = win_domain = ""
    if ad_cfg:
        acc = ad_cfg[0] or ""
        win_pass   = _decrypt(ad_cfg[1]) or ""
        win_domain = (ad_cfg[2] or "").split(".")[0]
        win_user   = acc.split("\\", 1)[1] if "\\" in acc else acc

    results = []
    for agent in offline_agents:
        aid      = str(agent[0])
        hostname = agent[1]
        ip       = agent[2]
        os_type  = (agent[3] or "").lower()

        if not ip:
            await db.execute(text("""
                INSERT INTO agent_watchdog_events (agent_id, reachable, action_taken, message)
                VALUES (CAST(:aid AS uuid), NULL, 'unknown', 'No IP address recorded')
            """), {"aid": aid})
            results.append({"agent": hostname, "status": "unknown"})
            continue

        probe_port = _SMB_PORT if os_type == "windows" else _SSH_PORT
        reachable  = _is_reachable(ip, probe_port)

        if not reachable:
            await db.execute(text("""
                INSERT INTO agent_watchdog_events (agent_id, reachable, action_taken, message)
                VALUES (CAST(:aid AS uuid), FALSE, 'not_reachable',
                        :msg)
            """), {"aid": aid, "msg": f"Port {probe_port} on {ip} did not respond"})
            results.append({"agent": hostname, "reachable": False})
            continue

        # Machine is reachable — check cooldown before attempting restart
        if aid in on_cooldown:
            results.append({"agent": hostname, "reachable": True, "action": "cooldown"})
            continue

        # Attempt restart
        if os_type == "windows":
            if win_user and win_pass:
                success, message = _restart_windows_agent(ip, win_user, win_pass, win_domain)
            else:
                success, message = False, "No AD credentials configured in ad_configs"
        else:
            ssh_row = await db.execute(text("""
                SELECT username, password, ssh_key, port, use_sudo
                FROM agent_ssh_credentials WHERE agent_id = CAST(:aid AS uuid) LIMIT 1
            """), {"aid": aid})
            cred = ssh_row.fetchone()
            if cred:
                success, message = _restart_linux_agent(
                    ip, cred[0] or "",
                    _decrypt(cred[1]) or "",
                    _decrypt(cred[2]) or "",
                    int(cred[3] or _SSH_PORT), bool(cred[4])
                )
            else:
                success, message = False, "No SSH credentials configured for this agent"

        await db.execute(text("""
            INSERT INTO agent_watchdog_events
                (agent_id, reachable, action_taken, success, message)
            VALUES (CAST(:aid AS uuid), TRUE, 'restart_attempted', :success, :message)
        """), {"aid": aid, "success": success, "message": message})

        results.append({"agent": hostname, "reachable": True,
                        "success": success, "message": message})
        logger.info("Watchdog restart %s (%s): success=%s — %s", hostname, ip, success, message)

    await db.commit()
    return {"status": "ok", "checked": len(results), "results": results}


# ── User-facing endpoints ─────────────────────────────────────────────────────

@router.get("/agents/watchdog/status")
async def watchdog_status(
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """All agents with their current watchdog classification."""
    rows = await db.execute(text("""
        SELECT
            a.id, a.hostname, a.display_name, a.ip_address, a.os_type,
            a.status, a.last_seen, a.watchdog_enabled,
            e.reachable, e.action_taken, e.success, e.message, e.triggered_at
        FROM agents a
        LEFT JOIN LATERAL (
            SELECT reachable, action_taken, success, message, triggered_at
            FROM agent_watchdog_events
            WHERE agent_id = a.id
            ORDER BY triggered_at DESC
            LIMIT 1
        ) e ON TRUE
        WHERE a.is_active = TRUE
        ORDER BY
            CASE
                WHEN a.status = 'offline' AND e.reachable = TRUE  THEN 0
                WHEN a.status = 'offline' AND e.reachable IS NULL  THEN 1
                WHEN a.status = 'offline'                          THEN 2
                ELSE 3
            END,
            a.hostname
    """))
    result = []
    for r in rows.fetchall():
        agent_status = r[5]
        reachable    = r[8]
        action       = r[9]

        success = r[10]

        # Derive watchdog classification
        if agent_status == "online":
            watchdog_class = "online"
        elif not r[3]:  # no IP
            watchdog_class = "unknown"
        elif action == "restart_attempted":
            watchdog_class = "restart_ok" if success else "restart_failed"
        elif action == "not_reachable" or reachable is False:
            watchdog_class = "offline"
        elif action == "unknown":
            watchdog_class = "unknown"
        else:
            watchdog_class = "unknown"

        result.append({
            "id":               str(r[0]),
            "hostname":         r[1],
            "display_name":     r[2],
            "ip_address":       r[3],
            "os_type":          r[4],
            "status":           agent_status,
            "watchdog_class":   watchdog_class,
            "last_seen":        r[6].isoformat() if r[6] else None,
            "watchdog_enabled": r[7],
            "last_reachable":   reachable,
            "last_action":      action,
            "last_success":     success,
            "last_message":     r[11],
            "last_checked":     r[12].isoformat() if r[12] else None,
        })
    return result


@router.get("/agents/watchdog/events")
async def watchdog_events(
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """Recent watchdog probe events."""
    rows = await db.execute(text("""
        SELECT e.id, e.reachable, e.action_taken, e.message, e.triggered_at,
               a.hostname, a.display_name, a.os_type, a.ip_address
        FROM agent_watchdog_events e
        JOIN agents a ON a.id = e.agent_id
        ORDER BY e.triggered_at DESC
        LIMIT :limit
    """), {"limit": limit})
    result = []
    for r in rows.fetchall():
        result.append({
            "id":           str(r[0]),
            "reachable":    r[1],
            "action_taken": r[2],
            "message":      r[3],
            "triggered_at": r[4].isoformat() if r[4] else None,
            "hostname":     r[5],
            "display_name": r[6],
            "os_type":      r[7],
            "ip_address":   r[8],
        })
    return result


@router.patch("/agents/{agent_id}/watchdog")
async def toggle_watchdog(
    agent_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    """Enable or disable watchdog for a specific agent."""
    enabled = body.get("enabled")
    if enabled is None:
        raise HTTPException(status_code=400, detail="'enabled' field required")
    await db.execute(
        text("UPDATE agents SET watchdog_enabled = :v WHERE id = CAST(:id AS uuid)"),
        {"v": bool(enabled), "id": agent_id},
    )
    await db.commit()
    return {"status": "ok"}
