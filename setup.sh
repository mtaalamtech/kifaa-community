#!/usr/bin/env bash
# =============================================================================
# Kifaa Platform — Fresh Server Setup Script
# =============================================================================
# Usage (on the target server, after copying the project files):
#   sudo bash /opt/kifaa/setup.sh
#
# Or run from the source server via sync-to-server.sh which does both steps.
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[kifaa]${NC} $*"; }
success() { echo -e "${GREEN}[kifaa]${NC} $*"; }
warn()    { echo -e "${YELLOW}[kifaa]${NC} $*"; }
error()   { echo -e "${RED}[kifaa]${NC} $*" >&2; exit 1; }

# ── Configuration — edit these before running ─────────────────────────────────

INSTALL_DIR="/opt/kifaa"
DOMAIN="kifaa.kenyanut.com"
SERVER_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1);exit}}' || hostname -I | awk '{print $1}')

# ── Secrets — copy exactly from the current deployment ────────────────────────
POSTGRES_PASSWORD="KifaaDB2026Secure"
API_SECRET_KEY="858919704c6094afae4d8bbd676acc1ae7bc6d41e6b4329340e79c1e88220b4ee9988c6b0047b2788f7cbc702aabb01fd357e1a75c7b4d036da9d7bd6e96950e"
AGENT_REGISTRATION_SECRET="90f61a1e0796d0489b63af79e7db1673cb4fa09cd5463471eea708c90f93f260"
FERNET_KEY="EKGjKyFx6rTrhxtW9V8mEUUU148ibLD7Jbo1smX0vG4="
BOT_SECRET="44535ebad1950a2b125a64b90bb332614a348922917a3ccab94ba2a5b2fd7e81"
TELEGRAM_TOKEN="8774219957:AAEpxM63h1GvNGB1RWA3cYwJcyJzW1F9X8M"
TEAMS_HMAC_SECRET=""
WHATSAPP_BRIDGE_SECRET=""
WA_ADMIN_TOKEN=""

# ── Admin account ──────────────────────────────────────────────────────────────
ADMIN_USERNAME="admin"
ADMIN_PASSWORD="Kifaa@2026!"

# =============================================================================

[[ $EUID -eq 0 ]] || error "Run as root: sudo ./setup.sh"

info "Detected server IP: $SERVER_IP"

# ── Step 1: System packages ───────────────────────────────────────────────────
info "Updating system packages..."
apt-get update -qq
apt-get install -y -qq \
    curl wget git rsync sshpass \
    ca-certificates gnupg \
    openssl python3 python3-pip \
    net-tools ufw \
    2>/dev/null

# ── Step 2: Docker ────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
    info "Installing Docker Engine..."
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
      https://download.docker.com/linux/ubuntu \
      $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
    success "Docker installed: $(docker --version)"
else
    success "Docker already installed: $(docker --version)"
fi

# ── Step 3: Go 1.22 ──────────────────────────────────────────────────────────
if ! command -v go &>/dev/null; then
    info "Installing Go 1.22..."
    GO_VERSION="1.22.4"
    GO_ARCH="amd64"
    [[ "$(dpkg --print-architecture)" == "arm64" ]] && GO_ARCH="arm64"
    wget -q "https://go.dev/dl/go${GO_VERSION}.linux-${GO_ARCH}.tar.gz" -O /tmp/go.tar.gz
    rm -rf /usr/local/go
    tar -C /usr/local -xzf /tmp/go.tar.gz
    rm /tmp/go.tar.gz
    ln -sf /usr/local/go/bin/go /usr/local/bin/go
    ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
    success "Go installed: $(go version)"
else
    success "Go already installed: $(go version)"
fi

# ── Step 4: Node.js 20 ────────────────────────────────────────────────────────
if ! node --version 2>/dev/null | grep -q "^v2[0-9]"; then
    info "Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - &>/dev/null
    apt-get install -y -qq nodejs
    success "Node installed: $(node --version)"
else
    success "Node already installed: $(node --version)"
fi

