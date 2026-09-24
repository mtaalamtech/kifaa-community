"""Microsoft Teams Outgoing Webhook handler."""
import logging

from fastapi import APIRouter, Request, Response, HTTPException

from app import commands
from app.security import verify_teams_hmac

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/webhook/teams")
async def teams_webhook(request: Request):
    body_bytes = await request.body()

    # Verify HMAC signature from Teams
    auth_header = request.headers.get("Authorization", "")
    if not verify_teams_hmac(body_bytes, auth_header):
        raise HTTPException(status_code=401, detail="Invalid HMAC signature")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    # Extract user identity and message text
    sender = body.get("from", {})
    # Use stable aadObjectId as platform_id, fall back to email
    platform_id = sender.get("aadObjectId") or sender.get("email") or sender.get("name", "unknown")
    text = body.get("text", "")

    if not text.strip():
        return {"type": "message", "text": "Send 'help' for a list of commands."}

    try:
        reply = await commands.process("teams", platform_id, text)
    except Exception as e:
        logger.error(f"Teams command error: {e}")
        reply = "An error occurred. Please try again."

    # Teams expects {"type": "message", "text": "..."}
    return {"type": "message", "text": reply}
