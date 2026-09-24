"""
Command processor: parse, authenticate, dispatch, and confirm bot commands.
Platform-agnostic — returns a plain-text string to be sent back to the user.
"""
import asyncio
import logging
import re
from typing import Optional

from app import security, kifaa_client
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

HELP_TEXT = """📋 Kifaa Bot Commands:

🔐 Auth
  auth <PIN>    — Authenticate (required first)
  logout        — End your session

📊 Status
  agents [online|all]   — List agents
  agent <name>          — Agent details
  alerts [critical|all] — Active alerts
  compliance            — Compliance score
  patchstatus           — Patch compliance summary

🔧 Actions (require CONFIRM)
  patches <name>        — Pending patches for an agent
  patchscan <name>      — Trigger patch scan
  restart <name>        — Restart endpoint
  unlock <agent> <user> — Unlock AD account
  resetpassword <agent> <user> — Reset AD password
  service <agent> <svc> start|stop|restart

  CONFIRM / CANCEL — confirm or cancel a pending action
  help / menu     — show this list

<name> = hostname fragment (must match exactly one agent)"""

DESTRUCTIVE = {"restart", "unlock", "service", "resetpassword"}


def _normalize_wa(platform_id: str) -> str:
    """Strip @c.us suffix from WhatsApp IDs."""
    return platform_id.split("@")[0]


def _strip_teams_mention(text: str) -> str:
    """Remove <at>...</at> HTML from Teams messages."""
    return re.sub(r"<at>[^<]*</at>", "", text).strip()


async def _resolve_agent(fragment: str) -> tuple[Optional[dict], str]:
    """
    Returns (agent_dict, error_message).
    error_message is empty string on success.
    Prefers exact hostname match over partial match to avoid KNCAD vs KNCAD2 ambiguity.
    """
    try:
        agents = await kifaa_client.get_agents(hostname=fragment, limit=10)
    except Exception as e:
        return None, f"Error querying agents: {e}"

    if not agents:
        return None, f"No agent found matching '{fragment}'. Use 'agents' to list all."
    if len(agents) > 1:
        # Prefer exact case-insensitive match before declaring ambiguity
        exact = [a for a in agents if a.get('hostname', '').lower() == fragment.lower()
                 or (a.get('display_name') or '').lower() == fragment.lower()]
        if len(exact) == 1:
            return exact[0], ""
        names = "\n".join(f"  • {a['hostname']}" for a in agents)
        return None, f"Multiple agents match '{fragment}':\n{names}\nBe more specific."
    return agents[0], ""


