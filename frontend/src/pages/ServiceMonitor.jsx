import { useState, useEffect, useCallback } from 'react'
import {
  RefreshCw, Search, Play, RotateCcw, Plus, X, CheckCircle2,
  AlertCircle, Clock, Server, Zap, Shield, Wifi, WifiOff, Eye,
} from 'lucide-react'
import api from '../api/client'

const STATUS_STYLE = {
  running:  'bg-emerald-500/15 text-emerald-400 border-emerald-600/40',
  stopped:  'bg-red-500/15 text-red-400 border-red-600/40',
  starting: 'bg-amber-500/15 text-amber-400 border-amber-600/40',
  stopping: 'bg-amber-500/15 text-amber-400 border-amber-600/40',
  failed:   'bg-red-500/15 text-red-400 border-red-600/40',
  unknown:  'bg-slate-700 text-slate-400 border-slate-600',
}

function StatusBadge({ status }) {
  const cls = STATUS_STYLE[status] || STATUS_STYLE.unknown
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${cls}`}>
      {status || '—'}
    </span>
  )
}

function AgentBadge({ agentStatus }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full mr-1.5 flex-shrink-0 ${agentStatus === 'online' ? 'bg-emerald-400' : 'bg-slate-500'}`} />
  )
}

function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
        checked ? 'bg-blue-600' : 'bg-slate-600'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
    </button>
  )
}

