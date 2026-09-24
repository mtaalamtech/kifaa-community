"""
Agent-based remote control.

Flow:
  1. POST /remote/sessions          → creates session in Redis, deploys kifaa-remote.exe via SMB
  2. WS  /remote/sessions/{token}/helper  → Windows helper binary connects here (outbound)
  3. WS  /remote/sessions/{token}/browser → browser connects here
  4. Redis pub/sub relays binary frames (screen JPEG) helper→browser and
     JSON events (input) browser→helper.  Works across multiple uvicorn workers.
  5. DELETE /remote/sessions/{token}      → terminates session
"""

import asyncio
import json
import logging
import os
import secrets
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.database import get_db
from api.services.auth import get_current_user, decode_token
from api.config import get_settings

logger = logging.getLogger(__name__)
router = APIRouter(tags=["remote"])

_SESSION_TTL = 300   # seconds — Redis key expiry while waiting for helper
_SESSION_ACTIVE_TTL = 3600  # 1 h — expiry once active


# ── Redis helpers ─────────────────────────────────────────────────────────────

async def _redis():
    import redis.asyncio as aioredis
    return aioredis.from_url(get_settings().redis_url)


async def _session_create(token: str, agent_id: str, hostname: str):
    r = await _redis()
    await r.hset(f"remote:{token}", mapping={
        "agent_id": agent_id,
        "hostname": hostname,
        "created_at": str(time.time()),
        "state": "waiting",
        "error": "",
    })
    await r.expire(f"remote:{token}", _SESSION_TTL)
    await r.aclose()


async def _session_get(token: str) -> dict | None:
    r = await _redis()
    data = await r.hgetall(f"remote:{token}")
    await r.aclose()
    return data or None


async def _session_set_error(token: str, error: str):
    r = await _redis()
    await r.hset(f"remote:{token}", mapping={"state": "error", "error": error})
    # Publish so browser_ws wakes up
    await r.publish(f"remote_state:{token}", json.dumps({"type": "error", "msg": error}))
    await r.aclose()


async def _session_set_active(token: str):
    r = await _redis()
    await r.hset(f"remote:{token}", "state", "active")
    await r.expire(f"remote:{token}", _SESSION_ACTIVE_TTL)
    await r.publish(f"remote_state:{token}", json.dumps({"type": "connected"}))
    await r.aclose()


async def _session_delete(token: str):
    r = await _redis()
    await r.delete(f"remote:{token}")
    await r.publish(f"remote_state:{token}", json.dumps({"type": "quit"}))
    await r.aclose()


def _new_token() -> str:
    return secrets.token_hex(24)


async def _validate_ws_auth(token: str) -> bool:
    return decode_token(token) is not None


# ── Session creation + SMB deploy ─────────────────────────────────────────────

