"""
Phishing Simulation module.
- Campaign/template/target CRUD (authenticated)
- Email delivery via configured SMTP notification channel
- Public tracking endpoints: pixel open, click redirect, lure landing page, cred submit
"""
import asyncio
import csv
import io
import json
import logging
import smtplib
import uuid
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import make_msgid, formatdate

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.database import engine, get_db
from api.services.auth import get_current_user, require_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/phishing", tags=["Phishing Simulation"])

# ── DDL ──────────────────────────────────────────────────────────────────────

_BUILTIN_TEMPLATES = [
    {
        "name": "Microsoft 365 — Account Expiry Warning",
        "category": "credential",
        "subject": "Action Required: Your Microsoft 365 account will expire in 24 hours",
        "sender_name": "Microsoft 365 Admin",
        "sender_email": "noreply@microsoft365-admin.com",
        "body_html": """<html><body style="font-family:Segoe UI,Arial,sans-serif;background:#f3f2f1;margin:0;padding:20px">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:4px;overflow:hidden">
  <div style="background:#0078d4;padding:20px 30px">
    <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/4/44/Microsoft_logo.svg/200px-Microsoft_logo.svg.png" style="height:24px">
  </div>
  <div style="padding:30px">
    <h2 style="color:#323130;margin-top:0">Your account access will be suspended</h2>
    <p style="color:#605e5c">Dear {{FIRST_NAME}},</p>
    <p style="color:#605e5c">We detected unusual sign-in activity on your Microsoft 365 account associated with <strong>{{TARGET_EMAIL}}</strong>. To protect your organisation, your access will be suspended in <strong>24 hours</strong> unless you verify your identity.</p>
    <div style="text-align:center;margin:30px 0">
      <a href="{{CLICK_URL}}" style="background:#0078d4;color:#fff;padding:12px 28px;text-decoration:none;border-radius:2px;font-weight:600;display:inline-block">Verify My Account</a>
    </div>
    <p style="color:#a19f9d;font-size:12px">If you did not request this, ignore this message. Microsoft will never ask for your password via email.</p>
  </div>
  <div style="background:#f3f2f1;padding:15px 30px;font-size:11px;color:#a19f9d">
    Microsoft Corporation, One Microsoft Way, Redmond, WA 98052
  </div>
</div>
{{TRACKING_PIXEL}}
</body></html>""",
        "landing_page_html": """<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Sign in - Microsoft 365</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',sans-serif;background:#f3f2f1;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#fff;border-radius:6px;padding:44px;width:440px;box-shadow:0 2px 6px rgba(0,0,0,.15)}
.logo{height:28px;margin-bottom:24px}.title{font-size:24px;color:#1b1b1b;margin-bottom:4px;font-weight:600}
.sub{font-size:13px;color:#605e5c;margin-bottom:20px}
.alert{background:#fff4ce;border-left:3px solid #ffc83d;padding:10px 14px;font-size:12px;color:#323130;margin-bottom:18px;border-radius:2px}
label{display:block;font-size:13px;color:#323130;margin-bottom:4px}
input[type=email],input[type=password]{width:100%;border:1px solid #8a8886;padding:8px 10px;font-size:14px;border-radius:2px;margin-bottom:16px;outline:none}
input:focus{border-color:#0078d4}
.btn{width:100%;background:#0078d4;color:#fff;border:none;padding:10px;font-size:15px;font-weight:600;border-radius:2px;cursor:pointer;margin-top:4px}
.btn:hover{background:#106ebe}.footer{font-size:11px;color:#a19f9d;margin-top:20px;text-align:center}</style></head>
<body><div class="card">
  <img class="logo" src="https://upload.wikimedia.org/wikipedia/commons/thumb/4/44/Microsoft_logo.svg/200px-Microsoft_logo.svg.png" alt="Microsoft">
  <div class="title">Sign in</div>
  <div class="sub">to continue to Microsoft 365</div>
  <div class="alert">⚠ Your session has expired. Please sign in again to verify your identity.</div>
  <form method="POST">
    <label>Email</label><input type="email" name="email" placeholder="user@company.com" required>
    <label>Password</label><input type="password" name="password" placeholder="Password" required>
    <button class="btn">Sign in</button>
  </form>
  <div class="footer">© 2025 Microsoft Corporation. All rights reserved.</div>
</div></body></html>""",
        "is_builtin": True,
    },
    {
        "name": "IT Help Desk — Password Reset Required",
        "category": "credential",
        "subject": "IT Security: Mandatory password reset — your account has been flagged",
        "sender_name": "IT Help Desk",
        "sender_email": "helpdesk@it-support.internal",
        "body_html": """<html><body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:20px">
<div style="max-width:580px;margin:0 auto;background:#fff;border-top:4px solid #d32f2f">
  <div style="padding:24px 30px;border-bottom:1px solid #eee">
    <h2 style="color:#d32f2f;margin:0;font-size:18px">🔒 IT Security Alert — Immediate Action Required</h2>
  </div>
  <div style="padding:24px 30px">
    <p>Dear {{FIRST_NAME}},</p>
    <p>Our security systems have flagged your account (<strong>{{TARGET_EMAIL}}</strong>) for a potential compromise. As a precautionary measure, your account password must be reset within the next <strong>2 hours</strong> or it will be locked.</p>
    <table style="background:#fff3cd;border:1px solid #ffc107;border-radius:4px;padding:12px 16px;width:100%;margin:16px 0">
      <tr><td style="font-size:13px;color:#856404">⚠ Detected: Multiple failed login attempts from an unrecognised IP address (41.80.x.x)</td></tr>
    </table>
    <div style="text-align:center;margin:24px 0">
      <a href="{{CLICK_URL}}" style="background:#d32f2f;color:#fff;padding:12px 32px;text-decoration:none;border-radius:4px;font-weight:bold;display:inline-block">Reset My Password Now</a>
    </div>
    <p style="font-size:12px;color:#999">Reference: TKT-{{TOKEN_SHORT}} | IT Security Team</p>
  </div>
</div>
{{TRACKING_PIXEL}}
</body></html>""",
        "landing_page_html": """<!DOCTYPE html><html><head><meta charset="UTF-8"><title>IT Portal — Password Reset</title>
<style>*{box-sizing:border-box}body{font-family:Arial,sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#fff;border-radius:8px;padding:40px;width:420px;box-shadow:0 4px 12px rgba(0,0,0,.1)}
.header{display:flex;align-items:center;gap:12px;margin-bottom:24px}
.icon{width:48px;height:48px;background:#d32f2f;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:22px;flex-shrink:0}
h2{color:#1a1a1a;margin:0;font-size:20px}p.sub{color:#666;font-size:13px;margin:0}
.alert{background:#fff3cd;border-left:4px solid #ffc107;padding:10px 14px;font-size:13px;color:#664d03;margin-bottom:20px;border-radius:2px}
label{display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:4px}
input[type=password],input[type=text]{width:100%;border:1px solid #ccc;padding:9px 12px;font-size:14px;border-radius:4px;margin-bottom:14px;outline:none}
input:focus{border-color:#d32f2f;box-shadow:0 0 0 2px rgba(211,47,47,.1)}
.btn{width:100%;background:#d32f2f;color:#fff;border:none;padding:11px;font-size:15px;font-weight:600;border-radius:4px;cursor:pointer}
.btn:hover{background:#b71c1c}</style></head>
<body><div class="card">
  <div class="header"><div class="icon">🔒</div><div><h2>Password Reset</h2><p class="sub">IT Security Portal</p></div></div>
  <div class="alert">Your account has been flagged. Enter a new password to secure it.</div>
  <form method="POST">
    <label>Current Password</label><input type="password" name="current_password" required>
    <label>New Password</label><input type="password" name="new_password" required>
    <label>Confirm New Password</label><input type="password" name="confirm_password" required>
    <button class="btn">Reset Password</button>
  </form>
</div></body></html>""",
        "is_builtin": True,
    },
    {
        "name": "HR Payroll — Banking Details Update",
        "category": "credential",
        "subject": "HR Notice: Update your banking details before the next payroll run",
        "sender_name": "HR Payroll Team",
        "sender_email": "payroll@hr-portal.co",
        "body_html": """<html><body style="font-family:Calibri,Arial,sans-serif;background:#f7f7f7;margin:0;padding:20px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:6px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
  <div style="background:#1a5276;padding:20px 28px;color:#fff">
    <h3 style="margin:0;font-size:16px;font-weight:600">Human Resources — Payroll Department</h3>
  </div>
  <div style="padding:28px">
    <p>Dear {{FIRST_NAME}},</p>
    <p>As part of our annual banking detail verification process, all employees are required to confirm or update their salary payment information in the HR self-service portal <strong>before 5:00 PM on Friday</strong>.</p>
    <p>Failure to verify your details may result in a delay or suspension of your next salary payment.</p>
    <div style="background:#eaf4fb;border-left:4px solid #1a5276;padding:12px 16px;margin:20px 0;font-size:13px">
      Employee: <strong>{{FIRST_NAME}} — {{TARGET_EMAIL}}</strong><br>
      Deadline: <strong>Friday 5:00 PM EAT</strong>
    </div>
    <div style="text-align:center;margin:24px 0">
      <a href="{{CLICK_URL}}" style="background:#1a5276;color:#fff;padding:12px 30px;text-decoration:none;border-radius:4px;font-weight:bold;display:inline-block">Update Banking Details</a>
    </div>
    <p style="font-size:12px;color:#999">HR Payroll Department | Confidential</p>
  </div>
</div>
{{TRACKING_PIXEL}}
</body></html>""",
        "landing_page_html": """<!DOCTYPE html><html><head><meta charset="UTF-8"><title>HR Self-Service Portal</title>
<style>*{box-sizing:border-box}body{font-family:Calibri,Arial,sans-serif;background:#eaf4fb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#fff;border-radius:6px;padding:36px;width:460px;box-shadow:0 2px 12px rgba(0,0,0,.1)}
.header{background:#1a5276;color:#fff;margin:-36px -36px 24px;padding:16px 24px;border-radius:6px 6px 0 0;font-size:15px;font-weight:600}
h3{color:#1a5276;margin:0 0 16px}
label{display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:4px}
input{width:100%;border:1px solid #ccc;padding:8px 12px;font-size:14px;border-radius:4px;margin-bottom:14px;outline:none}
input:focus{border-color:#1a5276}
.btn{width:100%;background:#1a5276;color:#fff;border:none;padding:10px;font-size:14px;font-weight:600;border-radius:4px;cursor:pointer}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}</style></head>
<body><div class="card">
  <div class="header">HR Self-Service Portal — Banking Details</div>
  <h3>Verify Banking Information</h3>
  <form method="POST">
    <label>Employee ID</label><input type="text" name="employee_id" required>
    <label>Bank Name</label><input type="text" name="bank_name" required>
    <div class="row">
      <div><label>Account Number</label><input type="text" name="account_number" required></div>
      <div><label>Branch Code</label><input type="text" name="branch_code"></div>
    </div>
    <label>Confirm Password</label><input type="password" name="password" required>
    <button class="btn">Submit Update</button>
  </form>
</div></body></html>""",
        "is_builtin": True,
    },
    {
        "name": "Awareness Only — General Phishing Test",
        "category": "awareness",
        "subject": "Important: Review and sign the updated IT Security Policy",
        "sender_name": "IT Security",
        "sender_email": "security@company.internal",
        "body_html": """<html><body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:20px">
<div style="max-width:560px;margin:0 auto;background:#fff;padding:30px;border-radius:6px">
  <h2 style="color:#333">Updated IT Security Policy — Action Required</h2>
  <p>Dear {{FIRST_NAME}},</p>
  <p>Please review and acknowledge the updated <strong>IT Security Policy 2025</strong> by clicking the link below. All employees must sign off by end of this week.</p>
  <div style="text-align:center;margin:24px 0">
    <a href="{{CLICK_URL}}" style="background:#2e7d32;color:#fff;padding:12px 28px;text-decoration:none;border-radius:4px;font-weight:bold;display:inline-block">Review Policy Document</a>
  </div>
  <p style="font-size:12px;color:#999">IT Security Team</p>
</div>
{{TRACKING_PIXEL}}
</body></html>""",
        "landing_page_html": "",
        "is_builtin": True,
    },
]

