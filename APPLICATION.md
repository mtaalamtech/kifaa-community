# Kifaa Platform — Application Overview & Launch Readiness

**Stack:** FastAPI · React 19 · TimescaleDB · Go Agent · Docker Compose  
**Domain:** kifaa.kenyanut.com  
**Last updated:** 2026-06-30

---

## What Kifaa Is

Kifaa is a full-stack **Remote Monitoring and Management (RMM) / Security Information and Event Management (SIEM)** platform built for IT infrastructure management. It competes directly with NinjaRMM, Atera, Datto RMM, and Wazuh — tools that are either expensive USD-priced SaaS or complex open-source installations that require significant DevOps expertise.

### Core Capabilities

| Domain | Features |
|--------|----------|
| **Endpoint Management** | Cross-platform Go agent (Linux + Windows), real-time inventory, services, software, hardware |
| **Monitoring** | Port/TCP/HTTP/ping/SSL/database checks, alert rules, uptime tracking, Recharts dashboards |
| **Patch Management** | Agent-pull patching, SSH/WinRM/SMB patch delivery, schedule automation, compliance reporting |
| **Security / SIEM** | Threat detection, syslog ingestion, audit logging, compliance dashboard, CVE matching |
| **Active Directory** | AD sync via agent, user/group management, account actions (enable/disable/unlock/reset), event log |
| **Remote Access** | In-browser SSH terminal (xterm.js), in-browser RDP/VNC (Apache Guacamole), credential vault |
| **Phishing Simulation** | Campaign builder, email delivery via Postfix relay, admin-only with approval workflow |
| **Integrations** | VMware vCenter, Nutanix Prism, Proxmox VE, Sophos Central, Microsoft 365, Unitrends, SAP Business One |
| **Messaging Bot** | Telegram, WhatsApp (whatsapp-web.js bridge), Microsoft Teams — query agents, run commands, get alerts |
| **Reporting** | Scheduled PDF/CSV/Excel reports via email, weekly health report, AD user/group exports |
| **Multi-tenancy** | Role-based access (admin/operator/viewer), agent groups, object-level authorization |

### Infrastructure

- **12 Docker services:** API, Worker (Celery), Beat scheduler, TimescaleDB, Redis, Frontend, Nginx, Guacamole, Postfix relay, WhatsApp bridge, Bot, optional backup
- **Agent:** Go binary, cross-compiled for Linux (amd64/arm64) and Windows (amd64)
- **Data retention:** 30-day time-series metrics (TimescaleDB hypertables with automatic pruning)
- **Backup:** Daily pg_dump at 2am UTC, tiered retention (1/day × 7 days, 1/week × 4 weeks), max 14 files

---

## Business Decision: Open Source vs Monetize

### The Honest Recommendation — Open-Core Hybrid

Do not choose one or the other. The right model is **open-core**: open source the foundation to drive adoption, monetize managed hosting and premium modules.

This is exactly how Wazuh, Netdata, Grafana, and GitLab grew. All are free to self-host; all charge for cloud-managed and enterprise tiers.

### Why Kifaa is Suited for This

**The case for open sourcing the core:**
- IT teams are reluctant to run closed-source agents on their endpoints. Open sourcing the agent removes the biggest adoption barrier.
- The African IT market lacks affordable, locally-relevant RMM tooling. Free self-hosted tier captures SMBs who cannot afford USD SaaS pricing.
- Community contributions accelerate integrations. There are many more integrations (Zabbix, PRTG, ConnectWise, Jira, PagerDuty) the community would build if the code is open.
- Distribution is everything for infrastructure tooling. Wazuh grew entirely through free adoption, then converted enterprises to paid support contracts.

**The case for monetizing:**
- The depth of this platform — phishing simulation, SAP integration, WhatsApp bot, in-browser RDP — represents months of engineering. That work deserves a return.
- NinjaRMM charges ~$3–4 USD/device/month. At 500 managed devices that is $1,500–2,000/month recurring. The market exists.
- The **WhatsApp bot** is a genuine regional differentiator. WhatsApp is the dominant business communication tool in East Africa. No Western RMM platform has this. It is a competitive moat.
- Enterprise customers (banks, telcos, government, NGOs) will pay for hosted + SLA + compliance modules. They cannot self-host.