async def process(platform: str, raw_platform_id: str, raw_text: str) -> str:
    """
    Main entry point. Returns reply text.
    platform: 'telegram' | 'whatsapp' | 'teams'
    """
    # Normalize platform_id
    platform_id = _normalize_wa(raw_platform_id) if platform == "whatsapp" else raw_platform_id

    # Strip Teams mentions
    text = _strip_teams_mention(raw_text) if platform == "teams" else raw_text.strip()

    # Strip leading /
    if text.startswith("/"):
        text = text[1:]

    parts = text.split()
    if not parts:
        return "Send 'help' for a list of commands."

    cmd = parts[0].lower()
    args = parts[1:]

    # ── CONFIRM / CANCEL (bypass all other checks) ───────────────────────────
    if cmd == "confirm":
        pending = await security.consume_confirmation(platform, platform_id)
        if not pending:
            return "No pending action to confirm (or it expired)."
        disp = await security.get_session_display_name(platform, platform_id)
        reply = await _execute_destructive(platform, platform_id, disp, pending["command"], pending["args"])
        await kifaa_client.write_audit(platform, platform_id, disp, "CONFIRM", pending["command"], "confirmed", pending["args"].get("agent_id"))
        return reply

    if cmd == "cancel":
        await security.cancel_confirmation(platform, platform_id)
        return "Pending action cancelled."

    # ── WHITELIST CHECK ───────────────────────────────────────────────────────
    try:
        user_info = await kifaa_client.check_user(platform, platform_id)
    except Exception as e:
        logger.error(f"check_user error: {e}")
        return "Service temporarily unavailable. Try again."

    if not user_info.get("allowed"):
        await kifaa_client.write_audit(platform, platform_id, platform_id, text[:200], cmd, "denied")
        return "You are not authorized to use this bot. Contact your IT administrator."

    display_name = user_info.get("display_name", platform_id)

    # ── AUTH command (special: no session needed) ─────────────────────────────
    if cmd == "auth":
        if not args:
            return "Usage: auth <PIN>"
        pin = args[0]

        # Check for brute-force lockout
        failures = await security.get_pin_failures(platform, platform_id)
        if failures >= settings.pin_fail_limit:
            await kifaa_client.write_audit(platform, platform_id, display_name, text[:200], "auth", "locked")
            return "Account temporarily locked due to too many failed PIN attempts. Contact your admin."

        try:
            result = await kifaa_client.verify_user(platform, platform_id, pin)
        except Exception as e:
            return f"Authentication error: {e}"

        if result.get("authenticated"):
            await security.create_session(platform, platform_id, result.get("display_name", display_name))
            await security.clear_pin_failures(platform, platform_id)
            await kifaa_client.write_audit(platform, platform_id, display_name, "auth", "auth", "success")
            return f"Authenticated. Welcome, {result.get('display_name', display_name)}! Session valid for 4 hours."
        else:
            count = await security.record_pin_failure(platform, platform_id)
            remaining = settings.pin_fail_limit - count
            await kifaa_client.write_audit(platform, platform_id, display_name, "auth", "auth", "denied")
            if remaining <= 0:
                return "Incorrect PIN. Account locked for 10 minutes."
            return f"Incorrect PIN. {remaining} attempt(s) remaining before lockout."

    # ── HELP (no session needed) ──────────────────────────────────────────────
    if cmd == "help":
        return HELP_TEXT

    # ── SESSION CHECK ─────────────────────────────────────────────────────────
    if not await security.session_exists(platform, platform_id):
        return "Not authenticated. Send: auth <YOUR_PIN>"

    # ── RATE LIMIT ────────────────────────────────────────────────────────────
    if not await security.check_rate_limit(platform, platform_id):
        return "Rate limit exceeded (5 commands/min). Wait a moment."

    # Refresh session TTL on activity
    await security.refresh_session(platform, platform_id)

    # ── LOGOUT ───────────────────────────────────────────────────────────────
    if cmd == "logout":
        await security.destroy_session(platform, platform_id)
        await kifaa_client.write_audit(platform, platform_id, display_name, "logout", "logout", "success")
        return "Session ended. Send 'auth <PIN>' to log in again."

    # ── READ COMMANDS ─────────────────────────────────────────────────────────
    if cmd == "agents":
        filter_status = args[0].lower() if args else "online"
        try:
            agents = await kifaa_client.get_agents(limit=20)
            if filter_status == "online":
                agents = [a for a in agents if a.get("status") == "online"]
            if not agents:
                reply = "No agents found."
            else:
                lines = [f"{'AGENT':<20} {'STATUS':<10} {'OS':<8} {'IP'}"]
                lines.append("-" * 55)
                for a in agents:
                    lines.append(f"{(a.get('display_name') or a.get('hostname',''))[:20]:<20} {a.get('status','?'):<10} {(a.get('os_type') or '')[:8]:<8} {a.get('ip_address','')}")
                reply = "\n".join(lines)
        except Exception as e:
            reply = f"Error: {e}"
        await kifaa_client.write_audit(platform, platform_id, display_name, text[:200], "agents", "success")
        return reply

    if cmd == "agent":
        if not args:
            return "Usage: agent <hostname_fragment>"
        agent, err = await _resolve_agent(args[0])
        if err:
            return err
        a = agent
        reply = (
            f"Agent: {a.get('display_name') or a.get('hostname')}\n"
            f"Hostname: {a.get('hostname')}\n"
            f"Status: {a.get('status', 'unknown')}\n"
            f"OS: {a.get('os_type', '?')}\n"
            f"IP: {a.get('ip_address', 'unknown')}\n"
            f"Last seen: {str(a.get('last_seen', 'unknown'))[:19]}"
        )
        await kifaa_client.write_audit(platform, platform_id, display_name, text[:200], "agent", "success", a["id"])
        return reply

    if cmd == "alerts":
        sev = args[0].lower() if args else None
        try:
            alerts = await kifaa_client.get_alerts(severity=sev if sev in ("critical", "warning", "info") else None)
            if not alerts:
                return "No open alerts."
            lines = [f"{'SEV':<10} {'AGENT':<18} MESSAGE"]
            lines.append("-" * 60)
            for al in alerts:
                lines.append(f"{al.get('severity','?'):<10} {(al.get('hostname') or '')[:18]:<18} {(al.get('message') or '')[:40]}")
            reply = "\n".join(lines)
        except Exception as e:
            reply = f"Error: {e}"
        await kifaa_client.write_audit(platform, platform_id, display_name, text[:200], "alerts", "success")
        return reply

    if cmd == "compliance":
        try:
            c = await kifaa_client.get_compliance()
            reply = (
                f"Compliance Summary\n"
                f"Overall:       {c.get('overall',0):.1f}%\n"
                f"Patching:      {c.get('patch',0):.1f}%\n"
                f"Vulnerability: {c.get('vuln',0):.1f}%\n"
                f"Configuration: {c.get('config',0):.1f}%\n"
                f"Protection:    {c.get('protection',0):.1f}%\n"
                f"Licensing:     {c.get('license',0):.1f}%\n"
                f"As of: {str(c.get('as_of','?'))[:10]}"
            )
        except Exception as e:
            reply = f"Error: {e}"
        await kifaa_client.write_audit(platform, platform_id, display_name, text[:200], "compliance", "success")
        return reply

    if cmd in ("patchstatus", "patch_status"):
        try:
            s = await kifaa_client.get_patch_summary()
            lines = [
                f"🩹 Patch Compliance Summary",
                f"Compliance:  {s.get('compliance_pct', 0):.1f}%",
                f"Agents:      {s.get('fully_patched', 0)}/{s.get('total_agents', 0)} fully patched",
                f"Pending:     {s.get('total_pending', 0)} total  |  {s.get('security_pending', 0)} security",
            ]
            top = s.get("top_agents", [])
            if top:
                lines.append("\nTop agents needing patches:")
                for a in top:
                    lines.append(f"  • {a['hostname'][:22]:<22} {a['total']} ({a['security']} sec)")
            reply = "\n".join(lines)
        except Exception as e:
            reply = f"Error: {e}"
        await kifaa_client.write_audit(platform, platform_id, display_name, text[:200], "patchstatus", "success")
        return reply

    if cmd == "patches":
        if not args:
            return "Usage: patches <hostname_fragment>"
        agent, err = await _resolve_agent(args[0])
        if err:
            return err
        try:
            patches = await kifaa_client.get_patches(str(agent["id"]))
            if not patches:
                return f"No pending patches for {agent.get('hostname')}."
            security_patches = [p for p in patches if (p.get("category") or "").lower() == "security"]
            other_patches = [p for p in patches if (p.get("category") or "").lower() != "security"]
            lines = [f"Pending patches for {agent.get('hostname')} ({len(patches)} total):"]
            if security_patches:
                lines.append(f"\nSECURITY ({len(security_patches)}):")
                for p in security_patches[:8]:
                    lines.append(f"  • {p.get('package_name','?')}")
            if other_patches:
                lines.append(f"\nOTHER ({len(other_patches)}):")
                for p in other_patches[:5]:
                    lines.append(f"  • {p.get('package_name','?')}")
            reply = "\n".join(lines)
        except Exception as e:
            reply = f"Error: {e}"
        await kifaa_client.write_audit(platform, platform_id, display_name, text[:200], "patches", "success", str(agent["id"]))
        return reply

    if cmd == "patchscan":
        if not args:
            return "Usage: patchscan <hostname_fragment>"
        agent, err = await _resolve_agent(args[0])
        if err:
            return err
        try:
            await kifaa_client.cmd_patch_scan(str(agent["id"]))
            reply = f"Patch scan queued for {agent.get('hostname')}. Results will appear in Kifaa within a few minutes."
        except Exception as e:
            reply = f"Error queuing scan: {e}"
        await kifaa_client.write_audit(platform, platform_id, display_name, text[:200], "patchscan", "success", str(agent["id"]))
        return reply

    # ── DESTRUCTIVE COMMANDS ──────────────────────────────────────────────────
    if cmd == "restart":
        if not args:
            return "Usage: restart <hostname_fragment>"
        agent, err = await _resolve_agent(args[0])
        if err:
            return err
        return await _queue_destructive(platform, platform_id, display_name, text, "restart",
                                        {"agent_id": str(agent["id"]), "hostname": agent.get("hostname")},
                                        f"restart {agent.get('hostname')}")

    if cmd == "unlock":
        if len(args) < 2:
            return "Usage: unlock <agent_hostname_fragment> <ad_username>"
        agent, err = await _resolve_agent(args[0])
        if err:
            return err
        username = args[1]
        return await _queue_destructive(platform, platform_id, display_name, text, "unlock",
                                        {"agent_id": str(agent["id"]), "hostname": agent.get("hostname"), "username": username},
                                        f"unlock AD user '{username}' via {agent.get('hostname')}")

    if cmd in ("resetpassword", "reset_password", "resetpw"):
        if len(args) < 2:
            return "Usage: resetpassword <agent_hostname_fragment> <ad_username>"
        agent, err = await _resolve_agent(args[0])
        if err:
            return err
        username = args[1]
        return await _queue_destructive(platform, platform_id, display_name, text, "resetpassword",
                                        {"agent_id": str(agent["id"]), "hostname": agent.get("hostname"), "username": username},
                                        f"reset AD password for '{username}' via {agent.get('hostname')}")

    if cmd == "service":
        if len(args) < 3:
            return "Usage: service <hostname_fragment> <service_name> start|stop|restart"
        agent, err = await _resolve_agent(args[0])
        if err:
            return err
        svc_name = args[1]
        action = args[2].lower()
        if action not in ("start", "stop", "restart"):
            return "Action must be start, stop, or restart."
        return await _queue_destructive(platform, platform_id, display_name, text, "service",
                                        {"agent_id": str(agent["id"]), "hostname": agent.get("hostname"),
                                         "service_name": svc_name, "action": action},
                                        f"{action} service '{svc_name}' on {agent.get('hostname')}")

    await kifaa_client.write_audit(platform, platform_id, display_name, text[:200], cmd, "unknown_command")
    return f"Unknown command: '{cmd}'. Send 'help' for a list."


