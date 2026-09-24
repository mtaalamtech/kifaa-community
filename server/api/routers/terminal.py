"""
Terminal access: SSH web terminal (Linux) + RDP file download (Windows).
"""
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
import asyncio, json, logging

from api.database import get_db
from api.services.auth import decode_token, get_current_user
from api.models.models import AgentSSHCredentials
from api.config import get_settings
import uuid as _uuid

logger = logging.getLogger(__name__)
router = APIRouter()


def _get_fernet():
    """Return a Fernet instance if FERNET_KEY is configured, else None."""
    key = get_settings().fernet_key
    if not key:
        return None
    try:
        from cryptography.fernet import Fernet
        return Fernet(key.encode() if isinstance(key, str) else key)
    except Exception:
        return None


def _encrypt(value: str | None) -> str | None:
    """Encrypt a string value at rest. Returns original if Fernet not configured."""
    if not value:
        return value
    f = _get_fernet()
    if not f:
        return value
    return f.encrypt(value.encode()).decode()


def _decrypt(value: str | None) -> str | None:
    """Decrypt a Fernet-encrypted string. Falls back gracefully for unencrypted legacy values."""
    if not value:
        return value
    f = _get_fernet()
    if not f:
        return value
    try:
        return f.decrypt(value.encode()).decode()
    except Exception:
        # Value may be plaintext from before encryption was enabled
        return value


async def _get_redis():
    """Return an aioredis client, or None if Redis is unavailable."""
    try:
        import redis.asyncio as aioredis
        return aioredis.from_url(get_settings().redis_url, decode_responses=True)
    except Exception:
        return None


async def _issue_ticket(user_id: str, username: str, role: str) -> str:
    """Store a one-time terminal ticket in Redis (30s TTL). Returns the ticket UUID."""
    ticket = str(_uuid.uuid4())
    r = await _get_redis()
    if r:
        try:
            await r.setex(
                f"terminal_ticket:{ticket}",
                30,
                json.dumps({"sub": user_id, "username": username, "role": role}),
            )
        finally:
            await r.aclose()
    return ticket


async def _redeem_ticket(ticket: str) -> dict | None:
    """Exchange a ticket for user info (one-time use; deleted on read). Returns None if invalid."""
    r = await _get_redis()
    if not r:
        return None
    try:
        key = f"terminal_ticket:{ticket}"
        data = await r.get(key)
        if data:
            await r.delete(key)  # one-time use
            return json.loads(data)
        return None
    except Exception:
        return None
    finally:
        await r.aclose()


@router.get("/terminal/ticket")
async def get_terminal_ticket(current_user=Depends(get_current_user)):
    """Issue a one-time 30-second ticket for WebSocket terminal auth.
    The frontend exchanges the JWT for a ticket, then uses the ticket in the WS URL.
    This prevents the JWT from appearing in server logs or browser history."""
    ticket = await _issue_ticket(
        user_id=str(current_user.id),
        username=current_user.username,
        role=current_user.role,
    )
    return {"ticket": ticket, "expires_in": 30}


async def _validate_ws_auth(token_or_ticket: str) -> dict | None:
    """Validate either a JWT token (legacy) or a one-time ticket for WebSocket auth.
    Returns the user payload dict, or None if invalid."""
    # Try as one-time ticket first (UUID format)
    try:
        _uuid.UUID(token_or_ticket)
        return await _redeem_ticket(token_or_ticket)
    except ValueError:
        pass
    # Fall back to JWT token (for backwards compatibility during transition)
    return decode_token(token_or_ticket)


async def _get_agent_and_creds(agent_id: str, db: AsyncSession):
    """Load agent IP + SSH credentials, raise HTTPException if missing."""
    row = await db.execute(text(
        "SELECT ip_address, hostname FROM agents WHERE id = CAST(:id AS uuid) AND is_active = TRUE"
    ), {"id": agent_id})
    agent = row.fetchone()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    crow = await db.execute(text(
        "SELECT host_override, port, username, password, ssh_key, use_sudo, connect_type, winrm_port, domain, "
        "COALESCE(rdp_ignore_cert, FALSE) AS rdp_ignore_cert, known_host_key "
        "FROM agent_ssh_credentials WHERE agent_id = CAST(:id AS uuid)"
    ), {"id": agent_id})
    creds = crow.fetchone()
    return agent, creds