### Recommended Tiering

| Tier | What's Included | Pricing Model |
|------|----------------|---------------|
| **Community** (open source) | Core API, frontend, Go agent, basic monitoring, patching, AD | Free — self-hosted |
| **Cloud / Managed** | Hosted Kifaa, multi-tenant, backups managed, SSL auto-renew | Per-device/month SaaS |
| **Enterprise** | Phishing simulation, compliance reporting, SAP/VMware integrations, SLA, dedicated support | Annual contract |
| **WhatsApp Add-on** | WhatsApp bot for all tiers | Flat monthly fee |

### What to Open Source vs Keep Proprietary

| Component | Recommendation | Reason |
|-----------|---------------|--------|
| Go agent | Open source | Trust — IT teams will not deploy closed binaries |
| Core API + frontend | Open source (community tier) | Drives adoption |
| Phishing module | Proprietary / enterprise only | High-risk feature, needs controls |
| SAP / VMware / Nutanix integrations | Proprietary / enterprise only | Enterprise differentiators |
| WhatsApp bridge | Proprietary add-on | Regional moat |
| Messaging bot (Telegram/Teams) | Open source | Low risk, builds community |

---

## What Has Been Built vs What Is Incomplete

### Security Hardening (21 of 23 tasks complete)

A full static security audit was completed in June 2026. All critical and high-severity issues have been remediated.

| Task | Status | Description |
|------|--------|-------------|
| TASK-01 Unauthenticated admin creation | ✅ Done | Fixed — endpoint now requires admin auth |
| TASK-02 SQL injection in metrics | ✅ Done | Fixed — parameterized queries |
| TASK-03 SQL injection in software inventory | ✅ Done | Fixed — parameterized queries |
| TASK-04 Rotate secrets | ✅ Done | All secrets rotated |
| TASK-05 Auth on all agent endpoints | ✅ Done | JWT required on all routes |
| TASK-06 HTTPS enforced + HSTS | ✅ Done | HTTP → HTTPS redirect, HSTS header |
| TASK-07 CORS locked to known origin | ✅ Done | Restricted to kifaa.kenyanut.com |
| TASK-08 JWT strengthened | ✅ Done | 64-byte secret, 60min expiry, Redis blacklist |
| TASK-09 Object-level authorization | ✅ Done | Role checks on all resource endpoints |
| TASK-10 Phishing restricted to admin | ✅ Done | Requires admin role + approval workflow |
| TASK-11 SSH host key verification | ✅ Done | Key stored on first connect, verified after |
| TASK-12 WebSocket one-time tickets | ✅ Done | JWT no longer in URL |
| TASK-13 Rate limiting | ✅ Done | slowapi on login + registration |
| TASK-14 Encrypt SSH/RDP credentials | ✅ Done | Fernet encryption at rest |
| TASK-15 Syslog bound to loopback | ✅ Done | No longer exposed to network |
| TASK-16 Disable autoindex on downloads | ✅ Done | Agent builds no longer enumerable |
| TASK-17 Forward audit logs to external syslog | ❌ **Pending** | Module exists, not wired to startup |
| TASK-18 RDP cert validation | ✅ Done | Defaults to TLS, UI toggle for override |
| TASK-19 Strong password policy | ✅ Done | 12 chars, complexity requirements |
| TASK-20 Security headers | ✅ Done | CSP, HSTS, Referrer-Policy added |
| TASK-21 Remove default admin password | ✅ Done | Removed from init.sql |
| TASK-22 Content Security Policy | ✅ Done | Configured in nginx |
| TASK-23 Secrets management | ❌ **Pending** | Still using plaintext .env file |

### Known Bugs / Issues (discovered in operations)