@router.post("/remote/sessions")
async def create_session(
    body: dict,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    agent_id = body.get("agent_id")
    if not agent_id:
        raise HTTPException(400, "agent_id required")

    agent = await db.execute(
        text("SELECT ip_address, hostname, os_type FROM agents WHERE id = CAST(:id AS uuid)"),
        {"id": agent_id},
    )
    agent = agent.fetchone()
    if not agent:
        raise HTTPException(404, "Agent not found")

    ip, hostname, os_type = agent
    if os_type not in ("windows", "Windows"):
        raise HTTPException(400, "Remote control currently supports Windows agents only")

    cred_row = await db.execute(
        text("SELECT username, password, domain FROM agent_ssh_credentials WHERE agent_id = CAST(:id AS uuid)"),
        {"id": agent_id},
    )
    cred_row = cred_row.fetchone()

    from api.routers.terminal import _decrypt
    if cred_row:
        username = cred_row[0] or body.get("username", "")
        password = _decrypt(cred_row[1]) if cred_row[1] else body.get("password", "")
        domain   = cred_row[2] or body.get("domain", "")
    else:
        username = body.get("username", "")
        password = body.get("password", "")
        domain   = body.get("domain", "")

    if not username or not password:
        raise HTTPException(400, "Credentials required (not stored — provide username/password)")

    token = _new_token()
    server_url = os.getenv("SERVER_URL", "https://kifaa.kenyanut.com")

    await _session_create(token, agent_id, hostname)

    # Deploy helper in background thread (SMB is blocking I/O)
    loop = asyncio.get_event_loop()
    loop.run_in_executor(
        None,
        _deploy_helper_sync,
        ip, username, password, domain, server_url, token,
    )

    return {"session_id": token, "token": token, "message": "Deploying remote helper…"}


def _deploy_helper_sync(ip: str, username: str, password: str, domain: str,
                        server_url: str, token: str):
    """Copy kifaa-remote.exe to Windows via SMB and launch it (runs in thread pool)."""
    import asyncio as _asyncio

    def _set_error(msg):
        _asyncio.run(_session_set_error(token, msg))

    try:
        from impacket.smbconnection import SMBConnection
        from impacket.dcerpc.v5 import transport as imp_transport, scmr
    except ImportError:
        logger.error("impacket not available — cannot deploy remote helper")
        _set_error("impacket not installed on server")
        return

    binary_path = "/app/static/agent-builds/kifaa-remote-windows-amd64.exe"
    if not os.path.exists(binary_path):
        logger.error("kifaa-remote-windows-amd64.exe not found")
        _set_error("Remote helper binary not found on server")
        return

    remote_exe = r"Windows\Temp\kifaa-remote.exe"
    svc_name   = f"KifaaRemote_{token[:8]}"
    # Use cmd.exe as the service binary so it immediately exits (avoiding the
    # SERVICE_REQUEST_TIMEOUT that occurs when a non-service binary is run directly).
    # /b = no new window; the helper becomes an orphaned process that outlives cmd.
    helper_cmd = (f'C:\\Windows\\Temp\\kifaa-remote.exe '
                  f'--server {server_url} --token {token}')
    svc_cmd = f'cmd /c "start /b {helper_cmd}"'

    # ERROR_SERVICE_REQUEST_TIMEOUT (0x41d) — cmd exits before SCM handshake.
    # This is expected; the helper is already running by the time we get this error.
    SCMR_TIMEOUT_CODE = 0x41d

    try:
        smb = SMBConnection(ip, ip, sess_port=445)
        smb.login(username, password, domain or ".")
        logger.info("Remote deploy: SMB authenticated to %s", ip)

        with open(binary_path, "rb") as fh:
            smb.putFile("C$", remote_exe, fh.read)
        logger.info("Remote helper copied to \\\\%s\\C$\\%s", ip, remote_exe)

        rpct = imp_transport.SMBTransport(ip, filename=r"\svcctl", smb_connection=smb)
        dce = rpct.get_dce_rpc()
        dce.connect()
        dce.bind(scmr.MSRPC_UUID_SCMR)
        scm = scmr.hROpenSCManagerW(dce)["lpScHandle"]

        try:
            old = scmr.hROpenServiceW(dce, scm, svc_name)["lpServiceHandle"]
            try:
                scmr.hRControlService(dce, old, scmr.SERVICE_CONTROL_STOP)
            except Exception:
                pass
            scmr.hRDeleteService(dce, old)
            scmr.hRCloseServiceHandle(dce, old)
        except Exception:
            pass

        scmr.hRCreateServiceW(
            dce, scm, svc_name, f"Kifaa Remote {token[:8]}",
            lpBinaryPathName=svc_cmd,
            dwStartType=scmr.SERVICE_DEMAND_START,
            dwErrorControl=scmr.SERVICE_ERROR_IGNORE,
        )
        svc = scmr.hROpenServiceW(dce, scm, svc_name)["lpServiceHandle"]
        try:
            scmr.hRStartServiceW(dce, svc)
            logger.info("Remote helper service started on %s (token=%s)", ip, token[:8])
        except Exception as start_err:
            err_str = str(start_err)
            # Timeout is expected — cmd exited; helper is running as orphan
            if hex(SCMR_TIMEOUT_CODE) in err_str.lower() or "0x41d" in err_str.lower() or "timeout" in err_str.lower():
                logger.info("Remote helper launched (cmd exited, helper orphaned) on %s token=%s", ip, token[:8])
            else:
                raise

        scmr.hRCloseServiceHandle(dce, svc)
        # Clean up the service entry — helper is already running as a standalone process
        try:
            svc2 = scmr.hROpenServiceW(dce, scm, svc_name)["lpServiceHandle"]
            scmr.hRDeleteService(dce, svc2)
            scmr.hRCloseServiceHandle(dce, svc2)
        except Exception:
            pass
        scmr.hRCloseServiceHandle(dce, scm)
        dce.disconnect()
        smb.logoff()

    except Exception as e:
        logger.error("Remote helper deploy failed: %s", e)
        _set_error(str(e))


# ── Helper WebSocket (outbound from Windows machine) ──────────────────────────

@router.websocket("/remote/sessions/{token}/helper")
async def helper_ws(websocket: WebSocket, token: str):
    """The kifaa-remote.exe binary on the Windows machine connects here."""
    session = await _session_get(token)
    if not session:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    await _session_set_active(token)
    logger.info("Remote helper connected for token %s", token[:8])

    r_pub = await _redis()  # publisher for frames
    r_sub = await _redis()  # subscriber for input events
    psub = r_sub.pubsub()
    await psub.subscribe(f"remote_input:{token}")

    async def _send_frames():
        """Read frames from helper WS and publish to Redis."""
        try:
            while True:
                try:
                    data = await asyncio.wait_for(websocket.receive_bytes(), timeout=5.0)
                    await r_pub.publish(f"remote_frame:{token}", data)
                except asyncio.TimeoutError:
                    continue
                except WebSocketDisconnect:
                    break
                except Exception:
                    break
        finally:
            pass

    async def _recv_input():
        """Read input events from Redis and forward to helper WS."""
        try:
            async for msg in psub.listen():
                if msg["type"] != "message":
                    continue
                data = msg["data"]
                if isinstance(data, bytes):
                    data = data.decode()
                parsed = json.loads(data)
                if parsed.get("type") == "quit":
                    break
                try:
                    await websocket.send_text(data)
                except Exception:
                    break
        finally:
            pass

    try:
        await asyncio.gather(_send_frames(), _recv_input())
    finally:
        await psub.unsubscribe(f"remote_input:{token}")
        await psub.aclose()
        await r_pub.aclose()
        await r_sub.aclose()

        # Notify browser that helper disconnected
        r_notify = await _redis()
        await r_notify.publish(f"remote_state:{token}",
                               json.dumps({"type": "helper_disconnected"}))
        await r_notify.aclose()
        logger.info("Remote helper disconnected for token %s", token[:8])


# ── Browser WebSocket ──────────────────────────────────────────────────────────

@router.websocket("/remote/sessions/{token}/browser")
async def browser_ws(websocket: WebSocket, token: str, ws_token: str = Query(...)):
    """Browser connects here to view and control the remote desktop."""
    if not await _validate_ws_auth(ws_token):
        await websocket.close(code=4001)
        return

    session = await _session_get(token)
    if not session:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    logger.info("Browser connected to remote session %s (state=%s)", token[:8], session.get("state"))

    # If not yet active, wait for helper to connect (via Redis pub/sub)
    if session.get("state") != "active":
        r_wait = await _redis()
        psub_wait = r_wait.pubsub()
        await psub_wait.subscribe(f"remote_state:{token}")
        helper_ok = False
        error_msg = None
        try:
            deadline = time.time() + 30.0
            async for msg in psub_wait.listen():
                if msg["type"] != "message":
                    continue
                payload = json.loads(msg["data"])
                mtype = payload.get("type")
                if mtype == "connected":
                    helper_ok = True
                    break
                elif mtype == "error":
                    error_msg = payload.get("msg", "Deploy failed")
                    break
                elif mtype == "quit":
                    error_msg = "Session terminated"
                    break
                if time.time() > deadline:
                    error_msg = "Helper did not connect in time — check SMB credentials"
                    break
        except asyncio.TimeoutError:
            error_msg = "Helper did not connect in time"
        finally:
            await psub_wait.unsubscribe(f"remote_state:{token}")
            await psub_wait.aclose()
            await r_wait.aclose()

        if error_msg:
            await websocket.send_text(json.dumps({"type": "error", "msg": error_msg}))
            await websocket.close()
            return

        if not helper_ok:
            await websocket.send_text(json.dumps({"type": "error", "msg": "Helper not available"}))
            await websocket.close()
            return

    await websocket.send_text(json.dumps({"type": "connected", "msg": "Remote session active"}))

    r_pub = await _redis()   # publish input events
    r_sub = await _redis()   # subscribe to frames + state
    psub = r_sub.pubsub()
    await psub.subscribe(f"remote_frame:{token}", f"remote_state:{token}")

    async def _recv_frames():
        """Read frames from Redis and send to browser."""
        try:
            async for msg in psub.listen():
                if msg["type"] != "message":
                    continue
                channel = msg["channel"]
                if isinstance(channel, bytes):
                    channel = channel.decode()
                data = msg["data"]
                if f"remote_state:{token}" in channel:
                    if isinstance(data, bytes):
                        data = data.decode()
                    payload = json.loads(data)
                    mtype = payload.get("type")
                    if mtype in ("helper_disconnected", "quit"):
                        await websocket.send_text(json.dumps({"type": "helper_disconnected"}))
                        break
                else:
                    # Binary JPEG frame
                    if isinstance(data, str):
                        data = data.encode()
                    try:
                        await websocket.send_bytes(data)
                    except Exception:
                        break
        finally:
            pass

    async def _send_input():
        """Read input events from browser and publish to Redis."""
        try:
            while True:
                try:
                    msg = await asyncio.wait_for(websocket.receive_text(), timeout=30.0)
                    await r_pub.publish(f"remote_input:{token}", msg)
                except asyncio.TimeoutError:
                    await websocket.send_text(json.dumps({"type": "ping"}))
                except WebSocketDisconnect:
                    break
                except Exception:
                    break
        finally:
            pass

    try:
        await asyncio.gather(_recv_frames(), _send_input())
    finally:
        await psub.unsubscribe(f"remote_frame:{token}", f"remote_state:{token}")
        await psub.aclose()
        await r_pub.aclose()
        await r_sub.aclose()

        # Tell helper to quit
        r_quit = await _redis()
        await r_quit.publish(f"remote_input:{token}", json.dumps({"type": "quit"}))
        await r_quit.aclose()
        logger.info("Browser disconnected from remote session %s", token[:8])


# ── Session termination ────────────────────────────────────────────────────────

@router.delete("/remote/sessions/{token}")
async def terminate_session(token: str, _=Depends(get_current_user)):
    session = await _session_get(token)
    if not session:
        raise HTTPException(404, "Session not found")
    await _session_delete(token)
    return {"status": "terminated"}


@router.get("/remote/sessions")
async def list_sessions(_=Depends(get_current_user)):
    r = await _redis()
    keys = await r.keys("remote:*")
    sessions = []
    for key in keys:
        if isinstance(key, bytes):
            key = key.decode()
        token = key.split(":", 1)[1]
        data = await r.hgetall(key)
        if data:
            created_at = float(data.get("created_at", b"0") if isinstance(data.get("created_at"), str)
                               else data.get(b"created_at", b"0"))
            sessions.append({
                "token": token[:8] + "…",
                "agent_id": data.get("agent_id", ""),
                "hostname": data.get("hostname", ""),
                "state": data.get("state", ""),
                "age_seconds": int(time.time() - created_at),
            })
    await r.aclose()
    return sessions
