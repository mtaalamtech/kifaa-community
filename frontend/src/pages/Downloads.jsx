import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Download, Terminal, Monitor, Server, Copy, CheckCheck, Info, Shield,
  ChevronDown, ChevronRight, Wifi, WifiOff, Search, Zap, Play,
  CheckCircle, XCircle, Loader, AlertTriangle, Plus, Trash2, X, KeyRound,
  Clock, CheckCircle2, History, RefreshCw, BookOpen, Tag, Star,
} from 'lucide-react'
import api from '../api/client'

// ── Release Notes Data ────────────────────────────────────────────────────────

const CURRENT_VERSION = '1.4.0'

const CHANGELOG = [
  {
    version: '1.4.0',
    date: '2026-06-12',
    tag: 'latest',
    summary: 'Multi-AV detection, SIEM, virtualization integrations, compliance improvements',
    changes: {
      'New Features': [
        'SIEM: UDP syslog receiver (port 514) + REST event ingestion with TimescaleDB hypertable storage',
        'SIEM: Real-time event viewer with timeline chart, source breakdown, agent attribution, and 30-second auto-refresh',
        'VMware vCenter integration: VM/host/datastore/cluster inventory with HA/DRS status',
        'Proxmox VE integration: VM and LXC container inventory, node resource usage, storage pools',
        'Nutanix Prism integration: VM/host/cluster inventory, alerts, v3 API with Prism Element fallback',
        'Integrations hub: plugin cards with status, last-sync timestamp, per-integration config modals and test-connection',
        'Celery auto-sync for all integrations (every 15 minutes)',
        'Exclude from Reports flag on agents — test/dev endpoints are filtered from compliance scores and executive reports',
        'Update Agent button on Agent Detail page with live status feedback',
      ],
      'Improvements': [
        'Windows AV detection now reports ALL installed AV products (comma-separated) instead of only the first one registered in Security Center',
        'Linux AV detection checks 16 known AV/EDR products (Sophos, ClamAV, ESET, Kaspersky, CrowdStrike, SentinelOne, Carbon Black, and more)',
        'Linux agents: missing AV is no longer flagged as a finding — absence is treated as not-applicable',
        'Compliance dashboard and per-agent scores now exclude agents marked as test environments',
        'Sophos Central, Office 365 integration dashboards with endpoint health and license utilization',
      ],
      'Bug Fixes': [
        'Fixed concurrent worker race condition on table creation at startup (UniqueViolationError on pg_type_typname_nsp_index)',
        'Fixed Proxmox/Nutanix column name mismatch between DB schema and sync tasks',
        'Fixed syslog UDP listener reporting as not bound (ss binary not present in container)',
      ],
    },
  },
  {
    version: '1.3.0',
    date: '2026-05-20',
    tag: null,
    summary: 'Terminal access, software deploy, Active Directory, database monitoring, patch compliance',
    changes: {
      'New Features': [
        'Web-based SSH/PowerShell terminal (WebSocket) for Linux and Windows agents',
        'RDP launcher shortcut on Windows agent detail page',
        'Remote software deployment with silent install/uninstall via agent commands',
        'Active Directory integration: users, groups, OUs, computers, password policy, domain info',
        'Database monitoring: MySQL, MSSQL, PostgreSQL connection health, version, and size checks',
        'Patch Compliance report: per-agent patching status with zero-day critical patch tracking',
        'IP Scanner with WebSocket live results and one-click remote agent deployment',
        'Agent remote deployment via WinRM (Windows) and SSH (Linux)',
        'Deployment history log with per-job live output',
      ],
      'Improvements': [
        'Agent detail page: tabs for services, software inventory, event history',
        'Service control (start/stop/restart) directly from agent detail',
        'Software uninstall with confirmation modal and progress feedback',
        'Agent groups with color coding and group assignment from agent list',
      ],
      'Bug Fixes': [
        'Fixed agent re-registration on IP change incorrectly creating duplicate records',
        'Fixed service status not updating after remote control action',
      ],
    },
  },
  {
    version: '1.2.0',
    date: '2026-04-15',
    tag: null,
    summary: 'SSL certificate manager, monitoring checks, alerts, report scheduling',
    changes: {
      'New Features': [
        'SSL Certificate Manager: CSR generation, certificate upload, expiry tracking, and renewal alerts',
        'Uptime/HTTP monitoring with configurable check intervals and alerting thresholds',
        'Monitor detail page with response-time history chart',
        'Alert inbox with severity levels (critical/warning/info), acknowledgement, and filtering',
        'Report Schedules: automated PDF/Excel reports sent via email on cron schedule',
        'Patch management: pending patches with CVE cross-reference and one-click approve/defer',
        'Compliance Dashboard: weighted scores across patching, vulnerabilities, configuration, endpoint protection, and licenses',
        'License inventory: Windows activation status, edition, and expiry tracking',
        'Threat intelligence: agent misconfiguration rules with pass/fail/warn per-agent status',
        'Storage monitoring: disk usage with per-drive warnings at 85%/90% thresholds',
      ],
      'Improvements': [
        'Dashboard summary cards: online/offline/warning agent counts, alert counts, patch counts',
        'Agent list with live search, OS filter, status filter, and group filter',
        'Executive PDF/Excel multi-sheet reports with compliance, patch, and agent data',
      ],
      'Bug Fixes': [
        'Fixed SSL certificate upload failing for certificates with intermediate chains',
        'Fixed monitoring check not clearing alert when endpoint recovers',
      ],
    },
  },
  {
    version: '1.1.0',
    date: '2026-03-10',
    tag: null,
    summary: 'Hardware inventory, security state collection, vulnerability scanning, agent self-update',
    changes: {
      'New Features': [
        'Hardware inventory: CPU model/cores, RAM, disks with usage bars, NICs with MAC addresses, GPU, BIOS/motherboard info',
        'Security state collection: firewall status, AV detection, SSH config, SELinux/AppArmor, disk encryption (LUKS/BitLocker), auto-updates',
        'Windows-specific: RDP status, SMBv1 detection, Guest account check, audit policy, password policy complexity',
        'Vulnerability scanning: CVE cross-reference for installed software versions',
        'Agent self-update: server queues update_agent command, agent downloads new binary and hot-swaps (Windows via scheduled task)',
        'Agent event history: hostname changes, IP changes, version upgrades, patch scans',
        'Asset tagging: custom tags, asset type (workstation/server/laptop), description field',
      ],
      'Improvements': [
        'Agent heartbeat now reports live CPU %, RAM %, disk usage per drive',
        'Agent checkin includes full software inventory (name, version, publisher, install date)',
        'Agent checkin includes running services with status and display name',
      ],
      'Bug Fixes': [
        'Fixed Windows inventory missing CPU model on multi-socket systems',
        'Fixed Linux disk free space reporting incorrectly for tmpfs mounts',
      ],
    },
  },
  {
    version: '1.0.0',
    date: '2026-02-01',
    tag: 'initial',
    summary: 'Initial release — agent registration, heartbeat, basic inventory',
    changes: {
      'New Features': [
        'Kifaa Agent for Windows (amd64, 386) and Linux (amd64, arm64)',
        'Agent registration with pre-shared secret and API key issuance',
        'Periodic heartbeat (30-second interval) with online/offline status tracking',
        'Basic system inventory: hostname, OS name/version/arch, IP address',
        'Windows installer (EXE and MSI) with automatic service registration',
        'Linux one-line install script with systemd service setup',
        'Web dashboard with agent list, status badges, last-seen timestamps',
        'JWT-based user authentication with admin/viewer roles',
        'Administration panel: user management, system settings',
        'Downloads page with OS-specific install instructions and copy-paste commands',
      ],
    },
  },
]

