#!/bin/bash
# Kifaa Agent Recovery Script
# Fixes GLIBC compatibility error by replacing the agent binary with a static build.
# Usage: curl http://192.168.0.7/downloads/recover-linux-agent.sh | sudo bash

set -e

AGENT_URL="http://192.168.0.7/downloads/kifaa-agent-linux-amd64"

# Find the current agent binary
AGENT_BIN=$(find /opt/kifaa-agent /usr/local/bin /opt /usr/bin -name "kifaa-agent" -type f 2>/dev/null | head -1)

if [ -z "$AGENT_BIN" ]; then
  echo "ERROR: Cannot find kifaa-agent binary. Defaulting to /opt/kifaa-agent/kifaa-agent"
  mkdir -p /opt/kifaa-agent
  AGENT_BIN="/opt/kifaa-agent/kifaa-agent"
fi

echo "Found agent at: $AGENT_BIN"
echo "Downloading static binary from $AGENT_URL ..."
curl -fsSL "$AGENT_URL" -o "${AGENT_BIN}.new"
chmod 755 "${AGENT_BIN}.new"
mv "${AGENT_BIN}.new" "$AGENT_BIN"

echo "Resetting and restarting kifaa-agent service..."
systemctl reset-failed kifaa-agent 2>/dev/null || true
systemctl restart kifaa-agent

sleep 3
systemctl status kifaa-agent --no-pager | tail -10
echo "Done."
