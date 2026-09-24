"""
HTTP client for the Kifaa internal bot API.
All calls use X-Bot-Secret header — no JWT required.
"""
import logging
from typing import Optional

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

_BASE = settings.kifaa_api_url.rstrip("/") + "/api/v1/bot"
_HEADERS = {"X-Bot-Secret": settings.bot_secret}
_TIMEOUT = 10.0


async def _get(path: str, params: dict = None):
    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        r = await c.get(_BASE + path, params=params, headers=_HEADERS)
        r.raise_for_status()
        return r.json()


async def _post(path: str, body: dict = None):
    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        r = await c.post(_BASE + path, json=body or {}, headers=_HEADERS)
        r.raise_for_status()
        return r.json()


async def verify_user(platform: str, platform_id: str, pin: str) -> dict:
    return await _post("/internal/verify-user", {"platform": platform, "platform_id": platform_id, "pin": pin})


async def check_user(platform: str, platform_id: str) -> dict:
    return await _get("/internal/check-user", {"platform": platform, "platform_id": platform_id})


async def write_audit(platform: str, platform_id: str, display_name: str, command: str,
                      parsed_command: str, result: str, agent_id: Optional[str] = None, detail: dict = None):
    try:
        await _post("/internal/audit", {
            "platform": platform, "platform_id": platform_id, "display_name": display_name,
            "command": command, "parsed_command": parsed_command, "result": result,
            "agent_id": agent_id, "detail": detail or {},
        })
    except Exception as e:
        logger.warning(f"Audit write failed: {e}")


async def get_agents(hostname: Optional[str] = None, limit: int = 5) -> list:
    params = {"limit": limit}
    if hostname:
        params["hostname"] = hostname
    return await _get("/internal/agents", params)


async def get_alerts(severity: Optional[str] = None, limit: int = 10) -> list:
    params = {"limit": limit}
    if severity:
        params["severity"] = severity
    return await _get("/internal/alerts", params)


async def get_compliance() -> dict:
    return await _get("/internal/compliance")


async def get_patches(agent_id: str) -> list:
    return await _get(f"/internal/patches/{agent_id}")


async def cmd_restart(agent_id: str) -> dict:
    return await _post("/internal/command/restart", {"agent_id": agent_id})


async def cmd_patch_scan(agent_id: str) -> dict:
    return await _post("/internal/command/patch-scan", {"agent_id": agent_id})


async def cmd_service(agent_id: str, service_name: str, action: str) -> dict:
    return await _post("/internal/command/service-control", {
        "agent_id": agent_id, "service_name": service_name, "action": action
    })


async def cmd_unlock_user(agent_id: str, username: str) -> dict:
    """Returns {"status": "queued", "action_id": "..."}"""
    return await _post("/internal/command/unlock-user", {"agent_id": agent_id, "username": username})


async def poll_unlock_status(action_id: str) -> dict:
    """Returns {"status": "pending"|"completed"|"failed", "error": "..."}"""
    return await _get(f"/internal/command/unlock-status/{action_id}")


async def cmd_reset_password(agent_id: str, username: str) -> dict:
    """Reset AD password. Returns {"status","action_id","temp_password"}"""
    return await _post("/internal/command/reset-password", {"agent_id": agent_id, "username": username})


async def poll_ad_action_status(action_id: str) -> dict:
    return await _get(f"/internal/command/ad-action-status/{action_id}")


async def get_patch_summary() -> dict:
    return await _get("/internal/patch-summary")