_AWARENESS_HTML = """<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Security Awareness</title>
<style>body{font-family:Arial,sans-serif;background:#fff3cd;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#fff;border-radius:8px;padding:40px;max-width:520px;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,.1)}
.icon{font-size:60px;margin-bottom:16px}.title{color:#e65100;font-size:24px;font-weight:700;margin-bottom:12px}
p{color:#555;line-height:1.6;margin-bottom:12px}.tips{background:#f8f9fa;border-radius:6px;padding:16px;text-align:left;margin-top:16px}
.tips li{color:#333;font-size:14px;margin-bottom:6px}</style></head>
<body><div class="card">
  <div class="icon">⚠️</div>
  <div class="title">You clicked a simulated phishing link!</div>
  <p>This was a <strong>security awareness test</strong> conducted by your IT department. You clicked a link in a simulated phishing email.</p>
  <p>In a real attack, this could have led to your credentials being stolen or malware being installed.</p>
  <div class="tips"><strong>Remember:</strong><ul>
    <li>Always check the sender's email address carefully</li>
    <li>Never click unexpected links — go directly to the website instead</li>
    <li>Look for urgency/pressure tactics — these are red flags</li>
    <li>When in doubt, call IT before taking action</li>
    <li>Report suspicious emails to your IT security team</li>
  </ul></div>
</div></body></html>"""

