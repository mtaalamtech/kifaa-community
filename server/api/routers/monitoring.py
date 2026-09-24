import asyncio
import ssl
import socket
import subprocess
import time as time_mod
from datetime import datetime, timezone, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, text

from api.database import get_db
from api.models.models import Monitor, MonitoredPort, Alert
from api.services.auth import get_current_user

router = APIRouter(prefix="/monitoring", tags=["Monitoring"])


# ── Monitor catalog ────────────────────────────────────────────────────────────
# Defines all supported monitor subtypes, their check engine, default port, icon

MONITOR_CATALOG = {
    "Network": [
        {"subtype": "ping",    "label": "Ping Monitor",         "check": "ping",  "port": None, "icon": "radio"},
        {"subtype": "tcp",     "label": "TCP Port",             "check": "tcp",   "port": None, "icon": "plug"},
        {"subtype": "snmp",    "label": "SNMP / Network Device","check": "snmp",  "port": 161,  "icon": "network"},
    ],
    "Web / HTTP": [
        {"subtype": "http",              "label": "HTTP/HTTPS URL",         "check": "http",     "port": 80,  "icon": "globe"},
        {"subtype": "https",             "label": "HTTPS URL",              "check": "http",     "port": 443, "icon": "globe"},
        {"subtype": "ssl_cert",          "label": "SSL Certificate",        "check": "ssl_cert", "port": 443, "icon": "shield"},
        {"subtype": "rest_api",          "label": "REST API Monitor",       "check": "http",     "port": 80,  "icon": "code"},
        {"subtype": "website_content",   "label": "Website Content",        "check": "http",     "port": 80,  "icon": "file-text"},
        {"subtype": "apache",            "label": "Apache Server",          "check": "http",     "port": 80,  "icon": "server"},
        {"subtype": "nginx",             "label": "Nginx",                  "check": "http",     "port": 80,  "icon": "server"},
        {"subtype": "iis",               "label": "IIS Server",             "check": "http",     "port": 80,  "icon": "server"},
        {"subtype": "tomcat",            "label": "Tomcat Server",          "check": "http",     "port": 8080,"icon": "server"},
        {"subtype": "jboss",             "label": "JBoss Server",           "check": "http",     "port": 8080,"icon": "server"},
        {"subtype": "weblogic",          "label": "WebLogic Server",        "check": "http",     "port": 7001,"icon": "server"},
        {"subtype": "websphere",         "label": "WebSphere Server",       "check": "http",     "port": 9080,"icon": "server"},
        {"subtype": "glassfish",         "label": "GlassFish",              "check": "http",     "port": 4848,"icon": "server"},
        {"subtype": "jetty",             "label": "Jetty Server",           "check": "http",     "port": 8080,"icon": "server"},
        {"subtype": "elasticsearch",     "label": "Elasticsearch",          "check": "http",     "port": 9200,"icon": "search"},
        {"subtype": "solr",              "label": "Apache Solr",            "check": "http",     "port": 8983,"icon": "search"},
        {"subtype": "haproxy",           "label": "HAProxy",                "check": "http",     "port": 8404,"icon": "shuffle"},
        {"subtype": "php_fpm",           "label": "PHP-FPM",                "check": "tcp",      "port": 9000,"icon": "code"},
    ],
    "Databases": [
        {"subtype": "mysql",      "label": "MySQL",          "check": "tcp", "port": 3306,  "icon": "database"},
        {"subtype": "postgresql", "label": "PostgreSQL",     "check": "tcp", "port": 5432,  "icon": "database"},
        {"subtype": "redis",      "label": "Redis",          "check": "tcp", "port": 6379,  "icon": "database"},
        {"subtype": "mongodb",    "label": "MongoDB",        "check": "tcp", "port": 27017, "icon": "database"},
        {"subtype": "mssql",      "label": "MS SQL Server",  "check": "tcp", "port": 1433,  "icon": "database"},
        {"subtype": "oracle",     "label": "Oracle DB",      "check": "tcp", "port": 1521,  "icon": "database"},
        {"subtype": "db2",        "label": "IBM DB2",        "check": "tcp", "port": 50000, "icon": "database"},
        {"subtype": "cassandra",  "label": "Cassandra",      "check": "tcp", "port": 9042,  "icon": "database"},
        {"subtype": "couchbase",  "label": "Couchbase",      "check": "http","port": 8091,  "icon": "database"},
        {"subtype": "memcached",  "label": "Memcached",      "check": "tcp", "port": 11211, "icon": "database"},
        {"subtype": "hbase",      "label": "HBase",          "check": "http","port": 16010, "icon": "database"},
        {"subtype": "sap_hana",   "label": "SAP HANA",       "check": "tcp", "port": 30015, "icon": "database"},
        {"subtype": "sybase",     "label": "Sybase",         "check": "tcp", "port": 5000,  "icon": "database"},
        {"subtype": "informix",   "label": "Informix",       "check": "tcp", "port": 9088,  "icon": "database"},
    ],
    "Database Plugins": [
        {"subtype": "pg_plugin",            "label": "PostgreSQL Plugin",    "check": "db_plugin", "port": 5432,  "icon": "database"},
        {"subtype": "mysql_plugin",         "label": "MySQL / MariaDB Plugin","check": "db_plugin", "port": 3306,  "icon": "database"},
        {"subtype": "mssql_plugin",         "label": "MS SQL Server Plugin", "check": "db_plugin", "port": 1433,  "icon": "database"},
        {"subtype": "mongodb_plugin",       "label": "MongoDB Plugin",       "check": "db_plugin", "port": 27017, "icon": "database"},
        {"subtype": "redis_plugin",         "label": "Redis Plugin",         "check": "db_plugin", "port": 6379,  "icon": "database"},
        {"subtype": "elasticsearch_plugin", "label": "Elasticsearch Plugin", "check": "db_plugin", "port": 9200,  "icon": "search"},
        {"subtype": "opensearch_plugin",    "label": "OpenSearch Plugin",    "check": "db_plugin", "port": 9200,  "icon": "search"},
        {"subtype": "couchdb_plugin",       "label": "CouchDB Plugin",       "check": "db_plugin", "port": 5984,  "icon": "database"},
        {"subtype": "influxdb_plugin",      "label": "InfluxDB Plugin",      "check": "db_plugin", "port": 8086,  "icon": "database"},
        {"subtype": "couchbase_plugin",     "label": "Couchbase Plugin",     "check": "db_plugin", "port": 8091,  "icon": "database"},
        {"subtype": "cassandra_plugin",     "label": "Cassandra Plugin",     "check": "db_plugin", "port": 9042,  "icon": "database"},
        {"subtype": "memcached_plugin",     "label": "Memcached Plugin",     "check": "db_plugin", "port": 11211, "icon": "database"},
        {"subtype": "oracle_plugin",        "label": "Oracle DB Plugin",     "check": "db_plugin", "port": 1521,  "icon": "database"},
        {"subtype": "sap_hana_plugin",      "label": "SAP HANA Plugin",      "check": "db_plugin", "port": 30015, "icon": "database"},
        {"subtype": "mariadb_plugin",       "label": "MariaDB Plugin",       "check": "db_plugin", "port": 3306,  "icon": "database"},
    ],
    "Services": [
        {"subtype": "dns",              "label": "DNS Monitor",       "check": "dns", "port": 53,  "icon": "search"},
        {"subtype": "ftp",              "label": "FTP Monitor",       "check": "tcp", "port": 21,  "icon": "folder"},
        {"subtype": "sftp",             "label": "SFTP Monitor",      "check": "tcp", "port": 22,  "icon": "folder"},
        {"subtype": "ldap",             "label": "LDAP Server",       "check": "tcp", "port": 389, "icon": "users"},
        {"subtype": "active_directory", "label": "Active Directory",  "check": "tcp", "port": 389, "icon": "users"},
        {"subtype": "telnet",           "label": "Telnet",            "check": "tcp", "port": 23,  "icon": "terminal"},
        {"subtype": "zookeeper",        "label": "Apache Zookeeper",  "check": "tcp", "port": 2181,"icon": "server"},
        {"subtype": "ceph",             "label": "Ceph Storage",      "check": "http","port": 8080,"icon": "hard-drive"},
    ],
    "Mail Servers": [
        {"subtype": "exchange",  "label": "Exchange Server",    "check": "http","port": 443, "icon": "mail"},
        {"subtype": "smtp",      "label": "SMTP Mail Server",   "check": "tcp", "port": 25,  "icon": "mail"},
        {"subtype": "imap",      "label": "IMAP Server",        "check": "tcp", "port": 143, "icon": "mail"},
        {"subtype": "pop3",      "label": "POP3 Server",        "check": "tcp", "port": 110, "icon": "mail"},
        {"subtype": "smtp_tls",  "label": "SMTP (TLS/587)",     "check": "tcp", "port": 587, "icon": "mail"},
    ],
    "Middleware": [
        {"subtype": "rabbitmq",   "label": "RabbitMQ",       "check": "http","port": 15672,"icon": "layers"},
        {"subtype": "kafka",      "label": "Apache Kafka",   "check": "tcp", "port": 9092, "icon": "layers"},
        {"subtype": "activemq",   "label": "Apache ActiveMQ","check": "http","port": 8161, "icon": "layers"},
        {"subtype": "spark",      "label": "Apache Spark",   "check": "http","port": 8080, "icon": "zap"},
        {"subtype": "hadoop",     "label": "Hadoop",         "check": "http","port": 9870, "icon": "hard-drive"},
        {"subtype": "msmq",       "label": "Microsoft MQ",   "check": "tcp", "port": 1801, "icon": "layers"},
        {"subtype": "ibm_mq",     "label": "IBM WebSphere MQ","check":"tcp", "port": 1414, "icon": "layers"},
    ],
    "Virtualization / Cloud": [
        {"subtype": "docker",      "label": "Docker API",       "check": "http","port": 2375, "icon": "box"},
        {"subtype": "vmware_esxi", "label": "VMware ESXi",      "check": "http","port": 443,  "icon": "server"},
        {"subtype": "hyperv",      "label": "Hyper-V Server",   "check": "tcp", "port": 445,  "icon": "server"},
        {"subtype": "xenserver",   "label": "XenServer",        "check": "http","port": 443,  "icon": "server"},
        {"subtype": "openstack",   "label": "OpenStack",        "check": "http","port": 5000, "icon": "cloud"},
    ],
    "Custom": [
        {"subtype": "tcp_custom",  "label": "TCP Port Check",   "check": "tcp",  "port": None, "icon": "plug"},
        {"subtype": "http_custom", "label": "HTTP/HTTPS Check", "check": "http", "port": 80,   "icon": "globe"},
        {"subtype": "ping_custom", "label": "Ping Check",       "check": "ping", "port": None, "icon": "radio"},
        {"subtype": "dns_custom",  "label": "DNS Check",        "check": "dns",  "port": 53,   "icon": "search"},
        {"subtype": "ssl_custom",  "label": "SSL Cert Check",   "check": "ssl_cert","port": 443,"icon": "shield"},
        {"subtype": "snmp_custom", "label": "SNMP Check",       "check": "snmp", "port": 161,  "icon": "network"},
    ],
}


