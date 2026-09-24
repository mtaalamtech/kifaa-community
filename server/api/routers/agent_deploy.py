import asyncio
import ipaddress
import json
import socket
from typing import List

import paramiko
from fastapi import APIRouter, WebSocket, Query
from sqlalchemy import text

from api.database import AsyncSessionLocal
from api.services.auth import decode_token
from api.config import get_settings

router = APIRouter(prefix="/agent-deploy")

# Must match config.AgentVersion in the Go agent
CURRENT_AGENT_VERSION = "1.4.4"

PROBE_PORTS = [22, 135, 445, 3389, 5985]
PROBE_TIMEOUT = 0.5
MAX_RANGE = 1024


def parse_ip_range(range_str: str) -> List[str]:
    ips = []
    parts = [p.strip() for p in range_str.split(",")]
    for part in parts:
        if "/" in part:
            net = ipaddress.ip_network(part, strict=False)
            ips.extend(str(ip) for ip in net.hosts())
        elif "-" in part:
            base, last = part.rsplit(".", 1)
            if "-" in last:
                start_str, end_str = last.split("-")
                start = int(start_str)
                end = int(end_str)
                for i in range(start, end + 1):
                    ips.append(f"{base}.{i}")
            else:
                ips.append(part)
        else:
            ips.append(part)
    return ips


async def probe_port(ip: str, port: int) -> bool:
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(ip, port), timeout=PROBE_TIMEOUT
        )
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return True
    except Exception:
        return False


async def scan_host(ip: str, sem: asyncio.Semaphore):
    async with sem:
        tasks = [probe_port(ip, p) for p in PROBE_PORTS]
        results = await asyncio.gather(*tasks)
        open_ports = [PROBE_PORTS[i] for i, r in enumerate(results) if r]
        return ip, open_ports


def detect_os(open_ports: List[int]) -> str:
    has_5985 = 5985 in open_ports
    has_3389 = 3389 in open_ports
    has_445 = 445 in open_ports
    has_22 = 22 in open_ports

    if has_5985 or (has_3389 and has_445):
        return "windows"
    if has_445 and not has_22:
        return "windows"
    if has_22:
        return "linux"
    return "unknown"


async def reverse_dns(ip: str, loop: asyncio.AbstractEventLoop) -> str:
    try:
        result = await loop.run_in_executor(
            None, lambda: socket.getnameinfo((ip, 0), 0)[0]
        )
        return result
    except Exception:
        return ip


@router.websocket("/scan")
async def scan_ws(websocket: WebSocket, token: str = Query(...)):
    await websocket.accept()

    if not decode_token(token):
        await websocket.send_json({"type": "error", "msg": "Unauthorized"})
        await websocket.close()
        return

    try:
        data = await websocket.receive_json()
    except Exception:
        await websocket.send_json({"type": "error", "msg": "Invalid message"})
        await websocket.close()
        return

    range_str = data.get("range", "")
    if not range_str:
        await websocket.send_json({"type": "error", "msg": "Missing range"})
        await websocket.close()
        return

    try:
        ips = parse_ip_range(range_str)
    except Exception as e:
        await websocket.send_json({"type": "error", "msg": f"Invalid range: {e}"})
        await websocket.close()
        return

    if len(ips) > MAX_RANGE:
        await websocket.send_json({"type": "error", "msg": f"Range too large (max {MAX_RANGE})"})
        await websocket.close()
        return

    loop = asyncio.get_event_loop()
    sem = asyncio.Semaphore(100)
    found = 0

    tasks = [scan_host(ip, sem) for ip in ips]

    for coro in asyncio.as_completed(tasks):
        try:
            ip, open_ports = await coro
        except Exception:
            continue

        if not open_ports:
            continue

        found += 1
        os_type = detect_os(open_ports)
        hostname = await reverse_dns(ip, loop)

        await websocket.send_json({
            "type": "result",
            "ip": ip,
            "hostname": hostname,
            "os": os_type,
            "ports": open_ports,
        })

    await websocket.send_json({"type": "done", "scanned": len(ips), "found": found})
    await websocket.close()


def _ssh_deploy(target: dict, server_url: str, secret: str) -> List[dict]:
    import base64

    logs = []

    def log(level, msg):
        logs.append({"level": level, "msg": msg})

    ip       = target["ip"]
    username = target["username"]
    password = target.get("password", "")
    port     = target.get("port", 22)
    use_sudo = target.get("use_sudo", False)
    install_dir = target.get("install_dir") or "/opt/kifaa-agent"

    # Need sudo when: use_sudo is True AND user is not root
    need_sudo = use_sudo and username != "root"

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        ssh.connect(ip, port=port, username=username, password=password, timeout=15)
    except Exception as e:
        log("error", f"SSH connect failed: {e}")
        return logs

    log("info", f"Connected as {username}{'  (sudo)' if need_sudo else ''}")

    def run(cmd, elevated=False):
        log("info", f"$ {cmd[:100]}{'...' if len(cmd) > 100 else ''}")
        actual_cmd = f"sudo -S -p '' {cmd}" if (elevated and need_sudo) else cmd
        try:
            stdin, stdout, stderr = ssh.exec_command(actual_cmd, timeout=120)
            if elevated and need_sudo and password:
                try:
                    stdin.write(password + "\n")
                    stdin.flush()
                except Exception:
                    pass
            out = stdout.read().decode(errors="replace").strip()
            err = stderr.read().decode(errors="replace").strip()
            rc  = stdout.channel.recv_exit_status()
            if out:
                log("info", out)
            if err:
                for line in err.splitlines():
                    if line.strip().lower() in ("password:", "[sudo] password:"):
                        continue
                    # Log stderr as info on success (systemctl etc. use stderr for normal output)
                    log("error" if rc != 0 else "info", line)
            if rc != 0:
                log("error", f"Command exited with code {rc}")
        except Exception as e:
            log("error", f"Command failed: {e}")

    # Create install directory
    run(f"mkdir -p {install_dir}", elevated=True)

    # Download to /tmp (no privileges needed)
    agent_url = f"{server_url}/downloads/kifaa-agent-linux-amd64"
    run(
        f"curl -fsSL '{agent_url}' -o /tmp/kifaa-agent --connect-timeout 30 "
        f"|| wget -q '{agent_url}' -O /tmp/kifaa-agent"
    )

    # Move to install dir and set permissions
    run(f"cp /tmp/kifaa-agent {install_dir}/kifaa-agent && rm -f /tmp/kifaa-agent", elevated=True)
    run(f"chmod +x {install_dir}/kifaa-agent", elevated=True)

    # Write systemd service via /tmp then copy with sudo (avoids stdin conflict)
    service_content = (
        "[Unit]\n"
        "Description=Kifaa Endpoint Agent\n"
        "After=network.target\n\n"
        "[Service]\n"
        "Type=simple\n"
        f"ExecStart={install_dir}/kifaa-agent --server {server_url} --secret {secret}\n"
        "Restart=always\n"
        "RestartSec=10\n\n"
        "[Install]\n"
        "WantedBy=multi-user.target\n"
    )
    service_b64 = base64.b64encode(service_content.encode()).decode()
    run(f"echo {service_b64} | base64 -d > /tmp/kifaa-agent.service")
    run("cp /tmp/kifaa-agent.service /etc/systemd/system/kifaa-agent.service && rm -f /tmp/kifaa-agent.service", elevated=True)

    run("systemctl daemon-reload", elevated=True)
    run("systemctl enable --now kifaa-agent", elevated=True)

    ssh.close()
    log("success", f"Agent deployed to {install_dir}")
    return logs


