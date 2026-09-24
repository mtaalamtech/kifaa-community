"""
Security helpers: session management, PIN auth, rate limiting, HMAC verification.
All session/rate data stored in Redis DB 3.
"""
import hashlib
import hmac
import base64
import json
import logging
from typing import Optional

import redis.asyncio as aioredis

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

_redis: Optional[aioredis.Redis] = None


def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _redis


# ── Session management ─────────────────────────────────────────────────────────

async def session_exists(platform: str, platform_id: str) -> bool:
    r = get_redis()
    key = f"bot:session:{platform}:{platform_id}"
    return bool(await r.exists(key))


async def create_session(platform: str, platform_id: str, display_name: str):
    r = get_redis()
    key = f"bot:session:{platform}:{platform_id}"
    data = json.dumps({"display_name": display_name, "authenticated": True})
    await r.setex(key, settings.session_ttl, data)


async def refresh_session(platform: str, platform_id: str):
    r = get_redis()
    key = f"bot:session:{platform}:{platform_id}"
    await r.expire(key, settings.session_ttl)


async def get_session_display_name(platform: str, platform_id: str) -> str:
    r = get_redis()
    key = f"bot:session:{platform}:{platform_id}"
    raw = await r.get(key)
    if raw:
        try:
            return json.loads(raw).get("display_name", platform_id)
        except Exception:
            pass
    return platform_id


async def destroy_session(platform: str, platform_id: str):
    r = get_redis()
    await r.delete(f"bot:session:{platform}:{platform_id}")


# ── Rate limiting ──────────────────────────────────────────────────────────────

async def check_rate_limit(platform: str, platform_id: str) -> bool:
    """Returns True if allowed, False if rate limited."""
    r = get_redis()
    key = f"bot:ratelimit:{platform}:{platform_id}"
    count = await r.incr(key)
    if count == 1:
        await r.expire(key, 60)
    return count <= settings.rate_limit


# ── PIN failure tracking ───────────────────────────────────────────────────────

async def record_pin_failure(platform: str, platform_id: str) -> int:
    """Increment failure counter. Returns new count."""
    r = get_redis()
    key = f"bot:authfail:{platform}:{platform_id}"
    count = await r.incr(key)
    if count == 1:
        await r.expire(key, settings.pin_fail_window)
    return count


async def clear_pin_failures(platform: str, platform_id: str):
    r = get_redis()
    await r.delete(f"bot:authfail:{platform}:{platform_id}")


async def get_pin_failures(platform: str, platform_id: str) -> int:
    r = get_redis()
    val = await r.get(f"bot:authfail:{platform}:{platform_id}")
    return int(val) if val else 0


# ── Pending confirmations ──────────────────────────────────────────────────────

async def store_confirmation(platform: str, platform_id: str, command: str, args: dict):
    r = get_redis()
    key = f"bot:confirm:{platform}:{platform_id}"
    data = json.dumps({"command": command, "args": args})
    await r.setex(key, settings.confirm_ttl, data)


async def consume_confirmation(platform: str, platform_id: str) -> Optional[dict]:
    """Returns the pending command dict if confirmation exists, else None."""
    r = get_redis()
    key = f"bot:confirm:{platform}:{platform_id}"
    raw = await r.getdel(key)
    if raw:
        try:
            return json.loads(raw)
        except Exception:
            pass
    return None


async def cancel_confirmation(platform: str, platform_id: str):
    r = get_redis()
    await r.delete(f"bot:confirm:{platform}:{platform_id}")


async def has_pending_confirmation(platform: str, platform_id: str) -> bool:
    r = get_redis()
    return bool(await r.exists(f"bot:confirm:{platform}:{platform_id}"))


# ── Teams HMAC verification ────────────────────────────────────────────────────

def verify_teams_hmac(body_bytes: bytes, auth_header: str) -> bool:
    """
    Teams sends: Authorization: HMAC <base64(HMAC-SHA256(secret_bytes, body_bytes))>
    The secret is base64-encoded when Teams provides it; decode before use.
    """
    secret_b64 = settings.teams_hmac_secret
    if not secret_b64:
        logger.warning("TEAMS_HMAC_SECRET not configured — rejecting Teams request")
        return False
    if not auth_header or not auth_header.startswith("HMAC "):
        return False

    received = auth_header[5:]  # strip "HMAC "
    try:
        secret_bytes = base64.b64decode(secret_b64)
        expected_bytes = hmac.new(secret_bytes, body_bytes, hashlib.sha256).digest()
        expected_b64 = base64.b64encode(expected_bytes).decode()
        return hmac.compare_digest(expected_b64, received)
    except Exception as e:
        logger.error(f"HMAC verification error: {e}")
        return False
