from pydantic_settings import BaseSettings
from functools import lru_cache


class BotSettings(BaseSettings):
    # Kifaa API (internal Docker network)
    kifaa_api_url: str = "http://api:8000"
    bot_secret: str = ""

    # Telegram
    telegram_token: str = ""

    # WhatsApp bridge (internal)
    whatsapp_bridge_url: str = "http://kifaa-whatsapp:3000"
    whatsapp_bridge_secret: str = ""

    # Teams
    teams_hmac_secret: str = ""

    # Redis (DB 3 — isolated from API and Celery)
    redis_url: str = "redis://redis:6379/3"

    # Session TTL (seconds)
    session_ttl: int = 14400  # 4 hours
    # Confirmation window (seconds)
    confirm_ttl: int = 60
    # Rate limit (commands per minute per user)
    rate_limit: int = 5
    # Max failed PIN attempts before lockout
    pin_fail_limit: int = 5
    pin_fail_window: int = 600  # 10 minutes

    class Config:
        env_file = ".env"
        case_sensitive = False


@lru_cache()
def get_settings() -> BotSettings:
    return BotSettings()