async def _queue_destructive(platform: str, platform_id: str, display_name: str, raw_text: str,
                              command: str, cmd_args: dict, description: str) -> str:
    await security.store_confirmation(platform, platform_id, command, cmd_args)
    await kifaa_client.write_audit(platform, platform_id, display_name, raw_text[:200], command, "pending_confirm", cmd_args.get("agent_id"))
    return f"About to: {description}\n\nReply CONFIRM within 60 seconds to proceed, or CANCEL to abort."


async def _send_platform_message(platform: str, platform_id: str, message: str):
    """Send a proactive message to a user on any supported platform."""
    try:
        if platform == "telegram":
            from app.platforms.telegram import get_telegram_app
            app = get_telegram_app()
            if app:
                await app.bot.send_message(chat_id=int(platform_id), text=message)
        elif platform == "whatsapp":
            from app.platforms.whatsapp import send_whatsapp
            await send_whatsapp(platform_id, message)
        else:
            logger.warning(f"Cannot send proactive message on platform: {platform}")
    except Exception as e:
        logger.error(f"Failed to send follow-up message to {platform}/{platform_id}: {e}")


async def _poll_ad_action(platform: str, platform_id: str, action_id: str,
                           success_msg: str, fail_prefix: str):
    """Poll an AD action and notify the user when done."""
    interval = 4
    max_attempts = 23
    for attempt in range(max_attempts):
        await asyncio.sleep(interval)
        try:
            result = await kifaa_client.poll_ad_action_status(action_id)
            status = result.get("status", "pending")
            if status == "completed":
                await _send_platform_message(platform, platform_id, f"✓ {success_msg}")
                return
            elif status == "failed":
                error = result.get("error") or "Unknown error"
                await _send_platform_message(platform, platform_id, f"✗ {fail_prefix}\nError: {error}")
                return
        except Exception as e:
            logger.error(f"_poll_ad_action error (attempt {attempt + 1}): {e}")
    await _send_platform_message(platform, platform_id,
        f"{fail_prefix} — timed out. Check Active Directory section in Kifaa.")


