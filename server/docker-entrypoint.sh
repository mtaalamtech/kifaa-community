#!/bin/sh
# Kifaa container entrypoint — reads Docker secrets from /run/secrets/ and
# exports DATABASE_URL / SYNC_DATABASE_URL so Celery tasks can use os.getenv().
# Secrets are read from files so they never appear in `docker inspect` env vars.

set -e

# Read a secret from /run/secrets/<name>, falling back to an env var of the same name.
read_secret() {
    local name="$1"
    local file="/run/secrets/${name}"
    if [ -f "$file" ]; then
        cat "$file"
    else
        # Fall back to env var (uppercase)
        eval echo "\$$(echo "$name" | tr '[:lower:]' '[:upper:]')"
    fi
}

# Build database URLs from components + password secret
POSTGRES_PASSWORD_VAL=$(read_secret postgres_password)
if [ -n "$POSTGRES_PASSWORD_VAL" ]; then
    # Export raw password so database.py (which uses os.getenv) can read it.
    # This is set by the entrypoint at runtime — it does NOT appear in `docker inspect`.
    export POSTGRES_PASSWORD="$POSTGRES_PASSWORD_VAL"
    export DATABASE_URL="postgresql+asyncpg://${POSTGRES_USER:-kifaa}:${POSTGRES_PASSWORD_VAL}@${POSTGRES_HOST:-timescaledb}:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-kifaa}"
    export SYNC_DATABASE_URL="postgresql://${POSTGRES_USER:-kifaa}:${POSTGRES_PASSWORD_VAL}@${POSTGRES_HOST:-timescaledb}:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-kifaa}"
fi

exec "$@"
