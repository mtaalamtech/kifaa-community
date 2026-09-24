import { useState, useEffect, useCallback } from 'react'
import {
  ShieldAlert, AlertTriangle, Wifi, Ban, RefreshCw,
  ChevronDown, ChevronRight, Trash2, Plus, Search,
  PackageX, Bug, Zap, Eye, Globe
} from 'lucide-react'

const API = '/api/v1'
const token = () => localStorage.getItem('kifaa_token')
const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` })

async function apiFetch(path, opts = {}) {
  const res = await fetch(API + path, { headers: authHeaders(), ...opts })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

const SEVERITY_COLORS = {
  critical: 'bg-red-900/40 text-red-300 border-red-700',
  high: 'bg-orange-900/40 text-orange-300 border-orange-700',
  medium: 'bg-yellow-900/40 text-yellow-300 border-yellow-700',
  low: 'bg-blue-900/40 text-blue-300 border-blue-700',
}
const SEVERITY_DOT = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-yellow-500',
  low: 'bg-blue-500',
}

function SeverityBadge({ severity }) {
  const cls = SEVERITY_COLORS[severity] || 'bg-slate-800 text-slate-400 border-slate-600'
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${cls}`}>
      {severity?.toUpperCase()}
    </span>
  )
}

function StatusBadge({ status }) {
  if (status === 'pass') return <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-green-900/40 text-green-300 border-green-700">PASS</span>
  if (status === 'excepted') return <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-slate-800 text-slate-400 border-slate-600">EXCEPTED</span>
  return <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-red-900/40 text-red-300 border-red-700">FAIL</span>
}

// Ports that are "dangerous" when bound to 0.0.0.0
const DANGEROUS_PORTS = new Set([21, 23, 445, 3389, 1433, 3306, 5432, 4444, 5900, 6379, 27017, 9200])
const PORT_INFO = {
  21:    { label: 'FTP',            risk: 'Cleartext credentials, directory traversal' },
  23:    { label: 'Telnet',         risk: 'Unencrypted remote access — replace with SSH' },
  445:   { label: 'SMB',            risk: 'EternalBlue / ransomware attack surface' },
  3389:  { label: 'RDP',            risk: 'Brute-force & BlueKeep vulnerability target' },
  1433:  { label: 'SQL Server',     risk: 'Database exposed to network — restrict access' },
  3306:  { label: 'MySQL',          risk: 'Database exposed to network — restrict access' },
  5432:  { label: 'PostgreSQL',     risk: 'Database exposed to network — restrict access' },
  4444:  { label: 'Metasploit',     risk: 'Known C2 / backdoor default port' },
  5900:  { label: 'VNC',            risk: 'Remote desktop — often weak authentication' },
  6379:  { label: 'Redis',          risk: 'No auth by default — remote code execution risk' },
  27017: { label: 'MongoDB',        risk: 'No auth by default — data exposure' },
  9200:  { label: 'Elasticsearch',  risk: 'No auth by default — data exposure' },
}

