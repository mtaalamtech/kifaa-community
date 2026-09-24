# KIFAA SECURITY REMEDIATION TASKS
**Generated from:** KIFAA_AUDIT.md — 2026-06-19

Tasks are ordered by priority. Complete PHASE 1 before deploying to any external network.

---

## PHASE 1 — CRITICAL (Do before next user session)

- [x] **TASK-01** Fix unauthenticated user creation endpoint  
  File: `server/api/routers/auth.py` — `POST /auth/users`  
  Add `_=Depends(require_admin)` to the endpoint signature.  
  Also prevent callers from self-assigning `role=admin`.  
  Ref: Audit C1

- [x] **TASK-02** Fix SQL injection in agent metrics heartbeat  
  File: `server/api/routers/agents.py` ~line 140  
  Replace f-string SQL with parameterized `executemany()` using bound params.  
  Ref: Audit C2

- [x] **TASK-03** Fix SQL injection in software inventory deletion  
  File: `server/api/routers/agents.py` ~line 243  
  Replace `f"...'{agent.id}'"` with `text("... :id"), {"id": str(agent.id)}`.  
  Ref: Audit C3

- [x] **TASK-04** Rotate all secrets in .env  
  Generate new values for: `API_SECRET_KEY`, `AGENT_REGISTRATION_SECRET`,
  `POSTGRES_PASSWORD`, `BOT_SECRET`, `TELEGRAM_TOKEN`.  
  Use `openssl rand -hex 64` for the API key.  
  Audit git history to confirm `.env` was never committed.  
  Ref: Audit C4

- [x] **TASK-05** Add authentication to all public agent endpoints  
  File: `server/api/routers/agents.py`  
  Add `_=Depends(get_current_user)` to: list_agents, get_agent, get_services,
  get_software, get_metrics, get_history, stats/dashboard, and any other
  GET endpoints missing it.  
  Ref: Audit H1

---

## PHASE 2 — HIGH (Complete within 48 hours)

- [x] **TASK-06** Enforce HTTPS and add HSTS  
  File: `nginx/conf.d/kifaa.conf`  
  Add HTTP→HTTPS redirect on port 80.  
  Add `Strict-Transport-Security` header on port 443.  
  Verify SSL certificate is valid and auto-renews.  
  Ref: Audit M3, L2

- [x] **TASK-07** Restrict CORS to known origins  
  File: `server/api/main.py`  
  Change `allow_origins=["*"]` to `allow_origins=["https://kifaa.kenyanut.com"]`.  
  Ref: Audit H3

- [x] **TASK-08** Strengthen JWT configuration  
  File: `.env`, `server/api/config.py`  
  Set `API_SECRET_KEY` to 64-byte random value (see TASK-04).  
  Reduce `ACCESS_TOKEN_EXPIRE_MINUTES` from 1440 to 60.  
  Implement Redis-backed token blacklist so logout actually invalidates tokens.  
  Ref: Audit H4

- [x] **TASK-09** Add object-level authorization checks  
  File: All routers  
  After `get_current_user`, verify the user has rights to the specific agent/resource.  
  Viewer role: read-only, own-group agents only.  
  Operator role: read-write, assigned agents only.  
  Admin role: full access.  
  Ref: Audit H2

- [x] **TASK-10** Restrict phishing module to admin role  
  File: `server/api/routers/phishing.py`  
  Add `_=Depends(require_admin)` to all campaign create/send endpoints.  
  Add campaign approval state machine (draft → approved → sent).  
  Encrypt stored phishing credentials at rest.  
  Ref: Audit H7

- [x] **TASK-11** Fix SSH host key verification  
  File: `server/api/routers/terminal.py`  
  Remove `known_hosts: None`.  
  Store host key fingerprint in `agent_ssh_credentials` on first connection.  
  Verify on all subsequent connections; reject on mismatch with UI warning.  
  Ref: Audit H6

- [x] **TASK-12** Replace URL-based WebSocket tokens with one-time tickets  
  File: `server/api/routers/terminal.py`, new endpoint needed  
  Create `GET /api/v1/terminal/ticket` (auth required) → stores UUID in Redis (30s TTL).  
  WebSocket connects with `?ticket=<uuid>` instead of `?token=<jwt>`.  
  Server exchanges ticket for user identity at connect time.  
  Ref: Audit H5

---

## PHASE 3 — MEDIUM (Complete within 1 week)

- [x] **TASK-13** Add rate limiting to login and registration endpoints  
  Add `slowapi` or `fastapi-limiter` package.  
  Limits: login 5 req/min per IP, registration 10 req/hour per IP.  
  Add nginx `limit_req_zone` as a second layer.  
  Ref: Audit M1

- [x] **TASK-14** Encrypt SSH/RDP credentials stored in database  
  File: `server/api/routers/terminal.py`, `server/api/models/models.py`  
  Use `cryptography.fernet.Fernet` to encrypt `password` and `ssh_key` fields before INSERT.  
  Decrypt on read. Store `FERNET_KEY` in secrets manager / environment only.  
  Ref: Audit M2

