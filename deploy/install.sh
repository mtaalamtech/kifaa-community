#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Kifaa Community Edition — One-line installer
# Usage: curl -fsSL https://raw.githubusercontent.com/kenyanut/kifaa/main/install.sh | bash
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()    { echo -e "${BLUE}[kifaa]${NC} $*"; }
success() { echo -e "${GREEN}[kifaa]${NC} $*"; }
warn()    { echo -e "${YELLOW}[kifaa]${NC} $*"; }
error()   { echo -e "${RED}[kifaa]${NC} $*" >&2; exit 1; }

INSTALL_DIR="${KIFAA_DIR:-/opt/kifaa}"
REPO_URL="https://github.com/kenyanut/kifaa.git"
BRANCH="${KIFAA_BRANCH:-main}"

# ── Checks ────────────────────────────────────────────────────────────────────

[[ $EUID -eq 0 ]] || error "This script must be run as root (use sudo)"

info "Checking prerequisites..."

command -v docker   &>/dev/null || error "Docker is not installed. Install Docker Engine 24+ first: https://docs.docker.com/engine/install/"
command -v git      &>/dev/null || error "git is not installed. Run: apt-get install -y git"

DOCKER_COMPOSE_VERSION=$(docker compose version --short 2>/dev/null || echo "")
[[ -n "$DOCKER_COMPOSE_VERSION" ]] || error "Docker Compose v2 is not installed. Update Docker Engine or install the plugin."

TOTAL_RAM=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
[[ $TOTAL_RAM -ge 1800 ]] || warn "Less than 2GB RAM detected. Kifaa recommends at least 2GB."

DISK_FREE=$(df -BG "$INSTALL_DIR" 2>/dev/null | awk 'NR==2 {gsub("G",""); print $4}' || df -BG / | awk 'NR==2 {gsub("G",""); print $4}')
[[ $DISK_FREE -ge 10 ]] || warn "Less than 10GB free disk space. Kifaa recommends at least 20GB."

success "Prerequisites OK (Docker $(docker --version | awk '{print $3}' | tr -d ','), Compose $DOCKER_COMPOSE_VERSION)"

# ── Clone ─────────────────────────────────────────────────────────────────────

if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "Existing installation found at $INSTALL_DIR — pulling latest..."
    git -C "$INSTALL_DIR" pull --ff-only
else
    info "Cloning Kifaa into $INSTALL_DIR..."
    git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# ── Environment ───────────────────────────────────────────────────────────────

if [[ ! -f .env ]]; then
    info "Creating .env from template..."
    cp .env.example .env

    # Auto-detect server IP
    SERVER_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}' || hostname -I | awk '{print $1}')
    sed -i "s/^SERVER_IP=.*/SERVER_IP=${SERVER_IP}/" .env

    # Generate random secrets
    SECRET_KEY=$(openssl rand -hex 32)
    AGENT_KEY=$(openssl rand -hex 20)
    DB_PASS=$(openssl rand -hex 24)
    FERNET_KEY=$(python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())" 2>/dev/null || openssl rand -base64 32)

    sed -i "s/^SECRET_KEY=.*/SECRET_KEY=${SECRET_KEY}/" .env
    sed -i "s/^AGENT_REGISTRATION_KEY=.*/AGENT_REGISTRATION_KEY=${AGENT_KEY}/" .env
    sed -i "s/^DB_PASSWORD=.*/DB_PASSWORD=${DB_PASS}/" .env
    sed -i "s/^FERNET_KEY=.*/FERNET_KEY=${FERNET_KEY}/" .env

    success ".env created with auto-generated secrets"
else
    warn ".env already exists — skipping (delete it to regenerate secrets)"
fi

# ── Data directories ──────────────────────────────────────────────────────────

mkdir -p data/{postgres,redis,backups,logs}
chmod 700 data/postgres

# ── SSL placeholder (self-signed for first run) ────────────────────────────────

if [[ ! -f ssl/certs/kifaa.crt ]]; then
    mkdir -p ssl/certs ssl/private
    SERVER_IP_OR_DOMAIN=$(grep '^SERVER_IP=' .env | cut -d= -f2)
    info "Generating self-signed certificate for $SERVER_IP_OR_DOMAIN..."
    openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
        -keyout ssl/private/kifaa.key \
        -out ssl/certs/kifaa.crt \
        -subj "/CN=${SERVER_IP_OR_DOMAIN}/O=Kifaa/C=KE" \
        -addext "subjectAltName=IP:${SERVER_IP_OR_DOMAIN},DNS:${SERVER_IP_OR_DOMAIN}" \
        2>/dev/null
    success "Self-signed certificate generated (replace with a real cert for production)"
fi

# ── Agent builds directory ────────────────────────────────────────────────────

mkdir -p agent/builds
info "Agent binaries will be placed in agent/builds/ after you build the agent."
info "See: https://github.com/kenyanut/kifaa/blob/main/docs/agent-deployment.md"

# ── Pull images & build ───────────────────────────────────────────────────────

info "Building and starting Kifaa (this takes 2-4 minutes on first run)..."
docker compose pull --ignore-buildable 2>/dev/null || true
docker compose build --no-cache
docker compose up -d

# ── Wait for API to be ready ─────────────────────────────────────────────────

info "Waiting for API to start..."
for i in $(seq 1 30); do
    if curl -sf http://localhost:8000/health &>/dev/null; then
        break
    fi
    sleep 4
done

# ── Done ─────────────────────────────────────────────────────────────────────

SERVER_IP_DISPLAY=$(grep '^SERVER_IP=' .env | cut -d= -f2)

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Kifaa is running!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  UI:      ${BLUE}https://${SERVER_IP_DISPLAY}${NC}"
echo -e "  Credentials: Check container logs for the initial admin password:"
echo -e "           ${YELLOW}docker compose logs api | grep 'initial password'${NC}"
echo ""
echo -e "  Agent registration key: ${YELLOW}$(grep '^AGENT_REGISTRATION_KEY=' .env | cut -d= -f2)${NC}"
echo ""
echo -e "  To deploy agents:"
echo -e "    Windows: see ${BLUE}https://github.com/kenyanut/kifaa/blob/main/docs/agent-deployment.md${NC}"
echo -e "    Linux:   curl -fsSL http://${SERVER_IP_DISPLAY}/downloads/kifaa-agent-linux-amd64 | sudo bash -s -- --server http://${SERVER_IP_DISPLAY} --key YOUR_KEY"
echo ""
echo -e "  To view logs:  ${YELLOW}docker compose logs -f${NC}"
echo -e "  To stop:       ${YELLOW}docker compose down${NC}"
echo ""
