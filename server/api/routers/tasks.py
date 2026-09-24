"""
Tasks router — unified view of agent commands and patch jobs.
"""
import json as _json
import uuid as _uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.database import get_db
from api.services.auth import get_current_user

router = APIRouter(prefix="/tasks", tags=["Tasks"])


@router.get("")
async def list_tasks(
    limit: int = 300,
    source: str = "all",
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    results = []

    if source in ("all", "command"):
        cmds = await db.execute(text("""
            SELECT
                ac.id,
                ac.command_type,
                ac.agent_id,
                a.hostname,
                CASE WHEN ac.picked_up_at IS NULL THEN 'pending' ELSE 'sent' END AS status,
                ac.payload,
                ac.created_at,
                ac.picked_up_at
            FROM agent_commands ac
            JOIN agents a ON a.id = ac.agent_id
            ORDER BY ac.created_at DESC
            LIMIT :limit
        """), {"limit": limit})
        for row in cmds.fetchall():
            results.append({
                "id": str(row[0]),
                "source": "command",
                "task_type": row[1],
                "agent_id": str(row[2]),
                "hostname": row[3],
                "status": row[4],
                "payload": row[5] or {},
                "created_at": row[6].isoformat() if row[6] else None,
                "updated_at": row[7].isoformat() if row[7] else None,
                "has_output": False,
                "job_id": None,
            })

    if source in ("all", "patch_job"):
        jobs = await db.execute(text("""
            SELECT
                pj.id,
                pj.job_type,
                pj.agent_id,
                a.hostname,
                pj.status,
                pj.triggered_by,
                pj.started_at,
                pj.finished_at,
                pj.packages
            FROM patch_jobs pj
            JOIN agents a ON a.id = pj.agent_id
            ORDER BY pj.started_at DESC
            LIMIT :limit
        """), {"limit": limit})
        for row in jobs.fetchall():
            results.append({
                "id": str(row[0]),
                "source": "patch_job",
                "task_type": row[1],
                "agent_id": str(row[2]),
                "hostname": row[3],
                "status": row[4],
                "payload": {"triggered_by": row[5], "packages": row[8] or []},
                "created_at": row[6].isoformat() if row[6] else None,
                "updated_at": row[7].isoformat() if row[7] else None,
                "has_output": True,
                "job_id": str(row[0]),
            })

    results.sort(key=lambda x: x["created_at"] or "", reverse=True)
    return results[:limit]


@router.get("/stats")
async def task_stats(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    pending = await db.execute(text(
        "SELECT COUNT(*) FROM agent_commands WHERE picked_up_at IS NULL"
    ))
    running = await db.execute(text(
        "SELECT COUNT(*) FROM patch_jobs WHERE status = 'running'"
    ))
    failed = await db.execute(text(
        "SELECT COUNT(*) FROM patch_jobs WHERE status = 'failed'"
    ))
    success = await db.execute(text(
        "SELECT COUNT(*) FROM patch_jobs WHERE status = 'success'"
    ))
    return {
        "pending": pending.scalar() or 0,
        "running": running.scalar() or 0,
        "failed": failed.scalar() or 0,
        "success": success.scalar() or 0,
    }


@router.post("/{task_id}/cancel")
async def cancel_task(task_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    # Agent command — only deletable if not yet picked up
    r = await db.execute(
        text("DELETE FROM agent_commands WHERE id = :id AND picked_up_at IS NULL RETURNING id"),
        {"id": task_id},
    )
    if r.fetchone():
        await db.commit()
        return {"status": "cancelled"}

    # Patch job
    r = await db.execute(
        text("UPDATE patch_jobs SET status='cancelled', finished_at=NOW() WHERE id=:id AND status IN ('pending','running') RETURNING id"),
        {"id": task_id},
    )
    if r.fetchone():
        await db.commit()
        return {"status": "cancelled"}

    raise HTTPException(404, "Task not found or already completed")


@router.post("/{task_id}/retry")
async def retry_task(task_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    # Try agent command retry
    r = await db.execute(
        text("SELECT agent_id, command_type, payload FROM agent_commands WHERE id = :id"),
        {"id": task_id},
    )
    row = r.fetchone()
    if row:
        new_id = str(_uuid.uuid4())
        await db.execute(
            text("INSERT INTO agent_commands (id, agent_id, command_type, payload) VALUES (:id, :aid, :type, CAST(:payload AS jsonb))"),
            {"id": new_id, "aid": str(row[0]), "type": row[1], "payload": _json.dumps(row[2] or {})},
        )
        await db.commit()
        return {"status": "queued", "new_id": new_id}

    # Try patch job retry (re-queue as agent command for scan type)
    r = await db.execute(
        text("SELECT agent_id, job_type FROM patch_jobs WHERE id = :id"),
        {"id": task_id},
    )
    row = r.fetchone()
    if row and row[1] == "scan":
        new_id = str(_uuid.uuid4())
        await db.execute(
            text("INSERT INTO agent_commands (id, agent_id, command_type, payload) VALUES (:id, :aid, 'patch_scan', '{}')"),
            {"id": new_id, "aid": str(row[0])},
        )
        await db.commit()
        return {"status": "queued", "new_id": new_id}

    raise HTTPException(404, "Task not found or retry not supported")


@router.delete("/{task_id}")
async def delete_task(task_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    r1 = await db.execute(text("DELETE FROM agent_commands WHERE id = :id RETURNING id"), {"id": task_id})
    r2 = await db.execute(text("DELETE FROM patch_jobs WHERE id = :id RETURNING id"), {"id": task_id})
    await db.commit()
    deleted = bool(r1.fetchone()) or bool(r2.fetchone())
    if not deleted:
        raise HTTPException(404, "Task not found")
    return {"status": "deleted"}
