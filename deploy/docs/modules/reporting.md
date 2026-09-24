# Reporting

Kifaa generates PDF and Excel reports covering patch compliance, software inventory, and agent uptime. Reports can be generated on demand or delivered automatically on a schedule.

## Report Types

| Report | Format | Contents |
|--------|--------|---------|
| **Patch Compliance** | PDF, Excel | Per-agent patch status, missing update count, compliance score |
| **Software Inventory** | PDF, Excel | Installed software across the fleet — name, version, publisher, install date |
| **Agent Inventory** | PDF, Excel | Hardware, OS, agent version, group, last seen for all agents |
| **Uptime / Availability** | PDF | Endpoint check results, availability percentage, downtime events |
| **Alert Summary** | PDF | Alerts fired in the period, severity distribution, MTTR |
| **Per-Agent Detail** | PDF | Full detail for one machine: hardware, software, services, metrics, events |

---

## Generating a Report on Demand

1. Navigate to **Reports**
2. Select the report type
3. Choose the scope: all agents, a group, or specific machines
4. Select the time range (for time-based reports)
5. Choose the output format (PDF or Excel)
6. Click **Generate** — the report downloads immediately

---

## Scheduled Report Delivery

Automatically email reports to recipients on a schedule.

### Creating a scheduled report

1. Go to **Reports → Schedules → New**
2. Configure:
   - **Report type** and scope
   - **Format** (PDF / Excel)
   - **Recipients** — comma-separated email addresses
   - **Schedule** — cron expression or preset (Daily, Weekly, Monthly)
3. Click **Save**

Example schedules:
| Frequency | Cron |
|-----------|------|
| Every Monday morning at 8am | `0 8 * * 1` |
| First day of month at 6am | `0 6 1 * *` |
| Every day at 7am | `0 7 * * *` |

Reports are generated and emailed automatically. If email delivery fails, the report is stored for 7 days and a notification appears in the UI.

---

## PDF Report Layout

PDF reports include:
- Cover page with company name/logo, report title, generated date, and scope
- Summary section with key metrics and charts
- Detailed data tables
- Page numbers and header/footer with timestamp

To configure the company name and logo shown on reports:

```env
COMPANY_NAME=Acme Corporation
COMPANY_LOGO_URL=https://yourdomain.com/logo.png
```

---

## Excel Report Layout

Excel reports are formatted workbooks with:
- Summary sheet with totals and charts
- Data sheet with one row per agent/software/patch
- Column headers, auto-filter, and frozen header rows
- Conditional formatting (e.g. red for non-compliant, green for compliant)

---

## Per-Agent Detail Report

The most detailed report — covers everything Kifaa knows about a single machine:

- System info: hostname, OS, IP, CPU, RAM, disks
- Installed software (full list with versions)
- Running services and their status
- Recent alerts and events
- Disk usage per volume with trend
- Patch history

Generate from **Agents → [agent name] → Generate Report** or from the Reports page.

---

## Report Storage

Generated reports are stored in `data/reports/` for 30 days. After that they are automatically pruned. Download again from the UI or configure scheduled delivery to always have a copy.

---

## API

```bash
# Generate a patch compliance report (returns PDF)
curl -X POST https://YOUR_SERVER/api/v1/reports/generate \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type": "patch_compliance", "format": "pdf", "scope": "all"}' \
  --output patch_report.pdf

# List scheduled reports
curl https://YOUR_SERVER/api/v1/reports/schedules \
  -H "Authorization: Bearer YOUR_TOKEN"
```