const REGISTRATION_SECRET = 'KifaaAgent@Register2026!'

function useServerUrl() {
  return `${window.location.protocol}//${window.location.hostname}${window.location.port && window.location.port !== '80' && window.location.port !== '443' ? ':' + window.location.port : ''}`
}

function detectOS() {
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('win')) return 'windows'
  if (ua.includes('linux')) return 'linux'
  return 'windows'
}

function CopyBtn({ text, className = '' }) {
  const [copied, setCopied] = useState(false)
  function copy() { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }
  return (
    <button onClick={copy} className={`flex items-center gap-1.5 text-xs transition-colors ${copied ? 'text-emerald-400' : 'text-slate-400 hover:text-white'} ${className}`}>
      {copied ? <><CheckCheck size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
    </button>
  )
}

function CodeBox({ code, lang, highlight }) {
  return (
    <div className={`rounded-lg border overflow-hidden ${highlight ? 'border-blue-500/50' : 'border-slate-700'}`}>
      <div className="flex items-center justify-between px-4 py-2 bg-slate-800 border-b border-slate-700">
        <span className="text-xs text-slate-400 font-mono">{lang}</span>
        <CopyBtn text={code} />
      </div>
      <pre className="bg-slate-950 px-4 py-3 text-xs font-mono text-green-300 overflow-x-auto whitespace-pre-wrap break-words leading-5">{code}</pre>
    </div>
  )
}

function StepNumber({ n }) {
  return <div className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">{n}</div>
}

function Expandable({ title, children }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border border-slate-700 rounded-lg overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 py-3 bg-slate-800 text-sm text-slate-300 hover:text-white transition-colors">
        <span className="font-medium">{title}</span>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {open && <div className="px-4 py-4 bg-slate-900 space-y-3">{children}</div>}
    </div>
  )
}

// ── Downloads (original content) ──────────────────────────────────────────────

function WindowsSection({ serverUrl }) {
  const cmdVerify = `sc query KifaaAgent\n:: Expected: STATE = 4  RUNNING`
  const cmdUninstall = `sc stop   KifaaAgent\nsc delete KifaaAgent`
  return (
    <div className="space-y-5">
      <div className="bg-emerald-900/20 border border-emerald-600/40 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-bold text-emerald-300">★ Recommended — EXE Installer</span>
        </div>
        <p className="text-xs text-slate-400 mb-4">Run as Administrator — handles everything automatically.</p>
        <div className="grid grid-cols-2 gap-3 mb-4">
          <a href={`${serverUrl}/downloads/kifaa-installer-amd64.exe`} className="flex items-center gap-3 bg-slate-800 hover:bg-emerald-900/30 border border-slate-600 hover:border-emerald-500/60 rounded-xl p-4 transition-all group">
            <Download size={22} className="text-emerald-400" />
            <div><div className="text-sm font-bold text-white group-hover:text-emerald-300">64-bit Installer</div><div className="text-xs text-slate-400">Windows 10, 11, Server 2016+</div></div>
          </a>
          <a href={`${serverUrl}/downloads/kifaa-installer-386.exe`} className="flex items-center gap-3 bg-slate-800 hover:bg-emerald-900/30 border border-slate-600 hover:border-emerald-500/60 rounded-xl p-4 transition-all group">
            <Download size={22} className="text-slate-400" />
            <div><div className="text-sm font-bold text-white group-hover:text-emerald-300">32-bit Installer</div><div className="text-xs text-slate-400">Windows 7, 8, older systems</div></div>
          </a>
        </div>
      </div>
      {/* MSI section */}
      <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-blue-300">MSI Package</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400">GPO / SCCM / Intune</span>
        </div>
        <p className="text-xs text-slate-400">Standard Windows Installer — deploy silently via Group Policy, SCCM, Intune, or command line.</p>
        <div className="grid grid-cols-2 gap-3">
          <a href={`${serverUrl}/downloads/kifaa-installer-amd64.msi`} className="flex items-center gap-3 bg-slate-700 hover:bg-blue-900/30 border border-slate-600 hover:border-blue-500/60 rounded-xl p-4 transition-all group">
            <Download size={20} className="text-blue-400" />
            <div><div className="text-sm font-bold text-white group-hover:text-blue-300">64-bit MSI</div><div className="text-xs text-slate-400">Windows 10, 11, Server 2016+</div></div>
          </a>
          <a href={`${serverUrl}/downloads/kifaa-installer-386.msi`} className="flex items-center gap-3 bg-slate-700 hover:bg-blue-900/30 border border-slate-600 hover:border-blue-500/60 rounded-xl p-4 transition-all group">
            <Download size={20} className="text-slate-400" />
            <div><div className="text-sm font-bold text-white group-hover:text-blue-300">32-bit MSI</div><div className="text-xs text-slate-400">Windows 7, 8, older systems</div></div>
          </a>
        </div>
        <div className="space-y-2">
          <p className="text-xs text-slate-500 font-medium">Command-line silent install:</p>
          <CodeBox code={`msiexec /i kifaa-installer-amd64.msi /qn /norestart\n:: Then run the setup helper once to register the agent:\n"C:\\Program Files\\KifaaAgent\\kifaa-setup-helper.exe" --server ${serverUrl} --secret ${REGISTRATION_SECRET}`} lang="Command Prompt — Run as Administrator" />
        </div>
      </div>
      <Expandable title="Silent install — EXE (legacy)">
        <CodeBox code={`kifaa-installer-amd64.exe --silent --server ${serverUrl} --secret ${REGISTRATION_SECRET}`} lang="Command Prompt — Run as Administrator" />
      </Expandable>
      <div>
        <div className="flex items-center gap-2 mb-2"><StepNumber n="✓" /><span className="text-sm font-semibold text-white">Verify</span></div>
        <div className="ml-8"><CodeBox code={cmdVerify} lang="cmd.exe" /></div>
      </div>
      <Expandable title="Uninstall"><CodeBox code={cmdUninstall} lang="cmd.exe — Run as Administrator" /></Expandable>
    </div>
  )
}

