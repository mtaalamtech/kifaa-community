from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from typing import Optional
import uuid

from api.database import get_db
from api.services.auth import get_current_user

router = APIRouter(prefix="/groups", tags=["Groups"])


# ─── List all groups ─────────────────────────
@router.get("")
async def list_groups(db: AsyncSession = Depends(get_db)):
    rows = await db.execute(text("""
        SELECT
            g.id::text,
            g.name,
            g.description,
            g.color,
            g.created_at,
            COUNT(DISTINCT a.id) AS agent_count,
            COUNT(DISTINCT m.id) AS monitor_count
        FROM agent_groups g
        LEFT JOIN agents a ON a.group_id = g.id AND a.is_active = TRUE
        LEFT JOIN monitors m ON m.group_id = g.id
        GROUP BY g.id, g.name, g.description, g.color, g.created_at
        ORDER BY g.name
    """))
    cols = ["id", "name", "description", "color", "created_at", "agent_count", "monitor_count"]
    result = []
    for row in rows.fetchall():
        d = dict(zip(cols, row))
        d["agent_count"] = int(d["agent_count"] or 0)
        d["monitor_count"] = int(d["monitor_count"] or 0)
        d["created_at"] = d["created_at"].isoformat() if d["created_at"] else None
        result.append(d)
    return result


# ─── Create group ────────────────────────────
@router.post("", status_code=201)
async def create_group(body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    description = body.get("description") or None
    color = body.get("color", "#3B82F6")

    # check uniqueness
    existing = await db.execute(
        text("SELECT id FROM agent_groups WHERE name = :name"),
        {"name": name},
    )
    if existing.fetchone():
        raise HTTPException(status_code=409, detail="Group name already exists")

    new_id = str(uuid.uuid4())
    await db.execute(
        text("INSERT INTO agent_groups (id, name, description, color) VALUES (:id, :name, :desc, :color)"),
        {"id": new_id, "name": name, "desc": description, "color": color},
    )
    await db.commit()

    row = await db.execute(
        text("SELECT id::text, name, description, color, created_at FROM agent_groups WHERE id = :id"),
        {"id": new_id},
    )
    row = row.fetchone()
    cols = ["id", "name", "description", "color", "created_at"]
    d = dict(zip(cols, row))
    d["created_at"] = d["created_at"].isoformat() if d["created_at"] else None
    d["agent_count"] = 0
    d["monitor_count"] = 0
    return d


# ─── Update group ────────────────────────────
@router.put("/{group_id}")
async def update_group(group_id: str, body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    existing = await db.execute(
        text("SELECT id FROM agent_groups WHERE id = :id"),
        {"id": group_id},
    )
    if not existing.fetchone():
        raise HTTPException(status_code=404, detail="Group not found")

    updates = {}
    if "name" in body:
        updates["name"] = body["name"].strip()
    if "description" in body:
        updates["description"] = body["description"] or None
    if "color" in body:
        updates["color"] = body["color"]

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    set_clause = ", ".join(f"{k} = :{k}" for k in updates)
    await db.execute(
        text(f"UPDATE agent_groups SET {set_clause} WHERE id = :group_id"),
        {**updates, "group_id": group_id},
    )
    await db.commit()

    row = await db.execute(
        text("""
            SELECT g.id::text, g.name, g.description, g.color, g.created_at,
                   COUNT(DISTINCT a.id) AS agent_count,
                   COUNT(DISTINCT m.id) AS monitor_count
            FROM agent_groups g
            LEFT JOIN agents a ON a.group_id = g.id AND a.is_active = TRUE
            LEFT JOIN monitors m ON m.group_id = g.id
            WHERE g.id = :id
            GROUP BY g.id, g.name, g.description, g.color, g.created_at
        """),
        {"id": group_id},
    )
    row = row.fetchone()
    cols = ["id", "name", "description", "color", "created_at", "agent_count", "monitor_count"]
    d = dict(zip(cols, row))
    d["agent_count"] = int(d["agent_count"] or 0)
    d["monitor_count"] = int(d["monitor_count"] or 0)
    d["created_at"] = d["created_at"].isoformat() if d["created_at"] else None
    return d


# ─── Delete group ────────────────────────────
@router.delete("/{group_id}", status_code=204)
async def delete_group(group_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    existing = await db.execute(
        text("SELECT id FROM agent_groups WHERE id = :id"),
        {"id": group_id},
    )
    if not existing.fetchone():
        raise HTTPException(status_code=404, detail="Group not found")

    # Set group_id=NULL for all member agents
    await db.execute(
        text("UPDATE agents SET group_id = NULL WHERE group_id = :id"),
        {"id": group_id},
    )
    # Set group_id=NULL for monitors
    await db.execute(
        text("UPDATE monitors SET group_id = NULL WHERE group_id = :id"),
        {"id": group_id},
    )
    await db.execute(
        text("DELETE FROM agent_groups WHERE id = :id"),
        {"id": group_id},
    )
    await db.commit()


# ─── Set group members (bulk replace) ────────
@router.put("/{group_id}/members")
async def set_group_members(group_id: str, body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    existing = await db.execute(
        text("SELECT id FROM agent_groups WHERE id = CAST(:id AS uuid)"),
        {"id": group_id},
    )
    if not existing.fetchone():
        raise HTTPException(status_code=404, detail="Group not found")

    agent_ids = body.get("agent_ids", [])

    # Unassign all current members of this group
    await db.execute(
        text("UPDATE agents SET group_id = NULL WHERE group_id = CAST(:gid AS uuid)"),
        {"gid": group_id},
    )
    # Assign selected agents
    for aid in agent_ids:
        await db.execute(
            text("UPDATE agents SET group_id = CAST(:gid AS uuid) WHERE id = CAST(:aid AS uuid) AND is_active = TRUE"),
            {"gid": group_id, "aid": str(aid)},
        )
    await db.commit()
    return {"updated": len(agent_ids)}


# ─── List agents in group ────────────────────
@router.get("/{group_id}/agents")
async def list_group_agents(group_id: str, db: AsyncSession = Depends(get_db)):
    rows = await db.execute(
        text("""
            SELECT id::text, hostname, display_name, ip_address, os_type, os_name,
                   agent_version, status, last_seen, asset_type
            FROM agents
            WHERE group_id = :gid AND is_active = TRUE
            ORDER BY hostname
        """),
        {"gid": group_id},
    )
    cols = ["id", "hostname", "display_name", "ip_address", "os_type", "os_name",
            "agent_version", "status", "last_seen", "asset_type"]
    result = []
    for row in rows.fetchall():
        d = dict(zip(cols, row))
        d["last_seen"] = d["last_seen"].isoformat() if d["last_seen"] else None
        result.append(d)
    return result
