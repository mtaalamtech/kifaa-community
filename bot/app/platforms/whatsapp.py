"""WhatsApp inbound webhook — receives messages from kifaa-whatsapp bridge."""
import logging

from fastapi import APIRouter, Request, HTTPException, Header

from app import commands
from app.config import get_settings
import httpx

logger = logging.getLogger(__name__)
router = APIRouter()
settings = get_settings()


def _verify_bridge_token(authorization: str):
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    token = authorization[7:]
    expected = settings.whatsapp_bridge_secret
    if expected and token != expected:
        raise HTTPException(status_code=401, detail="Invalid bridge secret")


async def send_whatsapp(to: str, message: str):
    """Send a WhatsApp message via the bridge service."""
    if not to.endswith("@c.us"):
        to = f"{to}@c.us"
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.post(
                f"{settings.whatsapp_bridge_url}/send",
                json={"to": to, "message": message},
                headers={"Authorization": f"Bearer {settings.whatsapp_bridge_secret}"},
            )
            r.raise_for_status()
    except Exception as e:
        logger.error(f"WhatsApp send error to {to}: {e}")


@router.post("/webhook/whatsapp")
async def whatsapp_inbound(request: Request, authorization: str = Header(...)):
    _verify_bridge_token(authorization)

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    from_id = body.get("from", "")
    text = body.get("body", "")

    if not from_id or not text:
        return {"status": "ignored"}

    # Normalize: strip @c.us, get digits only
    platform_id = "".join(c for c in from_id.split("@")[0] if c.isdigit())

    try:
        reply = await commands.process("whatsapp", platform_id, text)
    except Exception as e:
        logger.error(f"WhatsApp command error: {e}")
        reply = "An error occurred. Please try again."

    # Send reply back via bridge
    await send_whatsapp(platform_id, reply)
    return {"status": "ok"}
