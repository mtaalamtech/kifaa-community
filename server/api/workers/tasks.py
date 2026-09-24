import os
import subprocess
import datetime
import logging
import uuid
from api.workers.celery_app import celery_app
import httpx

logger = logging.getLogger(__name__)

API_BASE = "http://api:8000/api/v1"


@celery_app.task(name="api.workers.tasks.mark_offline_agents")
def mark_offline_agents():
    try:
        with httpx.Client(timeout=10) as client:
            r = client.post(f"{API_BASE}/agents/maintenance/mark-offline")
            return r.json()
    except Exception as e:
        return {"error": str(e)}


@celery_app.task(name="api.workers.tasks.evaluate_alerts")
def evaluate_alerts():
    try:
        with httpx.Client(timeout=30) as client:
            r = client.post(f"{API_BASE}/alerts/internal/evaluate")
            return r.json()
    except Exception as e:
        return {"error": str(e)}


@celery_app.task(name="api.workers.tasks.run_port_checks")
def run_port_checks():
    try:
        with httpx.Client(timeout=120) as client:
            r = client.post(f"{API_BASE}/monitoring/internal/run-checks")
            return r.json()
    except Exception as e:
        return {"error": str(e)}


@celery_app.task(name="api.workers.tasks.run_service_monitor")
def run_service_monitor():
    """Check monitored services; auto-restart any that are stopped."""
    try:
        with httpx.Client(timeout=30) as client:
            r = client.post(f"{API_BASE}/service-monitor/internal/check")
            return r.json()
    except Exception as e:
        return {"error": str(e)}


@celery_app.task(name="api.workers.tasks.run_agent_watchdog")
def run_agent_watchdog():
    """Find offline agents whose endpoints are still reachable and restart the agent service."""
    try:
        with httpx.Client(timeout=120) as client:
            r = client.post(f"{API_BASE}/agents/internal/watchdog-check")
            return r.json()
    except Exception as e:
        return {"error": str(e)}


@celery_app.task(name="api.workers.tasks.renew_expiring_le_certs")
def renew_expiring_le_certs():
    """Auto-renew Let's Encrypt certificates that expire within 30 days."""
    try:
        with httpx.Client(timeout=180) as client:
            # Get all LE certs with auto_renew=true
            certs_r = client.get(f"{API_BASE}/ssl")
            if certs_r.status_code != 200:
                return {"error": "Could not fetch certificates"}
            certs = certs_r.json()

            renewed = []
            skipped = []
            for cert in certs:
                if cert.get("provider") != "letsencrypt":
                    continue
                if not cert.get("auto_renew"):
                    continue
                days = cert.get("days_until_expiry")
                if days is None or days > 30:
                    skipped.append(cert["common_name"])
                    continue

                logger.info("Auto-renewing LE cert for %s (%d days left)", cert["common_name"], days)
                r = client.post(f"{API_BASE}/ssl/letsencrypt/{cert['id']}/renew")
                if r.status_code == 200:
                    renewed.append(cert["common_name"])
                    logger.info("LE cert renewed: %s", cert["common_name"])
                else:
                    logger.error("LE renewal failed for %s: %s", cert["common_name"], r.text)

            return {"renewed": renewed, "skipped": skipped}
    except Exception as e:
        logger.error("LE renewal task error: %s", e)
        return {"error": str(e)}


@celery_app.task(name="api.workers.tasks.timeout_stale_patch_jobs")
def timeout_stale_patch_jobs():
    """Mark patch jobs stuck in pending/running for more than 2 hours as timed_out.
    Also marks deployment jobs stuck for more than 1 hour as failed."""
    import psycopg2
    db_url = os.getenv("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    try:
        conn = psycopg2.connect(db_url)
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute("""
            UPDATE patch_jobs
            SET status = 'timed_out',
                output = 'Job timed out — agent did not report a result within 2 hours.',
                finished_at = NOW()
            WHERE status IN ('pending', 'running')
              AND started_at < NOW() - INTERVAL '2 hours'
        """)
        patch_count = cur.rowcount
        cur.execute("""
            UPDATE deployment_jobs
            SET status = 'failed',
                finished_at = NOW(),
                logs = COALESCE(logs, '') || E'\n[ERROR] Job timed out — server was restarted or process died'
            WHERE status IN ('running', 'pending')
              AND created_at < NOW() - INTERVAL '1 hour'
        """)
        deploy_count = cur.rowcount
        cur.close()
        conn.close()
        return {"patch_timed_out": patch_count, "deploy_timed_out": deploy_count}
    except Exception as e:
        return {"error": str(e)}


@celery_app.task(name="api.workers.tasks.run_database_backup")
def run_database_backup(trigger: str = "auto"):
    """Run pg_dump and record the result in backup_history."""
    import psycopg2
    from urllib.parse import urlparse

    # Get settings via API
    try:
        with httpx.Client(timeout=10) as client:
            r = client.get(f"{API_BASE}/settings/system/backup")
            cfg = r.json() if r.status_code == 200 else {}
    except Exception:
        cfg = {}

    if not cfg.get("enabled", True):
        return {"skipped": "backups disabled"}

    # For scheduled trigger, check if it's the right hour/minute
    if trigger == "scheduled":
        now = datetime.datetime.now(datetime.timezone.utc)
        if now.hour != int(cfg.get("scheduled_hour", 2)):
            return {"skipped": "not scheduled time"}
        if now.minute > 5:   # only run within first 5 min of the hour
            return {"skipped": "not scheduled time"}

    backup_path = cfg.get("backup_path", "/app/backups")
    os.makedirs(backup_path, exist_ok=True)

    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d_%H%M%S")
    filename = f"kifaa_backup_{ts}.sql.gz"
    file_path = os.path.join(backup_path, filename)

    # Record start in DB
    sync_url = os.getenv("SYNC_DATABASE_URL", "")
    conn = psycopg2.connect(sync_url)
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO backup_history (filename, status, trigger) VALUES (%s, 'running', %s) RETURNING id",
        (filename, trigger),
    )
    backup_id = cur.fetchone()[0]

    # Build pg_dump command
    db_url = urlparse(sync_url)
    env = os.environ.copy()
    env["PGPASSWORD"] = db_url.password or ""

    cmd = [
        "pg_dump",
        "-h", db_url.hostname,
        "-p", str(db_url.port or 5432),
        "-U", db_url.username,
        "-d", db_url.path.lstrip("/"),
        "--no-password",
        "-Fp",   # plain SQL
    ]

    # Exclude regeneratable large tables — hypertable chunks live in _timescaledb_internal,
    # so we exclude that whole schema's data. Also exclude large synced/log tables.
    if cfg.get("exclude_metrics", True):
        # Exclude all TimescaleDB chunk data (metrics 17GB, monitor_results 346MB, etc.)
        cmd.extend(["--exclude-table-data", "_timescaledb_internal.*"])
        # Exclude large regeneratable tables
        for table in [
            "ad_events",         # 13GB+ AD event logs — re-synced from AD
            "services",          # agent service list — re-pushed by agents each sync
            "unitrends_backups", # synced from Unitrends appliance
            "monitor_results",   # port/service check results — regenerated by monitoring
        ]:
            cmd.extend(["--exclude-table-data", table])

    try:
        with open(file_path, "wb") as f:
            # Pipe through gzip
            pg = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
            gz = subprocess.Popen(["gzip", "-c"], stdin=pg.stdout, stdout=f, stderr=subprocess.PIPE)
            pg.stdout.close()
            gz.communicate()
            pg.wait()

        if pg.returncode != 0:
            stderr = pg.stderr.read().decode()
            raise RuntimeError(f"pg_dump failed: {stderr}")

        size = os.path.getsize(file_path)
        finished = datetime.datetime.now(datetime.timezone.utc)
        cur.execute(
            "UPDATE backup_history SET status='success', size_bytes=%s, finished_at=%s WHERE id=%s",
            (size, finished, backup_id),
        )

        # Prune old backups
        _prune_old_backups(backup_path, cfg, cur)

        cur.close()
        conn.close()
        return {"status": "success", "filename": filename, "size_bytes": size}

    except Exception as e:
        finished = datetime.datetime.now(datetime.timezone.utc)
        cur.execute(
            "UPDATE backup_history SET status='failed', error=%s, finished_at=%s WHERE id=%s",
            (str(e), finished, backup_id),
        )
        cur.close()
        conn.close()
        if os.path.exists(file_path):
            os.remove(file_path)
        return {"status": "failed", "error": str(e)}


def _prune_old_backups(backup_path: str, cfg: dict, cur):
    """Tiered backup retention:
    - Keep all backups from the last 24 hours
    - Keep 1 per day for the last 7 days
    - Keep 1 per week for the last 30 days
    - Enforce max_backup_count (default 14) as a hard cap
    """
    max_count = int(cfg.get("max_backup_count", 14))

    try:
        files = []
        for fname in os.listdir(backup_path):
            if not fname.startswith("kifaa_backup_"):
                continue
            fpath = os.path.join(backup_path, fname)
            mtime = datetime.datetime.fromtimestamp(os.path.getmtime(fpath), tz=datetime.timezone.utc)
            files.append((fpath, fname, mtime))

        files.sort(key=lambda x: x[2], reverse=True)  # newest first

        now = datetime.datetime.now(datetime.timezone.utc)
        keep = set()

        # Tier 1: keep all from last 24 hours
        for _, fname, mtime in files:
            if now - mtime < datetime.timedelta(hours=24):
                keep.add(fname)

        # Tier 2: keep 1 per day for last 7 days
        days_seen: set = set()
        for _, fname, mtime in files:
            if now - mtime < datetime.timedelta(days=7):
                day_key = mtime.strftime("%Y-%m-%d")
                if day_key not in days_seen:
                    days_seen.add(day_key)
                    keep.add(fname)

        # Tier 3: keep 1 per week for last 30 days
        weeks_seen: set = set()
        for _, fname, mtime in files:
            if now - mtime < datetime.timedelta(days=30):
                week_key = mtime.strftime("%Y-W%W")
                if week_key not in weeks_seen:
                    weeks_seen.add(week_key)
                    keep.add(fname)

        # Enforce max_count — trim oldest if over the cap
        kept_sorted = sorted(
            [(fp, fn, mt) for fp, fn, mt in files if fn in keep],
            key=lambda x: x[2], reverse=True
        )
        if len(kept_sorted) > max_count:
            for _, fn, _ in kept_sorted[max_count:]:
                keep.discard(fn)

        # Delete files not in the keep set
        for fpath, fname, _ in files:
            if fname not in keep:
                try:
                    os.remove(fpath)
                except OSError:
                    pass

        # Prune DB records for deleted files
        if keep:
            placeholders = ",".join(["%s"] * len(keep))
            cur.execute(
                f"DELETE FROM backup_history WHERE status != 'running' AND filename NOT IN ({placeholders})",
                list(keep),
            )
        else:
            cur.execute("DELETE FROM backup_history WHERE status != 'running'")

    except Exception:
        pass


@celery_app.task(name="api.workers.tasks.prune_old_backups")
def prune_old_backups():
    """Standalone pruning task — runs on its own schedule as a safety net."""
    import psycopg2
    try:
        with httpx.Client(timeout=10) as client:
            r = client.get(f"{API_BASE}/settings/system/backup")
            cfg = r.json() if r.status_code == 200 else {}
    except Exception:
        cfg = {}

    backup_path = cfg.get("backup_path", "/app/backups")
    sync_url = os.getenv("SYNC_DATABASE_URL", "")
    try:
        conn = psycopg2.connect(sync_url)
        conn.autocommit = True
        cur = conn.cursor()
        _prune_old_backups(backup_path, cfg, cur)
        cur.close()
        conn.close()
    except Exception as e:
        return {"error": str(e)}
    return {"status": "pruned"}


@celery_app.task(name="api.workers.tasks.prune_ad_events")
def prune_ad_events():
    """Delete ad_events rows older than the configured retention period (default 60 days).
    Runs in batches to avoid long locks on this high-volume table.
    """
    import psycopg2
    import datetime as dt

    retention_days = 60  # keep 60 days of AD event history
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=retention_days)

    sync_url = os.getenv("SYNC_DATABASE_URL", "")
    if not sync_url:
        return {"error": "SYNC_DATABASE_URL not set"}

    try:
        conn = psycopg2.connect(sync_url)
        conn.autocommit = True
        cur = conn.cursor()

        total_deleted = 0
        batch_size = 10000
        while True:
            cur.execute(
                """
                DELETE FROM ad_events
                WHERE id IN (
                    SELECT id FROM ad_events
                    WHERE event_time < %s
                    LIMIT %s
                )
                """,
                (cutoff, batch_size),
            )
            deleted = cur.rowcount
            total_deleted += deleted
            if deleted < batch_size:
                break  # no more rows to delete

        cur.close()
        conn.close()
        return {"status": "pruned", "deleted": total_deleted, "cutoff": cutoff.isoformat()}

    except Exception as e:
        return {"error": str(e)}


@celery_app.task(name="api.workers.tasks.run_reboot_schedules")
def run_reboot_schedules():
    try:
        with httpx.Client(timeout=30) as client:
            r = client.post(f"{API_BASE}/reboot-schedules/internal/run-due")
            return r.json()
    except Exception as e:
        return {"error": str(e)}


