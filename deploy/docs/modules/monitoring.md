# Monitoring & Alerting

Kifaa provides several layers of monitoring: agent metrics (CPU, memory, disk), external endpoint checks (port, HTTP, ICMP), and alert rules that fire when thresholds are breached.

## Agent Metrics

Every agent reports the following metrics every 30 seconds via heartbeat:

| Metric | Description |
|--------|-------------|
| `cpu_percent` | Overall CPU utilisation (%) |
| `memory_percent` | RAM used (%) |
| `disk_percent` | Disk usage per volume (%) |
| `disk_read_mbps` | Disk read throughput |
| `disk_write_mbps` | Disk write throughput |
| `net_sent_mbps` | Network TX throughput |
| `net_recv_mbps` | Network RX throughput |

Metrics are stored in a TimescaleDB hypertable with 30-day retention and 1-hour continuous aggregates for trend graphs.

### Viewing metrics

Go to **Agents → [agent name] → Metrics** to see real-time and historical graphs.

---

## External Endpoint Checks

Endpoint checks run from the Kifaa **server** (not agents) and verify that services are reachable from the network.

### Supported check types

| Type | Description |
|------|-------------|
| **Port** | TCP connect to host:port — verifies the port is listening |
| **HTTP** | HTTP GET — verifies status code and optional content match |
| **HTTPS** | HTTPS GET — also checks TLS certificate validity and expiry |
| **ICMP (ping)** | Ping — verifies the host is reachable at network layer |
| **DNS** | Resolve a hostname — verifies DNS resolution returns expected IP |

### Adding a check

1. Go to **Monitoring → Endpoint Checks**
2. Click **Add Check**
3. Configure target, check type, interval (default 60s), and alert threshold

### Check intervals

Checks run on a configurable interval (1-60 minutes). The Celery beat scheduler triggers checks. Status history is stored for 30 days.

---

## Alert Rules

Alert rules define conditions that trigger notifications. The default rules are:

| Rule | Condition | Severity |
|------|-----------|----------|
| High CPU Usage | cpu_percent > 90 | Warning |
| Critical CPU Usage | cpu_percent > 98 | Critical |
| High Memory Usage | memory_percent > 90 | Warning |
| Low Disk Space | disk_percent > 85 | Warning |
| Critical Disk Space | disk_percent > 95 | Critical |
| Agent Offline | no heartbeat > 5 min | Critical |

### Creating a custom rule

1. Go to **Monitoring → Alert Rules → New Rule**
2. Set the metric, condition, threshold, and severity
3. Choose scope: all agents, a specific group, or a single agent
4. Configure notification channels (email)
5. Set a cooldown period to avoid alert spam

### Alert lifecycle

```
OPEN → (acknowledged by operator) → ACKNOWLEDGED → (condition clears) → RESOLVED
```

Open and acknowledged alerts appear on the dashboard. Resolved alerts move to history.

---

## Email Notifications

Configure SMTP in `.env` to receive alert emails:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=alerts@yourdomain.com
SMTP_PASSWORD=your-app-password
SMTP_TLS=true
ALERT_FROM=kifaa@yourdomain.com
ALERT_EMAIL=admin@yourdomain.com,ops@yourdomain.com
```

Alert emails include:
- Agent name and IP
- Metric name, current value, threshold
- Timestamp
- Direct link to the agent detail page

---

## Alert History

Navigate to **Monitoring → Alert History** to see every alert that has ever fired, including when it opened, when it was acknowledged, and when it resolved.

---

## Dashboard

The main dashboard shows:
- Fleet summary: online / offline / warning counts
- Active alerts (by severity)
- Patch compliance score
- Recent agent activity
- Top-N endpoints by CPU, memory, disk

The dashboard auto-refreshes every 30 seconds.
