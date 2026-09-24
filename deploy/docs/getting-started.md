# Getting Started with Kifaa

This guide walks you through a complete Kifaa deployment from zero to first monitored endpoint.

## Step 1: Prepare Your Server

Kifaa runs on any Linux host. Recommended spec:

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 2 cores | 4 cores |
| RAM | 2 GB | 4 GB |
| Disk | 20 GB | 50 GB |
| OS | Ubuntu 22.04+ / Debian 12+ | Ubuntu 22.04 LTS |

Install Docker Engine and Docker Compose:

```bash
# Ubuntu / Debian
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in, then verify:
docker compose version
```

## Step 2: Install Kifaa

**One-line install:**

```bash
curl -fsSL https://raw.githubusercontent.com/kenyanut/kifaa/main/install.sh | sudo bash
```

This will:
1. Clone the repository to `/opt/kifaa`
2. Create `.env` with auto-generated secrets and your server IP
3. Generate a self-signed TLS certificate
4. Build and start all containers
5. Print the UI URL and initial admin password

**Manual install:**

```bash
git clone https://github.com/kenyanut/kifaa.git /opt/kifaa
cd /opt/kifaa
cp .env.example .env
nano .env    # At minimum, set SERVER_IP and change the secret values
make up
```

## Step 3: First Login

1. Open `https://YOUR_SERVER_IP` in a browser
   - Your browser will warn about the self-signed certificate — accept the exception
   - For production, replace with a real certificate (see [TLS Configuration](#tls-configuration) below)
2. Log in with username `admin` and the initial password from the container logs:
   ```bash
   docker compose logs api | grep "initial password"
   ```
3. **Change your password immediately** — go to the user menu (top right) → Profile → Change Password

## Step 4: Deploy Your First Agent

### Linux

```bash
curl -fsSL http://YOUR_SERVER_IP/downloads/kifaa-agent-linux-amd64 -o /usr/local/bin/kifaa-agent
chmod +x /usr/local/bin/kifaa-agent
kifaa-agent --install --server http://YOUR_SERVER_IP --key YOUR_REGISTRATION_KEY
```

Your `AGENT_REGISTRATION_KEY` is in `.env`. Or, find it in the UI under **Settings → Agent Registration Key**.

### Windows (run as Administrator)

```powershell
$server = "http://YOUR_SERVER_IP"
$key    = "YOUR_REGISTRATION_KEY"
$dest   = "C:\Program Files\KifaaAgent\kifaa-agent.exe"
New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
Invoke-WebRequest "$server/downloads/kifaa-agent-windows-amd64.exe" -OutFile $dest
& $dest --install --server $server --key $key
```

Within 30 seconds the endpoint appears in the **Agents** dashboard.

See [Agent Deployment](agent-deployment.md) for mass deployment (GPO, Ansible, PowerShell remoting).

## Step 5: Explore the UI

| Section | What it does |
|---------|-------------|
| **Dashboard** | Fleet overview, active alerts, patch compliance |
| **Agents** | All endpoints — status, OS, version, metrics |
| **Patch Management** | Scan and deploy updates |
| **Monitoring** | Endpoint checks, alert rules, alert history |
| **Service Monitor** | Watch and auto-restart specific services |
| **Reports** | Generate and schedule PDF/Excel reports |
| **Settings** | Users, groups, email, backup, registration keys |

## Step 6: Set Up Alerting

1. Go to **Settings → Email** and configure your SMTP server
2. Go to **Monitoring → Alert Rules** and review the default rules
3. Create a test alert: temporarily lower the CPU threshold below your server's current usage

## TLS Configuration

For production, replace the self-signed certificate with a real one.

### Let's Encrypt (certbot)

```bash
# Install certbot
apt-get install -y certbot

# Obtain certificate (stop nginx briefly)
docker compose stop nginx
certbot certonly --standalone -d your.domain.com
docker compose start nginx

# Copy certificates
cp /etc/letsencrypt/live/your.domain.com/fullchain.pem ssl/certs/kifaa.crt
cp /etc/letsencrypt/live/your.domain.com/privkey.pem ssl/private/kifaa.key
docker compose restart nginx
```

Set up auto-renewal:
```bash
echo "0 3 * * * certbot renew --quiet && cp /etc/letsencrypt/live/your.domain.com/fullchain.pem /opt/kifaa/ssl/certs/kifaa.crt && cp /etc/letsencrypt/live/your.domain.com/privkey.pem /opt/kifaa/ssl/private/kifaa.key && docker compose -f /opt/kifaa/docker-compose.yml restart nginx" | crontab -
```

### Existing certificate

```bash
cp your.crt ssl/certs/kifaa.crt
cp your.key ssl/private/kifaa.key
docker compose restart nginx
```

## Upgrading

```bash
cd /opt/kifaa
git pull
make update    # pulls, rebuilds, and restarts all services
```

Database migrations run automatically on startup.

## Backup & Restore

```bash
# Manual backup
make backup

# Backups are stored in data/backups/
ls -lh data/backups/

# Restore (replace DATE with the backup timestamp)
docker compose exec timescaledb psql -U kifaa -d kifaa < data/backups/kifaa_backup_DATE.sql
```

Daily automated backups run at 2am UTC by default. Configure with `BACKUP_HOUR` in `.env`.
