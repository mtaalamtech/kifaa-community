#!/usr/bin/env bash
# =============================================================================
#  Kifaa Community Edition — Installer
#  https://github.com/mtaalamtech/kifaa-community
# =============================================================================
#  Usage:
#    git clone https://github.com/mtaalamtech/kifaa-community /opt/kifaa
#    cd /opt/kifaa
#    sudo bash setup.sh
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${BLUE}[kifaa]${NC} $*"; }
success() { echo -e "${GREEN}[✓]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
error()   { echo -e "${RED}[✗] $*${NC}" >&2; exit 1; }
step()    { echo -e "\n${BOLD}${CYAN}── $* ${NC}"; }

# =============================================================================
# Checks
# =============================================================================
[[ $EUID -eq 0 ]] || error "Run as root: sudo bash setup.sh"

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$INSTALL_DIR/docker-compose.yml" ]] || \
    error "Run this script from the kifaa-community directory."

# Detect server IP
SERVER_IP=$(ip route get 1.1.1.1 2>/dev/null \
    | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1);exit}}' \
    || hostname -I | awk '{print $1}')

# =============================================================================
# Banner
# =============================================================================
echo -e ""
echo -e "${BOLD}${CYAN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║       Kifaa Community Edition — Installer             ║${NC}"
echo -e "${BOLD}${CYAN}║       Free for up to 25 agents                        ║${NC}"
echo -e "${BOLD}${CYAN}╚═══════════════════════════════════════════════════════╝${NC}"
echo -e ""
info "Detected server IP: ${YELLOW}${SERVER_IP}${NC}"
echo -e ""

# =============================================================================
# Interactive configuration
# =============================================================================
step "Configuration"

# Domain
read -rp "  Domain name (or press Enter to use IP address): " INPUT_DOMAIN
DOMAIN="${INPUT_DOMAIN:-$SERVER_IP}"
info "Using domain/host: ${YELLOW}${DOMAIN}${NC}"

# Admin credentials
read -rp "  Admin username [admin]: " INPUT_USER
ADMIN_USERNAME="${INPUT_USER:-admin}"

