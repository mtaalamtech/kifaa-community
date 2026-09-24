from sqlalchemy import Column, String, Boolean, Integer, Float, Text, DateTime, ForeignKey, JSON, Numeric
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
import uuid
from api.database import Base


def gen_uuid():
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    username = Column(String(100), unique=True, nullable=False)
    email = Column(String(255), unique=True, nullable=False)
    full_name = Column(String(255))
    hashed_password = Column(Text, nullable=False)
    role = Column(String(50), default="viewer")
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    last_login = Column(DateTime(timezone=True))


class AgentGroup(Base):
    __tablename__ = "agent_groups"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(100), unique=True, nullable=False)
    description = Column(Text)
    color = Column(String(7), default="#3B82F6")
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    agents = relationship("Agent", back_populates="group")


class Agent(Base):
    __tablename__ = "agents"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    hostname = Column(String(255), nullable=False)
    display_name = Column(String(255))
    ip_address = Column(String(45))
    mac_address = Column(String(17))
    os_type = Column(String(50))
    os_name = Column(String(100))
    os_version = Column(String(100))
    os_arch = Column(String(20))
    agent_version = Column(String(20))
    agent_type = Column(String(20), default="modern")
    status = Column(String(20), default="offline")
    last_seen = Column(DateTime(timezone=True))
    registered_at = Column(DateTime(timezone=True), server_default=func.now())
    group_id = Column(UUID(as_uuid=True), ForeignKey("agent_groups.id"), nullable=True)
    asset_type = Column(String(30), nullable=True)
    description = Column(Text, nullable=True)
    tags = Column(JSON, default=list)
    agent_metadata = Column("metadata", JSON, default=dict)
    api_key = Column(String(64), unique=True, nullable=False)
    api_key_expires_at = Column(DateTime(timezone=True))
    is_active = Column(Boolean, default=True)
    restart_pending = Column(Boolean, default=False)
    exclude_from_reports = Column(Boolean, default=False)
    is_restarting = Column(Boolean, default=False)
    restarting_job_id = Column(UUID(as_uuid=True), nullable=True)

    group = relationship("AgentGroup", back_populates="agents")
    hardware = relationship("HardwareInventory", back_populates="agent", uselist=False)
    software = relationship("SoftwareInventory", back_populates="agent")
    services = relationship("Service", back_populates="agent")
    alerts = relationship("Alert", back_populates="agent")


class HardwareInventory(Base):
    __tablename__ = "hardware_inventory"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    agent_id = Column(UUID(as_uuid=True), ForeignKey("agents.id", ondelete="CASCADE"), unique=True)
    cpu_model = Column(String(255))
    cpu_cores = Column(Integer)
    cpu_threads = Column(Integer)
    ram_total_gb = Column(Numeric(10, 2))
    disks = Column(JSON, default=list)
    nics = Column(JSON, default=list)
    dns_servers = Column(JSON, default=list)
    default_gateway = Column(String(64))
    gpu = Column(JSON, default=list)
    bios_vendor = Column(String(100))
    bios_version = Column(String(100))
    bios_date = Column(String(50))
    motherboard_vendor = Column(String(100))
    motherboard_model = Column(String(100))
    serial_number = Column(String(100))
    asset_tag = Column(String(100))
    last_updated = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())

    agent = relationship("Agent", back_populates="hardware")


class SoftwareInventory(Base):
    __tablename__ = "software_inventory"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    agent_id = Column(UUID(as_uuid=True), ForeignKey("agents.id", ondelete="CASCADE"))
    name = Column(String(255), nullable=False)
    version = Column(String(100))
    publisher = Column(String(255))
    install_date = Column(String(20))
    install_location = Column(Text)
    size_mb = Column(Numeric(10, 2))
    first_seen = Column(DateTime(timezone=True), server_default=func.now())
    last_seen = Column(DateTime(timezone=True), server_default=func.now())

    agent = relationship("Agent", back_populates="software")


class Service(Base):
    __tablename__ = "services"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    agent_id = Column(UUID(as_uuid=True), ForeignKey("agents.id", ondelete="CASCADE"))
    service_name = Column(String(255), nullable=False)
    display_name = Column(String(255))
    status = Column(String(50))
    startup_type = Column(String(50))
    pid = Column(Integer)
    description = Column(Text)
    exe_path = Column(Text)
    last_start_time = Column(DateTime(timezone=True))
    last_start_duration_ms = Column(Integer)
    monitored = Column(Boolean, default=False)
    last_updated = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())

    agent = relationship("Agent", back_populates="services")


