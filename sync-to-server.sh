#!/usr/bin/env bash
# =============================================================================
# Kifaa — Copy project to new server and run setup
# Run this FROM the current server (192.168.0.7) as root.
# =============================================================================
set -euo pipefail

TARGET_HOST="192.168.0.64"
TARGET_USER="mtunzi"
TARGET_PASS="Onesha@123!"
INSTALL_DIR="/opt/kifaa"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[sync]${NC} $*"; }
success() { echo -e "${GREEN}[sync]${NC} $*"; }
warn()    { echo -e "${YELLOW}[sync]${NC} $*"; }
error()   { echo -e "${RED}[sync]${NC} $*" >&2; exit 1; }

command -v sshpass &>/dev/null || { apt-get install -y sshpass -qq; }
command -v rsync   &>/dev/null || { apt-get install -y rsync   -qq; }

SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10"
SSHPASS="sshpass -p ${TARGET_PASS}"

info "Testing connection to ${TARGET_USER}@${TARGET_HOST}..."
$SSHPASS ssh $SSH_OPTS "${TARGET_USER}@${TARGET_HOST}" echo "Connection OK" \
    || error "Cannot connect to ${TARGET_HOST}. Check IP/credentials."
success "Connected"

# Ensure target directory exists with correct permissions
info "Creating ${INSTALL_DIR} on target..."
$SSHPASS ssh $SSH_OPTS "${TARGET_USER}@${TARGET_HOST}" \
    "echo '${TARGET_PASS}' | sudo -S mkdir -p ${INSTALL_DIR} && echo '${TARGET_PASS}' | sudo -S chown ${TARGET_USER}:${TARGET_USER} ${INSTALL_DIR}"

# Rsync project files — exclude runtime data and caches
info "Syncing project files (this may take a few minutes for the first run)..."
$SSHPASS rsync -avz --progress \
    --exclude='.git/' \
    --exclude='data/postgres/' \
    --exclude='data/redis/' \
    --exclude='data/whatsapp/' \
    --exclude='*.pyc' \
    --exclude='__pycache__/' \
    --exclude='node_modules/' \
    --exclude='frontend/.vite/' \
    --exclude='agent/modern/vendor/' \
    --exclude='*.log' \
    --exclude='*.pid' \
    "${INSTALL_DIR}/" \
    "${TARGET_USER}@${TARGET_HOST}:${INSTALL_DIR}/"

success "Files synced"

# Make setup script executable and run it
info "Running setup on target server..."
$SSHPASS ssh $SSH_OPTS "${TARGET_USER}@${TARGET_HOST}" \
    "chmod +x ${INSTALL_DIR}/setup.sh && echo '${TARGET_PASS}' | sudo -S ${INSTALL_DIR}/setup.sh"

success "Setup complete on ${TARGET_HOST}"
