"""Telegram bot using python-telegram-bot polling with inline keyboard menu."""
import asyncio
import logging

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, BotCommand
from telegram.ext import (
    Application, MessageHandler, CommandHandler,
    CallbackQueryHandler, filters, ContextTypes,
)

from app import commands
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

_app: Application = None

# ── Main menu keyboard ────────────────────────────────────────────────────────
MAIN_MENU = InlineKeyboardMarkup([
    [
        InlineKeyboardButton("📡 Agents",      callback_data="cmd:agents"),
        InlineKeyboardButton("🚨 Alerts",      callback_data="cmd:alerts"),
    ],
    [
        InlineKeyboardButton("✅ Compliance",   callback_data="cmd:compliance"),
        InlineKeyboardButton("🩹 Patch Status", callback_data="cmd:patchstatus"),
    ],
    [
        InlineKeyboardButton("🔐 AD Unlock",    callback_data="guide:unlock"),
        InlineKeyboardButton("🔑 Reset PW",     callback_data="guide:resetpassword"),
    ],
    [
        InlineKeyboardButton("⚡ Patch Scan",   callback_data="guide:patchscan"),
        InlineKeyboardButton("🔄 Restart",      callback_data="guide:restart"),
    ],
    [
        InlineKeyboardButton("❓ Help",         callback_data="cmd:help"),
    ],
])

GUIDE = {
    "unlock":         "To unlock an AD account:\n  unlock <agent_name> <ad_username>\n\nExample:\n  unlock DC01 jsmith",
    "resetpassword":  "To reset an AD password:\n  resetpassword <agent_name> <ad_username>\n\nExample:\n  resetpassword DC01 jsmith\n\nA temporary password will be generated and the user must change it on next login.",
    "patchscan":      "To trigger a patch scan:\n  patchscan <agent_name>\n\nExample:\n  patchscan WORKSTATION01",
    "restart":        "To restart an endpoint:\n  restart <agent_name>\n\nExample:\n  restart WORKSTATION01\n\nYou will need to confirm with CONFIRM.",
}


def get_telegram_app() -> Application:
    global _app
    if _app is None and settings.telegram_token:
        _app = Application.builder().token(settings.telegram_token).build()
        _app.add_handler(CommandHandler("start", _handle_start))
        _app.add_handler(CommandHandler("menu",  _handle_start))
        _app.add_handler(CallbackQueryHandler(_handle_callback))
        _app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, _handle_message))
        _app.add_handler(MessageHandler(filters.COMMAND, _handle_message))
    return _app


async def _handle_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    welcome = (
        f"👋 Welcome to Kifaa Bot{', ' + user.first_name if user and user.first_name else ''}!\n\n"
        "I'm your IT security management assistant. I can help you:\n"
        "• Monitor agents and alerts\n"
        "• Check compliance and patch status\n"
        "• Unlock AD accounts & reset passwords\n"
        "• Restart endpoints and control services\n\n"
        "🔐 First, authenticate with your PIN:\n"
        "  auth <YOUR_PIN>\n\n"
        "Then use the menu below or type any command."
    )
    await update.message.reply_text(welcome, reply_markup=MAIN_MENU)


async def _handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    data = query.data or ""
    user = update.effective_user
    platform_id = str(user.id)

    if data.startswith("cmd:"):
        cmd_text = data[4:]
        try:
            reply = await commands.process("telegram", platform_id, cmd_text)
        except Exception as e:
            logger.error(f"Telegram callback command error: {e}")
            reply = "An error occurred. Please try again."
        # For info commands, show menu again; for others just reply
        if cmd_text in ("agents", "alerts", "compliance", "patchstatus", "help"):
            await query.message.reply_text(reply, reply_markup=MAIN_MENU)
        else:
            await query.message.reply_text(reply)

    elif data.startswith("guide:"):
        key = data[6:]
        guide_text = GUIDE.get(key, "Use 'help' to see all commands.")
        await query.message.reply_text(guide_text, reply_markup=MAIN_MENU)

    elif data == "menu":
        await query.message.reply_text("Main menu:", reply_markup=MAIN_MENU)


async def _handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.message or not update.message.text:
        return
    user = update.effective_user
    platform_id = str(user.id)
    text = update.message.text

    try:
        reply = await commands.process("telegram", platform_id, text)
    except Exception as e:
        logger.error(f"Telegram command error: {e}")
        reply = "An error occurred. Please try again."

    # Show the menu after certain commands for easy navigation
    show_menu_after = {"help", "menu", "agents", "alerts", "compliance", "patchstatus",
                       "auth", "logout"}
    cmd_word = text.lstrip("/").split()[0].lower() if text.strip() else ""
    if cmd_word in show_menu_after:
        await update.message.reply_text(reply, reply_markup=MAIN_MENU)
    else:
        await update.message.reply_text(reply)


async def start_polling():
    app = get_telegram_app()
    if app is None:
        logger.info("TELEGRAM_TOKEN not configured — Telegram bot disabled")
        return

    # Set bot commands for the Telegram command picker
    try:
        await app.bot.set_my_commands([
            BotCommand("start",  "Show welcome message and menu"),
            BotCommand("menu",   "Show main menu"),
            BotCommand("help",   "List all commands"),
            BotCommand("agents", "List online agents"),
            BotCommand("alerts", "Show active alerts"),
            BotCommand("compliance", "Compliance score summary"),
            BotCommand("patchstatus", "Patch compliance summary"),
            BotCommand("logout", "End your session"),
        ])
    except Exception as e:
        logger.warning(f"Could not set bot commands: {e}")

    retry_delay = 5
    while True:
        try:
            logger.info("Starting Telegram bot polling...")
            await app.initialize()
            await app.start()
            await app.updater.start_polling(drop_pending_updates=True)
            logger.info("Telegram bot polling started")
            # Keep running until cancelled
            while True:
                await asyncio.sleep(30)
        except asyncio.CancelledError:
            logger.info("Telegram polling cancelled")
            break
        except Exception as e:
            logger.error(f"Telegram polling error: {e}. Retrying in {retry_delay}s...")
            try:
                await app.updater.stop()
            except Exception:
                pass
            try:
                await app.stop()
            except Exception:
                pass
            try:
                await app.shutdown()
            except Exception:
                pass
            global _app
            _app = None
            get_telegram_app()
            app = _app
            await asyncio.sleep(retry_delay)
            retry_delay = min(retry_delay * 2, 60)


async def stop_polling():
    app = get_telegram_app()
    if app and app.updater:
        try:
            await app.updater.stop()
            await app.stop()
            await app.shutdown()
        except Exception:
            pass
