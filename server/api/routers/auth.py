from fastapi import APIRouter, Depends, HTTPException, status, Request
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime, timezone, timedelta
from typing import List
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address

from api.database import get_db
from api.schemas.schemas import LoginRequest, TokenResponse, UserCreate, UserResponse
from api.services.auth import authenticate_user, create_access_token, hash_password, verify_password, get_user_by_username, get_current_user, require_admin, revoke_token, decode_token
from sqlalchemy import select
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from api.audit_log import audit
from api.models.models import User, AuditLog
from api.config import get_settings

settings = get_settings()
router = APIRouter(prefix="/auth", tags=["Authentication"])
limiter = Limiter(key_func=get_remote_address)


@router.post("/login", response_model=TokenResponse)
@limiter.limit("10/minute")
async def login(request: Request, body: LoginRequest, db: AsyncSession = Depends(get_db)):
    user = await authenticate_user(db, body.username, body.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password"
        )
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account is disabled")

    # Update last login
    user.last_login = datetime.now(timezone.utc)

    # Audit log
    log = AuditLog(
        user_id=user.id,
        action="user_login",
        resource_type="user",
        resource_id=str(user.id),
        ip_address=request.client.host if request.client else None,
    )
    db.add(log)
    await db.commit()

    audit("user_login", user_id=str(user.id), username=user.username,
          ip=request.client.host if request.client else None, result="success")
    token = create_access_token({"sub": str(user.id), "username": user.username, "role": user.role})
    return TokenResponse(
        access_token=token,
        expires_in=settings.access_token_expire_minutes * 60,
        user={"id": str(user.id), "username": user.username, "role": user.role, "full_name": user.full_name}
    )


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.put("/me/password")
async def change_own_password(
    body: ChangePasswordRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    pw = body.new_password
    if len(pw) < 12 or not any(c.isupper() for c in pw) or not any(c.isdigit() for c in pw) or not any(c in "!@#$%^&*()_+-=[]{}|;:,.<>?" for c in pw):
        raise HTTPException(status_code=400, detail="Password must be at least 12 characters and include uppercase, number, and special character")
    if not verify_password(body.current_password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    # Re-fetch user within this session so the UPDATE is tracked and committed
    result = await db.execute(select(User).where(User.id == current_user.id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.hashed_password = hash_password(body.new_password)
    await db.commit()
    return {"status": "ok"}


@router.post("/logout")
async def logout(
    credentials: HTTPAuthorizationCredentials = Depends(HTTPBearer()),
    _: User = Depends(get_current_user),
):
    """Revoke the current token so it cannot be reused after logout."""
    payload = decode_token(credentials.credentials)
    if payload:
        jti = payload.get("jti")
        exp = payload.get("exp")
        if jti and exp:
            await revoke_token(jti, exp)
    audit("user_logout", user_id=str(_.id), username=_.username)
    return {"status": "logged out"}


@router.get("/me")
async def get_me(current_user: User = Depends(get_current_user)):
    return {
        "id": str(current_user.id),
        "username": current_user.username,
        "email": current_user.email,
        "full_name": current_user.full_name,
        "role": current_user.role,
    }


@router.post("/users", response_model=UserResponse, status_code=201)
async def create_user(
    body: UserCreate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    # Only admins can create users; only admins can assign the admin role
    allowed_roles = {"admin", "operator", "viewer"}
    if body.role not in allowed_roles:
        raise HTTPException(status_code=400, detail=f"Invalid role. Must be one of: {', '.join(allowed_roles)}")

    existing = await get_user_by_username(db, body.username)
    if existing:
        raise HTTPException(status_code=409, detail="Username already exists")

    # Enforce minimum password complexity
    pw = body.password
    if len(pw) < 12 or not any(c.isupper() for c in pw) or not any(c.isdigit() for c in pw) or not any(c in "!@#$%^&*()_+-=[]{}|;:,.<>?" for c in pw):
        raise HTTPException(status_code=400, detail="Password must be at least 12 characters and include uppercase, number, and special character")

    user = User(
        username=body.username,
        email=body.email,
        full_name=body.full_name,
        hashed_password=hash_password(body.password),
        role=body.role,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@router.get("/users", response_model=List[UserResponse])
async def list_users(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    from sqlalchemy import select as sa_select
    result = await db.execute(sa_select(User).order_by(User.username))
    return result.scalars().all()


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    if str(current_user.id) == user_id:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")
    from sqlalchemy import select as sa_select
    result = await db.execute(sa_select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    await db.delete(user)
    await db.commit()