// ── Add Service Modal ──────────────────────────────────────────────────────────
function AddServiceModal({ onClose, onAdded }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState(null)

  const search = useCallback(async (q) => {
    if (q.length < 2) { setResults([]); return }
    setLoading(true)
    try {
      const r = await api.get(`/services/search?q=${encodeURIComponent(q)}`)
      setResults(r.data || [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => search(query), 300)
    return () => clearTimeout(t)
  }, [query, search])

  async function add(svc, autoRestart) {
    setAdding(svc.id)
    try {
      await api.patch(`/services/${svc.id}/monitor`, { monitored: true, auto_restart: autoRestart })
      onAdded()
      // Update result in-place
      setResults(r => r.map(s => s.id === svc.id ? { ...s, monitored: true, auto_restart: autoRestart } : s))
    } finally {
      setAdding(null)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-2xl shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-slate-700">
          <h2 className="text-white font-semibold text-lg">Add Service to Monitor</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search service name (e.g. Remote Desktop, MSSQL, IIS)…"
              className="w-full bg-slate-900 border border-slate-600 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {loading && <div className="text-slate-400 text-sm text-center py-4">Searching…</div>}

          {!loading && results.length === 0 && query.length >= 2 && (
            <div className="text-slate-500 text-sm text-center py-4">No services found</div>
          )}

          {results.length > 0 && (
            <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-700 divide-y divide-slate-700">
              {results.map(svc => (
                <div key={svc.id} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-700/50 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <AgentBadge agentStatus="online" />
                      <span className="text-slate-400 text-xs">{svc.agent_display || svc.hostname}</span>
                    </div>
                    <div className="text-white text-sm font-medium mt-0.5">{svc.display_name || svc.service_name}</div>
                    <div className="text-slate-500 text-xs font-mono">{svc.service_name}</div>
                  </div>
                  <StatusBadge status={svc.status} />
                  {svc.monitored ? (
                    <span className="text-emerald-400 text-xs flex items-center gap-1">
                      <CheckCircle2 size={13} /> Monitored
                    </span>
                  ) : (
                    <div className="flex gap-2 flex-shrink-0">
                      <button
                        disabled={adding === svc.id}
                        onClick={() => add(svc, false)}
                        className="px-3 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-colors disabled:opacity-50"
                      >
                        Monitor
                      </button>
                      <button
                        disabled={adding === svc.id}
                        onClick={() => add(svc, true)}
                        className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1"
                      >
                        <Zap size={11} /> + Auto-restart
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Watchdog Tab ──────────────────────────────────────────────────────────────
const WATCHDOG_CLASS = {
  online:         { label: 'Online',               color: 'text-emerald-400', border: 'border-emerald-600/40', bg: 'bg-emerald-500/15', icon: CheckCircle2 },
  restart_ok:     { label: 'Restart sent',         color: 'text-blue-400',    border: 'border-blue-600/40',    bg: 'bg-blue-500/15',    icon: RotateCcw },
  restart_failed: { label: 'Restart failed',       color: 'text-red-400',     border: 'border-red-600/40',     bg: 'bg-red-500/15',     icon: AlertCircle },
  offline:        { label: 'Machine offline',      color: 'text-slate-400',   border: 'border-slate-600',      bg: 'bg-slate-700',      icon: WifiOff },
  unknown:        { label: 'Unknown',              color: 'text-slate-400',   border: 'border-slate-600',      bg: 'bg-slate-700',      icon: Eye },
}

function WatchdogBadge({ cls }) {
  const cfg = WATCHDOG_CLASS[cls] || WATCHDOG_CLASS.unknown
  const Icon = cfg.icon
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${cfg.bg} ${cfg.color} ${cfg.border}`}>
      <Icon size={10} /> {cfg.label}
    </span>
  )
}

function WatchdogTab() {
  const [agents, setAgents] = useState([])
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState({})

  const load = useCallback(async () => {
    try {
      const [aR, eR] = await Promise.all([
        api.get('/agents/watchdog/status'),
        api.get('/agents/watchdog/events?limit=50'),
      ])
      setAgents(aR.data || [])
      setEvents(eR.data || [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t) }, [load])

  async function toggleWatchdog(agent, val) {
    setToggling(t => ({ ...t, [agent.id]: true }))
    try {
      await api.patch(`/agents/${agent.id}/watchdog`, { enabled: val })
      setAgents(a => a.map(x => x.id === agent.id ? { ...x, watchdog_enabled: val } : x))
    } finally {
      setToggling(t => ({ ...t, [agent.id]: false }))
    }
  }

  const restartFailed = agents.filter(a => a.watchdog_class === 'restart_failed')
  const restartOk     = agents.filter(a => a.watchdog_class === 'restart_ok')
  const offline       = agents.filter(a => a.watchdog_class === 'offline')
  const unknown       = agents.filter(a => a.watchdog_class === 'unknown')

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-3xl font-bold text-emerald-400">{agents.filter(a => a.watchdog_class === 'online').length}</div>
          <div className="text-slate-400 text-sm mt-1">Online</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className={`text-3xl font-bold ${restartFailed.length > 0 ? 'text-red-400' : restartOk.length > 0 ? 'text-blue-400' : 'text-slate-500'}`}>
            {restartOk.length + restartFailed.length}
          </div>
          <div className="text-slate-400 text-sm mt-1">Restart attempted</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className={`text-3xl font-bold ${offline.length > 0 ? 'text-slate-400' : 'text-slate-500'}`}>{offline.length}</div>
          <div className="text-slate-400 text-sm mt-1">Machine offline</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className={`text-3xl font-bold ${unknown.length > 0 ? 'text-slate-400' : 'text-slate-500'}`}>{unknown.length}</div>
          <div className="text-slate-400 text-sm mt-1">Unknown</div>
        </div>
      </div>

      {/* Restart failed alert */}
      {restartFailed.length > 0 && (
        <div className="bg-red-500/10 border border-red-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 text-red-400 font-medium mb-3">
            <AlertCircle size={16} />
            {restartFailed.length} agent{restartFailed.length !== 1 ? 's' : ''} could not be restarted automatically
          </div>
          <div className="space-y-2">
            {restartFailed.map(a => (
              <div key={a.id} className="flex items-start gap-3 bg-slate-800/60 rounded-lg px-3 py-2">
                <AlertCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-white text-sm font-medium">{a.display_name || a.hostname}</span>
                    <span className="text-slate-500 text-xs font-mono">{a.ip_address}</span>
                  </div>
                  {a.last_message && <div className="text-red-400 text-xs mt-0.5">{a.last_message}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Restart sent notice */}
      {restartOk.length > 0 && (
        <div className="bg-blue-500/10 border border-blue-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 text-blue-400 font-medium mb-2">
            <RotateCcw size={16} />
            {restartOk.length} agent{restartOk.length !== 1 ? 's' : ''} — restart command sent, waiting for agent to reconnect
          </div>
          <div className="flex flex-wrap gap-2">
            {restartOk.map(a => (
              <span key={a.id} className="text-xs bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-slate-300">
                {a.display_name || a.hostname}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Agent table */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between">
          <h2 className="text-white font-medium">All Agents</h2>
          <span className="text-slate-500 text-xs">Probes port 445 (Windows) or 22 (Linux) every 5 minutes</span>
        </div>
        {loading ? (
          <div className="p-10 text-center text-slate-400 text-sm">Loading…</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700">
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Agent</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">IP</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Agent status</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Last seen</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Last probe</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Watchdog</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {agents.map(a => (
                  <tr key={a.id} className={`transition-colors ${
                    a.watchdog_class === 'restart_failed' ? 'bg-red-500/5 hover:bg-red-500/10' :
                    a.watchdog_class === 'restart_ok'     ? 'bg-blue-500/5 hover:bg-blue-500/10' :
                    'hover:bg-slate-700/20'
                  }`}>
                    <td className="px-5 py-3">
                      <div className="text-white text-sm font-medium">{a.display_name || a.hostname}</div>
                      <div className="text-slate-500 text-xs uppercase">{a.os_type}</div>
                    </td>
                    <td className="px-5 py-3 text-slate-400 text-xs font-mono">{a.ip_address || '—'}</td>
                    <td className="px-5 py-3">
                      <WatchdogBadge cls={a.watchdog_class} />
                    </td>
                    <td className="px-5 py-3 text-slate-500 text-xs">
                      {a.last_seen ? new Date(a.last_seen).toLocaleString() : '—'}
                    </td>
                    <td className="px-5 py-3">
                      {a.last_checked ? (
                        <div>
                          <div className="text-slate-500 text-xs">{new Date(a.last_checked).toLocaleString()}</div>
                          {a.last_message && a.watchdog_class !== 'online' && (
                            <div className={`text-xs mt-0.5 max-w-xs ${a.watchdog_class === 'agent_down' ? 'text-amber-400/70' : 'text-slate-500'}`}>
                              {a.last_message}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-600 text-xs">Not yet probed</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <Toggle
                        checked={a.watchdog_enabled}
                        disabled={toggling[a.id]}
                        onChange={v => toggleWatchdog(a, v)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Events log */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-700">
          <h2 className="text-white font-medium">Probe History</h2>
          <p className="text-slate-500 text-xs mt-0.5">TCP reachability checks for offline agents</p>
        </div>
        {events.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-sm">No events yet — watchdog only runs when agents are offline</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700">
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Time</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Agent</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Endpoint</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Result</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {events.map(evt => (
                  <tr key={evt.id} className={`transition-colors ${evt.action_taken === 'agent_down' ? 'bg-amber-500/5 hover:bg-amber-500/10' : 'hover:bg-slate-700/20'}`}>
                    <td className="px-5 py-3 text-slate-500 text-xs whitespace-nowrap">
                      <div className="flex items-center gap-1.5"><Clock size={12} />{new Date(evt.triggered_at).toLocaleString()}</div>
                    </td>
                    <td className="px-5 py-3">
                      <div className="text-white text-sm">{evt.display_name || evt.hostname}</div>
                      <div className="text-slate-500 text-xs uppercase">{evt.os_type}</div>
                    </td>
                    <td className="px-5 py-3 text-slate-400 text-xs font-mono">{evt.ip_address || '—'}</td>
                    <td className="px-5 py-3">
                      {evt.action_taken === 'restart_attempted' && evt.success && (
                        <span className="inline-flex items-center gap-1 text-xs text-blue-400"><RotateCcw size={12} /> Restart sent</span>
                      )}
                      {evt.action_taken === 'restart_attempted' && !evt.success && (
                        <span className="inline-flex items-center gap-1 text-xs text-red-400"><AlertCircle size={12} /> Restart failed</span>
                      )}
                      {evt.action_taken === 'not_reachable' && (
                        <span className="inline-flex items-center gap-1 text-xs text-slate-500"><WifiOff size={12} /> Not reachable</span>
                      )}
                      {evt.action_taken === 'unknown' && (
                        <span className="inline-flex items-center gap-1 text-xs text-slate-400"><Eye size={12} /> Unknown</span>
                      )}
                    </td>
                    <td className={`px-5 py-3 text-xs max-w-sm ${evt.action_taken === 'restart_attempted' && !evt.success ? 'text-red-400' : 'text-slate-500'}`}>
                      {evt.message || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function ServiceMonitor() {
  const [tab, setTab] = useState('services')
  const [services, setServices] = useState([])
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [restarting, setRestarting] = useState({})
  const [toggling, setToggling] = useState({})
  const [msg, setMsg] = useState(null)

  const load = useCallback(async () => {
    try {
      const [svcR, evtR] = await Promise.all([
        api.get('/service-monitor/monitored'),
        api.get('/service-monitor/events?limit=50'),
      ])
      setServices(svcR.data || [])
      setEvents(evtR.data || [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Auto-refresh every 30s
  useEffect(() => {
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [load])

  function flash(text, type = 'ok') {
    setMsg({ text, type })
    setTimeout(() => setMsg(null), 3000)
  }

  async function manualRestart(svc) {
    setRestarting(r => ({ ...r, [svc.id]: true }))
    try {
      await api.post(`/agents/${svc.agent_id}/service-control`, {
        service_name: svc.service_name,
        action: 'start',
      })
      flash(`Restart queued for ${svc.display_name || svc.service_name}`)
      setTimeout(load, 5000)
    } catch {
      flash('Failed to queue restart', 'err')
    } finally {
      setRestarting(r => ({ ...r, [svc.id]: false }))
    }
  }

  async function toggleAutoRestart(svc, val) {
    setToggling(t => ({ ...t, [svc.id]: true }))
    try {
      await api.patch(`/services/${svc.id}/monitor`, { auto_restart: val })
      setServices(s => s.map(x => x.id === svc.id ? { ...x, auto_restart: val } : x))
    } finally {
      setToggling(t => ({ ...t, [svc.id]: false }))
    }
  }

  async function removeMonitor(svc) {
    try {
      await api.patch(`/services/${svc.id}/monitor`, { monitored: false, auto_restart: false })
      setServices(s => s.filter(x => x.id !== svc.id))
      flash('Removed from monitoring')
    } catch {
      flash('Failed to remove', 'err')
    }
  }

  const stopped = services.filter(s => s.status === 'stopped' || s.status === 'failed')
  const healthy = services.filter(s => s.status === 'running')

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Shield size={24} className="text-blue-400" />
            Service Monitor
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Watch critical services and auto-restart them if they stop
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={load} className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition-colors">
            <RefreshCw size={16} />
          </button>
          {tab === 'services' && (
            <button
              onClick={() => setShowAdd(true)}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Plus size={16} /> Add Service
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-slate-800 border border-slate-700 rounded-xl p-1 w-fit">
        {[['services', 'Service Monitor'], ['watchdog', 'Agent Watchdog']].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === key ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'watchdog' && <WatchdogTab />}
      {tab === 'services' && <>
      {/* Flash message */}
      {msg && (
        <div className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm ${
          msg.type === 'err' ? 'bg-red-500/20 text-red-300 border border-red-700' : 'bg-emerald-500/20 text-emerald-300 border border-emerald-700'
        }`}>
          {msg.type === 'err' ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />}
          {msg.text}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-3xl font-bold text-white">{services.length}</div>
          <div className="text-slate-400 text-sm mt-1">Monitored services</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className={`text-3xl font-bold ${stopped.length > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{stopped.length}</div>
          <div className="text-slate-400 text-sm mt-1">Currently stopped</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-3xl font-bold text-blue-400">
            {services.filter(s => s.auto_restart).length}
          </div>
          <div className="text-slate-400 text-sm mt-1">With auto-restart</div>
        </div>
      </div>

      {/* Stopped services alert */}
      {stopped.length > 0 && (
        <div className="bg-red-500/10 border border-red-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 text-red-400 font-medium mb-3">
            <AlertCircle size={16} />
            {stopped.length} service{stopped.length !== 1 ? 's' : ''} currently stopped
          </div>
          <div className="space-y-2">
            {stopped.map(svc => (
              <div key={svc.id} className="flex items-center justify-between gap-3 bg-slate-800/60 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Server size={14} className="text-slate-400 flex-shrink-0" />
                  <span className="text-slate-400 text-xs">{svc.agent_display || svc.hostname}</span>
                  <span className="text-white text-sm">{svc.display_name || svc.service_name}</span>
                  {svc.auto_restart && (
                    <span className="text-blue-400 text-xs flex items-center gap-1"><Zap size={11} /> auto-restart on</span>
                  )}
                </div>
                <button
                  onClick={() => manualRestart(svc)}
                  disabled={restarting[svc.id] || svc.agent_status !== 'online'}
                  className="flex items-center gap-1.5 px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50"
                >
                  <Play size={11} /> Start Now
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Services table */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between">
          <h2 className="text-white font-medium">Monitored Services</h2>
          <span className="text-slate-500 text-xs">{services.length} total</span>
        </div>

        {loading ? (
          <div className="p-10 text-center text-slate-400 text-sm">Loading…</div>
        ) : services.length === 0 ? (
          <div className="p-10 text-center">
            <Shield size={32} className="text-slate-600 mx-auto mb-3" />
            <div className="text-slate-400 text-sm">No services monitored yet</div>
            <div className="text-slate-500 text-xs mt-1">Click "Add Service" to start monitoring</div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700">
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Agent</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Service</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Status</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Startup</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Auto-restart</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Last updated</th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {services.map(svc => (
                  <tr key={svc.id} className="hover:bg-slate-700/20 transition-colors">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-1.5">
                        <AgentBadge agentStatus={svc.agent_status} />
                        <span className="text-slate-300 text-xs">{svc.agent_display || svc.hostname}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <div className="text-white font-medium">{svc.display_name || svc.service_name}</div>
                      <div className="text-slate-500 text-xs font-mono">{svc.service_name}</div>
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={svc.status} />
                    </td>
                    <td className="px-5 py-3 text-slate-400 text-xs capitalize">{svc.startup_type || '—'}</td>
                    <td className="px-5 py-3">
                      <Toggle
                        checked={svc.auto_restart}
                        disabled={toggling[svc.id]}
                        onChange={v => toggleAutoRestart(svc, v)}
                      />
                    </td>
                    <td className="px-5 py-3 text-slate-500 text-xs">
                      {svc.last_updated ? new Date(svc.last_updated).toLocaleString() : '—'}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {svc.status !== 'running' && (
                          <button
                            onClick={() => manualRestart(svc)}
                            disabled={restarting[svc.id] || svc.agent_status !== 'online'}
                            title="Start service"
                            className="p-1.5 text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 rounded-lg transition-colors disabled:opacity-40"
                          >
                            <Play size={14} />
                          </button>
                        )}
                        {svc.status === 'running' && (
                          <button
                            onClick={() => manualRestart(svc)}
                            disabled={restarting[svc.id] || svc.agent_status !== 'online'}
                            title="Restart service"
                            className="p-1.5 text-slate-400 hover:text-slate-300 hover:bg-slate-700 rounded-lg transition-colors disabled:opacity-40"
                          >
                            <RotateCcw size={14} />
                          </button>
                        )}
                        <button
                          onClick={() => removeMonitor(svc)}
                          title="Remove from monitor"
                          className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Events log */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-700">
          <h2 className="text-white font-medium">Auto-restart Events</h2>
          <p className="text-slate-500 text-xs mt-0.5">Recent automatic service restart triggers</p>
        </div>

        {events.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-sm">No events yet</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700">
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Time</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Agent</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Service</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Event</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {events.map(evt => {
                  const isFailed = evt.event_type === 'start_failed'
                  const isSucceeded = evt.event_type === 'start_succeeded'
                  const isTriggered = evt.event_type === 'auto_restart'
                  return (
                    <tr key={evt.id} className={`transition-colors ${isFailed ? 'bg-red-500/5 hover:bg-red-500/10' : 'hover:bg-slate-700/20'}`}>
                      <td className="px-5 py-3 text-slate-500 text-xs whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <Clock size={12} />
                          {new Date(evt.triggered_at).toLocaleString()}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-slate-300 text-xs">{evt.agent_display || evt.hostname}</td>
                      <td className="px-5 py-3">
                        <div className="text-white text-sm">{evt.display_name || evt.service_name}</div>
                        <div className="text-slate-500 text-xs font-mono">{evt.service_name}</div>
                      </td>
                      <td className="px-5 py-3">
                        {isFailed && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-red-500/15 text-red-400 border-red-600/40">
                            <AlertCircle size={10} /> Failed to start
                          </span>
                        )}
                        {isSucceeded && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-emerald-500/15 text-emerald-400 border-emerald-600/40">
                            <CheckCircle2 size={10} /> Started successfully
                          </span>
                        )}
                        {isTriggered && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-blue-500/15 text-blue-400 border-blue-600/40">
                            <Zap size={10} /> Auto-restart triggered
                          </span>
                        )}
                        {!isFailed && !isSucceeded && !isTriggered && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-slate-700 text-slate-400 border-slate-600">
                            <Play size={10} /> {evt.event_type}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        {evt.message ? (
                          <span className={`text-xs ${isFailed ? 'text-red-400' : 'text-slate-400'}`}>
                            {evt.message}
                          </span>
                        ) : evt.old_status ? (
                          <StatusBadge status={evt.old_status} />
                        ) : (
                          <span className="text-slate-600 text-xs">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showAdd && (
        <AddServiceModal
          onClose={() => setShowAdd(false)}
          onAdded={() => { setShowAdd(false); load() }}
        />
      )}
      </>}
    </div>
  )
}
