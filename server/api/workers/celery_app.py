from celery import Celery
from celery.schedules import crontab
import os

broker = os.getenv("CELERY_BROKER_URL", "redis://redis:6379/1")
backend = os.getenv("CELERY_RESULT_BACKEND", "redis://redis:6379/2")

celery_app = Celery("kifaa", broker=broker, backend=backend, include=["api.workers.tasks"])

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    beat_schedule={
        # Mark stale agents offline every 2 minutes
        "mark-offline-agents": {
            "task": "api.workers.tasks.mark_offline_agents",
            "schedule": crontab(minute="*/2"),
        },
        # Evaluate metric alert rules every minute
        "evaluate-alerts": {
            "task": "api.workers.tasks.evaluate_alerts",
            "schedule": crontab(minute="*"),
        },
        # Run port checks every minute
        "run-port-checks": {
            "task": "api.workers.tasks.run_port_checks",
            "schedule": crontab(minute="*"),
        },
        # Service monitor: auto-restart stopped services every 2 minutes
        "run-service-monitor": {
            "task": "api.workers.tasks.run_service_monitor",
            "schedule": crontab(minute="*/2"),
        },
        # Agent watchdog: restart offline-but-reachable agents every 5 minutes
        "run-agent-watchdog": {
            "task": "api.workers.tasks.run_agent_watchdog",
            "schedule": crontab(minute="*/5"),
        },
        # Daily scheduled backup at 2am UTC
        "daily-backup": {
            "task": "api.workers.tasks.run_database_backup",
            "schedule": crontab(minute=0, hour=2),
            "args": ("scheduled",),
        },
        # Daily backup pruning safety net at 3:30am UTC
        "prune-backups": {
            "task": "api.workers.tasks.prune_old_backups",
            "schedule": crontab(minute=30, hour=3),
        },
        # Daily AD event log retention — delete events older than 60 days (runs at 4am UTC)
        "prune-ad-events": {
            "task": "api.workers.tasks.prune_ad_events",
            "schedule": crontab(minute=0, hour=4),
        },
        # Check report schedules every 5 minutes
        "check-report-schedules": {
            "task": "api.workers.tasks.check_report_schedules",
            "schedule": crontab(minute="*/5"),
        },
        # Hourly agent sync — queue collect_inventory for all online agents
        "hourly-agent-sync": {
            "task": "api.workers.tasks.run_hourly_sync",
            "schedule": crontab(minute=30),  # runs at :30 past every hour
        },
        # Daily patch scan — queue patch_scan commands for all online agents at 3am UTC
        "daily-patch-scan": {
            "task": "api.workers.tasks.run_daily_patch_scan",
            "schedule": crontab(minute=0, hour=3),
        },
        # Timeout patch jobs stuck for more than 2 hours — runs every 30 minutes
        "timeout-stale-patch-jobs": {
            "task": "api.workers.tasks.timeout_stale_patch_jobs",
            "schedule": crontab(minute="*/30"),
        },
        # Check reboot schedules every minute
        "run-reboot-schedules": {
            "task": "api.workers.tasks.run_reboot_schedules",
            "schedule": crontab(minute="*"),
        },
        # Check patch schedules every minute
        "run-patch-schedules": {
            "task": "api.workers.tasks.run_patch_schedules",
            "schedule": crontab(minute="*"),
        },
        # Execute due maintenance plan cycles every minute
        "run-maintenance-cycles": {
            "task": "api.workers.tasks.run_maintenance_cycles",
            "schedule": crontab(minute="*"),
        },
        # Sync Unitrends backup data every 15 minutes
        "sync-unitrends": {
            "task": "api.workers.tasks.sync_unitrends",
            "schedule": crontab(minute="*/15"),
        },
        # Sync Sophos Central every 30 minutes
        "sync-sophos": {
            "task": "api.workers.tasks.sync_sophos",
            "schedule": crontab(minute="*/30"),
        },
        # Sync Office 365 every hour
        "sync-o365": {
            "task": "api.workers.tasks.sync_o365",
            "schedule": crontab(minute=0),
        },
        # Sync VMware vCenter every 15 minutes
        "sync-vmware": {
            "task": "api.workers.tasks.sync_vmware",
            "schedule": crontab(minute="*/15"),
        },
        # Sync Proxmox VE every 15 minutes
        "sync-proxmox": {
            "task": "api.workers.tasks.sync_proxmox",
            "schedule": crontab(minute="*/15"),
        },
        # Sync Nutanix Prism every 15 minutes
        "sync-nutanix": {
            "task": "api.workers.tasks.sync_nutanix",
            "schedule": crontab(minute="*/15"),
        },
        # Sync SAP Business One every 4 hours
        "sync-sap": {
            "task": "api.workers.tasks.sync_sap",
            "schedule": crontab(minute=0, hour="*/4"),
        },
        # Sync APC UPS via SNMP every 5 minutes
        "sync-apc-ups": {
            "task": "api.workers.tasks.sync_apc_ups",
            "schedule": crontab(minute="*/5"),
        },
        # Check UPS shutdown policies every 5 minutes
        "check-ups-shutdown": {
            "task": "api.workers.tasks.check_ups_shutdown",
            "schedule": crontab(minute="*/5"),
        },
        # Weekly Server Health Status Report — Monday 8am EAT (5am UTC)
        "weekly-health-report": {
            "task": "api.workers.tasks.send_weekly_health_report",
            "schedule": crontab(hour=5, minute=0, day_of_week=1),
        },
        # Check Let's Encrypt certs daily at 3:15am UTC and renew if expiring within 30 days
        "renew-le-certs": {
            "task": "api.workers.tasks.renew_expiring_le_certs",
            "schedule": crontab(hour=3, minute=15),
        },
    },
)
