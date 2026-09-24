import asyncio
import threading
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from api.database import get_db, AsyncSessionLocal
from api.models.models import DeploymentJob, DeployCredential
from api.services.auth import get_current_user, require_admin
from api.config import get_settings

router = APIRouter(prefix="/deployment", tags=["Deployment"])
settings = get_settings()


# ── API Reachability Check ─────────────────────────────────────────────────────

@router.get("/api-check")
async def api_check(_=Depends(get_current_user)):
    """Return the server URL agents will use to register, and confirm the API is reachable."""
    import httpx, time
    server_url = f"http://{settings.server_ip}"
    health_url  = f"{server_url}/api/health"
    start = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(health_url)
        latency_ms = int((time.monotonic() - start) * 1000)
        reachable = r.status_code == 200
        detail = r.json() if reachable else {"status": f"HTTP {r.status_code}"}
    except Exception as exc:
        latency_ms = int((time.monotonic() - start) * 1000)
        reachable = False
        detail = {"error": str(exc)}
    return {
        "server_url": server_url,
        "health_url": health_url,
        "reachable": reachable,
        "latency_ms": latency_ms,
        "detail": detail,
    }


# ── List / get jobs ────────────────────────────────────────────────────────────

@router.get("/jobs")
async def list_jobs(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(
        select(DeploymentJob).order_by(DeploymentJob.created_at.desc()).limit(100)
    )
    return [_job_dict(j) for j in result.scalars().all()]


@router.get("/jobs/{job_id}")
async def get_job(job_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(select(DeploymentJob).where(DeploymentJob.id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(404, "Job not found")
    return _job_dict(job)


@router.get("/jobs/{job_id}/logs")
async def get_logs(job_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(select(DeploymentJob).where(DeploymentJob.id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(404, "Job not found")
    return {"logs": job.logs or "", "status": job.status}


# ── Start deployment ───────────────────────────────────────────────────────────

@router.post("/deploy", status_code=201)
async def start_deployment(
    body: dict,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    os_type = body.get("os_type", "linux").lower()
    if os_type not in ("linux", "windows"):
        raise HTTPException(400, "os_type must be 'linux' or 'windows'")

    target_host = (body.get("target_host") or "").strip()
    if not target_host:
        raise HTTPException(400, "target_host is required")

    # Resolve saved credential if provided
    saved_cred = {}
    cred_id = body.get("credential_id")
    if cred_id:
        result = await db.execute(select(DeployCredential).where(DeployCredential.id == cred_id))
        cred_obj = result.scalar_one_or_none()
        if cred_obj:
            saved_cred = {
                "username":   cred_obj.username,
                "password":   cred_obj.password or "",
                "ssh_key":    cred_obj.ssh_key or "",
                "domain":     cred_obj.domain or "",
                "port":       cred_obj.port,
                "use_sudo":   cred_obj.use_sudo,
            }

    # Explicit values in the request override saved credential
    username = body.get("username") or saved_cred.get("username", "")
    deploy_method = body.get("deploy_method", "winrm")  # winrm | smb

    if os_type == "linux":
        default_port = saved_cred.get("port") or 22
    elif deploy_method == "smb":
        default_port = saved_cred.get("port") or 445
    else:
        default_port = saved_cred.get("port") or 5985

    creds = {
        "password":      body.get("password") or saved_cred.get("password", ""),
        "ssh_key":       body.get("ssh_key") or saved_cred.get("ssh_key", ""),
        "use_sudo":      body.get("use_sudo") if "use_sudo" in body else saved_cred.get("use_sudo", True),
        "install_dir":   body.get("install_dir", ""),
        "domain":        body.get("domain") or saved_cred.get("domain", ""),
        "deploy_method": deploy_method,
    }

    job = DeploymentJob(
        target_host=target_host,
        target_port=int(body.get("target_port") or default_port),
        os_type=os_type,
        username=username,
        status="pending",
        logs="",
        created_by=user.id,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    thread = threading.Thread(
        target=_run_deployment_sync,
        args=(str(job.id), target_host, int(body.get("target_port") or default_port),
              os_type, username, creds),
        daemon=True,
    )
    thread.start()

    return _job_dict(job)


@router.delete("/jobs/{job_id}", status_code=204)
async def delete_job(job_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(select(DeploymentJob).where(DeploymentJob.id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(404, "Job not found")
    await db.delete(job)
    await db.commit()


# ── SSH deployment worker (runs in thread) ─────────────────────────────────────

def _append_log(job_id: str, line: str):
    """Appends a line to job logs synchronously via a new event loop."""
    import asyncio

    async def _write():
        async with AsyncSessionLocal() as db:
            from sqlalchemy import update
            from api.models.models import DeploymentJob
            result = await db.execute(
                select(DeploymentJob).where(DeploymentJob.id == job_id)
            )
            job = result.scalar_one_or_none()
            if job:
                job.logs = (job.logs or "") + line + "\n"
                await db.commit()

    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(_write())
    finally:
        loop.close()


def _set_job_status(job_id: str, status: str, finished: bool = False):
    import asyncio

    async def _write():
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(DeploymentJob).where(DeploymentJob.id == job_id)
            )
            job = result.scalar_one_or_none()
            if job:
                job.status = status
                if finished:
                    job.finished_at = datetime.now(timezone.utc)
                elif status == "running":
                    job.started_at = datetime.now(timezone.utc)
                await db.commit()

    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(_write())
    finally:
        loop.close()


def _run_deployment_sync(
    job_id: str,
    host: str,
    port: int,
    os_type: str,
    username: str,
    creds: dict,
):
    try:
        _set_job_status(job_id, "running")
        _append_log(job_id, f"[INFO] Starting deployment to {host}:{port} ({os_type})")

        if os_type == "linux":
            _deploy_linux(job_id, host, port, username, creds)
        elif creds.get("deploy_method") == "smb":
            _deploy_windows_smb(job_id, host, username, creds)
        else:
            _deploy_windows(job_id, host, port, username, creds)

        _append_log(job_id, "[SUCCESS] Deployment completed successfully")
        _set_job_status(job_id, "success", finished=True)

    except Exception as e:
        _append_log(job_id, f"[ERROR] {e}")
        _set_job_status(job_id, "failed", finished=True)


def _deploy_linux(job_id: str, host: str, port: int, username: str, creds: dict):
    import paramiko
    import io
    import base64
    import time

    password = creds.get("password", "")
    ssh_key_str = creds.get("ssh_key", "")
    use_sudo = creds.get("use_sudo", True)
    # Need sudo when: use_sudo is True AND user is not root
    need_sudo = use_sudo and username != "root"

    platform_url = f"https://{settings.domain}"
    reg_secret = settings.agent_registration_secret
    install_dir = creds.get("install_dir") or "/opt/kifaa-agent"

    _append_log(job_id, f"[INFO] Connecting via SSH to {username}@{host}:{port}")

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    connect_kwargs = dict(hostname=host, port=port, username=username, timeout=30)
    if ssh_key_str:
        try:
            pkey = paramiko.RSAKey.from_private_key(io.StringIO(ssh_key_str))
        except Exception:
            pkey = paramiko.Ed25519Key.from_private_key(io.StringIO(ssh_key_str))
        connect_kwargs["pkey"] = pkey
    else:
        connect_kwargs["password"] = password

    ssh.connect(**connect_kwargs)
    _append_log(job_id, "[INFO] SSH connection established")

    if need_sudo:
        _append_log(job_id, f"[INFO] Using sudo (user: {username})")

    def run(cmd, desc=None, elevated=False):
        """
        Run a command over SSH.
        elevated=True: prefix with sudo; if a password is available inject it via stdin.
        """
        if desc:
            _append_log(job_id, f"[RUN] {desc}")

        if elevated and need_sudo:
            actual_cmd = f"sudo -S -p '' {cmd}"
        else:
            actual_cmd = cmd

        stdin, stdout, stderr = ssh.exec_command(actual_cmd, timeout=120)

        if elevated and need_sudo and password:
            try:
                stdin.write(password + "\n")
                stdin.flush()
            except Exception:
                pass

        exit_code = stdout.channel.recv_exit_status()
        out = stdout.read().decode(errors="replace").strip()
        err = stderr.read().decode(errors="replace").strip()
        if out:
            for line in out.splitlines():
                _append_log(job_id, f"      {line}")
        if err:
            # Filter out sudo's "password:" prompt leak
            for line in err.splitlines():
                if line.strip().lower() not in ("password:", "[sudo] password:"):
                    _append_log(job_id, f"[ERR] {line}")
        if exit_code != 0:
            raise RuntimeError(f"Command failed (exit {exit_code}): {cmd[:120]}")
        return out

    # Detect OS
    try:
        os_info = run("grep PRETTY_NAME /etc/os-release | cut -d= -f2 | tr -d '\"'")
        _append_log(job_id, f"[INFO] Target OS: {os_info}")
    except Exception:
        _append_log(job_id, "[WARN] Could not detect OS version")

    # Create install directory
    run(f"mkdir -p {install_dir}", f"Creating install directory: {install_dir}", elevated=True)

    # Download agent binary to /tmp (no sudo needed)
    agent_url = f"{platform_url}/downloads/kifaa-agent-linux"
    _append_log(job_id, f"[INFO] Downloading agent from {agent_url}")
    run(
        f"curl -fsSL '{agent_url}' -o /tmp/kifaa-agent --connect-timeout 30 "
        f"|| wget -q '{agent_url}' -O /tmp/kifaa-agent",
        "Downloading Kifaa agent binary",
    )

    run(f"cp /tmp/kifaa-agent {install_dir}/kifaa-agent && rm -f /tmp/kifaa-agent",
        "Installing binary", elevated=True)
    run(f"chmod +x {install_dir}/kifaa-agent", "Setting executable permissions", elevated=True)

    # Write systemd service file via /tmp (avoids sudo | tee stdin conflict)
    service_content = (
        "[Unit]\n"
        "Description=Kifaa Agent\n"
        "After=network.target\n\n"
        "[Service]\n"
        "Type=simple\n"
        f"ExecStart={install_dir}/kifaa-agent --server {platform_url} --secret {reg_secret}\n"
        "Restart=always\n"
        "RestartSec=10\n\n"
        "[Install]\n"
        "WantedBy=multi-user.target\n"
    )
    service_b64 = base64.b64encode(service_content.encode()).decode()
    run(f"echo {service_b64} | base64 -d > /tmp/kifaa-agent.service",
        "Staging systemd service file")
    run("cp /tmp/kifaa-agent.service /etc/systemd/system/kifaa-agent.service && rm -f /tmp/kifaa-agent.service",
        "Installing systemd service file", elevated=True)

    run("systemctl daemon-reload", "Reloading systemd", elevated=True)
    run("systemctl enable kifaa-agent", "Enabling Kifaa agent service", elevated=True)
    run("systemctl restart kifaa-agent", "Starting Kifaa agent service", elevated=True)

    # Verify running
    time.sleep(3)
    try:
        status = run("systemctl is-active kifaa-agent", elevated=True)
        _append_log(job_id, f"[INFO] Service status: {status}")
    except Exception:
        _append_log(job_id, "[WARN] Service may not be running — check manually with: systemctl status kifaa-agent")

    ssh.close()
    _append_log(job_id, f"[INFO] Agent installed to {install_dir}")
    _append_log(job_id, f"[INFO] The agent will register with {platform_url} automatically")


def _deploy_windows(job_id: str, host: str, port: int, username: str, creds: dict):
    """
    PDQ-style Windows deployment via WinRM (NTLM auth).
    Supports domain\\user, .\\localadmin or plain username formats.
    Copies agent to C:\\Windows\\Temp\\kifaa\\, installs as service, then cleans up temp files.
    """
    import winrm
    import time

    password = creds.get("password", "")
    platform_url = f"https://{settings.domain}"
    reg_secret = settings.agent_registration_secret
    temp_dir = "C:\\Windows\\Temp\\kifaa"
    temp_exe = f"{temp_dir}\\kifaa-agent.exe"
    agent_url = f"{platform_url}/downloads/kifaa-agent-windows.exe"

    # Normalise username: accept domain\user, .\user, or plain user
    if "\\" not in username and "/" not in username:
        # No domain — treat as local account (.\username)
        winrm_user = f".\\{username}"
    else:
        winrm_user = username.replace("/", "\\")

    _append_log(job_id, f"[INFO] Connecting to {host}:{port} via WinRM (NTLM)")
    _append_log(job_id, f"[INFO] User: {winrm_user}")

    try:
        session = winrm.Session(
            f"http://{host}:{port}/wsman",
            auth=(winrm_user, password),
            transport="ntlm",
            read_timeout_sec=120,
            operation_timeout_sec=90,
        )
    except ImportError:
        raise RuntimeError("pywinrm is not installed. Cannot deploy to Windows.")

    def run_ps(script, desc=None):
        """Run a PowerShell script block via WinRM and stream output to logs."""
        if desc:
            _append_log(job_id, f"[RUN] {desc}")
        result = session.run_ps(script)
        out = result.std_out.decode("utf-8", errors="replace").strip()
        err = result.std_err.decode("utf-8", errors="replace").strip()
        if out:
            for line in out.splitlines():
                _append_log(job_id, f"      {line}")
        if err:
            for line in err.splitlines():
                _append_log(job_id, f"[ERR] {line}")
        if result.status_code != 0:
            raise RuntimeError(f"PowerShell failed (exit {result.status_code}): {err[:200]}")
        return out

    def cleanup():
        """Remove temp files regardless of success or failure."""
        try:
            session.run_ps(
                f"if (Test-Path '{temp_dir}') {{ Remove-Item -Recurse -Force '{temp_dir}' }}"
            )
            _append_log(job_id, "[INFO] Temp files cleaned up")
        except Exception as e:
            _append_log(job_id, f"[WARN] Cleanup failed: {e}")

    try:
        # ── 1. Test WinRM connectivity ─────────────────────────────────────────
        _append_log(job_id, "[RUN] Testing WinRM connectivity...")
        run_ps("$env:COMPUTERNAME")

        # ── 2. Get OS info ─────────────────────────────────────────────────────
        try:
            run_ps("(Get-WmiObject Win32_OperatingSystem).Caption", "Checking Windows version")
        except Exception:
            pass

        # ── 3. Create temp directory ───────────────────────────────────────────
        run_ps(
            f"New-Item -ItemType Directory -Force -Path '{temp_dir}' | Out-Null",
            f"Creating temp directory: {temp_dir}",
        )

        # ── 4. Download agent binary ───────────────────────────────────────────
        _append_log(job_id, f"[INFO] Downloading agent from {agent_url}")
        run_ps(
            f"[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; "
            f"Invoke-WebRequest -Uri '{agent_url}' -OutFile '{temp_exe}' -UseBasicParsing",
            "Downloading Kifaa agent binary",
        )

        # ── 5. Verify download succeeded ──────────────────────────────────────
        run_ps(
            f"if (-not (Test-Path '{temp_exe}')) {{ throw 'Download failed: file not found' }}; "
            f"$size = (Get-Item '{temp_exe}').Length; Write-Output \"File size: $size bytes\"",
            "Verifying downloaded file",
        )

        # ── 6. Stop existing service if running ────────────────────────────────
        run_ps(
            "try { "
            "  $svc = Get-Service -Name 'KifaaAgent' -ErrorAction SilentlyContinue; "
            "  if ($svc) { Stop-Service -Name 'KifaaAgent' -Force -ErrorAction SilentlyContinue; "
            "    sc.exe delete KifaaAgent | Out-Null; Start-Sleep -Seconds 2 } "
            "} catch {}",
            "Removing existing service (if present)",
        )

        # ── 7. Install agent as Windows service ────────────────────────────────
        run_ps(
            f"& '{temp_exe}' install --server '{platform_url}' --secret '{reg_secret}'",
            "Installing Kifaa agent as Windows service",
        )

        # ── 8. Start service ───────────────────────────────────────────────────
        run_ps("Start-Service -Name 'KifaaAgent'", "Starting KifaaAgent service")

        time.sleep(3)

        # ── 9. Verify service is running ───────────────────────────────────────
        status_out = run_ps(
            "Get-Service -Name 'KifaaAgent' | Select-Object -ExpandProperty Status",
            "Checking service status",
        )
        if "running" not in status_out.lower():
            _append_log(job_id, f"[WARN] Service status: {status_out} — may need manual verification")
        else:
            _append_log(job_id, f"[INFO] Service is running")

        _append_log(job_id, f"[INFO] Agent installed. Will register with {platform_url} on first run.")

    finally:
        # Always clean up temp files
        cleanup()


def _deploy_windows_smb(job_id: str, host: str, username: str, creds: dict):
    """
    PDQ-style SMB deployment for legacy Windows (XP/7/2003/2008) without WinRM.
    Uses SMB port 445 + ADMIN$ share for file copy, then SCM/RPC for service install.

    Requirements on target:
      - Port 445 open (SMB file sharing)
      - ADMIN$ and IPC$ shares available
      - Domain admin or local admin credentials
      - .NET Framework (for the agent binary)
      - Remote Service Management enabled (Service Control Manager reachable via RPC/445)
    """
    import time

    try:
        from impacket.smbconnection import SMBConnection
        from impacket.dcerpc.v5 import transport, scmr
    except ImportError:
        raise RuntimeError(
            "impacket is not installed. Cannot deploy via SMB. "
            "Run: pip install impacket"
        )

    password = creds.get("password", "")
    platform_url = f"https://{settings.domain}"
    reg_secret = settings.agent_registration_secret

    # Parse domain\user or .\user
    domain = ""
    user = username
    if "\\" in username:
        domain, user = username.split("\\", 1)
        if domain in (".", ""):
            domain = ""
    elif "/" in username:
        domain, user = username.split("/", 1)

    _append_log(job_id, f"[INFO] Connecting to {host} via SMB (port 445)")
    domain_prefix = (domain + "\\") if domain else ""
    _append_log(job_id, f"[INFO] User: {domain_prefix}{user}")

    # ── 1. SMB connection ──────────────────────────────────────────────────────
    smb = SMBConnection(host, host, timeout=30)
    try:
        smb.login(user, password, domain)
    except Exception as e:
        raise RuntimeError(f"SMB authentication failed: {e}")
    _append_log(job_id, "[INFO] SMB authenticated successfully")

    # ── 2. Get OS info ─────────────────────────────────────────────────────────
    try:
        server_info = smb.getServerOS()
        _append_log(job_id, f"[INFO] Target OS: {server_info}")
    except Exception:
        pass

    # ── 3. Download agent locally then copy via SMB ────────────────────────────
    import tempfile
    import urllib.request
    import ssl

    agent_url = f"{platform_url}/downloads/kifaa-agent-windows.exe"
    _append_log(job_id, f"[INFO] Downloading agent from {agent_url}")

    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE

    with tempfile.NamedTemporaryFile(suffix=".exe", delete=False) as tmp:
        local_tmp = tmp.name
    try:
        urllib.request.urlretrieve(agent_url, local_tmp)
        _append_log(job_id, f"[INFO] Downloaded to local temp: {local_tmp}")
    except Exception as e:
        raise RuntimeError(f"Failed to download agent: {e}")

    # ── 4. Copy to ADMIN$ share (maps to C:\Windows) ──────────────────────────
    # Path on target: C:\Windows\Temp\kifaa\kifaa-agent.exe
    # Via ADMIN$: Temp\kifaa\kifaa-agent.exe
    remote_share = "ADMIN$"
    remote_dir = "Temp\\kifaa"
    remote_file = f"{remote_dir}\\kifaa-agent.exe"
    cleanup_path = f"C:\\Windows\\Temp\\kifaa"

    _append_log(job_id, f"[RUN] Creating remote directory: C:\\Windows\\Temp\\kifaa")
    try:
        smb.createDirectory(remote_share, remote_dir)
    except Exception:
        pass  # May already exist

    _append_log(job_id, "[RUN] Copying agent binary via SMB...")
    with open(local_tmp, "rb") as fh:
        smb.putFile(remote_share, remote_file, fh.read)
    _append_log(job_id, "[INFO] File copied successfully")

    import os as _os
    try:
        _os.unlink(local_tmp)
    except Exception:
        pass

    # ── 5. Install via SCM (Service Control Manager) ───────────────────────────
    # Connect via RPC to SCM over SMB named pipe
    _append_log(job_id, "[RUN] Connecting to Service Control Manager via RPC...")

    rpctransport = transport.SMBTransport(host, 445, r"\svcctl", username=user, password=password, domain=domain)
    rpctransport.set_connect_timeout(30)
    dce = rpctransport.get_dce_rpc()
    dce.connect()
    dce.bind(scmr.MSRPC_UUID_SCMR)

    scm_handle = scmr.hROpenSCManagerW(dce)["lpScHandle"]

    # Remove old service if exists
    _append_log(job_id, "[RUN] Removing existing KifaaAgent service (if present)...")
    try:
        svc_handle = scmr.hROpenServiceW(dce, scm_handle, "KifaaAgent")["lpServiceHandle"]
        try:
            scmr.hRControlService(dce, svc_handle, scmr.SERVICE_CONTROL_STOP)
            time.sleep(2)
        except Exception:
            pass
        scmr.hRDeleteService(dce, svc_handle)
        scmr.hRCloseServiceHandle(dce, svc_handle)
        _append_log(job_id, "[INFO] Old service removed")
    except Exception:
        pass  # Service didn't exist

    # Install new service
    agent_exe = f"C:\\Windows\\Temp\\kifaa\\kifaa-agent.exe"
    service_cmd = f'"{agent_exe}" --server {platform_url} --secret {reg_secret}'
    _append_log(job_id, "[RUN] Creating KifaaAgent service...")

    svc_handle = scmr.hRCreateServiceW(
        dce, scm_handle,
        "KifaaAgent", "Kifaa Agent",
        lpBinaryPathName=service_cmd,
        dwStartType=scmr.SERVICE_AUTO_START,
    )["lpServiceHandle"]

    _append_log(job_id, "[RUN] Starting KifaaAgent service...")
    scmr.hRStartServiceW(dce, svc_handle)

    time.sleep(4)

    # ── 6. Verify service running ──────────────────────────────────────────────
    try:
        status_resp = scmr.hRQueryServiceStatus(dce, svc_handle)
        state = status_resp["lpServiceStatus"]["dwCurrentState"]
        # 4 = SERVICE_RUNNING
        if state == scmr.SERVICE_RUNNING:
            _append_log(job_id, "[INFO] Service is running")
        else:
            _append_log(job_id, f"[WARN] Service state: {state} — may need manual check")
    except Exception as e:
        _append_log(job_id, f"[WARN] Could not query service state: {e}")

    scmr.hRCloseServiceHandle(dce, svc_handle)
    scmr.hRCloseServiceHandle(dce, scm_handle)
    dce.disconnect()

    # ── 7. Cleanup temp dir via SMB ────────────────────────────────────────────
    # Note: we keep the .exe because the service binary must stay at that path.
    # Only clean if the exe was an installer that extracted itself.
    # For a direct binary service, leave it in place.
    _append_log(job_id, "[INFO] Agent binary left at C:\\Windows\\Temp\\kifaa\\ (required for service)")
    _append_log(job_id, f"[INFO] Agent will register with {platform_url} on first run")

    smb.logoff()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _job_dict(j: DeploymentJob) -> dict:
    return {
        "id": str(j.id),
        "target_host": j.target_host,
        "target_port": j.target_port,
        "os_type": j.os_type,
        "username": j.username,
        "status": j.status,
        "logs": j.logs or "",
        "created_at": j.created_at.isoformat() if j.created_at else None,
        "started_at": j.started_at.isoformat() if j.started_at else None,
        "finished_at": j.finished_at.isoformat() if j.finished_at else None,
    }