# ─── SSH Web Terminal ─────────────────────────────────────────────────────────

@router.websocket("/terminal/ssh/{agent_id}")
async def ssh_terminal(
    websocket: WebSocket,
    agent_id: str,
    token: str = Query(...),
    db: AsyncSession = Depends(get_db),
):
    # Validate via one-time ticket or JWT token
    payload = await _validate_ws_auth(token)
    if not payload:
        await websocket.close(code=4001)
        return

    agent, creds = await _get_agent_and_creds(agent_id, db)

    if not creds:
        await websocket.accept()
        await websocket.send_text(json.dumps({"type": "error", "data": "No SSH credentials configured for this agent. Add credentials in the agent settings."}))
        await websocket.close()
        return

    host = creds[0] or agent[0]  # host_override or agent IP
    port = creds[1] or 22
    username = creds[2]
    password = _decrypt(creds[3])
    ssh_key = _decrypt(creds[4])
    stored_host_key = creds[10] if len(creds) > 10 else None

    await websocket.accept()

    try:
        import asyncssh
    except ImportError:
        await websocket.send_text(json.dumps({"type": "error", "data": "asyncssh not installed on server. Please rebuild the API container."}))
        await websocket.close()
        return

    # Build known_hosts: TOFU — accept any key on first connect, verify on subsequent ones
    if stored_host_key:
        # Format: "[host]:port keytype base64key" (brackets+port needed for non-22)
        if port == 22:
            known_hosts_entry = f"{host} {stored_host_key}\n"
        else:
            known_hosts_entry = f"[{host}]:{port} {stored_host_key}\n"
        known_hosts = known_hosts_entry.encode()
    else:
        known_hosts = None  # First connection: accept any key (TOFU)

    connect_kwargs = {
        "host": host,
        "port": port,
        "username": username,
        "known_hosts": known_hosts,
    }
    if ssh_key:
        connect_kwargs["client_keys"] = [asyncssh.import_private_key(ssh_key)]
    if password:
        connect_kwargs["password"] = password

    try:
        conn = await asyncio.wait_for(asyncssh.connect(**connect_kwargs), timeout=15)
    except asyncio.TimeoutError:
        await websocket.send_text(json.dumps({"type": "error", "data": f"Connection timed out to {host}:{port}"}))
        await websocket.close()
        return
    except asyncssh.KeyNotVerifiable as e:
        await websocket.send_text(json.dumps({
            "type": "error",
            "data": f"SSH host key mismatch for {host}! The server's key has changed. "
                    f"This may indicate a man-in-the-middle attack. "
                    f"If the server was rebuilt, clear the stored key in agent settings. Error: {e}"
        }))
        await websocket.close()
        return
    except Exception as e:
        await websocket.send_text(json.dumps({"type": "error", "data": f"SSH connection failed: {e}"}))
        await websocket.close()
        return

    # TOFU: save the server's host key after first successful connection
    if not stored_host_key:
        try:
            server_host_key = conn.get_server_host_key()
            if server_host_key:
                key_data = server_host_key.export_public_key().decode().strip()
                # key_data is "algorithm base64data [comment]" — strip trailing fields to just "algo base64"
                key_parts = key_data.split()
                if len(key_parts) >= 2:
                    compact_key = f"{key_parts[0]} {key_parts[1]}"
                    await db.execute(text(
                        "UPDATE agent_ssh_credentials SET known_host_key = :key "
                        "WHERE agent_id = CAST(:aid AS uuid)"
                    ), {"key": compact_key, "aid": agent_id})
                    await db.commit()
                    logger.info("Stored SSH host key for agent %s: %s...", agent_id, compact_key[:40])
        except Exception as e:
            logger.warning("Failed to store SSH host key for agent %s: %s", agent_id, e)

    try:
        process = await conn.create_process(
            term_type="xterm-256color",
            term_size=(80, 24),
            encoding=None,          # raw bytes — avoids line-buffering that hides prompts/echoes
        )

        async def read_ssh():
            """Forward SSH stdout → WebSocket as base64 to safely carry raw bytes."""
            import base64
            try:
                while True:
                    data = await process.stdout.read(4096)
                    if not data:
                        break
                    # Send as UTF-8 text, replacing any non-decodable bytes
                    text = data.decode("utf-8", errors="replace")
                    await websocket.send_text(json.dumps({"type": "data", "data": text}))
            except Exception:
                pass

        ssh_task = asyncio.create_task(read_ssh())

        try:
            while True:
                msg_raw = await websocket.receive_text()
                try:
                    msg = json.loads(msg_raw)
                except Exception:
                    continue
                if msg.get("type") == "data":
                    process.stdin.write(msg["data"].encode("utf-8"))
                elif msg.get("type") == "resize":
                    cols = msg.get("cols", 80)
                    rows = msg.get("rows", 24)
                    process.change_terminal_size(cols, rows)
        except WebSocketDisconnect:
            pass
        finally:
            ssh_task.cancel()
            process.close()
            conn.close()

    except Exception as e:
        logger.exception("SSH terminal error for agent %s: %s", agent_id, e)
        try:
            await websocket.send_text(json.dumps({"type": "error", "data": str(e)}))
            await websocket.close()
        except Exception:
            pass