# ── Step 5: Verify project files ──────────────────────────────────────────────
[[ -f "$INSTALL_DIR/docker-compose.yml" ]] || \
    error "Project files not found at $INSTALL_DIR. Copy the project first then re-run."

cd "$INSTALL_DIR"

# ── Step 6: Secrets ───────────────────────────────────────────────────────────
info "Writing secrets..."
mkdir -p "$INSTALL_DIR/secrets"
chmod 700 "$INSTALL_DIR/secrets"

write_secret() {
    printf '%s' "$2" > "$INSTALL_DIR/secrets/$1"
    chmod 600 "$INSTALL_DIR/secrets/$1"
}

write_secret postgres_password          "$POSTGRES_PASSWORD"
write_secret api_secret_key             "$API_SECRET_KEY"
write_secret agent_registration_secret  "$AGENT_REGISTRATION_SECRET"
write_secret fernet_key                 "$FERNET_KEY"
write_secret bot_secret                 "$BOT_SECRET"
write_secret telegram_token             "$TELEGRAM_TOKEN"
write_secret teams_hmac_secret          "$TEAMS_HMAC_SECRET"
write_secret whatsapp_bridge_secret     "$WHATSAPP_BRIDGE_SECRET"
write_secret wa_admin_token             "$WA_ADMIN_TOKEN"

success "Secrets written"

# ── Step 7: .env ─────────────────────────────────────────────────────────────
info "Writing .env..."
cat > "$INSTALL_DIR/.env" << ENV
# Kifaa Platform — Non-sensitive configuration
DOMAIN=${DOMAIN}
SERVER_IP=${SERVER_IP}
POSTGRES_DB=kifaa
POSTGRES_USER=kifaa
POSTGRES_HOST=timescaledb
POSTGRES_PORT=5432
REDIS_URL=redis://redis:6379/0
API_ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=480
CELERY_BROKER_URL=redis://redis:6379/1
CELERY_RESULT_BACKEND=redis://redis:6379/2
VITE_API_URL=/api/v1
HTTP_PORT=80
HTTPS_PORT=443
ENV
success ".env written"

# ── Step 8: Data directories ──────────────────────────────────────────────────
info "Creating data directories..."
mkdir -p \
    "$INSTALL_DIR/data/postgres" \
    "$INSTALL_DIR/data/redis" \
    "$INSTALL_DIR/data/backups" \
    "$INSTALL_DIR/data/logs" \
    "$INSTALL_DIR/data/whatsapp" \
    "$INSTALL_DIR/ssl/certs" \
    "$INSTALL_DIR/ssl/private" \
    "$INSTALL_DIR/agent/builds"

# ── Step 9: Self-signed SSL cert ──────────────────────────────────────────────
if [[ ! -f "$INSTALL_DIR/ssl/certs/kifaa.crt" ]]; then
    info "Generating self-signed SSL certificate..."
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
        -keyout "$INSTALL_DIR/ssl/private/kifaa.key" \
        -out    "$INSTALL_DIR/ssl/certs/kifaa.crt" \
        -subj   "/C=KE/ST=Nairobi/L=Nairobi/O=Kifaa/CN=${DOMAIN}" \
        -addext "subjectAltName=DNS:${DOMAIN},IP:${SERVER_IP}" \
        2>/dev/null
    chmod 600 "$INSTALL_DIR/ssl/private/kifaa.key"
    success "SSL certificate created"
fi

# ── Step 10: Update nginx server_name with detected IP ───────────────────────
info "Configuring nginx for $SERVER_IP..."
sed -i "s/server_name kifaa.kenyanut.com [0-9.]* [0-9.]*/server_name kifaa.kenyanut.com ${SERVER_IP}/" \
    "$INSTALL_DIR/nginx/conf.d/kifaa.conf" 2>/dev/null || true

# ── Step 11: Build frontend ────────────────────────────────────────────────────
info "Building frontend..."
cd "$INSTALL_DIR/frontend"
npm install --legacy-peer-deps --silent 2>/dev/null
VITE_API_URL=/api/v1 npm run build
success "Frontend built"