- [x] **TASK-15** Bind syslog port to loopback only  
  File: `docker-compose.yml` line 69  
  Change `"514:5140/udp"` to `"127.0.0.1:514:5140/udp"`.  
  Add source IP validation in the syslog handler.  
  Ref: Audit M4

- [x] **TASK-16** Disable nginx autoindex on downloads directory  
  File: `nginx/conf.d/kifaa.conf`  
  Change `autoindex on` to `autoindex off` in the `/downloads/` location block.  
  Ref: Audit M5

- [x] **TASK-17** Forward audit logs to external syslog  
  File: `server/api/` — logging configuration  
  Implemented: `audit_log.py` uses `RotatingFileHandler` (50MB, 10 backups → `/app/logs/audit.log`) always active; optional `SysLogHandler` forwarding if `SYSLOG_HOST` is set. `main.py` calls `configure_audit_logging()` on startup. `docker-compose.yml` mounts `./data/logs:/app/logs` for persistence.  
  Ref: Audit M6

- [x] **TASK-18** Tighten RDP certificate and security settings  
  File: `server/api/routers/terminal.py`  
  Change default `security` from `any` to `tls`.  
  Change `ignore-cert` to `false` by default.  
  Add a per-agent UI checkbox "Skip certificate check" that requires explicit user action.  
  Ref: Audit M7

---

## PHASE 4 — LOW (Complete within 1 month)

- [x] **TASK-19** Enforce strong password policy  
  File: `server/api/routers/auth.py`  
  Minimum 12 characters, at least 1 uppercase, 1 number, 1 special character.  
  Add validation in both create_user and change_password endpoints.  
  Ref: Audit L1

- [x] **TASK-20** Add missing security headers to nginx  
  File: `nginx/nginx.conf`  
  Add: `Content-Security-Policy`, `Referrer-Policy`, `Permissions-Policy`.  
  Ref: Audit L2

- [x] **TASK-21** Remove default admin password from init.sql  
  File: `server/sql/init.sql`  
  Remove the hardcoded bcrypt hash.  
  On first startup with no users, generate a random temp password, print to container
  stdout, and set a `password_must_change = true` flag on the admin account.  
  Force password change on first login in the frontend.  
  Ref: Audit L3

- [x] **TASK-22** Add Content Security Policy to frontend  
  File: `frontend/` — build config or nginx  
  Configure CSP to restrict script sources, prevent inline scripts, block framing.  
  Test thoroughly — React SPAs often need `'unsafe-inline'` exceptions documented.  
  Ref: Audit L2

- [x] **TASK-23** Implement secrets management  
  Implemented: 9 Docker file-based secrets in `./secrets/` (dir chmod 700, files chmod 600). `docker-compose.yml` declares all secrets and mounts them at `/run/secrets/<name>`. `config.py` uses `pydantic-settings` `secrets_dir="/run/secrets"`. `docker-entrypoint.sh` reads secret files at container startup and exports `POSTGRES_PASSWORD`/`DATABASE_URL`/`SYNC_DATABASE_URL` into the process environment (invisible to `docker inspect`). `.env` retains only non-sensitive config.  
  Ref: Audit C4

---

## PROGRESS TRACKING

| Task | Owner | Status | Completed |
|------|-------|--------|-----------|
| TASK-01 | Claude Code | Done | 2026-06-19 |
| TASK-02 | Claude Code | Done | 2026-06-19 |
| TASK-03 | Claude Code | Done | 2026-06-19 |
| TASK-04 | Claude Code | Done | 2026-06-19 |
| TASK-05 | Claude Code | Done | 2026-06-19 |
| TASK-06 | Claude Code | Done | 2026-06-19 |
| TASK-07 | Claude Code | Done | 2026-06-19 |
| TASK-08 | Claude Code | Done | 2026-06-19 |
| TASK-09 | Claude Code | Done | 2026-06-19 |
| TASK-10 | Claude Code | Done | 2026-06-19 |
| TASK-11 | Claude Code | Done | 2026-06-19 |
| TASK-12 | Claude Code | Done | 2026-06-19 |
| TASK-13 | Claude Code | Done | 2026-06-19 |
| TASK-14 | Claude Code | Done | 2026-06-19 |
| TASK-15 | Claude Code | Done | 2026-06-19 |
| TASK-16 | Claude Code | Done | 2026-06-19 |
| TASK-17 | Claude Code | Done | 2026-06-27 |
| TASK-18 | Claude Code | Done | 2026-06-19 |
| TASK-19 | Claude Code | Done | 2026-06-19 |
| TASK-20 | Claude Code | Done | 2026-06-19 |
| TASK-21 | Claude Code | Done | 2026-06-19 |
| TASK-22 | Claude Code | Done | 2026-06-19 |
| TASK-23 | Claude Code | Done | 2026-06-27 |
