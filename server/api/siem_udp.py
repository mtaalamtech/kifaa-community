"""
Async UDP syslog listener for Kifaa SIEM.
Supports RFC 3164 (BSD/legacy) and RFC 5424 (structured) syslog formats.
Runs as an asyncio background task alongside the FastAPI app.
"""
import asyncio
import logging
import os
import json
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

# Map syslog severity int → normalized level string
_SEV_MAP = {
    0: "critical",   # Emergency
    1: "critical",   # Alert
    2: "critical",   # Critical
    3: "error",      # Error
    4: "warning",    # Warning
    5: "warning",    # Notice
    6: "info",       # Informational
    7: "debug",      # Debug
}

_FACILITY_NAMES = [
    "kern", "user", "mail", "daemon", "auth", "syslog", "lpr", "news",
    "uucp", "cron", "authpriv", "ftp", "ntp", "audit", "alert", "clock",
    "local0", "local1", "local2", "local3", "local4", "local5", "local6", "local7",
]

_MONTHS = {"Jan":1,"Feb":2,"Mar":3,"Apr":4,"May":5,"Jun":6,
           "Jul":7,"Aug":8,"Sep":9,"Oct":10,"Nov":11,"Dec":12}


def _parse_pri(raw: str):
    """Extract PRI value and return (pri_int, rest_of_message)."""
    if not raw.startswith("<"):
        return None, raw
    end = raw.find(">")
    if end < 0:
        return None, raw
    try:
        return int(raw[1:end]), raw[end+1:]
    except ValueError:
        return None, raw[end+1:]


def _pri_to_facility_severity(pri: int):
    facility = pri >> 3
    severity = pri & 0x7
    fac_name = _FACILITY_NAMES[facility] if facility < len(_FACILITY_NAMES) else str(facility)
    return facility, severity, fac_name


def _parse_5424(raw: str, pri: int, rest: str, source_ip: str) -> dict:
    """Parse RFC 5424: VERSION SP TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP MSGID SP STRUCTURED-DATA SP MSG"""
    try:
        parts = rest.split(" ", 7)  # VERSION, TS, HOST, APP, PROCID, MSGID, SD, MSG
        version = parts[0] if parts else "1"
        ts_str = parts[1] if len(parts) > 1 else "-"
        hostname = parts[2] if len(parts) > 2 else "-"
        app_name = parts[3] if len(parts) > 3 else "-"
        proc_id = parts[4] if len(parts) > 4 else "-"
        msg_id = parts[5] if len(parts) > 5 else "-"
        # parts[6] = STRUCTURED-DATA (skip)
        message = parts[7] if len(parts) > 7 else ""

        # Parse timestamp
        event_time = datetime.now(timezone.utc)
        if ts_str and ts_str != "-":
            try:
                event_time = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            except Exception:
                pass

        facility, severity, fac_name = _pri_to_facility_severity(pri)
        level = _SEV_MAP.get(severity, "info")
        channel = f"{fac_name}.{['emerg','alert','crit','err','warning','notice','info','debug'][severity]}"

        return {
            "time": event_time,
            "source_ip": source_ip,
            "log_source": "syslog",
            "level": level,
            "event_id": None,
            "channel": channel,
            "message": message.strip() or raw[:500],
            "raw_data": json.dumps({
                "format": "rfc5424",
                "facility": facility,
                "severity": severity,
                "hostname": hostname,
                "app_name": app_name,
                "proc_id": proc_id,
                "msg_id": msg_id,
                "raw": raw[:1000],
            }),
        }
    except Exception as e:
        logger.debug(f"RFC5424 parse error: {e}")
        return _fallback(raw, source_ip)


def _parse_3164(raw: str, pri: int, rest: str, source_ip: str) -> dict:
    """Parse RFC 3164: Mmm DD HH:MM:SS HOSTNAME TAG: MSG"""
    try:
        parts = rest.strip().split(" ", 5)
        # Mmm DD HH:MM:SS HOSTNAME TAG MSG
        month_str = parts[0] if parts else ""
        month = _MONTHS.get(month_str, 1)
        day_str = parts[1].strip() if len(parts) > 1 else "1"
        time_str = parts[2] if len(parts) > 2 else "00:00:00"
        hostname = parts[3] if len(parts) > 3 else "-"
        remainder = " ".join(parts[4:]) if len(parts) > 4 else ""

        # Parse time
        now = datetime.now(timezone.utc)
        try:
            h, m, s = [int(x) for x in time_str.split(":")]
            event_time = now.replace(month=month, day=int(day_str), hour=h, minute=m, second=s, microsecond=0)
            # Handle year rollover (Dec→Jan)
            if event_time > now:
                event_time = event_time.replace(year=event_time.year - 1)
        except Exception:
            event_time = now

        # Extract TAG (up to first ':' or '[')
        tag = ""
        message = remainder
        if ":" in remainder:
            tag, _, message = remainder.partition(":")
            message = message.strip()

        facility, severity, fac_name = _pri_to_facility_severity(pri)
        level = _SEV_MAP.get(severity, "info")
        channel = f"{fac_name}.{['emerg','alert','crit','err','warning','notice','info','debug'][severity]}"

        return {
            "time": event_time,
            "source_ip": source_ip,
            "log_source": "syslog",
            "level": level,
            "event_id": None,
            "channel": channel,
            "message": message[:2000] or remainder[:2000] or raw[:500],
            "raw_data": json.dumps({
                "format": "rfc3164",
                "facility": facility,
                "severity": severity,
                "hostname": hostname,
                "tag": tag,
                "raw": raw[:1000],
            }),
        }
    except Exception as e:
        logger.debug(f"RFC3164 parse error: {e}")
        return _fallback(raw, source_ip)


