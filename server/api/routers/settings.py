import asyncio
import smtplib
import json
import os
from datetime import datetime, timezone
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Optional
import httpx

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc

from api.database import get_db
from api.models.models import NotificationChannel, SystemSetting, BackupHistory
from api.services.auth import get_current_user

router = APIRouter(prefix="/settings", tags=["Settings"])


# ── System Settings ────────────────────────────────────────────────────────────

@router.get("/system")
async def get_all_settings(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(select(SystemSetting))
    rows = result.scalars().all()
    return {r.key: r.value for r in rows}


@router.get("/system/{key}")
async def get_setting(key: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    row = await db.get(SystemSetting, key)
    if not row:
        raise HTTPException(404, f"Setting '{key}' not found")
    return row.value


@router.put("/system/{key}")
async def update_setting(
    key: str, body: dict,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    row = await db.get(SystemSetting, key)
    if not row:
        raise HTTPException(404, f"Setting '{key}' not found")
    # Merge — only update provided keys, preserve others
    current = dict(row.value or {})
    current.update(body)
    row.value = current
    row.updated_by = user.id
    await db.commit()
    return row.value


# ── Backup ─────────────────────────────────────────────────────────────────────

@router.post("/backup/run")
async def run_backup_now(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Trigger an immediate backup via Celery."""
    from api.workers.tasks import run_database_backup
    task = run_database_backup.delay("manual")
    return {"status": "queued", "task_id": task.id}


@router.get("/backup/history")
async def backup_history(
    limit: int = 20,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    result = await db.execute(
        select(BackupHistory).order_by(desc(BackupHistory.started_at)).limit(limit)
    )
    rows = result.scalars().all()
    return [_backup_dict(r) for r in rows]


@router.get("/backup/stats")
async def backup_stats(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Return backup storage statistics."""
    setting = await db.get(SystemSetting, "backup")
    backup_path = (setting.value or {}).get("backup_path", "/app/backups") if setting else "/app/backups"
    total_size = 0
    count = 0
    try:
        for fname in os.listdir(backup_path):
            if fname.startswith("kifaa_backup_"):
                fpath = os.path.join(backup_path, fname)
                total_size += os.path.getsize(fpath)
                count += 1
    except FileNotFoundError:
        pass
    return {
        "file_count": count,
        "total_size_bytes": total_size,
        "total_size_gb": round(total_size / (1024 ** 3), 2),
        "backup_path": backup_path,
    }


@router.post("/backup/cleanup")
async def run_backup_cleanup(
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Trigger immediate backup pruning via Celery."""
    from api.workers.tasks import prune_old_backups
    task = prune_old_backups.delay()
    return {"status": "queued", "task_id": task.id}


@router.delete("/backup/{backup_id}")
async def delete_backup(
    backup_id: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    row = await db.get(BackupHistory, backup_id)
    if not row:
        raise HTTPException(404, "Backup record not found")
    # Delete the actual file if it exists
    if row.filename:
        setting = await db.get(SystemSetting, "backup")
        backup_path = (setting.value or {}).get("backup_path", "/app/backups")
        file_path = os.path.join(backup_path, row.filename)
        if os.path.exists(file_path):
            os.remove(file_path)
    await db.delete(row)
    await db.commit()
    return {"deleted": backup_id}


# ── Notification Channels ──────────────────────────────────────────────────────

@router.get("/notifications")
async def list_channels(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(
        select(NotificationChannel).order_by(NotificationChannel.created_at)
    )
    return [_channel_dict(c) for c in result.scalars().all()]


@router.post("/notifications", status_code=201)
async def create_channel(body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    ch = NotificationChannel(
        name=body["name"],
        type=body["type"],
        config=body.get("config", {}),
        is_active=body.get("is_active", True),
    )
    db.add(ch)
    await db.commit()
    await db.refresh(ch)
    return _channel_dict(ch)


@router.put("/notifications/{channel_id}")
async def update_channel(
    channel_id: str, body: dict,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    result = await db.execute(select(NotificationChannel).where(NotificationChannel.id == channel_id))
    ch = result.scalar_one_or_none()
    if not ch:
        raise HTTPException(404, "Channel not found")
    for field in ["name", "type", "is_active"]:
        if field in body:
            setattr(ch, field, body[field])
    if "config" in body:
        # Preserve stored password if masked value sent back
        existing = dict(ch.config or {})
        incoming = dict(body["config"])
        if "password" in incoming and incoming["password"] == "••••••••":
            incoming["password"] = existing.get("password", "")
        if "bot_token" in incoming and incoming["bot_token"] == "••••••••":
            incoming["bot_token"] = existing.get("bot_token", "")
        existing.update(incoming)
        ch.config = existing
    await db.commit()
    return _channel_dict(ch)


@router.delete("/notifications/{channel_id}", status_code=204)
async def delete_channel(channel_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(select(NotificationChannel).where(NotificationChannel.id == channel_id))
    ch = result.scalar_one_or_none()
    if not ch:
        raise HTTPException(404, "Channel not found")
    await db.delete(ch)
    await db.commit()


@router.post("/notifications/test-inline")
async def test_channel_inline(
    body: dict,
    _=Depends(get_current_user),
):
    """Test a notification channel using config provided in the request body (no save needed)."""
    ch_type = body.get("type", "")
    config = body.get("config", {})
    title = "Kifaa — Test Notification"
    msg = "This is a test notification from Kifaa Platform. Your notification channel is working correctly."
    try:
        if ch_type == "smtp":
            await _send_email(config, subject=title, body=msg)
        elif ch_type == "telegram":
            await _send_telegram(config, title, msg)
        elif ch_type in ("webhook_teams", "webhook_slack", "webhook_generic"):
            await _send_webhook(ch_type, config, title, msg)
        else:
            raise HTTPException(400, f"Unknown channel type: {ch_type}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Notification failed: {e}")
    return {"status": "sent"}


@router.post("/notifications/{channel_id}/test")
async def test_channel(
    channel_id: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    result = await db.execute(select(NotificationChannel).where(NotificationChannel.id == channel_id))
    ch = result.scalar_one_or_none()
    if not ch:
        raise HTTPException(404, "Channel not found")

    title = "Kifaa — Test Notification"
    body = "This is a test notification from Kifaa Platform. Your notification channel is working correctly."

    try:
        if ch.type == "smtp":
            await _send_email(ch.config, subject=title, body=body)
        elif ch.type == "telegram":
            await _send_telegram(ch.config, title, body)
        elif ch.type in ("webhook_teams", "webhook_slack", "webhook_generic"):
            await _send_webhook(ch.type, ch.config, title, body)
        else:
            raise HTTPException(400, f"Unknown channel type: {ch.type}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Notification failed: {e}")

    return {"status": "sent"}


# ── Internal: dispatch alert notifications ─────────────────────────────────────

async def dispatch_notifications(channel_ids: list, subject: str, body: str, db: AsyncSession):
    if not channel_ids:
        return
    result = await db.execute(
        select(NotificationChannel).where(
            NotificationChannel.id.in_(channel_ids),
            NotificationChannel.is_active == True,
        )
    )
    channels = result.scalars().all()
    for ch in channels:
        try:
            if ch.type == "smtp":
                await _send_email(ch.config, subject=subject, body=body)
            elif ch.type == "telegram":
                await _send_telegram(ch.config, subject, body)
            elif ch.type in ("webhook_teams", "webhook_slack", "webhook_generic"):
                await _send_webhook(ch.type, ch.config, subject, body)
        except Exception:
            pass  # Don't fail alert evaluation on notification error


# ── Email helper ───────────────────────────────────────────────────────────────

async def _send_email(config: dict, subject: str, body: str):
    host = config.get("host", "")
    port = int(config.get("port", 587))
    username = config.get("username", "")
    password = config.get("password", "")
    from_addr = config.get("from_address", username)
    to_addrs = config.get("to_addresses", [])
    if isinstance(to_addrs, str):
        to_addrs = [a.strip() for a in to_addrs.split(",") if a.strip()]

    if not host or not to_addrs:
        raise ValueError("SMTP host and to_addresses are required")

    def _send():
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = from_addr
        msg["To"] = ", ".join(to_addrs)
        msg.attach(MIMEText(body, "plain"))

        use_tls = config.get("use_tls", True)
        if use_tls and port == 465:
            with smtplib.SMTP_SSL(host, port, timeout=10) as server:
                if username:
                    server.login(username, password)
                server.sendmail(from_addr, to_addrs, msg.as_string())
        else:
            with smtplib.SMTP(host, port, timeout=10) as server:
                server.ehlo()
                if use_tls:
                    server.starttls()
                    server.ehlo()
                if username:
                    server.login(username, password)
                server.sendmail(from_addr, to_addrs, msg.as_string())

    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _send)


# ── Telegram helper ────────────────────────────────────────────────────────────

async def _send_telegram(config: dict, title: str, body: str):
    bot_token = config.get("bot_token", "")
    chat_id = config.get("chat_id", "")
    if not bot_token or not chat_id:
        raise ValueError("Telegram bot_token and chat_id are required")
    text = f"*{title}*\n{body}"
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            json={"chat_id": chat_id, "text": text, "parse_mode": "Markdown"},
        )
        if r.status_code >= 400:
            raise ValueError(f"Telegram API returned {r.status_code}: {r.text}")


# ── Webhook helper ─────────────────────────────────────────────────────────────

async def _send_webhook(channel_type: str, config: dict, title: str, body: str):
    url = config.get("url", "")
    if not url:
        raise ValueError("Webhook URL is required")

    if channel_type == "webhook_teams":
        payload = {
            "@type": "MessageCard",
            "@context": "http://schema.org/extensions",
            "summary": title,
            "themeColor": "0076D7",
            "sections": [{"activityTitle": title, "activityText": body}],
        }
    elif channel_type == "webhook_slack":
        payload = {"text": f"*{title}*\n{body}"}
    else:
        payload = {"title": title, "message": body}

    headers = {}
    if config.get("headers"):
        try:
            headers = json.loads(config["headers"]) if isinstance(config["headers"], str) else config["headers"]
        except Exception:
            pass

    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(url, json=payload, headers=headers)
        if r.status_code >= 400:
            raise ValueError(f"Webhook returned {r.status_code}: {r.text}")


# ── Helpers ────────────────────────────────────────────────────────────────────

def _channel_dict(c: NotificationChannel) -> dict:
    cfg = dict(c.config or {})
    if "password" in cfg:
        cfg["password"] = "••••••••"
    if "bot_token" in cfg:
        cfg["bot_token"] = "••••••••"
    return {
        "id": str(c.id),
        "name": c.name,
        "type": c.type,
        "config": cfg,
        "is_active": c.is_active,
        "created_at": c.created_at.isoformat() if c.created_at else None,
    }


def _backup_dict(b: BackupHistory) -> dict:
    return {
        "id": str(b.id),
        "filename": b.filename,
        "size_bytes": b.size_bytes,
        "status": b.status,
        "trigger": b.trigger,
        "error": b.error,
        "started_at": b.started_at.isoformat() if b.started_at else None,
        "finished_at": b.finished_at.isoformat() if b.finished_at else None,
    }