@celery_app.task(name="api.workers.tasks.run_patch_schedules")
def run_patch_schedules():
    """Find due patch schedules and queue patch commands."""
    import psycopg2
    import json
    from datetime import datetime, timezone
    db_url = os.getenv("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    cur = conn.cursor()
    try:
        now = datetime.now(timezone.utc)
        cur.execute(
            "SELECT id::text FROM patch_schedules WHERE is_active=TRUE AND next_run <= %s",
            (now,),
        )
        due = [r[0] for r in cur.fetchall()]
        fired = 0
        from api.routers.patch_schedules import (
            _execute_schedule_sync, _next_run_from_row, _get_platform_timezone_sync,
        )
        tz = _get_platform_timezone_sync(db_url)
        for sid in due:
            try:
                _execute_schedule_sync(sid, db_url, tz)
                cur.execute(
                    "SELECT frequency, day_of_week, day_of_month, hour_utc, minute_utc, scheduled_at "
                    "FROM patch_schedules WHERE id=%s",
                    (sid,),
                )
                row = cur.fetchone()
                if row:
                    next_r = _next_run_from_row(*row, tz)
                    cur.execute(
                        "UPDATE patch_schedules SET last_run=%s, next_run=%s WHERE id=%s",
                        (now, next_r, sid),
                    )
                fired += 1
            except Exception as e:
                import logging
                logging.getLogger(__name__).error(f"Patch schedule {sid} error: {e}")
        return {"fired": fired}
    finally:
        try:
            cur.close()
            conn.close()
        except Exception:
            pass


@celery_app.task(name="api.workers.tasks.run_hourly_sync")
def run_hourly_sync():
    """Queue collect_inventory for all online agents every hour to keep data fresh."""
    try:
        with httpx.Client(timeout=30) as client:
            r = client.post(f"{API_BASE}/agents/internal/sync-all")
            return r.json()
    except Exception as e:
        return {"error": str(e)}


@celery_app.task(name="api.workers.tasks.run_daily_patch_scan")
def run_daily_patch_scan():
    """Queue patch_scan commands for all online agents — runs once a day."""
    try:
        with httpx.Client(timeout=30) as client:
            r = client.post(f"{API_BASE}/patches/internal/scan-all-agent-pull")
            return r.json()
    except Exception as e:
        return {"error": str(e)}


@celery_app.task(name="api.workers.tasks.check_report_schedules")
def check_report_schedules():
    """Trigger any report schedules that are due."""
    try:
        with httpx.Client(timeout=30) as client:
            r = client.post(f"{API_BASE}/report-schedules/internal/run-due")
            return r.json()
    except Exception as e:
        return {"error": str(e)}


@celery_app.task(name="api.workers.tasks.run_scheduled_report")
def run_scheduled_report(schedule_id: str):
    """Generate a report and email/send it via notification channels."""
    import psycopg2
    import io
    import csv
    import smtplib
    from email.mime.multipart import MIMEMultipart
    from email.mime.base import MIMEBase
    from email.mime.text import MIMEText
    from email import encoders

    sync_url = os.getenv("SYNC_DATABASE_URL", "")
    conn = psycopg2.connect(sync_url)
    conn.autocommit = True
    cur = conn.cursor()

    # Load schedule
    cur.execute("SELECT * FROM scheduled_reports WHERE id = %s", (schedule_id,))
    row = cur.fetchone()
    if not row:
        return {"error": "Schedule not found"}

    cols = [d[0] for d in cur.description]
    schedule = dict(zip(cols, row))

    report_type = schedule["report_type"]  # agents or monitors
    fmt = schedule["format"]              # pdf, csv, xlsx
    email_to = schedule.get("email_to") or []
    status_filter = schedule.get("status_filter", "all")

    # ── Generate report data ──────────────────────────────────────────────────
    try:
        if report_type == "agents":
            q = "SELECT hostname, ip_address, os_name, os_version, os_arch, status, agent_version, last_seen, registered_at FROM agents WHERE is_active = TRUE"
            if status_filter != "all":
                q += f" AND status = '{status_filter}'"
            cur.execute(q)
            headers = ["Hostname", "IP Address", "OS", "OS Version", "Arch", "Status", "Agent Version", "Last Seen", "Registered"]
        else:
            # Previous day availability report: aggregate monitor_results from that day
            report_day = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=1)
            report_day_label = report_day.strftime("%Y-%m-%d")
            yesterday_q = """
                WITH yday AS (
                    SELECT
                        monitor_id,
                        COUNT(*) AS total_checks,
                        SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS up_count,
                        SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) AS down_count,
                        ROUND(AVG(latency_ms)::numeric, 1) AS avg_latency_ms,
                        MIN(latency_ms) AS min_latency_ms,
                        MAX(latency_ms) AS max_latency_ms
                    FROM monitor_results
                    WHERE time >= date_trunc('day', NOW() AT TIME ZONE 'UTC' - INTERVAL '1 day')
                      AND time  < date_trunc('day', NOW() AT TIME ZONE 'UTC')
                    GROUP BY monitor_id
                )
                SELECT
                    m.name,
                    m.monitor_type,
                    m.category,
                    m.host,
                    m.port,
                    COALESCE(y.total_checks, 0) AS total_checks,
                    COALESCE(y.up_count, 0) AS up_count,
                    COALESCE(y.down_count, 0) AS down_count,
                    CASE WHEN COALESCE(y.total_checks, 0) > 0
                         THEN ROUND(y.up_count::numeric / y.total_checks * 100, 1)
                         ELSE NULL END AS uptime_pct,
                    y.avg_latency_ms,
                    y.min_latency_ms,
                    y.max_latency_ms,
                    m.last_status AS current_status
                FROM monitors m
                LEFT JOIN yday y ON y.monitor_id = m.id
                WHERE m.is_active = TRUE
            """
            if status_filter != "all":
                yesterday_q += f" AND m.last_status = '{status_filter}'"
            yesterday_q += " ORDER BY m.name"
            cur.execute(yesterday_q)
            headers = [
                "Name", "Type", "Category", "Host", "Port",
                f"Checks ({report_day_label})", "Up", "Down",
                "Uptime %", "Avg Latency (ms)", "Min Latency (ms)", "Max Latency (ms)",
                "Current Status"
            ]

        rows = cur.fetchall()
    except Exception as e:
        cur.close(); conn.close()
        return {"error": f"Query failed: {e}"}

    # ── Build summary (monitors only) ─────────────────────────────────────────
    monitor_summary = None
    if report_type == "monitors" and rows:
        # uptime_pct is index 8; total_checks index 5; up_count 6; down_count 7
        uptime_values = [float(r[8]) for r in rows if r[8] is not None]
        total_checks_all = sum(r[5] or 0 for r in rows)
        up_count_all = sum(r[6] or 0 for r in rows)
        down_count_all = sum(r[7] or 0 for r in rows)
        avg_uptime_pct = round(sum(uptime_values) / len(uptime_values), 1) if uptime_values else 0.0
        avg_downtime_pct = round(100.0 - avg_uptime_pct, 1)
        monitor_summary = {
            "period": report_day_label,
            "monitors": len(rows),
            "total_checks": total_checks_all,
            "up_count": up_count_all,
            "down_count": down_count_all,
            "avg_uptime_pct": avg_uptime_pct,
            "avg_downtime_pct": avg_downtime_pct,
        }

    # ── Build file content ────────────────────────────────────────────────────
    report_date = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=1)).strftime("%Y%m%d") if report_type == "monitors" else datetime.datetime.now().strftime("%Y%m%d")
    filename = f"kifaa_{report_type}_report_{report_date}.{fmt}"

    if fmt == "csv":
        buf = io.StringIO()
        writer = csv.writer(buf)
        if monitor_summary:
            writer.writerow(["MONITOR AVAILABILITY REPORT"])
            writer.writerow(["Report Period", monitor_summary["period"]])
            writer.writerow(["Monitors", monitor_summary["monitors"]])
            writer.writerow(["Average Uptime", f"{monitor_summary['avg_uptime_pct']}%"])
            writer.writerow(["Average Downtime", f"{monitor_summary['avg_downtime_pct']}%"])
            writer.writerow(["Total Checks", monitor_summary["total_checks"]])
            writer.writerow(["Total Up", monitor_summary["up_count"]])
            writer.writerow(["Total Down", monitor_summary["down_count"]])
            writer.writerow([])
        writer.writerow(headers)
        for r in rows:
            writer.writerow([str(v) if v is not None else "" for v in r])
        content = buf.getvalue().encode("utf-8")
        mimetype = "text/csv"

    elif fmt == "xlsx":
        try:
            import openpyxl
            from openpyxl.styles import Font, PatternFill, Alignment
            wb = openpyxl.Workbook()
            ws = wb.active
            ws.title = report_type.capitalize()

            row_offset = 0
            if monitor_summary:
                dark_fill = PatternFill("solid", fgColor="1E293B")
                blue_fill = PatternFill("solid", fgColor="1D4ED8")
                white_font = Font(bold=True, color="FFFFFF", size=11)
                label_font = Font(bold=True, color="93C5FD", size=10)
                val_font = Font(color="F1F5F9", size=10)

                ws.merge_cells("A1:D1")
                title_cell = ws["A1"]
                title_cell.value = "MONITOR AVAILABILITY REPORT"
                title_cell.font = Font(bold=True, color="FFFFFF", size=13)
                title_cell.fill = blue_fill
                title_cell.alignment = Alignment(horizontal="center")

                summary_rows = [
                    ("Report Period", monitor_summary["period"]),
                    ("Monitors Tracked", monitor_summary["monitors"]),
                    ("Average Uptime", f"{monitor_summary['avg_uptime_pct']}%"),
                    ("Average Downtime", f"{monitor_summary['avg_downtime_pct']}%"),
                    ("Total Checks", monitor_summary["total_checks"]),
                    ("Total Up", monitor_summary["up_count"]),
                    ("Total Down", monitor_summary["down_count"]),
                ]
                for i, (label, val) in enumerate(summary_rows, 2):
                    lc = ws.cell(row=i, column=1, value=label)
                    lc.font = label_font; lc.fill = dark_fill
                    vc = ws.cell(row=i, column=2, value=val)
                    vc.font = val_font; vc.fill = dark_fill
                row_offset = len(summary_rows) + 2  # title row + summary rows + blank
                ws.cell(row=row_offset, column=1)  # blank row

                # Header row
                hdr_fill = PatternFill("solid", fgColor="0F172A")
                for col_i, h in enumerate(headers, 1):
                    c = ws.cell(row=row_offset + 1, column=col_i, value=h)
                    c.font = Font(bold=True, color="FFFFFF", size=9)
                    c.fill = hdr_fill
                    c.alignment = Alignment(horizontal="center")
                row_offset += 1
                for r in rows:
                    row_offset += 1
                    for col_i, v in enumerate(r, 1):
                        ws.cell(row=row_offset, column=col_i, value=str(v) if v is not None else "")
            else:
                ws.append(headers)
                for r in rows:
                    ws.append([str(v) if v is not None else "" for v in r])

            ws.column_dimensions["A"].width = 28
            ws.column_dimensions["B"].width = 14
            buf = io.BytesIO()
            wb.save(buf)
            content = buf.getvalue()
            mimetype = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        except ImportError:
            # Fall back to CSV
            buf = io.StringIO()
            csv.writer(buf).writerows([headers] + [[str(v) for v in r] for r in rows])
            content = buf.getvalue().encode("utf-8")
            filename = filename.replace(".xlsx", ".csv")
            mimetype = "text/csv"
    else:
        # PDF — simple text fallback (jsPDF is browser-only; use reportlab if available)
        try:
            from reportlab.lib.pagesizes import A4, landscape
            from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
            from reportlab.lib import colors
            from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
            from reportlab.lib.units import cm
            buf = io.BytesIO()
            doc = SimpleDocTemplate(buf, pagesize=landscape(A4), topMargin=1*cm, bottomMargin=1*cm)
            styles = getSampleStyleSheet()
            story = []

            if monitor_summary:
                title_style = ParagraphStyle("title", parent=styles["Normal"],
                    fontSize=14, fontName="Helvetica-Bold", textColor=colors.white,
                    backColor=colors.HexColor("#1D4ED8"), alignment=1, spaceAfter=6,
                    borderPadding=(6, 10, 6, 10))
                story.append(Paragraph("MONITOR AVAILABILITY REPORT", title_style))
                story.append(Spacer(1, 6))

                summary_data = [
                    ["Report Period", monitor_summary["period"],
                     "Average Uptime", f"{monitor_summary['avg_uptime_pct']}%"],
                    ["Monitors Tracked", str(monitor_summary["monitors"]),
                     "Average Downtime", f"{monitor_summary['avg_downtime_pct']}%"],
                    ["Total Checks", str(monitor_summary["total_checks"]),
                     "Total Up / Down", f"{monitor_summary['up_count']} / {monitor_summary['down_count']}"],
                ]
                summary_table = Table(summary_data, colWidths=[4*cm, 4*cm, 4*cm, 4*cm])
                summary_table.setStyle(TableStyle([
                    ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#1E293B")),
                    ("TEXTCOLOR",  (0, 0), (0, -1), colors.HexColor("#93C5FD")),
                    ("TEXTCOLOR",  (2, 0), (2, -1), colors.HexColor("#93C5FD")),
                    ("TEXTCOLOR",  (1, 0), (1, -1), colors.white),
                    ("TEXTCOLOR",  (3, 0), (3, -1), colors.white),
                    ("FONTNAME",   (0, 0), (0, -1), "Helvetica-Bold"),
                    ("FONTNAME",   (2, 0), (2, -1), "Helvetica-Bold"),
                    ("FONTSIZE",   (0, 0), (-1, -1), 9),
                    ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#334155")),
                    ("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.HexColor("#1E293B"), colors.HexColor("#0F172A")]),
                    ("TOPPADDING", (0, 0), (-1, -1), 5),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                    ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ]))
                story.append(summary_table)
                story.append(Spacer(1, 10))

            data = [headers] + [[str(v) if v is not None else "" for v in r] for r in rows]
            t = Table(data)
            t.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e293b")),
                ("TEXTCOLOR",  (0, 0), (-1, 0), colors.white),
                ("FONTSIZE",   (0, 0), (-1, -1), 8),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
                ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#cbd5e1")),
            ]))
            story.append(t)
            doc.build(story)
            content = buf.getvalue()
            mimetype = "application/pdf"
        except ImportError:
            # Ultimate fallback: plain text
            lines = []
            if monitor_summary:
                lines += [
                    "MONITOR AVAILABILITY REPORT",
                    f"Report Period:\t{monitor_summary['period']}",
                    f"Monitors:\t{monitor_summary['monitors']}",
                    f"Average Uptime:\t{monitor_summary['avg_uptime_pct']}%",
                    f"Average Downtime:\t{monitor_summary['avg_downtime_pct']}%",
                    f"Total Checks:\t{monitor_summary['total_checks']}",
                    "",
                ]
            lines.append("\t".join(headers))
            for r in rows:
                lines.append("\t".join(str(v) if v is not None else "" for v in r))
            content = "\n".join(lines).encode("utf-8")
            filename = filename.replace(".pdf", ".txt")
            mimetype = "text/plain"

    # ── Send via email ────────────────────────────────────────────────────────
    sent = 0
    email_error = None
    if email_to:
        try:
            # Fetch the first active SMTP notification channel directly
            cur.execute(
                "SELECT config FROM notification_channels WHERE type='smtp' AND is_active=TRUE LIMIT 1"
            )
            smtp_row = cur.fetchone()
            smtp_cfg = smtp_row[0] if smtp_row else {}

            if not smtp_cfg:
                email_error = "No active SMTP notification channel configured"
            else:
                msg = MIMEMultipart()
                from_address = smtp_cfg.get("from_address", "kifaa@localhost")
                msg["Subject"] = f"Kifaa Report: {schedule['name']}"
                msg["From"] = f"Kifaa Notification <{from_address}>"
                msg["To"] = ", ".join(email_to)
                report_date = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=1)).strftime("%Y-%m-%d")
                body_text = (
                    f"Kifaa Notification\n"
                    f"{'='*40}\n"
                    f"Scheduled Report: {schedule['name']}\n"
                    f"Report Type: {report_type.capitalize()}\n"
                    f"Data Date: {report_date} (UTC)\n"
                    f"Format: {fmt.upper()}\n"
                    f"Records: {len(rows)}\n"
                    f"Generated: {datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n"
                    f"{'='*40}\n"
                    f"This is an automated report from your Kifaa platform.\n"
                )
                msg.attach(MIMEText(body_text, "plain"))

                part = MIMEBase("application", "octet-stream")
                part.set_payload(content)
                encoders.encode_base64(part)
                part.add_header("Content-Disposition", f'attachment; filename="{filename}"')
                msg.attach(part)

                smtp_host = smtp_cfg.get("host", "localhost")
                smtp_port = int(smtp_cfg.get("port", 587))
                use_tls = smtp_cfg.get("use_tls", True)
                with smtplib.SMTP(smtp_host, smtp_port, timeout=30) as server:
                    server.ehlo()
                    if use_tls:
                        server.starttls()
                        server.ehlo()
                    if smtp_cfg.get("username"):
                        server.login(smtp_cfg["username"], smtp_cfg.get("password", ""))
                    server.sendmail(from_address, email_to, msg.as_string())
                    sent = len(email_to)
        except Exception as e:
            email_error = str(e)

    cur.close()
    conn.close()
    result = {"status": "done", "records": len(rows), "format": fmt, "sent_to": sent}
    if email_error:
        result["email_error"] = email_error
    return result


