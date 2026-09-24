# KIFAA — Enterprise Endpoint Management Platform
### Portfolio Showcase & CV Reference

---

## What Is KIFAA?

KIFAA is a **full-stack, self-hosted enterprise IT management platform** built from scratch to monitor, manage, and secure a fleet of 32+ servers and endpoints across an organisation. It replaces multiple commercial tools (WSUS, basic RMM agents, separate monitoring systems) with a single unified platform.

The platform is live in production at `kifaa.kenyanut.com`, managing a mixed Windows/Linux environment including Active Directory, SAP Business One, MSSQL, web servers, and UPS power management.

---

## Technical Stack

| Layer | Technology |
|---|---|
| **Backend API** | Python · FastAPI · SQLAlchemy (async) · Celery |
| **Database** | PostgreSQL · TimescaleDB (time-series metrics) |
| **Frontend** | React · Vite · Tailwind CSS · Recharts · XLSX |
| **Agent** | Go (cross-compiled Windows/Linux/macOS) |
| **Infrastructure** | Docker Compose · Nginx (reverse proxy + SSL) · Redis |
| **Messaging** | Telegram Bot · WhatsApp (via Baileys) |
| **Protocols** | SNMP (custom raw UDP, no library) · WebSocket · SSH tunnels |

**Scale:** 43 API routers · 45 frontend pages · 46 Go agent collector modules · 51 GB live database · 137M+ time-series metric rows

---

## Core Modules Built

### 1. Agent System
- Lightweight Go agent deployed on Windows and Linux endpoints
- Heartbeat-based command polling every 5 seconds
- Collects: CPU, RAM, disk, network, services, software inventory, hardware specs (BIOS, NIC, serial number)
- Cross-compiled binaries for Windows (amd64/arm64) and Linux
- Agent auto-deploy pipeline with signed packages

### 2. Real-Time Monitoring
- TimescaleDB hypertable storing 137M+ metric rows with continuous aggregates
- Alerting engine with configurable thresholds, cooldowns, and escalation
- Service monitor with auto-restart capability
- Port/URL uptime checks with response time tracking
- Grafana-style metric charts on per-agent detail pages

### 3. Patch Management
- Full Windows Update integration via agent
- Patch compliance dashboard across all endpoints
- Scheduled patch windows with group targeting
- WSUS integration (KNCPATCHSVR)
- Patch history and success/failure tracking

### 4. Active Directory Management
- Full AD read/write via agent (users, groups, OUs)
- Bulk user operations (enable/disable/unlock/reset)
- Stale account detection, password expiry tracking
- AD event log streaming
- Compliance reporting (admin accounts, never-logged-in users)
- Auto-sync background loop with configurable intervals

### 5. UPS / Power Management (APC)
- Custom raw SNMPv2c UDP socket implementation (no pysnmp dependency)
- Polls APC UPS devices every 5 minutes: battery %, runtime remaining, load %, status
- **Automatic shutdown policies**: battery/runtime thresholds trigger ordered server shutdown
- Cancellation window with live countdown banner in the UI
- Telegram/WhatsApp bot notifications on UPS events
- Configurable shutdown order per policy, with OS-aware commands (Windows: `shutdown /s`, Linux: `shutdown -h now`)
- `poweroff` mode added to Go agent restart module

### 6. SSL Certificate Management
- CSR generation and certificate tracking
- Let's Encrypt ACME HTTP-01 challenge automation
- Auto-renewal with configurable schedule
- Agent-side certificate deployment

### 7. Security Suite
- **Threats**: IOC scanning, file hash detection, quarantine commands
- **Antivirus**: Sophos integration — endpoint health, alerts, policy status
- **SIEM**: UDP syslog listener (port 5140), event parsing, severity classification, source tracking
- **Phishing Simulation**: campaign builder, email template editor, SMTP channel management, click/open tracking
- **Compliance Dashboard**: CIS-aligned checks, risk scoring, finding management
- **Risk Review**: quarterly risk register with treatment tracking

### 8. Integrations Hub
- **Unitrends**: backup job status, client health, storage utilisation, alerts
- **Sophos**: endpoint security posture, license management
- **Office 365**: user/license overview via Graph API
- **VMware vSphere**: VM inventory, host health, datastore utilisation
- **Proxmox**: node/VM management, storage overview
- **Nutanix**: cluster health, VM list, alerts
- **SAP Business One**: user/employee/license management
- **APC UPS**: SNMP monitoring + automated shutdown (see above)

### 9. Reporting Engine
- **Server Inventory Report** (Excel, 4 sheets): server specs + disk usage, 24h CPU/RAM utilisation, software licenses (Windows + MSSQL database licenses), summary
- **Server Consolidation Report** (Excel, 6 sheets): full assessment, license dependencies, storage, timeline, retention plan
- **Quarterly Security Report**: scorecard, findings, incidents, SLA tracking
- **Patch Compliance Report**
- Scheduled report delivery via email

### 10. Server Consolidation Planner
- Auto-suggestion engine using service detection + utilisation data + OS version
- Distinguishes Windows Internal DB (WID) from real MSSQL instances
- Role detection: AD, SAP RDP thin-client, SAP Business One, e-commerce (PHP+MySQL), Domino mail, MSSQL, Web
- Action recommendations: Keep / Consolidate / Migrate / Virtualize / Cloud / Decommission
- Per-server plan editing: confirmed action, destination server, target date, rollback plan, retention period
- Excel export matching management report requirements (6 sheets including retention plan for decommission/migrate servers)

