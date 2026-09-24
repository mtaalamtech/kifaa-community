"""
Audit log forwarding — sends structured audit events to:
  1. /app/logs/audit.log  (rotating file — always active, independent of the database)
  2. External syslog server (optional — when SYSLOG_HOST is configured)
  3. The audit_log DB table  (already handled by each router)

Usage:
    from api.audit_log import audit

    audit("user_login", user_id=str(user.id), username=user.username,
          ip=request.client.host, result="success")
"""
import logging
import json
import os
from logging.handlers import RotatingFileHandler

_audit_log = logging.getLogger("kifaa.audit")


def _configure_file_handler(log_path: str = "/app/logs/audit.log") -> None:
    """Attach a rotating file handler. Called once at startup — always active."""
    try:
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        handler = RotatingFileHandler(
            log_path,
            maxBytes=50 * 1024 * 1024,   # 50 MB per file
            backupCount=10,               # keep 10 rotated files (~500 MB total)
            encoding="utf-8",
        )
        handler.setFormatter(logging.Formatter(
            fmt="%(asctime)s kifaa-audit: %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S%z",
        ))
        _audit_log.addHandler(handler)
        _audit_log.setLevel(logging.INFO)
        _audit_log.propagate = False
    except Exception as e:
        logging.getLogger("api").warning("Failed to configure audit file handler: %s", e)


def configure_audit_logging(log_path: str = "/app/logs/audit.log",
                             syslog_host: str = "", syslog_port: int = 514) -> None:
    """Wire up all audit log handlers. Called once from main.py lifespan."""
    _configure_file_handler(log_path)
    if syslog_host:
        configure_syslog(syslog_host, syslog_port)


def audit(action: str, **details) -> None:
    """Emit a structured audit event."""
    payload = {"action": action, **details}
    _audit_log.info(json.dumps(payload))


def configure_syslog(host: str, port: int = 514) -> None:
    """Attach a UDP SysLogHandler to the kifaa.audit logger.
    Called once at startup when SYSLOG_HOST is configured.
    """
    if not host:
        return
    try:
        from logging.handlers import SysLogHandler
        handler = SysLogHandler(address=(host, port))
        handler.setFormatter(logging.Formatter(
            fmt="kifaa[%(process)d]: %(message)s",
        ))
        _audit_log.addHandler(handler)
        logging.getLogger("api").info(
            "Audit log syslog forwarding enabled: %s:%d", host, port
        )
    except Exception as e:
        logging.getLogger("api").warning(
            "Failed to configure syslog handler (%s:%d): %s", host, port, e
        )
