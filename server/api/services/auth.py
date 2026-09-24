import secrets
import hashlib
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from jose import JWTError, jwt
import bcrypt as _bcrypt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from api.config import get_settings
from api.models.models import User, Agent

_bearer = HTTPBearer(auto_error=False)

settings = get_settings()


def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        return _bcrypt.checkpw(plain_password.encode(), hashed_password.encode())
    except Exception:
        return False


def hash_password(password: str) -> str:
    return _bcrypt.hashpw(password.encode(), _bcrypt.gensalt(rounds=12)).decode()


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.access_token_expire_minutes)
    )
    to_encode.update({
        "exp": expire,
        "jti": str(uuid.uuid4()),  # unique token ID for blacklisting on logout
    })
    return jwt.encode(to_encode, settings.api_secret_key, algorithm=settings.api_algorithm)


def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, settings.api_secret_key, algorithms=[settings.api_algorithm])
    except JWTError:
        return None


async def _get_redis():
    """Return an aioredis client. Returns None if Redis is unavailable."""
    try:
        import redis.asyncio as aioredis
        return aioredis.from_url(settings.redis_url, decode_responses=True)
    except Exception:
        return None


async def revoke_token(jti: str, exp: int) -> None:
    """Add a token's JTI to the Redis blacklist, expiring when the token would have."""
    r = await _get_redis()
    if not r:
        return
    try:
        remaining = max(1, exp - int(datetime.now(timezone.utc).timestamp()))
        await r.setex(f"blacklist:{jti}", remaining, "1")
    except Exception:
        pass
    finally:
        await r.aclose()


async def is_token_revoked(jti: str) -> bool:
    """Return True if this token has been explicitly revoked (logged out)."""
    r = await _get_redis()
    if not r:
        return False
    try:
        return bool(await r.exists(f"blacklist:{jti}"))
    except Exception:
        return False
    finally:
        await r.aclose()


def generate_api_key() -> str:
    return secrets.token_urlsafe(48)


async def get_user_by_username(db: AsyncSession, username: str) -> Optional[User]:
    result = await db.execute(select(User).where(User.username == username))
    return result.scalar_one_or_none()


async def authenticate_user(db: AsyncSession, username: str, password: str) -> Optional[User]:
    user = await get_user_by_username(db, username)
    if not user or not verify_password(password, user.hashed_password):
        return None
    return user


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> User:
    """FastAPI dependency — validates Bearer JWT and returns the authenticated User."""
    from api.database import AsyncSessionLocal  # local import to avoid circular
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    payload = decode_token(credentials.credentials)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    # Check token blacklist (logout revocation)
    jti = payload.get("jti")
    if jti and await is_token_revoked(jti):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token has been revoked")
    user_id: str = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token payload")
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


async def require_operator(user: User = Depends(get_current_user)) -> User:
    """Require at least operator role (operator or admin). Viewers are read-only."""
    if user.role not in ("admin", "operator"):
        raise HTTPException(status_code=403, detail="Operator or admin access required")
    return user


async def get_agent_by_api_key(db: AsyncSession, api_key: str) -> Optional[Agent]:
    result = await db.execute(
        select(Agent).where(Agent.api_key == api_key, Agent.is_active == True)
    )
    return result.scalar_one_or_none()
