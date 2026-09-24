# Patch Management

Kifaa's patch management module detects missing updates on managed endpoints and lets you deploy them individually, in bulk, or on a schedule.

## How It Works

1. **Scan** — the server sends a `scan_patches` command to the agent. The agent queries the OS for available updates and reports them back.
   - **Windows**: queries Windows Update API (equivalent to `Get-WindowsUpdate`)
   - **Linux**: reads available upgrades from the package manager (`apt`, `yum`, `dnf`)
2. **Review** — the server lists discovered patches per endpoint, including package name, current version, available version, and category
3. **Deploy** — you select patches and click Deploy. The server queues a `install_patches` command; the agent executes the installation and streams output back in real time
4. **Verify** — the patch list refreshes after install to confirm the update applied

Patches are never stored on the server — they download directly on each endpoint from the OS vendor or package mirror.

---

## Running a Patch Scan

### From the UI

1. Navigate to **Patch Management → Scan**
2. Click **Scan All** to queue a scan on every online agent, or select specific machines
3. Results appear within 1-3 minutes (depending on agent count and Windows Update service response time)

### Via API

```bash
# Scan a single agent
curl -X POST https://YOUR_SERVER/api/v1/patches/scan/AGENT_ID \
  -H "Authorization: Bearer YOUR_TOKEN"

# Scan all agents
curl -X POST https://YOUR_SERVER/api/v1/patches/scan/all \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Deploying Patches

### Manual deploy

1. Go to **Patch Management → Pending**
2. Filter by machine, category, or severity
3. Select the patches to install (or "Select All")
4. Click **Deploy**
5. Watch live output in the job panel on the right

### Deploy to a group

1. Go to **Patch Management → By Group**
2. Select a group (e.g. "Servers")
3. Click **Deploy All Pending** — patches are queued for every online machine in the group

---

## Scheduled Patching

Define maintenance windows to automatically patch machines without manual intervention.

1. Navigate to **Patch Management → Schedules**
2. Click **New Schedule**
3. Configure:
   - **Name** — e.g. "Wednesday Server Patching"
   - **Target** — all agents, a group, or specific machines
   - **Schedule** — recurring (cron expression) or one-time
   - **Categories** — filter by Security, Critical, etc.
   - **Auto-reboot** — reboot after patching if required

Example cron expressions:
| Schedule | Cron |
|----------|------|
| Every Wednesday at 2am | `0 2 * * 3` |
| First Sunday of month at 11pm | `0 23 1-7 * 0` |
| Daily at 3am | `0 3 * * *` |

---

## Patch Job Tracking

Every patch operation creates a **Job** with:
- Start time, finish time
- Exit status (success / failure)
- Full console output (streamed live, retained for audit)
- Per-package result

Navigate to **Patch Management → Jobs** to see the history.

---

## Patch Compliance Dashboard

The **Compliance** tab shows:
- Percentage of endpoints fully patched
- Breakdown by missing patch count (0, 1-5, 6-20, 20+)
- Per-group compliance scores
- Trend over time (30-day rolling)

---

## SSH Credentials for Linux

Deploying patches on Linux requires SSH access. Configure credentials per agent:

1. Go to **Agents → [agent name] → SSH Credentials**
2. Enter username, password or SSH private key
3. Enable "Use sudo" if the account is not root

Credentials are encrypted at rest using Fernet symmetric encryption.

---

## Windows Update Caveats

- **Windows Update Service** must be running on the endpoint (`wuauserv`). If stopped, scans return empty results.
- **WSUS environments** — if endpoints point to a WSUS server, Kifaa inherits the approved update list from WSUS. Configure WSUS approval before running scans.
- **Reboot pending** — some patches require a reboot before the system reports them as installed. The agent reports `reboot_required: true` for these.
