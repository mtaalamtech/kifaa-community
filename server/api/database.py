import os
from urllib.parse import quote_plus
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from api.config import get_settings

settings = get_settings()

# Build URL with safe password encoding to handle special characters
_password = quote_plus(os.getenv("POSTGRES_PASSWORD", ""))
_user = os.getenv("POSTGRES_USER", "kifaa")
_host = os.getenv("POSTGRES_HOST", "timescaledb")
_port = os.getenv("POSTGRES_PORT", "5432")
_db = os.getenv("POSTGRES_DB", "kifaa")
_database_url = f"postgresql+asyncpg://{_user}:{_password}@{_host}:{_port}/{_db}"

engine = create_async_engine(
    _database_url,
    pool_size=20,
    max_overflow=40,
    pool_pre_ping=True,
    echo=False,
)

AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()