# ── Step 12: Build agent binaries ─────────────────────────────────────────────
info "Building agent binaries..."
cd "$INSTALL_DIR/agent/modern"
export PATH=$PATH:/usr/local/go/bin

GOOS=linux   GOARCH=amd64 go build -o ../builds/kifaa-agent-linux-amd64           ./cmd/kifaa-agent/ && echo "  linux-amd64 OK"  || warn "linux-amd64 failed"
GOOS=linux   GOARCH=arm64 go build -o ../builds/kifaa-agent-linux-arm64           ./cmd/kifaa-agent/ && echo "  linux-arm64 OK"  || warn "linux-arm64 failed"
GOOS=windows GOARCH=amd64 go build -o ../builds/kifaa-agent-windows-amd64.exe     ./cmd/kifaa-agent/ && echo "  win-amd64 OK"    || warn "win-amd64 failed"
GOOS=windows GOARCH=386   go build -o ../builds/kifaa-agent-windows-386.exe       ./cmd/kifaa-agent/ && echo "  win-386 OK"      || warn "win-386 failed"
GOOS=windows GOARCH=amd64 go build -tags noad -o ../builds/kifaa-agent-windows-amd64-legacy.exe ./cmd/kifaa-agent/ && echo "  win-legacy OK" || warn "win-legacy failed"

success "Agent binaries built"

# ── Step 13: Docker build and start ───────────────────────────────────────────
cd "$INSTALL_DIR"
info "Building Docker images..."
docker compose build --parallel 2>&1 | grep -E "^#|Building|built|error|ERROR" | grep -v "^#[0-9]* \[" | head -30 || true

info "Starting services..."
docker compose up -d

info "Waiting for database..."
for i in $(seq 1 40); do
    docker compose exec -T timescaledb pg_isready -U kifaa -d kifaa &>/dev/null && break
    [[ $i -eq 40 ]] && error "Database did not start in time"
    sleep 3
done
success "Database ready"

# ── Step 14: Create admin user ────────────────────────────────────────────────
info "Creating admin user..."

# Generate hash inside Python to avoid shell escaping issues with $ characters
HASH=$(docker compose exec -T api python3 -c \
    "import bcrypt; print(bcrypt.hashpw(b'${ADMIN_PASSWORD}', bcrypt.gensalt(12)).decode())" 2>/dev/null)

# Write SQL to file inside DB container (avoids shell variable interpolation of $ in hash)
docker compose exec -T timescaledb bash -c "cat > /tmp/admin.sql << 'SQLEOF'
INSERT INTO users (username, hashed_password, role, is_active, created_at)
VALUES ('${ADMIN_USERNAME}', '${HASH}', 'admin', true, NOW())
ON CONFLICT (username) DO UPDATE
    SET hashed_password = EXCLUDED.hashed_password,
        role            = EXCLUDED.role,
        is_active       = EXCLUDED.is_active;
SQLEOF
psql -U kifaa -d kifaa -f /tmp/admin.sql"

success "Admin user '${ADMIN_USERNAME}' created"

# ── Step 15: Firewall ─────────────────────────────────────────────────────────
info "Configuring firewall..."
ufw --force enable &>/dev/null || true
ufw allow ssh     &>/dev/null || true
ufw allow 80/tcp  &>/dev/null || true
ufw allow 443/tcp &>/dev/null || true
success "Firewall: SSH, HTTP, HTTPS allowed"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Kifaa Platform setup complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Dashboard:   ${BLUE}http://${SERVER_IP}${NC}"
echo -e "  Username:    ${YELLOW}${ADMIN_USERNAME}${NC}"
echo -e "  Password:    ${YELLOW}${ADMIN_PASSWORD}${NC}"
echo ""
echo -e "  Agent registration secret:"
echo -e "    ${YELLOW}${AGENT_REGISTRATION_SECRET}${NC}"
echo ""
echo -e "  Agent server URL:"
echo -e "    ${YELLOW}http://${SERVER_IP}${NC}"
echo ""
echo -e "  Check services:  ${BLUE}docker compose ps${NC}"
echo -e "  View API logs:   ${BLUE}docker compose logs -f api${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
