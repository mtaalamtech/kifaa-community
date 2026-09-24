"""
Active Directory Plugin API
Frontend-facing endpoints: config, users, groups, events, actions, compliance.
"""
import csv
import io
import secrets
import string
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from typing import Optional
import json as _json
import uuid

from api.database import get_db
from api.services.auth import get_current_user

router = APIRouter(prefix="/ad", tags=["Active Directory"])

_deleted_table_ready = False


def _generate_temp_password(length: int = 16) -> str:
    """Generate a secure temporary password satisfying AD complexity requirements."""
    upper = string.ascii_uppercase
    lower = string.ascii_lowercase
    digits = string.digits
    special = "!@#$%^&*"
    # Guarantee at least one of each character class
    required = [
        secrets.choice(upper),
        secrets.choice(lower),
        secrets.choice(digits),
        secrets.choice(special),
    ]
    rest = [secrets.choice(upper + lower + digits + special) for _ in range(length - 4)]
    pool = required + rest
    secrets.SystemRandom().shuffle(pool)
    return "".join(pool)


async def _ensure_deleted_users_table(db: AsyncSession):
    global _deleted_table_ready
    if _deleted_table_ready:
        return
    await db.execute(text("""
        CREATE TABLE IF NOT EXISTS ad_deleted_users (
            id              UUID NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
            agent_id        UUID REFERENCES agents(id) ON DELETE CASCADE,
            sam_account_name TEXT NOT NULL,
            upn             TEXT,
            display_name    TEXT,
            email           TEXT,
            department      TEXT,
            title           TEXT,
            distinguished_name TEXT,
            ou_path         TEXT,
            member_of       JSONB DEFAULT '[]'::jsonb,
            is_admin        BOOLEAN DEFAULT FALSE,
            deleted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deleted_by      TEXT
        )
    """))
    await db.execute(text(
        "CREATE INDEX IF NOT EXISTS idx_ad_deleted_agent "
        "ON ad_deleted_users(agent_id, deleted_at DESC)"
    ))
    await db.commit()
    _deleted_table_ready = True


# ─── AD Config (per-agent) ────────────────────────────────────────────────────