_SUBMIT_AWARENESS_HTML = """<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Security Awareness</title>
<style>body{font-family:Arial,sans-serif;background:#ffebee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#fff;border-radius:8px;padding:40px;max-width:520px;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,.1)}
.icon{font-size:60px;margin-bottom:16px}.title{color:#c62828;font-size:24px;font-weight:700;margin-bottom:12px}
p{color:#555;line-height:1.6;margin-bottom:12px}</style></head>
<body><div class="card">
  <div class="icon">🚨</div>
  <div class="title">You submitted credentials to a phishing page!</div>
  <p>This was a <strong>security awareness test</strong>. You entered information into a fake login form.</p>
  <p>In a real attack, your credentials would now be in the hands of a cybercriminal. Please contact your IT security team immediately to change your passwords.</p>
  <p><strong>Always verify the URL in your browser's address bar before entering any credentials.</strong></p>
</div></body></html>"""


_TABLES_STMTS = [
    """CREATE TABLE IF NOT EXISTS phishing_campaigns (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'draft',
        template_id UUID,
        smtp_channel_id UUID,
        base_url TEXT DEFAULT '',
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )""",
    """CREATE TABLE IF NOT EXISTS phishing_templates (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name TEXT NOT NULL,
        category TEXT DEFAULT 'credential',
        subject TEXT NOT NULL,
        sender_name TEXT DEFAULT 'IT Support',
        sender_email TEXT DEFAULT 'support@company.com',
        body_html TEXT NOT NULL,
        landing_page_html TEXT DEFAULT '',
        is_builtin BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )""",
    """CREATE TABLE IF NOT EXISTS phishing_targets (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        campaign_id UUID NOT NULL REFERENCES phishing_campaigns(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        first_name TEXT DEFAULT '',
        last_name TEXT DEFAULT '',
        department TEXT DEFAULT '',
        token TEXT UNIQUE NOT NULL DEFAULT gen_random_uuid()::text,
        send_status TEXT DEFAULT 'pending',
        sent_at TIMESTAMPTZ,
        opened_at TIMESTAMPTZ,
        clicked_at TIMESTAMPTZ,
        submitted_at TIMESTAMPTZ,
        reported_at TIMESTAMPTZ,
        ip_address TEXT,
        user_agent TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )""",
    "CREATE INDEX IF NOT EXISTS idx_phishing_targets_campaign ON phishing_targets(campaign_id)",
    "CREATE INDEX IF NOT EXISTS idx_phishing_targets_token ON phishing_targets(token)",
]

_tables_created = False


async def _ensure_tables():
    global _tables_created
    if _tables_created:
        return
    async with engine.begin() as conn:
        for stmt in _TABLES_STMTS:
            await conn.execute(text(stmt))
        # Seed built-in templates if not present
        existing = await conn.execute(
            text("SELECT COUNT(*) FROM phishing_templates WHERE is_builtin = TRUE")
        )
        if existing.scalar() == 0:
            for t in _BUILTIN_TEMPLATES:
                await conn.execute(text("""
                    INSERT INTO phishing_templates
                        (name, category, subject, sender_name, sender_email,
                         body_html, landing_page_html, is_builtin)
                    VALUES (:name, :category, :subject, :sender_name, :sender_email,
                            :body_html, :landing_page_html, :is_builtin)
                """), t)
    _tables_created = True


