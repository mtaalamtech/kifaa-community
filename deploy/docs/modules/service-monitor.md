# Service Monitor

The Service Monitor watches specific Windows services and Linux systemd units on your managed endpoints. When a monitored service stops, Kifaa automatically sends a restart command and logs the outcome.

## Use case

Servers that reboot (e.g. after patch deployment or power cycle) sometimes fail to start dependent services — Remote Desktop Connection Broker, SQL Server, IIS, or custom application services. Without monitoring, the failure goes unnoticed until users report a problem.

The Service Monitor closes that gap: it detects the stopped service within 2 minutes and restarts it automatically, logging whether the restart succeeded.

---

## How It Works

1. The agent reports all running/stopped services every 30 seconds in its heartbeat
2. A Celery task runs every 2 minutes and checks for stopped services that have `auto_restart = true`
3. If a monitored service is stopped and no restart has been attempted in the last 2 minutes, a `service_control` command is queued for the agent
4. The agent executes `sc start <service>` (Windows) or `systemctl start <unit>` (Linux) and reports the result
5. The result is logged as a `service_monitor_event` (succeeded or failed, with the full error message)

---

## Adding a Service to Monitor

### From the UI

1. Navigate to **Service Monitor**
2. Click **Add Service**
3. Search by service name (searches all agents simultaneously)
4. Select the service from the results
5. Enable **Auto-restart** if you want Kifaa to restart it automatically when stopped
6. Click **Add**

### Directly via the API

```bash
curl -X PATCH https://YOUR_SERVER/api/v1/services/SERVICE_ID/monitor \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"monitored": true, "auto_restart": true}'
```

---

## Dashboard

The Service Monitor page shows:
- **Total monitored** — number of services being watched
- **Currently stopped** — services that are not running right now
- **Auto-restart enabled** — services with automatic restart configured
- **Recent events** — a log of every auto-restart attempt with success/failure and error message

---

## Event Types

| Event | Meaning |
|-------|---------|
| `auto_restart` | A restart command was sent to the agent |
| `start_succeeded` | The agent confirmed the service started |
| `start_failed` | The agent tried to start the service but it failed — the Windows SCM error message is shown |

### Example error messages

- `The service did not respond to the start or control request in a timely fashion` — service startup timeout; check for a hanging startup script or dependency
- `The service did not start due to a logon failure` — service account credentials are invalid or account is locked
- `Access is denied` — the agent is running without sufficient privileges to start the service

---

## Agent Watchdog

The **Agent Watchdog** is a companion feature that watches the Kifaa agent itself rather than managed services.

If an agent stops reporting (its status is `offline`) but the endpoint is still reachable on the network (TCP probe succeeds on port 445 for Windows, 22 for Linux), the watchdog automatically attempts to restart the `KifaaAgent` Windows service or `kifaa-agent` systemd unit.

**Windows restart** — uses Active Directory credentials from your configured `ad_configs` record (same credentials used for domain operations — no additional setup required). Connects via SMB/SCM (port 445) using impacket.

**Linux restart** — uses the per-agent SSH credentials stored under **Agent → SSH Credentials**. Executes `systemctl start kifaa-agent`.

### Watchdog status classifications

| Status | Meaning |
|--------|---------|
| `online` | Agent reporting normally |
| `restart_ok` | Agent was offline, machine reachable, restart command sent |
| `restart_failed` | Machine reachable but restart attempt failed (error shown) |
| `offline` | Machine is not reachable on the network |
| `unknown` | No IP address recorded for this agent |

The watchdog runs every 5 minutes with a 10-minute cooldown per agent to avoid hammering machines that consistently fail.

### Enabling/disabling watchdog per agent

Toggle from the **Agent Watchdog** tab, or via API:

```bash
curl -X PATCH https://YOUR_SERVER/api/v1/agents/AGENT_ID/watchdog \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"enabled": true}'
```