# ─── WinRM / PowerShell Web Terminal ─────────────────────────────────────────

@router.websocket("/terminal/winrm/{agent_id}")
async def winrm_terminal(
    websocket: WebSocket,
    agent_id: str,
    token: str = Query(...),
    db: AsyncSession = Depends(get_db),
):
    payload = await _validate_ws_auth(token)
    if not payload:
        await websocket.close(code=4001)
        return

    agent, creds = await _get_agent_and_creds(agent_id, db)
    await websocket.accept()

    if not creds or not creds[2]:
        await websocket.send_text(json.dumps({"type": "error", "data": "No credentials configured for this agent. Click Settings to add credentials."}))
        await websocket.close()
        return

    host = creds[0] or agent[0]
    winrm_port = creds[7] or 5985
    username = creds[2]
    password = _decrypt(creds[3]) or ""
    domain = creds[8] or ""

    full_user = f"{domain}\\{username}" if domain else username

    try:
        import winrm
    except ImportError:
        await websocket.send_text(json.dumps({"type": "error", "data": "pywinrm not installed on server."}))
        await websocket.close()
        return

    # Test connectivity first
    try:
        protocol = winrm.Protocol(
            endpoint=f"http://{host}:{winrm_port}/wsman",
            transport="ntlm",
            username=full_user,
            password=password,
            operation_timeout_sec=15,
            read_timeout_sec=20,
        )
        shell_id = protocol.open_shell()
    except Exception as e:
        await websocket.send_text(json.dumps({"type": "error", "data": f"WinRM connection failed: {e}"}))
        await websocket.close()
        return

    await websocket.send_text(json.dumps({"type": "data", "data": f"\x1b[32mConnected to {host} via WinRM\x1b[0m\r\nWindows PowerShell\r\nType commands and press Enter.\r\n\r\nPS> "}))

    # Stateless command executor — each message runs a PS command and streams output
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue

            if msg.get("type") == "data":
                user_input = msg["data"]
                # Accumulate until we get a newline (Enter key)
                # For simplicity, run each Enter-terminated input as a PS command
                if "\r" in user_input or "\n" in user_input:
                    command = user_input.strip()
                    if not command:
                        await websocket.send_text(json.dumps({"type": "data", "data": "\r\nPS> "}))
                        continue
                    # Echo the command
                    await websocket.send_text(json.dumps({"type": "data", "data": f"\r\n"}))
                    try:
                        cmd_id = protocol.run_command(shell_id, f"powershell -NonInteractive -Command \"{command.replace(chr(34), chr(39))}\"")
                        std_out, std_err, rc = protocol.get_command_output(shell_id, cmd_id)
                        protocol.cleanup_command(shell_id, cmd_id)
                        output = ""
                        if std_out:
                            output += std_out.decode("utf-8", errors="replace").replace("\r\n", "\r\n")
                        if std_err:
                            output += "\x1b[31m" + std_err.decode("utf-8", errors="replace").replace("\r\n", "\r\n") + "\x1b[0m"
                        if output:
                            await websocket.send_text(json.dumps({"type": "data", "data": output}))
                    except Exception as e:
                        await websocket.send_text(json.dumps({"type": "data", "data": f"\x1b[31mError: {e}\x1b[0m\r\n"}))
                    await websocket.send_text(json.dumps({"type": "data", "data": "\r\nPS> "}))
                else:
                    # Echo keystrokes back so user can see what they type
                    await websocket.send_text(json.dumps({"type": "data", "data": user_input}))

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.exception("WinRM terminal error for agent %s: %s", agent_id, e)
    finally:
        try:
            protocol.close_shell(shell_id)
        except Exception:
            pass


