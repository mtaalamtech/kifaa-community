# Agent Deployment

The Kifaa agent is a single binary (~7MB, zero runtime dependencies) that self-registers with the server on first run, then sends heartbeats every 30 seconds.

## Prerequisites

- Server must be running and reachable from your endpoints
- You need the **Agent Registration Key** from your `.env` (`AGENT_REGISTRATION_KEY`)
- Agents require outbound HTTP access to your server on port 80 (or 443 for HTTPS)

---

## Windows

### Single machine (PowerShell — run as Administrator)

```powershell
$server  = "http://YOUR_SERVER_IP"
$regKey  = "YOUR_REGISTRATION_KEY"
$dest    = "C:\Program Files\KifaaAgent\kifaa-agent.exe"

New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
Invoke-WebRequest "$server/downloads/kifaa-agent-windows-amd64.exe" -OutFile $dest
& $dest --install --server $server --key $regKey
```

This creates a Windows Service (`KifaaAgent`) set to Automatic start and registers the machine with the server.

### Verify

```powershell
Get-Service KifaaAgent
# Should show: Status=Running
```

### Uninstall

```powershell
& "C:\Program Files\KifaaAgent\kifaa-agent.exe" --uninstall
```

### Mass deployment — Group Policy (GPO)

1. Place the agent binary on a network share: `\\fileserver\Tools\kifaa-agent.exe`
2. Create a GPO Startup Script with:
   ```bat
   @echo off
   if exist "C:\Program Files\KifaaAgent\kifaa-agent.exe" exit /b 0
   mkdir "C:\Program Files\KifaaAgent" 2>nul
   copy "\\fileserver\Tools\kifaa-agent.exe" "C:\Program Files\KifaaAgent\kifaa-agent.exe"
   "C:\Program Files\KifaaAgent\kifaa-agent.exe" --install --server http://YOUR_SERVER_IP --key YOUR_KEY
   ```
3. Link the GPO to the target OU and force a group policy update: `gpupdate /force`

The `if exist` guard ensures the installer only runs once. Machines already running the agent skip the script.

### Mass deployment — PowerShell remoting / Ansible

```powershell
# PowerShell remoting (WinRM)
$computers = Get-Content computers.txt
$server    = "http://YOUR_SERVER_IP"
$regKey    = "YOUR_REGISTRATION_KEY"

Invoke-Command -ComputerName $computers -ScriptBlock {
    param($srv, $key)
    $dest = "C:\Program Files\KifaaAgent\kifaa-agent.exe"
    if (Test-Path $dest) { return "already installed" }
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    Invoke-WebRequest "$srv/downloads/kifaa-agent-windows-amd64.exe" -OutFile $dest
    & $dest --install --server $srv --key $key
} -ArgumentList $server, $regKey
```

---

## Linux (systemd)

### Single machine

```bash
SERVER="http://YOUR_SERVER_IP"
REG_KEY="YOUR_REGISTRATION_KEY"

curl -fsSL "$SERVER/downloads/kifaa-agent-linux-amd64" -o /usr/local/bin/kifaa-agent
chmod +x /usr/local/bin/kifaa-agent
kifaa-agent --install --server "$SERVER" --key "$REG_KEY"
```

This creates a systemd service unit (`kifaa-agent.service`) enabled to start on boot.

### Verify

```bash
systemctl status kifaa-agent
# Should show: active (running)
```

### Uninstall

```bash
kifaa-agent --uninstall
```

### Mass deployment — Ansible

```yaml
# deploy_kifaa_agent.yml
- name: Deploy Kifaa agent
  hosts: all
  become: yes
  vars:
    server_url: "http://YOUR_SERVER_IP"
    reg_key: "YOUR_REGISTRATION_KEY"

  tasks:
    - name: Check if agent is already installed
      stat:
        path: /usr/local/bin/kifaa-agent
      register: agent_binary

    - name: Download agent binary
      get_url:
        url: "{{ server_url }}/downloads/kifaa-agent-linux-amd64"
        dest: /usr/local/bin/kifaa-agent
        mode: '0755'
      when: not agent_binary.stat.exists

    - name: Install agent service
      command: "/usr/local/bin/kifaa-agent --install --server {{ server_url }} --key {{ reg_key }}"
      when: not agent_binary.stat.exists

    - name: Ensure agent service is running
      systemd:
        name: kifaa-agent
        state: started
        enabled: yes
```

```bash
ansible-playbook deploy_kifaa_agent.yml -i inventory.ini
```

### Mass deployment — shell script

```bash
#!/bin/bash
SERVER="http://YOUR_SERVER_IP"
REG_KEY="YOUR_REGISTRATION_KEY"
HOSTS="server1 server2 server3"

for host in $HOSTS; do
    echo "Deploying to $host..."
    ssh "$host" "
        curl -fsSL $SERVER/downloads/kifaa-agent-linux-amd64 -o /usr/local/bin/kifaa-agent
        chmod +x /usr/local/bin/kifaa-agent
        /usr/local/bin/kifaa-agent --install --server $SERVER --key $REG_KEY
    " && echo "  OK" || echo "  FAILED"
done
```

---

## Agent Self-Update

Once agents are registered, you can push a new agent version to the entire fleet from the UI:

1. Build the new agent binary and place it in `agent/builds/`
2. Go to **Agents → Fleet** in the UI
3. Click **Update All Agents** (or select individual agents)

Agents download the new binary from the server and restart themselves. The update takes effect within 30 seconds (next heartbeat cycle).

---

## Troubleshooting

### Agent shows as "offline" immediately after install

- Verify the server is reachable: `curl http://YOUR_SERVER_IP/api/v1/health`
- Check the agent log:
  - Windows: `Get-Content "C:\Program Files\KifaaAgent\kifaa-agent.log" -Tail 50`
  - Linux: `journalctl -u kifaa-agent -n 50`

### Windows — "The service did not start due to a logon failure"

The agent runs as Local System by default. If your environment requires a specific account, modify the service: `sc config KifaaAgent obj= "NT AUTHORITY\LocalService"`

### Windows Server 2008 R2

The Go 1.21+ agent binary requires Windows Server 2012 R2 or later. Server 2008 R2 is not supported. These machines will appear with agent version `legacy` and limited functionality.

### Firewall rules

The agent only makes **outbound** HTTP connections to the server. No inbound ports need to be opened on the endpoint. Ensure the following is allowed:

| Direction | Protocol | Port | Destination |
|-----------|----------|------|-------------|
| Outbound  | TCP      | 80   | Kifaa server IP |
| Outbound  | TCP      | 443  | Kifaa server IP (if using HTTPS) |