@router.get("/catalog")
async def get_catalog(_=Depends(get_current_user)):
    return MONITOR_CATALOG


@router.post("/monitors/test")
async def test_monitor(body: dict, _=Depends(get_current_user)):
    """Run a one-off check against supplied config without saving."""
    import time as _t

    class _FakeMonitor:
        monitor_type = body.get("monitor_type", "tcp")
        host = body.get("host", "")
        port = body.get("port")
        config = body.get("config", {})
        timeout_seconds = int(body.get("timeout_seconds", 10))

    m = _FakeMonitor()
    t0 = _t.monotonic()
    status, latency_ms, message = await _run_check(m)
    elapsed = int((_t.monotonic() - t0) * 1000)

    return {
        "status": status,
        "latency_ms": latency_ms if latency_ms is not None else elapsed,
        "message": message or ("Reachable" if status == "up" else "Unreachable"),
        "ok": status == "up",
    }


# ── Monitors CRUD ──────────────────────────────────────────────────────────────

@router.get("/monitors")
async def list_monitors(
    category: Optional[str] = None,
    group_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    # Fetch monitors with 24h uptime % in a single query
    uptime_q = text("""
        SELECT monitor_id,
               ROUND(COUNT(*) FILTER (WHERE status='up')::numeric
                     / NULLIF(COUNT(*), 0) * 100, 1) AS uptime_24h
        FROM monitor_results
        WHERE time > NOW() - INTERVAL '24 hours'
        GROUP BY monitor_id
    """)
    uptime_rows = await db.execute(uptime_q)
    uptime_map = {str(r.monitor_id): float(r.uptime_24h) for r in uptime_rows}

    q = select(Monitor).order_by(Monitor.name.asc())
    if category:
        q = q.where(Monitor.category == category)
    if group_id:
        import uuid as _uuid
        q = q.where(Monitor.group_id == _uuid.UUID(group_id))
    result = await db.execute(q)
    out = []
    for m in result.scalars().all():
        d = _monitor_dict(m)
        d["uptime_24h"] = uptime_map.get(str(m.id))
        out.append(d)
    return out


@router.post("/monitors", status_code=201)
async def create_monitor(body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    import uuid as _uuid
    agent_id = None
    if body.get("agent_id"):
        try:
            agent_id = _uuid.UUID(body["agent_id"])
        except ValueError:
            pass
    m = Monitor(
        name=body["name"],
        monitor_type=body["monitor_type"],
        category=body.get("category", "network"),
        subtype=body.get("subtype"),
        host=body.get("host"),
        port=int(body["port"]) if body.get("port") else None,
        config=body.get("config", {}),
        check_interval_seconds=int(body.get("check_interval_seconds", 60)),
        timeout_seconds=int(body.get("timeout_seconds", 10)),
        is_active=body.get("is_active", True),
        agent_id=agent_id,
    )
    db.add(m)
    await db.commit()
    await db.refresh(m)
    return _monitor_dict(m)


@router.put("/monitors/{monitor_id}")
async def update_monitor(monitor_id: str, body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(select(Monitor).where(Monitor.id == monitor_id))
    m = result.scalar_one_or_none()
    if not m:
        raise HTTPException(404, "Monitor not found")
    for field in ["name", "host", "port", "config", "check_interval_seconds", "timeout_seconds", "is_active", "category", "subtype"]:
        if field in body:
            setattr(m, field, body[field])
    if "agent_id" in body:
        import uuid as _uuid
        try:
            m.agent_id = _uuid.UUID(body["agent_id"]) if body["agent_id"] else None
        except ValueError:
            m.agent_id = None
    await db.commit()
    return _monitor_dict(m)


@router.delete("/monitors/{monitor_id}", status_code=204)
async def delete_monitor(monitor_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(select(Monitor).where(Monitor.id == monitor_id))
    m = result.scalar_one_or_none()
    if not m:
        raise HTTPException(404, "Monitor not found")
    await db.delete(m)
    await db.commit()


@router.get("/monitors/{monitor_id}/results")
async def monitor_results(
    monitor_id: str, hours: int = 24,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    rows = await db.execute(
        text("""
            SELECT time, status, latency_ms, message
            FROM monitor_results
            WHERE monitor_id = :mid
              AND time > NOW() - (:h * INTERVAL '1 hour')
            ORDER BY time DESC LIMIT 500
        """),
        {"mid": monitor_id, "h": hours},
    )
    return [{"time": r.time.isoformat(), "status": r.status, "latency_ms": r.latency_ms, "message": r.message} for r in rows]


@router.get("/monitors/{monitor_id}/stats")
async def monitor_stats(
    monitor_id: str,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Availability %, uptime today, last downtime, hourly status grid."""
    m = await db.get(Monitor, monitor_id)
    if not m:
        raise HTTPException(404, "Monitor not found")

    # Overall availability last 24h
    row = await db.execute(text("""
        SELECT
            COUNT(*) FILTER (WHERE status='up') AS up_count,
            COUNT(*) AS total
        FROM monitor_results
        WHERE monitor_id = :mid AND time > NOW() - INTERVAL '24 hours'
    """), {"mid": monitor_id})
    r = row.first()
    up_count = r.up_count or 0
    total = r.total or 0
    availability_24h = round((up_count / total * 100), 2) if total else None

    # Today's availability (midnight UTC to now)
    row2 = await db.execute(text("""
        SELECT
            COUNT(*) FILTER (WHERE status='up') AS up_count,
            COUNT(*) AS total
        FROM monitor_results
        WHERE monitor_id = :mid AND time >= DATE_TRUNC('day', NOW())
    """), {"mid": monitor_id})
    r2 = row2.first()
    today_up = r2.up_count or 0
    today_total = r2.total or 0
    availability_today = round((today_up / today_total * 100), 2) if today_total else None

    # Last downtime
    row3 = await db.execute(text("""
        SELECT time FROM monitor_results
        WHERE monitor_id = :mid AND status != 'up'
        ORDER BY time DESC LIMIT 1
    """), {"mid": monitor_id})
    r3 = row3.first()
    last_downtime = r3.time.isoformat() if r3 else None

    # Uptime since last downtime (or since first check)
    row4 = await db.execute(text("""
        SELECT time FROM monitor_results
        WHERE monitor_id = :mid AND status != 'up'
        ORDER BY time DESC LIMIT 1
    """), {"mid": monitor_id})
    r4 = row4.first()
    if r4:
        uptime_since = r4.time
    else:
        row5 = await db.execute(text("""
            SELECT MIN(time) FROM monitor_results WHERE monitor_id = :mid AND status = 'up'
        """), {"mid": monitor_id})
        r5 = row5.first()
        uptime_since = r5[0] if r5 and r5[0] else None

    uptime_seconds = None
    if uptime_since:
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc)
        delta = now - uptime_since
        uptime_seconds = int(delta.total_seconds())

    # Hourly status buckets for last 24 hours (status grid)
    row6 = await db.execute(text("""
        SELECT
            DATE_TRUNC('hour', time) AS hour,
            COUNT(*) FILTER (WHERE status='up') AS up_count,
            COUNT(*) AS total,
            AVG(latency_ms) FILTER (WHERE status='up') AS avg_latency
        FROM monitor_results
        WHERE monitor_id = :mid AND time > NOW() - INTERVAL '24 hours'
        GROUP BY 1 ORDER BY 1
    """), {"mid": monitor_id})
    hourly = []
    for hr in row6:
        up_pct = round((hr.up_count / hr.total * 100)) if hr.total else 0
        status = "up" if up_pct >= 80 else ("warning" if up_pct >= 50 else "down")
        hourly.append({
            "hour": hr.hour.isoformat(),
            "up_pct": up_pct,
            "status": status,
            "avg_latency": round(hr.avg_latency) if hr.avg_latency else None,
        })

    # Response time series — last 6h, bucketed every 5 min
    row7 = await db.execute(text("""
        SELECT
            DATE_TRUNC('minute', time) - (EXTRACT(MINUTE FROM time)::int % 5) * INTERVAL '1 minute' AS bucket,
            AVG(latency_ms) FILTER (WHERE status='up') AS avg_latency,
            MAX(latency_ms) FILTER (WHERE status='up') AS max_latency,
            COUNT(*) FILTER (WHERE status!='up') AS down_count
        FROM monitor_results
        WHERE monitor_id = :mid AND time > NOW() - INTERVAL '6 hours'
        GROUP BY 1 ORDER BY 1
    """), {"mid": monitor_id})
    timeseries = []
    for ts in row7:
        timeseries.append({
            "time": ts.bucket.isoformat(),
            "avg_latency": round(ts.avg_latency) if ts.avg_latency else None,
            "max_latency": round(ts.max_latency) if ts.max_latency else None,
            "down": ts.down_count > 0,
        })

    # 7-day availability (day by day)
    row8 = await db.execute(text("""
        SELECT
            DATE_TRUNC('day', time) AS day,
            COUNT(*) FILTER (WHERE status='up') AS up_count,
            COUNT(*) AS total
        FROM monitor_results
        WHERE monitor_id = :mid AND time > NOW() - INTERVAL '7 days'
        GROUP BY 1 ORDER BY 1
    """), {"mid": monitor_id})
    daily = []
    for d in row8:
        up_pct = round((d.up_count / d.total * 100), 1) if d.total else 0
        daily.append({"day": d.day.isoformat(), "up_pct": up_pct, "total": d.total})

    return {
        "monitor": _monitor_dict(m),
        "availability_24h": availability_24h,
        "availability_today": availability_today,
        "last_downtime": last_downtime,
        "uptime_seconds": uptime_seconds,
        "hourly": hourly,
        "timeseries": timeseries,
        "daily": daily,
        "total_checks_24h": total,
    }


# ── Daily availability report (previous day) ──────────────────────────────────

@router.get("/report/daily")
async def daily_report(
    range: Optional[str] = "yesterday",   # today|yesterday|7d|30d|month|last_month|custom
    from_date: Optional[str] = None,       # ISO date YYYY-MM-DD (for custom)
    to_date: Optional[str] = None,         # ISO date YYYY-MM-DD (for custom, inclusive)
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Returns per-monitor availability stats for the chosen date range (UTC)."""
    from datetime import datetime, timezone, timedelta

    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    if range == "today":
        t_from = today_start
        t_to   = now
        label  = "Today"
    elif range == "yesterday":
        t_from = today_start - timedelta(days=1)
        t_to   = today_start
        label  = "Yesterday"
    elif range == "7d":
        t_from = now - timedelta(days=7)
        t_to   = now
        label  = "Last 7 Days"
    elif range == "30d":
        t_from = now - timedelta(days=30)
        t_to   = now
        label  = "Last 30 Days"
    elif range == "month":
        t_from = today_start.replace(day=1)
        t_to   = now
        label  = "This Month"
    elif range == "last_month":
        first_this = today_start.replace(day=1)
        last_prev  = first_this - timedelta(days=1)
        t_from = last_prev.replace(day=1)
        t_to   = first_this
        label  = "Last Month"
    elif range == "custom" and from_date and to_date:
        t_from = datetime.fromisoformat(from_date).replace(tzinfo=timezone.utc)
        # to_date is inclusive — go to end of that day
        t_to   = datetime.fromisoformat(to_date).replace(
            hour=23, minute=59, second=59, tzinfo=timezone.utc
        )
        label  = f"{from_date} – {to_date}"
    else:
        # default: yesterday
        t_from = today_start - timedelta(days=1)
        t_to   = today_start
        label  = "Yesterday"

    rows = await db.execute(
        text("""
            WITH period AS (
                SELECT
                    monitor_id,
                    COUNT(*) AS total_checks,
                    SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS up_count,
                    SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) AS down_count,
                    ROUND(AVG(latency_ms)::numeric, 1) AS avg_latency_ms,
                    MIN(latency_ms) AS min_latency_ms,
                    MAX(latency_ms) AS max_latency_ms,
                    MIN(time) AS first_check,
                    MAX(time) AS last_check
                FROM monitor_results
                WHERE time >= :t_from AND time < :t_to
                GROUP BY monitor_id
            )
            SELECT
                m.id::text,
                m.name,
                m.monitor_type,
                m.subtype,
                m.category,
                m.host,
                m.port,
                m.last_status,
                COALESCE(p.total_checks, 0) AS total_checks,
                COALESCE(p.up_count, 0)     AS up_count,
                COALESCE(p.down_count, 0)   AS down_count,
                CASE WHEN COALESCE(p.total_checks, 0) > 0
                     THEN ROUND(p.up_count::numeric / p.total_checks * 100, 1)
                     ELSE NULL END AS uptime_pct,
                p.avg_latency_ms,
                p.min_latency_ms,
                p.max_latency_ms
            FROM monitors m
            LEFT JOIN period p ON p.monitor_id = m.id
            WHERE m.is_active = TRUE
            ORDER BY m.name
        """),
        {"t_from": t_from, "t_to": t_to},
    )
    keys = ["id","name","monitor_type","subtype","category","host","port","last_status",
            "total_checks","up_count","down_count","uptime_pct",
            "avg_latency_ms","min_latency_ms","max_latency_ms"]
    return {
        "label": label,
        "from": t_from.isoformat(),
        "to": t_to.isoformat(),
        "monitors": [dict(zip(keys, r)) for r in rows.fetchall()],
    }


# ── Yearly availability report ────────────────────────────────────────────────

@router.get("/report/yearly")
async def yearly_report(
    year: Optional[int] = None,
    db: AsyncSession = Depends(get_db),
    _=Depends(get_current_user),
):
    """Per-monitor daily uptime aggregates for an entire calendar year."""
    from datetime import datetime, timezone
    if year is None:
        year = datetime.now(timezone.utc).year

    t_from = datetime(year, 1, 1, tzinfo=timezone.utc)
    t_to   = datetime(year + 1, 1, 1, tzinfo=timezone.utc)

    # Never include today — the day hasn't ended so its aggregate would be partial.
    now = datetime.now(timezone.utc)
    today_start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
    if t_to > today_start:
        t_to = today_start

    rows = await db.execute(text("""
        WITH daily AS (
            SELECT
                DATE(time AT TIME ZONE 'UTC')                                   AS day,
                monitor_id,
                COUNT(*)                                                         AS total_checks,
                SUM(CASE WHEN status = 'up'   THEN 1 ELSE 0 END)               AS up_count,
                SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END)               AS down_count,
                ROUND(AVG(latency_ms)::numeric, 1)                              AS avg_latency_ms
            FROM monitor_results
            WHERE time >= :t_from AND time < :t_to
            GROUP BY DATE(time AT TIME ZONE 'UTC'), monitor_id
        )
        SELECT
            d.day,
            m.name,
            m.monitor_type,
            m.subtype,
            m.category,
            m.host,
            d.total_checks,
            d.up_count,
            d.down_count,
            CASE WHEN d.total_checks > 0
                 THEN ROUND(d.up_count::numeric / d.total_checks * 100, 2)
                 ELSE NULL END  AS uptime_pct,
            d.avg_latency_ms
        FROM daily d
        JOIN monitors m ON m.id = d.monitor_id
        WHERE m.is_active = TRUE
        ORDER BY d.day, m.name
    """), {"t_from": t_from, "t_to": t_to})

    records = []
    for r in rows.fetchall():
        records.append({
            "date":           r[0].isoformat(),
            "monitor_name":   r[1],
            "monitor_type":   r[2],
            "subtype":        r[3],
            "category":       r[4],
            "host":           r[5],
            "total_checks":   int(r[6]),
            "up_count":       int(r[7]),
            "down_count":     int(r[8]),
            "uptime_pct":     float(r[9])  if r[9]  is not None else None,
            "avg_latency_ms": float(r[10]) if r[10] is not None else None,
        })

    return {"year": year, "records": records}


# ── Legacy port checks (keep for backwards compat) ─────────────────────────────

@router.get("/ports")
async def list_ports(db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(select(MonitoredPort).order_by(MonitoredPort.name.asc()))
    return [_port_dict(p) for p in result.scalars().all()]


@router.post("/ports", status_code=201)
async def create_port(body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    p = MonitoredPort(
        name=body["name"], host=body["host"], port=int(body["port"]),
        protocol=body.get("protocol", "tcp"),
        check_interval_seconds=int(body.get("check_interval_seconds", 60)),
        timeout_seconds=int(body.get("timeout_seconds", 5)),
        is_active=body.get("is_active", True),
    )
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return _port_dict(p)


@router.put("/ports/{port_id}")
async def update_port(port_id: str, body: dict, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(select(MonitoredPort).where(MonitoredPort.id == port_id))
    p = result.scalar_one_or_none()
    if not p: raise HTTPException(404, "Port check not found")
    for field in ["name", "host", "port", "protocol", "check_interval_seconds", "timeout_seconds", "is_active"]:
        if field in body: setattr(p, field, body[field])
    await db.commit()
    return _port_dict(p)


@router.delete("/ports/{port_id}", status_code=204)
async def delete_port(port_id: str, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    result = await db.execute(select(MonitoredPort).where(MonitoredPort.id == port_id))
    p = result.scalar_one_or_none()
    if not p: raise HTTPException(404, "Port check not found")
    await db.delete(p)
    await db.commit()


@router.get("/ports/{port_id}/results")
async def port_results(port_id: str, hours: int = 24, db: AsyncSession = Depends(get_db), _=Depends(get_current_user)):
    rows = await db.execute(
        text("SELECT time, status, latency_ms FROM port_check_results WHERE port_id=:pid AND time>NOW()-(:h*INTERVAL '1 hour') ORDER BY time DESC LIMIT 500"),
        {"pid": port_id, "h": hours},
    )
    return [{"time": r.time.isoformat(), "status": r.status, "latency_ms": r.latency_ms} for r in rows]


# ── Internal: run all checks (called by Celery) ────────────────────────────────

@router.post("/internal/run-checks", include_in_schema=False)
async def run_all_checks(db: AsyncSession = Depends(get_db)):
    import json as _json
    result = await db.execute(select(Monitor).where(Monitor.is_active == True))
    monitors = result.scalars().all()

    checked = down = 0
    for m in monitors:
        if m.last_checked:
            elapsed = (datetime.now(timezone.utc) - m.last_checked).total_seconds()
            if elapsed < m.check_interval_seconds - 5:
                continue

        # DB plugin monitors: queue command to the assigned agent instead of running locally
        if m.monitor_type == "db_plugin":
            if not m.agent_id:
                continue  # no agent assigned, skip
            # Check if the agent is online
            ag_row = await db.execute(
                text("SELECT status FROM agents WHERE id = :id AND is_active = TRUE"),
                {"id": str(m.agent_id)},
            )
            ag = ag_row.fetchone()
            if not ag or ag[0] != "online":
                continue  # agent offline, skip
            # Map plugin subtype to db_type
            subtype = m.subtype or ""
            db_type = subtype.replace("_plugin", "") if subtype.endswith("_plugin") else subtype
            payload = _json.dumps({
                "monitor_id": str(m.id),
                "db_type": db_type,
                "host": m.host or "localhost",
                "port": m.port or 0,
                "username": (m.config or {}).get("username", ""),
                "password": (m.config or {}).get("password", ""),
                "database": (m.config or {}).get("database", ""),
                "timeout_seconds": m.timeout_seconds or 10,
            })
            await db.execute(
                text("INSERT INTO agent_commands (agent_id, command_type, payload) VALUES (:aid, 'db_check', CAST(:payload AS jsonb))"),
                {"aid": str(m.agent_id), "payload": payload},
            )
            m.last_checked = datetime.now(timezone.utc)
            checked += 1
            continue

        status, latency_ms, message = await _run_check(m)

        await db.execute(
            text("INSERT INTO monitor_results (time, monitor_id, status, latency_ms, message) VALUES (NOW(),:mid,:st,:lat,:msg)"),
            {"mid": str(m.id), "st": status, "lat": latency_ms, "msg": message},
        )

        prev = m.last_status
        m.last_status = status
        m.last_checked = datetime.now(timezone.utc)
        m.last_latency_ms = latency_ms
        m.last_message = message

        if status == "up":
            m.consecutive_failures = 0
            await _resolve_monitor_alert(db, m)
        else:
            m.consecutive_failures = (m.consecutive_failures or 0) + 1
            down += 1
            # Fire alert on 2nd failure and keep trying (dedup is in _fire_monitor_alert)
            if m.consecutive_failures >= 2:
                await _fire_monitor_alert(db, m, status)
        checked += 1

    # Also run legacy port checks
    port_result = await db.execute(select(MonitoredPort).where(MonitoredPort.is_active == True))
    for p in port_result.scalars().all():
        if p.last_checked:
            elapsed = (datetime.now(timezone.utc) - p.last_checked).total_seconds()
            if elapsed < p.check_interval_seconds - 5:
                continue
        pstatus, platency = await _tcp_check(p.host, p.port, p.timeout_seconds)
        await db.execute(
            text("INSERT INTO port_check_results (time, port_id, status, latency_ms) VALUES (NOW(),:pid,:st,:lat)"),
            {"pid": str(p.id), "st": pstatus, "lat": platency},
        )
        p.last_status = pstatus
        p.last_checked = datetime.now(timezone.utc)
        p.last_latency_ms = platency
        p.consecutive_failures = 0 if pstatus == "up" else (p.consecutive_failures or 0) + 1
        checked += 1

    try:
        await db.commit()
    except Exception as e:
        # Deadlock or conflict from concurrent check run — safe to swallow
        await db.rollback()
        return {"checked": 0, "skipped": "concurrent_check"}
    return {"checked": checked, "down": down}


# Keep old endpoint name for Celery task compatibility
@router.post("/internal/run-port-checks", include_in_schema=False)
async def run_port_checks_compat(db: AsyncSession = Depends(get_db)):
    return await run_all_checks(db)


# ── Check engines ──────────────────────────────────────────────────────────────

async def _run_check(m: Monitor) -> tuple[str, Optional[int], Optional[str]]:
    t = m.monitor_type
    host = m.host or ""
    port = m.port
    cfg = m.config or {}
    timeout = m.timeout_seconds or 10
    subtype = getattr(m, "subtype", None) or ""

    try:
        if t == "db_plugin":
            # Agent-side check — cannot run from server; return last known status
            return m.last_status or "unknown", m.last_latency_ms, "Awaiting agent check"
        elif t == "ping":
            return await _ping_check(host, timeout)
        elif t == "tcp":
            # Database monitors with credentials → attempt real auth check
            if cfg.get("username") and subtype in _DB_CHECK_MAP:
                return await _database_check(subtype, host, port, cfg, timeout)
            status, lat = await _tcp_check(host, port, timeout)
            return status, lat, None
        elif t == "http":
            return await _http_check(host, port, cfg, timeout)
        elif t == "ssl_cert":
            return await _ssl_cert_check(host, port or 443, timeout)
        elif t == "dns":
            return await _dns_check(host, cfg, timeout)
        elif t == "snmp":
            return await _snmp_check(host, port or 161, cfg, timeout)
        else:
            # Fallback to TCP for unknown types
            if port:
                status, lat = await _tcp_check(host, port, timeout)
                return status, lat, None
            return "unknown", None, "No check method for this type"
    except Exception as e:
        return "down", None, str(e)


# Maps subtype → driver name for authenticated DB checks
_DB_CHECK_MAP = {
    "postgresql": "postgresql",
    "mysql":      "mysql",
    "mssql":      "mssql",
    "mongodb":    "mongodb",
    "redis":      "redis",
}


async def _database_check(
    subtype: str, host: str, port: Optional[int], cfg: dict, timeout: int
) -> tuple[str, Optional[int], Optional[str]]:
    """Attempt an authenticated connection to a database. Falls back to TCP if driver unavailable."""
    username = cfg.get("username", "")
    password = cfg.get("password", "")
    database = cfg.get("database", "")
    t0 = time_mod.monotonic()

    def _connect():
        if subtype == "postgresql":
            import psycopg2
            conn = psycopg2.connect(
                host=host, port=port or 5432,
                user=username, password=password,
                dbname=database or "postgres",
                connect_timeout=timeout,
            )
            conn.close()
        elif subtype == "mysql":
            import pymysql
            conn = pymysql.connect(
                host=host, port=port or 3306,
                user=username, password=password,
                database=database or None,
                connect_timeout=timeout,
            )
            conn.close()
        elif subtype == "mssql":
            import pymssql
            conn = pymssql.connect(
                server=host, port=str(port or 1433),
                user=username, password=password,
                database=database or "master",
                timeout=timeout,
                login_timeout=timeout,
            )
            conn.close()
        elif subtype == "mongodb":
            from pymongo import MongoClient
            uri = f"mongodb://{username}:{password}@{host}:{port or 27017}/{database or 'admin'}"
            client = MongoClient(uri, serverSelectionTimeoutMS=timeout * 1000)
            client.admin.command("ping")
            client.close()
        elif subtype == "redis":
            import redis as redis_lib
            r = redis_lib.Redis(
                host=host, port=port or 6379,
                password=password or None,
                db=int(database) if database else 0,
                socket_connect_timeout=timeout,
                socket_timeout=timeout,
            )
            r.ping()
            r.close()
        else:
            raise ValueError(f"No driver for {subtype}")

    try:
        loop = asyncio.get_event_loop()
        await asyncio.wait_for(loop.run_in_executor(None, _connect), timeout=timeout + 2)
        latency_ms = int((time_mod.monotonic() - t0) * 1000)
        return "up", latency_ms, f"Auth OK ({subtype})"
    except asyncio.TimeoutError:
        return "timeout", None, "Connection timed out"
    except ImportError as e:
        # Driver not installed — fall back to TCP
        status, lat = await _tcp_check(host, port or 5432, timeout)
        return status, lat, f"TCP only (driver unavailable: {e})"
    except Exception as e:
        latency_ms = int((time_mod.monotonic() - t0) * 1000)
        err = str(e)
        if any(kw in err.lower() for kw in ["password", "authentication", "access denied", "login failed"]):
            return "down", latency_ms, f"Auth failed: {err[:120]}"
        return "down", latency_ms, err[:120]


async def _ping_check(host: str, timeout: int) -> tuple[str, Optional[int], Optional[str]]:
    t0 = time_mod.monotonic()
    try:
        result = await asyncio.wait_for(
            asyncio.get_event_loop().run_in_executor(
                None,
                lambda: subprocess.run(
                    ["ping", "-c", "1", "-W", str(timeout), host],
                    capture_output=True, timeout=timeout + 2
                )
            ),
            timeout=timeout + 3,
        )
        latency_ms = int((time_mod.monotonic() - t0) * 1000)
        if result.returncode == 0:
            # Parse round-trip time from ping output
            out = result.stdout.decode()
            import re
            m = re.search(r"time[=<]([\d.]+)", out)
            if m:
                latency_ms = int(float(m.group(1)))
            return "up", latency_ms, None
        return "down", None, "Host unreachable"
    except Exception as e:
        return "down", None, str(e)


async def _tcp_check(host: str, port: int, timeout: int) -> tuple[str, Optional[int]]:
    t0 = time_mod.monotonic()
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=timeout)
        writer.close()
        try: await writer.wait_closed()
        except Exception: pass
        return "up", int((time_mod.monotonic() - t0) * 1000)
    except asyncio.TimeoutError:
        return "timeout", None
    except Exception:
        return "down", None


async def _http_check(host: str, port: Optional[int], cfg: dict, timeout: int) -> tuple[str, Optional[int], Optional[str]]:
    import httpx
    scheme = cfg.get("scheme", "https" if port == 443 else "http")
    path = cfg.get("path", "/")
    url = cfg.get("url") or f"{scheme}://{host}:{port}{path}" if port else f"{scheme}://{host}{path}"
    expected_status = int(cfg.get("expected_status", 200))
    content_match = cfg.get("content_match", "")

    t0 = time_mod.monotonic()
    try:
        async with httpx.AsyncClient(timeout=timeout, verify=False, follow_redirects=True) as client:
            r = await client.get(url, headers={"User-Agent": "Kifaa-Monitor/1.0"})
        latency_ms = int((time_mod.monotonic() - t0) * 1000)
        if r.status_code != expected_status:
            return "down", latency_ms, f"HTTP {r.status_code} (expected {expected_status})"
        if content_match and content_match not in r.text:
            return "down", latency_ms, f"Content match failed: '{content_match}' not found"
        return "up", latency_ms, f"HTTP {r.status_code}"
    except httpx.TimeoutException:
        return "timeout", None, "Request timed out"
    except Exception as e:
        return "down", None, str(e)


async def _ssl_cert_check(host: str, port: int, timeout: int) -> tuple[str, Optional[int], Optional[str]]:
    import datetime as dt
    t0 = time_mod.monotonic()

    def _get_cert_verified():
        """Try with certifi CA bundle — covers more intermediates than the system bundle."""
        import certifi
        ctx = ssl.create_default_context(cafile=certifi.where())
        conn = ctx.wrap_socket(socket.create_connection((host, port), timeout=timeout), server_hostname=host)
        cert = conn.getpeercert()
        conn.close()
        return cert, None  # (cert_dict, chain_warning)

    def _get_cert_unverified():
        """Fetch raw DER cert without chain verification, parse expiry via cryptography."""
        from cryptography import x509
        from cryptography.hazmat.backends import default_backend
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        conn = ctx.wrap_socket(socket.create_connection((host, port), timeout=timeout), server_hostname=host)
        der = conn.getpeercert(binary_form=True)
        conn.close()
        parsed = x509.load_der_x509_certificate(der, default_backend())
        return parsed, "Incomplete certificate chain — server is not sending intermediate cert"

    try:
        loop = asyncio.get_event_loop()
        chain_warning = None
        expiry = None

        try:
            cert, _ = await asyncio.wait_for(loop.run_in_executor(None, _get_cert_verified), timeout=timeout + 2)
            latency_ms = int((time_mod.monotonic() - t0) * 1000)
            not_after = cert.get("notAfter", "")
            expiry = dt.datetime.strptime(not_after, "%b %d %H:%M:%S %Y %Z")
        except ssl.SSLCertVerificationError:
            # Chain incomplete — fetch raw cert to still check expiry/validity
            parsed, chain_warning = await asyncio.wait_for(loop.run_in_executor(None, _get_cert_unverified), timeout=timeout + 2)
            latency_ms = int((time_mod.monotonic() - t0) * 1000)
            expiry = parsed.not_valid_after_utc.replace(tzinfo=None)

        days_left = (expiry - dt.datetime.utcnow()).days

        if days_left <= 0:
            return "down", latency_ms, "Certificate EXPIRED"
        if days_left <= 3:
            return "down", latency_ms, f"Certificate expires in {days_left} days — CRITICAL"

        suffix = " (renew soon)" if days_left <= 30 else ""
        if chain_warning:
            return "up", latency_ms, f"Valid — expires in {days_left} days{suffix} ⚠ {chain_warning}"
        return "up", latency_ms, f"Valid — expires in {days_left} days{suffix}"

    except ssl.SSLCertVerificationError as e:
        return "down", None, f"SSL error: {e}"
    except Exception as e:
        return "down", None, str(e)


async def _dns_check(host: str, cfg: dict, timeout: int) -> tuple[str, Optional[int], Optional[str]]:
    t0 = time_mod.monotonic()
    try:
        import dns.resolver
        resolver = dns.resolver.Resolver()
        resolver.lifetime = timeout
        record_type = cfg.get("record_type", "A")
        lookup = cfg.get("lookup_hostname", host)
        answers = await asyncio.get_event_loop().run_in_executor(
            None, lambda: resolver.resolve(lookup, record_type)
        )
        latency_ms = int((time_mod.monotonic() - t0) * 1000)
        results = [str(r) for r in answers]
        return "up", latency_ms, f"{record_type} → {', '.join(results[:3])}"
    except Exception as e:
        return "down", None, str(e)


async def _snmp_check(host: str, port: int, cfg: dict, timeout: int) -> tuple[str, Optional[int], Optional[str]]:
    t0 = time_mod.monotonic()
    try:
        from pysnmp.hlapi.asyncio import (
            getCmd, SnmpEngine, CommunityData, UdpTransportTarget,
            ContextData, ObjectType, ObjectIdentity,
        )
        community = cfg.get("community", "public")
        oid = cfg.get("oid", "1.3.6.1.2.1.1.1.0")  # sysDescr

        error_indication, error_status, _, var_binds = await getCmd(
            SnmpEngine(),
            CommunityData(community),
            UdpTransportTarget((host, port), timeout=timeout, retries=1),
            ContextData(),
            ObjectType(ObjectIdentity(oid)),
        )
        latency_ms = int((time_mod.monotonic() - t0) * 1000)

        if error_indication:
            return "down", latency_ms, str(error_indication)
        if error_status:
            return "down", latency_ms, str(error_status)

        val = str(var_binds[0][1]) if var_binds else "OK"
        return "up", latency_ms, val[:120]
    except Exception as e:
        return "down", None, str(e)


async def _fire_monitor_alert(db: AsyncSession, m: Monitor, status: str):
    existing = await db.execute(
        select(Alert).where(
            Alert.source == "monitor",
            Alert.message.like(f"%{m.name}%"),
            Alert.status.in_(["open", "acknowledged"]),
        )
    )
    if existing.scalars().first():
        return
    alert = Alert(
        source="monitor", severity="critical",
        message=f"Monitor DOWN: {m.name} ({m.subtype or m.monitor_type}) — {m.host} is {status}. {m.last_message or ''}",
        status="open",
    )
    db.add(alert)


async def _resolve_monitor_alert(db: AsyncSession, m: Monitor):
    result = await db.execute(
        select(Alert).where(
            Alert.source == "monitor",
            Alert.message.like(f"%{m.name}%"),
            Alert.status.in_(["open", "acknowledged"]),
        )
    )
    for alert in result.scalars().all():
        alert.status = "resolved"
        alert.resolved_at = datetime.now(timezone.utc)


def _monitor_dict(m: Monitor) -> dict:
    return {
        "id": str(m.id),
        "name": m.name,
        "monitor_type": m.monitor_type,
        "category": m.category,
        "subtype": m.subtype,
        "host": m.host,
        "port": m.port,
        "config": m.config or {},
        "check_interval_seconds": m.check_interval_seconds,
        "timeout_seconds": m.timeout_seconds,
        "is_active": m.is_active,
        "last_status": m.last_status,
        "last_checked": m.last_checked.isoformat() if m.last_checked else None,
        "last_latency_ms": m.last_latency_ms,
        "last_message": m.last_message,
        "consecutive_failures": m.consecutive_failures or 0,
        "created_at": m.created_at.isoformat() if m.created_at else None,
        "agent_id": str(m.agent_id) if m.agent_id else None,
    }


def _port_dict(p: MonitoredPort) -> dict:
    return {
        "id": str(p.id), "name": p.name, "host": p.host, "port": p.port,
        "protocol": p.protocol, "check_interval_seconds": p.check_interval_seconds,
        "timeout_seconds": p.timeout_seconds, "is_active": p.is_active,
        "last_status": p.last_status,
        "last_checked": p.last_checked.isoformat() if p.last_checked else None,
        "last_latency_ms": p.last_latency_ms,
        "consecutive_failures": p.consecutive_failures or 0,
        "created_at": p.created_at.isoformat() if p.created_at else None,
    }