async def _poll_unlock_result(platform: str, platform_id: str, action_id: str, username: str, hostname: str):
    """Background task: poll for unlock result and notify user when done."""
    interval = 4  # seconds between polls
    max_attempts = 23  # ~90 seconds total

    for attempt in range(max_attempts):
        await asyncio.sleep(interval)
        try:
            result = await kifaa_client.poll_unlock_status(action_id)
            status = result.get("status", "pending")

            if status == "completed":
                await _send_platform_message(
                    platform, platform_id,
                    f"✓ User '{username}' has been successfully unlocked via {hostname}."
                )
                return
            elif status == "failed":
                error = result.get("error_message") or "Unknown error"
                await _send_platform_message(
                    platform, platform_id,
                    f"✗ Failed to unlock user '{username}' via {hostname}.\nError: {error}"
                )
                return
            # status == 'pending' → keep waiting
        except Exception as e:
            logger.error(f"poll_unlock_result error (attempt {attempt + 1}): {e}")

    # Timed out
    await _send_platform_message(
        platform, platform_id,
        f"Unlock result for '{username}' via {hostname} is taking longer than expected. "
        f"Check the Active Directory section in Kifaa for the current status."
    )


async def _execute_destructive(platform: str, platform_id: str, display_name: str, command: str, cmd_args: dict) -> str:
    try:
        if command == "restart":
            await kifaa_client.cmd_restart(cmd_args["agent_id"])
            return f"Restart command sent to {cmd_args.get('hostname')}. The machine will restart in ~30 seconds."

        elif command == "unlock":
            result = await kifaa_client.cmd_unlock_user(cmd_args["agent_id"], cmd_args["username"])
            action_id = result.get("action_id")
            username = cmd_args["username"]
            hostname = cmd_args.get("hostname", "agent")
            if action_id:
                asyncio.create_task(_poll_unlock_result(platform, platform_id, action_id, username, hostname))
                return (
                    f"Unlock command queued for '{username}' via {hostname}.\n"
                    f"I'll send you a follow-up message once the agent processes it (usually within 30 seconds)."
                )
            return f"Unlock command sent for user '{username}' via {hostname}."

        elif command == "resetpassword":
            result = await kifaa_client.cmd_reset_password(cmd_args["agent_id"], cmd_args["username"])
            action_id = result.get("action_id")
            temp_pw = result.get("temp_password", "")
            username = cmd_args["username"]
            hostname = cmd_args.get("hostname", "agent")
            msg = (
                f"🔑 Password reset queued for '{username}' via {hostname}.\n"
                f"Temporary password: `{temp_pw}`\n"
                f"User must change it on next login.\n"
                f"I'll confirm once the agent processes it."
            )
            if action_id:
                asyncio.create_task(_poll_ad_action(
                    platform, platform_id, action_id,
                    f"Password for '{username}' has been reset successfully.",
                    f"Password reset for '{username}' failed",
                ))
            return msg

        elif command == "service":
            await kifaa_client.cmd_service(cmd_args["agent_id"], cmd_args["service_name"], cmd_args["action"])
            return f"Service '{cmd_args['service_name']}' {cmd_args['action']} command sent to {cmd_args.get('hostname')}."

        return "Unknown command type."
    except Exception as e:
        return f"Command failed: {e}. Check Kifaa for details."