| Issue | Status | Impact |
|-------|--------|--------|
| `patch_schedule_runs` table missing | ✅ Fixed 2026-06-29 | Patch schedules were silently failing every minute |
| Database backup consuming 97GB | ✅ Fixed 2026-06-27 | Reduced to ~70MB with tiered retention + metric exclusion |
| Monitoring deadlock (concurrent run-checks) | ✅ Fixed 2026-06-29 | Intermittent 500 on monitoring endpoint |
| AD export "not authenticated" | ✅ Fixed 2026-06-30 | Token not sent via `<a href>` links |

---

## What Is NOT Complete — Pre-Launch Gaps

The following are gaps that should be addressed before making this available to paying customers or the public. They are ranked by priority.

---

### MUST FIX before any public launch

#### 1. Secrets Management (TASK-23) — HIGH RISK
The `.env` file contains all production secrets in plaintext. Anyone with SSH access to the server can read database passwords, API signing keys, Telegram tokens, and Postgres credentials.

**What to do:**
- Migrate to Docker secrets (`docker secret create`) or HashiCorp Vault
- At minimum, restrict `.env` file permissions to root only (`chmod 600`)
- Ensure `.env` is in `.gitignore` and has never been committed to git
- Verify secrets are not visible in `docker inspect` output

**Why it matters for launch:** If you open-source the repo and `.env` was ever committed, the secrets are permanently in git history and must be rotated. If a customer self-hosts and copies your `.env` template, they inherit your secrets.

---

#### 2. Audit Log External Forwarding (TASK-17) — MEDIUM RISK
The `audit_log.py` module is written and `configure_syslog()` exists, but it is not wired into `main.py` startup. Audit logs only exist in the same database they protect — an attacker with database access can delete all evidence.

**What to do:**
- Add `configure_syslog()` call in `server/api/main.py` lifespan startup
- Verify `SYSLOG_HOST` is in `config.py` and the `.env`
- Test that sensitive actions (login, user creation, agent command dispatch, credential access) produce syslog entries

**Why it matters for launch:** Any enterprise or government customer will require external audit log forwarding as a compliance requirement (ISO 27001, SOC 2). Without it you cannot sell to regulated industries.

---

#### 3. Multi-Tenant Isolation — NOT BUILT
The platform currently assumes a single organization. All users see all agents regardless of group assignment. There is a groups model but no hard data isolation between tenants.

**What to do (for SaaS):**
- Add an `organisation_id` foreign key to agents, users, and all related tables
- Scope all queries to the requesting user's organisation
- Add organisation management (create, invite users, billing)

**Why it matters for launch:** You cannot run multiple paying customers on the same instance without this. Each customer would see all other customers' data.

---

#### 4. Billing / Licensing — NOT BUILT
There is a `licenses.py` router and a `Licenses` page in the frontend, but no payment integration, no seat counting, and no usage-based enforcement.

**What to do:**
- Integrate a payment provider (Stripe, Flutterwave for East Africa, or M-Pesa)
- Implement device/agent count enforcement against license limits
- Add a license expiry check and grace period

**Why it matters for launch:** Without this, you cannot charge for the product.

---

#### 5. Agent Auto-Update Robustness — PARTIAL
The Go agent has a self-update mechanism (via `reporter/`), but there is no rollback if a bad update is pushed, no version pinning, and no staged rollout (push to 10% of agents first).

**What to do:**
- Add a rollback mechanism (keep previous binary, swap back on failure)
- Add version pinning per agent group
- Add a staged rollout flag on the update endpoint

**Why it matters for launch:** Pushing a bad agent update to 500 customer devices simultaneously is a catastrophic failure mode.

---

### SHOULD DO before scaling to multiple customers

#### 6. Email Deliverability
Scheduled reports and alert notifications use an SMTP notification channel configured per installation. There is no transactional email service built in. Self-hosted Postfix (used for phishing) is not appropriate for alert emails.

**What to do:** Add SendGrid, Mailgun, or AWS SES as a built-in option alongside custom SMTP.

---

#### 7. First-Run Setup Wizard — NOT BUILT
A new installation requires manually configuring the `.env`, running `docker compose up`, and knowing which ports to open. There is no guided setup for non-technical users.

