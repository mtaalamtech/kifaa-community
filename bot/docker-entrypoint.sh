#!/bin/sh
# Bot container entrypoint — reads Docker secrets and exports as env vars.
set -e

read_secret() {
    local name="$1"
    local file="/run/secrets/${name}"
    if [ -f "$file" ]; then
        cat "$file"
    fi
}

VAL=$(read_secret telegram_token)
[ -n "$VAL" ] && export TELEGRAM_TOKEN="$VAL"

VAL=$(read_secret bot_secret)
[ -n "$VAL" ] && export BOT_SECRET="$VAL"

VAL=$(read_secret teams_hmac_secret)
[ -n "$VAL" ] && export TEAMS_HMAC_SECRET="$VAL"

exec "$@"
