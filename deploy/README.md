# Kifaa — Open-Source Endpoint Management Platform

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-compose-blue?logo=docker)](docker-compose.yml)
[![Go](https://img.shields.io/badge/agent-Go%201.21+-00ADD8?logo=go)](agent/)
[![Python](https://img.shields.io/badge/server-Python%203.12-3776AB?logo=python)](server/)
[![React](https://img.shields.io/badge/frontend-React%2019-61DAFB?logo=react)](frontend/)

**Kifaa** (Swahili: *tool*) is a lightweight, self-hosted Remote Monitoring and Management (RMM) platform built for IT teams that need real visibility across their endpoint fleet — without the complexity or cost of enterprise tools.

Deploy it in minutes with Docker Compose. Monitor Windows and Linux endpoints, manage patches, watch services, and get notified when things go wrong.

---

## Features

### Endpoint Management
- **Agent-based monitoring** — lightweight Go agent (~7MB) for Windows and Linux
- **Auto-registration** — agents self-register on first contact; no manual onboarding
- **Live heartbeat** — status, CPU, memory, disk, and service state reported every 30 seconds
- **Fleet overview** — see all your endpoints, their OS, version, and status at a glance
- **Agent self-update** — push new agent versions to the entire fleet in one click

### Patch Management
- **Patch scanning** — detect missing Windows updates and Linux package upgrades
- **One-click deployment** — push patches to individual machines or groups
- **Scheduled patching** — define maintenance windows, recurring or one-time
- **Job tracking** — live output streaming, success/failure per machine
- **Patch compliance** — dashboard showing how up-to-date your fleet is

### Monitoring & Alerting
- **Port / HTTP / HTTPS / DNS / ICMP checks** — know if services are up before your users notice
- **Service monitor** — watch specific services (e.g. SQL Server, IIS) and auto-restart them when stopped
- **Agent watchdog** — detect machines that are up but the agent isn't running; auto-restart the agent service
- **Configurable alert rules** — CPU, memory, disk, offline agents — with cooldown periods
- **Alert history** — full log of every alert that fired and when it resolved

### Reporting
- **PDF / Excel export** — generate patch, inventory, and uptime reports
- **Scheduled delivery** — email reports on a schedule to any recipient list
- **Per-agent detail** — hardware, software, running services, disk volumes, recent events

### Additional Modules
- **Software inventory** — what's installed on every machine, version, publisher
- **Disk & storage monitoring** — per-volume usage with trend over time
- **Group management** — organise agents into groups; apply patches or commands by group
- **Role-based access** — admin, operator, and viewer roles
- **SSH terminal** — browser-based terminal to Linux agents (no VPN required)

---

## Architecture

```
                    ┌─────────────────────────────────┐
                    │          Your Browser            │
                    └──────────────┬──────────────────┘
                                   │ HTTPS
                    ┌──────────────▼──────────────────┐
                    │            Nginx                 │
                    │   (reverse proxy + TLS)          │
                    └────┬─────────────────┬──────────┘
                         │                 │
               ┌─────────▼──────┐  ┌──────▼─────────┐
               │  React (Vite)  │  │  FastAPI (API)  │
               │   Frontend     │  │   + Celery      │
               └────────────────┘  └──────┬──────────┘
                                          │
                          ┌───────────────┴───────────────┐
                          │                               │
               ┌──────────▼──────────┐      ┌────────────▼──────┐
               │  TimescaleDB        │      │      Redis         │
               │  (PostgreSQL +      │      │  (task queue +     │
               │   time-series)      │      │   pub/sub)         │
               └─────────────────────┘      └───────────────────┘

                    ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
                    │       Managed Endpoints       │
                    ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─

          ┌──────────────────┐        ┌──────────────────┐
          │  Windows Agent   │        │   Linux Agent    │
          │  (KifaaAgent     │        │  (kifaa-agent    │
          │   Windows svc)   │        │   systemd unit)  │
          └────────┬─────────┘        └────────┬─────────┘
                   │  HTTP heartbeat (30s)      │
                   └──────────────┬─────────────┘
                                  │
                          FastAPI /heartbeat
```

**Stack:**
| Component | Technology |
|-----------|-----------|
| Agent | Go 1.21+ (~7MB binary, zero dependencies) |
| API server | Python 3.12 / FastAPI / SQLAlchemy async |
| Task queue | Celery + Redis |
| Database | TimescaleDB (PostgreSQL 16 + time-series) |
| Frontend | React 19 / Vite / Tailwind CSS |
| Proxy | Nginx 1.27 |

---

## Quick Start

### Prerequisites
- Docker Engine 24+ and Docker Compose v2
- A Linux host with at least 2GB RAM and 20GB disk
- A domain name or static IP (for agent connectivity)

### One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/kenyanut/kifaa/main/install.sh | bash
```

### Manual install

```bash
# 1. Clone the repository
git clone https://github.com/kenyanut/kifaa.git
cd kifaa

# 2. Configure your environment
cp .env.example .env
nano .env          # set SERVER_IP, domain, and secrets

# 3. Start the stack
docker compose up -d

# 4. Open the UI
# https://your-server-ip  (default credentials: admin / kifaa-change-me)
```

The first startup takes ~2 minutes to initialise the database and build the frontend.

---

## Agent Deployment

### Windows

Run as Administrator (PowerShell):

```powershell
$url = "http://YOUR_SERVER_IP/downloads/kifaa-agent-windows-amd64.exe"
$dest = "C:\Program Files\KifaaAgent\kifaa-agent.exe"
New-Item -ItemType Directory -Force -Path (Split-Path $dest)
Invoke-WebRequest $url -OutFile $dest
& $dest --install --server http://YOUR_SERVER_IP --key YOUR_REGISTRATION_KEY
```

The agent installs itself as a Windows Service (`KifaaAgent`) set to automatic start.

### Linux (systemd)

```bash
curl -fsSL http://YOUR_SERVER_IP/downloads/kifaa-agent-linux-amd64 -o /usr/local/bin/kifaa-agent
chmod +x /usr/local/bin/kifaa-agent
kifaa-agent --install --server http://YOUR_SERVER_IP --key YOUR_REGISTRATION_KEY
```

The installer creates a systemd service unit (`kifaa-agent.service`) enabled on boot.

### Mass deployment

See [docs/agent-deployment.md](docs/agent-deployment.md) for Group Policy (Windows), Ansible, and shell script deployment examples.

---

## Configuration

All configuration is in `.env`. Key variables:

```env
# Server
SERVER_IP=192.168.1.10          # IP or hostname agents connect to
SERVER_DOMAIN=kifaa.example.com # Optional: public domain for HTTPS

# Security (change these before first run)
SECRET_KEY=change-me-32-chars-minimum
AGENT_REGISTRATION_KEY=change-me-agent-key
DB_PASSWORD=change-me-db-password

# Email notifications
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=alerts@example.com
SMTP_PASSWORD=smtp-password
ALERT_FROM=kifaa@example.com
```

---

## Module Documentation

| Module | Documentation |
|--------|--------------|
| Patch Management | [docs/modules/patching.md](docs/modules/patching.md) |
| Monitoring & Alerts | [docs/modules/monitoring.md](docs/modules/monitoring.md) |
| Service Monitor | [docs/modules/service-monitor.md](docs/modules/service-monitor.md) |
| Reporting | [docs/modules/reporting.md](docs/modules/reporting.md) |
| Agent Deployment | [docs/agent-deployment.md](docs/agent-deployment.md) |

---

## Upgrade

```bash
git pull
docker compose build --no-cache
docker compose up -d
```

Database migrations run automatically on startup.

---

## Roadmap

- [ ] REST API documentation (OpenAPI)
- [ ] Agent deployment via UI (drag-and-drop MSI / shell script generator)
- [ ] Webhook alerts (Slack, Teams, generic HTTP)
- [ ] Multi-server federation (manage multiple Kifaa instances from one UI)
- [ ] Agent for macOS

Community contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Enterprise Edition

The open-source Community Edition covers the core RMM workflow. The **Enterprise Edition** adds:

- Active Directory integration (user/group sync, AD health monitoring)
- Browser-based RDP and SSH terminal (no VPN required)
- Integrations: VMware vCenter, Proxmox, Nutanix, SAP, Sophos, Office 365, Unitrends
- SIEM event collection and correlation
- Compliance scoring and audit reports
- Phishing simulation campaigns
- Multi-channel alerting (Telegram, Teams, WhatsApp)
- Priority support and SLA

[Contact us](mailto:info@kenyanut.com) for Enterprise Edition licensing.

---

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you'd like to change.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and contribution guidelines.

---

## License

Copyright 2024 [Kenyanut Systems](https://kenyanut.com)

Licensed under the **Apache License, Version 2.0**. See [LICENSE](LICENSE) for the full text.

You are free to use, modify, and distribute this software for any purpose, including commercially, provided you include the original copyright notice and license.