def _smb_detect_arch(smb) -> str:
    """Return 'amd64' or '386' by checking if SysWOW64 exists (64-bit Windows has it)."""
    try:
        smb.listPath("C$", r"Windows\SysWOW64\*")
        return "amd64"
    except Exception:
        return "386"


def _smb_write(smb, share_path: str, data: bytes, log_fn):
    """Write bytes to a remote SMB path using a closure-based read callback."""
    offset = [0]
    def _read(n):
        chunk = data[offset[0]:offset[0] + n]
        offset[0] += n
        return chunk
    smb.putFile("C$", share_path, _read)


def _smb_run_bat(smb, ip, username, password, domain, bat_path: str,
                 wait_secs: int, log_fn, imp_transport, tsch, scmr, NULL, time):
    """
    Run a bat file on the remote host using Task Scheduler (preferred) or SCM.
    bat_path is the Windows path, e.g. C:\\Windows\\Temp\\kifaa-deploy.bat
    Returns True if launched successfully.
    """
    launched = False

    # Try 1: Task Scheduler (Vista / 2008 R2 +)
    try:
        task_name = "\\KifaaAgentDeploy"
        task_xml = (
            '<?xml version="1.0" encoding="UTF-16"?>'
            '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">'
            '<RegistrationInfo/><Triggers/>'
            '<Settings>'
            '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'
            '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>'
            '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>'
            '<AllowHardTerminate>true</AllowHardTerminate>'
            '<ExecutionTimeLimit>PT10M</ExecutionTimeLimit>'
            '</Settings>'
            '<Principals><Principal id="Author">'
            '<RunLevel>HighestAvailable</RunLevel>'
            '</Principal></Principals>'
            '<Actions Context="Author"><Exec>'
            '<Command>cmd.exe</Command>'
            f'<Arguments>/c "{bat_path}"</Arguments>'
            '</Exec></Actions>'
            '</Task>'
        )
        rpct = imp_transport.SMBTransport(ip, filename=r"\atsvc")
        rpct.set_credentials(username, password, domain, "", "", None)
        dce = rpct.get_dce_rpc()
        dce.connect()
        dce.bind(tsch.MSRPC_UUID_TSCHS)
        tsch.hSchRpcRegisterTask(dce, task_name, task_xml,
                                 tsch.TASK_CREATE, NULL, tsch.TASK_LOGON_NONE)
        tsch.hSchRpcRun(dce, task_name)
        log_fn("info", f"Task Scheduler: deploy bat launched, waiting {wait_secs} s …")
        # Poll up to wait_secs for completion
        for _ in range(wait_secs // 2):
            time.sleep(2)
            try:
                resp = tsch.hSchRpcGetLastRunInfo(dce, task_name)
                if resp["pLastRuntime"]["wYear"] != 0:
                    log_fn("info", "Task Scheduler: bat completed")
                    break
            except Exception:
                break
        try:
            tsch.hSchRpcDelete(dce, task_name)
        except Exception:
            pass
        dce.disconnect()
        launched = True
    except Exception as tsch_err:
        log_fn("info", f"Task Scheduler unavailable ({tsch_err}) — falling back to SCM …")

    # Try 2: SCM (works on XP / 2003 / 2008 without Task Scheduler access)
    if not launched:
        svc_name = "KifaaBootstrap"
        full_cmd = f"cmd.exe /c {bat_path}"
        try:
            rpct2 = imp_transport.SMBTransport(ip, filename=r"\svcctl", smb_connection=smb)
            dce2  = rpct2.get_dce_rpc()
            dce2.connect()
            dce2.bind(scmr.MSRPC_UUID_SCMR)
            scm_h = scmr.hROpenSCManagerW(dce2)["lpScHandle"]

            # ── Clean up all KifaaTmp*/KifaaBootstrap leftovers via enumeration ──
            try:
                svc_list = scmr.hREnumServicesStatusW(dce2, scm_h)
                for entry in svc_list:
                    name = entry['lpServiceName']
                    if name.startswith('KifaaTmp') or name == 'KifaaBootstrap':
                        try:
                            h = scmr.hROpenServiceW(dce2, scm_h, name)["lpServiceHandle"]
                            scmr.hRDeleteService(dce2, h)
                            scmr.hRCloseServiceHandle(dce2, h)
                            log_fn("info", f"Cleaned up stale launcher: {name}")
                        except Exception:
                            pass
            except Exception:
                pass  # enumeration not critical

            # ── Also try fixed legacy names ────────────────────────────────────
            for stale in ["KifaaTmpDeploy", "KifaaBootstrap"]:
                try:
                    old_h = scmr.hROpenServiceW(dce2, scm_h, stale)["lpServiceHandle"]
                    scmr.hRDeleteService(dce2, old_h)
                    scmr.hRCloseServiceHandle(dce2, old_h)
                except Exception:
                    pass

            scmr.hRCreateServiceW(dce2, scm_h, svc_name, svc_name,
                                  lpBinaryPathName=full_cmd,
                                  dwStartType=scmr.SERVICE_DEMAND_START)
            svc_h = scmr.hROpenServiceW(dce2, scm_h, svc_name)["lpServiceHandle"]
            try:
                scmr.hRStartServiceW(dce2, svc_h)
                log_fn("info", "SCM: bat launched")
            except Exception as se:
                se_s = str(se)
                if "41d" in se_s.lower():
                    log_fn("info", "SCM: bat running (cmd timeout expected)")
                elif "1056" in se_s:
                    log_fn("info", "SCM: bat already running")
                else:
                    log_fn("error", f"SCM start failed: {se}")
            launched = True
            log_fn("info", f"Waiting {wait_secs} s for bat to complete …")
            # Wait in 30-second chunks, pinging the SMB server to keep the session alive.
            # Do NOT send SERVICE_CONTROL_STOP — that would kill the bat process.
            elapsed = 0
            while elapsed < wait_secs:
                chunk = min(30, wait_secs - elapsed)
                time.sleep(chunk)
                elapsed += chunk
                try:
                    smb.listShares()  # keepalive
                except Exception:
                    pass
            # Only delete (mark for deletion) — do not stop, so the bat process finishes
            try:
                scmr.hRDeleteService(dce2, svc_h)
            except Exception:
                pass
            scmr.hRCloseServiceHandle(dce2, svc_h)
            scmr.hRCloseServiceHandle(dce2, scm_h)
            dce2.disconnect()
        except Exception as scm_err:
            log_fn("error", f"SCM execution failed: {scm_err}")

    return launched


def _smb_deploy(target: dict, server_url: str, secret: str) -> List[dict]:
    """
    Deploy via SMB: copy agent EXE + config directly, register service via bat file.
    No MSI dependency — works on Windows XP / 2003 / 2008 / 2008 R2 and all newer.
    """
    import io
    import json as _json
    import os
    import time
    import traceback
    import urllib.request
    from impacket.smbconnection import SMBConnection
    from impacket.dcerpc.v5 import transport as imp_transport, tsch, scmr
    from impacket.dcerpc.v5.dtypes import NULL

    logs = []
    def log(level, msg): logs.append({"level": level, "msg": msg})

    log("info", f"SMB deploy init: target={target.get('ip')} os={target.get('os')}")

    try:
        _run_smb_deploy(target, server_url, secret, log, SMBConnection,
                        imp_transport, tsch, scmr, NULL, io, _json, os, time)
    except Exception as _outer:
        log("error", f"Unhandled: {_outer}")
        log("error", traceback.format_exc())

    return logs


def _run_smb_deploy(target, server_url, secret, log,
                    SMBConnection, imp_transport, tsch, scmr, NULL,
                    io, _json, os, time):
    import urllib.request as urllib_request
    import urllib.error
    ip       = target["ip"]
    username = target["username"]
    password = target["password"]
    domain   = target.get("domain", "") or "."

    log_path   = r"C:\Windows\Temp\kifaa-deploy.log"
    log_remote = r"Windows\Temp\kifaa-deploy.log"

    def _smb_connect(port=445):
        """Connect and authenticate; returns SMBConnection or raises."""
        # Force SMBv1 dialect on port 139 (NetBIOS / legacy Windows 2008)
        if port == 139:
            from impacket import smb as _smb_mod
            conn = SMBConnection(ip, ip, timeout=30, sess_port=port,
                                 preferredDialect=_smb_mod.SMB_DIALECT)
        else:
            conn = SMBConnection(ip, ip, timeout=30, sess_port=port)
        conn.login(username, password, domain)
        return conn

    # ── Connect via SMB — try 445 (SMB2/3), fall back to 139 (SMB1/NetBIOS) ──
    log("info", f"Connecting to \\\\{ip} via SMB …")
    smb = None
    smb_port = 445
    for port in [445, 139]:
        try:
            smb = _smb_connect(port)
            smb_port = port
            log("info", f"SMB authenticated (port {port})")
            break
        except Exception as e:
            smb = None
            last_err = e
    if smb is None:
        log("error", f"SMB login failed: {last_err}")
        return

    def _reconnect_smb():
        """Re-establish the SMB session (needed after large SMB1 transfers)."""
        nonlocal smb
        try:
            smb.logoff()
        except Exception:
            pass
        smb = _smb_connect(smb_port)

    # ── Detect architecture ──────────────────────────────────────────────
    arch = _smb_detect_arch(smb)
    log("info", f"Detected architecture: {arch}")

    # ── Detect OS — use legacy Go 1.20 binary for Windows 2008 R2 / Win7 ──
    # Go 1.22+ binaries silently exit (code 2) on Windows 2008 R2 / Windows 7
    # because the Go runtime performs an OS version check before main() runs.
    # The legacy binary is built with Go 1.20 and -tags noad (no LDAP).
    server_os = smb.getServerOS() or ""
    is_legacy_os = (
        "2008" in server_os
        or "Windows 7" in server_os
        or "Build 7600" in server_os
        or "Build 7601" in server_os
    )
    if is_legacy_os:
        log("info", f"Legacy OS detected ({server_os}) — using Go 1.20 binary")
        agent_filename = f"kifaa-agent-windows-{arch}-legacy.exe"
    else:
        agent_filename = f"kifaa-agent-windows-{arch}.exe"
    agent_server_url = server_url

    # ── Locate agent EXE from local builds directory ─────────────────────
    local_builds = "/app/static/agent-builds"
    local_src = os.path.join(local_builds, agent_filename)
    local_tmp = f"/tmp/kifaa-agent-{ip.replace('.', '_')}-{arch}.exe"

    log("info", f"Copying {agent_filename} from local builds …")
    try:
        import shutil as _shutil
        _shutil.copy2(local_src, local_tmp)
        log("info", f"Agent EXE ready ({os.path.getsize(local_tmp):,} bytes)")
    except Exception as e:
        log("error", f"Failed to read agent binary: {e}")
        smb.logoff()
        return

    # ── Copy agent EXE to C:\Windows\Temp\ ──────────────────────────────
    remote_exe_rel  = r"Windows\Temp\kifaa-agent.exe"
    remote_exe_path = r"C:\Windows\Temp\kifaa-agent.exe"
    log("info", f"Copying agent to \\\\{ip}\\C$\\{remote_exe_rel} …")
    try:
        with open(local_tmp, "rb") as fh:
            smb.putFile("C$", remote_exe_rel, fh.read)
        log("info", "Agent EXE copied")
    except Exception as e:
        log("error", f"File copy failed: {e}")
        smb.logoff()
        return

    # SMBv1 sessions (port 139) commonly drop after large transfers — reconnect.
    # SMBv2/3 (port 445) sessions are stable; skip the reconnect to avoid disruption.
    if smb_port == 139:
        try:
            _reconnect_smb()
            log("info", "SMB session refreshed (SMBv1)")
        except Exception as e:
            log("error", f"SMB reconnect failed: {e}")
            return

    # ── Detect if the server uses a self-signed / untrusted certificate ──
    # Always skip TLS verification for self-signed certs (legacy OS always skips too).
    _skip_tls = is_legacy_os
    if not _skip_tls and agent_server_url.startswith("https://"):
        import ssl, urllib.request as _urlreq
        try:
            _urlreq.urlopen(agent_server_url.rstrip("/") + "/api/v1/health", timeout=5)
        except urllib.error.URLError as _te:
            if "certificate" in str(_te).lower() or "ssl" in str(_te).lower():
                _skip_tls = True
                log("info", "Self-signed certificate detected — enabling insecure_skip_verify")
        except Exception:
            pass

    # ── Write config.json to C:\Windows\Temp\ ───────────────────────────
    cfg = {
        "server_url": agent_server_url,
        "registration_secret": secret,
        "heartbeat_interval_seconds": 30,
        "inventory_interval_seconds": 3600,
        "insecure_skip_verify": _skip_tls,
    }
    cfg_bytes  = _json.dumps(cfg, indent=2).encode("utf-8")
    cfg_rel    = r"Windows\Temp\kifaa-config.json"
    try:
        _smb_write(smb, cfg_rel, cfg_bytes, log)
        log("info", "Config written")
    except Exception as e:
        log("error", f"Config write failed: {e}")
        smb.logoff()
        return

    install_dir   = r"C:\Program Files\KifaaAgent"
    config_dir    = r"C:\ProgramData\KifaaAgent"
    agent_dest    = fr"{install_dir}\kifaa-agent.exe"
    config_dest   = fr"{config_dir}\config.json"
    uninstall_key = r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\KifaaAgent"
    svc_key       = r"HKLM\SYSTEM\CurrentControlSet\Services\KifaaAgent"

    # ── Write uninstall.bat to Temp (deployed to install dir by the bat) ──
    uninstall_bat = "\r\n".join([
        "@echo off",
        "echo Stopping KifaaAgent service...",
        "sc stop KifaaAgent 2>NUL",
        "timeout /t 3 /nobreak >NUL",
        "echo Removing KifaaAgent service...",
        "sc delete KifaaAgent 2>NUL",
        "echo Killing agent process...",
        "taskkill /f /im kifaa-agent.exe 2>NUL",
        "timeout /t 2 /nobreak >NUL",
        "echo Removing files...",
        "cd /d C:\\",
        f'rd /s /q "{install_dir}" 2>NUL',
        f'rd /s /q "{config_dir}" 2>NUL',
        "echo Removing registry entries...",
        f'reg delete "{uninstall_key}" /f 2>NUL',
        f'reg delete "{svc_key}" /f 2>NUL',
        "echo Kifaa Agent has been removed.",
        "",
    ])
    try:
        _smb_write(smb, r"Windows\Temp\kifaa-uninstall.bat",
                   uninstall_bat.encode("ascii"), log)
    except Exception as e:
        log("info", f"Uninstall bat write: {e}")

    # ── Stop / delete existing KifaaAgent service via SCM BEFORE the bat ──
    # This avoids the SCM database lock that would deadlock sc.exe inside the bat.
    log("info", "Stopping existing KifaaAgent service (if any) …")
    try:
        rpct_pre = imp_transport.SMBTransport(ip, filename=r"\svcctl", smb_connection=smb)
        dce_pre  = rpct_pre.get_dce_rpc()
        dce_pre.connect()
        dce_pre.bind(scmr.MSRPC_UUID_SCMR)
        scm_pre  = scmr.hROpenSCManagerW(dce_pre)["lpScHandle"]
        try:
            ka_pre = scmr.hROpenServiceW(dce_pre, scm_pre, "KifaaAgent")["lpServiceHandle"]
            try:
                scmr.hRControlService(dce_pre, ka_pre, scmr.SERVICE_CONTROL_STOP)
                time.sleep(3)
            except Exception:
                pass
            scmr.hRDeleteService(dce_pre, ka_pre)
            scmr.hRCloseServiceHandle(dce_pre, ka_pre)
            log("info", "Old KifaaAgent service removed")
        except Exception:
            pass  # service didn't exist — that's fine
        scmr.hRCloseServiceHandle(dce_pre, scm_pre)
        dce_pre.disconnect()
    except Exception as e:
        log("info", f"Pre-stop SCM: {e}")
    time.sleep(2)  # let SCM release the lock

    # ── Write deploy bat (file ops + registry only — NO sc commands) ──────
    bat_content = "\r\n".join([
        "@echo off",
        f"echo [1] Creating directories > {log_path}",
        f'mkdir "{install_dir}" 2>NUL',
        f'mkdir "{config_dir}" 2>NUL',
        # Add Defender exclusion BEFORE writing the binary so real-time protection
        # does not quarantine the agent exe the moment it lands on disk.
        f"echo [1b] Adding Defender exclusion >> {log_path}",
        f'powershell -NoProfile -NonInteractive -Command "Add-MpPreference -ExclusionPath \'{install_dir}\' -ErrorAction SilentlyContinue" >> {log_path} 2>&1',
        f'powershell -NoProfile -NonInteractive -Command "Add-MpPreference -ExclusionProcess \'kifaa-agent.exe\' -ErrorAction SilentlyContinue" >> {log_path} 2>&1',
        f"echo [1b-done] >> {log_path}",
        f"echo [2] Killing old agent process >> {log_path}",
        f"taskkill /f /im kifaa-agent.exe >> {log_path} 2>&1",
        # WMI delete clears ghost SCM entries stuck in "marked for delete" state.
        # This is needed on re-installs on Windows 2008 R2 / Win7 where the SCM
        # holds a stale in-memory entry that blocks hRCreateServiceW.
        f'wmic service where "name=\'KifaaAgent\'" delete 2>NUL',
        f"ping -n 4 127.0.0.1 > NUL",
        f"echo [3] Copying agent >> {log_path}",
        f'copy /Y "{remote_exe_path}" "{agent_dest}" >> {log_path} 2>&1',
        f"echo [4] Copying config >> {log_path}",
        f'copy /Y "C:\\Windows\\Temp\\kifaa-config.json" "{config_dest}" >> {log_path} 2>&1',
        f"echo [5] Adding Programs and Features entry >> {log_path}",
        f'reg add "{uninstall_key}" /v DisplayName /t REG_SZ /d "Kifaa Agent" /f >> {log_path} 2>&1',
        f'reg add "{uninstall_key}" /v DisplayVersion /t REG_SZ /d "1.4.4" /f >> {log_path} 2>&1',
        f'reg add "{uninstall_key}" /v Publisher /t REG_SZ /d "Kifaa" /f >> {log_path} 2>&1',
        f'reg add "{uninstall_key}" /v InstallLocation /t REG_SZ /d "{install_dir}" /f >> {log_path} 2>&1',
        f'copy /Y "C:\\Windows\\Temp\\kifaa-uninstall.bat" "{install_dir}\\uninstall.bat"',
        f'reg add "{uninstall_key}" /v UninstallString /t REG_SZ /d "cmd.exe /c \\"{install_dir}\\uninstall.bat\\"" /f >> {log_path} 2>&1',
        f'reg add "{uninstall_key}" /v NoModify /t REG_DWORD /d 1 /f >> {log_path} 2>&1',
        f'reg add "{uninstall_key}" /v NoRepair /t REG_DWORD /d 1 /f >> {log_path} 2>&1',
        # Register the agent (gets agent_id + api_key → config.json).
        # Must run BEFORE service start so the agent has credentials on first heartbeat.
        f"echo [6] Registering agent >> {log_path}",
        f'"{agent_dest}" --register --server {agent_server_url} --secret {secret} >> {log_path} 2>&1',
        f"echo [6-done] >> {log_path}",
        # On legacy OS (Win 2008 R2 / Win7), --register may overwrite the config and drop
        # insecure_skip_verify. Patch it back in using PowerShell so TLS is skipped.
        *(
            [
                f"echo [6b] Patching insecure_skip_verify >> {log_path}",
                f'powershell -NoProfile -NonInteractive -Command "'
                f'$c = Get-Content \\\"{config_dest}\\\" -Raw | ConvertFrom-Json; '
                f'$c | Add-Member -Force -NotePropertyName insecure_skip_verify -NotePropertyValue $true; '
                f'$c | ConvertTo-Json -Depth 5 | Set-Content \\\"{config_dest}\\\"" >> {log_path} 2>&1',
                f"echo [6b-done] >> {log_path}",
            ] if is_legacy_os else []
        ),
        f"echo [done] >> {log_path}",
        "",
    ])
    bat_remote = r"Windows\Temp\kifaa-deploy.bat"
    bat_path   = r"C:\Windows\Temp\kifaa-deploy.bat"
    try:
        _smb_write(smb, bat_remote, bat_content.encode("ascii"), log)
        log("info", "Deploy bat written")
    except Exception as e:
        log("error", f"Bat write failed: {e}")
        smb.logoff()
        return

    # ── Execute bat (Task Scheduler → SCM fallback) ──────────────────────
    # Bat is now fast (~10-15 s): no sc commands, no blocking waits.
    _smb_run_bat(smb, ip, username, password, domain, bat_path,
                 60, log, imp_transport, tsch, scmr, NULL, time)

    # Reconnect after wait — the session may have died on SMBv1
    try:
        _reconnect_smb()
        log("info", "SMB session refreshed")
    except Exception:
        pass

    # ── Read deploy log ──────────────────────────────────────────────────
    try:
        buf = io.BytesIO()
        smb.getFile("C$", log_remote, buf.write)
        deploy_log = buf.getvalue().decode("utf-8", errors="replace").strip()
        if deploy_log:
            for line in deploy_log.splitlines():
                line = line.strip()
                if line:
                    log("info", f"  deploy.log: {line}")
        else:
            log("info", "  deploy.log: (empty — bat may not have run)")
    except Exception as log_err:
        log("info", f"  deploy.log: not readable ({log_err})")

    # ── Create KifaaAgent service via SCM (no sc.exe, no SCM lock conflict) ─
    log("info", "Creating KifaaAgent service …")
    try:
        rpct_c = imp_transport.SMBTransport(ip, filename=r"\svcctl", smb_connection=smb)
        dce_c  = rpct_c.get_dce_rpc()
        dce_c.connect()
        dce_c.bind(scmr.MSRPC_UUID_SCMR)
        scm_c  = scmr.hROpenSCManagerW(dce_c)["lpScHandle"]
        # Clean up stale service if it snuck back in
        try:
            stale_h = scmr.hROpenServiceW(dce_c, scm_c, "KifaaAgent")["lpServiceHandle"]
            scmr.hRDeleteService(dce_c, stale_h)
            scmr.hRCloseServiceHandle(dce_c, stale_h)
        except Exception:
            pass
        scmr.hRCreateServiceW(
            dce_c, scm_c,
            "KifaaAgent", "Kifaa Agent",
            lpBinaryPathName=agent_dest,
            dwStartType=scmr.SERVICE_AUTO_START,
            dwErrorControl=scmr.SERVICE_ERROR_NORMAL,
        )
        log("info", "KifaaAgent service created")
        scmr.hRCloseServiceHandle(dce_c, scm_c)
        dce_c.disconnect()
    except Exception as e:
        log("info", f"Service create: {e}")

    # ── Start KifaaAgent service ─────────────────────────────────────────
    log("info", "Starting KifaaAgent service …")
    time.sleep(2)
    try:
        rpct_v = imp_transport.SMBTransport(ip, filename=r"\svcctl", smb_connection=smb)
        dce_v  = rpct_v.get_dce_rpc()
        dce_v.connect()
        dce_v.bind(scmr.MSRPC_UUID_SCMR)
        scm_v  = scmr.hROpenSCManagerW(dce_v)["lpScHandle"]
        try:
            ka = scmr.hROpenServiceW(dce_v, scm_v, "KifaaAgent")["lpServiceHandle"]
            # Start the service
            try:
                scmr.hRStartServiceW(dce_v, ka)
            except Exception as se:
                se_s = str(se)
                if "41d" in se_s.lower() or "1053" in se_s:
                    log("info", "Service start timeout — binary initialising …")
                elif "1056" in se_s:
                    log("info", "Service already running")
                else:
                    log("info", f"Start: {se}")
            # Check state after a brief wait
            time.sleep(8)
            st = scmr.hRQueryServiceStatus(dce_v, ka)
            state_code = st["lpServiceStatus"]["dwCurrentState"]
            state = {1: "stopped", 2: "starting", 3: "stopping", 4: "running"}.get(
                state_code, "unknown"
            )
            if state_code in (2, 4):
                log("success", f"KifaaAgent service running — state: {state}")
            else:
                log("info", f"KifaaAgent service state: {state}")
                log("error", "Service not running — binary may be incompatible with this OS version")
            scmr.hRCloseServiceHandle(dce_v, ka)
        except Exception:
            log("error", "KifaaAgent service not found after creation")
        scmr.hRCloseServiceHandle(dce_v, scm_v)
        dce_v.disconnect()
    except Exception as e:
        log("error", f"SCM verify failed: {e}")

    # ── Verify credentials in config; inject server-side if --register failed ─
    # --register runs inside the bat (as SYSTEM via Task Scheduler).  It can fail
    # silently on any OS if TLS verification fails, routing blocks the call, or
    # the bat execution timed out.  Always read the config back and inject
    # credentials if the api_key is missing — never rely solely on --register.
    try:
        _reconnect_smb()
        buf2 = io.BytesIO()
        smb.getFile("C$", r"ProgramData\KifaaAgent\config.json", buf2.write)
        cfg_readback = _json.loads(buf2.getvalue().decode("utf-8-sig", errors="replace"))
        if not cfg_readback.get("api_key"):
            log("info", "api_key absent in config — performing server-side registration …")
            import urllib.request as _urllib_req
            from api.config import get_settings as _get_settings
            _reg_secret = _get_settings().agent_registration_secret
            reg_payload = _json.dumps({
                "registration_secret": _reg_secret,
                "hostname": ip,  # agent updates hostname on first heartbeat
                "ip_address": ip,
                "os_type": "windows",
                "os_name": server_os or "Windows Server",
                "os_version": "",
                "os_arch": arch,
                "agent_version": CURRENT_AGENT_VERSION,
                "agent_type": "modern",
            }).encode("utf-8")
            req = _urllib_req.Request(
                "http://localhost:8000/api/v1/agents/register",
                data=reg_payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with _urllib_req.urlopen(req, timeout=10) as resp:
                reg_resp = _json.loads(resp.read())
            agent_id_new = reg_resp["agent_id"]
            api_key_new  = reg_resp["api_key"]
            # Write complete config with credentials
            full_cfg = {
                "server_url": agent_server_url,
                "agent_id": agent_id_new,
                "api_key": api_key_new,
                "heartbeat_interval_seconds": 30,
                "inventory_interval_seconds": 3600,
                "insecure_skip_verify": _skip_tls,
            }
            _smb_write(smb, r"ProgramData\KifaaAgent\config.json",
                       _json.dumps(full_cfg, indent=2).encode("utf-8"), log)
            log("info", f"Credentials injected (agent_id={agent_id_new[:8]}…)")
            # Restart service to pick up new config
            try:
                rpct_r = imp_transport.SMBTransport(ip, filename=r"\svcctl", smb_connection=smb)
                dce_r  = rpct_r.get_dce_rpc()
                dce_r.connect()
                dce_r.bind(scmr.MSRPC_UUID_SCMR)
                scm_r  = scmr.hROpenSCManagerW(dce_r)["lpScHandle"]
                ka_r   = scmr.hROpenServiceW(dce_r, scm_r, "KifaaAgent")["lpServiceHandle"]
                try:
                    scmr.hRControlService(dce_r, ka_r, scmr.SERVICE_CONTROL_STOP)
                    time.sleep(3)
                except Exception:
                    pass
                scmr.hRStartServiceW(dce_r, ka_r)
                log("info", "KifaaAgent service restarted with injected credentials")
                scmr.hRCloseServiceHandle(dce_r, ka_r)
                scmr.hRCloseServiceHandle(dce_r, scm_r)
                dce_r.disconnect()
            except Exception as rs_err:
                log("info", f"Service restart: {rs_err}")
        else:
            log("info", f"Agent credentials verified in config (agent_id={cfg_readback.get('agent_id','?')[:8]}…)")
    except Exception as inj_err:
        log("info", f"Credential check skipped: {inj_err}")

    try:
        smb.logoff()
    except Exception:
        pass
    try:
        os.remove(local_tmp)
    except Exception:
        pass


def _winrm_deploy(target: dict, server_url: str, secret: str) -> List[dict]:
    import winrm  # lazy import — pywinrm is optional dependency

    logs = []

    def log(level, msg):
        logs.append({"level": level, "msg": msg})

    ip = target["ip"]
    username = target["username"]
    password = target["password"]
    domain = target.get("domain", "")
    port = target.get("port", 5985)

    full_user = f"{domain}\\{username}" if domain else username

    try:
        protocol = winrm.Protocol(
            endpoint=f"http://{ip}:{port}/wsman",
            transport="ntlm" if domain else "basic",
            username=full_user,
            password=password,
            operation_timeout_sec=30,
            read_timeout_sec=60,
        )
        shell_id = protocol.open_shell()
    except Exception as e:
        log("error", f"WinRM connect failed: {e}")
        return logs

    def run_cmd(cmd, label=None):
        log("info", f"> {label or cmd[:100]}")
        try:
            cmd_id = protocol.run_command(shell_id, cmd)
            stdout, stderr, rc = protocol.get_command_output(shell_id, cmd_id)
            protocol.cleanup_command(shell_id, cmd_id)
            out = stdout.decode(errors="replace").strip()
            err = stderr.decode(errors="replace").strip()
            if out:
                log("info", out)
            if err:
                # stderr on Windows often has warnings even on success — only flag non-zero exit
                log("info" if rc == 0 else "error", err)
            if rc not in (0, 3010):  # 3010 = success + reboot required
                log("error", f"Exited with code {rc}")
            return rc
        except Exception as e:
            log("error", f"Command failed: {e}")
            return -1

    # 1. Create working directory
    run_cmd('cmd /c mkdir "C:\\Windows\\Temp\\KifaaDeploy" 2>nul || exit 0', "Create temp dir")

    # 2. Download installer via bitsadmin (available on all Windows Vista+)
    #    Fallback: certutil (also universal)
    dl_url = f"{server_url}/downloads/kifaa-installer-amd64.exe"
    dest = "C:\\Windows\\Temp\\KifaaDeploy\\kifaa-installer.exe"
    rc = run_cmd(
        f'bitsadmin /transfer KifaaInstall /download /priority FOREGROUND "{dl_url}" "{dest}"',
        f"Download installer from {server_url}"
    )
    if rc != 0:
        # bitsadmin failed, try certutil
        log("info", "bitsadmin failed, trying certutil…")
        run_cmd(
            f'certutil -urlcache -split -f "{dl_url}" "{dest}"',
            "Download via certutil"
        )

    # 3. Run installer silently — plain EXE, no PowerShell needed
    run_cmd(
        f'"{dest}" --silent --server {server_url} --secret {secret}',
        "Run installer (silent)"
    )

    # 4. Verify service registered
    run_cmd("sc query KifaaAgent", "Verify KifaaAgent service")

    try:
        protocol.close_shell(shell_id)
    except Exception:
        pass

    return logs


@router.websocket("/deploy")
async def deploy_ws(websocket: WebSocket, token: str = Query(...)):
    await websocket.accept()

    if not decode_token(token):
        await websocket.send_json({"type": "error", "msg": "Unauthorized"})
        await websocket.close()
        return

    try:
        data = await websocket.receive_json()
    except Exception:
        await websocket.send_json({"type": "error", "msg": "Invalid message"})
        await websocket.close()
        return

    targets = data.get("targets", [])
    server_url = data.get("server_url", "")
    secret = data.get("secret", "")
    force = data.get("force", False)  # bypass version check / force reinstall

    if not targets or not server_url or not secret:
        await websocket.send_json({"type": "error", "msg": "Missing targets, server_url, or secret"})
        await websocket.close()
        return

    loop = asyncio.get_event_loop()
    succeeded = 0
    failed = 0
    skipped = 0

    for target in targets:
        ip = target.get("ip", "unknown")
        os_type = target.get("os", "unknown")

        # ── Check if agent already registered and up-to-date ─────────────
        if not force:
            try:
                async with AsyncSessionLocal() as db:
                    row = await db.execute(
                        text("SELECT agent_version, hostname, status FROM agents WHERE ip_address = :ip LIMIT 1"),
                        {"ip": ip}
                    )
                    existing = row.fetchone()
                # Only skip if agent is online AND already on current version
                agent_online = existing and existing.status == 'online'
                if existing and existing.agent_version == CURRENT_AGENT_VERSION and agent_online:
                    await websocket.send_json({
                        "type": "log", "target": ip, "level": "skip",
                        "msg": f"Already on latest version ({CURRENT_AGENT_VERSION}) and online — skipping"
                    })
                    await websocket.send_json({"type": "target_done", "target": ip, "success": True, "skipped": True})
                    skipped += 1
                    succeeded += 1
                    continue
                elif existing:
                    status_note = " (offline — forcing redeploy)" if not agent_online else ""
                    await websocket.send_json({
                        "type": "log", "target": ip, "level": "info",
                        "msg": f"Upgrading from v{existing.agent_version} → v{CURRENT_AGENT_VERSION}{status_note}"
                    })
            except Exception:
                pass  # DB check failure is non-fatal — proceed with deploy
        else:
            await websocket.send_json({
                "type": "log", "target": ip, "level": "info",
                "msg": "Force reinstall requested — bypassing version check"
            })

        await websocket.send_json({"type": "log", "target": ip, "level": "info", "msg": f"Starting deployment ({os_type})"})

        success = False
        try:
            if os_type == "linux":
                logs = await loop.run_in_executor(None, lambda t=target: _ssh_deploy(t, server_url, secret))
            elif os_type == "windows":
                # Prefer SMB+SCM (no WinRM needed); fall back to WinRM if SMB fails
                logs = await loop.run_in_executor(None, lambda t=target: _smb_deploy(t, server_url, secret))
                # Only fall back to WinRM when SMB authentication itself failed (no success at all)
                smb_auth_failed = any(
                    e["level"] == "error" and "SMB login failed" in e["msg"] for e in logs
                )
                if smb_auth_failed:
                    await websocket.send_json({"type": "log", "target": ip, "level": "info", "msg": "SMB auth failed, retrying via WinRM …"})
                    logs2 = await loop.run_in_executor(None, lambda t=target: _winrm_deploy(t, server_url, secret))
                    logs = logs + logs2
            else:
                logs = [{"level": "error", "msg": f"Unsupported OS type: {os_type}"}]

            has_error = False
            has_success = False
            for entry in logs:
                await websocket.send_json({"type": "log", "target": ip, "level": entry["level"], "msg": entry["msg"]})
                if entry["level"] == "error":
                    has_error = True
                if entry["level"] == "success":
                    has_success = True

            # Succeeded if there's an explicit success log and no errors,
            # OR if the only errors were non-fatal SCM messages
            success = has_success and not has_error
        except Exception as e:
            await websocket.send_json({"type": "log", "target": ip, "level": "error", "msg": f"Deployment exception: {e}"})
            success = False

        if success:
            succeeded += 1
        else:
            failed += 1

        await websocket.send_json({"type": "target_done", "target": ip, "success": success})

    await websocket.send_json({"type": "complete", "succeeded": succeeded, "failed": failed, "skipped": skipped})
    await websocket.close()


# ─────────────────────────────────────────────────────────────────────────────
# Remove Agent WebSocket endpoint
# ─────────────────────────────────────────────────────────────────────────────

def _smb_remove(target: dict, log) -> List[dict]:
    """Stop service, delete files/registry, remove agent from local system via SMB."""
    try:
        from impacket.smbconnection import SMBConnection
        from impacket.dcerpc.v5 import transport as imp_transport, scmr
    except ImportError:
        log("error", "impacket not available")
        return []

    ip       = target["ip"]
    username = target["username"]
    password = target["password"]
    domain   = target.get("domain", "") or "."

    install_dir   = r"C:\Program Files\KifaaAgent"
    config_dir    = r"C:\ProgramData\KifaaAgent"
    uninstall_key = r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\KifaaAgent"
    svc_key       = r"HKLM\SYSTEM\CurrentControlSet\Services\KifaaAgent"
    log_path      = r"C:\Windows\Temp\kifaa-remove.log"

    import time, io

    # Connect SMB
    log("info", f"Connecting to \\\\{ip} …")
    try:
        smb = SMBConnection(ip, ip, timeout=30, sess_port=445)
        smb.login(username, password, domain)
        log("info", "SMB authenticated")
    except Exception as e:
        # Try SMBv1
        try:
            from impacket import smb as _smb_mod
            smb = SMBConnection(ip, ip, timeout=30, sess_port=139,
                                preferredDialect=_smb_mod.SMB_DIALECT)
            smb.login(username, password, domain)
            log("info", "SMB authenticated (SMBv1)")
        except Exception as e2:
            log("error", f"SMB login failed: {e2}")
            return []

    # Stop + delete service via SCM
    log("info", "Stopping KifaaAgent service …")
    try:
        rpct = imp_transport.SMBTransport(ip, filename=r"\svcctl")
        rpct.set_credentials(username, password, domain, "", "", None)
        dce = rpct.get_dce_rpc(); dce.connect(); dce.bind(scmr.MSRPC_UUID_SCMR)
        scm = scmr.hROpenSCManagerW(dce)["lpScHandle"]
        try:
            h = scmr.hROpenServiceW(dce, scm, "KifaaAgent")["lpServiceHandle"]
            try:
                scmr.hRControlService(dce, h, scmr.SERVICE_CONTROL_STOP)
                log("info", "Service stopped")
            except Exception:
                pass
            time.sleep(3)
            scmr.hRDeleteService(dce, h)
            scmr.hRCloseServiceHandle(dce, h)
            log("info", "Service removed from SCM")
        except Exception:
            log("info", "Service not found in SCM")
        scmr.hRCloseServiceHandle(dce, scm)
        dce.disconnect()
    except Exception as e:
        log("info", f"SCM: {e}")

    # Run removal bat via SCM bootstrap
    remove_bat = "\r\n".join([
        "@echo off",
        f"echo Removing KifaaAgent > {log_path}",
        "taskkill /f /im kifaa-agent.exe >> " + log_path + " 2>&1",
        'wmic service where "name=\'KifaaAgent\'" delete 2>NUL',
        "ping -n 4 127.0.0.1 >NUL",
        "cd /d C:\\",
        f'rd /s /q "{install_dir}" >> {log_path} 2>&1',
        f'rd /s /q "{config_dir}" >> {log_path} 2>&1',
        f'reg delete "{uninstall_key}" /f >> {log_path} 2>&1',
        f'reg delete "{svc_key}" /f >> {log_path} 2>&1',
        f"echo [done] >> {log_path}",
        "",
    ])
    try:
        bat_bytes = remove_bat.encode("ascii")
        o = [0]
        def _rb(n): chunk = bat_bytes[o[0]:o[0]+n]; o[0] += n; return chunk
        smb.putFile("C$", r"Windows\Temp\kifaa-remove.bat", _rb)

        _smb_run_bat(smb, ip, username, password, domain,
                     r"C:\Windows\Temp\kifaa-remove.bat",
                     60, log, imp_transport,
                     __import__("impacket.dcerpc.v5.tsch", fromlist=["tsch"]),
                     scmr, None, time)
        time.sleep(3)

        # Read remove log
        try:
            buf = io.BytesIO()
            smb.getFile("C$", r"Windows\Temp\kifaa-remove.log", buf.write)
            for line in buf.getvalue().decode("utf-8", errors="replace").splitlines():
                if line.strip():
                    log("info", f"  {line.strip()}")
        except Exception:
            pass

        log("success", f"KifaaAgent removed from {ip}")
    except Exception as e:
        log("error", f"Removal bat failed: {e}")
    finally:
        try: smb.logoff()
        except Exception: pass

    return []


def _ssh_remove(target: dict, log) -> List[dict]:
    """Remove agent from Linux host via SSH."""
    ip       = target["ip"]
    username = target["username"]
    password = target.get("password", "")
    key_path = target.get("key_path", "")
    port     = int(target.get("port", 22))

    log("info", f"Connecting to {ip}:{port} via SSH …")
    import paramiko as _pm
    ssh = _pm.SSHClient()
    ssh.set_missing_host_key_policy(_pm.AutoAddPolicy())
    try:
        if key_path:
            ssh.connect(ip, port=port, username=username, key_filename=key_path, timeout=15)
        else:
            ssh.connect(ip, port=port, username=username, password=password, timeout=15)
        log("info", "SSH connected")
    except Exception as e:
        log("error", f"SSH connection failed: {e}")
        return []

    def run(cmd):
        _, stdout, stderr = ssh.exec_command(cmd, timeout=30)
        out = stdout.read().decode(errors="replace").strip()
        err = stderr.read().decode(errors="replace").strip()
        return out, err

    log("info", "Stopping kifaa-agent service …")
    run("systemctl stop kifaa-agent 2>/dev/null || true")
    run("systemctl disable kifaa-agent 2>/dev/null || true")
    run("pkill -f kifaa-agent 2>/dev/null || true")

    log("info", "Removing files …")
    run("rm -f /etc/systemd/system/kifaa-agent.service")
    run("systemctl daemon-reload 2>/dev/null || true")
    run("rm -rf /opt/kifaa-agent /opt/kifaa/agent/builds/kifaa-agent-linux-amd64 2>/dev/null || true")
    run("rm -f /etc/kifaa-agent/config.json 2>/dev/null || true")
    run("rm -rf /etc/kifaa-agent 2>/dev/null || true")

    ssh.close()
    log("success", f"KifaaAgent removed from {ip}")
    return []


@router.websocket("/remove")
async def remove_ws(websocket: WebSocket, token: str = Query(...)):
    await websocket.accept()

    if not decode_token(token):
        await websocket.send_json({"type": "error", "msg": "Unauthorized"})
        await websocket.close()
        return

    try:
        data = await websocket.receive_json()
    except Exception:
        await websocket.send_json({"type": "error", "msg": "Invalid message"})
        await websocket.close()
        return

    targets = data.get("targets", [])
    if not targets:
        await websocket.send_json({"type": "error", "msg": "No targets provided"})
        await websocket.close()
        return

    delete_from_db = data.get("delete_from_db", True)
    loop = asyncio.get_event_loop()
    succeeded = 0
    failed = 0

    for target in targets:
        ip      = target.get("ip", "unknown")
        os_type = target.get("os", "windows")

        await websocket.send_json({"type": "log", "target": ip, "level": "info",
                                   "msg": f"Starting removal ({os_type})"})

        logs_list = []

        def log(level, msg, _ip=ip):
            logs_list.append({"level": level, "msg": msg})

        success = False
        try:
            if os_type == "linux":
                await loop.run_in_executor(None, lambda t=target: _ssh_remove(t, log))
            else:
                await loop.run_in_executor(None, lambda t=target: _smb_remove(t, log))

            for entry in logs_list:
                await websocket.send_json({
                    "type": "log", "target": ip,
                    "level": entry["level"], "msg": entry["msg"],
                })

            success = any(e["level"] == "success" for e in logs_list)
        except Exception as e:
            await websocket.send_json({"type": "log", "target": ip, "level": "error",
                                       "msg": f"Exception: {e}"})

        # Delete agent from DB if removal succeeded or if explicitly requested
        if delete_from_db:
            try:
                async with AsyncSessionLocal() as db:
                    await db.execute(
                        text("UPDATE agents SET is_active = FALSE, status = 'removed' WHERE ip_address = :ip"),
                        {"ip": ip},
                    )
                    await db.commit()
                await websocket.send_json({
                    "type": "log", "target": ip, "level": "info",
                    "msg": "Agent record marked as removed in dashboard",
                })
            except Exception as e:
                await websocket.send_json({
                    "type": "log", "target": ip, "level": "info",
                    "msg": f"DB update: {e}",
                })

        if success:
            succeeded += 1
        else:
            failed += 1

        await websocket.send_json({"type": "target_done", "target": ip, "success": success})

    await websocket.send_json({"type": "complete", "succeeded": succeeded, "failed": failed})
    await websocket.close()