class SSLCertificate(Base):
    __tablename__ = "ssl_certificates"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(255), nullable=False)
    common_name = Column(String(255))
    san_names = Column(JSON, default=list)
    organization = Column(String(255))
    org_unit = Column(String(255))
    country = Column(String(2))
    state = Column(String(100))
    city = Column(String(100))
    email = Column(String(255))
    key_type = Column(String(20), default="RSA")
    key_size = Column(Integer, default=2048)
    csr_path = Column(Text)
    cert_path = Column(Text)
    key_path = Column(Text)
    issued_by = Column(String(255))
    valid_from = Column(DateTime(timezone=True))
    valid_until = Column(DateTime(timezone=True))
    status = Column(String(30), default="csr_pending")
    used_for = Column(String(50), default="platform")
    renewed_from_id = Column(UUID(as_uuid=True), ForeignKey("ssl_certificates.id", ondelete="SET NULL"), nullable=True)
    # Let's Encrypt / ACME fields
    provider = Column(String(30), default="manual")   # manual, letsencrypt
    auto_renew = Column(Boolean, default=False)
    le_email = Column(String(255))                     # email used for LE account
    le_staging = Column(Boolean, default=False)        # whether issued from LE staging
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))


class AlertRule(Base):
    __tablename__ = "alert_rules"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(255), nullable=False)
    description = Column(Text)
    rule_type = Column(String(30), default="metric")   # metric, service, port
    metric_name = Column(String(100))
    condition = Column(String(20))                      # >, >=, <, <=, ==
    threshold = Column(Numeric)
    duration_minutes = Column(Integer, default=5)
    severity = Column(String(20), default="warning")   # info, warning, critical
    applies_to = Column(String(20), default="all")     # all, group, agent
    group_id = Column(UUID(as_uuid=True), nullable=True)
    agent_id = Column(UUID(as_uuid=True), nullable=True)
    notify_channels = Column(JSON, default=list)        # list of notification_channel ids
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Alert(Base):
    __tablename__ = "alerts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    rule_id = Column(UUID(as_uuid=True), ForeignKey("alert_rules.id"), nullable=True)
    agent_id = Column(UUID(as_uuid=True), ForeignKey("agents.id"), nullable=True)
    source = Column(String(30), default="rule")        # rule, port_check, manual
    severity = Column(String(20))
    message = Column(Text)
    metric_value = Column(Numeric)
    triggered_at = Column(DateTime(timezone=True), server_default=func.now())
    acknowledged_at = Column(DateTime(timezone=True))
    resolved_at = Column(DateTime(timezone=True))
    acknowledged_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    status = Column(String(20), default="open")        # open, acknowledged, resolved

    agent = relationship("Agent", back_populates="alerts")
    rule = relationship("AlertRule")


class MonitoredPort(Base):
    __tablename__ = "monitored_ports"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(255), nullable=False)
    host = Column(String(255), nullable=False)
    port = Column(Integer, nullable=False)
    protocol = Column(String(10), default="tcp")
    check_interval_seconds = Column(Integer, default=60)
    timeout_seconds = Column(Integer, default=5)
    is_active = Column(Boolean, default=True)
    last_status = Column(String(20), default="unknown")
    last_checked = Column(DateTime(timezone=True))
    last_latency_ms = Column(Integer)
    consecutive_failures = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class NotificationChannel(Base):
    __tablename__ = "notification_channels"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(100), nullable=False)
    type = Column(String(30), nullable=False)   # smtp, webhook_teams, webhook_slack, webhook_generic
    config = Column(JSON, default=dict)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class AuditLog(Base):
    __tablename__ = "audit_log"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    timestamp = Column(DateTime(timezone=True), server_default=func.now())
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    agent_id = Column(UUID(as_uuid=True), ForeignKey("agents.id"))
    action = Column(String(100), nullable=False)
    resource_type = Column(String(50))
    resource_id = Column(String(100))
    details = Column(JSON, default=dict)
    ip_address = Column(String(45))
    result = Column(String(20), default="success")


class Monitor(Base):
    __tablename__ = "monitors"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(255), nullable=False)
    monitor_type = Column(String(50), nullable=False)   # ping, tcp, http, https, dns, ssl_cert, snmp
    category = Column(String(50), default="network")   # network, web, database, service, mail, middleware, virtualization
    subtype = Column(String(100))                       # apache, mysql, nginx … (display/informational)
    host = Column(String(255))
    port = Column(Integer)
    config = Column(JSON, default=dict)
    check_interval_seconds = Column(Integer, default=60)
    timeout_seconds = Column(Integer, default=10)
    is_active = Column(Boolean, default=True)
    last_status = Column(String(20), default="unknown")
    last_checked = Column(DateTime(timezone=True))
    last_latency_ms = Column(Integer)
    last_message = Column(Text)
    consecutive_failures = Column(Integer, default=0)
    group_id = Column(UUID(as_uuid=True), ForeignKey("agent_groups.id", ondelete="SET NULL"), nullable=True)
    agent_id = Column(UUID(as_uuid=True), ForeignKey("agents.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class SystemSetting(Base):
    __tablename__ = "system_settings"

    key = Column(String(100), primary_key=True)
    value = Column(JSON, default=dict)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())
    updated_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)