# ── Integration sync tasks ─────────────────────────────────────────────────────

def _get_plugin_config(cur, plugin_type):
    """Load plugin config from DB (sync psycopg2 connection)."""
    cur.execute(
        "SELECT config, is_enabled FROM integration_plugins WHERE plugin_type = %s",
        (plugin_type,),
    )
    row = cur.fetchone()
    if not row:
        return None, False
    return row[0] or {}, row[1]


def _log_sync_start(cur, plugin_type):
    cur.execute("""
        INSERT INTO integration_sync_log (plugin_type, status)
        VALUES (%s, 'running') RETURNING id
    """, (plugin_type,))
    return cur.fetchone()[0]


def _log_sync_done(cur, log_id, status, records, error=None):
    cur.execute("""
        UPDATE integration_sync_log
        SET status = %s, records_synced = %s, error_message = %s, completed_at = NOW()
        WHERE id = %s
    """, (status, records, error, log_id))


def _update_plugin_status(cur, plugin_type, status, error=None):
    cur.execute("""
        UPDATE integration_plugins
        SET status = %s, last_error = %s,
            last_sync_at = CASE WHEN %s = 'connected' THEN NOW() ELSE last_sync_at END,
            updated_at = NOW()
        WHERE plugin_type = %s
    """, (status, error, status, plugin_type))


