# Kifaa Community Edition

**Self-hosted IT security & endpoint management — free for up to 25 agents**

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-v1.0.1-green.svg)
![Platform](https://img.shields.io/badge/platform-Linux-lightgrey.svg)

Kifaa Community Edition is a self-hosted IT security and endpoint management platform for small teams and home labs. Real-time endpoint visibility, automated patch management, compliance scoring, and Active Directory integration — running entirely on your own infrastructure with no external dependencies or licensing fees.

---

## Features

| Module | Description |
|--------|-------------|
| **Agent Management** | Monitor up to 25 Windows & Linux endpoints with lightweight Go agents |
| **Patch Management** | Scan, apply, and schedule patches remotely with compliance tracking |
| **Compliance Scoring** | Automated security checks, per-agent risk scoring, quarterly reports |
| **Service Monitoring** | HTTP / HTTPS / TCP / ICMP uptime monitoring with alert thresholds |
| **Active Directory** | Sync AD users, view lockouts, password expiry, and group membership |
| **Antivirus Status** | Collect AV product status and definition age from Windows endpoints |
| **SSL Certificates** | Track cert expiry across your environment, renew via Let's Encrypt |
| **Software Inventory** | Full installed software list per endpoint with version tracking |
| **Reports & Exports** | Uptime, patch compliance, and quarterly XLSX security reports |

---

## Requirements

| Component | Minimum |
|-----------|---------|
| OS | Ubuntu 22.04 LTS (or Debian 12) |
| CPU | 2 cores |
| RAM | 4 GB |
| Disk | 20 GB free |
| Docker | 24.0+ |
| Docker Compose | v2.0+ |

> The `setup.sh` installer handles Docker, Go, and Node.js installation automatically.

---

## Installation

### One-line install

```bash
git clone https://github.com/mtaalamtech/kifaa-community.git /opt/kifaa
cd /opt/kifaa
sudo bash setup.sh
```

### What the installer does

The interactive `setup.sh` script walks you through the full setup:

1. **Prompts** for your domain name (optional — defaults to server IP) and admin password (or auto-generates one)
2. **Installs** Docker Engine, Go 1.22, and Node.js 20 if not already present
3. **Generates** all secrets randomly using `openssl rand` — no hardcoded values
4. **Builds** the React frontend, Windows + Linux agent binaries, and Docker images
5. **Creates** a self-signed TLS certificate (or uses your existing one)
6. **Configures** Nginx, starts all containers, creates your admin account
7. **Prints** a summary with your login URL, credentials, and agent registration secret

### Example session

```
── Configuration
  Domain name (or press Enter to use IP address): kifaa.example.com
  Admin username [admin]:
  Admin password (min 8 chars) [auto-generate]:
  Generated admin password: xK9mP2nQrT4w

── System packages ............. ✓
── Docker Engine ............... ✓ already installed
── Go compiler ................. ✓ go1.22.4
── Node.js ..................... ✓ v20.18.0
── Generating secrets .......... ✓
── Writing .env ................ ✓
── TLS certificate ............. ✓ self-signed (10 years)
── Frontend build .............. ✓
── Agent binaries .............. ✓ linux-amd64  linux-arm64  windows-amd64  windows-386
── Docker: build & start ....... ✓
── Admin user .................. ✓

╔═══════════════════════════════════════════════════════╗
║   Kifaa Community Edition — setup complete!           ║
╚═══════════════════════════════════════════════════════╝

  Dashboard URL:     http://192.168.1.10
                     https://kifaa.example.com

  Login:             admin / xK9mP2nQrT4w

  Agent config:
    Server URL:      http://192.168.1.10
    Reg. secret:     a3f8e2c1d9b047...
```

---

## Deploying Agents

Once the server is running, deploy the lightweight Go agent to your endpoints.

### Windows (PowerShell — run as Administrator)

```powershell
$server = "http://YOUR_SERVER_IP"
$secret = "YOUR_REGISTRATION_SECRET"

Invoke-WebRequest "$server/downloads/install-windows.ps1" -OutFile install.ps1
.\install.ps1 -ServerUrl $server -RegistrationSecret $secret
```

### Linux

```bash
SERVER="http://YOUR_SERVER_IP"
SECRET="YOUR_REGISTRATION_SECRET"

curl -fsSL "$SERVER/downloads/install-linux.sh" | sudo bash -s -- "$SERVER" "$SECRET"
```

> Both the server URL and registration secret are printed at the end of `setup.sh`.  
> You can also find the secret in `secrets/agent_registration_secret`.

---

## Post-install

### Check service status

```bash
cd /opt/kifaa
docker compose ps
```

### View logs

```bash
docker compose logs -f api        # API logs
docker compose logs -f worker     # Celery worker logs
```

### Restart after code changes

```bash
docker compose restart api worker beat
```

### Upgrade to a new version

```bash
cd /opt/kifaa
git pull
sudo bash setup.sh     # re-run is safe — secrets are not regenerated
docker compose restart api worker beat
```

### Backup the database

```bash
docker exec kifaa-db pg_dump -U kifaa kifaa | gzip > kifaa_backup_$(date +%Y%m%d).sql.gz
```

---

## Limits

| Resource | Community | Enterprise |
|----------|-----------|------------|
| Agents | **25 max** | Unlimited |
| Active Directory users | **20 per DC** | Unlimited |
| VMware / Proxmox / Sophos | — | ✅ |
| O365 / SAP / Unitrends | — | ✅ |
| Telegram / Teams / WhatsApp bot | — | ✅ |
| SIEM & syslog ingestion | — | ✅ |
| Phishing simulation | — | ✅ |
| RDP session reporting | — | ✅ |

**Upgrade to Enterprise:** contact [info@mtaalamtech.com](mailto:info@mtaalamtech.com) or visit [mtaalamtech.com/software/kifaa](https://mtaalamtech.com/software/kifaa).

---

## Troubleshooting

**Database does not start**
```bash
docker compose logs timescaledb
# Common fix: check disk space
df -h
```

**Frontend shows blank page**
```bash
cd /opt/kifaa/frontend && npm run build
docker compose restart nginx
```

**Agent not connecting**
- Confirm the server URL in the agent config matches the server IP (no trailing slash)
- Confirm port 80 / 443 is open: `sudo ufw status`
- Check: `docker compose logs api | grep register`

**Forgot admin password**
```bash
docker compose exec api python3 -c \
  "import bcrypt; print(bcrypt.hashpw(b'NewPassword123', bcrypt.gensalt(12)).decode())"
# Then update the DB:
docker exec kifaa-db psql -U kifaa -d kifaa \
  -c "UPDATE users SET hashed_password='<hash>' WHERE username='admin';"
```

---

## Support

- **Bug reports & feature requests:** [GitHub Issues](https://github.com/mtaalamtech/kifaa-community/issues)
- **Discussions:** [GitHub Discussions](https://github.com/mtaalamtech/kifaa-community/discussions)
- **Enterprise enquiries:** [info@mtaalamtech.com](mailto:info@mtaalamtech.com)

---

## License

MIT License — see [LICENSE](deploy/LICENSE) for details.  
Copyright © 2026 Mtaalam Tech