class DeploymentJob(Base):
    __tablename__ = "deployment_jobs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    target_host = Column(String(255), nullable=False)
    target_port = Column(Integer, default=22)
    os_type = Column(String(20), nullable=False)    # linux, windows
    username = Column(String(100))
    status = Column(String(20), default="pending")  # pending, running, success, failed
    logs = Column(Text, default="")
    agent_version = Column(String(50))
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    started_at = Column(DateTime(timezone=True))
    finished_at = Column(DateTime(timezone=True))


class ScheduledReport(Base):
    __tablename__ = "scheduled_reports"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(255), nullable=False)
    report_type = Column(String(50), nullable=False)   # agents, monitors
    format = Column(String(10), default="pdf")          # pdf, csv, xlsx
    frequency = Column(String(20), default="daily")     # daily, weekly, monthly
    hour = Column(Integer, default=8)                   # 0-23
    minute = Column(Integer, default=0)                 # 0-59
    day_of_week = Column(Integer, nullable=True)        # 0=Mon … 6=Sun (weekly)
    day_of_month = Column(Integer, nullable=True)       # 1-31 (monthly)
    email_to = Column(JSON, default=list)               # list of email addresses
    channel_ids = Column(JSON, default=list)            # notification channel UUIDs
    status_filter = Column(String(50), default="all")
    is_active = Column(Boolean, default=True)
    last_run = Column(DateTime(timezone=True))
    next_run = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class BackupHistory(Base):
    __tablename__ = "backup_history"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    filename = Column(String(255))
    size_bytes = Column(Integer)
    status = Column(String(20), default="running")   # running, success, failed
    trigger = Column(String(20))                     # manual, scheduled, auto
    error = Column(Text)
    started_at = Column(DateTime(timezone=True), server_default=func.now())
    finished_at = Column(DateTime(timezone=True))


class DeployCredential(Base):
    __tablename__ = "deploy_credentials"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(100), nullable=False)
    description = Column(Text)
    os_type = Column(String(20), default="any")   # linux, windows, any
    username = Column(String(100), nullable=False)
    password = Column(Text)
    ssh_key = Column(Text)
    domain = Column(String(100))
    port = Column(Integer)                         # None = OS default (22 / 445 / 5985)
    use_sudo = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())


class AgentSSHCredentials(Base):
    __tablename__ = "agent_ssh_credentials"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    agent_id = Column(UUID(as_uuid=True), ForeignKey("agents.id", ondelete="CASCADE"), unique=True, nullable=False)
    host_override = Column(Text)
    port = Column(Integer, default=22)
    username = Column(Text, nullable=False)
    password = Column(Text)
    ssh_key = Column(Text)
    use_sudo = Column(Boolean, default=True)
    connect_type = Column(Text, default="linux")   # linux, windows_winrm, windows_smb
    winrm_port = Column(Integer, default=5985)
    domain = Column(Text)
    updated_at = Column(DateTime(timezone=True), server_default=func.now())


class AgentPatch(Base):
    __tablename__ = "agent_patches"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    agent_id = Column(UUID(as_uuid=True), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False)
    package_name = Column(Text, nullable=False)
    current_version = Column(Text)
    available_version = Column(Text)
    category = Column(Text, default="unknown")
    description = Column(Text)
    scanned_at = Column(DateTime(timezone=True), server_default=func.now())


class PatchJob(Base):
    __tablename__ = "patch_jobs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    agent_id = Column(UUID(as_uuid=True), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False)
    job_type = Column(Text, nullable=False, default="scan")   # scan, apply
    packages = Column(JSON, default=list)
    status = Column(Text, default="pending")   # pending, running, success, failed
    output = Column(Text, default="")
    triggered_by = Column(Text, default="manual")
    started_at = Column(DateTime(timezone=True), server_default=func.now())
    finished_at = Column(DateTime(timezone=True))


class ScheduledTask(Base):
    __tablename__ = "scheduled_tasks"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(255), nullable=False)
    task_type = Column(String(50), nullable=False)
    agent_id = Column(UUID(as_uuid=True), ForeignKey("agents.id"))
    group_id = Column(UUID(as_uuid=True), ForeignKey("agent_groups.id"))
    schedule_type = Column(String(20), nullable=False)
    scheduled_at = Column(DateTime(timezone=True))
    cron_expression = Column(String(100))
    payload = Column(JSON, default=dict)
    status = Column(String(30), default="pending")
    last_run = Column(DateTime(timezone=True))
    next_run = Column(DateTime(timezone=True))
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