@celery_app.task(name="api.workers.tasks.sync_unitrends")
def sync_unitrends():
    """Sync Unitrends backup data into local cache tables."""
    import psycopg2
    db_url = os.getenv("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    cur = conn.cursor()

    cfg, enabled = _get_plugin_config(cur, "unitrends")
    if not enabled:
        cur.close(); conn.close()
        return {"skipped": "not enabled"}

    log_id = _log_sync_start(cur, "unitrends")
    records = 0

    try:
        from api.services.unitrends_client import UnitrendsClient
        client = UnitrendsClient(
            host=cfg.get("host", ""),
            username=cfg.get("username", "root"),
            password=cfg.get("password", ""),
            verify_ssl=cfg.get("verify_ssl", False),
        )
        client.login()

        # Sync backups (last 30 days)
        # Unitrends returns {"BackupStatus": {"appliance_name": [backup_list]}}
        raw_backups = client.get_backups(days=30)
        backup_list = []
        if isinstance(raw_backups, dict):
            for _appliance, blist in raw_backups.get("BackupStatus", raw_backups).items():
                if isinstance(blist, list):
                    backup_list.extend(blist)
        elif isinstance(raw_backups, list):
            backup_list = raw_backups

        if backup_list:
            cur.execute("DELETE FROM unitrends_backups WHERE start_time < NOW() - INTERVAL '31 days'")
            for b in backup_list:
                backup_id = str(b.get("id", "") or b.get("jobId", ""))
                # Unitrends date format: "06/05/2026 12:00:32 am" → parse to ISO
                def parse_ut_date(s):
                    if not s: return None
                    try:
                        from datetime import datetime
                        return datetime.strptime(s, "%m/%d/%Y %I:%M:%S %p").isoformat()
                    except Exception:
                        return s
                # Map Unitrends status to normalized values
                status_raw = str(b.get("status", "") or "").lower()
                status_map = {
                    "successful": "success", "success": "success",
                    "failed": "failure", "failure": "failure", "error": "failure",
                    "warning": "warning", "warnings": "warning",
                    "active": "active", "running": "active", "in progress": "active",
                }
                status_raw = status_map.get(status_raw, status_raw or ("success" if b.get("complete") else "active"))
                # Size: Unitrends uses MB-based "size" dict or bytes
                size_val = b.get("size")
                size_bytes = 0
                if isinstance(size_val, dict):
                    size_bytes = int((size_val.get("bytes") or size_val.get("mb", 0) * 1024 * 1024))
                elif isinstance(size_val, (int, float)):
                    size_bytes = int(size_val)

                cur.execute("""
                    INSERT INTO unitrends_backups
                        (backup_id, client_name, instance_name, backup_type, status,
                         start_time, end_time, size_bytes, message)
                    VALUES (%s, %s, %s, %s, %s,
                            NULLIF(%s,'')::timestamptz, NULLIF(%s,'')::timestamptz, %s, %s)
                    ON CONFLICT DO NOTHING
                """, (
                    backup_id,
                    b.get("client_name") or b.get("clientName") or b.get("client", ""),
                    b.get("asset_name") or b.get("vm_name") or b.get("instance_name") or b.get("server_instance_name", ""),
                    (b.get("type") or b.get("backup_type", "")).lower(),
                    status_raw.lower() if status_raw else "unknown",
                    parse_ut_date(b.get("start_time") or b.get("startTime")),
                    parse_ut_date(b.get("complete_time") or b.get("endTime") or b.get("end_time")),
                    size_bytes,
                    b.get("output") or b.get("message") or "",
                ))
                records += 1

        # Sync clients
        # Unitrends returns {"data": [...], "timestamp": ...}
        raw_clients = client.get_clients()
        client_list = []
        if isinstance(raw_clients, dict):
            client_list = raw_clients.get("data", raw_clients.get("clients", []))
        elif isinstance(raw_clients, list):
            client_list = raw_clients

        if client_list:
            cur.execute("TRUNCATE TABLE unitrends_clients")
            for c in client_list:
                cur.execute("""
                    INSERT INTO unitrends_clients
                        (client_id, client_name, os, ip_address, status, last_backup, total_backups)
                    VALUES (%s, %s, %s, %s, %s, NULL, %s)
                    ON CONFLICT (client_id) DO UPDATE SET
                        client_name = EXCLUDED.client_name,
                        os = EXCLUDED.os, ip_address = EXCLUDED.ip_address,
                        status = EXCLUDED.status, synced_at = NOW()
                """, (
                    str(c.get("id") or c.get("clientId", "")),
                    c.get("name") or c.get("clientName", ""),
                    c.get("asset_type") or c.get("os") or c.get("osType", ""),
                    c.get("ip") or c.get("ipAddress", ""),
                    "online",  # Unitrends doesn't expose online/offline in this endpoint
                    0,
                ))

        # Sync alerts
        # Unitrends returns {"data": [...], "timestamp": ...}
        raw_alerts = client.get_alerts()
        alert_list = []
        if isinstance(raw_alerts, dict):
            alert_list = raw_alerts.get("data", raw_alerts.get("alerts", []))
        elif isinstance(raw_alerts, list):
            alert_list = raw_alerts

        if alert_list:
            cur.execute("TRUNCATE TABLE unitrends_alerts")
            for a in alert_list:
                # Unitrends timestamps are Unix epoch integers
                ts = a.get("created_timestamp") or a.get("updated_timestamp")
                alert_time_iso = None
                if ts:
                    try:
                        from datetime import datetime, timezone
                        alert_time_iso = datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat()
                    except Exception:
                        pass
                cur.execute("""
                    INSERT INTO unitrends_alerts
                        (alert_id, severity, message, alert_time, acknowledged)
                    VALUES (%s, %s, %s, NULLIF(%s,'')::timestamptz, %s)
                    ON CONFLICT (alert_id) DO UPDATE SET
                        severity = EXCLUDED.severity, message = EXCLUDED.message,
                        alert_time = EXCLUDED.alert_time,
                        acknowledged = EXCLUDED.acknowledged, synced_at = NOW()
                """, (
                    str(a.get("id") or a.get("alertId", "")),
                    (a.get("severity") or "info").lower(),
                    a.get("message") or a.get("description", ""),
                    alert_time_iso or "",
                    bool(a.get("resolved", False)),
                ))

        # Sync storage
        # Unitrends returns {"storage": [...], "totals": {...}}
        # Sizes are in MB (mb_size, mb_free fields); percent_used is direct
        raw_storage = client.get_storage()
        storage_list = []
        if isinstance(raw_storage, dict):
            storage_list = raw_storage.get("storage", [])
        elif isinstance(raw_storage, list):
            storage_list = raw_storage

        if storage_list:
            cur.execute("TRUNCATE TABLE unitrends_storage")
            for s in storage_list:
                # Unitrends sizes in MB — convert to bytes
                mb_total = s.get("mb_size") or s.get("totalMB") or 0
                mb_free = s.get("mb_free") or s.get("freeMB") or 0
                mb_used = mb_total - mb_free
                MB = 1024 * 1024
                total = int(mb_total * MB)
                used = int(mb_used * MB)
                free = int(mb_free * MB)
                pct_raw = s.get("percent_used", "")
                try:
                    pct = float(str(pct_raw).replace("%", "").strip())
                except Exception:
                    pct = round(mb_used / mb_total * 100, 1) if mb_total > 0 else 0
                cur.execute("""
                    INSERT INTO unitrends_storage
                        (device_name, total_bytes, used_bytes, free_bytes, usage_pct)
                    VALUES (%s, %s, %s, %s, %s)
                """, (
                    s.get("name") or s.get("deviceName", "Storage"),
                    total, used, free, pct,
                ))

        _update_plugin_status(cur, "unitrends", "connected")
        _log_sync_done(cur, log_id, "success", records)
        client.close()
        return {"synced": records}

    except Exception as e:
        _update_plugin_status(cur, "unitrends", "error", str(e))
        _log_sync_done(cur, log_id, "failed", 0, str(e))
        cur.close(); conn.close()
        return {"error": str(e)}

    finally:
        try:
            cur.close(); conn.close()
        except Exception:
            pass


@celery_app.task(name="api.workers.tasks.sync_sophos")
def sync_sophos():
    """Sync Sophos Central endpoint and alert data."""
    import psycopg2
    db_url = os.getenv("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    cur = conn.cursor()

    cfg, enabled = _get_plugin_config(cur, "sophos")
    if not enabled:
        cur.close(); conn.close()
        return {"skipped": "not enabled"}

    log_id = _log_sync_start(cur, "sophos")
    records = 0

    try:
        from api.services.sophos_client import SophosClient
        client = SophosClient(
            client_id=cfg.get("client_id", ""),
            client_secret=cfg.get("client_secret", ""),
        )
        client.authenticate()

        # Use cached tenant discovery to avoid hitting /whoami/v1 on every sync (429 rate limit)
        cached_tenant_id = cfg.get("tenant_id", "")
        cached_api_host = cfg.get("api_host", "")
        if cached_tenant_id and cached_api_host:
            client.tenant_id = cached_tenant_id
            client.api_host = cached_api_host
            if cfg.get("global_host"):
                client.global_host = cfg["global_host"]
        else:
            client.discover_tenant()
            # Persist discovered values so future syncs skip /whoami/v1
            import json as _json
            cur.execute("""
                UPDATE integration_plugins
                SET config = config || %s::jsonb, updated_at = NOW()
                WHERE plugin_type = 'sophos'
            """, (_json.dumps({"tenant_id": client.tenant_id, "api_host": client.api_host, "global_host": client.global_host}),))

        endpoints = client.get_endpoints()
        if endpoints:
            cur.execute("TRUNCATE TABLE sophos_endpoints")
            for ep in endpoints:
                health = (ep.get("health", {}) or {})
                health_status = health.get("overall") or "unknown"
                os_info = (ep.get("os") or {})
                net = (ep.get("ipv4Addresses") or [])
                ip = net[0] if net else ""
                tamper = (ep.get("tamperProtectionEnabled") or False)
                group = (ep.get("group") or {}).get("name", "")
                os_info = {k: (v.strip() if isinstance(v, str) else v) for k, v in os_info.items()}
                cur.execute("""
                    INSERT INTO sophos_endpoints
                        (endpoint_id, hostname, health_status, os_name, ip_address,
                         last_seen, tamper_protection, group_name)
                    VALUES (%s, %s, %s, %s, %s, %s::timestamptz, %s, %s)
                    ON CONFLICT (endpoint_id) DO UPDATE SET
                        hostname = EXCLUDED.hostname, health_status = EXCLUDED.health_status,
                        os_name = EXCLUDED.os_name, ip_address = EXCLUDED.ip_address,
                        last_seen = EXCLUDED.last_seen, tamper_protection = EXCLUDED.tamper_protection,
                        group_name = EXCLUDED.group_name, synced_at = NOW()
                """, (
                    ep.get("id", ""),
                    ep.get("hostname", ""),
                    health_status,
                    os_info.get("name", ""),
                    ip,
                    ep.get("lastSeenAt"),
                    tamper,
                    group,
                ))
                records += 1

        alerts = client.get_alerts()
        if alerts:
            cur.execute("TRUNCATE TABLE sophos_alerts")
            for a in alerts:
                cur.execute("""
                    INSERT INTO sophos_alerts
                        (alert_id, severity, category, description, endpoint_hostname, raised_at)
                    VALUES (%s, %s, %s, %s, %s, %s::timestamptz)
                    ON CONFLICT (alert_id) DO UPDATE SET
                        severity = EXCLUDED.severity, description = EXCLUDED.description,
                        raised_at = EXCLUDED.raised_at, synced_at = NOW()
                """, (
                    a.get("id", ""),
                    (a.get("severity") or "medium").lower(),
                    a.get("category", ""),
                    a.get("description", ""),
                    (a.get("managedAgent") or {}).get("name", ""),
                    a.get("raisedAt"),
                ))
                records += 1

        # ── Licenses ──────────────────────────────────────────────────────────
        try:
            licenses = client.get_licenses()
            if licenses:
                cur.execute("TRUNCATE TABLE sophos_licenses")
                for lic in licenses:
                    cur.execute("""
                        INSERT INTO sophos_licenses
                            (license_id, product_name, license_type,
                             starts_at, expires_at, quantity, used_quantity)
                        VALUES (%s, %s, %s, %s::timestamptz, %s::timestamptz, %s, %s)
                        ON CONFLICT (license_id) DO UPDATE SET
                            product_name = EXCLUDED.product_name,
                            license_type = EXCLUDED.license_type,
                            starts_at    = EXCLUDED.starts_at,
                            expires_at   = EXCLUDED.expires_at,
                            quantity     = EXCLUDED.quantity,
                            used_quantity = EXCLUDED.used_quantity,
                            synced_at    = NOW()
                    """, (
                        lic.get("id") or lic.get("licenseId", ""),
                        lic.get("productName", ""),
                        (lic.get("licenseType") or lic.get("type", "")).lower(),
                        lic.get("startsAt") or lic.get("startDate"),
                        lic.get("expiresAt") or lic.get("expiryDate"),
                        lic.get("quantity") or lic.get("allowedQuantity") or 0,
                        lic.get("usedQuantity") or lic.get("usedLicenses") or 0,
                    ))
                    records += 1
        except Exception as lic_err:
            logger.warning(f"Sophos license sync failed (non-fatal): {lic_err}")

        _update_plugin_status(cur, "sophos", "connected")
        _log_sync_done(cur, log_id, "success", records)
        client.close()
        return {"synced": records}

    except Exception as e:
        _update_plugin_status(cur, "sophos", "error", str(e))
        _log_sync_done(cur, log_id, "failed", 0, str(e))
        return {"error": str(e)}

    finally:
        try:
            cur.close(); conn.close()
        except Exception:
            pass


@celery_app.task(name="api.workers.tasks.sync_o365")
def sync_o365():
    """Sync Office 365 user and license data via Microsoft Graph."""
    import psycopg2
    import json as json_lib
    db_url = os.getenv("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    cur = conn.cursor()

    cfg, enabled = _get_plugin_config(cur, "o365")
    if not enabled:
        cur.close(); conn.close()
        return {"skipped": "not enabled"}

    log_id = _log_sync_start(cur, "o365")
    records = 0

    try:
        from api.services.o365_client import O365Client
        client = O365Client(
            tenant_id=cfg.get("tenant_id", ""),
            client_id=cfg.get("client_id", ""),
            client_secret=cfg.get("client_secret", ""),
        )
        client.authenticate()

        users = client.get_users()
        if users:
            cur.execute("TRUNCATE TABLE o365_users")
            for u in users:
                sign_in = (u.get("signInActivity") or {})
                last_sign = sign_in.get("lastSignInDateTime") or sign_in.get("lastInteractiveSignInDateTime")
                cur.execute("""
                    INSERT INTO o365_users
                        (user_id, display_name, email, account_enabled, last_sign_in, assigned_licenses)
                    VALUES (%s, %s, %s, %s, %s::timestamptz, %s::jsonb)
                    ON CONFLICT (user_id) DO UPDATE SET
                        display_name = EXCLUDED.display_name, email = EXCLUDED.email,
                        account_enabled = EXCLUDED.account_enabled,
                        last_sign_in = EXCLUDED.last_sign_in,
                        assigned_licenses = EXCLUDED.assigned_licenses, synced_at = NOW()
                """, (
                    u.get("id", ""),
                    u.get("displayName", ""),
                    u.get("mail") or u.get("userPrincipalName", ""),
                    u.get("accountEnabled", True),
                    last_sign,
                    json_lib.dumps([lic.get("skuId", "") for lic in (u.get("assignedLicenses") or [])]),
                ))
                records += 1

        skus = client.get_subscribed_skus()
        if skus:
            cur.execute("TRUNCATE TABLE o365_licenses")
            for sku in skus:
                consumed = (sku.get("consumedUnits") or 0)
                total = (sku.get("prepaidUnits") or {}).get("enabled", 0)
                # Map common SKU part numbers to friendly names
                sku_name = _friendly_sku_name(sku.get("skuPartNumber", ""))
                cur.execute("""
                    INSERT INTO o365_licenses (sku_id, sku_name, total_units, consumed_units)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (sku_id) DO UPDATE SET
                        sku_name = EXCLUDED.sku_name, total_units = EXCLUDED.total_units,
                        consumed_units = EXCLUDED.consumed_units, synced_at = NOW()
                """, (sku.get("skuId", ""), sku_name, total, consumed))

        _update_plugin_status(cur, "o365", "connected")
        _log_sync_done(cur, log_id, "success", records)
        client.close()
        return {"synced": records}

    except Exception as e:
        _update_plugin_status(cur, "o365", "error", str(e))
        _log_sync_done(cur, log_id, "failed", 0, str(e))
        return {"error": str(e)}

    finally:
        try:
            cur.close(); conn.close()
        except Exception:
            pass


def _friendly_sku_name(part_number: str) -> str:
    """Map SKU part numbers to human-friendly names."""
    mapping = {
        "O365_BUSINESS_ESSENTIALS": "Microsoft 365 Business Basic",
        "O365_BUSINESS_PREMIUM": "Microsoft 365 Business Standard",
        "SPB": "Microsoft 365 Business Premium",
        "ENTERPRISEPACK": "Office 365 E3",
        "ENTERPRISEPREMIUM": "Office 365 E5",
        "SPE_E3": "Microsoft 365 E3",
        "SPE_E5": "Microsoft 365 E5",
        "EXCHANGESTANDARD": "Exchange Online (Plan 1)",
        "EXCHANGEENTERPRISE": "Exchange Online (Plan 2)",
        "TEAMS_ESSENTIALS": "Microsoft Teams Essentials",
        "MCOSTANDARD": "Skype for Business Online",
        "POWER_BI_STANDARD": "Power BI (free)",
        "POWER_BI_PRO": "Power BI Pro",
        "PROJECTPREMIUM": "Project Plan 5",
        "VISIOCLIENT": "Visio Plan 2",
        "AAD_PREMIUM": "Azure AD Premium P1",
        "AAD_PREMIUM_P2": "Azure AD Premium P2",
        "INTUNE_A": "Microsoft Intune",
        "WIN10_PRO_ENT_SUB": "Windows 10/11 Enterprise E3",
        "DEFENDER_ENDPOINT_P1": "Microsoft Defender for Endpoint P1",
        "MDATP_XPLAT": "Microsoft Defender for Endpoint P2",
    }
    return mapping.get(part_number, part_number.replace("_", " ").title())


def _sync_vmware_source(cur, client, source_tag, records_counter):
    """Sync one vCenter/ESXi source into the vmware_* tables. Returns record count."""
    from api.services.vmware_client import VMwareClient
    count = 0

    # ── VMs ──────────────────────────────────────────────────────────────────
    vms = client.get_vms()
    for vm in (vms or []):
        vm_id = vm.get("vm") or vm.get("vm_id", "")
        if not vm_id:
            continue
        # The list response already contains cpu_count and memory_size_MiB
        cpu_count = vm.get("cpu_count", 0)
        memory_mb = vm.get("memory_size_MiB", 0)
        guest_os = vm.get("guest_OS", "")

        # Only fetch detail when we need extra fields not in list
        if not guest_os:
            detail = client.get_vm_detail(vm_id)
            cpu_count = cpu_count or (detail.get("cpu") or {}).get("count", 0)
            memory_mb = memory_mb or (detail.get("memory") or {}).get("size_MiB", 0)
            guest_os = detail.get("guest_OS", "")

        vcenter_created_at = vm.get("create_date")
        cur.execute("""
            INSERT INTO vmware_vms
                (vm_id, name, power_state, cpu_count, memory_mb, guest_os,
                 ip_address, host_name, cluster_name, vcenter_created_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (vm_id) DO UPDATE SET
                name = EXCLUDED.name, power_state = EXCLUDED.power_state,
                cpu_count = EXCLUDED.cpu_count, memory_mb = EXCLUDED.memory_mb,
                guest_os = EXCLUDED.guest_os, ip_address = EXCLUDED.ip_address,
                host_name = EXCLUDED.host_name,
                vcenter_created_at = COALESCE(vmware_vms.vcenter_created_at, EXCLUDED.vcenter_created_at),
                synced_at = NOW()
        """, (
            vm_id, vm.get("name", ""), vm.get("power_state", "UNKNOWN"),
            cpu_count, memory_mb, guest_os,
            vm.get("ip_address", ""), vm.get("host_name", ""), source_tag,
            vcenter_created_at,
        ))
        count += 1

    # ── Hosts ─────────────────────────────────────────────────────────────────
    hosts = client.get_hosts()
    for h in (hosts or []):
        host_id = h.get("host") or h.get("host_id", "")
        if not host_id:
            continue
        cur.execute("""
            INSERT INTO vmware_hosts
                (host_id, name, connection_state, power_state,
                 cpu_cores, cpu_mhz, cpu_usage_mhz,
                 memory_mb, memory_usage_mb, vm_count,
                 version, cluster_name)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (host_id) DO UPDATE SET
                name = EXCLUDED.name,
                connection_state = EXCLUDED.connection_state,
                power_state = EXCLUDED.power_state,
                cpu_cores = EXCLUDED.cpu_cores,
                cpu_mhz = EXCLUDED.cpu_mhz,
                cpu_usage_mhz = EXCLUDED.cpu_usage_mhz,
                memory_mb = EXCLUDED.memory_mb,
                memory_usage_mb = EXCLUDED.memory_usage_mb,
                vm_count = EXCLUDED.vm_count,
                version = EXCLUDED.version,
                cluster_name = EXCLUDED.cluster_name,
                synced_at = NOW()
        """, (
            host_id, h.get("name", ""),
            h.get("connection_state", "UNKNOWN"),
            h.get("power_state", "UNKNOWN"),
            h.get("cpu_cores") or 0,
            h.get("cpu_mhz") or 0,
            h.get("cpu_usage_mhz") or 0,
            h.get("memory_mb") or 0,
            h.get("memory_usage_mb") or 0,
            h.get("vm_count") or 0,
            h.get("version") or "",
            h.get("cluster_name") or source_tag,
        ))
        count += 1

    # ── Datastores ────────────────────────────────────────────────────────────
    datastores = client.get_datastores()
    for ds in (datastores or []):
        ds_id = ds.get("datastore") or ds.get("datastore_id", "")
        if not ds_id:
            continue
        # capacity and free_space are bytes directly on the object
        total_bytes = ds.get("capacity", 0) or 0
        free_bytes = ds.get("free_space", 0) or 0
        total_mb = total_bytes // (1024 * 1024)
        free_mb = free_bytes // (1024 * 1024)
        cur.execute("""
            INSERT INTO vmware_datastores
                (ds_id, name, ds_type, capacity_mb, free_mb, accessible)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (ds_id) DO UPDATE SET
                name = EXCLUDED.name, capacity_mb = EXCLUDED.capacity_mb,
                free_mb = EXCLUDED.free_mb, accessible = EXCLUDED.accessible,
                synced_at = NOW()
        """, (
            ds_id, ds.get("name", ""), ds.get("type", ""),
            total_mb, free_mb, ds.get("accessible", True),
        ))
        count += 1

    # ── Clusters ──────────────────────────────────────────────────────────────
    clusters = client.get_clusters()
    for cl in (clusters or []):
        cl_id = cl.get("cluster") or cl.get("cluster_id", "")
        if not cl_id:
            continue
        cur.execute("""
            INSERT INTO vmware_clusters (cluster_id, name, ha_enabled, drs_enabled)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (cluster_id) DO UPDATE SET
                name = EXCLUDED.name, ha_enabled = EXCLUDED.ha_enabled,
                drs_enabled = EXCLUDED.drs_enabled, synced_at = NOW()
        """, (
            cl_id, cl.get("name", ""),
            cl.get("ha_enabled", False), cl.get("drs_enabled", False),
        ))
        count += 1

    return count


@celery_app.task(name="api.workers.tasks.sync_vmware", soft_time_limit=180, time_limit=240)
def sync_vmware():
    """Sync VMware vCenter VM, host, datastore, and cluster data.
    Also syncs standalone ESXi hosts stored in the plugin config."""
    import psycopg2
    db_url = os.getenv("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    cur = conn.cursor()

    cfg, enabled = _get_plugin_config(cur, "vmware")
    if not enabled:
        cur.close(); conn.close()
        return {"skipped": "not enabled"}

    log_id = _log_sync_start(cur, "vmware")
    total = 0
    errors = []

    try:
        from api.services.vmware_client import VMwareClient

        # Clear tables before full resync
        cur.execute("TRUNCATE TABLE vmware_vms")
        cur.execute("TRUNCATE TABLE vmware_hosts")
        cur.execute("TRUNCATE TABLE vmware_datastores")
        cur.execute("TRUNCATE TABLE vmware_clusters")

        # ── vCenter ──────────────────────────────────────────────────────────
        vc_host = cfg.get("host", "")
        if vc_host:
            try:
                client = VMwareClient(
                    host=vc_host,
                    username=cfg.get("username", ""),
                    password=cfg.get("password", ""),
                    verify_ssl=cfg.get("verify_ssl", False),
                )
                client.login()
                total += _sync_vmware_source(cur, client, "vcenter", total)
                client.close()
            except Exception as e:
                errors.append(f"vCenter {vc_host}: {e}")
                logger.error(f"VMware vCenter sync error: {e}")

        # ── Standalone ESXi hosts ─────────────────────────────────────────────
        for esxi in (cfg.get("standalone_esxi") or []):
            esxi_host = esxi.get("host", "")
            if not esxi_host:
                continue
            try:
                client = VMwareClient(
                    host=esxi_host,
                    username=esxi.get("username", ""),
                    password=esxi.get("password", ""),
                    verify_ssl=esxi.get("verify_ssl", False),
                    is_esxi=True,
                )
                client.login()
                total += _sync_vmware_source(cur, client, f"esxi:{esxi_host}", total)
                client.close()
            except Exception as e:
                errors.append(f"ESXi {esxi_host}: {e}")
                logger.error(f"ESXi standalone sync error {esxi_host}: {e}")
                # Insert a placeholder host row so it appears in the dashboard with an error state
                placeholder_id = f"esxi:{esxi_host}"
                cur.execute("""
                    INSERT INTO vmware_hosts
                        (host_id, name, connection_state, power_state,
                         cpu_cores, cpu_mhz, cpu_usage_mhz,
                         memory_mb, memory_usage_mb, vm_count,
                         version, cluster_name)
                    VALUES (%s, %s, 'error', 'UNKNOWN', 0, 0, 0, 0, 0, 0, '', %s)
                    ON CONFLICT (host_id) DO UPDATE SET
                        connection_state = 'error',
                        cluster_name = EXCLUDED.cluster_name,
                        synced_at = NOW()
                """, (placeholder_id, esxi_host, f"esxi:{esxi_host}"))

        if errors and total == 0:
            _update_plugin_status(cur, "vmware", "error", "; ".join(errors))
            _log_sync_done(cur, log_id, "failed", 0, "; ".join(errors))
            return {"error": "; ".join(errors)}

        _update_plugin_status(cur, "vmware", "connected")
        _log_sync_done(cur, log_id, "success", total)
        return {"synced": total, "warnings": errors or None}

    except Exception as e:
        _update_plugin_status(cur, "vmware", "error", str(e))
        _log_sync_done(cur, log_id, "failed", 0, str(e))
        return {"error": str(e)}

    finally:
        try:
            cur.close(); conn.close()
        except Exception:
            pass


@celery_app.task(name="api.workers.tasks.sync_proxmox", soft_time_limit=120, time_limit=180)
def sync_proxmox():
    """Sync Proxmox VE nodes, VMs, containers, and storage."""
    import psycopg2
    db_url = os.getenv("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    cur = conn.cursor()

    cfg, enabled = _get_plugin_config(cur, "proxmox")
    if not enabled:
        cur.close(); conn.close()
        return {"skipped": "not enabled"}

    log_id = _log_sync_start(cur, "proxmox")
    records = 0

    try:
        from api.services.proxmox_client import ProxmoxClient
        client = ProxmoxClient(
            host=cfg.get("host", ""),
            username=cfg.get("username", "root@pam"),
            password=cfg.get("password", ""),
            token_id=cfg.get("token_id", ""),
            token_secret=cfg.get("token_secret", ""),
            verify_ssl=cfg.get("verify_ssl", False),
        )
        client.login()

        # Use cluster/resources for a single comprehensive call
        resources = client.get_cluster_resources()

        cur.execute("TRUNCATE TABLE proxmox_nodes")
        cur.execute("TRUNCATE TABLE proxmox_vms")
        cur.execute("TRUNCATE TABLE proxmox_storage")

        for r in resources:
            rtype = r.get("type", "")
            if rtype == "node":
                cur.execute("""
                    INSERT INTO proxmox_nodes
                        (node_id, name, status, cpu_usage, maxcpu, mem, maxmem, disk, maxdisk,
                         uptime_seconds, pve_version)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (node_id) DO UPDATE SET
                        status = EXCLUDED.status, cpu_usage = EXCLUDED.cpu_usage,
                        mem = EXCLUDED.mem, maxmem = EXCLUDED.maxmem,
                        disk = EXCLUDED.disk, maxdisk = EXCLUDED.maxdisk,
                        uptime_seconds = EXCLUDED.uptime_seconds, synced_at = NOW()
                """, (
                    r.get("id", r.get("node", "")),
                    r.get("node", ""),
                    r.get("status", ""),
                    r.get("cpu", 0),
                    r.get("maxcpu", 0),
                    r.get("mem", 0),
                    r.get("maxmem", 0),
                    r.get("disk", 0),
                    r.get("maxdisk", 0),
                    r.get("uptime", 0),
                    "",
                ))

            elif rtype in ("qemu", "lxc"):
                vmid = r.get("vmid", 0)
                cur.execute("""
                    INSERT INTO proxmox_vms
                        (vm_id, vmid, name, type, status, node_name,
                         cpu_usage, cpus, mem, maxmem, disk, maxdisk, uptime_seconds)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (vm_id) DO UPDATE SET
                        name = EXCLUDED.name, status = EXCLUDED.status,
                        cpu_usage = EXCLUDED.cpu_usage, mem = EXCLUDED.mem,
                        maxmem = EXCLUDED.maxmem, uptime_seconds = EXCLUDED.uptime_seconds,
                        synced_at = NOW()
                """, (
                    r.get("id", f"{rtype}/{vmid}"),
                    vmid,
                    r.get("name", ""),
                    rtype,
                    r.get("status", ""),
                    r.get("node", ""),
                    r.get("cpu", 0),
                    r.get("maxcpu", 0),
                    r.get("mem", 0),
                    r.get("maxmem", 0),
                    r.get("disk", 0),
                    r.get("maxdisk", 0),
                    r.get("uptime", 0),
                ))
                records += 1

            elif rtype == "storage":
                cur.execute("""
                    INSERT INTO proxmox_storage
                        (stor_id, name, node_name, storage_type,
                         total_bytes, used_bytes, avail_bytes, enabled, shared)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (stor_id) DO UPDATE SET
                        total_bytes = EXCLUDED.total_bytes, used_bytes = EXCLUDED.used_bytes,
                        avail_bytes = EXCLUDED.avail_bytes, synced_at = NOW()
                """, (
                    r.get("id", ""),
                    r.get("storage", ""),
                    r.get("node", ""),
                    r.get("plugintype", ""),
                    r.get("maxdisk", 0),
                    r.get("disk", 0),
                    (r.get("maxdisk", 0) - r.get("disk", 0)),
                    r.get("status", "") == "available",
                    r.get("shared", 0) == 1,
                ))

        _update_plugin_status(cur, "proxmox", "connected")
        _log_sync_done(cur, log_id, "success", records)
        client.close()
        return {"synced": records}

    except Exception as e:
        _update_plugin_status(cur, "proxmox", "error", str(e))
        _log_sync_done(cur, log_id, "failed", 0, str(e))
        return {"error": str(e)}

    finally:
        try:
            cur.close(); conn.close()
        except Exception:
            pass


@celery_app.task(name="api.workers.tasks.sync_nutanix")
def sync_nutanix():
    """Sync Nutanix Prism cluster, VM, host, and alert data."""
    import psycopg2
    db_url = os.getenv("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    cur = conn.cursor()

    cfg, enabled = _get_plugin_config(cur, "nutanix")
    if not enabled:
        cur.close(); conn.close()
        return {"skipped": "not enabled"}

    log_id = _log_sync_start(cur, "nutanix")
    records = 0

    try:
        from api.services.nutanix_client import NutanixClient
        client = NutanixClient(
            host=cfg.get("host", ""),
            username=cfg.get("username", "admin"),
            password=cfg.get("password", ""),
            verify_ssl=cfg.get("verify_ssl", False),
            port=int(cfg.get("port", 9440)),
        )

        # Sync clusters
        clusters = client.get_clusters()
        if clusters:
            cur.execute("TRUNCATE TABLE nutanix_clusters")
            for cl in clusters:
                meta = cl.get("metadata") or {}
                spec = cl.get("spec") or {}
                status = cl.get("status") or {}
                resources = status.get("resources") or spec.get("resources") or {}
                config = resources.get("config") or {}
                cur.execute("""
                    INSERT INTO nutanix_clusters
                        (cluster_id, name, cluster_uuid, num_nodes, version, hypervisor)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (cluster_id) DO UPDATE SET
                        name = EXCLUDED.name, num_nodes = EXCLUDED.num_nodes,
                        version = EXCLUDED.version, synced_at = NOW()
                """, (
                    meta.get("uuid", ""),
                    (spec.get("name") or status.get("name") or ""),
                    meta.get("uuid", ""),
                    config.get("num_nodes", 0),
                    (config.get("software_map") or {}).get("NOS", {}).get("version", ""),
                    "",
                ))

        # Sync VMs
        vms = client.get_vms()
        if vms:
            cur.execute("TRUNCATE TABLE nutanix_vms")
            for vm in vms:
                meta = vm.get("metadata") or {}
                spec = vm.get("spec") or {}
                status = vm.get("status") or {}
                resources = (status.get("resources") or spec.get("resources") or {})
                cluster_ref = (spec.get("cluster_reference") or status.get("cluster_reference") or {})
                cur.execute("""
                    INSERT INTO nutanix_vms
                        (vm_id, name, power_state, num_vcpus, memory_mb,
                         cluster_name, host_name, guest_os)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (vm_id) DO UPDATE SET
                        name = EXCLUDED.name, power_state = EXCLUDED.power_state,
                        num_vcpus = EXCLUDED.num_vcpus, memory_mb = EXCLUDED.memory_mb,
                        synced_at = NOW()
                """, (
                    meta.get("uuid", ""),
                    (spec.get("name") or status.get("name") or ""),
                    resources.get("power_state", "OFF"),
                    resources.get("num_sockets", 0),
                    (resources.get("memory_size_mib") or 0),
                    cluster_ref.get("name", ""),
                    "",
                    resources.get("guest_os_id", ""),
                ))
                records += 1

        # Sync hosts
        hosts = client.get_hosts()
        if hosts:
            cur.execute("TRUNCATE TABLE nutanix_hosts")
            for h in hosts:
                meta = h.get("metadata") or {}
                spec = h.get("spec") or {}
                status = h.get("status") or {}
                resources = (status.get("resources") or spec.get("resources") or {})
                block = (resources.get("block") or {})
                cluster_ref = (spec.get("cluster_reference") or status.get("cluster_reference") or {})
                cpu_cap = resources.get("cpu_capacity_hz") or 0
                mem_cap = (resources.get("memory_capacity_mib") or 0)
                cur.execute("""
                    INSERT INTO nutanix_hosts
                        (host_id, name, ip_address, hypervisor_type,
                         num_cpus, cpu_capacity_hz, memory_capacity_mb,
                         cluster_name, num_vms)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (host_id) DO UPDATE SET
                        name = EXCLUDED.name, ip_address = EXCLUDED.ip_address,
                        cpu_capacity_hz = EXCLUDED.cpu_capacity_hz,
                        memory_capacity_mb = EXCLUDED.memory_capacity_mb, synced_at = NOW()
                """, (
                    meta.get("uuid", ""),
                    (spec.get("name") or status.get("name") or ""),
                    resources.get("hypervisor_server_ip", ""),
                    resources.get("hypervisor", ""),
                    resources.get("num_cpu_sockets", 0),
                    cpu_cap,
                    mem_cap,
                    cluster_ref.get("name", ""),
                    resources.get("num_vms", 0),
                ))

        # Sync alerts
        alerts = client.get_alerts()
        if alerts:
            cur.execute("TRUNCATE TABLE nutanix_alerts")
            for a in alerts:
                # v2 alert format
                alert_id = str(a.get("id", ""))
                severity = (a.get("severity") or a.get("alert_type_description", {}).get("severity") or "INFO").upper()
                cur.execute("""
                    INSERT INTO nutanix_alerts
                        (alert_id, severity, title, message, entity_type, created_at, resolved)
                    VALUES (%s, %s, %s, %s, %s, %s::timestamptz, %s)
                    ON CONFLICT (alert_id) DO UPDATE SET
                        severity = EXCLUDED.severity, message = EXCLUDED.message,
                        resolved = EXCLUDED.resolved, synced_at = NOW()
                """, (
                    alert_id,
                    severity,
                    a.get("alert_title", "") or a.get("message", ""),
                    a.get("message", ""),
                    (a.get("context_types") or [""])[0] if a.get("context_types") else "",
                    a.get("created_time_stamp_in_usecs") and
                    __import__("datetime").datetime.fromtimestamp(
                        a["created_time_stamp_in_usecs"] / 1e6,
                        tz=__import__("datetime").timezone.utc
                    ).isoformat() or None,
                    a.get("resolved", False),
                ))

        _update_plugin_status(cur, "nutanix", "connected")
        _log_sync_done(cur, log_id, "success", records)
        client.close()
        return {"synced": records}

    except Exception as e:
        _update_plugin_status(cur, "nutanix", "error", str(e))
        _log_sync_done(cur, log_id, "failed", 0, str(e))
        return {"error": str(e)}

    finally:
        try:
            cur.close(); conn.close()
        except Exception:
            pass


# ── Weekly Health Report ──────────────────────────────────────────────────────

@celery_app.task(name="api.workers.tasks.send_weekly_health_report")
def send_weekly_health_report():
    """Generate and email the weekly KNC Server Health Status Report (Word doc)."""
    import psycopg2
    from api.workers.weekly_report import collect_report_data, build_docx, send_report_email

    sync_url = os.getenv("SYNC_DATABASE_URL", "")
    conn = psycopg2.connect(sync_url)
    conn.autocommit = True
    cur = conn.cursor()

    try:
        # Load recipients from system_settings
        cur.execute("SELECT value FROM system_settings WHERE key = 'weekly_report_recipients'")
        row = cur.fetchone()
        recipients = []
        if row and row[0]:
            import json
            val = row[0]
            if isinstance(val, str):
                val = json.loads(val)
            if isinstance(val, list):
                recipients = [r.strip() for r in val if r.strip()]
            elif isinstance(val, str):
                recipients = [v.strip() for v in val.split(",") if v.strip()]

        if not recipients:
            return {"error": "No recipients configured. Set weekly_report_recipients in system_settings."}

        # Load SMTP config
        cur.execute("SELECT config FROM notification_channels WHERE type='smtp' AND is_active=TRUE LIMIT 1")
        smtp_row = cur.fetchone()
        if not smtp_row or not smtp_row[0]:
            return {"error": "No active SMTP notification channel configured."}
        smtp_cfg = smtp_row[0]

        # Collect data and build document
        data = collect_report_data(cur)
        docx_bytes = build_docx(data)

        week_label = data["week_end"].strftime("Week ending %d %B %Y")
        filename = f"KNC_Server_Health_Report_{data['week_end'].strftime('%Y-%m-%d')}.docx"
        subject = f"KNC Server Health Status Report – {week_label}"

        send_report_email(docx_bytes, filename, recipients, subject, smtp_cfg)

        # Log to audit (no created_at column — it's auto-populated)
        try:
            cur.execute("""
                INSERT INTO audit_log (action, details)
                VALUES ('weekly_report_sent', %s)
            """, (f"Sent to {len(recipients)} recipient(s): {', '.join(recipients)}",))
        except Exception:
            pass  # audit failure must not block the report

        return {"status": "sent", "recipients": recipients, "filename": filename}

    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc()}
    finally:
        try:
            cur.close(); conn.close()
        except Exception:
            pass


@celery_app.task(name="api.workers.tasks.sync_sap")
def sync_sap():
    """Sync SAP Business One users and employees via Service Layer."""
    import psycopg2
    import json as json_lib
    db_url = os.getenv("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    cur = conn.cursor()

    cfg, enabled = _get_plugin_config(cur, "sap")
    if not enabled:
        cur.close(); conn.close()
        return {"skipped": "not enabled"}

    log_id = _log_sync_start(cur, "sap")
    records = 0

    try:
        from api.services.sap_client import SAPClient, infer_license_type

        client = SAPClient(
            host=cfg.get("host", ""),
            username=cfg.get("username", ""),
            password=cfg.get("password", ""),
            company_db=cfg.get("company_db", ""),
        )
        client.login()

        # Build department name map from Departments endpoint
        dept_map = {}
        try:
            for d in client.get_departments():
                dept_map[d.get("Code")] = d.get("Name", "")
        except Exception as dep_err:
            logger.warning(f"SAP departments fetch failed: {dep_err}")

        # Fetch all employees (paginated via $skip)
        employees = client.get_employees()

        # Sync employees table
        cur.execute("TRUNCATE TABLE sap_employees")
        emp_by_app_user_id = {}  # ApplicationUserID (int) → employee dict
        for emp in employees:
            emp_id = emp.get("EmployeeID")
            if emp_id is None:
                continue
            dept_id = emp.get("Department") or 0   # Department field is integer code in EmployeesInfo
            dept_name = dept_map.get(dept_id, "")
            app_user_id = emp.get("ApplicationUserID")
            if app_user_id:
                emp_by_app_user_id[int(app_user_id)] = emp

            cur.execute("""
                INSERT INTO sap_employees
                    (employee_id, first_name, last_name, email,
                     department_id, department_name, job_title, active,
                     start_date, termination_date, mobile_phone, office_phone,
                     sap_user_code, sap_internal_key)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (employee_id) DO UPDATE SET
                    first_name = EXCLUDED.first_name,
                    last_name = EXCLUDED.last_name,
                    email = EXCLUDED.email,
                    department_id = EXCLUDED.department_id,
                    department_name = EXCLUDED.department_name,
                    job_title = EXCLUDED.job_title,
                    active = EXCLUDED.active,
                    start_date = EXCLUDED.start_date,
                    termination_date = EXCLUDED.termination_date,
                    mobile_phone = EXCLUDED.mobile_phone,
                    office_phone = EXCLUDED.office_phone,
                    synced_at = NOW()
            """, (
                emp_id,
                emp.get("FirstName", ""),
                emp.get("LastName", ""),
                emp.get("eMail", ""),
                dept_id or None,
                dept_name,
                emp.get("JobTitle", ""),
                bool(emp.get("Active", "tYES") == "tYES"),
                emp.get("StartDate") or None,
                emp.get("TerminationDate") or None,
                emp.get("MobilePhone", ""),
                emp.get("OfficePhone", ""),
                None,   # sap_user_code — filled after user lookup
                None,   # sap_internal_key — filled after user lookup
            ))
            records += 1

        # For each employee linked to a SAP user, fetch user details via direct PK
        cur.execute("TRUNCATE TABLE sap_users")
        for app_user_id, emp in emp_by_app_user_id.items():
            user = client.get_user(app_user_id)
            if not user:
                continue
            emp_id = emp.get("EmployeeID")
            dept_id = emp.get("Department") or 0   # integer code
            dept_name = dept_map.get(dept_id, "")
            is_superuser = user.get("Superuser") == "tYES"
            license_type = infer_license_type(dept_id, dept_name, is_superuser)

            # Preserve manual overrides: if existing row has non-inferred license, keep it
            cur.execute(
                "SELECT license_type FROM sap_users WHERE internal_key = %s",
                (app_user_id,),
            )
            existing_lic = cur.fetchone()
            if existing_lic and existing_lic[0] not in ("unknown", None):
                license_type = existing_lic[0]

            user_code = user.get("UserCode", "")
            locked = user.get("Locked") == "tYES"
            last_logout = user.get("LastLogoutDate") or None

            cur.execute("""
                INSERT INTO sap_users
                    (internal_key, user_code, user_name, email,
                     locked, superuser, group_name, last_logout_date,
                     department_id, department_name,
                     employee_id, employee_first_name, employee_last_name,
                     active, job_title, mobile_phone, license_type)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (internal_key) DO UPDATE SET
                    user_code = EXCLUDED.user_code,
                    user_name = EXCLUDED.user_name,
                    email = EXCLUDED.email,
                    locked = EXCLUDED.locked,
                    superuser = EXCLUDED.superuser,
                    group_name = EXCLUDED.group_name,
                    last_logout_date = EXCLUDED.last_logout_date,
                    department_id = EXCLUDED.department_id,
                    department_name = EXCLUDED.department_name,
                    employee_id = EXCLUDED.employee_id,
                    employee_first_name = EXCLUDED.employee_first_name,
                    employee_last_name = EXCLUDED.employee_last_name,
                    active = EXCLUDED.active,
                    job_title = EXCLUDED.job_title,
                    mobile_phone = EXCLUDED.mobile_phone,
                    synced_at = NOW()
            """, (
                app_user_id,
                user_code,
                user.get("UserName") or user.get("UserCode", ""),
                user.get("EMail", ""),
                locked,
                is_superuser,
                user.get("UserDefaultGroupCode", ""),
                last_logout[:10] if last_logout else None,  # keep date only
                dept_id or None,
                dept_name,
                emp_id,
                emp.get("FirstName", ""),
                emp.get("LastName", ""),
                not locked,
                emp.get("JobTitle", ""),
                emp.get("MobilePhone", ""),
                license_type,
            ))

            # Update employee row with SAP user link
            cur.execute("""
                UPDATE sap_employees
                SET sap_user_code = %s, sap_internal_key = %s, synced_at = NOW()
                WHERE employee_id = %s
            """, (user_code, app_user_id, emp_id))
            records += 1

        _update_plugin_status(cur, "sap", "connected")
        _log_sync_done(cur, log_id, "success", records)
        client.close()
        return {"synced": records}

    except Exception as e:
        _update_plugin_status(cur, "sap", "error", str(e))
        _log_sync_done(cur, log_id, "failed", 0, str(e))
        logger.error(f"SAP sync error: {e}")
        return {"error": str(e)}

    finally:
        try:
            cur.close(); conn.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Maintenance cycle execution helpers
# ---------------------------------------------------------------------------

def _maintenance_cycle_date(frequency: str, patch_day: str, patch_week: str,
                             start_from) -> "datetime.date":
    """
    Compute the next occurrence of a maintenance cycle ON OR AFTER start_from.
    Mirrors the logic in maintenance.py _current_cycle_date.
    """
    from datetime import date, timedelta

    _DAY_MAP  = {"Monday": 0, "Tuesday": 1, "Wednesday": 2, "Thursday": 3,
                 "Friday": 4, "Saturday": 5, "Sunday": 6}
    _WEEK_MAP = {"1st": 1, "2nd": 2, "3rd": 3, "4th": 4}

    day_num  = _DAY_MAP.get(str(patch_day), 0) if isinstance(patch_day, str) else int(patch_day or 0) % 7
    week_num = _WEEK_MAP.get(str(patch_week), 1) if isinstance(patch_week, str) else int(patch_week or 1)

    if isinstance(start_from, datetime.datetime):
        start_from = start_from.date()

    def _nth(year, month, weekday, n):
        d = date(year, month, 1)
        ahead = weekday - d.weekday()
        if ahead < 0:
            ahead += 7
        d = d + timedelta(days=ahead)
        for _ in range(n - 1):
            d += timedelta(weeks=1)
            if d.month != month:
                return None
        return d if d.month == month else None

    if frequency == "weekly":
        days_ahead = day_num - start_from.weekday()
        if days_ahead < 0:
            days_ahead += 7
        return start_from + timedelta(days=days_ahead)

    if frequency == "monthly":
        y, m = start_from.year, start_from.month
        for _ in range(13):
            c = _nth(y, m, day_num, week_num)
            if c and c >= start_from:
                return c
            m += 1
            if m > 12:
                m, y = 1, y + 1
        return start_from + timedelta(days=30)

    if frequency == "quarterly":
        q_months = [1, 4, 7, 10]
        y, m = start_from.year, start_from.month
        for _ in range(8):
            c = _nth(y, m, day_num, week_num)
            if c and c >= start_from:
                return c
            nq = next((qm for qm in q_months if qm > m), None)
            if nq is None:
                nq, y = 1, y + 1
            m = nq
        return start_from + timedelta(days=90)

    return start_from + timedelta(days=30)


@celery_app.task(name="api.workers.tasks.run_maintenance_cycles")
def run_maintenance_cycles():
    """
    Check for maintenance cycles due today and execute patching for their
    assigned agents. Runs every minute; uses preferred_time (UTC HH:MM) to
    gate execution and maintenance_history to prevent double-runs.
    """
    import psycopg2
    import json
    from datetime import timezone

    db_url = os.getenv("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    cur = conn.cursor()
    log = logging.getLogger(__name__)

    try:
        now_utc = datetime.datetime.now(timezone.utc)
        today = now_utc.date()
        current_hhmm = now_utc.strftime("%H:%M")

        # Fetch all cycles
        cur.execute("""
            SELECT id::text, name, frequency, patch_day, patch_week,
                   preferred_time, restart_action, cycle_type
            FROM maintenance_cycles
        """)
        cycles = cur.fetchall()

        fired = 0
        for (cycle_id, name, frequency, patch_day, patch_week,
             preferred_time, restart_action, cycle_type) in cycles:

            # Only handle patch and maintenance type cycles (skip 'scan', 'restart', etc.)
            if cycle_type and cycle_type not in ("patch", "maintenance", ""):
                continue

            # Calculate when this cycle is next due
            try:
                cycle_date = _maintenance_cycle_date(
                    frequency or "monthly",
                    patch_day or "Monday",
                    patch_week or "1st",
                    today,
                )
            except Exception as e:
                log.warning(f"Maintenance cycle {cycle_id} date calc error: {e}")
                continue

            if cycle_date != today:
                continue

            # Gate on preferred_time (stored as UTC HH:MM)
            pt = (preferred_time or "02:00")[:5]
            if current_hhmm < pt:
                continue

            # Idempotency: skip if already ran today for this cycle
            cur.execute("""
                SELECT 1 FROM maintenance_history
                WHERE cycle_id = CAST(%s AS uuid)
                  AND action_type = 'patch'
                  AND actioned_at::date = %s
                LIMIT 1
            """, (cycle_id, today))
            if cur.fetchone():
                continue

            # Get all active agents assigned to this cycle (online or offline)
            cur.execute("""
                SELECT a.id::text, a.hostname, a.status
                FROM maintenance_cycle_agents ca
                JOIN agents a ON a.id = ca.agent_id
                WHERE ca.cycle_id = CAST(%s AS uuid)
                  AND a.is_active = TRUE
            """, (cycle_id,))
            agents = cur.fetchall()

            if not agents:
                log.info(f"Maintenance cycle '{name}' ({cycle_id}): no agents assigned, skipping")
                continue

            reboot_after = bool(restart_action and restart_action in ("reboot", "restart", "auto_restart"))

            for (agent_id, hostname, agent_status) in agents:
                if agent_status != "online":
                    # Log as skipped so it shows in history
                    cur.execute("""
                        INSERT INTO maintenance_history
                            (cycle_id, agent_id, action_type, status, notes, created_by)
                        VALUES (CAST(%s AS uuid), %s, 'patch', 'skipped',
                                %s, 'scheduler')
                    """, (
                        cycle_id, agent_id,
                        f"Cycle '{name}': {hostname} was {agent_status} at scheduled time",
                    ))
                    log.info(f"Maintenance cycle '{name}': {hostname} is {agent_status}, logged as skipped")
                    continue
                # Get pending patches
                cur.execute("""
                    SELECT package_name FROM agent_patches WHERE agent_id = %s
                """, (agent_id,))
                packages = [r[0] for r in cur.fetchall()]

                if not packages:
                    cur.execute("""
                        INSERT INTO maintenance_history
                            (cycle_id, agent_id, action_type, status, notes, created_by)
                        VALUES (CAST(%s AS uuid), %s, 'patch', 'completed',
                                'No patches pending at execution time', 'scheduler')
                    """, (cycle_id, agent_id))
                    continue

                # Create patch job
                job_id = str(uuid.uuid4())
                cur.execute("""
                    INSERT INTO patch_jobs
                        (id, agent_id, job_type, packages, status, triggered_by,
                         reboot_after, reboot_mode, reboot_delay_seconds)
                    VALUES (%s, %s, 'apply', %s, 'pending', 'maintenance_cycle',
                            %s, 'silent', 60)
                """, (job_id, agent_id, packages, reboot_after))

                # Queue agent command
                payload = json.dumps({
                    "job_id": job_id,
                    "packages": packages,
                    "reboot_after": reboot_after,
                    "reboot_mode": "silent",
                    "reboot_delay_seconds": 60,
                })
                cur.execute("""
                    INSERT INTO agent_commands (agent_id, command_type, payload)
                    VALUES (%s, 'apply_patches', CAST(%s AS jsonb))
                """, (agent_id, payload))

                # Log to maintenance_history — store patch_job_id for status tracking
                cur.execute("""
                    INSERT INTO maintenance_history
                        (cycle_id, agent_id, action_type, status, notes, created_by, patch_job_id)
                    VALUES (CAST(%s AS uuid), %s, 'patch', 'pending', %s, 'scheduler', CAST(%s AS uuid))
                """, (
                    cycle_id, agent_id,
                    f"Cycle '{name}': {len(packages)} patch(es) queued for {hostname}",
                    job_id,
                ))

                log.info(f"Maintenance cycle '{name}': queued {len(packages)} patches for {hostname}")

            fired += 1

        return {"cycles_fired": fired}

    except Exception as e:
        log.error(f"run_maintenance_cycles error: {e}")
        return {"error": str(e)}

    finally:
        try:
            cur.close()
            conn.close()
        except Exception:
            pass


# ── Patch result notification ─────────────────────────────────────────────────

@celery_app.task(name="api.workers.tasks.notify_patch_result")
def notify_patch_result(job_id, hostname, status, cycle_name, packages, reboot_after, output):
    """
    Email notification when a maintenance_cycle patch job completes.
    Sends a summary to all recipients configured in maintenance_notification_settings.
    """
    import smtplib
    import psycopg2
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText
    import logging as _logging
    log = _logging.getLogger("notify_patch")

    db_url = os.getenv("DATABASE_URL") or _build_db_url()
    try:
        conn = psycopg2.connect(db_url)
        cur  = conn.cursor()

        # Fetch SMTP config
        cur.execute("SELECT config FROM notification_channels WHERE type='smtp' AND is_active=TRUE LIMIT 1")
        smtp_row = cur.fetchone()
        if not smtp_row or not smtp_row[0]:
            log.warning("notify_patch_result: no active SMTP channel — skipping email")
            return

        smtp_cfg = smtp_row[0]

        # Fetch notification recipients (all active maintenance notification entries)
        cur.execute("""
            SELECT email, name FROM maintenance_notification_settings
            WHERE email IS NOT NULL AND email != ''
        """)
        recipients = []
        for row in cur.fetchall():
            raw = row[0] or ""
            for addr in raw.replace("\n", ",").split(","):
                addr = addr.strip()
                if addr:
                    recipients.append(addr)
        recipients = list(dict.fromkeys(recipients))  # deduplicate

        cur.close()
        conn.close()

        if not recipients:
            log.info("notify_patch_result: no recipients configured")
            return

        # Build email
        status_label = {"success": "Succeeded", "failed": "Failed", "error": "Error"}.get(status, status.capitalize())
        status_emoji = "✅" if status == "success" else "❌"
        subject = f"{status_emoji} Patch {status_label}: {hostname} — {cycle_name}"

        pkg_lines = "\n".join(f"  • {p}" for p in (packages or [])) or "  (no packages listed)"
        reboot_note = "A reboot has been scheduled automatically." if reboot_after else "No reboot was scheduled."

        # Trim output — cap at 4000 chars to keep email readable
        output_trimmed = (output or "").strip()
        if len(output_trimmed) > 4000:
            output_trimmed = output_trimmed[:4000] + "\n... [truncated]"

        body = (
            f"Kifaa Patch Notification\n"
            f"{'='*48}\n\n"
            f"Status:        {status_label}\n"
            f"Server:        {hostname}\n"
            f"Cycle:         {cycle_name}\n"
            f"Job ID:        {job_id}\n\n"
            f"Packages:\n{pkg_lines}\n\n"
            f"{reboot_note}\n\n"
            f"{'─'*48}\n"
            f"Output:\n{output_trimmed}\n"
            f"{'─'*48}\n\n"
            f"This is an automated notification from your Kifaa platform.\n"
        )

        msg = MIMEMultipart()
        from_address = smtp_cfg.get("from_address", "kifaa@localhost")
        msg["Subject"] = subject
        msg["From"]    = f"Kifaa Notification <{from_address}>"
        msg["To"]      = ", ".join(recipients)
        msg.attach(MIMEText(body, "plain"))

        smtp_host = smtp_cfg.get("host", "localhost")
        smtp_port = int(smtp_cfg.get("port", 587))
        use_tls   = smtp_cfg.get("use_tls", True)

        with smtplib.SMTP(smtp_host, smtp_port, timeout=30) as server:
            server.ehlo()
            if use_tls:
                server.starttls()
                server.ehlo()
            if smtp_cfg.get("username"):
                server.login(smtp_cfg["username"], smtp_cfg.get("password", ""))
            server.sendmail(from_address, recipients, msg.as_string())

        log.info(f"notify_patch_result: sent to {recipients} for {hostname} ({status})")

    except Exception as exc:
        log.error(f"notify_patch_result error: {exc}", exc_info=True)


def _smtp_send(subject, body, log):
    """Shared helper: send plain-text email to all maintenance notification recipients."""
    import smtplib
    import psycopg2
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    db_url = os.getenv("DATABASE_URL") or _build_db_url()
    try:
        conn = psycopg2.connect(db_url)
        cur  = conn.cursor()
        cur.execute("SELECT config FROM notification_channels WHERE type='smtp' AND is_active=TRUE LIMIT 1")
        smtp_row = cur.fetchone()
        if not smtp_row or not smtp_row[0]:
            log.warning("_smtp_send: no active SMTP channel")
            cur.close(); conn.close()
            return
        smtp_cfg = smtp_row[0]
        cur.execute("SELECT email FROM maintenance_notification_settings WHERE email IS NOT NULL AND email != ''")
        recipients = []
        for row in cur.fetchall():
            for addr in (row[0] or "").replace("\n", ",").split(","):
                addr = addr.strip()
                if addr:
                    recipients.append(addr)
        recipients = list(dict.fromkeys(recipients))
        cur.close(); conn.close()
        if not recipients:
            return
        msg = MIMEMultipart()
        from_address = smtp_cfg.get("from_address", "kifaa@localhost")
        msg["Subject"] = subject
        msg["From"]    = f"Kifaa Notification <{from_address}>"
        msg["To"]      = ", ".join(recipients)
        msg.attach(MIMEText(body, "plain"))
        smtp_host = smtp_cfg.get("host", "localhost")
        smtp_port = int(smtp_cfg.get("port", 587))
        use_tls   = smtp_cfg.get("use_tls", True)
        with smtplib.SMTP(smtp_host, smtp_port, timeout=30) as server:
            server.ehlo()
            if use_tls:
                server.starttls()
                server.ehlo()
            if smtp_cfg.get("username"):
                server.login(smtp_cfg["username"], smtp_cfg.get("password", ""))
            server.sendmail(from_address, recipients, msg.as_string())
        log.info(f"_smtp_send: sent '{subject}' to {recipients}")
    except Exception as exc:
        log.error(f"_smtp_send error: {exc}", exc_info=True)


@celery_app.task(name="api.workers.tasks.notify_restart_scheduled")
def notify_restart_scheduled(hostname, delay_seconds, cycle_name, job_id):
    """Send email when a server is about to restart after patching."""
    import logging as _logging
    log = _logging.getLogger("notify_restart")
    mins = delay_seconds // 60
    time_str = f"{mins} minute{'s' if mins != 1 else ''}" if mins > 0 else f"{delay_seconds} seconds"
    subject = f"⚠️  Restart Scheduled: {hostname} will restart in {time_str}"
    body = (
        f"Kifaa Maintenance Notification\n"
        f"{'='*48}\n\n"
        f"Server:   {hostname}\n"
        f"Cycle:    {cycle_name}\n"
        f"Action:   Automatic restart after patching\n"
        f"In:       {time_str}\n\n"
        f"The server will restart automatically. It will come back online\n"
        f"within a few minutes. You will receive another notification\n"
        f"when the server is back online.\n\n"
        f"Job ID: {job_id}\n"
        f"{'─'*48}\n"
        f"This is an automated notification from your Kifaa platform.\n"
    )
    _smtp_send(subject, body, log)


@celery_app.task(name="api.workers.tasks.notify_restart_done")
def notify_restart_done(hostname, cycle_name, job_id, success):
    """Send email when a server has come back online after a restart."""
    import logging as _logging
    log = _logging.getLogger("notify_restart")
    if success:
        subject = f"✅ Restart Complete: {hostname} is back online"
        status_line = "The server has successfully restarted and is back online."
    else:
        subject = f"❌ Restart Failed: {hostname} did not come back online"
        status_line = "WARNING: The server did not come back online as expected. Please check manually."
    body = (
        f"Kifaa Maintenance Notification\n"
        f"{'='*48}\n\n"
        f"Server:   {hostname}\n"
        f"Cycle:    {cycle_name}\n"
        f"Result:   {'Success' if success else 'Failed'}\n\n"
        f"{status_line}\n\n"
        f"Job ID: {job_id}\n"
        f"{'─'*48}\n"
        f"This is an automated notification from your Kifaa platform.\n"
    )
    _smtp_send(subject, body, log)


# ── APC UPS SNMP Integration ───────────────────────────────────────────────────

APC_OIDS = {
    'model':              '1.3.6.1.4.1.318.1.1.1.1.1.1.0',
    'firmware':           '1.3.6.1.4.1.318.1.1.1.1.2.1.0',
    'serial':             '1.3.6.1.4.1.318.1.1.1.1.2.3.0',
    'battery_capacity':   '1.3.6.1.4.1.318.1.1.1.2.2.1.0',  # % (Gauge32)
    'battery_temp':       '1.3.6.1.4.1.318.1.1.1.2.2.2.0',  # C (Gauge32)
    'battery_runtime':    '1.3.6.1.4.1.318.1.1.1.2.2.3.0',  # timeticks (/100 = seconds)
    'battery_status_int': '1.3.6.1.4.1.318.1.1.1.2.2.4.0',  # 1=unknown,2=normal,3=low,4=fault
    'input_voltage':      '1.3.6.1.4.1.318.1.1.1.3.2.1.0',  # V (Gauge32)
    'input_frequency':    '1.3.6.1.4.1.318.1.1.1.3.2.4.0',  # Hz (Gauge32)
    'output_status':      '1.3.6.1.4.1.318.1.1.1.4.1.1.0',  # 2=onLine,3=onBattery,4=smartBoost,6=softBypass,9=switchedBypass,10=hwBypass,12=smartTrim
    'output_voltage':     '1.3.6.1.4.1.318.1.1.1.4.2.1.0',  # V (Gauge32)
    'output_frequency':   '1.3.6.1.4.1.318.1.1.1.4.2.2.0',  # Hz (Gauge32)
    'output_load_pct':    '1.3.6.1.4.1.318.1.1.1.4.2.3.0',  # % (Gauge32)
    'output_current':     '1.3.6.1.4.1.318.1.1.1.4.2.4.0',  # A (Gauge32)
    'alarm_flags':        '1.3.6.1.4.1.318.1.1.1.11.1.1.0', # STRING bit pattern
}

BATT_STATUS_MAP = {1: 'unknown', 2: 'normal', 3: 'low', 4: 'fault'}

# upsBasicOutputStatus integer → human-readable status
OUTPUT_STATUS_MAP = {
    1:  'unknown',
    2:  'online',
    3:  'on_battery',
    4:  'on_smart_boost',   # AVR boosting low input voltage
    5:  'timed_sleeping',
    6:  'on_bypass',        # software bypass
    7:  'off',
    8:  'rebooting',
    9:  'on_bypass',        # switched bypass
    10: 'on_bypass',        # hardware failure bypass
    11: 'sleeping',
    12: 'on_smart_trim',    # AVR trimming high input voltage
}


def _parse_ups_status(output_status_int, alarm_flags_str=None):
    """
    Determine UPS operational status.
    Primary: upsBasicOutputStatus integer (authoritative).
    Fallback: parse upsAdvStateAbnormalConditions bit string.
    """
    if output_status_int is not None:
        return OUTPUT_STATUS_MAP.get(int(output_status_int), 'unknown')

    # Fallback: alarm bit string
    s = (alarm_flags_str or '').strip()
    if len(s) < 2:
        return 'unknown'
    on_battery  = len(s) > 0 and s[0] == '1'
    low_battery = len(s) > 1 and s[1] == '1'
    if on_battery and low_battery:
        return 'low_battery'
    if on_battery:
        return 'on_battery'
    return 'online'


def _snmp_v2c_get(host, oids, community='public', port=161, timeout=5):
    """
    Send SNMPv2c GET for multiple OIDs. Returns dict {oid: value} or raises.
    Sends one OID per request for maximum compatibility with older NMC hardware.
    """
    import socket

    def _encode_length(n):
        if n < 0x80:
            return bytes([n])
        elif n < 0x100:
            return bytes([0x81, n])
        else:
            return bytes([0x82, (n >> 8) & 0xff, n & 0xff])

    def _tlv(tag, content):
        return bytes([tag]) + _encode_length(len(content)) + content

    def _encode_oid(dotted):
        parts = [int(x) for x in dotted.strip('.').split('.')]
        body = bytes([40 * parts[0] + parts[1]])
        for p in parts[2:]:
            if p == 0:
                body += b'\x00'
            elif p < 128:
                body += bytes([p])
            else:
                enc = []
                v = p
                while v:
                    enc.insert(0, v & 0x7f)
                    v >>= 7
                for i, b in enumerate(enc):
                    body += bytes([b | (0x80 if i < len(enc) - 1 else 0)])
        return body

    def _build_get(oid, req_id=1):
        oid_tlv = _tlv(0x06, _encode_oid(oid))
        varbind = _tlv(0x30, oid_tlv + b'\x05\x00')
        varbindlist = _tlv(0x30, varbind)
        pdu_content = (
            _tlv(0x02, bytes([req_id & 0x7f])) +  # request-id
            _tlv(0x02, b'\x00') +                   # error-status = 0
            _tlv(0x02, b'\x00') +                   # error-index = 0
            varbindlist
        )
        pdu = _tlv(0xa0, pdu_content)               # GetRequest-PDU
        comm = community.encode()
        msg_content = (
            _tlv(0x02, b'\x01') +                   # version = 1 (SNMPv2c)
            _tlv(0x04, comm) +                       # community
            pdu
        )
        return _tlv(0x30, msg_content)

    def _decode_len(data, pos):
        """Returns (length, next_pos) using proper BER multi-byte length."""
        b = data[pos]
        if b < 0x80:
            return b, pos + 1
        n = b & 0x7f
        return int.from_bytes(data[pos + 1:pos + 1 + n], 'big'), pos + 1 + n

    def _parse_response(data):
        """Parse SNMP GetResponse, return dict {oid_str: value}."""
        pos = 0
        if len(data) < 10 or data[pos] != 0x30:
            return {}
        pos += 1
        _, pos = _decode_len(data, pos)
        # Version INTEGER
        if data[pos] != 0x02:
            return {}
        pos += 1
        vlen, pos = _decode_len(data, pos)
        pos += vlen
        # Community OCTET STRING
        if data[pos] != 0x04:
            return {}
        pos += 1
        clen, pos = _decode_len(data, pos)
        pos += clen
        # PDU — 0xa2 = GetResponse-PDU
        if data[pos] not in (0xa2, 0xa0):
            return {}
        pos += 1
        _, pos = _decode_len(data, pos)
        # Skip request-id, error-status, error-index
        for _ in range(3):
            pos += 1                       # tag
            flen, pos = _decode_len(data, pos)
            pos += flen
        # VarBindList SEQUENCE
        if data[pos] != 0x30:
            return {}
        pos += 1
        _, pos = _decode_len(data, pos)
        # Parse each VarBind
        results = {}
        while pos < len(data):
            if data[pos] != 0x30:
                break
            pos += 1
            vb_len, pos = _decode_len(data, pos)
            vb_end = pos + vb_len
            # OID
            if pos >= len(data) or data[pos] != 0x06:
                pos = vb_end
                continue
            pos += 1
            oid_len, pos = _decode_len(data, pos)
            oid_bytes = data[pos:pos + oid_len]
            pos += oid_len
            # Decode OID bytes → dotted string
            parts = [oid_bytes[0] // 40, oid_bytes[0] % 40]
            i = 1
            while i < len(oid_bytes):
                val = 0
                while i < len(oid_bytes) and (oid_bytes[i] & 0x80):
                    val = (val << 7) | (oid_bytes[i] & 0x7f)
                    i += 1
                if i < len(oid_bytes):
                    val = (val << 7) | oid_bytes[i]
                    i += 1
                parts.append(val)
            oid_str = '.'.join(map(str, parts))
            # Value
            if pos >= vb_end:
                results[oid_str] = None
                pos = vb_end
                continue
            val_tag = data[pos]
            pos += 1
            val_len, pos = _decode_len(data, pos)
            val_data = data[pos:pos + val_len]
            pos = vb_end  # always advance to end of varbind

            if val_tag == 0x04:  # OCTET STRING
                results[oid_str] = val_data.decode('latin-1').strip('\x00').strip()
            elif val_tag in (0x02, 0x41, 0x42, 0x43, 0x47):
                # INTEGER, Counter32, Gauge32, TimeTicks, Counter64
                results[oid_str] = int.from_bytes(val_data, 'big')
            else:
                results[oid_str] = None
        return results

    # Send one OID per request — maximises compatibility with NMC1/NMC2/NMC3
    results = {}
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        for i, oid in enumerate(oids):
            pkt = _build_get(oid, req_id=i + 1)
            try:
                sock.sendto(pkt, (host, port))
                data, _ = sock.recvfrom(65535)
                results.update(_parse_response(data))
            except socket.timeout:
                pass  # this OID timed out — skip, collect the rest
            except Exception:
                pass
    finally:
        sock.close()
    return results


@celery_app.task(name="api.workers.tasks.sync_apc_ups")
def sync_apc_ups():
    """Sync APC UPS device data via raw SNMP v2c UDP polling."""
    import psycopg2
    import logging as _logging

    log = _logging.getLogger(__name__)

    db_url = os.getenv("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    cur = conn.cursor()

    cfg, enabled = _get_plugin_config(cur, "apc_ups")
    if not enabled:
        cur.close(); conn.close()
        return {"skipped": "not enabled"}

    log_id = _log_sync_start(cur, "apc_ups")
    records = 0

    try:
        devices = cfg.get("devices", [])
        if not devices:
            _log_sync_done(cur, log_id, "success", 0)
            _update_plugin_status(cur, "apc_ups", "connected")
            return {"synced": 0, "message": "No devices configured"}

        oid_list = list(APC_OIDS.values())
        # Reverse map: dotted OID -> logical key name
        oid_to_key = {v: k for k, v in APC_OIDS.items()}

        for dev in devices:
            host      = dev.get("host", "").strip()
            name      = dev.get("name", host)
            community = dev.get("community", "public")
            version   = dev.get("version", "2c")

            if not host:
                continue

            try:
                raw = _snmp_v2c_get(host, oid_list, community=community, timeout=10)
            except Exception as snmp_err:
                log.warning(f"APC UPS SNMP poll failed for {host}: {snmp_err}")
                # Upsert as offline so we still have a persistent record
                cur.execute("""
                    INSERT INTO apc_ups_devices (name, host, snmp_community, snmp_version, status, updated_at)
                    VALUES (%s, %s, %s, %s, 'offline', NOW())
                    ON CONFLICT (host) DO UPDATE SET
                        status = 'offline',
                        updated_at = NOW()
                """, (name, host, community, version))
                continue

            # Map raw results by logical key
            r = {}
            for oid_str, value in raw.items():
                normalized = oid_str.lstrip('.')
                for known_dotted, key in oid_to_key.items():
                    if normalized == known_dotted.lstrip('.'):
                        r[key] = value
                        break

            # Extract and coerce fields
            model            = r.get('model') or None
            firmware         = r.get('firmware') or None
            serial           = r.get('serial') or None
            battery_capacity = r.get('battery_capacity')
            battery_temp     = r.get('battery_temp')
            # runtime is in TimeTicks (1/100 sec units) — convert to whole seconds
            battery_runtime_ticks = r.get('battery_runtime')
            battery_runtime  = int(battery_runtime_ticks / 100) if battery_runtime_ticks is not None else None
            batt_status_int  = r.get('battery_status_int')
            battery_status   = BATT_STATUS_MAP.get(batt_status_int, 'unknown') if batt_status_int is not None else 'unknown'
            input_voltage    = r.get('input_voltage')
            input_frequency  = r.get('input_frequency')
            output_voltage   = r.get('output_voltage')
            output_frequency = r.get('output_frequency')
            output_load_pct  = r.get('output_load_pct')
            output_current   = r.get('output_current')
            output_status_int = r.get('output_status')
            alarm_flags       = r.get('alarm_flags') or ''

            status = _parse_ups_status(output_status_int, alarm_flags)

            cur.execute("""
                INSERT INTO apc_ups_devices (
                    name, host, model, serial_number, firmware_version,
                    snmp_community, snmp_version, status,
                    battery_capacity_pct, battery_temp_c, battery_runtime_seconds, battery_status,
                    input_voltage_v, input_frequency_hz,
                    output_voltage_v, output_frequency_hz, output_load_pct, output_current_a,
                    alarm_flags, last_polled_at, updated_at
                ) VALUES (
                    %s, %s, %s, %s, %s,
                    %s, %s, %s,
                    %s, %s, %s, %s,
                    %s, %s,
                    %s, %s, %s, %s,
                    %s, NOW(), NOW()
                )
                ON CONFLICT (host) DO UPDATE SET
                    name                    = EXCLUDED.name,
                    model                   = EXCLUDED.model,
                    serial_number           = EXCLUDED.serial_number,
                    firmware_version        = EXCLUDED.firmware_version,
                    snmp_community          = EXCLUDED.snmp_community,
                    snmp_version            = EXCLUDED.snmp_version,
                    status                  = EXCLUDED.status,
                    battery_capacity_pct    = EXCLUDED.battery_capacity_pct,
                    battery_temp_c          = EXCLUDED.battery_temp_c,
                    battery_runtime_seconds = EXCLUDED.battery_runtime_seconds,
                    battery_status          = EXCLUDED.battery_status,
                    input_voltage_v         = EXCLUDED.input_voltage_v,
                    input_frequency_hz      = EXCLUDED.input_frequency_hz,
                    output_voltage_v        = EXCLUDED.output_voltage_v,
                    output_frequency_hz     = EXCLUDED.output_frequency_hz,
                    output_load_pct         = EXCLUDED.output_load_pct,
                    output_current_a        = EXCLUDED.output_current_a,
                    alarm_flags             = EXCLUDED.alarm_flags,
                    last_polled_at          = EXCLUDED.last_polled_at,
                    updated_at              = EXCLUDED.updated_at
            """, (
                name, host, model, serial, firmware,
                community, version, status,
                battery_capacity, battery_temp, battery_runtime, battery_status,
                input_voltage, input_frequency,
                output_voltage, output_frequency, output_load_pct, output_current,
                alarm_flags,
            ))

            # Fetch device UUID for metrics insert
            cur.execute("SELECT id FROM apc_ups_devices WHERE host = %s", (host,))
            dev_row = cur.fetchone()
            if dev_row:
                device_id = dev_row[0]
                cur.execute("""
                    INSERT INTO apc_ups_metrics (
                        time, device_id,
                        battery_capacity_pct, battery_runtime_seconds,
                        input_voltage_v, output_voltage_v,
                        output_load_pct, output_current_a, status
                    ) VALUES (NOW(), %s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    device_id,
                    battery_capacity, battery_runtime,
                    input_voltage, output_voltage,
                    output_load_pct, output_current, status,
                ))

            records += 1
            log.info(
                f"APC UPS synced: {name} ({host}) — status={status}, "
                f"load={output_load_pct}%, battery={battery_capacity}%, "
                f"runtime={battery_runtime}s"
            )

        _log_sync_done(cur, log_id, "success", records)
        _update_plugin_status(cur, "apc_ups", "connected")
        return {"synced": records}

    except Exception as exc:
        log.error(f"sync_apc_ups error: {exc}", exc_info=True)
        _log_sync_done(cur, log_id, "error", records, str(exc))
        _update_plugin_status(cur, "apc_ups", "error", str(exc))
        return {"error": str(exc)}

    finally:
        try:
            cur.close()
            conn.close()
        except Exception:
            pass


# ── UPS Shutdown Orchestration ─────────────────────────────────────────────────

def _ups_bot_notify(cur, message: str):
    """Send a bot notification for UPS events."""
    import logging as _logging
    log = _logging.getLogger(__name__)
    try:
        # Use existing send_weekly_health_report infrastructure — find bot config
        cur.execute("""
            SELECT config FROM integration_plugins
            WHERE plugin_type = 'bot' AND is_enabled = TRUE LIMIT 1
        """)
        row = cur.fetchone()
        if not row:
            return
        cfg = row[0] or {}
        # Send via Telegram if configured
        telegram_chat_id = cfg.get("telegram_chat_id") or cfg.get("chat_id")
        if not telegram_chat_id:
            return

        import requests as _requests, os as _os
        token_file = "/run/secrets/telegram_token"
        token = None
        try:
            with open(token_file) as f:
                token = f.read().strip()
        except Exception:
            token = _os.getenv("TELEGRAM_TOKEN", "")

        if token and telegram_chat_id:
            _requests.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": telegram_chat_id, "text": message, "parse_mode": "HTML"},
                timeout=10,
            )
    except Exception as e:
        log.warning(f"_ups_bot_notify failed: {e}")


@celery_app.task(name="api.workers.tasks.check_ups_shutdown")
def check_ups_shutdown():
    """Check UPS shutdown policies. Triggered on a schedule after SNMP polls.
    Creates shutdown events when runtime/battery thresholds are breached."""
    import psycopg2
    import datetime as _dt
    import logging as _logging
    log = _logging.getLogger(__name__)

    sync_url = os.getenv("SYNC_DATABASE_URL", "")
    try:
        conn = psycopg2.connect(sync_url)
        conn.autocommit = True
        cur = conn.cursor()
    except Exception as e:
        log.error(f"check_ups_shutdown: DB connect failed: {e}")
        return {"error": str(e)}

    try:
        # Ensure tables exist
        cur.execute("""
            SELECT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_name = 'ups_shutdown_policies'
            )
        """)
        if not cur.fetchone()[0]:
            return {"skipped": "tables not ready"}

        # Get all active policies with current UPS status
        cur.execute("""
            SELECT p.id::text, p.name, p.device_id::text,
                   p.trigger_runtime_seconds, p.trigger_battery_pct, p.trigger_mode,
                   p.cancel_window_seconds, p.delay_between_agents_seconds, p.notify_bot,
                   d.name AS device_name, d.status AS device_status,
                   d.battery_capacity_pct, d.battery_runtime_seconds
            FROM ups_shutdown_policies p
            JOIN apc_ups_devices d ON d.id = p.device_id
            WHERE p.is_active = TRUE
        """)
        policies = cur.fetchall()

        for row in policies:
            (policy_id, policy_name, device_id,
             trigger_runtime, trigger_battery, trigger_mode,
             cancel_window, delay_between, notify_bot,
             device_name, device_status,
             battery_pct, battery_runtime_secs) = row

            # Auto-cancel pending events when power is restored
            if device_status not in ("on_battery", "low_battery"):
                cur.execute("""
                    UPDATE ups_shutdown_events
                    SET status='cancelled', cancelled_at=NOW(), cancelled_by='system (power restored)'
                    WHERE policy_id = CAST(%s AS uuid) AND status = 'pending'
                """, (policy_id,))
                continue

            # Evaluate thresholds
            runtime_breached = (battery_runtime_secs is not None and battery_runtime_secs < trigger_runtime)
            battery_breached = (battery_pct is not None and battery_pct < trigger_battery)

            if trigger_mode == "all":
                triggered = runtime_breached and battery_breached
            else:
                triggered = runtime_breached or battery_breached

            if not triggered:
                continue

            # Skip if event already active for this policy
            cur.execute("""
                SELECT id FROM ups_shutdown_events
                WHERE policy_id = CAST(%s AS uuid) AND status IN ('pending', 'executing')
                LIMIT 1
            """, (policy_id,))
            if cur.fetchone():
                continue

            # Build trigger reason
            def fmt_runtime(secs):
                if secs is None:
                    return "unknown"
                return f"{secs // 60}m {secs % 60}s"

            reason_parts = []
            if runtime_breached:
                reason_parts.append(f"runtime={fmt_runtime(battery_runtime_secs)} (threshold: {fmt_runtime(trigger_runtime)})")
            if battery_breached:
                reason_parts.append(f"battery={battery_pct}% (threshold: {trigger_battery}%)")
            trigger_reason = "; ".join(reason_parts)

            now = _dt.datetime.now(_dt.timezone.utc)
            cancel_deadline = now + _dt.timedelta(seconds=cancel_window)

            cur.execute("""
                INSERT INTO ups_shutdown_events
                    (policy_id, device_id, device_name, policy_name,
                     trigger_reason, cancel_deadline, status)
                VALUES (CAST(%s AS uuid), CAST(%s AS uuid), %s, %s, %s, %s, 'pending')
                RETURNING id::text
            """, (policy_id, device_id, device_name, policy_name, trigger_reason, cancel_deadline))
            event_id = cur.fetchone()[0]

            cur.execute("SELECT COUNT(*) FROM ups_shutdown_policy_agents WHERE policy_id = CAST(%s AS uuid)", (policy_id,))
            agent_count = cur.fetchone()[0]
            cur.execute("UPDATE ups_shutdown_events SET agents_total=%s WHERE id=CAST(%s AS uuid)", (agent_count, event_id))

            log.warning(
                f"UPS SHUTDOWN TRIGGERED: policy='{policy_name}', UPS='{device_name}', "
                f"reason='{trigger_reason}', cancel_window={cancel_window}s, event_id={event_id}"
            )

            if notify_bot:
                try:
                    cancel_mins = cancel_window // 60
                    cancel_secs = cancel_window % 60
                    _ups_bot_notify(cur,
                        f"\u26a1 UPS POWER ALERT \u2014 {device_name}\n"
                        f"Trigger: {trigger_reason}\n"
                        f"Policy: {policy_name} ({agent_count} server(s) will shutdown)\n"
                        f"\u23f3 Shutdown begins in {cancel_mins}m {cancel_secs}s \u2014 cancel via Kifaa UI"
                    )
                except Exception as notify_err:
                    log.warning(f"Bot notification failed: {notify_err}")

            # Schedule execution after cancel window
            execute_ups_shutdown.apply_async(args=[event_id], countdown=cancel_window)

        return {"ok": True, "policies_checked": len(policies)}

    except Exception as e:
        log.error(f"check_ups_shutdown error: {e}", exc_info=True)
        return {"error": str(e)}
    finally:
        try:
            cur.close()
            conn.close()
        except Exception:
            pass


@celery_app.task(name="api.workers.tasks.execute_ups_shutdown")
def execute_ups_shutdown(event_id: str):
    """Execute ordered server shutdown after cancel window expires.
    Checks if event was cancelled before proceeding."""
    import psycopg2
    import json as _json
    import time as _time
    import logging as _logging
    log = _logging.getLogger(__name__)

    sync_url = os.getenv("SYNC_DATABASE_URL", "")
    try:
        conn = psycopg2.connect(sync_url)
        conn.autocommit = True
        cur = conn.cursor()
    except Exception as e:
        log.error(f"execute_ups_shutdown: DB connect failed: {e}")
        return {"error": str(e)}

    try:
        cur.execute(
            "SELECT status, policy_id::text, policy_name, device_name FROM ups_shutdown_events WHERE id=CAST(%s AS uuid)",
            (event_id,)
        )
        row = cur.fetchone()
        if not row:
            log.error(f"execute_ups_shutdown: event {event_id} not found")
            return {"error": "event not found"}

        status, policy_id, policy_name, device_name = row

        if status == "cancelled":
            log.info(f"execute_ups_shutdown: event {event_id} was cancelled — aborting")
            return {"skipped": "cancelled"}

        if status != "pending":
            log.warning(f"execute_ups_shutdown: event {event_id} unexpected status '{status}'")
            return {"skipped": status}

        # Get delay from policy
        delay_between = 30
        if policy_id:
            cur.execute("SELECT delay_between_agents_seconds FROM ups_shutdown_policies WHERE id=CAST(%s AS uuid)", (policy_id,))
            pr = cur.fetchone()
            if pr:
                delay_between = pr[0] or 30

        # Mark executing
        cur.execute("UPDATE ups_shutdown_events SET status='executing' WHERE id=CAST(%s AS uuid)", (event_id,))

        # Get ordered agents
        cur.execute("""
            SELECT pa.agent_id::text, pa.shutdown_order, a.hostname, a.os_type, a.status
            FROM ups_shutdown_policy_agents pa
            JOIN agents a ON a.id = pa.agent_id
            WHERE pa.policy_id = CAST(%s AS uuid)
            ORDER BY pa.shutdown_order
        """, (policy_id,))
        agents = cur.fetchall()

        if not agents:
            cur.execute("UPDATE ups_shutdown_events SET status='completed', completed_at=NOW() WHERE id=CAST(%s AS uuid)", (event_id,))
            return {"ok": True, "shutdown_count": 0, "total": 0}

        # Pre-insert event_agent records
        for agent_id, order, hostname, os_type, agent_status in agents:
            cur.execute("""
                INSERT INTO ups_shutdown_event_agents
                    (event_id, agent_id, hostname, os_type, shutdown_order, status)
                VALUES (CAST(%s AS uuid), CAST(%s AS uuid), %s, %s, %s, 'pending')
            """, (event_id, agent_id, hostname, os_type or "unknown", order))

        log.warning(f"execute_ups_shutdown: shutting down {len(agents)} server(s) for event {event_id}")

        shutdown_count = 0
        for i, (agent_id, order, hostname, os_type, agent_status) in enumerate(agents):
            # Check if cancelled mid-execution
            cur.execute("SELECT status FROM ups_shutdown_events WHERE id=CAST(%s AS uuid)", (event_id,))
            ev = cur.fetchone()
            if ev and ev[0] == "cancelled":
                log.info(f"execute_ups_shutdown: cancelled mid-execution at {hostname}")
                cur.execute("""
                    UPDATE ups_shutdown_event_agents SET status='cancelled'
                    WHERE event_id=CAST(%s AS uuid) AND status='pending'
                """, (event_id,))
                break

            try:
                payload = _json.dumps({"mode": "poweroff", "delay_seconds": 0})
                cur.execute("""
                    INSERT INTO agent_commands (agent_id, command_type, payload)
                    VALUES (CAST(%s AS uuid), 'restart_machine', CAST(%s AS jsonb))
                """, (agent_id, payload))
                cur.execute("""
                    UPDATE ups_shutdown_event_agents
                    SET status='sent', sent_at=NOW()
                    WHERE event_id=CAST(%s AS uuid) AND agent_id=CAST(%s AS uuid)
                """, (event_id, agent_id))
                shutdown_count += 1
                log.warning(f"execute_ups_shutdown: poweroff command sent to {hostname} ({os_type or 'unknown'})")
            except Exception as agent_err:
                log.error(f"execute_ups_shutdown: failed for {hostname}: {agent_err}")
                cur.execute("""
                    UPDATE ups_shutdown_event_agents
                    SET status='failed', error=%s
                    WHERE event_id=CAST(%s AS uuid) AND agent_id=CAST(%s AS uuid)
                """, (str(agent_err), event_id, agent_id))

            # Delay between agents (skip after last)
            if i < len(agents) - 1 and delay_between > 0:
                _time.sleep(delay_between)

        cur.execute("""
            UPDATE ups_shutdown_events
            SET status='completed', completed_at=NOW(), agents_shutdown=%s
            WHERE id=CAST(%s AS uuid) AND status='executing'
        """, (shutdown_count, event_id))

        log.warning(f"execute_ups_shutdown: done — {shutdown_count}/{len(agents)} servers")

        try:
            _ups_bot_notify(cur,
                f"\u2705 UPS Shutdown Complete \u2014 {device_name}\n"
                f"Policy: {policy_name}\n"
                f"Servers shutdown: {shutdown_count}/{len(agents)}"
            )
        except Exception:
            pass

        return {"ok": True, "shutdown_count": shutdown_count, "total": len(agents)}

    except Exception as e:
        log.error(f"execute_ups_shutdown error: {e}", exc_info=True)
        try:
            cur.execute("UPDATE ups_shutdown_events SET status='failed' WHERE id=CAST(%s AS uuid) AND status IN ('pending','executing')", (event_id,))
        except Exception:
            pass
        return {"error": str(e)}
    finally:
        try:
            cur.close()
            conn.close()
        except Exception:
            pass