# ── SMTP helper ───────────────────────────────────────────────────────────────

_LOCAL_RELAY_HOST = "kifaa-mailrelay"
_LOCAL_RELAY_PORT = 25


def _build_smtp_config_local() -> dict:
    """Return SMTP config for the built-in Postfix relay container."""
    return {
        "host": _LOCAL_RELAY_HOST,
        "port": _LOCAL_RELAY_PORT,
        "use_tls": False,
        "username": "",
        "password": "",
    }


def _send_phishing_email_sync(smtp_config: dict, to_addr: str, subject: str,
                               from_name: str, from_addr: str, body_html: str):
    """Send a single HTML phishing email synchronously (called in thread pool).

    from_addr — the envelope/From address. When using the local relay this can
    be any address (e.g. noreply@microsoft365-admin.com) since Postfix does not
    enforce authenticated-sender restrictions.
    """
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"{from_name} <{from_addr}>"
    msg["To"] = to_addr
    msg["Date"] = formatdate(localtime=False)
    msg["Message-ID"] = make_msgid(domain=from_addr.split("@")[-1])
    msg["X-Mailer"] = "Microsoft Outlook 16.0"
    msg.attach(MIMEText(body_html, "html"))

    host = smtp_config.get("host", "")
    port = int(smtp_config.get("port", 587))
    username = smtp_config.get("username", "")
    password = smtp_config.get("password", "")
    use_tls = smtp_config.get("use_tls", True)

    if not host:
        raise ValueError("SMTP host is required")

    if use_tls and port == 465:
        with smtplib.SMTP_SSL(host, port, timeout=30) as server:
            if username:
                server.login(username, password)
            server.sendmail(from_addr, [to_addr], msg.as_string())
    else:
        with smtplib.SMTP(host, port, timeout=30) as server:
            server.ehlo()
            if use_tls:
                server.starttls()
                server.ehlo()
            if username:
                server.login(username, password)
            server.sendmail(from_addr, [to_addr], msg.as_string())


def _build_email_html(body_html: str, target: dict, base_url: str) -> str:
    """Replace template placeholders with real tracking URLs and target info."""
    token = target["token"]
    click_url = f"{base_url.rstrip('/')}/api/v1/phishing/t/{token}/c"
    pixel_url = f"{base_url.rstrip('/')}/api/v1/phishing/t/{token}/o"

    html = body_html
    html = html.replace("{{FIRST_NAME}}", target.get("first_name") or target.get("email", "").split("@")[0])
    html = html.replace("{{LAST_NAME}}", target.get("last_name") or "")
    html = html.replace("{{TARGET_EMAIL}}", target.get("email", ""))
    html = html.replace("{{CLICK_URL}}", click_url)
    html = html.replace("{{TOKEN_SHORT}}", token[:8].upper())
    html = html.replace("{{TRACKING_PIXEL}}", f'<img src="{pixel_url}" width="1" height="1" style="display:none">')
    return html


async def _send_campaign_emails(campaign_id: str, db_url: str):
    """Background: send emails for all pending targets in a campaign."""
    import psycopg2

    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    cur = conn.cursor()

    try:
        # Fetch campaign + template + smtp config
        cur.execute("""
            SELECT c.id, c.base_url, c.smtp_channel_id,
                   t.subject, t.sender_name, t.sender_email, t.body_html
            FROM phishing_campaigns c
            JOIN phishing_templates t ON t.id = c.template_id
            WHERE c.id = %s
        """, (campaign_id,))
        row = cur.fetchone()
        if not row:
            return

        (camp_id, base_url, smtp_channel_id,
         subject, sender_name, sender_email, body_html) = row

        # Fetch SMTP config — fall back to built-in local relay if none configured
        smtp_config = {}
        # __local__ = built-in Postfix relay; skip DB lookup
        if smtp_channel_id and str(smtp_channel_id) != "__local__":
            cur.execute(
                "SELECT config FROM notification_channels WHERE id = %s AND type = 'smtp'",
                (str(smtp_channel_id),)
            )
            ch = cur.fetchone()
            if ch:
                smtp_config = ch[0] if isinstance(ch[0], dict) else json.loads(ch[0])

        if not smtp_config or not smtp_config.get("host"):
            # Use the built-in Postfix relay — no authentication required,
            # allows any From address (no SendAs restrictions like O365)
            logger.info(f"Campaign {campaign_id}: using built-in local relay (kifaa-mailrelay)")
            smtp_config = _build_smtp_config_local()

        # Determine envelope From address.
        # - Local relay: use the template's sender_email directly (no restriction)
        # - External SMTP (e.g. O365): must use the authenticated account address
        is_local_relay = smtp_config.get("host", "") in (_LOCAL_RELAY_HOST, "localhost", "127.0.0.1")
        if is_local_relay:
            smtp_from_addr = sender_email  # full spoof — relay allows any From
        else:
            smtp_from_addr = (
                smtp_config.get("from_address")
                or smtp_config.get("username")
                or sender_email
            )

        # Fetch pending targets
        cur.execute("""
            SELECT id::text, email, first_name, last_name, token
            FROM phishing_targets
            WHERE campaign_id = %s AND send_status = 'pending'
        """, (campaign_id,))
        targets = cur.fetchall()

        for (target_id, email, first_name, last_name, token) in targets:
            target = {"email": email, "first_name": first_name or "", "last_name": last_name or "", "token": token}
            html = _build_email_html(body_html, target, base_url)
            try:
                loop = asyncio.get_event_loop()
                await loop.run_in_executor(
                    None,
                    _send_phishing_email_sync,
                    smtp_config, email, subject, sender_name, smtp_from_addr, html
                )
                cur.execute(
                    "UPDATE phishing_targets SET send_status = 'sent', sent_at = NOW() WHERE id = %s",
                    (target_id,)
                )
            except Exception as e:
                logger.warning(f"Phishing email to {email} failed: {e}")
                cur.execute(
                    "UPDATE phishing_targets SET send_status = 'failed' WHERE id = %s",
                    (target_id,)
                )

        # Mark campaign completed (if all sent)
        cur.execute(
            "UPDATE phishing_campaigns SET status = 'running', started_at = COALESCE(started_at, NOW()) WHERE id = %s",
            (campaign_id,)
        )

    except Exception as e:
        logger.error(f"Phishing campaign send error: {e}")
        try:
            cur.execute(
                "UPDATE phishing_campaigns SET status = 'error' WHERE id = %s",
                (campaign_id,)
            )
        except Exception:
            pass
    finally:
        try:
            cur.close()
            conn.close()
        except Exception:
            pass


