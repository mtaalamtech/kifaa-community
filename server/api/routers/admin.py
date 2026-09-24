from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from typing import Optional
from datetime import datetime, timezone

from api.database import get_db
from api.models.models import User, AuditLog
from api.services.auth import require_admin, get_current_user, hash_password

router = APIRouter(prefix="/admin", tags=["Admin"])

# ── Predefined roles with permission descriptions ──────────────────────────────
ROLES = {
    "admin": {
        "name": "Administrator",
        "description": "Full access to all features including user management, system settings, and configuration.",
        "permissions": [
            "users.view", "users.create", "users.edit", "users.delete",
            "agents.view", "agents.manage", "agents.deploy",
            "monitors.view", "monitors.manage",
            "alerts.view", "alerts.manage",
            "settings.view", "settings.edit",
            "admin.access",
        ],
        "editable": False,
    },
    "operator": {
        "name": "Operator",
        "description": "Can manage agents, monitors, and alerts. Cannot manage users or system settings.",
        "permissions": [
            "agents.view", "agents.manage", "agents.deploy",
            "monitors.view", "monitors.manage",
            "alerts.view", "alerts.manage",
        ],
        "editable": False,
    },
    "viewer": {
        "name": "Viewer",
        "description": "Read-only access to agents, monitors, and alerts.",
        "permissions": [
            "agents.view",
            "monitors.view",
            "alerts.view",
        ],
        "editable": False,
    },
}


# ── Users ──────────────────────────────────────────────────────────────────────

@router.get("/users")
async def list_users(db: AsyncSession = Depends(get_db), _=Depends(require_admin)):
    result = await db.execute(select(User).order_by(User.created_at.asc()))
    users = result.scalars().all()
    return [_user_dict(u) for u in users]


@router.post("/users", status_code=201)
async def create_user(
    body: dict,
    db: AsyncSession = Depends(get_db),
    admin=Depends(require_admin),
):
    username = body.get("username", "").strip()
    email = body.get("email", "").strip()
    password = body.get("password", "")

    if not username or not email or not password:
        raise HTTPException(400, "username, email and password are required")
    if len(password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")

    existing = await db.execute(select(User).where(User.username == username))
    if existing.scalar_one_or_none():
        raise HTTPException(409, "Username already exists")

    existing_email = await db.execute(select(User).where(User.email == email))
    if existing_email.scalar_one_or_none():
        raise HTTPException(409, "Email already in use")

    role = body.get("role", "viewer")
    if role not in ROLES:
        raise HTTPException(400, f"Invalid role. Choose from: {', '.join(ROLES.keys())}")

    # Capture admin_id as a plain value — admin is a detached SQLAlchemy object
    # from get_current_user's own closed session; accessing .id is safe but
    # passing the object itself to AuditLog could trigger lazy-load errors
    admin_id = admin.id

    user = User(
        username=username,
        email=email,
        full_name=body.get("full_name", ""),
        hashed_password=hash_password(password),
        role=role,
        is_active=body.get("is_active", True),
    )
    db.add(user)
    await db.flush()  # assign user.id before audit log references it

    db.add(AuditLog(
        user_id=admin_id,
        action="user_created",
        resource_type="user",
        resource_id=username,
        details={"role": role},
    ))
    await db.commit()
    await db.refresh(user)
    return _user_dict(user)


@router.put("/users/{user_id}")
async def update_user(
    user_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    admin=Depends(require_admin),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(404, "User not found")

    if "full_name" in body:
        user.full_name = body["full_name"]
    if "email" in body:
        # Check uniqueness
        dup = await db.execute(
            select(User).where(User.email == body["email"], User.id != user_id)
        )
        if dup.scalar_one_or_none():
            raise HTTPException(409, "Email already in use")
        user.email = body["email"]
    if "role" in body:
        if body["role"] not in ROLES:
            raise HTTPException(400, f"Invalid role")
        # Prevent removing last admin
        if user.role == "admin" and body["role"] != "admin":
            count = await db.execute(
                select(func.count(User.id)).where(User.role == "admin", User.is_active == True)
            )
            if (count.scalar() or 0) <= 1:
                raise HTTPException(400, "Cannot demote the last active admin")
        user.role = body["role"]
    if "is_active" in body:
        if not body["is_active"] and user.role == "admin":
            count = await db.execute(
                select(func.count(User.id)).where(User.role == "admin", User.is_active == True)
            )
            if (count.scalar() or 0) <= 1:
                raise HTTPException(400, "Cannot disable the last active admin")
        user.is_active = body["is_active"]

    db.add(AuditLog(
        user_id=admin.id,
        action="user_updated",
        resource_type="user",
        resource_id=str(user.id),
    ))
    await db.commit()
    return _user_dict(user)


@router.post("/users/{user_id}/reset-password")
async def reset_password(
    user_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    admin=Depends(require_admin),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(404, "User not found")

    password = body.get("password", "")
    if len(password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")

    user.hashed_password = hash_password(password)
    db.add(AuditLog(
        user_id=admin.id,
        action="password_reset",
        resource_type="user",
        resource_id=str(user.id),
    ))
    await db.commit()
    return {"ok": True}


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    admin=Depends(require_admin),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(404, "User not found")
    if str(user.id) == str(admin.id):
        raise HTTPException(400, "Cannot delete your own account")
    if user.role == "admin":
        count = await db.execute(
            select(func.count(User.id)).where(User.role == "admin", User.is_active == True)
        )
        if (count.scalar() or 0) <= 1:
            raise HTTPException(400, "Cannot delete the last active admin")
    await db.delete(user)
    await db.commit()


# ── Roles ──────────────────────────────────────────────────────────────────────

@router.get("/roles")
async def list_roles(_=Depends(require_admin)):
    return [{"role": k, **v} for k, v in ROLES.items()]


# ── Stats for admin dashboard ──────────────────────────────────────────────────

@router.get("/stats")
async def admin_stats(db: AsyncSession = Depends(get_db), _=Depends(require_admin)):
    total_users = await db.execute(select(func.count(User.id)))
    active_users = await db.execute(select(func.count(User.id)).where(User.is_active == True))
    by_role = {}
    for role in ROLES:
        cnt = await db.execute(select(func.count(User.id)).where(User.role == role))
        by_role[role] = cnt.scalar() or 0
    return {
        "total_users": total_users.scalar() or 0,
        "active_users": active_users.scalar() or 0,
        "by_role": by_role,
    }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _user_dict(u: User) -> dict:
    return {
        "id": str(u.id),
        "username": u.username,
        "email": u.email,
        "full_name": u.full_name,
        "role": u.role,
        "is_active": u.is_active,
        "created_at": u.created_at.isoformat() if u.created_at else None,
        "last_login": u.last_login.isoformat() if u.last_login else None,
    }
