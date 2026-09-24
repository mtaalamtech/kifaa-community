"""
Kifaa Bot Service — FastAPI app handling Teams webhook + WhatsApp inbound.
Telegram runs as a background polling task alongside uvicorn.
"""
import asyncio
import logging
import uvicorn
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from app.platforms.teams import router as teams_router
from app.platforms.whatsapp import router as whatsapp_router
from app.platforms import telegram as tg
from app.platforms.whatsapp import send_whatsapp
from app.config import get_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Start Telegram polling in background
    tg_task = asyncio.create_task(tg.start_polling())
    logger.info("Kifaa Bot Service starting")
    yield
    logger.info("Kifaa Bot Service shutting down")
    await tg.stop_polling()
    tg_task.cancel()


app = FastAPI(title="Kifaa Bot Service", lifespan=lifespan)
app.include_router(teams_router)
app.include_router(whatsapp_router)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/send")
async def send_message(body: dict):
    """
    Send a message to a user on any platform.
    Called from kifaa-api with X-Bot-Secret.
    Body: { platform, platform_id, message }
    """
    cfg = get_settings()
    secret = body.get("bot_secret", "")
    if cfg.bot_secret and secret != cfg.bot_secret:
        raise HTTPException(status_code=403, detail="Invalid bot secret")

    platform = body.get("platform", "")
    platform_id = str(body.get("platform_id", ""))
    message = body.get("message", "").strip()

    if not platform or not platform_id or not message:
        raise HTTPException(status_code=400, detail="platform, platform_id and message are required")

    if platform == "telegram":
        tg_app = tg.get_telegram_app()
        if not tg_app:
            raise HTTPException(status_code=503, detail="Telegram bot not configured")
        try:
            await tg_app.bot.send_message(chat_id=int(platform_id), text=message)
            return {"status": "sent"}
        except Exception as e:
            err = str(e)
            if "Chat not found" in err or "chat not found" in err or "400" in err:
                raise HTTPException(
                    status_code=502,
                    detail="Chat not found — the user must send any message to the Telegram bot first before you can message them. Ask them to open the bot and send /start."
                )
            raise HTTPException(status_code=502, detail=f"Telegram send failed: {e}")

    elif platform == "whatsapp":
        try:
            await send_whatsapp(platform_id, message)
            return {"status": "sent"}
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"WhatsApp send failed: {e}")

    elif platform == "teams":
        raise HTTPException(
            status_code=400,
            detail="Teams Outgoing Webhooks do not support proactive messages. "
                   "The bot can only reply to messages sent in the channel."
        )

    raise HTTPException(status_code=400, detail=f"Unknown platform: {platform}")


if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=8001, log_level="info")
