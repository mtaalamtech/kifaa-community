#!/bin/bash
# Kifaa Agent Installer — Linux
# Usage: curl -sSL http://kifaa.kenyanut.com/downloads/install-linux.sh | sudo bash -s -- --server http://kifaa.kenyanut.com --secret <REGISTRATION_SECRET>

set -e

SERVER_URL=""
SECRET=""
AGENT_USER="kifaa-agent"
AGENT_DIR="/opt/kifaa-agent"
SERVICE_NAME="kifaa-agent"

while [[ $# -gt 0 ]]; do
    case $1 in
        --server) SERVER_URL="$2"; shift 2 ;;
        --secret) SECRET="$2"; shift 2 ;;
        *) echo "Unknown: $1"; exit 1 ;;
    esac
done

if [[ -z "$SERVER_URL" || -z "$SECRET" ]]; then
    echo "Usage: $0 --server <url> --secret <registration_secret>"
    exit 1
fi

echo "[*] Installing Kifaa Agent..."

# Detect arch
ARCH=$(uname -m)
case $ARCH in
    x86_64)  BINARY="kifaa-agent-linux-amd64" ;;
    aarch64) BINARY="kifaa-agent-linux-arm64" ;;
    *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# Create agent user
if ! id -u $AGENT_USER &>/dev/null; then
    useradd -r -s /bin/false -d $AGENT_DIR $AGENT_USER
fi

mkdir -p $AGENT_DIR

# Download binary
echo "[*] Downloading agent binary..."
curl -sSL "$SERVER_URL/downloads/$BINARY" -o "$AGENT_DIR/kifaa-agent"
chmod +x "$AGENT_DIR/kifaa-agent"
chown -R $AGENT_USER:$AGENT_USER $AGENT_DIR

# Register
echo "[*] Registering with server..."
$AGENT_DIR/kifaa-agent --register --server "$SERVER_URL" --secret "$SECRET"

# Create systemd service
cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=Kifaa Endpoint Agent
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=root
ExecStart=$AGENT_DIR/kifaa-agent
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=kifaa-agent

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable $SERVICE_NAME
systemctl start $SERVICE_NAME

echo "[✓] Kifaa Agent installed and running!"
echo "    Status: systemctl status kifaa-agent"
echo "    Logs:   journalctl -u kifaa-agent -f"
