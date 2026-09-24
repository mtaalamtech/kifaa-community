# Kifaa Community Edition

**Self-hosted IT security & endpoint management — free for up to 25 agents**

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-v1.0.0-green.svg)

Kifaa Community Edition is a self-hosted IT security and endpoint management platform designed for small teams and home labs. It gives you real-time visibility into your Windows and Linux endpoints, automated patch management, compliance scoring, and Active Directory integration — all running on your own infrastructure with no external dependencies or licensing fees.

---

## Features

- **Agent Management** — Monitor up to 25 Windows and Linux endpoints with lightweight Go agents. View real-time status, hardware inventory, software inventory, and metrics.
- **Patch Management** — Scan endpoints for missing patches, apply updates remotely, schedule maintenance windows, and track patch compliance over time.
- **Compliance Scoring** — Automated security compliance checks with per-agent scoring, risk review workflows, and quarterly summary reports.
- **Service Monitoring** — Monitor HTTP/HTTPS/TCP/ICMP targets with configurable alert thresholds and uptime tracking.
- **Active Directory Integration** — Sync up to 20 AD users per domain controller agent. View account status, password expiry, lockouts, and group membership.
- **Antivirus Status** — Collect and display antivirus product status and definition age from Windows endpoints.
- **SSL Certificate Manager** — Track SSL certificate expiry across your environment with automated renewal via Let's Encrypt.
- **Software Inventory** — Full installed software inventory per endpoint with version tracking and publisher information.
- **Reports & XLSX Exports** — Generate uptime reports, patch compliance reports, quarterly security reports, and scheduled email delivery.

---

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/mtaalamtech/kifaa-community.git
cd kifaa-community

# 2. Copy example configuration
cp .env.example .env

# 3. Edit secrets and configuration
#    Set your domain, SMTP settings, and review defaults
nano .env

# 4. Start all services
docker compose up -d

# 5. View startup logs to get your temporary admin password
docker compose logs api | grep "TEMPORARY ADMIN PASSWORD" -A 5
```

> **Default URL:** `http://localhost` (or your configured domain)

---

> **Warning: Default Credentials**
>
> On first startup, Kifaa generates a random temporary admin password and prints it to the API container logs. You **must** retrieve this password from the logs and change it immediately after first login. There is no default static password.
>
> ```bash
> docker compose logs api | grep -A 3 "TEMPORARY ADMIN PASSWORD"
> ```

---

## Limits

Kifaa Community Edition includes the following limits:

| Resource | Community Limit |
|----------|----------------|
| Agents | 25 maximum |
| Active Directory users | 20 per DC agent |
| Integrations | None (VMware, Proxmox, Sophos, O365, etc. require Enterprise) |
| Bot notifications | Not included (Telegram, Teams, WhatsApp require Enterprise) |
| SIEM / syslog ingestion | Not included |
| Phishing simulation | Not included |

**Upgrade to Enterprise** for unlimited agents, VMware/Proxmox integrations, SIEM, bot notifications, RDP session reporting, and more. Contact [info@kenyanut.com](mailto:info@kenyanut.com) or visit [kifaa.kenyanut.com](https://kifaa.kenyanut.com) for pricing.

---

## Requirements

| Requirement | Minimum |
|-------------|---------|
| Docker | 24.0+ |
| Docker Compose | v2.0+ |
| RAM | 4 GB |
| Disk | 20 GB |
| OS | Linux (Ubuntu 22.04+ recommended) |

---

## Support

- **Bug reports & feature requests:** [GitHub Issues](https://github.com/mtaalamtech/kifaa-community/issues)
- **Documentation:** [GitHub Wiki](https://github.com/mtaalamtech/kifaa-community/wiki)
- **Community discussions:** [GitHub Discussions](https://github.com/mtaalamtech/kifaa-community/discussions)

---

## License

MIT License — see [LICENSE](LICENSE) for details.

Copyright (c) 2024 Mtaalam Tech