function LinuxSection({ serverUrl }) {
  const oneliner = `curl -sSL ${serverUrl}/downloads/install-linux.sh | sudo bash -s -- \\\n  --server ${serverUrl} \\\n  --secret ${REGISTRATION_SECRET}`
  const manual = `ARCH=$(uname -m)\n[ "$ARCH" = "aarch64" ] && BIN="kifaa-agent-linux-arm64" || BIN="kifaa-agent-linux-amd64"\nsudo mkdir -p /opt/kifaa-agent\nsudo curl -sSL ${serverUrl}/downloads/$BIN -o /opt/kifaa-agent/kifaa-agent\nsudo chmod +x /opt/kifaa-agent/kifaa-agent\nsudo /opt/kifaa-agent/kifaa-agent --register --server ${serverUrl} --secret ${REGISTRATION_SECRET}`
  const service = `sudo tee /etc/systemd/system/kifaa-agent.service << 'EOF'\n[Unit]\nDescription=Kifaa Endpoint Agent\nAfter=network.target\n\n[Service]\nType=simple\nUser=root\nExecStart=/opt/kifaa-agent/kifaa-agent\nRestart=always\nRestartSec=10\n\n[Install]\nWantedBy=multi-user.target\nEOF\nsudo systemctl daemon-reload && sudo systemctl enable --now kifaa-agent`
  return (
    <div className="space-y-5">
      <div className="bg-orange-900/20 border border-orange-600/40 rounded-xl p-4">
        <p className="text-sm font-semibold text-orange-300 mb-2">One-line install (Recommended)</p>
        <CodeBox code={oneliner} lang="bash" highlight />
      </div>
      <div className="space-y-4">
        <div><div className="flex items-center gap-2 mb-3"><StepNumber n={1} /><span className="text-sm font-semibold text-white">Download &amp; register</span></div><div className="ml-8"><CodeBox code={manual} lang="bash" /></div></div>
        <div><div className="flex items-center gap-2 mb-3"><StepNumber n={2} /><span className="text-sm font-semibold text-white">Install as systemd service</span></div><div className="ml-8"><CodeBox code={service} lang="bash" /></div></div>
      </div>
    </div>
  )
}

// ── IP Scanner ─────────────────────────────────────────────────────────────────

function OsBadge({ os }) {
  if (os === 'windows') return <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 font-medium">Windows</span>
  if (os === 'linux')   return <span className="text-xs px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-300 font-medium">Linux</span>
  return <span className="text-xs px-2 py-0.5 rounded-full bg-slate-600 text-slate-400">Unknown</span>
}

const SCAN_HISTORY_KEY = 'kifaa_scan_history'
const MAX_SCAN_HISTORY = 8

function loadScanHistory() {
  try { return JSON.parse(localStorage.getItem(SCAN_HISTORY_KEY) || '[]') } catch { return [] }
}
function saveScanHistory(range) {
  const prev = loadScanHistory().filter(r => r !== range)
  localStorage.setItem(SCAN_HISTORY_KEY, JSON.stringify([range, ...prev].slice(0, MAX_SCAN_HISTORY)))
}