**What to do:** Build a first-run wizard that configures SMTP, creates the first admin user, sets the domain, and validates the agent registration secret. This is table stakes for any self-hosted SaaS.

---

#### 8. Documentation — PARTIAL
There is internal developer documentation (`SESSION.md`, `MOBILITY.md`, `AUDIT_TASKS.md`) but no user-facing documentation: no installation guide, no agent deployment guide, no feature reference, no API docs (FastAPI auto-docs exist but are not curated).

**What to do:** Write an installation guide, agent deployment guide, and at least a getting-started walkthrough. Without documentation, self-hosted customers will flood your support channels.

---

#### 9. WhatsApp Bridge Stability
The WhatsApp bridge uses `whatsapp-web.js`, which is an unofficial library that reverse-engineers the WhatsApp Web protocol. Meta (WhatsApp's parent) actively attempts to block automated clients. Session tokens expire, QR codes need re-scanning, and the library breaks on WhatsApp Web updates.

**What to do:**
- Add a health check endpoint on the WhatsApp bridge
- Build a UI for re-scanning the QR code without server access
- Consider migrating to the official WhatsApp Business API (requires Meta approval and has costs)
- Document the instability risk clearly for customers

**Why it matters:** If you sell this as a feature and it breaks after a WhatsApp update, customers will be angry. It is a differentiator but also a liability.

---

#### 10. Monitoring Concurrency
The monitoring endpoint still has a potential deadlock when two simultaneous check runs occur. The current fix catches the exception gracefully, but the underlying cause (no locking strategy) remains. Under load with many monitors this will be a recurring issue.

**What to do:** Add `SELECT FOR UPDATE SKIP LOCKED` on the monitors table so concurrent workers each claim a distinct subset of monitors to check rather than racing on all of them.

---

### NICE TO HAVE before open sourcing

#### 11. Test Coverage — MINIMAL
There are no automated tests visible in the codebase. Before open sourcing, the lack of tests means:
- Contributors cannot safely submit pull requests
- Regressions are caught in production, not CI

**What to do:** Add at minimum integration tests for auth, agent registration, patch dispatch, and monitoring. Use pytest + httpx for the FastAPI backend.

---

#### 12. API Versioning
All endpoints are under `/api/v1/` but there is no formal deprecation policy or changelog. When the API changes, existing agent integrations or customer scripts break with no warning.

---

#### 13. OpenAPI / SDK
The FastAPI auto-generated OpenAPI schema exists but is not exposed publicly or used to generate client SDKs. For an open-source platform with a public API, a published OpenAPI spec and generated Python/JS SDKs are expected.

---

## Launch Readiness Summary

| Area | Ready? | Notes |
|------|--------|-------|
| Core RMM functionality | ✅ Yes | Agents, monitoring, patching, AD all work |
| Security hardening | ⚠️ Mostly | 21/23 tasks done — TASK-17 and TASK-23 pending |
| Secrets management | ❌ No | .env in plaintext — must fix before any public code |
| Multi-tenancy | ❌ No | Single-org only — needed for SaaS |
| Billing / licensing | ❌ No | Cannot charge without this |
| Agent auto-update safety | ⚠️ Partial | No rollback mechanism |
| Documentation | ⚠️ Partial | Internal only, no user-facing guides |
| WhatsApp stability | ⚠️ Risky | Unofficial API, can break on WhatsApp updates |
| Test coverage | ❌ No | No automated tests |
| Email deliverability | ⚠️ Partial | Custom SMTP only |
| First-run setup | ❌ No | Manual Docker configuration required |

### Minimum viable to launch (private beta / single customer):
Complete TASK-23 (secrets), wire TASK-17 (syslog), and document the installation process.
Everything else can follow in iterations.

### Minimum viable to open source:
Complete TASK-23 first (ensure no secrets in git history), add a basic installation guide,
and remove any hardcoded values specific to Kenyan Nut's deployment.

### Minimum viable for paid SaaS:
Multi-tenant isolation, billing integration, first-run wizard, and agent rollback mechanism.
All four are foundational — missing any one of them creates an unacceptable customer experience.
