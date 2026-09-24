from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        secrets_dir="/run/secrets",   # Docker secrets mounted here (TASK-23)
        case_sensitive=False,
        extra="ignore",
    )

    # App
    app_name: str = "Kifaa Platform"
    app_version: str = "1.0.0"
    debug: bool = False

    # Database components (password read from secret file)
    postgres_user: str = "kifaa"
    postgres_password: str = ""          # from /run/secrets/postgres_password
    postgres_db: str = "kifaa"
    postgres_host: str = "timescaledb"
    postgres_port: int = 5432

    # Computed database URLs — built at property access so password is never an env var
    @property
    def database_url(self) -> str:
        return (
            f"postgresql+asyncpg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def sync_database_url(self) -> str:
        return (
            f"postgresql://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    # Redis
    redis_url: str = "redis://redis:6379/0"
    celery_broker_url: str = "redis://redis:6379/1"
    celery_result_backend: str = "redis://redis:6379/2"

    # Security (from /run/secrets/)
    api_secret_key: str = ""
    api_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60
    agent_registration_secret: str = ""

    # Domain
    domain: str = "kifaa.kenyanut.com"
    server_ip: str = "192.168.0.7"
    server_base_url: str = "https://kifaa.kenyanut.com"

    # Credential encryption (from /run/secrets/)
    fernet_key: str = ""

    # External syslog (optional — leave empty to disable)
    syslog_host: str = ""
    syslog_port: int = 514

    # Messaging bot (from /run/secrets/)
    bot_secret: str = ""
    telegram_token: str = ""
    teams_hmac_secret: str = ""
    whatsapp_bridge_secret: str = ""
    wa_admin_token: str = ""


@lru_cache()
def get_settings() -> Settings:
    return Settings()
