.PHONY: help up down restart logs ps build pull update backup shell-api shell-db clean reset

# ─────────────────────────────────────────────────────────────────────────────
# Kifaa — Makefile helpers
# Usage: make <target>
# ─────────────────────────────────────────────────────────────────────────────

help:
	@echo ""
	@echo "  Kifaa Community Edition"
	@echo ""
	@echo "  make up          Start all services"
	@echo "  make down        Stop all services"
	@echo "  make restart     Restart all services"
	@echo "  make logs        Follow logs (all services)"
	@echo "  make ps          Show running containers"
	@echo "  make build       Rebuild images (no cache)"
	@echo "  make pull        Pull latest base images"
	@echo "  make update      Pull + rebuild + restart"
	@echo "  make backup      Run a manual database backup now"
	@echo "  make shell-api   Open a shell in the API container"
	@echo "  make shell-db    Open psql in the database container"
	@echo "  make clean       Remove stopped containers and dangling images"
	@echo "  make reset       DANGER: wipe all data and start fresh"
	@echo ""

up:
	docker compose up -d

down:
	docker compose down

restart:
	docker compose restart

logs:
	docker compose logs -f

ps:
	docker compose ps

build:
	docker compose build --no-cache

pull:
	docker compose pull --ignore-buildable

update: pull
	docker compose build --no-cache
	docker compose up -d
	@echo "Update complete. Run 'make logs' to verify."

backup:
	docker compose exec api python -c "from api.workers.tasks import run_database_backup; run_database_backup('manual')"

shell-api:
	docker compose exec api bash

shell-db:
	@DB_USER=$$(grep POSTGRES_USER .env | cut -d= -f2); \
	DB_NAME=$$(grep POSTGRES_DB .env | cut -d= -f2); \
	docker compose exec timescaledb psql -U $${DB_USER:-kifaa} -d $${DB_NAME:-kifaa}

clean:
	docker compose down --remove-orphans
	docker image prune -f

reset:
	@echo "WARNING: This will delete ALL data including the database."
	@read -p "Type 'yes' to confirm: " confirm; \
	[ "$$confirm" = "yes" ] || (echo "Aborted." && exit 1)
	docker compose down -v --remove-orphans
	rm -rf data/postgres data/redis data/backups data/logs
	@echo "Data wiped. Run 'make up' to start fresh."