function ScannerTab({ onDeployTargets }) {
  const [range, setRange] = useState('192.168.0.1-254')
  const [scanning, setScanning] = useState(false)
  const [results, setResults] = useState([])
  const [scanStats, setScanStats] = useState(null)
  const [selected, setSelected] = useState(new Set())
  const [history, setHistory] = useState(loadScanHistory)
  const [showHistory, setShowHistory] = useState(false)
  const [knownAgents, setKnownAgents] = useState([]) // [{ip_address, hostname, status}]
  const wsRef = useRef(null)
  const historyRef = useRef(null)

  // Load known agents once
  useEffect(() => {
    api.get('/agents').then(r => setKnownAgents(r.data || [])).catch(() => {})
  }, [])

  // Close history dropdown on outside click
  useEffect(() => {
    if (!showHistory) return
    function handler(e) { if (historyRef.current && !historyRef.current.contains(e.target)) setShowHistory(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showHistory])

  const agentByIP = Object.fromEntries(knownAgents.map(a => [a.ip_address, a]))
  const agentByHostname = Object.fromEntries(knownAgents.map(a => [a.hostname?.toLowerCase(), a]))

  function getInstalledAgent(r) {
    return agentByIP[r.ip] || (r.hostname && r.hostname !== r.ip ? agentByHostname[r.hostname?.toLowerCase()] : null)
  }

  const scan = useCallback(() => {
    if (wsRef.current) wsRef.current.close()
    setResults([])
    setScanStats(null)
    setSelected(new Set())
    setScanning(true)
    saveScanHistory(range)
    setHistory(loadScanHistory())

    const token = localStorage.getItem('kifaa_token')
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/api/v1/agent-deploy/scan?token=${token}`)
    wsRef.current = ws

    ws.onopen = () => ws.send(JSON.stringify({ range }))

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'result') {
        setResults(prev => [...prev, msg])
      } else if (msg.type === 'done') {
        setScanStats({ scanned: msg.scanned, found: msg.found })
        setScanning(false)
        // Refresh known agents so newly deployed ones show up
        api.get('/agents').then(r => setKnownAgents(r.data || [])).catch(() => {})
      } else if (msg.type === 'error') {
        setScanStats({ error: msg.msg })
        setScanning(false)
      }
    }
    ws.onerror = () => { setScanStats({ error: 'WebSocket error' }); setScanning(false) }
    ws.onclose = () => setScanning(false)
  }, [range])

  function toggle(ip) {
    setSelected(prev => { const s = new Set(prev); s.has(ip) ? s.delete(ip) : s.add(ip); return s })
  }
  function toggleAll() {
    setSelected(prev => prev.size === results.length ? new Set() : new Set(results.map(r => r.ip)))
  }

  function deploySelected() {
    const targets = results.filter(r => selected.has(r.ip)).map(r => ({ ip: r.ip, os: r.os, hostname: r.hostname }))
    onDeployTargets(targets)
  }

  function deploySingle(r) {
    onDeployTargets([{ ip: r.ip, os: r.os, hostname: r.hostname }])
  }

  return (
    <div className="space-y-4">
      {/* Range input with history */}
      <div className="flex gap-3 items-end">
        <div className="flex-1">
          <label className="text-xs text-slate-400 block mb-1">IP Range</label>
          <div className="relative" ref={historyRef}>
            <input value={range} onChange={e => setRange(e.target.value)}
              onFocus={() => history.length > 0 && setShowHistory(true)}
              placeholder="192.168.0.1-254 or 192.168.0.0/24"
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white pr-8" />
            {history.length > 0 && (
              <button onClick={() => setShowHistory(v => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white">
                <Clock size={14} />
              </button>
            )}
            {showHistory && (
              <div className="absolute z-20 left-0 right-0 top-full mt-1 bg-slate-800 border border-slate-600 rounded-lg shadow-xl overflow-hidden">
                <div className="px-3 py-1.5 text-xs text-slate-500 border-b border-slate-700">Recent scans</div>
                {history.map(h => (
                  <button key={h} onClick={() => { setRange(h); setShowHistory(false) }}
                    className="w-full text-left px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 font-mono">
                    {h}
                  </button>
                ))}
              </div>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-1">Formats: 192.168.0.1-254 · 192.168.0.0/24 · 10.0.0.1,10.0.0.5 (max 1024 hosts)</p>
        </div>
        <button onClick={scan} disabled={scanning}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-5 py-2 rounded-lg text-sm font-medium disabled:opacity-50">
          {scanning ? <><Loader size={14} className="animate-spin" /> Scanning…</> : <><Search size={14} /> Scan</>}
        </button>
      </div>

      {/* Stats */}
      {scanStats && (
        <div className={`text-sm px-4 py-2 rounded-lg border ${scanStats.error ? 'bg-red-900/20 border-red-700/40 text-red-400' : 'bg-slate-800 border-slate-700 text-slate-300'}`}>
          {scanStats.error ? `Error: ${scanStats.error}` : `Scanned ${scanStats.scanned} hosts — found ${scanStats.found} online`}
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
              <input type="checkbox" checked={selected.size === results.length && results.length > 0}
                onChange={toggleAll} className="rounded" />
              Select all ({results.length})
            </label>
            {selected.size > 0 && (
              <button onClick={deploySelected}
                className="flex items-center gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-lg font-medium">
                <Zap size={12} /> Deploy {selected.size} selected
              </button>
            )}
          </div>
          <div className="rounded-lg border border-slate-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-800 text-slate-400 text-xs">
                <tr>
                  <th className="w-10 px-3 py-2"></th>
                  <th className="text-left px-3 py-2">IP</th>
                  <th className="text-left px-3 py-2">Hostname</th>
                  <th className="text-left px-3 py-2">OS</th>
                  <th className="text-left px-3 py-2">Open Ports</th>
                  <th className="text-left px-3 py-2">Agent</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {results.map(r => {
                  const agent = getInstalledAgent(r)
                  return (
                    <tr key={r.ip} className="hover:bg-slate-800/50">
                      <td className="px-3 py-2 text-center">
                        <input type="checkbox" checked={selected.has(r.ip)} onChange={() => toggle(r.ip)} className="rounded" />
                      </td>
                      <td className="px-3 py-2 font-mono text-white">{r.ip}</td>
                      <td className="px-3 py-2 text-slate-300">{r.hostname !== r.ip ? r.hostname : '—'}</td>
                      <td className="px-3 py-2"><OsBadge os={r.os} /></td>
                      <td className="px-3 py-2 text-slate-400 text-xs font-mono">{r.ports.join(', ')}</td>
                      <td className="px-3 py-2">
                        {agent
                          ? <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium border ${
                              agent.status === 'online'
                                ? 'bg-green-900/30 text-green-400 border-green-800'
                                : 'bg-slate-700 text-slate-400 border-slate-600'
                            }`}>
                              <CheckCircle2 size={10} />
                              {agent.status === 'online' ? 'Online' : 'Installed'}
                            </span>
                          : <span className="text-slate-600 text-xs">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {!agent && (
                          <button onClick={() => deploySingle(r)} disabled={r.os === 'unknown'}
                            className="text-xs bg-slate-700 hover:bg-emerald-700 border border-slate-600 hover:border-emerald-500 text-slate-300 hover:text-white px-2.5 py-1 rounded-lg transition-colors disabled:opacity-40">
                            Deploy
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {scanning && results.length === 0 && (
        <div className="py-8 text-center text-slate-500 text-sm">Scanning — results appear as hosts are found…</div>
      )}
    </div>
  )
}

// ── Credential Picker ─────────────────────────────────────────────────────────

function CredentialPicker({ onSelect }) {
  const [creds, setCreds] = useState([])
  const [loading, setLoading] = useState(true)
  const [value, setValue] = useState('')

  useEffect(() => {
    setLoading(true)
    api.get('/credentials')
      .then(r => setCreds(r.data || []))
      .catch(() => setCreds([]))
      .finally(() => setLoading(false))
  }, [])

  function handleChange(e) {
    const id = e.target.value
    setValue(id)
    if (!id) { onSelect(null); return }
    const cred = creds.find(c => c.id === id)
    if (cred) onSelect(cred)
  }

  return (
    <div className="bg-slate-900 border border-blue-700/40 rounded-lg p-3 mb-3">
      <div className="flex items-center gap-2 mb-2">
        <KeyRound size={13} className="text-blue-400" />
        <span className="text-xs font-medium text-slate-300">Saved credential</span>
        <span className="text-xs text-slate-500 ml-auto">
          {loading ? 'Loading…' : creds.length === 0 ? 'None — add in Settings → Credentials' : `${creds.length} available`}
        </span>
      </div>
      <select value={value} onChange={handleChange} disabled={loading || creds.length === 0}
        className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed">
        <option value="">— enter manually below —</option>
        {creds.map(c => (
          <option key={c.id} value={c.id}>
            {c.name} · {c.username}{c.domain ? `@${c.domain}` : ''}{c.use_sudo ? ' (sudo)' : ''}
          </option>
        ))}
      </select>
    </div>
  )
}

// ── Agent Deploy ───────────────────────────────────────────────────────────────

function DeployTab({ initialTargets, serverUrl }) {
  const [targets, setTargets] = useState(initialTargets || [])
  const [creds, setCreds] = useState({ username: '', password: '', domain: '', port: '', winrm_port: '', use_sudo: false })
  const [credLoading, setCredLoading] = useState(false)

  async function handleCredSelect(cred) {
    if (!cred) { return }
    setCredLoading(true)
    try {
      const r = await api.get(`/credentials/${cred.id}/secret`)
      const d = r.data
      setCreds(c => ({
        ...c,
        username:  d.username  || c.username,
        password:  d.password  || c.password,
        domain:    d.domain    || c.domain,
        port:      d.port      ? String(d.port) : c.port,
        use_sudo:  d.use_sudo  ?? c.use_sudo,
      }))
    } catch (e) {
      console.error('Failed to load credential', e)
    } finally {
      setCredLoading(false)
    }
  }
  const [forceReinstall, setForceReinstall] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [logs, setLogs] = useState([]) // [{target, level, msg}]
  const [summary, setSummary] = useState(null)
  const logsEndRef = useRef(null)
  const wsRef = useRef(null)

  // Sync when initialTargets changes (from scanner)
  useEffect(() => { if (initialTargets?.length) setTargets(initialTargets) }, [initialTargets])
  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [logs])

  function removeTarget(ip) { setTargets(prev => prev.filter(t => t.ip !== ip)) }

  function addManual() {
    const ip = prompt('Enter IP address:')
    if (!ip) return
    const os = prompt('OS type (linux or windows):')?.toLowerCase()
    if (os !== 'linux' && os !== 'windows') return alert('Enter linux or windows')
    setTargets(prev => [...prev, { ip, os, hostname: ip }])
  }

  const deploy = useCallback(() => {
    if (!targets.length) return alert('Add at least one target.')
    if (!creds.username || !creds.password) return alert('Username and password are required.')

    setDeploying(true)
    setLogs([])
    setSummary(null)

    const token = localStorage.getItem('kifaa_token')
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/api/v1/agent-deploy/deploy?token=${token}`)
    wsRef.current = ws

    ws.onopen = () => {
      const payload = {
        targets: targets.map(t => ({
          ip: t.ip,
          os: t.os,
          username: creds.username,
          password: creds.password,
          domain: creds.domain,
          use_sudo: creds.use_sudo,
          port: t.os === 'linux'
            ? parseInt(creds.port) || 22
            : parseInt(creds.winrm_port) || 5985,
        })),
        server_url: serverUrl,
        secret: REGISTRATION_SECRET,
        force: forceReinstall,
      }
      ws.send(JSON.stringify(payload))
    }

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'log') {
        setLogs(prev => [...prev, { target: msg.target, level: msg.level, msg: msg.msg }])
      } else if (msg.type === 'target_done') {
        if (msg.skipped) {
          // no extra line — already logged "skipping" above
        } else {
          setLogs(prev => [...prev, {
            target: msg.target,
            level: msg.success ? 'success' : 'error',
            msg: msg.success ? '✓ Deployment succeeded' : '✗ Deployment failed',
          }])
        }
      } else if (msg.type === 'complete') {
        setSummary({ succeeded: msg.succeeded, failed: msg.failed, skipped: msg.skipped || 0 })
        setDeploying(false)
      } else if (msg.type === 'error') {
        setLogs(prev => [...prev, { target: 'system', level: 'error', msg: msg.msg }])
        setDeploying(false)
      }
    }
    ws.onerror = () => { setLogs(prev => [...prev, { target: 'system', level: 'error', msg: 'WebSocket error' }]); setDeploying(false) }
    ws.onclose = () => setDeploying(false)
  }, [targets, creds, serverUrl, forceReinstall])

  const logColor = { info: 'text-slate-300', error: 'text-red-400', success: 'text-emerald-400', skip: 'text-teal-400' }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-5">
        {/* Targets */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-white">Targets ({targets.length})</h3>
            <button onClick={addManual} className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300">
              <Plus size={12} /> Add manually
            </button>
          </div>
          {targets.length === 0 ? (
            <div className="border border-dashed border-slate-600 rounded-lg p-6 text-center text-slate-500 text-sm">
              No targets — use the Scanner tab or add manually
            </div>
          ) : (
            <div className="border border-slate-700 rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-slate-800 text-slate-400"><tr><th className="text-left px-3 py-2">IP</th><th className="text-left px-3 py-2">OS</th><th className="px-2 py-2"></th></tr></thead>
                <tbody className="divide-y divide-slate-700/50">
                  {targets.map(t => (
                    <tr key={t.ip} className="hover:bg-slate-800/40">
                      <td className="px-3 py-2 font-mono text-white">{t.ip}</td>
                      <td className="px-3 py-2"><OsBadge os={t.os} /></td>
                      <td className="px-2 py-2 text-right">
                        <button onClick={() => removeTarget(t.ip)} className="text-slate-500 hover:text-red-400"><X size={12} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Credentials */}
        <div>
          <h3 className="text-sm font-semibold text-white mb-2">Credentials</h3>
          <div className="space-y-3 bg-slate-800/50 border border-slate-700 rounded-lg p-4">
            <CredentialPicker onSelect={handleCredSelect} />
            {credLoading && <div className="text-xs text-blue-400">Loading credential…</div>}
            <p className="text-xs text-slate-400">Select a saved credential above, or enter manually. Linux uses SSH; Windows uses WinRM.</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-500 block mb-1">Username *</label>
                <input value={creds.username} onChange={e => setCreds(c => ({ ...c, username: e.target.value }))}
                  placeholder="root / Administrator"
                  className="w-full bg-slate-700 border border-slate-600 rounded px-2.5 py-1.5 text-sm text-white" />
              </div>
              <div>
                <label className="text-xs text-slate-500 block mb-1">Password *</label>
                <input type="password" value={creds.password} onChange={e => setCreds(c => ({ ...c, password: e.target.value }))}
                  className="w-full bg-slate-700 border border-slate-600 rounded px-2.5 py-1.5 text-sm text-white" />
              </div>
              <div>
                <label className="text-xs text-slate-500 block mb-1">Domain (Windows)</label>
                <input value={creds.domain} onChange={e => setCreds(c => ({ ...c, domain: e.target.value }))}
                  placeholder="optional"
                  className="w-full bg-slate-700 border border-slate-600 rounded px-2.5 py-1.5 text-sm text-white" />
              </div>
              <div>
                <label className="text-xs text-slate-500 block mb-1">SSH Port (Linux)</label>
                <input type="number" value={creds.port} onChange={e => setCreds(c => ({ ...c, port: e.target.value }))}
                  placeholder="22"
                  className="w-full bg-slate-700 border border-slate-600 rounded px-2.5 py-1.5 text-sm text-white" />
              </div>
              <div>
                <label className="text-xs text-slate-500 block mb-1">WinRM Port (Windows)</label>
                <input type="number" value={creds.winrm_port} onChange={e => setCreds(c => ({ ...c, winrm_port: e.target.value }))}
                  placeholder="5985"
                  className="w-full bg-slate-700 border border-slate-600 rounded px-2.5 py-1.5 text-sm text-white" />
              </div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-slate-300">
              <input type="checkbox" checked={creds.use_sudo} onChange={e => setCreds(c => ({ ...c, use_sudo: e.target.checked }))}
                className="w-4 h-4 rounded accent-blue-500" />
              Use sudo for Linux deployment (for non-root users)
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-amber-400">
              <input type="checkbox" checked={forceReinstall} onChange={e => setForceReinstall(e.target.checked)}
                className="w-4 h-4 rounded accent-amber-500" />
              Force reinstall (bypass version check — use for stuck or legacy agents)
            </label>
            <button onClick={deploy} disabled={deploying || !targets.length}
              className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50 mt-1">
              {deploying ? <><Loader size={14} className="animate-spin" /> Deploying…</> : <><Play size={14} /> Deploy Agent</>}
            </button>
          </div>
        </div>
      </div>

      {/* Live output */}
      {(logs.length > 0 || deploying) && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-white">Deployment Output</h3>
            {summary && (
              <span className={`text-xs px-3 py-1 rounded-full font-medium ${summary.failed === 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                {summary.succeeded - (summary.skipped || 0)} deployed{summary.skipped ? ` · ${summary.skipped} skipped (up-to-date)` : ''}{summary.failed ? ` · ${summary.failed} failed` : ''}
              </span>
            )}
          </div>
          <div className="bg-slate-950 border border-slate-700 rounded-xl p-4 font-mono text-xs leading-5 h-72 overflow-y-auto">
            {logs.map((l, i) => (
              <div key={i} className={logColor[l.level] || 'text-slate-300'}>
                <span className="text-slate-500">[{l.target}]</span> {l.msg}
              </div>
            ))}
            {deploying && <div className="text-yellow-400 animate-pulse">▌</div>}
            <div ref={logsEndRef} />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Deployment History ────────────────────────────────────────────────────────

const STATUS_DOT = {
  success: 'bg-green-400',
  failed:  'bg-red-400',
  running: 'bg-yellow-400 animate-pulse',
  pending: 'bg-slate-500',
}
const STATUS_TEXT = {
  success: 'text-green-400',
  failed:  'text-red-400',
  running: 'text-yellow-400',
  pending: 'text-slate-400',
}

function DeployHistory() {
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)

  const load = async () => {
    setLoading(true); setError(null)
    try {
      const r = await api.get('/deployment/jobs')
      setJobs(Array.isArray(r.data) ? r.data : [])
    } catch (e) {
      setError(e.response?.data?.detail || e.message || 'Failed to load')
    } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  async function del(e, id) {
    e.stopPropagation()
    try { await api.delete(`/deployment/jobs/${id}`); setJobs(j => j.filter(x => x.id !== id)); if (selected?.id === id) setSelected(null) } catch {}
  }

  if (loading) return (
    <div className="py-12 flex items-center justify-center gap-2 text-slate-500 text-sm">
      <RefreshCw size={14} className="animate-spin" /> Loading history…
    </div>
  )
  if (error) return (
    <div className="py-8 text-center space-y-2">
      <div className="text-red-400 text-sm">{error}</div>
      <button onClick={load} className="text-xs text-slate-400 hover:text-white underline">Retry</button>
    </div>
  )
  if (jobs.length === 0) return (
    <div className="py-12 text-center text-slate-600 text-sm">No deployment history yet — deploy an agent to see records here</div>
  )

  return (
    <div className="grid grid-cols-5 gap-5">
      {/* Job list */}
      <div className="col-span-2 space-y-1.5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-slate-500">{jobs.length} job{jobs.length !== 1 ? 's' : ''}</span>
          <button onClick={load} className="text-slate-500 hover:text-white transition-colors" title="Refresh">
            <RefreshCw size={13} />
          </button>
        </div>
        {jobs.map(j => (
          <div key={j.id} onClick={() => setSelected(j)}
            className={`flex items-center gap-3 border rounded-lg px-3 py-2.5 cursor-pointer transition-colors group ${
              selected?.id === j.id
                ? 'border-blue-500 bg-blue-600/10'
                : 'border-slate-700 bg-slate-800/50 hover:border-slate-500'
            }`}>
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[j.status] || 'bg-slate-500'}`} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-white truncate">{j.target_host}</div>
              <div className="text-xs text-slate-500 truncate">
                {j.os_type} · {j.created_at ? new Date(j.created_at).toLocaleString() : '—'}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <span className={`text-xs font-bold uppercase ${STATUS_TEXT[j.status] || 'text-slate-400'}`}>{j.status}</span>
              <button onClick={e => del(e, j.id)} className="ml-1 p-0.5 text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity">
                <Trash2 size={11} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Log viewer */}
      <div className="col-span-3">
        {selected ? (
          <div>
            <div className="flex items-center gap-3 mb-3">
              <div>
                <div className="font-medium text-white">{selected.target_host}</div>
                <div className="text-xs text-slate-500">
                  {selected.username ? `${selected.username} · ` : ''}{selected.os_type} · {selected.created_at ? new Date(selected.created_at).toLocaleString() : ''}
                </div>
              </div>
              <span className={`ml-auto text-xs font-bold uppercase px-2 py-0.5 rounded ${STATUS_TEXT[selected.status]}`}>
                {selected.status}
              </span>
            </div>
            <div className="bg-black border border-slate-700 rounded-xl p-4 h-96 overflow-y-auto font-mono text-xs space-y-0.5">
              {selected.logs ? selected.logs.split('\n').map((l, i) => (
                <div key={i} className={
                  l.startsWith('[ERROR]') || l.startsWith('[ERR]') ? 'text-red-400' :
                  l.startsWith('[SUCCESS]') ? 'text-green-400' :
                  l.startsWith('[WARN]')    ? 'text-yellow-400' :
                  l.startsWith('[RUN]')     ? 'text-blue-300' :
                  l.startsWith('[INFO]')    ? 'text-slate-300' :
                  'text-slate-500'
                }>{l || '\u00A0'}</div>
              )) : <div className="text-slate-600 italic">No log output recorded</div>}
            </div>
          </div>
        ) : (
          <div className="h-96 border border-dashed border-slate-700 rounded-xl flex items-center justify-center text-slate-600 text-sm">
            Select a job to view logs
          </div>
        )}
      </div>
    </div>
  )
}

// ── Release Notes ────────────────────────────────────────────────────────────

const CATEGORY_COLORS = {
  'New Features':  { dot: 'bg-emerald-400', text: 'text-emerald-300', badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  'Improvements':  { dot: 'bg-blue-400',    text: 'text-blue-300',    badge: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
  'Bug Fixes':     { dot: 'bg-yellow-400',  text: 'text-yellow-300',  badge: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' },
}

function ReleaseNotes() {
  const [expanded, setExpanded] = useState(CHANGELOG[0].version)

  return (
    <div className="space-y-4">
      {CHANGELOG.map((release) => {
        const isOpen = expanded === release.version
        const isCurrent = release.tag === 'latest'
        const totalChanges = Object.values(release.changes).reduce((s, arr) => s + arr.length, 0)

        return (
          <div key={release.version}
            className={`border rounded-xl overflow-hidden transition-colors ${
              isCurrent ? 'border-blue-500/50' : 'border-slate-700'
            }`}
          >
            {/* Header row */}
            <button
              onClick={() => setExpanded(isOpen ? null : release.version)}
              className="w-full flex items-center gap-4 px-5 py-4 bg-slate-800/80 hover:bg-slate-800 transition-colors text-left"
            >
              <div className="flex-1 flex items-center gap-3 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-white font-bold text-base font-mono">v{release.version}</span>
                  {isCurrent && (
                    <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30 font-medium">
                      <Star size={10} /> Current
                    </span>
                  )}
                  {release.tag === 'initial' && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-slate-700 text-slate-400 border border-slate-600">
                      Initial Release
                    </span>
                  )}
                </div>
                <span className="text-slate-500 text-sm">{release.date}</span>
                <span className="text-slate-400 text-sm truncate hidden md:block">{release.summary}</span>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <span className="text-xs text-slate-500">{totalChanges} changes</span>
                {isOpen ? <ChevronDown size={16} className="text-slate-400" /> : <ChevronRight size={16} className="text-slate-400" />}
              </div>
            </button>

            {/* Body */}
            {isOpen && (
              <div className="px-5 py-5 bg-slate-900 space-y-5">
                <p className="text-sm text-slate-300">{release.summary}</p>
                {Object.entries(release.changes).map(([cat, items]) => {
                  const c = CATEGORY_COLORS[cat] || { dot: 'bg-slate-400', text: 'text-slate-300', badge: 'bg-slate-700 text-slate-400 border-slate-600' }
                  return (
                    <div key={cat}>
                      <div className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border mb-3 ${c.badge}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
                        {cat}
                      </div>
                      <ul className="space-y-1.5 ml-1">
                        {items.map((item, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm text-slate-300">
                            <span className={`mt-1.5 w-1 h-1 rounded-full flex-shrink-0 ${c.dot}`} />
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Downloads() {
  const serverUrl = useServerUrl()
  const [mainTab, setMainTab] = useState('downloads')
  const [activeOS, setActiveOS] = useState(detectOS())
  const [deployTargets, setDeployTargets] = useState([])

  function handleDeployTargets(targets) {
    setDeployTargets(targets)
    setMainTab('deploy')
  }

  const tabs = [
    { id: 'downloads', label: 'Agent Downloads', icon: Download },
    { id: 'scanner',   label: 'IP Scanner',      icon: Search },
    { id: 'deploy',    label: 'Agent Deploy',     icon: Zap },
    { id: 'history',   label: 'Deploy History',   icon: History },
    { id: 'changelog', label: 'Release Notes',    icon: BookOpen },
  ]

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Agent Downloads &amp; Deployment</h1>
          <p className="text-sm text-slate-400 mt-0.5">Download, scan and remotely deploy the Kifaa agent to your endpoints</p>
        </div>
        <span className="text-xs font-mono px-3 py-1.5 rounded-full bg-blue-500/15 text-blue-300 border border-blue-500/30">
          Agent v{CURRENT_VERSION}
        </span>
      </div>

      {/* Main tabs */}
      <div className="flex gap-1 border-b border-slate-700 mb-6">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setMainTab(id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              mainTab === id ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-400 hover:text-white'
            }`}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {/* Downloads tab */}
      {mainTab === 'downloads' && (
        <div>
          {/* Version banner */}
          <div className="flex items-center justify-between mb-5 bg-slate-900 border border-blue-500/30 rounded-xl px-5 py-3.5">
            <div className="flex items-center gap-3">
              <Tag size={16} className="text-blue-400" />
              <div>
                <span className="text-sm font-semibold text-white">Current Release — v{CURRENT_VERSION}</span>
                <span className="ml-3 text-xs text-slate-400">{CHANGELOG[0].date} · {CHANGELOG[0].summary}</span>
              </div>
            </div>
            <button
              onClick={() => setMainTab('changelog')}
              className="text-xs text-blue-400 hover:text-blue-300 underline underline-offset-2 flex-shrink-0"
            >
              View release notes
            </button>
          </div>
          <div className="flex gap-2 mb-6 p-1 bg-slate-800 rounded-xl w-fit border border-slate-700">
            <button onClick={() => setActiveOS('windows')} className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${activeOS === 'windows' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}>
              <Monitor size={16} /> Windows
            </button>
            <button onClick={() => setActiveOS('linux')} className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${activeOS === 'linux' ? 'bg-orange-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}>
              <Terminal size={16} /> Linux
            </button>
          </div>
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-6">
            {activeOS === 'windows' ? <WindowsSection serverUrl={serverUrl} /> : <LinuxSection serverUrl={serverUrl} />}
          </div>
          <div className="mt-6 bg-slate-900 border border-slate-700 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-4"><Shield size={16} className="text-yellow-400" /><h3 className="text-sm font-semibold text-white">Legacy &amp; Agentless Systems</h3></div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[{ label: 'Windows XP', note: 'Phase 2 — Python 2.7 agent', color: 'yellow' }, { label: 'Windows 7', note: 'Phase 2 — Python 3.8 agent', color: 'yellow' }, { label: 'SAP HANA 12', note: 'Phase 2 — DB connector', color: 'blue' }, { label: 'Switches / Routers', note: 'Phase 2 — SNMP polling', color: 'blue' }].map(item => (
                <div key={item.label} className={`rounded-lg p-3 border ${item.color === 'yellow' ? 'bg-yellow-900/20 border-yellow-700/30' : 'bg-blue-900/20 border-blue-700/30'}`}>
                  <div className="text-sm font-medium text-white">{item.label}</div>
                  <div className={`text-xs mt-1 ${item.color === 'yellow' ? 'text-yellow-400' : 'text-blue-400'}`}>{item.note}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-4 flex items-start gap-3 bg-slate-800/50 border border-slate-700 rounded-xl p-4">
            <Info size={16} className="text-slate-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-slate-400 leading-5">The agent connects to <strong className="text-slate-200">{serverUrl}</strong> every 30 seconds. Uses ~3–5 MB RAM and less than 0.1% CPU.</p>
          </div>
        </div>
      )}

      {/* Scanner tab */}
      {mainTab === 'scanner' && (
        <div className="bg-slate-900 border border-slate-700 rounded-xl p-6">
          <ScannerTab onDeployTargets={handleDeployTargets} />
        </div>
      )}

      {/* Deploy tab */}
      {mainTab === 'deploy' && (
        <div className="bg-slate-900 border border-slate-700 rounded-xl p-6">
          <DeployTab initialTargets={deployTargets} serverUrl={serverUrl} />
        </div>
      )}

      {/* History tab */}
      {mainTab === 'history' && (
        <div className="bg-slate-900 border border-slate-700 rounded-xl p-6">
          <DeployHistory />
        </div>
      )}

      {/* Release Notes tab */}
      {mainTab === 'changelog' && (
        <div>
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-base font-semibold text-white">Release Notes</h2>
              <p className="text-sm text-slate-400 mt-0.5">Full changelog for every Kifaa agent release</p>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />
              Current: v{CURRENT_VERSION}
            </div>
          </div>
          <ReleaseNotes />
        </div>
      )}
    </div>
  )
}