// ── Tab: System Misconfigurations ─────────────────────────────────────────────
function MisconfigTab() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterSeverity, setFilterSeverity] = useState('')
  const [expanded, setExpanded] = useState({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/threats/misconfigs')
      setRows(data)
    } catch { setRows([]) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = rows.filter(r => {
    const q = search.toLowerCase()
    if (q && !r.hostname?.toLowerCase().includes(q) && !r.title?.toLowerCase().includes(q) && !r.rule_id?.toLowerCase().includes(q)) return false
    if (filterSeverity && r.severity !== filterSeverity) return false
    return true
  })

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className="bg-slate-800 border border-slate-600 rounded-lg pl-8 pr-3 py-2 text-sm text-white w-56"
            placeholder="Search host / rule..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select
          value={filterSeverity}
          onChange={e => setFilterSeverity(e.target.value)}
          className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option value="">All severities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <button onClick={load} className="ml-auto flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-white">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Count */}
      <div className="text-sm text-slate-400">{filtered.length} finding{filtered.length !== 1 ? 's' : ''}</div>

      {/* Table */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-slate-400">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-slate-400">No misconfigurations found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-slate-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 text-left w-8"></th>
                <th className="px-4 py-3 text-left">Host</th>
                <th className="px-4 py-3 text-left">Rule</th>
                <th className="px-4 py-3 text-left">Category</th>
                <th className="px-4 py-3 text-left">Severity</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Actual Value</th>
                <th className="px-4 py-3 text-left">Detected</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {filtered.map(row => (
                <>
                  <tr
                    key={row.id}
                    className="hover:bg-slate-700/50 cursor-pointer"
                    onClick={() => setExpanded(e => ({ ...e, [row.id]: !e[row.id] }))}
                  >
                    <td className="px-4 py-3 text-slate-400">
                      {expanded[row.id] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </td>
                    <td className="px-4 py-3 text-white">
                      <div className="font-medium">{row.display_name || row.hostname}</div>
                      <div className="text-xs text-slate-400">{row.ip_address}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-200">{row.title}</td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-slate-400 capitalize">{row.category}</span>
                    </td>
                    <td className="px-4 py-3"><SeverityBadge severity={row.severity} /></td>
                    <td className="px-4 py-3"><StatusBadge status={row.status} /></td>
                    <td className="px-4 py-3 text-slate-300 font-mono text-xs">{row.actual_value}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs">
                      {row.detected_at ? new Date(row.detected_at).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                  {expanded[row.id] && (
                    <tr key={`${row.id}-detail`} className="bg-slate-900/50">
                      <td colSpan={8} className="px-8 py-4">
                        <div className="grid grid-cols-2 gap-4 text-sm">
                          <div>
                            <div className="text-slate-400 text-xs font-medium mb-1">Expected</div>
                            <div className="text-green-300 font-mono">{row.expected_value}</div>
                          </div>
                          <div>
                            <div className="text-slate-400 text-xs font-medium mb-1">Platform</div>
                            <div className="text-slate-300 capitalize">{row.platform}</div>
                          </div>
                          {row.remediation && (
                            <div className="col-span-2">
                              <div className="text-slate-400 text-xs font-medium mb-1">Remediation</div>
                              <div className="text-slate-300 bg-slate-800 rounded-lg p-3 text-xs font-mono whitespace-pre-wrap">{row.remediation}</div>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── Tab: High Risk Software ────────────────────────────────────────────────────
const TYPE_LABELS = {
  eol: 'End of Life',
  p2p: 'P2P Client',
  remote_desktop: 'Remote Desktop',
  unauthorized: 'Unauthorized Tool',
}

function HighRiskTab() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState('')
  const [uninstalling, setUninstalling] = useState({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/threats/high-risk')
      setRows(data)
    } catch { setRows([]) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function handleUninstall(row) {
    if (!confirm(`Uninstall "${row.software_name}" from ${row.display_name || row.hostname}?`)) return
    setUninstalling(u => ({ ...u, [row.id]: true }))
    try {
      await apiFetch(`/threats/high-risk/${row.id}/uninstall`, { method: 'POST' })
      alert(`Uninstall command queued for "${row.software_name}"`)
    } catch (e) {
      alert('Failed to queue uninstall: ' + e.message)
    }
    setUninstalling(u => ({ ...u, [row.id]: false }))
  }

  const filtered = rows.filter(r => {
    const q = search.toLowerCase()
    if (q && !r.hostname?.toLowerCase().includes(q) && !r.software_name?.toLowerCase().includes(q)) return false
    if (filterType && r.match_type !== filterType) return false
    return true
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className="bg-slate-800 border border-slate-600 rounded-lg pl-8 pr-3 py-2 text-sm text-white w-56"
            placeholder="Search host / software..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select
          value={filterType}
          onChange={e => setFilterType(e.target.value)}
          className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option value="">All types</option>
          <option value="eol">End of Life</option>
          <option value="p2p">P2P Client</option>
          <option value="remote_desktop">Remote Desktop</option>
          <option value="unauthorized">Unauthorized</option>
        </select>
        <button onClick={load} className="ml-auto flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-white">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="text-sm text-slate-400">{filtered.length} finding{filtered.length !== 1 ? 's' : ''}</div>

      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-slate-400">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-slate-400">No high-risk software detected</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-slate-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 text-left">Host</th>
                <th className="px-4 py-3 text-left">Software</th>
                <th className="px-4 py-3 text-left">Version</th>
                <th className="px-4 py-3 text-left">Type</th>
                <th className="px-4 py-3 text-left">Severity</th>
                <th className="px-4 py-3 text-left">Detected</th>
                <th className="px-4 py-3 text-left">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {filtered.map(row => (
                <tr key={row.id} className="hover:bg-slate-700/50">
                  <td className="px-4 py-3 text-white">
                    <div className="font-medium">{row.display_name || row.hostname}</div>
                    <div className="text-xs text-slate-400">{row.ip_address}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-200 font-medium">{row.software_name}</td>
                  <td className="px-4 py-3 text-slate-400 text-xs">{row.software_version || '—'}</td>
                  <td className="px-4 py-3">
                    <span className="text-xs px-2 py-0.5 rounded-full border bg-slate-700 text-slate-300 border-slate-600">
                      {TYPE_LABELS[row.match_type] || row.match_type}
                    </span>
                  </td>
                  <td className="px-4 py-3"><SeverityBadge severity={row.severity} /></td>
                  <td className="px-4 py-3 text-slate-400 text-xs">
                    {row.detected_at ? new Date(row.detected_at).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleUninstall(row)}
                      disabled={uninstalling[row.id]}
                      className="flex items-center gap-1 px-2 py-1 bg-red-600/20 hover:bg-red-600/40 text-red-300 border border-red-700/50 rounded text-xs disabled:opacity-50"
                    >
                      <PackageX size={12} />
                      {uninstalling[row.id] ? 'Queuing...' : 'Uninstall'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── Tab: Port Audit ────────────────────────────────────────────────────────────
function PortAuditTab() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [onlyDangerous, setOnlyDangerous] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/threats/ports')
      setRows(data)
    } catch { setRows([]) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function isDangerous(row) {
    return DANGEROUS_PORTS.has(row.port) && (row.bind_address === '0.0.0.0' || row.bind_address === '::')
  }

  const filtered = rows.filter(r => {
    const q = search.toLowerCase()
    if (q && !r.hostname?.toLowerCase().includes(q) && !String(r.port).includes(q) && !r.process_name?.toLowerCase().includes(q)) return false
    if (onlyDangerous && !isDangerous(r)) return false
    return true
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className="bg-slate-800 border border-slate-600 rounded-lg pl-8 pr-3 py-2 text-sm text-white w-56"
            placeholder="Search host / port / process..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={onlyDangerous}
            onChange={e => setOnlyDangerous(e.target.checked)}
            className="rounded border-slate-600"
          />
          Dangerous ports only
        </label>
        <button onClick={load} className="ml-auto flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-white">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="text-sm text-slate-400">{filtered.length} port{filtered.length !== 1 ? 's' : ''}</div>

      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-slate-400">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-slate-400">No open ports found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-slate-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 text-left">Host</th>
                <th className="px-4 py-3 text-left">Port</th>
                <th className="px-4 py-3 text-left">Protocol</th>
                <th className="px-4 py-3 text-left">Process</th>
                <th className="px-4 py-3 text-left">Bind Address</th>
                <th className="px-4 py-3 text-left">State</th>
                <th className="px-4 py-3 text-left">Risk</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {filtered.map(row => {
                const danger = isDangerous(row)
                return (
                  <tr key={row.id} className={`hover:bg-slate-700/50 ${danger ? 'bg-red-900/10' : ''}`}>
                    <td className="px-4 py-3 text-white">
                      <div className="font-medium">{row.display_name || row.hostname}</div>
                      <div className="text-xs text-slate-400">{row.ip_address}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className={`font-mono font-bold ${danger ? 'text-red-400' : 'text-white'}`}>{row.port}</span>
                        {PORT_INFO[row.port] && (
                          <span className="text-xs text-slate-500">{PORT_INFO[row.port].label}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-400 uppercase text-xs">{row.protocol}</td>
                    <td className="px-4 py-3 text-slate-300 font-mono text-xs">
                      {row.process_name || '—'}
                      {row.process_pid ? <span className="text-slate-500 ml-1">({row.process_pid})</span> : null}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-300">{row.bind_address || '—'}</td>
                    <td className="px-4 py-3 text-xs text-slate-400">{row.state}</td>
                    <td className="px-4 py-3">
                      {danger
                        ? <div>
                            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border bg-red-900/40 text-red-300 border-red-700 font-medium">
                              ⚠ EXPOSED
                            </span>
                            {PORT_INFO[row.port] && (
                              <div className="text-xs text-red-400/70 mt-1 max-w-[220px]">{PORT_INFO[row.port].risk}</div>
                            )}
                          </div>
                        : <span className="text-xs text-slate-600">—</span>
                      }
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── Tab: Manage Exceptions ─────────────────────────────────────────────────────
function ExceptionsTab() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({ exception_type: 'misconfig', match_value: '', agent_id: '', reason: '', expires_at: '' })
  const [agents, setAgents] = useState([])
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [excs, agts] = await Promise.all([
        apiFetch('/threats/exceptions'),
        apiFetch('/agents?limit=500'),
      ])
      setRows(excs)
      setAgents(agts.agents || agts || [])
    } catch { setRows([]) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function handleDelete(id) {
    if (!confirm('Remove this exception?')) return
    await apiFetch(`/threats/exceptions/${id}`, { method: 'DELETE' })
    load()
  }

  async function handleAdd(e) {
    e.preventDefault()
    setSaving(true)
    try {
      await apiFetch('/threats/exceptions', { method: 'POST', body: JSON.stringify(form) })
      setShowAdd(false)
      setForm({ exception_type: 'misconfig', match_value: '', agent_id: '', reason: '', expires_at: '' })
      load()
    } catch (err) {
      alert('Failed to create exception: ' + err.message)
    }
    setSaving(false)
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm"
        >
          <Plus size={14} /> Add Exception
        </button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="bg-slate-800 border border-slate-600 rounded-xl p-6">
          <h3 className="text-white font-medium mb-4">New Exception</h3>
          <form onSubmit={handleAdd} className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Type</label>
              <select
                value={form.exception_type}
                onChange={e => setForm(f => ({ ...f, exception_type: e.target.value }))}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
              >
                <option value="misconfig">Misconfiguration</option>
                <option value="software">High-risk Software</option>
                <option value="port">Port</option>
                <option value="cve">CVE</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Match Value (rule_id / software name / port / CVE-ID)</label>
              <input
                required
                value={form.match_value}
                onChange={e => setForm(f => ({ ...f, match_value: e.target.value }))}
                placeholder="e.g. FIREWALL_DISABLED"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Agent (leave blank for global)</label>
              <select
                value={form.agent_id}
                onChange={e => setForm(f => ({ ...f, agent_id: e.target.value }))}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
              >
                <option value="">— Global —</option>
                {agents.map(a => (
                  <option key={a.id} value={a.id}>{a.display_name || a.hostname}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Expires At (optional)</label>
              <input
                type="date"
                value={form.expires_at}
                onChange={e => setForm(f => ({ ...f, expires_at: e.target.value }))}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-slate-400 mb-1">Reason</label>
              <input
                value={form.reason}
                onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                placeholder="Business justification..."
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
              />
            </div>
            <div className="col-span-2 flex gap-3 justify-end">
              <button type="button" onClick={() => setShowAdd(false)} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm">Cancel</button>
              <button type="submit" disabled={saving} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm disabled:opacity-50">
                {saving ? 'Saving...' : 'Add Exception'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-slate-400">Loading...</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-slate-400">No exceptions configured</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-slate-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 text-left">Type</th>
                <th className="px-4 py-3 text-left">Match Value</th>
                <th className="px-4 py-3 text-left">Agent</th>
                <th className="px-4 py-3 text-left">Reason</th>
                <th className="px-4 py-3 text-left">Expires</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {rows.map(row => (
                <tr key={row.id} className="hover:bg-slate-700/50">
                  <td className="px-4 py-3">
                    <span className="text-xs px-2 py-0.5 rounded-full border bg-slate-700 text-slate-300 border-slate-600 capitalize">{row.exception_type}</span>
                  </td>
                  <td className="px-4 py-3 text-white font-mono text-xs">{row.match_value}</td>
                  <td className="px-4 py-3 text-slate-300 text-xs">{row.hostname || <span className="text-slate-500">Global</span>}</td>
                  <td className="px-4 py-3 text-slate-400 text-xs">{row.reason || '—'}</td>
                  <td className="px-4 py-3 text-slate-400 text-xs">{row.expires_at ? new Date(row.expires_at).toLocaleDateString() : 'Never'}</td>
                  <td className="px-4 py-3">
                    {row.is_active
                      ? <span className="text-xs px-2 py-0.5 rounded-full border bg-green-900/40 text-green-300 border-green-700">Active</span>
                      : <span className="text-xs px-2 py-0.5 rounded-full border bg-slate-800 text-slate-400 border-slate-600">Inactive</span>
                    }
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleDelete(row.id)}
                      className="text-slate-500 hover:text-red-400"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── Tab: Software Vulnerabilities (CVE per agent) ─────────────────────────────
function VulnerabilitiesTab({ zeroDay = false }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterSeverity, setFilterSeverity] = useState('')
  const [expanded, setExpanded] = useState({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const endpoint = zeroDay ? '/threats/vulnerabilities/zero-day' : '/threats/vulnerabilities'
      const data = await apiFetch(endpoint)
      setRows(data)
    } catch { setRows([]) }
    setLoading(false)
  }, [zeroDay])

  useEffect(() => { load() }, [load])

  const filtered = rows.filter(r => {
    const q = search.toLowerCase()
    if (q && !r.hostname?.toLowerCase().includes(q) && !r.cve_id?.toLowerCase().includes(q) && !r.software_name?.toLowerCase().includes(q)) return false
    if (filterSeverity && r.severity !== filterSeverity) return false
    return true
  })

  async function handleMarkRemediated(id) {
    try {
      await apiFetch(`/threats/vulnerabilities/${id}/mark-remediated`, { method: 'POST', body: JSON.stringify({}) })
      load()
    } catch (e) { alert('Failed: ' + e.message) }
  }

  return (
    <div className="space-y-4">
      {zeroDay && (
        <div className="flex items-center gap-3 p-4 bg-red-900/30 border border-red-700/50 rounded-xl">
          <Zap size={18} className="text-red-400 flex-shrink-0" />
          <div className="text-sm text-red-200">Zero-day vulnerabilities: published within 30 days, critical/high severity, no fix available</div>
        </div>
      )}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className="bg-slate-800 border border-slate-600 rounded-lg pl-8 pr-3 py-2 text-sm text-white w-56"
            placeholder="Search host / CVE / software..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select
          value={filterSeverity}
          onChange={e => setFilterSeverity(e.target.value)}
          className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option value="">All severities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <button onClick={load} className="ml-auto flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-white">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="text-sm text-slate-400">{filtered.length} finding{filtered.length !== 1 ? 's' : ''}</div>

      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-slate-400">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-slate-400">
            {zeroDay ? 'No zero-day vulnerabilities detected' : 'No software vulnerabilities detected'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-slate-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 text-left w-8"></th>
                <th className="px-4 py-3 text-left">Host</th>
                <th className="px-4 py-3 text-left">CVE ID</th>
                <th className="px-4 py-3 text-left">Software</th>
                <th className="px-4 py-3 text-left">Version</th>
                <th className="px-4 py-3 text-left">Severity</th>
                <th className="px-4 py-3 text-left">CVSS</th>
                <th className="px-4 py-3 text-left">Detected</th>
                <th className="px-4 py-3 text-left">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {filtered.map(row => (
                <>
                  <tr
                    key={row.id}
                    className={`hover:bg-slate-700/50 cursor-pointer ${row.is_zero_day ? 'bg-red-900/10' : ''}`}
                    onClick={() => setExpanded(e => ({ ...e, [row.id]: !e[row.id] }))}
                  >
                    <td className="px-4 py-3 text-slate-400">
                      {expanded[row.id] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </td>
                    <td className="px-4 py-3 text-white">
                      <div className="font-medium">{row.display_name || row.hostname}</div>
                      <div className="text-xs text-slate-400">{row.ip_address}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-blue-300 text-xs">{row.cve_id}</span>
                        {row.is_zero_day && <span className="text-xs px-1.5 py-0.5 rounded bg-red-900/40 text-red-300 border border-red-700/50">0-day</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-200">{row.software_name}</td>
                    <td className="px-4 py-3 text-slate-400 font-mono text-xs">{row.software_version || '—'}</td>
                    <td className="px-4 py-3"><SeverityBadge severity={row.severity} /></td>
                    <td className="px-4 py-3 text-slate-300 font-mono text-xs">{row.cvss_score ?? '—'}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs">
                      {row.detected_at ? new Date(row.detected_at).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => handleMarkRemediated(row.id)}
                        className="text-xs px-2 py-1 bg-green-600/20 hover:bg-green-600/40 text-green-300 border border-green-700/50 rounded"
                      >
                        Mark Fixed
                      </button>
                    </td>
                  </tr>
                  {expanded[row.id] && (
                    <tr key={`${row.id}-d`} className="bg-slate-900/50">
                      <td colSpan={9} className="px-8 py-4">
                        <div className="text-sm text-slate-300 mb-2">{row.description || 'No description available'}</div>
                        {row.published_date && (
                          <div className="text-xs text-slate-500">Published: {new Date(row.published_date).toLocaleDateString()}</div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── Tab: Detected CVEs (CVE-centric view) ─────────────────────────────────────
function DetectedCVEsTab() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/threats/vulnerabilities/cve-view')
      setRows(data)
    } catch { setRows([]) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = rows.filter(r => {
    const q = search.toLowerCase()
    return !q || r.cve_id?.toLowerCase().includes(q) || r.software_names?.toLowerCase().includes(q) || r.hostnames?.toLowerCase().includes(q)
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className="bg-slate-800 border border-slate-600 rounded-lg pl-8 pr-3 py-2 text-sm text-white w-64"
            placeholder="Search CVE / software / host..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <button onClick={load} className="ml-auto flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-white">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="text-sm text-slate-400">{filtered.length} CVE{filtered.length !== 1 ? 's' : ''} across all agents</div>

      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-slate-400">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-slate-400">No CVEs detected</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-slate-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 text-left w-8"></th>
                <th className="px-4 py-3 text-left">CVE ID</th>
                <th className="px-4 py-3 text-left">Severity</th>
                <th className="px-4 py-3 text-left">CVSS</th>
                <th className="px-4 py-3 text-left">Affected Software</th>
                <th className="px-4 py-3 text-left">Affected Agents</th>
                <th className="px-4 py-3 text-left">Published</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {filtered.map((row, i) => (
                <>
                  <tr
                    key={row.cve_id}
                    className={`hover:bg-slate-700/50 cursor-pointer ${row.is_zero_day ? 'bg-red-900/10' : ''}`}
                    onClick={() => setExpanded(e => ({ ...e, [i]: !e[i] }))}
                  >
                    <td className="px-4 py-3 text-slate-400">
                      {expanded[i] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-blue-300">{row.cve_id}</span>
                        {row.is_zero_day && <span className="text-xs px-1.5 py-0.5 rounded bg-red-900/40 text-red-300 border border-red-700/50">0-day</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3"><SeverityBadge severity={row.severity} /></td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-300">{row.cvss_score ?? '—'}</td>
                    <td className="px-4 py-3 text-slate-300 text-xs max-w-xs truncate">{row.software_names || '—'}</td>
                    <td className="px-4 py-3">
                      <span className="text-white font-medium">{row.agent_count}</span>
                      <span className="text-slate-400 text-xs ml-1 truncate max-w-[180px] block">{row.hostnames}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-400 text-xs">
                      {row.published_date ? new Date(row.published_date).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                  {expanded[i] && (
                    <tr key={`cve-${row.cve_id}-d`} className="bg-slate-900/50">
                      <td colSpan={7} className="px-8 py-4">
                        <div className="text-sm text-slate-300">{row.description || 'No description available'}</div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── Tab: Web Server Misconfiguration ─────────────────────────────────────────
function WebConfigTab() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState({})

  const load = useCallback(async () => {
    setLoading(true)
    try { setRows(await apiFetch('/threats/webconfig')) }
    catch { setRows([]) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = rows.filter(r => {
    const q = search.toLowerCase()
    return !q || r.hostname?.toLowerCase().includes(q) || r.title?.toLowerCase().includes(q) || r.server_type?.toLowerCase().includes(q)
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className="bg-slate-800 border border-slate-600 rounded-lg pl-8 pr-3 py-2 text-sm text-white w-56"
            placeholder="Search host / rule..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <button onClick={load} className="ml-auto flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-white">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      <div className="text-sm text-slate-400">{filtered.length} finding{filtered.length !== 1 ? 's' : ''}</div>
      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        {loading ? <div className="p-8 text-center text-slate-400">Loading...</div>
          : filtered.length === 0 ? <div className="p-8 text-center text-slate-400">No web server misconfigurations found</div>
          : (
            <table className="w-full text-sm">
              <thead className="bg-slate-900 text-slate-400 text-xs uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3 text-left w-8"></th>
                  <th className="px-4 py-3 text-left">Host</th>
                  <th className="px-4 py-3 text-left">Server</th>
                  <th className="px-4 py-3 text-left">Finding</th>
                  <th className="px-4 py-3 text-left">Severity</th>
                  <th className="px-4 py-3 text-left">Config File</th>
                  <th className="px-4 py-3 text-left">Detected</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {filtered.map(row => (
                  <>
                    <tr key={row.id} className="hover:bg-slate-700/50 cursor-pointer" onClick={() => setExpanded(e => ({ ...e, [row.id]: !e[row.id] }))}>
                      <td className="px-4 py-3 text-slate-400">{expanded[row.id] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                      <td className="px-4 py-3 text-white">
                        <div className="font-medium">{row.display_name || row.hostname}</div>
                        <div className="text-xs text-slate-400">{row.ip_address}</div>
                      </td>
                      <td className="px-4 py-3"><span className="text-xs px-2 py-0.5 rounded-full border bg-slate-700 text-slate-300 border-slate-600 uppercase">{row.server_type}</span></td>
                      <td className="px-4 py-3 text-slate-200">{row.title}</td>
                      <td className="px-4 py-3"><SeverityBadge severity={row.severity} /></td>
                      <td className="px-4 py-3 text-slate-400 font-mono text-xs truncate max-w-xs">{row.config_file || '—'}</td>
                      <td className="px-4 py-3 text-slate-400 text-xs">{row.detected_at ? new Date(row.detected_at).toLocaleDateString() : '—'}</td>
                    </tr>
                    {expanded[row.id] && (
                      <tr key={`${row.id}-d`} className="bg-slate-900/50">
                        <td colSpan={7} className="px-8 py-4 space-y-2">
                          {row.detail && <div className="text-sm text-slate-300">{row.detail}</div>}
                          {row.remediation && (
                            <div>
                              <div className="text-xs text-slate-400 font-medium mb-1">Remediation</div>
                              <div className="text-xs text-slate-300 bg-slate-800 rounded-lg p-3 font-mono whitespace-pre-wrap">{row.remediation}</div>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </div>
  )
}

// ── Summary stats bar ──────────────────────────────────────────────────────────
function ThreatSummary({ data }) {
  if (!data) return null
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <div className="text-xs text-slate-400 mb-1">Misconfig Failures</div>
        <div className="text-2xl font-bold text-red-400">{data.misconfigs?.total_fail ?? '—'}</div>
        <div className="text-xs text-slate-500 mt-1">Critical: {data.misconfigs?.critical_fail ?? 0}</div>
      </div>
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <div className="text-xs text-slate-400 mb-1">CVE Vulnerabilities</div>
        <div className="text-2xl font-bold text-red-400">{data.vulnerabilities?.critical ?? '—'}</div>
        <div className="text-xs text-slate-500 mt-1">Critical · {data.vulnerabilities?.zero_day ?? 0} zero-day</div>
      </div>
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <div className="text-xs text-slate-400 mb-1">High-Risk Software</div>
        <div className="text-2xl font-bold text-orange-400">{data.high_risk_software?.total ?? '—'}</div>
        <div className="text-xs text-slate-500 mt-1">EOL: {data.high_risk_software?.eol ?? 0} · P2P: {data.high_risk_software?.p2p ?? 0}</div>
      </div>
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <div className="text-xs text-slate-400 mb-1">Dangerous Ports</div>
        <div className="text-2xl font-bold text-blue-400">{data.ports?.dangerous ?? '—'}</div>
        <div className="text-xs text-slate-500 mt-1">Total open: {data.ports?.total ?? 0}</div>
      </div>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'misconfigs', label: 'System Misconfigurations', icon: AlertTriangle },
  { id: 'high-risk', label: 'High Risk Software', icon: PackageX },
  { id: 'ports', label: 'Port Audit', icon: Wifi },
  { id: 'vulns', label: 'Software Vulnerabilities', icon: Bug },
  { id: 'cves', label: 'Detected CVEs', icon: Eye },
  { id: 'zero-day', label: 'Zero-day', icon: Zap },
  { id: 'webconfig', label: 'Web Server Misconfiguration', icon: Globe },
  { id: 'exceptions', label: 'Manage Exceptions', icon: Ban },
]

export default function Threats() {
  const [activeTab, setActiveTab] = useState('misconfigs')
  const [dashData, setDashData] = useState(null)

  useEffect(() => {
    apiFetch('/threats/dashboard').then(setDashData).catch(() => {})
  }, [])

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-red-600/20 flex items-center justify-center">
          <ShieldAlert size={20} className="text-red-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Threats</h1>
          <p className="text-sm text-slate-400">Security configuration and risk assessment</p>
        </div>
      </div>

      {/* Summary */}
      <ThreatSummary data={dashData} />

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-700 mb-6">
        {TABS.map(tab => {
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-blue-500 text-white'
                  : 'border-transparent text-slate-400 hover:text-white'
              }`}
            >
              <Icon size={15} />
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Tab content */}
      {activeTab === 'misconfigs' && <MisconfigTab />}
      {activeTab === 'high-risk' && <HighRiskTab />}
      {activeTab === 'ports' && <PortAuditTab />}
      {activeTab === 'vulns' && <VulnerabilitiesTab />}
      {activeTab === 'cves' && <DetectedCVEsTab />}
      {activeTab === 'zero-day' && <VulnerabilitiesTab zeroDay={true} />}
      {activeTab === 'webconfig' && <WebConfigTab />}
      {activeTab === 'exceptions' && <ExceptionsTab />}
    </div>
  )
}
