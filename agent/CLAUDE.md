# Kifaa Agent — Go Agent

## Overview
Lightweight Go agent that runs on Windows/Linux endpoints. Sends heartbeats, collects inventory, patches, security state, RDP sessions, etc. to the Kifaa server.

## Build Commands
```bash
cd /opt/kifaa/agent/modern

# Windows (most common)
GOOS=windows GOARCH=amd64 go build -o ../builds/kifaa-agent-windows-amd64.exe ./cmd/kifaa-agent/
GOOS=windows GOARCH=386   go build -o ../builds/kifaa-agent-windows-386.exe   ./cmd/kifaa-agent/

# Windows legacy (Go 1.20 compat, no AD — for Win 2008R2/Win7)
GOOS=windows GOARCH=amd64 go build -tags noad -o ../builds/kifaa-agent-windows-amd64-legacy.exe ./cmd/kifaa-agent/

# Linux
GOOS=linux GOARCH=amd64 go build -o ../builds/kifaa-agent-linux-amd64 ./cmd/kifaa-agent/
GOOS=linux GOARCH=arm64 go build -o ../builds/kifaa-agent-linux-arm64 ./cmd/kifaa-agent/
```
Built binaries go to `agent/builds/` which is volume-mounted into kifaa-api and served at `/downloads/`.

## Directory Structure
```
modern/
├── cmd/kifaa-agent/
│   └── main.go          ← main loop, inventory cycle, command polling
├── internal/
│   ├── collector/       ← data collectors
│   │   ├── apply_windows.go      ← patch apply via WUA COM/winget
│   │   ├── patches_windows.go    ← patch scan (Windows Update)
│   │   ├── rdp_sessions_windows.go  ← RDP session collector (TerminalServices events)
│   │   ├── rdp_sessions_others.go   ← stub for non-Windows
│   │   ├── security_windows.go   ← firewall, RDP, AV, BitLocker state
│   │   ├── ad_events_windows.go  ← AD lockout/logon events (4740, 4625, etc.)
│   │   ├── hardware.go           ← CPU, RAM, disk
│   │   └── software.go           ← installed software list
│   ├── reporter/
│   │   └── reporter.go  ← HTTP client (all SendXxx methods)
│   └── config/
│       └── config.go    ← config file parsing
└── builds/              ← compiled binaries
```

## Main Agent Loop (main.go)
- **Heartbeat:** every 30s — sends metrics, service states, IP
- **Inventory:** every 3600s (1h) — hardware, software, security, RDP sessions, patches
- **Command poll:** every 5s — checks for pending commands (restart, patch-apply, etc.)

## Adding a New Collector
1. Create `collector/feature_windows.go` with `//go:build windows` tag
2. Create `collector/feature_others.go` with `//go:build !windows` tag (stub returning nil/empty)
3. Add `SendFeature()` method to `reporter/reporter.go`
4. Call `go runFeatureReport(rep)` inside `sendInventory()` in `main.go`
5. Create server endpoint `POST /api/v1/agents/feature` to receive data

## Agent Config File (on endpoint)
Location: `C:\ProgramData\KifaaAgent\config.json` (Windows) or `/etc/kifaa-agent/config.json` (Linux)
```json
{
  "server_url": "https://kifaa.kenyanut.com",
  "agent_id": "uuid",
  "api_key": "hex-string",
  "heartbeat_interval_seconds": 30,
  "inventory_interval_seconds": 3600,
  "insecure_skip_verify": true
}
```
`insecure_skip_verify: true` is required when server uses self-signed certificate.

## Current Agent Version
`CURRENT_AGENT_VERSION = "1.4.2"` (defined in `agent_deploy.py` and `config.go`)

## Windows Patch Apply Logic (apply_windows.go)
- KB-prefixed packages → WUA COM API via PowerShell
- Other packages → winget
- Result codes: 2=success, 3=success_with_errors, 4=failed, 5=aborted (SQL Server conflict → retry after stopping SQL services)
- "No pending update found" → treated as success (already installed)

## RDP Session Collector (rdp_sessions_windows.go)
- Reads `Microsoft-Windows-TerminalServices-LocalSessionManager/Operational` event log
- Event 21 = logon, 23 = logoff, 24 = disconnect, 25 = reconnect
- Correlates logon/logoff by SessionID to compute duration
- Collects last 25h each inventory cycle
- Sent to `POST /api/v1/agents/rdp-sessions`
