from pydantic import BaseModel, EmailStr, Field
from typing import Optional, List, Any, Dict
from datetime import datetime
import uuid


# ─── Auth ────────────────────────────────────
class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: dict


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=50)
    email: EmailStr
    full_name: Optional[str] = None
    password: str = Field(min_length=8)
    role: str = "viewer"


class UserResponse(BaseModel):
    id: uuid.UUID
    username: str
    email: str
    full_name: Optional[str]
    role: str
    is_active: bool
    created_at: datetime

    class Config:
        from_attributes = True


# ─── Agent Registration ───────────────────────
class AgentRegisterRequest(BaseModel):
    registration_secret: str
    hostname: str
    ip_address: Optional[str] = None
    mac_address: Optional[str] = None
    os_type: str
    os_name: str
    os_version: str
    os_arch: str
    agent_version: str
    agent_type: str = "modern"
    metadata: Optional[Dict[str, Any]] = {}


class AgentRegisterResponse(BaseModel):
    agent_id: str
    api_key: str
    message: str
    server_time: datetime


# ─── Agent Heartbeat ─────────────────────────
class MetricPoint(BaseModel):
    name: str
    value: float
    tags: Optional[Dict[str, Any]] = {}


class ServiceInfo(BaseModel):
    service_name: str
    display_name: Optional[str] = None
    status: str
    startup_type: Optional[str] = None
    pid: Optional[int] = None
    exe_path: Optional[str] = None


class HeartbeatRequest(BaseModel):
    timestamp: Optional[datetime] = None
    metrics: List[MetricPoint] = []
    services: Optional[List[ServiceInfo]] = []
    ip_address: Optional[str] = None
    agent_version: Optional[str] = None
    restart_pending: Optional[bool] = False
    os_name: Optional[str] = None
    os_version: Optional[str] = None
    hostname: Optional[str] = None


class HeartbeatResponse(BaseModel):
    status: str
    server_time: datetime
    pending_commands: List[Dict] = []


# ─── Inventory ───────────────────────────────
class HardwareData(BaseModel):
    cpu_model: Optional[str] = None
    cpu_cores: Optional[int] = None
    cpu_threads: Optional[int] = None
    ram_total_gb: Optional[float] = None
    disks: List[Dict] = []
    nics: List[Dict] = []
    dns_servers: List[str] = []
    default_gateway: Optional[str] = None
    gpu: List[Dict] = []
    bios_vendor: Optional[str] = None
    bios_version: Optional[str] = None
    bios_date: Optional[str] = None
    motherboard_vendor: Optional[str] = None
    motherboard_model: Optional[str] = None
    serial_number: Optional[str] = None
    asset_tag: Optional[str] = None


class SoftwareItem(BaseModel):
    name: str
    version: Optional[str] = None
    publisher: Optional[str] = None
    install_date: Optional[str] = None
    install_location: Optional[str] = None
    size_mb: Optional[float] = None


class InventoryReport(BaseModel):
    hardware: Optional[HardwareData] = None
    software: Optional[List[SoftwareItem]] = []


# ─── Agent Response ──────────────────────────
class AgentResponse(BaseModel):
    id: uuid.UUID
    hostname: str
    display_name: Optional[str]
    ip_address: Optional[str]
    os_type: Optional[str]
    os_name: Optional[str]
    os_version: Optional[str]
    os_arch: Optional[str]
    agent_version: Optional[str]
    agent_type: str
    status: str
    last_seen: Optional[datetime]
    registered_at: datetime
    tags: Optional[List] = []
    group_id: Optional[uuid.UUID] = None
    group_name: Optional[str] = None
    group_color: Optional[str] = None
    asset_type: Optional[str] = None
    description: Optional[str] = None
    restart_pending: Optional[bool] = False
    exclude_from_reports: Optional[bool] = False

    class Config:
        from_attributes = True


class AgentDetailResponse(AgentResponse):
    hardware: Optional[Dict] = None
    software_count: int = 0
    service_count: int = 0

    class Config:
        from_attributes = True


# ─── SSL / CSR ───────────────────────────────
class CSRCreateRequest(BaseModel):
    name: str
    common_name: str
    san_names: List[str] = []
    organization: Optional[str] = None
    org_unit: Optional[str] = None
    country: str = "KE"
    state: Optional[str] = None
    city: Optional[str] = None
    email: Optional[str] = None
    key_type: str = "RSA"
    key_size: int = 2048
    used_for: str = "platform"


class CSRResponse(BaseModel):
    id: uuid.UUID
    name: str
    common_name: str
    status: str
    csr_content: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


# ─── Groups ──────────────────────────────────
class GroupCreate(BaseModel):
    name: str
    description: Optional[str] = None
    color: str = "#3B82F6"


class GroupResponse(BaseModel):
    id: uuid.UUID
    name: str
    description: Optional[str]
    color: str
    agent_count: int = 0

    class Config:
        from_attributes = True


# ─── Dashboard Stats ──────────────────────────
class DashboardStats(BaseModel):
    total_agents: int
    online_agents: int
    offline_agents: int
    warning_agents: int
    total_alerts: int
    open_alerts: int
    critical_alerts: int
    windows_agents: int = 0
    linux_agents: int = 0
    version_breakdown: list = []