while true; do
    read -rsp "  Admin password (min 8 chars) [auto-generate]: " INPUT_PASS
    echo
    if [[ -z "$INPUT_PASS" ]]; then
        ADMIN_PASSWORD="$(openssl rand -base64 12 | tr -d '/+=')"
        info "Generated admin password: ${YELLOW}${ADMIN_PASSWORD}${NC}"
        break
    elif [[ ${#INPUT_PASS} -lt 8 ]]; then
        warn "Password too short, try again."
    else
        ADMIN_PASSWORD="$INPUT_PASS"
        break
    fi
done

echo ""

# =============================================================================
# Step 1 — System packages
# =============================================================================
step "System packages"
apt-get update -qq
apt-get install -y -qq \
    curl wget git rsync \
    ca-certificates gnupg \
    openssl python3 python3-pip \
    net-tools ufw \
    2>/dev/null
success "System packages ready"

# =============================================================================
# Step 2 — Docker
# =============================================================================
step "Docker Engine"
if ! command -v docker &>/dev/null; then
    info "Installing Docker Engine..."
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu \
$(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq \
        docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
    success "Docker installed: $(docker --version | cut -d' ' -f3 | tr -d ',')"
else
    success "Docker already installed: $(docker --version | cut -d' ' -f3 | tr -d ',')"
fi

# =============================================================================
# Step 3 — Go (for agent builds)
# =============================================================================
step "Go compiler (agent builds)"
if ! command -v go &>/dev/null; then
    GO_VERSION="1.22.4"
    GO_ARCH="amd64"
    [[ "$(dpkg --print-architecture 2>/dev/null || uname -m)" == "arm64" || \
       "$(uname -m)" == "aarch64" ]] && GO_ARCH="arm64"
    info "Installing Go ${GO_VERSION}..."
    wget -q "https://go.dev/dl/go${GO_VERSION}.linux-${GO_ARCH}.tar.gz" -O /tmp/go.tar.gz
    rm -rf /usr/local/go
    tar -C /usr/local -xzf /tmp/go.tar.gz
    rm /tmp/go.tar.gz
    ln -sf /usr/local/go/bin/go    /usr/local/bin/go
    ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
    success "Go installed: $(go version | awk '{print $3}')"
else
    success "Go already installed: $(go version | awk '{print $3}')"
fi
export PATH=$PATH:/usr/local/go/bin

# =============================================================================
# Step 4 — Node.js (for frontend build)
# =============================================================================
step "Node.js (frontend build)"
if ! node --version 2>/dev/null | grep -qE "^v(18|20|22|24)"; then
    info "Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - &>/dev/null
    apt-get install -y -qq nodejs
    success "Node.js installed: $(node --version)"
else
    success "Node.js already installed: $(node --version)"
fi

# =============================================================================
# Step 5 — Generate secrets
# =============================================================================
step "Generating secrets"
mkdir -p "$INSTALL_DIR/secrets"
chmod 700 "$INSTALL_DIR/secrets"

write_secret() {
    local name="$1" value="$2"
    printf '%s' "$value" > "$INSTALL_DIR/secrets/$name"
    chmod 600 "$INSTALL_DIR/secrets/$name"
}

# Only write if not already set (allows re-running setup without rotating secrets)
[[ -f "$INSTALL_DIR/secrets/postgres_password"         ]] || \
    write_secret postgres_password         "$(openssl rand -hex 32)"
[[ -f "$INSTALL_DIR/secrets/api_secret_key"            ]] || \
    write_secret api_secret_key            "$(openssl rand -hex 64)"
[[ -f "$INSTALL_DIR/secrets/agent_registration_secret" ]] || \
    write_secret agent_registration_secret "$(openssl rand -hex 32)"
[[ -f "$INSTALL_DIR/secrets/fernet_key"                ]] || \
    write_secret fernet_key                "$(python3 -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())' 2>/dev/null || openssl rand -base64 32)"

AGENT_REG_SECRET="$(cat "$INSTALL_DIR/secrets/agent_registration_secret")"
success "Secrets generated"

# =============================================================================
# Step 6 — .env file
# =============================================================================
step "Writing .env"
cat > "$INSTALL_DIR/.env" << ENV
# Kifaa Community Edition — configuration
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
METRICS_RETENTION_DAYS=30
ENV
success ".env written"

# =============================================================================
# Step 7 — Data directories
# =============================================================================
step "Data directories"
mkdir -p \
    "$INSTALL_DIR/data/postgres" \
    "$INSTALL_DIR/data/redis" \
    "$INSTALL_DIR/data/backups" \
    "$INSTALL_DIR/data/logs" \
    "$INSTALL_DIR/ssl/certs" \
    "$INSTALL_DIR/ssl/private" \
    "$INSTALL_DIR/agent/builds"
success "Directories created"

# =============================================================================
# Step 8 — TLS certificate
# =============================================================================
step "TLS certificate"
CERT="$INSTALL_DIR/ssl/certs/kifaa.crt"
KEY="$INSTALL_DIR/ssl/private/kifaa.key"

if [[ ! -f "$CERT" ]]; then
    info "Generating self-signed certificate for ${DOMAIN}..."
    SAN="IP:${SERVER_IP}"
    # If domain looks like a real hostname (not an IP), add DNS SAN too
    if [[ "$DOMAIN" =~ [a-zA-Z] ]]; then
        SAN="DNS:${DOMAIN},IP:${SERVER_IP}"
    fi
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
        -keyout "$KEY" -out "$CERT" \
        -subj "/C=KE/ST=Nairobi/O=Kifaa/CN=${DOMAIN}" \
        -addext "subjectAltName=${SAN}" 2>/dev/null
    chmod 600 "$KEY"
    success "Self-signed certificate generated (valid 10 years)"
    info "  To use Let's Encrypt, run: docker compose exec api python3 -m api.routers.ssl"
else
    success "Certificate already exists — skipping"
fi

# =============================================================================
# Step 9 — Nginx config
# =============================================================================
step "Nginx configuration"
NGINX_CONF="$INSTALL_DIR/nginx/conf.d/kifaa.conf"
if [[ -f "$NGINX_CONF" ]]; then
    # Replace any existing server_name line
    sed -i "s|server_name .*|server_name ${DOMAIN} ${SERVER_IP};|g" "$NGINX_CONF" 2>/dev/null || true
    success "Nginx configured for ${DOMAIN} / ${SERVER_IP}"
fi

# =============================================================================
# Step 10 — Frontend build
# =============================================================================
step "Frontend build"
cd "$INSTALL_DIR/frontend"
npm install --legacy-peer-deps --silent 2>/dev/null
VITE_API_URL=/api/v1 npm run build
success "Frontend built"

# =============================================================================
# Step 11 — Agent binaries
# =============================================================================
step "Agent binaries"
cd "$INSTALL_DIR/agent/modern"

build_agent() {
    local os="$1" arch="$2" out="$3"
    GOOS="$os" GOARCH="$arch" go build -o "$INSTALL_DIR/agent/builds/$out" \
        ./cmd/kifaa-agent/ 2>/dev/null \
        && echo "  $(printf '%-30s' "$out") OK" \
        || warn "$out — build failed (skipping)"
}

build_agent linux   amd64 kifaa-agent-linux-amd64
build_agent linux   arm64 kifaa-agent-linux-arm64
build_agent windows amd64 kifaa-agent-windows-amd64.exe
build_agent windows 386   kifaa-agent-windows-386.exe

success "Agent binaries built"

# =============================================================================
# Step 12 — Docker: build and start
# =============================================================================
step "Docker: build & start"
cd "$INSTALL_DIR"

info "Building images (this may take a few minutes)..."
docker compose build --parallel 2>&1 \
    | grep -E "(ERROR|error|Built|built)" | head -20 || true

info "Starting services..."
docker compose up -d

# Wait for DB
info "Waiting for database to be ready..."
for i in $(seq 1 40); do
    docker compose exec -T timescaledb \
        pg_isready -U kifaa -d kifaa &>/dev/null && break
    [[ $i -eq 40 ]] && error "Database did not start after 120 s. Check: docker compose logs timescaledb"
    sleep 3
done
success "Database ready"

# =============================================================================
# Step 13 — Admin user
# =============================================================================
step "Admin user"

HASH=$(docker compose exec -T api python3 -c \
    "import bcrypt; print(bcrypt.hashpw(b'${ADMIN_PASSWORD}', bcrypt.gensalt(12)).decode())" \
    2>/dev/null)

docker compose exec -T timescaledb bash -c "cat > /tmp/kifaa_admin.sql << 'SQLEOF'
INSERT INTO users (username, hashed_password, role, is_active, created_at)
VALUES ('${ADMIN_USERNAME}', '${HASH}', 'admin', true, NOW())
ON CONFLICT (username) DO UPDATE
    SET hashed_password = EXCLUDED.hashed_password,
        role            = EXCLUDED.role,
        is_active       = EXCLUDED.is_active;
SQLEOF
psql -U kifaa -d kifaa -f /tmp/kifaa_admin.sql -q"

success "Admin user '${ADMIN_USERNAME}' created"

# =============================================================================
# Step 14 — Firewall
# =============================================================================
step "Firewall (ufw)"
ufw --force enable  &>/dev/null || true
ufw allow ssh       &>/dev/null || true
ufw allow 80/tcp    &>/dev/null || true
ufw allow 443/tcp   &>/dev/null || true
success "Firewall: SSH, HTTP(80), HTTPS(443) allowed"

# =============================================================================
# Done
# =============================================================================
echo ""
echo -e "${BOLD}${GREEN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║   Kifaa Community Edition — setup complete!           ║${NC}"
echo -e "${BOLD}${GREEN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Dashboard URL:${NC}     ${CYAN}http://${SERVER_IP}${NC}"
if [[ "$DOMAIN" != "$SERVER_IP" ]]; then
echo -e "                     ${CYAN}https://${DOMAIN}${NC}"
fi
echo ""
echo -e "  ${BOLD}Login:${NC}             ${YELLOW}${ADMIN_USERNAME}${NC} / ${YELLOW}${ADMIN_PASSWORD}${NC}"
echo ""
echo -e "  ${BOLD}Agent config:${NC}"
echo -e "    Server URL:      ${YELLOW}http://${SERVER_IP}${NC}"
echo -e "    Reg. secret:     ${YELLOW}${AGENT_REG_SECRET}${NC}"
echo ""
echo -e "  ${BOLD}Useful commands:${NC}"
echo -e "    docker compose ps                  — check service status"
echo -e "    docker compose logs -f api         — API logs"
echo -e "    docker compose restart api         — restart API"
echo ""
echo -e "  ${BOLD}Limits (Community Edition):${NC}"
echo -e "    Agents:          ${YELLOW}25 max${NC}"
echo -e "    AD users:        ${YELLOW}20 max${NC}"
echo ""
echo -e "${YELLOW}  ⚠  Save your admin password — it will not be shown again.${NC}"
echo -e "${GREEN}═════════════════════════════════════════════════════════${NC}"