# ── Campaign endpoints ────────────────────────────────────────────────────────

@router.get("/campaigns")
async def list_campaigns(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_tables()
    rows = await db.execute(text("""
        SELECT c.id, c.name, c.description, c.status, c.base_url,
               c.started_at, c.completed_at, c.created_at,
               t.name AS template_name,
               COUNT(DISTINCT tg.id) AS total_targets,
               COUNT(DISTINCT tg.id) FILTER (WHERE tg.send_status = 'sent') AS sent_count,
               COUNT(DISTINCT tg.id) FILTER (WHERE tg.opened_at IS NOT NULL) AS opened_count,
               COUNT(DISTINCT tg.id) FILTER (WHERE tg.clicked_at IS NOT NULL) AS clicked_count,
               COUNT(DISTINCT tg.id) FILTER (WHERE tg.submitted_at IS NOT NULL) AS submitted_count
        FROM phishing_campaigns c
        LEFT JOIN phishing_templates t ON t.id = c.template_id
        LEFT JOIN phishing_targets tg ON tg.campaign_id = c.id
        GROUP BY c.id, t.name
        ORDER BY c.created_at DESC
    """))
    return [_campaign_row(r) for r in rows.fetchall()]


@router.post("/campaigns", status_code=201)
async def create_campaign(body: dict, db: AsyncSession = Depends(get_db), _=Depends(require_admin)):
    await _ensure_tables()
    if not body.get("name"):
        raise HTTPException(400, "name is required")
    if not body.get("template_id"):
        raise HTTPException(400, "template_id is required")

    r = await db.execute(text("""
        INSERT INTO phishing_campaigns
            (name, description, template_id, smtp_channel_id, base_url, created_by)
        VALUES (:name, :desc, CAST(:tid AS uuid), CAST(:smtp AS uuid), :base_url, :by)
        RETURNING id
    """), {
        "name": body["name"],
        "desc": body.get("description") or "",
        "tid": body["template_id"],
        "smtp": body.get("smtp_channel_id") or None,
        "base_url": (body.get("base_url") or "").rstrip("/"),
        "by": body.get("created_by") or "admin",
    })
    await db.commit()
    new_id = str(r.fetchone()[0])
    return {"id": new_id}


@router.get("/campaigns/{campaign_id}")
async def get_campaign(campaign_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_tables()
    row = await db.execute(text("""
        SELECT c.id, c.name, c.description, c.status, c.base_url,
               c.template_id, c.smtp_channel_id,
               c.started_at, c.completed_at, c.created_at,
               t.name AS template_name,
               COUNT(DISTINCT tg.id) AS total_targets,
               COUNT(DISTINCT tg.id) FILTER (WHERE tg.send_status = 'sent') AS sent_count,
               COUNT(DISTINCT tg.id) FILTER (WHERE tg.opened_at IS NOT NULL) AS opened_count,
               COUNT(DISTINCT tg.id) FILTER (WHERE tg.clicked_at IS NOT NULL) AS clicked_count,
               COUNT(DISTINCT tg.id) FILTER (WHERE tg.submitted_at IS NOT NULL) AS submitted_count
        FROM phishing_campaigns c
        LEFT JOIN phishing_templates t ON t.id = c.template_id
        LEFT JOIN phishing_targets tg ON tg.campaign_id = c.id
        WHERE c.id = :id
        GROUP BY c.id, t.name, c.template_id, c.smtp_channel_id
    """), {"id": campaign_id})
    r = row.fetchone()
    if not r:
        raise HTTPException(404, "Campaign not found")
    d = _campaign_row(r)
    d["template_id"] = str(r.template_id) if r.template_id else None
    d["smtp_channel_id"] = str(r.smtp_channel_id) if r.smtp_channel_id else None
    return d


@router.put("/campaigns/{campaign_id}")
async def update_campaign(campaign_id: str, body: dict, db: AsyncSession = Depends(get_db), _=Depends(require_admin)):
    await _ensure_tables()
    await db.execute(text("""
        UPDATE phishing_campaigns SET
            name = COALESCE(:name, name),
            description = COALESCE(:desc, description),
            template_id = COALESCE(CAST(:tid AS uuid), template_id),
            smtp_channel_id = CAST(:smtp AS uuid),
            base_url = COALESCE(:base_url, base_url)
        WHERE id = :id
    """), {
        "id": campaign_id,
        "name": body.get("name"),
        "desc": body.get("description"),
        "tid": body.get("template_id"),
        "smtp": body.get("smtp_channel_id") or None,
        "base_url": (body.get("base_url") or "").rstrip("/") or None,
    })
    await db.commit()
    return {"ok": True}


@router.delete("/campaigns/{campaign_id}", status_code=204)
async def delete_campaign(campaign_id: str, db: AsyncSession = Depends(get_db), _=Depends(require_admin)):
    await _ensure_tables()
    await db.execute(text("DELETE FROM phishing_campaigns WHERE id = :id"), {"id": campaign_id})
    await db.commit()


@router.post("/campaigns/{campaign_id}/launch")
async def launch_campaign(
    campaign_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    _=Depends(require_admin),
):
    await _ensure_tables()
    row = await db.execute(
        text("SELECT status, template_id, smtp_channel_id, base_url FROM phishing_campaigns WHERE id = :id"),
        {"id": campaign_id}
    )
    camp = row.fetchone()
    if not camp:
        raise HTTPException(404, "Campaign not found")
    if camp.status == "running":
        raise HTTPException(400, "Campaign is already running")
    if not camp.template_id:
        raise HTTPException(400, "Campaign has no template selected")
    if not camp.base_url:
        raise HTTPException(400, "Campaign base_url is required for tracking links")

    # Count pending targets
    cnt = await db.execute(
        text("SELECT COUNT(*) FROM phishing_targets WHERE campaign_id = :id AND send_status = 'pending'"),
        {"id": campaign_id}
    )
    pending = cnt.scalar()
    if not pending:
        raise HTTPException(400, "No pending targets to send to")

    await db.execute(
        text("UPDATE phishing_campaigns SET status = 'sending' WHERE id = :id"),
        {"id": campaign_id}
    )
    await db.commit()

    import os
    db_url = os.getenv("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    background_tasks.add_task(_send_campaign_emails, campaign_id, db_url)

    return {"ok": True, "targets_queued": pending}


@router.post("/campaigns/{campaign_id}/complete")
async def complete_campaign(campaign_id: str, db: AsyncSession = Depends(get_db), _=Depends(require_admin)):
    await db.execute(
        text("UPDATE phishing_campaigns SET status = 'completed', completed_at = NOW() WHERE id = :id"),
        {"id": campaign_id}
    )
    await db.commit()
    return {"ok": True}


@router.post("/campaigns/{campaign_id}/reset")
async def reset_campaign(campaign_id: str, db: AsyncSession = Depends(get_db), _=Depends(require_admin)):
    """Reset a campaign back to draft (clears target send status for re-send)."""
    await db.execute(text("""
        UPDATE phishing_campaigns SET status = 'draft', started_at = NULL, completed_at = NULL WHERE id = :id
    """), {"id": campaign_id})
    await db.execute(text("""
        UPDATE phishing_targets SET send_status = 'pending', sent_at = NULL,
            opened_at = NULL, clicked_at = NULL, submitted_at = NULL, reported_at = NULL
        WHERE campaign_id = :id
    """), {"id": campaign_id})
    await db.commit()
    return {"ok": True}


# ── Target endpoints ──────────────────────────────────────────────────────────

@router.get("/campaigns/{campaign_id}/targets")
async def list_targets(campaign_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_tables()
    rows = await db.execute(text("""
        SELECT id, email, first_name, last_name, department,
               send_status, sent_at, opened_at, clicked_at, submitted_at, reported_at
        FROM phishing_targets WHERE campaign_id = :id
        ORDER BY email
    """), {"id": campaign_id})
    return [_target_row(r) for r in rows.fetchall()]


@router.post("/campaigns/{campaign_id}/targets", status_code=201)
async def add_target(campaign_id: str, body: dict, db: AsyncSession = Depends(get_db), _=Depends(require_admin)):
    await _ensure_tables()
    email = (body.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(400, "email is required")
    await db.execute(text("""
        INSERT INTO phishing_targets (campaign_id, email, first_name, last_name, department)
        VALUES (CAST(:cid AS uuid), :email, :fn, :ln, :dept)
    """), {
        "cid": campaign_id,
        "email": email,
        "fn": (body.get("first_name") or "").strip(),
        "ln": (body.get("last_name") or "").strip(),
        "dept": (body.get("department") or "").strip(),
    })
    await db.commit()
    return {"ok": True}


@router.post("/campaigns/{campaign_id}/targets/import")
async def import_targets(campaign_id: str, request: Request,
                          db: AsyncSession = Depends(get_db), _=Depends(require_admin)):
    """Bulk import from JSON list or CSV text."""
    await _ensure_tables()
    body = await request.json()
    targets = body.get("targets", [])
    added = 0
    for t in targets:
        email = (t.get("email") or "").strip().lower()
        if not email:
            continue
        try:
            await db.execute(text("""
                INSERT INTO phishing_targets (campaign_id, email, first_name, last_name, department)
                VALUES (CAST(:cid AS uuid), :email, :fn, :ln, :dept)
            """), {
                "cid": campaign_id,
                "email": email,
                "fn": (t.get("first_name") or t.get("firstName") or "").strip(),
                "ln": (t.get("last_name") or t.get("lastName") or "").strip(),
                "dept": (t.get("department") or "").strip(),
            })
            added += 1
        except Exception:
            pass
    await db.commit()
    return {"added": added}


@router.delete("/campaigns/{campaign_id}/targets/{target_id}", status_code=204)
async def delete_target(campaign_id: str, target_id: str,
                         db: AsyncSession = Depends(get_db), _=Depends(require_admin)):
    await db.execute(
        text("DELETE FROM phishing_targets WHERE id = :tid AND campaign_id = :cid"),
        {"tid": target_id, "cid": campaign_id}
    )
    await db.commit()


# ── Template endpoints ────────────────────────────────────────────────────────

@router.get("/templates")
async def list_templates(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_tables()
    rows = await db.execute(text("""
        SELECT id, name, category, subject, sender_name, sender_email,
               is_builtin, created_at
        FROM phishing_templates ORDER BY is_builtin DESC, name
    """))
    return [
        {
            "id": str(r.id),
            "name": r.name,
            "category": r.category,
            "subject": r.subject,
            "sender_name": r.sender_name,
            "sender_email": r.sender_email,
            "is_builtin": r.is_builtin,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows.fetchall()
    ]


@router.get("/templates/{template_id}")
async def get_template(template_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    await _ensure_tables()
    row = await db.execute(
        text("SELECT * FROM phishing_templates WHERE id = :id"),
        {"id": template_id}
    )
    r = row.fetchone()
    if not r:
        raise HTTPException(404, "Template not found")
    return {
        "id": str(r.id),
        "name": r.name,
        "category": r.category,
        "subject": r.subject,
        "sender_name": r.sender_name,
        "sender_email": r.sender_email,
        "body_html": r.body_html,
        "landing_page_html": r.landing_page_html or "",
        "is_builtin": r.is_builtin,
    }


@router.post("/templates", status_code=201)
async def create_template(body: dict, db: AsyncSession = Depends(get_db), _=Depends(require_admin)):
    await _ensure_tables()
    if not body.get("name") or not body.get("subject") or not body.get("body_html"):
        raise HTTPException(400, "name, subject, and body_html are required")
    r = await db.execute(text("""
        INSERT INTO phishing_templates
            (name, category, subject, sender_name, sender_email, body_html, landing_page_html)
        VALUES (:name, :cat, :subject, :sname, :semail, :body, :landing)
        RETURNING id
    """), {
        "name": body["name"],
        "cat": body.get("category", "credential"),
        "subject": body["subject"],
        "sname": body.get("sender_name", "IT Support"),
        "semail": body.get("sender_email", "support@company.com"),
        "body": body["body_html"],
        "landing": body.get("landing_page_html", ""),
    })
    await db.commit()
    return {"id": str(r.fetchone()[0])}


@router.put("/templates/{template_id}")
async def update_template(template_id: str, body: dict,
                           db: AsyncSession = Depends(get_db), _=Depends(require_admin)):
    await _ensure_tables()
    row = await db.execute(text("SELECT is_builtin FROM phishing_templates WHERE id = :id"), {"id": template_id})
    t = row.fetchone()
    if not t:
        raise HTTPException(404, "Template not found")
    if t.is_builtin:
        raise HTTPException(400, "Built-in templates cannot be edited. Clone it first.")
    await db.execute(text("""
        UPDATE phishing_templates SET
            name = :name, category = :cat, subject = :subject,
            sender_name = :sname, sender_email = :semail,
            body_html = :body, landing_page_html = :landing
        WHERE id = :id
    """), {
        "id": template_id,
        "name": body.get("name"), "cat": body.get("category"),
        "subject": body.get("subject"), "sname": body.get("sender_name"),
        "semail": body.get("sender_email"), "body": body.get("body_html"),
        "landing": body.get("landing_page_html", ""),
    })
    await db.commit()
    return {"ok": True}


@router.post("/templates/{template_id}/clone")
async def clone_template(template_id: str, db: AsyncSession = Depends(get_db), _=Depends(require_admin)):
    await _ensure_tables()
    row = await db.execute(text("SELECT * FROM phishing_templates WHERE id = :id"), {"id": template_id})
    t = row.fetchone()
    if not t:
        raise HTTPException(404, "Template not found")
    r = await db.execute(text("""
        INSERT INTO phishing_templates
            (name, category, subject, sender_name, sender_email, body_html, landing_page_html, is_builtin)
        VALUES (:name, :cat, :subject, :sname, :semail, :body, :landing, FALSE)
        RETURNING id
    """), {
        "name": f"{t.name} (copy)",
        "cat": t.category, "subject": t.subject,
        "sname": t.sender_name, "semail": t.sender_email,
        "body": t.body_html, "landing": t.landing_page_html or "",
    })
    await db.commit()
    return {"id": str(r.fetchone()[0])}


@router.delete("/templates/{template_id}", status_code=204)
async def delete_template(template_id: str, db: AsyncSession = Depends(get_db), _=Depends(require_admin)):
    row = await db.execute(text("SELECT is_builtin FROM phishing_templates WHERE id = :id"), {"id": template_id})
    t = row.fetchone()
    if not t:
        raise HTTPException(404, "Template not found")
    if t.is_builtin:
        raise HTTPException(400, "Built-in templates cannot be deleted")
    await db.execute(text("DELETE FROM phishing_templates WHERE id = :id"), {"id": template_id})
    await db.commit()


# ── SMTP channels helper ──────────────────────────────────────────────────────

@router.get("/smtp-channels")
async def list_smtp_channels(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    rows = await db.execute(text("""
        SELECT id, name, config->>'host' AS host
        FROM notification_channels
        WHERE type = 'smtp' AND is_active = TRUE
        ORDER BY name
    """))
    channels = [{"id": str(r.id), "name": r.name, "host": r.host} for r in rows.fetchall()]
    # Prepend the built-in local relay option (always available)
    channels.insert(0, {
        "id": "__local__",
        "name": "Built-in Mail Relay (Postfix)",
        "host": _LOCAL_RELAY_HOST,
    })
    return channels


# ── Public tracking endpoints (NO auth) ──────────────────────────────────────

@router.get("/t/{token}/o", include_in_schema=False)
async def track_open(token: str, request: Request, db: AsyncSession = Depends(get_db)):
    """Track email open via 1x1 pixel."""
    await db.execute(text("""
        UPDATE phishing_targets
        SET opened_at = COALESCE(opened_at, NOW()),
            ip_address = COALESCE(ip_address, :ip),
            user_agent = COALESCE(user_agent, :ua)
        WHERE token = :token
    """), {
        "token": token,
        "ip": request.client.host if request.client else None,
        "ua": request.headers.get("user-agent", "")[:500],
    })
    await db.commit()

    # Return 1x1 transparent GIF
    gif = b'\x47\x49\x46\x38\x39\x61\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00\x21\xf9\x04\x00\x00\x00\x00\x00\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3b'
    return Response(content=gif, media_type="image/gif",
                    headers={"Cache-Control": "no-store, no-cache"})


@router.get("/t/{token}/c", include_in_schema=False)
async def track_click(token: str, request: Request, db: AsyncSession = Depends(get_db)):
    """Track link click, then redirect to lure page or awareness page."""
    row = await db.execute(
        text("SELECT id, campaign_id FROM phishing_targets WHERE token = :token"),
        {"token": token}
    )
    target = row.fetchone()

    # Invalid token — return generic 404, do NOT reveal the awareness page
    if not target:
        return HTMLResponse(content="<html><body>Not found</body></html>", status_code=404)

    await db.execute(text("""
        UPDATE phishing_targets
        SET clicked_at = COALESCE(clicked_at, NOW()),
            opened_at = COALESCE(opened_at, NOW()),
            ip_address = COALESCE(ip_address, :ip),
            user_agent = COALESCE(user_agent, :ua)
        WHERE token = :token
    """), {
        "token": token,
        "ip": request.client.host if request.client else None,
        "ua": request.headers.get("user-agent", "")[:500],
    })
    await db.commit()

    # Check if campaign template has a lure (landing) page
    lp = await db.execute(text("""
        SELECT t.landing_page_html, t.category
        FROM phishing_targets tg
        JOIN phishing_campaigns c ON c.id = tg.campaign_id
        JOIN phishing_templates t ON t.id = c.template_id
        WHERE tg.token = :token
    """), {"token": token})
    tpl = lp.fetchone()
    if tpl and tpl.landing_page_html and tpl.landing_page_html.strip():
        # Serve lure page via redirect
        return RedirectResponse(url=f"/api/v1/phishing/lure/{token}", status_code=302)

    # No lure page — show awareness page directly (valid target only)
    return HTMLResponse(content=_AWARENESS_HTML, status_code=200)


@router.get("/lure/{token}", include_in_schema=False)
async def lure_page(token: str, db: AsyncSession = Depends(get_db)):
    """Serve the fake landing page for this token (valid targets only)."""
    row = await db.execute(text("""
        SELECT t.landing_page_html
        FROM phishing_targets tg
        JOIN phishing_campaigns c ON c.id = tg.campaign_id
        JOIN phishing_templates t ON t.id = c.template_id
        WHERE tg.token = :token
    """), {"token": token})
    r = row.fetchone()
    # Invalid token → 404
    if not r:
        return HTMLResponse(content="<html><body>Not found</body></html>", status_code=404)
    # Valid target but no lure page → fall back to awareness page
    if not r.landing_page_html:
        return HTMLResponse(content=_AWARENESS_HTML)
    return HTMLResponse(content=r.landing_page_html)


@router.post("/lure/{token}", include_in_schema=False)
async def lure_submit(token: str, request: Request, db: AsyncSession = Depends(get_db)):
    """Record credential submission from lure page (valid targets only)."""
    # Verify token belongs to an actual target
    check = await db.execute(
        text("SELECT id FROM phishing_targets WHERE token = :token"),
        {"token": token},
    )
    if not check.fetchone():
        return HTMLResponse(content="<html><body>Not found</body></html>", status_code=404)

    await db.execute(text("""
        UPDATE phishing_targets
        SET submitted_at = COALESCE(submitted_at, NOW())
        WHERE token = :token
    """), {"token": token})
    await db.commit()
    return HTMLResponse(content=_SUBMIT_AWARENESS_HTML)


# ── Serialisation helpers ─────────────────────────────────────────────────────

def _campaign_row(r) -> dict:
    total = r.total_targets or 0
    sent = r.sent_count or 0
    opened = r.opened_count or 0
    clicked = r.clicked_count or 0
    submitted = r.submitted_count or 0
    return {
        "id": str(r.id),
        "name": r.name,
        "description": r.description or "",
        "status": r.status,
        "base_url": r.base_url or "",
        "template_name": r.template_name or "—",
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "completed_at": r.completed_at.isoformat() if r.completed_at else None,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "stats": {
            "total": total,
            "sent": sent,
            "opened": opened,
            "clicked": clicked,
            "submitted": submitted,
            "open_rate": round(opened / sent * 100, 1) if sent > 0 else 0,
            "click_rate": round(clicked / sent * 100, 1) if sent > 0 else 0,
            "submit_rate": round(submitted / sent * 100, 1) if sent > 0 else 0,
        },
    }


def _target_row(r) -> dict:
    return {
        "id": str(r.id),
        "email": r.email,
        "first_name": r.first_name or "",
        "last_name": r.last_name or "",
        "department": r.department or "",
        "send_status": r.send_status,
        "sent_at": r.sent_at.isoformat() if r.sent_at else None,
        "opened_at": r.opened_at.isoformat() if r.opened_at else None,
        "clicked_at": r.clicked_at.isoformat() if r.clicked_at else None,
        "submitted_at": r.submitted_at.isoformat() if r.submitted_at else None,
        "reported_at": r.reported_at.isoformat() if r.reported_at else None,
    }