### 11. Additional Modules
- **Remote Terminal**: browser-based SSH terminal via WebSocket
- **RDP Viewer**: Apache Guacamole integration for browser RDP
- **Software Inventory**: installed applications across all endpoints with search/filter
- **Database Monitor**: MSSQL/MySQL service health and metrics
- **Storage Management**: per-mount disk history, growth trends, exclusion rules
- **Maintenance Plans**: scheduled maintenance windows with agent targeting
- **Reboot Schedules**: automated reboot windows with group policies
- **Bot & Messaging**: Telegram + WhatsApp alert delivery, configurable notification rules
- **Credentials Vault**: encrypted credential storage for integrations
- **Agent Downloads**: self-service download portal for agent installers

---

## Architecture Decisions Worth Highlighting

**TimescaleDB for metrics** — chose time-series extension over InfluxDB to keep a single PostgreSQL database. Hypertable with chunk-based retention (30-day policy) handles 137M rows with sub-second queries using narrow time windows.

**Custom SNMP without pysnmp** — implemented raw SNMPv2c over UDP socket to avoid the heavy pysnmp dependency and unreliable async support. Full OID polling with community string auth in ~80 lines of Python.

**Go agent cross-compilation** — single codebase compiles to Windows (amd64), Linux (amd64/arm64) and macOS. Collectors are modular files; adding a new metric type requires one new file.

**Celery beat scheduling** — all background jobs (metric collection triggers, alert evaluation, UPS checks, AD sync, report delivery) run through Celery with Redis broker. Beat schedule is code-defined, not database-driven.

**asyncpg race condition fix** — multiple uvicorn workers simultaneously running `CREATE TABLE IF NOT EXISTS` on startup caused `pg_type` duplicate key errors. Fixed with try/except + rollback + idempotent flag pattern.

---

## CV Bullet Points

Use these directly in a CV under a project or professional experience section:

---

### Option A — Senior / Lead Role Framing

**Lead Developer — KIFAA Enterprise Endpoint Management Platform** *(2024–Present)*

- Architected and built a full-stack IT management platform from scratch, replacing multiple commercial tools for a 32-server mixed Windows/Linux environment
- Designed a Python/FastAPI backend with 43 REST API modules, React/Tailwind frontend with 45 pages, and a cross-platform Go monitoring agent (Windows + Linux)
- Implemented TimescaleDB time-series storage handling 137M+ metric rows with sub-second query performance via hypertable partitioning and retention policies
- Built automated UPS shutdown orchestration using custom raw SNMPv2c (no third-party library), triggering ordered server poweroff sequences with cancellation windows and bot notifications
- Integrated 9 external platforms (VMware, Proxmox, Nutanix, Sophos, O365, SAP B1, Unitrends, APC UPS) through a unified integrations hub
- Developed a server consolidation assessment tool with auto-suggestion engine analysing service fingerprints, OS version, and utilisation data to produce management-ready Excel reports
- Built a SIEM module with UDP syslog listener, event classification, and source tracking; phishing simulation platform with campaign management and SMTP delivery
- Deployed on Docker Compose with Nginx reverse proxy, Let's Encrypt automation, and Celery/Redis background job processing

---

### Option B — Concise Single-Line Points (for space-limited CVs)

- Built KIFAA, a self-hosted RMM/SIEM platform in Python (FastAPI), React, and Go managing 32+ production servers with patch management, AD control, UPS automation, and 9 third-party integrations
- Designed time-series monitoring on TimescaleDB (137M rows) with alerting, service auto-restart, and per-endpoint metric dashboards
- Implemented custom SNMPv2c UPS monitoring with automated ordered server shutdown policies and live cancellation UI
- Created server consolidation planner with role-detection algorithm (AD, SAP RDP, Domino mail, e-commerce stacks) generating 6-sheet management Excel reports

---

### Option C — Skills Keywords Extracted from This Project

For skills sections or ATS keyword optimisation:

`Python` · `FastAPI` · `SQLAlchemy` · `PostgreSQL` · `TimescaleDB` · `React` · `Tailwind CSS` · `Go (Golang)` · `Docker` · `Docker Compose` · `Nginx` · `Redis` · `Celery` · `REST API Design` · `WebSocket` · `SNMP` · `Active Directory` · `Windows Server Administration` · `Linux Server Administration` · `SSL/TLS` · `Let's Encrypt` · `ACME` · `SIEM` · `Syslog` · `Patch Management` · `WSUS` · `VMware vSphere` · `Proxmox` · `Nutanix` · `SAP Business One` · `Microsoft SQL Server` · `MySQL` · `Telegram Bot API` · `Excel Report Automation (XLSX)` · `Time-Series Data` · `Monitoring & Alerting` · `Endpoint Management` · `Security Compliance` · `Phishing Simulation` · `Cross-Platform Agent Development`

---

## Proof Points for Interviews

Questions you can confidently answer with this project:

- *"Describe a performance problem you solved"* → TimescaleDB DISTINCT ON query scanning 1.7M rows causing 5-minute hangs; fixed by narrowing time window to 2 hours with GROUP BY aggregation (150ms result)
- *"How have you handled concurrency issues?"* → asyncpg race condition with multiple uvicorn workers simultaneously creating tables; fixed with try/except/rollback/idempotent flag pattern
- *"How do you approach third-party integrations?"* → built unified integration hub with per-platform routers, sync logs, and configurable credentials; custom SNMP without pysnmp to avoid dependency bloat
- *"Tell me about a system you designed end-to-end"* → KIFAA: agent (Go) → API (FastAPI) → database (PostgreSQL/TimescaleDB) → frontend (React) → background jobs (Celery) → notifications (Telegram/WhatsApp) — all self-hosted, all production
- *"How do you manage background jobs at scale?"* → Celery beat with Redis broker; tasks include metric evaluation, alert processing, AD sync, UPS polling, report delivery — all code-defined schedules

---

*Generated: July 2026 | Platform: KIFAA v1.0 | Live at: kifaa.kenyanut.com*