@router.get("/config/{agent_id}")
async def get_ad_config(agent_id: str, user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    row = await db.execute(
        text("""SELECT id, agent_id, domain_fqdn, dc_host, base_dn, service_account,
                       max_pwd_age_days, sync_interval_seconds, is_active,
                       last_sync_at, last_sync_status, last_sync_error
                FROM ad_configs WHERE agent_id = CAST(:aid AS uuid)"""),
        {"aid": agent_id}
    )
    cfg = row.fetchone()
    if not cfg:
        return {"configured": False}
    return {
        "configured": True,
        "id": str(cfg[0]),
        "agent_id": str(cfg[1]),
        "domain_fqdn": cfg[2],
        "dc_host": cfg[3],
        "base_dn": cfg[4],
        "service_account": cfg[5],
        "max_pwd_age_days": cfg[6],
        "sync_interval_seconds": cfg[7],
        "is_active": cfg[8],
        "last_sync_at": cfg[9].isoformat() if cfg[9] else None,
        "last_sync_status": cfg[10],
        "last_sync_error": cfg[11],
    }


@router.post("/config/{agent_id}")
async def save_ad_config(agent_id: str, body: dict, user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    domain_fqdn = body.get("domain_fqdn", "")
    dc_host = body.get("dc_host", "")
    base_dn = body.get("base_dn", "")
    service_account = body.get("service_account", "")
    service_password = body.get("service_password", "")
    max_pwd_age = body.get("max_pwd_age_days", 90)
    sync_interval = body.get("sync_interval_seconds", 900)

    if not domain_fqdn or not base_dn or not service_account:
        raise HTTPException(status_code=400, detail="domain_fqdn, base_dn and service_account are required")

    row = await db.execute(
        text("SELECT id FROM ad_configs WHERE agent_id = CAST(:aid AS uuid)"),
        {"aid": agent_id}
    )
    existing = row.fetchone()

    if existing:
        if service_password:
            await db.execute(text("""
                UPDATE ad_configs SET domain_fqdn=:fqdn, dc_host=:dc, base_dn=:dn,
                    service_account=:svc, service_password=:pw,
                    max_pwd_age_days=:age, sync_interval_seconds=:interval,
                    is_active=TRUE, updated_at=NOW()
                WHERE agent_id = CAST(:aid AS uuid)
            """), {"fqdn": domain_fqdn, "dc": dc_host, "dn": base_dn, "svc": service_account,
                   "pw": service_password, "age": max_pwd_age, "interval": sync_interval, "aid": agent_id})
        else:
            await db.execute(text("""
                UPDATE ad_configs SET domain_fqdn=:fqdn, dc_host=:dc, base_dn=:dn,
                    service_account=:svc, max_pwd_age_days=:age,
                    sync_interval_seconds=:interval, is_active=TRUE, updated_at=NOW()
                WHERE agent_id = CAST(:aid AS uuid)
            """), {"fqdn": domain_fqdn, "dc": dc_host, "dn": base_dn, "svc": service_account,
                   "age": max_pwd_age, "interval": sync_interval, "aid": agent_id})
    else:
        await db.execute(text("""
            INSERT INTO ad_configs (agent_id, domain_fqdn, dc_host, base_dn, service_account,
                service_password, max_pwd_age_days, sync_interval_seconds, is_active)
            VALUES (CAST(:aid AS uuid), :fqdn, :dc, :dn, :svc, :pw, :age, :interval, TRUE)
        """), {"aid": agent_id, "fqdn": domain_fqdn, "dc": dc_host, "dn": base_dn,
               "svc": service_account, "pw": service_password,
               "age": max_pwd_age, "interval": sync_interval})

    await db.commit()
    return {"status": "ok"}


@router.post("/sync/{agent_id}")
async def trigger_ad_sync(agent_id: str, user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Queue an ad_sync command to the agent."""
    row = await db.execute(
        text("""SELECT dc_host, base_dn, service_account, service_password,
                       max_pwd_age_days
                FROM ad_configs WHERE agent_id = CAST(:aid AS uuid) AND is_active = TRUE"""),
        {"aid": agent_id}
    )
    cfg = row.fetchone()
    if not cfg:
        raise HTTPException(status_code=404, detail="AD not configured for this agent")

    payload = _json.dumps({
        "dc_host": cfg[0],
        "base_dn": cfg[1],
        "username": cfg[2],
        "password": cfg[3],
        "use_ssl": False,
        "max_pwd_age_days": cfg[4],
        "event_hours": 48,
    })
    cmd_row = await db.execute(
        text("""
            INSERT INTO agent_commands (agent_id, command_type, payload)
            VALUES (CAST(:aid AS uuid), 'ad_sync', CAST(:payload AS jsonb))
            ON CONFLICT (agent_id, command_type) WHERE picked_up_at IS NULL
            DO UPDATE SET payload = EXCLUDED.payload, created_at = NOW()
            RETURNING id
        """),
        {"aid": agent_id, "payload": payload}
    )
    command_id = str(cmd_row.fetchone()[0])
    await db.commit()
    return {"status": "queued", "command_id": command_id}


@router.get("/sync-status/{agent_id}")
async def get_sync_status(agent_id: str, user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Return last sync status + recent snapshot stats."""
    row = await db.execute(
        text("SELECT last_sync_at, last_sync_status, last_sync_error FROM ad_configs WHERE agent_id = CAST(:aid AS uuid)"),
        {"aid": agent_id}
    )
    cfg = row.fetchone()

    # Latest snapshot counts
    snap = await db.execute(text("""
        SELECT total_users, enabled_users, disabled_users, locked_users,
               total_groups, compliance_score, snapped_at
        FROM ad_health_snapshots WHERE agent_id = CAST(:aid AS uuid)
        ORDER BY snapped_at DESC LIMIT 1
    """), {"aid": agent_id})
    snap_row = snap.fetchone()

    return {
        "last_sync_at": cfg[0].isoformat() if cfg and cfg[0] else None,
        "last_sync_status": cfg[1] if cfg else None,
        "last_sync_error": cfg[2] if cfg else None,
        "snapshot": {
            "total_users": snap_row[0],
            "enabled_users": snap_row[1],
            "disabled_users": snap_row[2],
            "locked_users": snap_row[3],
            "total_groups": snap_row[4],
            "compliance_score": snap_row[5],
            "snapped_at": snap_row[6].isoformat() if snap_row[6] else None,
        } if snap_row else None,
    }


# ─── Users ────────────────────────────────────────────────────────────────────

@router.get("/users/{agent_id}")
async def list_ad_users(
    agent_id: str,
    status: Optional[str] = None,   # "active", "disabled", "locked"
    search: Optional[str] = None,
    min_days_inactive: Optional[int] = None,  # e.g. 90 for stale users
    page: int = 1,
    page_size: int = 50,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    conds = ["agent_id = CAST(:aid AS uuid)"]
    params: dict = {"aid": agent_id}

    if status == "active":
        conds.append("account_enabled = TRUE AND locked_out = FALSE")
    elif status == "disabled":
        conds.append("account_enabled = FALSE")
    elif status == "locked":
        conds.append("locked_out = TRUE")

    if min_days_inactive is not None:
        # Include accounts that have never logged in (last_logon IS NULL) or exceed threshold
        conds.append("(days_since_logon >= :min_days OR (last_logon IS NULL AND created_at_ad <= NOW() - INTERVAL '1 day' * :min_days))")
        params["min_days"] = min_days_inactive

    if search:
        conds.append("(sam_account_name ILIKE :q OR display_name ILIKE :q OR email ILIKE :q)")
        params["q"] = f"%{search}%"

    where = " AND ".join(conds)
    offset = (page - 1) * page_size

    count_row = await db.execute(text(f"SELECT COUNT(*) FROM ad_users WHERE {where}"), params)
    total = count_row.scalar()

    # Community edition: cap to 20 AD users
    COMMUNITY_AD_LIMIT = 20
    if total > COMMUNITY_AD_LIMIT:
        total = COMMUNITY_AD_LIMIT
    page_size = min(page_size, COMMUNITY_AD_LIMIT)


    params["limit"] = page_size
    params["offset"] = offset
    rows = await db.execute(text(f"""
        SELECT sam_account_name, upn, display_name, email, department, title,
               manager_dn, distinguished_name, account_enabled, locked_out,
               lockout_time, password_expired, password_never_expires,
               password_last_set, password_expires_at, last_logon, created_at_ad,
               member_of, is_admin, is_service_account,
               CASE WHEN last_logon IS NULL THEN NULL
                    ELSE EXTRACT(DAY FROM NOW() - last_logon)::integer
               END AS days_since_logon,
               user_account_control, synced_at
        FROM ad_users WHERE {where}
        ORDER BY {("last_logon ASC NULLS LAST" if min_days_inactive else "sam_account_name")}
        LIMIT :limit OFFSET :offset
    """), params)

    users = []
    for r in rows.fetchall():
        users.append({
            "sam_account_name": r[0],
            "upn": r[1],
            "display_name": r[2],
            "email": r[3],
            "department": r[4],
            "title": r[5],
            "manager_dn": r[6],
            "distinguished_name": r[7],
            "account_enabled": r[8],
            "locked_out": r[9],
            "lockout_time": r[10].isoformat() if r[10] else None,
            "password_expired": r[11],
            "password_never_expires": r[12],
            "password_last_set": r[13].isoformat() if r[13] else None,
            "password_expires_at": r[14].isoformat() if r[14] else None,
            "last_logon": r[15].isoformat() if r[15] else None,
            "created_at_ad": r[16].isoformat() if r[16] else None,
            "member_of": r[17] if r[17] else [],
            "is_admin": r[18],
            "is_service_account": r[19],
            "days_since_logon": r[20],
            "user_account_control": r[21],
            "synced_at": r[22].isoformat() if r[22] else None,
        })

    return {"total": total, "page": page, "page_size": page_size, "users": users}


@router.get("/users/{agent_id}/export")
async def export_ad_users(
    agent_id: str,
    fmt: str = "csv",   # csv or xlsx
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Export all AD users (active and inactive) with all available columns."""
    rows = await db.execute(text("""
        SELECT
            sam_account_name,
            upn,
            display_name,
            email,
            department,
            title,
            manager_dn,
            ou_path,
            distinguished_name,
            account_enabled,
            locked_out,
            lockout_time,
            password_expired,
            password_never_expires,
            password_last_set,
            password_expires_at,
            last_logon,
            CASE WHEN last_logon IS NULL THEN NULL
                 ELSE EXTRACT(DAY FROM NOW() - last_logon)::integer
            END AS days_since_logon,
            created_at_ad,
            is_admin,
            is_service_account,
            user_account_control,
            member_of,
            synced_at
        FROM ad_users
        WHERE agent_id = CAST(:aid AS uuid)
        ORDER BY sam_account_name
    """), {"aid": agent_id})

    records = rows.fetchall()

    headers = [
        "Username (SAM)",
        "UPN",
        "Display Name",
        "Email",
        "Department",
        "Title",
        "Manager DN",
        "OU Path",
        "Distinguished Name",
        "Account Enabled",
        "Locked Out",
        "Lockout Time",
        "Password Expired",
        "Password Never Expires",
        "Password Last Set",
        "Password Expires At",
        "Last Logon",
        "Days Since Logon",
        "Created In AD",
        "Is Admin",
        "Is Service Account",
        "User Account Control",
        "Member Of (Groups)",
        "Last Synced",
    ]

    def _fmt(v):
        if v is None:
            return ""
        if isinstance(v, bool):
            return "Yes" if v else "No"
        if isinstance(v, list):
            return "; ".join(v)
        if hasattr(v, "isoformat"):
            return v.isoformat()
        return str(v)

    def _row(r):
        return [_fmt(v) for v in r]

    if fmt == "xlsx":
        try:
            import openpyxl
            from openpyxl.styles import Font, PatternFill, Alignment
            wb = openpyxl.Workbook()
            ws = wb.active
            ws.title = "AD Users"

            header_fill = PatternFill("solid", fgColor="1e293b")
            header_font = Font(bold=True, color="FFFFFF")
            ws.append(headers)
            for cell in ws[1]:
                cell.fill = header_fill
                cell.font = header_font
                cell.alignment = Alignment(horizontal="center")

            for r in records:
                ws.append(_row(r))

            # Auto-size columns
            for col in ws.columns:
                max_len = max((len(str(c.value or "")) for c in col), default=10)
                ws.column_dimensions[col[0].column_letter].width = min(max_len + 2, 50)

            buf = io.BytesIO()
            wb.save(buf)
            buf.seek(0)
            return StreamingResponse(
                buf,
                media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                headers={"Content-Disposition": "attachment; filename=\"ad_users_export.xlsx\""},
            )
        except ImportError:
            pass  # fall through to CSV

    # CSV (default or fallback)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(headers)
    for r in records:
        writer.writerow(_row(r))

    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=\"ad_users_export.csv\""},
    )


# ─── Groups ───────────────────────────────────────────────────────────────────

@router.get("/groups/{agent_id}")
async def list_ad_groups(
    agent_id: str,
    search: Optional[str] = None,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    conds = ["agent_id = CAST(:aid AS uuid)"]
    params: dict = {"aid": agent_id}

    if search:
        conds.append("(sam_account_name ILIKE :q OR display_name ILIKE :q OR description ILIKE :q)")
        params["q"] = f"%{search}%"

    where = " AND ".join(conds)
    rows = await db.execute(text(f"""
        SELECT sam_account_name, display_name, description, group_type,
               group_scope, member_count, is_privileged, synced_at
        FROM ad_groups WHERE {where} ORDER BY sam_account_name
    """), params)

    return [
        {
            "sam_account_name": r[0],
            "display_name": r[1],
            "description": r[2],
            "group_type": r[3],
            "group_scope": r[4],
            "member_count": r[5],
            "is_privileged": r[6],
            "synced_at": r[7].isoformat() if r[7] else None,
        }
        for r in rows.fetchall()
    ]


@router.get("/groups/{agent_id}/export")
async def export_ad_groups(
    agent_id: str,
    fmt: str = "csv",
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Export all AD groups with all available columns."""
    rows = await db.execute(text("""
        SELECT
            sam_account_name,
            display_name,
            description,
            group_type,
            group_scope,
            member_count,
            members,
            ou_path,
            is_privileged,
            synced_at
        FROM ad_groups
        WHERE agent_id = CAST(:aid AS uuid)
        ORDER BY sam_account_name
    """), {"aid": agent_id})

    records = rows.fetchall()

    headers = [
        "Group Name (SAM)",
        "Display Name",
        "Description",
        "Group Type",
        "Group Scope",
        "Member Count",
        "Members",
        "OU Path",
        "Is Privileged",
        "Last Synced",
    ]

    def _fmt(v):
        if v is None:
            return ""
        if isinstance(v, bool):
            return "Yes" if v else "No"
        if isinstance(v, list):
            return "; ".join(v)
        if hasattr(v, "isoformat"):
            return v.isoformat()
        return str(v)

    def _row(r):
        return [_fmt(v) for v in r]

    if fmt == "xlsx":
        try:
            import openpyxl
            from openpyxl.styles import Font, PatternFill, Alignment
            wb = openpyxl.Workbook()
            ws = wb.active
            ws.title = "AD Groups"

            header_fill = PatternFill("solid", fgColor="1e293b")
            header_font = Font(bold=True, color="FFFFFF")
            ws.append(headers)
            for cell in ws[1]:
                cell.fill = header_fill
                cell.font = header_font
                cell.alignment = Alignment(horizontal="center")

            for r in records:
                ws.append(_row(r))

            for col in ws.columns:
                max_len = max((len(str(c.value or "")) for c in col), default=10)
                ws.column_dimensions[col[0].column_letter].width = min(max_len + 2, 50)

            buf = io.BytesIO()
            wb.save(buf)
            buf.seek(0)
            return StreamingResponse(
                buf,
                media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                headers={"Content-Disposition": "attachment; filename=\"ad_groups_export.xlsx\""},
            )
        except ImportError:
            pass

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(headers)
    for r in records:
        writer.writerow(_row(r))

    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=\"ad_groups_export.csv\""},
    )


# ─── Security Events ─────────────────────────────────────────────────────────

EVENT_LABELS = {
    4740: "Account Locked Out",
    4767: "Account Unlocked",
    4722: "Account Enabled",
    4725: "Account Disabled",
    4720: "Account Created",
    4726: "Account Deleted",
    4724: "Password Reset",
    4728: "Added to Global Group",
    4732: "Added to Local Group",
    4756: "Added to Universal Group",
    4625: "Failed Logon",
}


@router.get("/events/{agent_id}")
async def list_ad_events(
    agent_id: str,
    event_id: Optional[int] = None,
    hours: int = 48,
    search: Optional[str] = None,
    page: int = 1,
    page_size: int = 100,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    conds = [
        "agent_id = CAST(:aid AS uuid)",
        "event_time >= NOW() - :hours * INTERVAL '1 hour'",
    ]
    params: dict = {"aid": agent_id, "hours": hours}

    if event_id:
        conds.append("event_id = :eid")
        params["eid"] = event_id

    if search:
        conds.append("(target_user ILIKE :q OR calling_computer ILIKE :q OR calling_ip ILIKE :q)")
        params["q"] = f"%{search}%"

    where = " AND ".join(conds)
    offset = (page - 1) * page_size

    count_row = await db.execute(text(f"SELECT COUNT(*) FROM ad_events WHERE {where}"), params)
    total = count_row.scalar()

    params["limit"] = page_size
    params["offset"] = offset
    rows = await db.execute(text(f"""
        SELECT event_id, event_time, target_user, target_domain,
               calling_computer, calling_ip, dc_name, subject_user, description
        FROM ad_events WHERE {where}
        ORDER BY event_time DESC
        LIMIT :limit OFFSET :offset
    """), params)

    events = []
    for r in rows.fetchall():
        events.append({
            "event_id": r[0],
            "label": EVENT_LABELS.get(r[0], f"Event {r[0]}"),
            "event_time": r[1].isoformat() if r[1] else None,
            "target_user": r[2],
            "target_domain": r[3],
            "calling_computer": r[4],
            "calling_ip": r[5],
            "dc_name": r[6],
            "subject_user": r[7],
            "description": r[8],
        })

    return {"total": total, "page": page, "page_size": page_size, "events": events}


# ─── Server-side LDAP helper ─────────────────────────────────────────────────

def _ldap_delete_user(dc_host: str, base_dn: str, service_account: str, service_password: str, sam: str) -> str:
    """Directly delete a user from AD using ldap3. Returns the user's DN on success, raises on error."""
    import asyncio
    from ldap3 import Server, Connection, SUBTREE, ALL_ATTRIBUTES, MODIFY_REPLACE, AUTO_BIND_NO_TLS
    from ldap3.core.exceptions import LDAPException

    server = Server(dc_host, port=389, use_ssl=False, connect_timeout=10)
    conn = Connection(server, user=service_account, password=service_password, auto_bind=AUTO_BIND_NO_TLS)
    if not conn.bind():
        raise Exception(f"LDAP bind failed: {conn.result}")

    # Find user DN
    search_filter = f"(sAMAccountName={sam})"
    conn.search(base_dn, search_filter, search_scope=SUBTREE, attributes=["distinguishedName"])
    if not conn.entries:
        raise Exception(f"User '{sam}' not found in AD")

    dn = conn.entries[0].entry_dn
    if not conn.delete(dn):
        result = conn.result
        raise Exception(f"LDAP delete failed: {result.get('description', str(result))}")

    return dn


# ─── User Actions ─────────────────────────────────────────────────────────────

@router.post("/action/{agent_id}")
async def perform_ad_action(agent_id: str, body: dict, user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Queue an ad_user_action command. Actions: unlock, enable, disable, change_password, force_password_change, delete."""
    action = body.get("action", "")
    sam = body.get("sam_account_name", "")
    if not action or not sam:
        raise HTTPException(status_code=400, detail="action and sam_account_name required")
    if action not in ("unlock", "enable", "disable", "change_password", "force_password_change", "delete"):
        raise HTTPException(status_code=400, detail="Invalid action")
    if action == "change_password":
        new_password = body.get("new_password", "")
        if not new_password:
            raise HTTPException(status_code=400, detail="new_password is required for change_password action")

    row = await db.execute(
        text("""SELECT dc_host, base_dn, service_account, service_password
                FROM ad_configs WHERE agent_id = CAST(:aid AS uuid) AND is_active = TRUE"""),
        {"aid": agent_id}
    )
    cfg = row.fetchone()
    if not cfg:
        raise HTTPException(status_code=404, detail="AD not configured for this agent")

    action_id = str(uuid.uuid4())

    # DELETE is executed server-side via ldap3 (doesn't require agent binary support)
    if action == "delete":
        import asyncio
        await db.execute(text("""
            INSERT INTO ad_action_log
                (agent_id, performed_by, performed_by_username, action, target_user,
                 notes, status, action_id, sam_account_name)
            VALUES (
                CAST(:aid AS uuid), CAST(:uid AS uuid), :uname, 'delete', :sam,
                :notes, 'pending', :action_id, :sam
            )
        """), {
            "aid": agent_id, "uid": str(user.id), "uname": user.username,
            "sam": sam, "notes": body.get("notes", ""), "action_id": action_id,
        })
        await db.commit()
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, _ldap_delete_user, cfg[0], cfg[1], cfg[2], cfg[3], sam)
            await db.execute(text("""
                UPDATE ad_action_log SET status='completed', completed_at=NOW()
                WHERE action_id=:aid
            """), {"aid": action_id})
            # Save tombstone before removing from local DB
            await _ensure_deleted_users_table(db)
            await db.execute(text("""
                INSERT INTO ad_deleted_users
                    (agent_id, sam_account_name, upn, display_name, email,
                     department, title, distinguished_name, ou_path, member_of,
                     is_admin, deleted_by)
                SELECT
                    CAST(:agent_id AS uuid), sam_account_name, upn, display_name,
                    email, department, title, distinguished_name, ou_path,
                    COALESCE(member_of::jsonb, '[]'::jsonb), is_admin, :deleted_by
                FROM ad_users
                WHERE agent_id = CAST(:agent_id AS uuid) AND sam_account_name = :sam
                ON CONFLICT DO NOTHING
            """), {"agent_id": agent_id, "sam": sam, "deleted_by": user.username})
            # Remove user from local DB — next sync will confirm
            await db.execute(text("""
                DELETE FROM ad_users WHERE agent_id=CAST(:agent_id AS uuid) AND sam_account_name=:sam
            """), {"agent_id": agent_id, "sam": sam})
            await db.commit()
            return {"status": "completed", "action_id": action_id}
        except Exception as e:
            err = str(e).replace("\x00", "")
            await db.execute(text("""
                UPDATE ad_action_log SET status='failed', error_message=:err, completed_at=NOW()
                WHERE action_id=:aid
            """), {"err": err, "aid": action_id})
            await db.commit()
            raise HTTPException(status_code=400, detail=str(e))

    # Pre-insert the action log row so the agent callback can update it
    await db.execute(text("""
        INSERT INTO ad_action_log
            (agent_id, performed_by, performed_by_username, action, target_user,
             notes, status, action_id, sam_account_name)
        VALUES (
            CAST(:aid AS uuid), CAST(:uid AS uuid), :uname, :action, :sam,
            :notes, 'pending', :action_id, :sam
        )
    """), {
        "aid": agent_id,
        "uid": str(user.id),
        "uname": user.username,
        "action": action,
        "sam": sam,
        "notes": body.get("notes", ""),
        "action_id": action_id,
    })

    # change_password requires TLS (LDAPS) to send unicodePwd
    use_ssl = action == "change_password"

    payload_dict = {
        "dc_host": cfg[0],
        "base_dn": cfg[1],
        "username": cfg[2],
        "password": cfg[3],
        "use_ssl": use_ssl,
        "action": action,
        "sam_account_name": sam,
        "action_id": action_id,
    }
    if action == "change_password":
        payload_dict["new_password"] = body.get("new_password", "")
    payload = _json.dumps(payload_dict)
    await db.execute(
        text("INSERT INTO agent_commands (agent_id, command_type, payload) VALUES (CAST(:aid AS uuid), 'ad_user_action', CAST(:payload AS jsonb))"),
        {"aid": agent_id, "payload": payload}
    )
    await db.commit()
    return {"status": "queued", "action_id": action_id}


@router.post("/bulk-action/{agent_id}")
async def bulk_ad_action(agent_id: str, body: dict, user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Queue the same action for multiple users. Body: { action, sam_account_names: [...] }"""
    action = body.get("action", "")
    sams = body.get("sam_account_names", [])
    if not action or not sams:
        raise HTTPException(status_code=400, detail="action and sam_account_names required")
    if action not in ("unlock", "enable", "disable", "delete"):
        raise HTTPException(status_code=400, detail="Bulk action not supported for this action type")
    if not isinstance(sams, list) or len(sams) > 200:
        raise HTTPException(status_code=400, detail="sam_account_names must be a list of up to 200 entries")

    row = await db.execute(
        text("""SELECT dc_host, base_dn, service_account, service_password
                FROM ad_configs WHERE agent_id = CAST(:aid AS uuid) AND is_active = TRUE"""),
        {"aid": agent_id}
    )
    cfg = row.fetchone()
    if not cfg:
        raise HTTPException(status_code=404, detail="AD not configured for this agent")

    # Log each user action individually
    action_ids = []
    bulk_entries = []
    for sam in sams:
        action_id = str(uuid.uuid4())
        action_ids.append(action_id)
        bulk_entries.append({"sam": sam, "action_id": action_id})
        await db.execute(text("""
            INSERT INTO ad_action_log
                (agent_id, performed_by, performed_by_username, action, target_user,
                 notes, status, action_id, sam_account_name)
            VALUES (
                CAST(:aid AS uuid), CAST(:uid AS uuid), :uname, :action, :sam,
                :notes, 'pending', :action_id, :sam
            )
        """), {
            "aid": agent_id,
            "uid": str(user.id),
            "uname": user.username,
            "action": action,
            "sam": sam,
            "notes": f"bulk {action}",
            "action_id": action_id,
        })

    # DELETE is executed server-side via ldap3 (doesn't require agent binary to support delete)
    if action == "delete":
        import asyncio
        await db.commit()  # Flush log entries first
        await _ensure_deleted_users_table(db)
        results = []
        loop = asyncio.get_event_loop()
        for i, sam in enumerate(sams):
            aid = action_ids[i]
            try:
                await loop.run_in_executor(None, _ldap_delete_user, cfg[0], cfg[1], cfg[2], cfg[3], sam)
                await db.execute(text("""
                    UPDATE ad_action_log SET status='completed', completed_at=NOW()
                    WHERE action_id=:aid
                """), {"aid": aid})
                # Save tombstone
                await db.execute(text("""
                    INSERT INTO ad_deleted_users
                        (agent_id, sam_account_name, upn, display_name, email,
                         department, title, distinguished_name, ou_path, member_of,
                         is_admin, deleted_by)
                    SELECT
                        CAST(:agent_id AS uuid), sam_account_name, upn, display_name,
                        email, department, title, distinguished_name, ou_path,
                        COALESCE(member_of::jsonb, '[]'::jsonb), is_admin, :deleted_by
                    FROM ad_users
                    WHERE agent_id = CAST(:agent_id AS uuid) AND sam_account_name = :sam
                    ON CONFLICT DO NOTHING
                """), {"agent_id": agent_id, "sam": sam, "deleted_by": user.username})
                await db.execute(text("""
                    DELETE FROM ad_users WHERE agent_id=CAST(:agent_id AS uuid) AND sam_account_name=:sam
                """), {"agent_id": agent_id, "sam": sam})
                results.append({"sam": sam, "status": "deleted"})
            except Exception as e:
                err = str(e).replace("\x00", "")
                await db.execute(text("""
                    UPDATE ad_action_log SET status='failed', error_message=:err, completed_at=NOW()
                    WHERE action_id=:aid
                """), {"err": err, "aid": aid})
                results.append({"sam": sam, "status": "failed", "error": err})
        await db.commit()
        deleted = sum(1 for r in results if r["status"] == "deleted")
        return {"status": "completed", "count": len(sams), "deleted": deleted, "results": results}

    # For non-delete bulk actions: single command with all users packed in
    payload = _json.dumps({
        "dc_host": cfg[0],
        "base_dn": cfg[1],
        "username": cfg[2],
        "password": cfg[3],
        "use_ssl": False,
        "action": action,
        "sam_account_names": bulk_entries,  # agent iterates over these
    })
    await db.execute(
        text("""INSERT INTO agent_commands (agent_id, command_type, payload)
                VALUES (CAST(:aid AS uuid), 'ad_user_action', CAST(:payload AS jsonb))
                ON CONFLICT (agent_id, command_type) WHERE picked_up_at IS NULL
                DO UPDATE SET payload = EXCLUDED.payload"""),
        {"aid": agent_id, "payload": payload}
    )

    await db.commit()
    return {"status": "queued", "count": len(sams), "action_ids": action_ids}


@router.get("/action-log/{agent_id}")
async def get_action_log(
    agent_id: str,
    limit: int = 50,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    rows = await db.execute(text("""
        SELECT action_id, action, target_user, performed_by_username,
               status, error_message, created_at, completed_at
        FROM ad_action_log WHERE agent_id = CAST(:aid AS uuid)
        ORDER BY created_at DESC LIMIT :limit
    """), {"aid": agent_id, "limit": limit})

    return [
        {
            "action_id": r[0],
            "action": r[1],
            "sam_account_name": r[2],
            "performed_by": r[3],
            "status": r[4],
            "error_message": r[5],
            "created_at": r[6].isoformat() if r[6] else None,
            "completed_at": r[7].isoformat() if r[7] else None,
        }
        for r in rows.fetchall()
    ]


# ─── Compliance ───────────────────────────────────────────────────────────────

@router.get("/compliance/{agent_id}")
async def get_compliance(agent_id: str, user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Latest compliance snapshot + 24h event aggregates."""
    snap_row = await db.execute(text("""
        SELECT total_users, enabled_users, disabled_users, locked_users,
               stale_users_30d, stale_users_90d, expiring_passwords_7d,
               expired_passwords, never_expire_passwords,
               admin_count, service_account_count,
               total_groups, privileged_groups_count, compliance_score, snapped_at
        FROM ad_health_snapshots WHERE agent_id = CAST(:aid AS uuid)
        ORDER BY snapped_at DESC LIMIT 1
    """), {"aid": agent_id})
    snap = snap_row.fetchone()

    lockout_row = await db.execute(text("""
        SELECT COUNT(*) FROM ad_events
        WHERE agent_id = CAST(:aid AS uuid) AND event_id = 4740
          AND event_time >= NOW() - INTERVAL '24 hours'
    """), {"aid": agent_id})
    lockouts_24h = lockout_row.scalar() or 0

    fail_row = await db.execute(text("""
        SELECT COUNT(*) FROM ad_events
        WHERE agent_id = CAST(:aid AS uuid) AND event_id = 4625
          AND event_time >= NOW() - INTERVAL '24 hours'
    """), {"aid": agent_id})
    failed_logons_24h = fail_row.scalar() or 0

    top_fail_rows = await db.execute(text("""
        SELECT target_user, COUNT(*) AS cnt FROM ad_events
        WHERE agent_id = CAST(:aid AS uuid) AND event_id = 4625
          AND event_time >= NOW() - INTERVAL '24 hours'
        GROUP BY target_user ORDER BY cnt DESC LIMIT 5
    """), {"aid": agent_id})
    top_failed = [{"user": r[0], "count": r[1]} for r in top_fail_rows.fetchall()]

    result = {
        "lockouts_24h": lockouts_24h,
        "failed_logons_24h": failed_logons_24h,
        "top_failed_logon_users": top_failed,
    }

    if snap:
        result.update({
            "total_users": snap[0],
            "enabled_users": snap[1],
            "disabled_users": snap[2],
            "locked_users": snap[3],
            "stale_users_30d": snap[4],
            "stale_users_90d": snap[5],
            "expiring_passwords_7d": snap[6],
            "expired_passwords": snap[7],
            "never_expire_passwords": snap[8],
            "admin_count": snap[9],
            "service_account_count": snap[10],
            "total_groups": snap[11],
            "privileged_groups_count": snap[12],
            "compliance_score": snap[13],
            "snapped_at": snap[14].isoformat() if snap[14] else None,
        })

    return result


# ─── Connection Test ──────────────────────────────────────────────────────────

@router.post("/test/{agent_id}")
async def test_ad_connection(agent_id: str, body: dict, user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Queue an ad_test command. Uses form credentials if provided, otherwise falls back to saved config."""
    dc_host = body.get("dc_host", "")
    base_dn = body.get("base_dn", "")
    service_account = body.get("service_account", "")
    service_password = body.get("service_password", "")
    use_ssl = body.get("use_ssl", False)

    # If password is missing, try to load it from the saved config
    if not service_password:
        saved = await db.execute(
            text("SELECT dc_host, base_dn, service_account, service_password FROM ad_configs WHERE agent_id = CAST(:aid AS uuid) AND is_active = TRUE"),
            {"aid": agent_id}
        )
        row = saved.fetchone()
        if not row:
            raise HTTPException(status_code=400, detail="No saved AD configuration found and no password provided. Save your configuration first, or enter the password to test.")
        # Use saved values for anything not overridden in the form
        if not dc_host:          dc_host = row[0] or ""
        if not base_dn:          base_dn = row[1] or ""
        if not service_account:  service_account = row[2] or ""
        service_password = row[3] or ""

    if not base_dn or not service_account or not service_password:
        raise HTTPException(status_code=400, detail="base_dn, service_account and service_password are required to test")

    # Insert the command and get its ID back
    row = await db.execute(text("""
        INSERT INTO agent_commands (agent_id, command_type, payload)
        VALUES (CAST(:aid AS uuid), 'ad_test', CAST(:payload AS jsonb))
        RETURNING id
    """), {
        "aid": agent_id,
        "payload": _json.dumps({
            "dc_host": dc_host,
            "base_dn": base_dn,
            "username": service_account,
            "password": service_password,
            "use_ssl": use_ssl,
            "command_id": "",  # will be filled below after insert
        })
    })
    command_id = str(row.fetchone()[0])

    # Update the payload with the real command_id so the agent can echo it back
    await db.execute(text("""
        UPDATE agent_commands SET payload = payload || CAST(:patch AS jsonb)
        WHERE id = CAST(:cid AS uuid)
    """), {"patch": _json.dumps({"command_id": command_id}), "cid": command_id})

    await db.commit()
    return {"status": "queued", "command_id": command_id}


@router.get("/test-result/{command_id}")
async def get_test_result(command_id: str, user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Poll for the result of a queued ad_test command."""
    row = await db.execute(text("""
        SELECT success, message, latency_ms, tested_at
        FROM ad_test_results WHERE command_id = CAST(:cid AS uuid)
    """), {"cid": command_id})
    result = row.fetchone()

    if not result:
        # Check if the command was picked up yet
        cmd_row = await db.execute(text("""
            SELECT picked_up_at FROM agent_commands WHERE id = CAST(:cid AS uuid)
        """), {"cid": command_id})
        cmd = cmd_row.fetchone()
        if cmd is None:
            raise HTTPException(status_code=404, detail="Command not found")
        return {
            "ready": False,
            "picked_up": cmd[0] is not None,
        }

    return {
        "ready": True,
        "success": result[0],
        "message": result[1],
        "latency_ms": result[2],
        "tested_at": result[3].isoformat() if result[3] else None,
    }


# ─── Deleted Users ────────────────────────────────────────────────────────────

@router.get("/deleted-users/{agent_id}")
async def list_deleted_users(
    agent_id: str,
    search: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List AD users that were deleted via Kifaa (tombstone records)."""
    await _ensure_deleted_users_table(db)

    conds = ["agent_id = CAST(:aid AS uuid)"]
    params: dict = {"aid": agent_id}

    if search:
        conds.append(
            "(sam_account_name ILIKE :q OR display_name ILIKE :q OR email ILIKE :q)"
        )
        params["q"] = f"%{search}%"

    where = " AND ".join(conds)
    offset = (page - 1) * page_size

    count_row = await db.execute(
        text(f"SELECT COUNT(*) FROM ad_deleted_users WHERE {where}"), params
    )
    total = count_row.scalar() or 0

    params["limit"] = page_size
    params["offset"] = offset
    rows = await db.execute(text(f"""
        SELECT id, sam_account_name, upn, display_name, email,
               department, title, distinguished_name, ou_path,
               member_of, is_admin, deleted_at, deleted_by
        FROM ad_deleted_users
        WHERE {where}
        ORDER BY deleted_at DESC
        LIMIT :limit OFFSET :offset
    """), params)

    users_out = []
    for r in rows.fetchall():
        users_out.append({
            "id": str(r[0]),
            "sam_account_name": r[1],
            "upn": r[2],
            "display_name": r[3],
            "email": r[4],
            "department": r[5],
            "title": r[6],
            "distinguished_name": r[7],
            "ou_path": r[8],
            "member_of": r[9] if r[9] else [],
            "is_admin": r[10],
            "deleted_at": r[11].isoformat() if r[11] else None,
            "deleted_by": r[12],
        })

    return {"total": total, "page": page, "page_size": page_size, "users": users_out}


def _ldap_restore_user(
    dc_host: str, base_dn: str, service_account: str, service_password: str,
    sam: str, original_dn: str, temp_password: str,
) -> dict:
    """
    Restore a deleted AD user using the AD Recycle Bin (requires the feature to be enabled).
    Tries to set the password via LDAPS (port 636); falls back gracefully if unavailable.
    """
    from ldap3 import (
        Server, Connection, SUBTREE, MODIFY_REPLACE, MODIFY_DELETE,
        AUTO_BIND_NO_TLS,
    )

    SHOW_DELETED_OID = "1.2.840.113556.1.4.417"

    server = Server(dc_host, port=389, use_ssl=False, connect_timeout=10)
    conn = Connection(
        server, user=service_account, password=service_password,
        auto_bind=AUTO_BIND_NO_TLS,
    )
    if not conn.bind():
        raise Exception(f"LDAP bind failed: {conn.result}")

    # Search for the deleted object
    deleted_base = f"CN=Deleted Objects,{base_dn}"
    conn.search(
        deleted_base,
        f"(sAMAccountName={sam})",
        search_scope=SUBTREE,
        attributes=["distinguishedName"],
        controls=[(SHOW_DELETED_OID, True, None)],
    )

    if not conn.entries:
        raise Exception(
            f"User '{sam}' not found in the AD Recycle Bin. "
            "Either the Recycle Bin feature is not enabled on this domain, "
            "or the tombstone lifetime has expired and the object is permanently deleted."
        )

    deleted_dn = conn.entries[0].entry_dn

    # Restore target: use original DN if available, otherwise fall back to CN=Users
    restore_dn = original_dn or f"CN={sam},CN=Users,{base_dn}"

    ok = conn.modify(
        deleted_dn,
        {
            "isDeleted": [(MODIFY_DELETE, [])],
            "distinguishedName": [(MODIFY_REPLACE, [restore_dn])],
        },
        controls=[(SHOW_DELETED_OID, True, None)],
    )
    if not ok:
        desc = conn.result.get("description", str(conn.result))
        raise Exception(f"Failed to restore '{sam}' from Recycle Bin: {desc}")

    # Attempt to set temp password via LDAPS (port 636)
    password_set = False
    try:
        ssl_server = Server(dc_host, port=636, use_ssl=True, connect_timeout=10)
        ssl_conn = Connection(
            ssl_server, user=service_account, password=service_password,
            auto_bind=AUTO_BIND_NO_TLS,
        )
        if ssl_conn.bind():
            ssl_conn.extend.microsoft.modify_password(restore_dn, temp_password)
            # Enable account (512 = NORMAL_ACCOUNT) and force password change
            ssl_conn.modify(restore_dn, {
                "userAccountControl": [(MODIFY_REPLACE, [512])],
                "pwdLastSet": [(MODIFY_REPLACE, [0])],
            })
            password_set = True
            ssl_conn.unbind()
    except Exception:
        # LDAPS unavailable — still enable the account and flag for password change
        conn.modify(restore_dn, {
            "userAccountControl": [(MODIFY_REPLACE, [512])],
            "pwdLastSet": [(MODIFY_REPLACE, [0])],
        })

    conn.unbind()

    if password_set:
        msg = "User restored and temporary password set. They will be required to change it on first login."
    else:
        msg = (
            "User restored but the temporary password could not be set — "
            "LDAPS (port 636) is not available on this domain controller. "
            "The account has been enabled and flagged to require a password change at next login. "
            "Please set the password manually via ADUC."
        )

    return {"restored": True, "password_set": password_set, "message": msg}


@router.post("/restore-user/{agent_id}")
async def restore_deleted_user(
    agent_id: str,
    body: dict,
    user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Restore a deleted AD user from the Recycle Bin.
    Generates a temporary password, sets mustChangePassword, and removes the tombstone record.
    Returns the temp password — shown once to the admin.
    """
    sam = body.get("sam_account_name", "").strip()
    if not sam:
        raise HTTPException(status_code=400, detail="sam_account_name is required")

    # Load AD config
    cfg_row = await db.execute(
        text("""
            SELECT dc_host, base_dn, service_account, service_password
            FROM ad_configs
            WHERE agent_id = CAST(:aid AS uuid) AND is_active = TRUE
        """),
        {"aid": agent_id},
    )
    cfg = cfg_row.fetchone()
    if not cfg:
        raise HTTPException(status_code=404, detail="AD not configured for this agent")

    # Load tombstone to get original DN
    await _ensure_deleted_users_table(db)
    tomb_row = await db.execute(
        text("""
            SELECT id, distinguished_name FROM ad_deleted_users
            WHERE agent_id = CAST(:aid AS uuid) AND sam_account_name = :sam
            ORDER BY deleted_at DESC LIMIT 1
        """),
        {"aid": agent_id, "sam": sam},
    )
    tomb = tomb_row.fetchone()
    original_dn = tomb[1] if tomb else None

    # Generate temp password
    temp_password = _generate_temp_password()

    # Execute LDAP restore (blocking — run in thread pool)
    import asyncio
    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            _ldap_restore_user,
            cfg[0], cfg[1], cfg[2], cfg[3],
            sam, original_dn or "", temp_password,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Log the action
    action_id = str(uuid.uuid4())
    await db.execute(text("""
        INSERT INTO ad_action_log
            (agent_id, performed_by, performed_by_username, action, target_user,
             notes, status, action_id, sam_account_name, completed_at)
        VALUES (
            CAST(:aid AS uuid), CAST(:uid AS uuid), :uname, 'restore', :sam,
            'Restored from Recycle Bin — temp password set', 'completed',
            :action_id, :sam, NOW()
        )
    """), {
        "aid": agent_id, "uid": str(user.id), "uname": user.username,
        "sam": sam, "action_id": action_id,
    })

    # Remove tombstone and add user back to ad_users (next sync will fully populate)
    if tomb:
        await db.execute(
            text("DELETE FROM ad_deleted_users WHERE id = CAST(:id AS uuid)"),
            {"id": str(tomb[0])},
        )

    await db.commit()

    return {
        "status": "restored",
        "sam_account_name": sam,
        "password_set": result["password_set"],
        "temp_password": temp_password if result["password_set"] else None,
        "message": result["message"],
        "action_id": action_id,
    }