# ─── RDP File Download ────────────────────────────────────────────────────────

@router.get("/terminal/rdp/{agent_id}")
async def download_rdp(
    agent_id: str,
    token: str = Query(default=None),
    db: AsyncSession = Depends(get_db),
):
    # Accept one-time ticket or JWT token via query param
    if not token or not await _validate_ws_auth(token):
        raise HTTPException(status_code=401, detail="Not authenticated")
    agent, creds = await _get_agent_and_creds(agent_id, db)
    ip = agent[0]
    hostname = agent[1]

    rdp_port = 3389
    rdp_user = ""
    domain = ""

    if creds:
        domain = creds[8] or ""
        rdp_user = creds[2] or ""
        # winrm_port (creds[7]) is 5985 — don't use it as RDP port; keep 3389

    full_user = f"{domain}\\{rdp_user}" if domain and rdp_user else rdp_user

    rdp_content = f"""full address:s:{ip}:{rdp_port}
username:s:{full_user}
prompt for credentials:i:1
authentication level:i:2
redirectclipboard:i:1
redirectprinters:i:0
auto connect:i:1
"""

    filename = f"{hostname or ip}.rdp"
    return Response(
        content=rdp_content,
        media_type="application/x-rdp",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ─── In-browser RDP via Guacamole (guacd) ────────────────────────────────────

GUACD_HOST = "kifaa-guacd"
GUACD_PORT = 4822


def _guac_encode(*args) -> bytes:
    parts = [f"{len(str(a))}.{a}" for a in args]
    return (",".join(parts) + ";").encode("utf-8")


async def _guac_read_instruction(reader: asyncio.StreamReader, buf: bytearray) -> str:
    """Read one complete Guacamole instruction (ends with ';') from the stream."""
    while True:
        idx = buf.find(b";")
        if idx != -1:
            instruction = buf[:idx + 1].decode("utf-8")
            del buf[:idx + 1]
            return instruction
        chunk = await reader.read(4096)
        if not chunk:
            raise ConnectionError("guacd disconnected")
        buf.extend(chunk)


@router.websocket("/terminal/rdp-ws/{agent_id}")
async def rdp_websocket(
    websocket: WebSocket,
    agent_id: str,
    token: str = Query(...),
    width: int = Query(default=1280),
    height: int = Query(default=800),
    db: AsyncSession = Depends(get_db),
):
    """In-browser RDP session proxied through guacd (Apache Guacamole)."""
    if not await _validate_ws_auth(token):
        await websocket.close(code=4001)
        return

    agent, creds = await _get_agent_and_creds(agent_id, db)
    await websocket.accept()

    host = (creds[0] if creds else None) or agent[0]
    rdp_port = 3389
    username = (creds[2] or "") if creds else ""
    password = (_decrypt(creds[3]) or "") if creds else ""
    domain = (creds[8] or "") if creds else ""
    rdp_ignore_cert = bool(creds[9]) if creds else False

    if not host:
        await websocket.send_text('5.error,1.0,"No IP address for this agent";')
        await websocket.close()
        return

    # Connect to guacd
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(GUACD_HOST, GUACD_PORT), timeout=10
        )
    except Exception as e:
        await websocket.send_text(f'5.error,1.0,"Cannot reach guacd: {e}";')
        await websocket.close()
        return

    buf = bytearray()

    # Send guacamole nop to browser every 500 ms while the guacd handshake is in progress.
    # The RDP/NLA negotiation can take 10-30 s; without keepalives guacamole-common-js
    # declares "Server timeout" before we even send the ready instruction.
    handshake_done = asyncio.Event()

    async def _browser_keepalive():
        try:
            while not handshake_done.is_set():
                await asyncio.sleep(0.5)
                if handshake_done.is_set():
                    break
                try:
                    await websocket.send_text("3.nop;")
                except Exception:
                    break
        except Exception:
            pass

    keepalive_task = asyncio.create_task(_browser_keepalive())

    try:
        # Guacamole handshake — step 1: select protocol
        writer.write(_guac_encode("select", "rdp"))
        await writer.drain()

        # Step 2: receive list of expected args from guacd
        args_instruction = await asyncio.wait_for(_guac_read_instruction(reader, buf), timeout=10)
        # Parse: "4.args,8.hostname,4.port,..."
        parts = args_instruction.rstrip(";").split(",")
        arg_names = []
        for part in parts[1:]:  # skip "args" opcode
            dot = part.index(".")
            arg_names.append(part[dot + 1:])

        # Step 3: build params dict and send connect
        # Echo back any VERSION_x_x_x arg for protocol version negotiation (guacd 1.5+)
        params = {n: n for n in arg_names if n.startswith("VERSION_")}
        params.update({
            "hostname": host,
            "port": str(rdp_port),
            "username": username,
            "password": password,
            "domain": domain,
            "width": str(width),
            "height": str(height),
            "dpi": "96",
            "color-depth": "32",
            # Cert bypass — both flags needed for guacd 1.5+/1.6.x with FreeRDP 3
            "ignore-cert": "true",
            "cert-tofu": "true",
            "security": "any",        # let guacd/FreeRDP negotiate best available
            "disable-audio": "true",  # prevents audio plugin crash in guacd
            "disable-gfx": "true",    # use legacy RDP codec path (more compatible)
            "enable-wallpaper": "false",
            "enable-theming": "false",
            "enable-font-smoothing": "true",
            "enable-full-window-drag": "false",
            "enable-desktop-composition": "false",
            "enable-menu-animations": "false",
            "resize-method": "display-update",
            "normalize-clipboard": "",
            "server-layout": "",
            "console": "",
        })
        logger.info("RDP guacd arg_names: %s", arg_names)
        values = [params.get(name, "") for name in arg_names]
        logger.info("RDP connect: host=%s user=%s domain=%s width=%s height=%s ignore-cert=%s cert-tofu=%s",
                    params.get("hostname"), params.get("username"), params.get("domain"),
                    params.get("width"), params.get("height"),
                    params.get("ignore-cert"), params.get("cert-tofu"))
        writer.write(_guac_encode("connect", *values))
        await writer.drain()

        # Step 4: receive ready instruction (NLA/TLS negotiation can take 10-30 s)
        ready = await asyncio.wait_for(_guac_read_instruction(reader, buf), timeout=45)
        logger.info("Guacamole RDP ready: %s  leftover_buf=%d bytes", ready[:80], len(buf))

        # Stop keepalive then deliver ready to browser
        handshake_done.set()
        keepalive_task.cancel()
        await websocket.send_text(ready)

        # Step 5: send display size now that the connection is established
        writer.write(_guac_encode("size", str(width), str(height), "96"))
        await writer.drain()

    except Exception as e:
        handshake_done.set()
        keepalive_task.cancel()
        logger.error("Guacamole RDP handshake failed for %s: %s", agent_id, e)
        try:
            await websocket.send_text(f'5.error,1.0,"RDP handshake failed: {e}";')
            await websocket.close()
        except Exception:
            pass
        writer.close()
        return

    # Bidirectional proxy: browser ↔ guacd
    stop_event = asyncio.Event()

    async def browser_to_guacd():
        try:
            while True:
                data = await websocket.receive_text()
                writer.write(data.encode("utf-8"))
                await writer.drain()
        except (WebSocketDisconnect, Exception):
            pass
        finally:
            stop_event.set()

    async def guacd_to_browser():
        try:
            # Drain any leftover handshake data first
            if buf:
                logger.info("Flushing leftover buf to browser: %s", buf[:200])
                await websocket.send_text(buf.decode("utf-8", errors="replace"))
                buf.clear()
            while True:
                try:
                    chunk = await asyncio.wait_for(reader.read(4096), timeout=5)
                except asyncio.TimeoutError:
                    continue  # keepalive handles the browser side; keep waiting on guacd
                if not chunk:
                    logger.info("guacd closed TCP connection for %s", agent_id)
                    break
                logger.debug("guacd→browser %d bytes: %s", len(chunk), chunk[:80])
                await websocket.send_text(chunk.decode("utf-8", errors="replace"))
        except (WebSocketDisconnect, Exception):
            pass
        finally:
            stop_event.set()

    async def keepalive():
        """Send Guacamole nop every 4s so the browser tunnel doesn't time out
        while guacd is doing the RDP/NLA handshake (can take 10-30s)."""
        try:
            while not stop_event.is_set():
                await asyncio.sleep(4)
                if stop_event.is_set():
                    break
                try:
                    await websocket.send_text("0.;")
                except Exception:
                    break
        except Exception:
            pass

    t1 = asyncio.create_task(browser_to_guacd())
    t2 = asyncio.create_task(guacd_to_browser())
    t3 = asyncio.create_task(keepalive())
    done, pending = await asyncio.wait([t1, t2], return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    t3.cancel()
    writer.close()


# ─── Credentials management ──────────────────────────────────────────────────

@router.get("/terminal/credentials/{agent_id}")
async def get_credentials(agent_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    row = await db.execute(text(
        "SELECT id, connect_type, username, port, winrm_port, domain, use_sudo, host_override, "
        "COALESCE(rdp_ignore_cert, FALSE) AS rdp_ignore_cert, "
        "CASE WHEN known_host_key IS NOT NULL THEN TRUE ELSE FALSE END AS has_known_host_key "
        "FROM agent_ssh_credentials WHERE agent_id = CAST(:id AS uuid)"
    ), {"id": agent_id})
    creds = row.fetchone()
    if not creds:
        return {"configured": False}
    return {
        "configured": True,
        "connect_type": creds[1], "username": creds[2],
        "port": creds[3], "winrm_port": creds[4],
        "domain": creds[5], "use_sudo": creds[6],
        "host_override": creds[7],
        "rdp_ignore_cert": creds[8],
        "has_known_host_key": creds[9],
    }


@router.post("/terminal/credentials/{agent_id}")
async def save_credentials(
    agent_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    # Upsert credentials
    existing = await db.execute(text(
        "SELECT id FROM agent_ssh_credentials WHERE agent_id = CAST(:id AS uuid)"
    ), {"id": agent_id})
    row = existing.fetchone()

    raw_password = body.get("password")
    raw_ssh_key = body.get("ssh_key")
    fields = {
        "connect_type": body.get("connect_type", "linux"),
        "username": body.get("username", ""),
        "password": _encrypt(raw_password) if raw_password else None,
        "ssh_key": _encrypt(raw_ssh_key) if raw_ssh_key else None,
        "port": body.get("port", 22),
        "winrm_port": body.get("winrm_port") or body.get("rdp_port") or 5985,
        "domain": body.get("domain"),
        "use_sudo": body.get("use_sudo", True),
        "host_override": body.get("host_override"),
        "rdp_ignore_cert": body.get("rdp_ignore_cert", False),
    }

    if row:
        # Don't overwrite password/ssh_key if not provided (blank = keep existing)
        update_fields = {k: v for k, v in fields.items()
                         if k not in ("password", "ssh_key") or v}
        set_parts = ", ".join(f"{k} = :{k}" for k in update_fields)
        await db.execute(text(
            f"UPDATE agent_ssh_credentials SET {set_parts}, updated_at = NOW() "
            f"WHERE agent_id = CAST(:agent_id AS uuid)"
        ), {**update_fields, "agent_id": agent_id})
    else:
        cols = ", ".join(fields.keys())
        vals = ", ".join(f":{k}" for k in fields.keys())
        await db.execute(text(
            f"INSERT INTO agent_ssh_credentials (agent_id, {cols}) "
            f"VALUES (CAST(:agent_id AS uuid), {vals})"
        ), {**fields, "agent_id": agent_id})

    await db.commit()
    return {"status": "saved"}


@router.delete("/terminal/credentials/{agent_id}/host-key")
async def clear_host_key(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Clear the stored SSH host key so the next connection performs fresh TOFU trust."""
    await db.execute(text(
        "UPDATE agent_ssh_credentials SET known_host_key = NULL "
        "WHERE agent_id = CAST(:id AS uuid)"
    ), {"id": agent_id})
    await db.commit()
    return {"status": "host key cleared"}
