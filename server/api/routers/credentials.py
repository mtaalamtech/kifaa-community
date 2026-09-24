from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, text

from api.database import get_db
from api.models.models import DeployCredential
from api.services.auth import get_current_user

router = APIRouter(prefix="/credentials", tags=["Credentials"])

_INIT_SQL = """
CREATE TABLE IF NOT EXISTS deploy_credentials (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(100) NOT NULL,
    description TEXT,
    os_type     VARCHAR(20)  DEFAULT 'any',
    username    VARCHAR(100) NOT NULL,
    password    TEXT,
    ssh_key     TEXT,
    domain      VARCHAR(100),
    port        INTEGER,
    use_sudo    BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ
);
"""

_initialized = False


async def _ensure_table(db: AsyncSession):
    global _initialized
    if _initialized:
        return
    await db.execute(text(_INIT_SQL))
    await db.commit()
    _initialized = True


def _safe(cred: DeployCredential) -> dict:
    """Return credential dict without sensitive fields."""
    return {
        "id":          str(cred.id),
        "name":        cred.name,
        "description": cred.description,
        "os_type":     cred.os_type,
        "username":    cred.username,
        "domain":      cred.domain,
        "port":        cred.port,
        "use_sudo":    cred.use_sudo,
        "has_password": bool(cred.password),
        "has_ssh_key":  bool(cred.ssh_key),
        "created_at":  cred.created_at.isoformat() if cred.created_at else None,
        "updated_at":  cred.updated_at.isoformat() if cred.updated_at else None,
    }


@router.get("")
async def list_credentials(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_table(db)
    result = await db.execute(select(DeployCredential).order_by(DeployCredential.created_at))
    return [_safe(c) for c in result.scalars().all()]


@router.post("", status_code=201)
async def create_credential(body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_table(db)
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "name is required")
    username = (body.get("username") or "").strip()
    if not username:
        raise HTTPException(400, "username is required")

    cred = DeployCredential(
        name=name,
        description=body.get("description"),
        os_type=body.get("os_type", "any"),
        username=username,
        password=body.get("password") or None,
        ssh_key=body.get("ssh_key") or None,
        domain=body.get("domain") or None,
        port=body.get("port") or None,
        use_sudo=bool(body.get("use_sudo", False)),
    )
    db.add(cred)
    await db.commit()
    await db.refresh(cred)
    return _safe(cred)


@router.put("/{cred_id}")
async def update_credential(cred_id: str, body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_table(db)
    result = await db.execute(select(DeployCredential).where(DeployCredential.id == cred_id))
    cred = result.scalar_one_or_none()
    if not cred:
        raise HTTPException(404, "Credential not found")

    if "name" in body:
        cred.name = (body["name"] or "").strip() or cred.name
    if "description" in body:
        cred.description = body["description"]
    if "os_type" in body:
        cred.os_type = body["os_type"]
    if "username" in body:
        cred.username = (body["username"] or "").strip() or cred.username
    if "domain" in body:
        cred.domain = body["domain"] or None
    if "port" in body:
        cred.port = body["port"] or None
    if "use_sudo" in body:
        cred.use_sudo = bool(body["use_sudo"])
    # Only update secrets if explicitly provided (non-empty string)
    if body.get("password"):
        cred.password = body["password"]
    if body.get("ssh_key"):
        cred.ssh_key = body["ssh_key"]
    # Allow clearing secrets with explicit empty string
    if body.get("clear_password"):
        cred.password = None
    if body.get("clear_ssh_key"):
        cred.ssh_key = None

    await db.commit()
    await db.refresh(cred)
    return _safe(cred)


@router.delete("/{cred_id}", status_code=204)
async def delete_credential(cred_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_table(db)
    result = await db.execute(select(DeployCredential).where(DeployCredential.id == cred_id))
    cred = result.scalar_one_or_none()
    if not cred:
        raise HTTPException(404, "Credential not found")
    await db.delete(cred)
    await db.commit()


@router.get("/{cred_id}/secret")
async def get_credential_secret(cred_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    """Return credential including secrets — only called by deployment flow."""
    await _ensure_table(db)
    result = await db.execute(select(DeployCredential).where(DeployCredential.id == cred_id))
    cred = result.scalar_one_or_none()
    if not cred:
        raise HTTPException(404, "Credential not found")
    return {
        **_safe(cred),
        "password": cred.password or "",
        "ssh_key":  cred.ssh_key or "",
    }