def _fallback(raw: str, source_ip: str) -> dict:
    return {
        "time": datetime.now(timezone.utc),
        "source_ip": source_ip,
        "log_source": "syslog",
        "level": "info",
        "event_id": None,
        "channel": None,
        "message": raw[:2000],
        "raw_data": json.dumps({"format": "unknown", "raw": raw[:1000]}),
    }


def parse_syslog(data: str, source_ip: str) -> dict:
    """Parse a syslog datagram (RFC 3164 or RFC 5424)."""
    pri, rest = _parse_pri(data)
    if pri is None:
        return _fallback(data, source_ip)

    # RFC 5424 has version digit immediately after '>'
    if rest and rest[0].isdigit() and len(rest) > 1 and rest[1] == " ":
        return _parse_5424(data, pri, rest, source_ip)
    return _parse_3164(data, pri, rest, source_ip)


class SyslogProtocol(asyncio.DatagramProtocol):
    def __init__(self, queue: asyncio.Queue):
        self._queue = queue

    def datagram_received(self, data: bytes, addr: tuple):
        try:
            text = data.decode("utf-8", errors="replace").strip()
            if text:
                event = parse_syslog(text, addr[0])
                self._queue.put_nowait(event)
        except asyncio.QueueFull:
            pass  # Drop under load rather than block
        except Exception as e:
            logger.debug(f"Syslog datagram error: {e}")

    def error_received(self, exc):
        logger.warning(f"Syslog UDP error: {exc}")

    def connection_lost(self, exc):
        logger.info("Syslog UDP transport closed")


async def _flush_events(events: list):
    """Batch-insert syslog events into siem_events table."""
    if not events:
        return
    try:
        import psycopg2
        db_url = os.getenv("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://")
        conn = psycopg2.connect(db_url)
        conn.autocommit = True
        cur = conn.cursor()
        args = [(
            e["time"], None, e["source_ip"], e["log_source"], e["level"],
            e["event_id"], e["channel"], e["message"], e["raw_data"]
        ) for e in events]
        cur.executemany("""
            INSERT INTO siem_events
                (time, agent_id, source_ip, log_source, level,
                 event_id, channel, message, raw_data)
            VALUES (%s, %s, %s::inet, %s, %s, %s, %s, %s, %s::jsonb)
            ON CONFLICT DO NOTHING
        """, args)
        cur.close()
        conn.close()
    except Exception as e:
        logger.error(f"Syslog DB flush error: {e}")


async def _syslog_worker(queue: asyncio.Queue):
    BATCH_SIZE = 100
    FLUSH_INTERVAL = 2.0
    buffer = []
    while True:
        try:
            event = await asyncio.wait_for(queue.get(), timeout=FLUSH_INTERVAL)
            buffer.append(event)
            if len(buffer) >= BATCH_SIZE:
                await _flush_events(buffer)
                buffer.clear()
        except asyncio.TimeoutError:
            if buffer:
                await _flush_events(buffer)
                buffer.clear()
        except asyncio.CancelledError:
            if buffer:
                await _flush_events(buffer)
            raise


async def start_syslog_listener(host: str = "0.0.0.0", port: int = 5140):
    """
    Start the UDP syslog listener. Default port 5140 (unprivileged).
    Map host port 514 → container 5140 in docker-compose for standard syslog.
    Returns (transport, worker_task).
    """
    queue = asyncio.Queue(maxsize=20_000)
    worker_task = asyncio.create_task(_syslog_worker(queue))

    loop = asyncio.get_event_loop()
    try:
        transport, _ = await loop.create_datagram_endpoint(
            lambda: SyslogProtocol(queue),
            local_addr=(host, port),
            reuse_port=True,
        )
        logger.info(f"Syslog UDP listener started on {host}:{port}")
        return transport, worker_task
    except OSError as e:
        logger.warning(f"Could not bind syslog UDP port {port}: {e} — syslog listener disabled")
        worker_task.cancel()
        return None, None
