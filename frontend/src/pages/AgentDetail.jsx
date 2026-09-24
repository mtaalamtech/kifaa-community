import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { agentsApi, storageApi, siemApi } from '../api/client'
import api from '../api/client'
import {
  ArrowLeft, Cpu, HardDrive, Settings2, AlertTriangle,
  LogIn, Wifi, RefreshCw, ShieldCheck, Tag, History,
  Play, Square, RotateCcw, Trash2, Terminal, Monitor, EyeOff,
  Loader2, MonitorSmartphone, Shield, Activity, Radio, Package,
  Server, Network, Zap, ChevronRight, Info, Lock, Globe,
  CheckCircle2, XCircle, Clock, AlertOctagon, BarChart2,
  ArrowUpRight, Layers, Cpu as CpuIcon, MemoryStick,
} from 'lucide-react'
import { friendlyOS } from '../utils/osName'
import RemoteControl from '../components/RemoteControl'

// ── Helpers ──────────────────────────────────────────────────────────────────

function Tab({ active, onClick, children, badge }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
        active ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-400 hover:text-white'
      }`}
    >
      {children}
      {badge != null && badge > 0 && (
        <span className="ml-1 text-xs bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded-full font-medium">{badge}</span>
      )}
    </button>
  )
}

function InfoRow({ label, value, mono }) {
  return (
    <div className="flex justify-between items-center py-2 border-b border-slate-800 last:border-0">
      <span className="text-sm text-slate-400 shrink-0 mr-4">{label}</span>
      <span className={`text-sm text-white font-medium text-right truncate max-w-xs ${mono ? 'font-mono' : ''}`}>{value || '—'}</span>
    </div>
  )
}

function StatCard({ icon: Icon, label, value, sub, color = 'blue', onClick }) {
  const colors = {
    blue:   'border-blue-800/50 bg-blue-950/30 text-blue-400',
    green:  'border-emerald-800/50 bg-emerald-950/30 text-emerald-400',
    red:    'border-red-800/50 bg-red-950/30 text-red-400',
    yellow: 'border-yellow-800/50 bg-yellow-950/30 text-yellow-400',
    purple: 'border-purple-800/50 bg-purple-950/30 text-purple-400',
    slate:  'border-slate-700 bg-slate-800/50 text-slate-400',
  }
  return (
    <div
      onClick={onClick}
      className={`rounded-xl border p-4 flex items-start gap-3 ${colors[color]} ${onClick ? 'cursor-pointer hover:brightness-110 transition' : ''}`}
    >
      <Icon size={18} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <div className="text-xs text-slate-400 mb-1">{label}</div>
        <div className="text-xl font-bold text-white">{value ?? '—'}</div>
        {sub && <div className="text-xs text-slate-500 mt-0.5 truncate">{sub}</div>}
      </div>
    </div>
  )
}

function StatusBadge({ status }) {
  const map = {
    online:  'bg-emerald-500/20 text-emerald-400 border border-emerald-800/50',
    offline: 'bg-slate-700 text-slate-400 border border-slate-600',
    running: 'bg-emerald-500/20 text-emerald-400',
    stopped: 'bg-red-500/20 text-red-400',
    failed:  'bg-red-500/20 text-red-400',
    starting:'bg-yellow-500/20 text-yellow-400',
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${map[status] || 'bg-slate-700 text-slate-400'}`}>
      {status}
    </span>
  )
}

function SeverityBadge({ sev }) {
  const map = {
    critical: 'bg-red-500/20 text-red-400 border border-red-800/50',
    high:     'bg-orange-500/20 text-orange-400 border border-orange-800/50',
    medium:   'bg-yellow-500/20 text-yellow-400 border border-yellow-800/50',
    low:      'bg-slate-600 text-slate-300 border border-slate-600',
    info:     'bg-blue-500/20 text-blue-400 border border-blue-800/50',
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${map[sev] || 'bg-slate-700 text-slate-400'}`}>
      {sev || 'unknown'}
    </span>
  )
}

function LevelBadge({ level }) {
  const map = {
    critical: 'bg-red-500/20 text-red-400',
    error:    'bg-orange-500/20 text-orange-400',
    warning:  'bg-yellow-500/20 text-yellow-400',
    info:     'bg-blue-500/20 text-blue-300',
    debug:    'bg-slate-700 text-slate-400',
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${map[level] || 'bg-slate-700 text-slate-400'}`}>
      {level}
    </span>
  )
}

// Simple SVG sparkline
function Sparkline({ data, color = '#3b82f6', height = 40 }) {
  if (!data || data.length < 2) return <div className="h-10 flex items-center justify-center text-xs text-slate-600">No data</div>
  const values = data.map(d => d.value)
  const min = Math.min(...values)
  const max = Math.max(...values) || 1
  const w = 300
  const h = height
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w
    const y = h - ((v - min) / (max - min || 1)) * (h - 4) - 2
    return `${x},${y}`
  })
  const last = values[values.length - 1]
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height }}>
        <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={parseFloat(pts[pts.length-1].split(',')[0])} cy={parseFloat(pts[pts.length-1].split(',')[1])} r="3" fill={color} />
      </svg>
      <div className="absolute top-0 right-0 text-xs font-bold" style={{ color }}>{last?.toFixed(1)}%</div>
    </div>
  )
}

// ── History tab ───────────────────────────────────────────────────────────────

const EVENT_META = {
  registered:     { icon: LogIn,      color: 'text-green-400',  label: 'Registered' },
  status_change:  { icon: RefreshCw,  color: 'text-blue-400',   label: 'Status Changed' },
  ip_change:      { icon: Wifi,       color: 'text-yellow-400', label: 'IP Changed' },
  version_change: { icon: Tag,        color: 'text-purple-400', label: 'Version Updated' },
  update_queued:  { icon: RefreshCw,  color: 'text-orange-400', label: 'Update Queued' },
  patch_scan:     { icon: ShieldCheck,color: 'text-teal-400',   label: 'Patch Scan Result' },
}

function HistoryTab({ agentId }) {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get(`/agents/${agentId}/history?limit=200`)
      .then(r => setEvents(r.data))
      .finally(() => setLoading(false))
  }, [agentId])

  if (loading) return <div className="py-12 text-center text-slate-500">Loading…</div>
  if (!events.length) return <div className="py-12 text-center text-slate-500">No history yet.</div>

  return (
    <div className="relative">
      <div className="absolute left-5 top-0 bottom-0 w-px bg-slate-700" />
      <div className="space-y-0">
        {events.map(ev => {
          const meta = EVENT_META[ev.event_type] || { icon: Tag, color: 'text-slate-400', label: ev.event_type }
          const Icon = meta.icon
          return (
            <div key={ev.id} className="relative flex gap-4 pl-12 py-3 hover:bg-slate-800/30 rounded-lg">
              <div className={`absolute left-3 top-4 w-4 h-4 rounded-full border-2 border-slate-700 bg-slate-900 flex items-center justify-center ${meta.color}`}>
                <div className="w-1.5 h-1.5 rounded-full bg-current" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <Icon size={13} className={meta.color} />
                    <span className="text-sm font-medium text-white">{meta.label}</span>
                    {ev.field && <span className="text-xs text-slate-500 font-mono">[{ev.field}]</span>}
                  </div>
                  <span className="text-xs text-slate-500 whitespace-nowrap">
                    {ev.created_at ? new Date(ev.created_at).toLocaleString() : ''}
                  </span>
                </div>
                {ev.old_value && ev.new_value ? (
                  <div className="mt-1 flex items-center gap-2 text-xs">
                    <span className="text-red-400 line-through">{ev.old_value}</span>
                    <span className="text-slate-500">→</span>
                    <span className="text-green-400">{ev.new_value}</span>
                  </div>
                ) : ev.new_value ? (
                  <div className="mt-1 text-xs text-slate-300">{ev.new_value}</div>
                ) : null}
                {ev.details && Object.keys(ev.details).length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-2">
                    {Object.entries(ev.details).map(([k, v]) => (
                      <span key={k} className="text-xs text-slate-400">
                        <span className="text-slate-500">{k}:</span> {String(v)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Patches tab ───────────────────────────────────────────────────────────────

function PatchesTab({ agentId }) {
  const [pending, setPending] = useState([])
  const [jobs, setJobs] = useState([])       // patch_jobs (all OS)
  const [winHistory, setWinHistory] = useState([]) // Windows Update history
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState('pending')

  useEffect(() => {
    Promise.all([
      api.get(`/patches/agents/${agentId}/updates`).catch(() => ({ data: [] })),
      api.get('/patches/jobs', { params: { agent_id: agentId, limit: 100 } }).catch(() => ({ data: [] })),
      api.get(`/patches/agents/${agentId}/update-history`).catch(() => ({ data: [] })),
    ]).then(([p, j, wh]) => {
      setPending(p.data || [])
      setJobs(j.data || [])
      setWinHistory(wh.data || [])
    }).finally(() => setLoading(false))
  }, [agentId])

  if (loading) return <div className="py-12 text-center text-slate-500">Loading…</div>

  const catColors = {
    security:    'text-red-400 bg-red-500/10 border-red-800/40',
    critical:    'text-red-400 bg-red-500/10 border-red-800/40',
    recommended: 'text-yellow-400 bg-yellow-500/10 border-yellow-800/40',
    optional:    'text-slate-400 bg-slate-700 border-slate-600',
  }
  const cats = {}
  pending.forEach(p => { cats[p.category] = (cats[p.category] || 0) + 1 })

  const totalHistory = jobs.length + winHistory.length

  return (
    <div className="space-y-4">
      {/* Summary row */}
      <div className="flex flex-wrap gap-3 mb-2">
        {Object.entries(cats).map(([cat, cnt]) => (
          <span key={cat} className={`text-xs px-3 py-1 rounded-full border font-medium capitalize ${catColors[cat] || 'text-slate-400 bg-slate-700 border-slate-600'}`}>
            {cat}: {cnt}
          </span>
        ))}
        {!pending.length && (
          <span className="text-xs text-emerald-400 flex items-center gap-1">
            <CheckCircle2 size={13} /> No pending updates
          </span>
        )}
      </div>

      {/* Toggle */}
      <div className="flex gap-2">
        <button onClick={() => setView('pending')}
          className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${view === 'pending' ? 'bg-blue-900/40 border-blue-700 text-blue-300' : 'border-slate-700 text-slate-400 hover:border-slate-600'}`}>
          Pending ({pending.length})
        </button>
        <button onClick={() => setView('jobs')}
          className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${view === 'jobs' ? 'bg-blue-900/40 border-blue-700 text-blue-300' : 'border-slate-700 text-slate-400 hover:border-slate-600'}`}>
          Patch Jobs ({jobs.length})
        </button>
        {winHistory.length > 0 && (
          <button onClick={() => setView('winhistory')}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${view === 'winhistory' ? 'bg-blue-900/40 border-blue-700 text-blue-300' : 'border-slate-700 text-slate-400 hover:border-slate-600'}`}>
            Windows Updates ({winHistory.length})
          </button>
        )}
      </div>

      {view === 'pending' && (
        <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-700 bg-slate-800/50">
                <th className="px-4 py-3 font-medium">Package</th>
                <th className="px-4 py-3 font-medium">Current</th>
                <th className="px-4 py-3 font-medium">Available</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 font-medium">Description</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((p, i) => (
                <tr key={i} className="border-b border-slate-800 hover:bg-slate-800/30">
                  <td className="px-4 py-2 font-mono text-xs text-slate-200">{p.package_name}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-400">{p.current_version || '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs text-emerald-400">{p.available_version || '—'}</td>
                  <td className="px-4 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${catColors[p.category] || 'text-slate-400 bg-slate-700'} border`}>
                      {p.category || 'other'}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-400 max-w-xs truncate">{p.description || '—'}</td>
                </tr>
              ))}
              {!pending.length && (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-500">No pending updates</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {view === 'jobs' && (
        <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-700 bg-slate-800/50">
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Triggered By</th>
                <th className="px-4 py-3 font-medium">Packages</th>
                <th className="px-4 py-3 font-medium">Started</th>
                <th className="px-4 py-3 font-medium">Finished</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j, i) => {
                const pkgs = Array.isArray(j.packages) ? j.packages : []
                return (
                  <tr key={i} className="border-b border-slate-800 hover:bg-slate-800/30">
                    <td className="px-4 py-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${j.job_type === 'apply' ? 'bg-blue-500/20 text-blue-400' : 'bg-slate-700 text-slate-400'}`}>
                        {j.job_type}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        j.status === 'success' ? 'bg-emerald-500/20 text-emerald-400' :
                        j.status === 'failed'  ? 'bg-red-500/20 text-red-400' :
                        j.status === 'running' ? 'bg-blue-500/20 text-blue-400' :
                        'bg-slate-700 text-slate-400'
                      }`}>
                        {j.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-400">{j.triggered_by || '—'}</td>
                    <td className="px-4 py-2 text-xs text-slate-400">
                      {pkgs.length > 0 ? (
                        <span title={pkgs.join(', ')}>{pkgs.length} package{pkgs.length !== 1 ? 's' : ''}</span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-400">
                      {j.started_at ? new Date(j.started_at).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-400">
                      {j.finished_at ? new Date(j.finished_at).toLocaleString() : '—'}
                    </td>
                  </tr>
                )
              })}
              {!jobs.length && (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-500">No patch jobs recorded</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {view === 'winhistory' && (
        <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-700 bg-slate-800/50">
                <th className="px-4 py-3 font-medium">Title</th>
                <th className="px-4 py-3 font-medium">KB</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 font-medium">Result</th>
                <th className="px-4 py-3 font-medium">Installed</th>
              </tr>
            </thead>
            <tbody>
              {winHistory.map((h, i) => (
                <tr key={i} className="border-b border-slate-800 hover:bg-slate-800/30">
                  <td className="px-4 py-2 text-slate-200 text-xs max-w-xs truncate">{h.title}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-400">{h.kb || '—'}</td>
                  <td className="px-4 py-2 text-xs text-slate-400 capitalize">{h.category || '—'}</td>
                  <td className="px-4 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${h.result === 'success' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                      {h.result || '—'}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-400">
                    {h.installed_at ? new Date(h.installed_at).toLocaleDateString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Security tab ──────────────────────────────────────────────────────────────

function SecurityTab({ agentId }) {
  const [misconfigs, setMisconfigs] = useState([])
  const [ports, setPorts] = useState([])
  const [vulns, setVulns] = useState([])
  const [highRisk, setHighRisk] = useState([])
  const [loading, setLoading] = useState(true)
  const [section, setSection] = useState('misconfigs')

  useEffect(() => {
    Promise.all([
      api.get(`/threats/misconfigs/${agentId}`).catch(() => ({ data: [] })),
      api.get(`/threats/ports/${agentId}`).catch(() => ({ data: [] })),
      api.get('/threats/vulnerabilities', { params: { agent_id: agentId, limit: 200 } }).catch(() => ({ data: { items: [] } })),
      api.get('/threats/high-risk', { params: { agent_id: agentId } }).catch(() => ({ data: [] })),
    ]).then(([m, p, v, h]) => {
      setMisconfigs(m.data || [])
      setPorts(p.data || [])
      setVulns(v.data?.items || v.data || [])
      setHighRisk(h.data || [])
    }).finally(() => setLoading(false))
  }, [agentId])

  if (loading) return <div className="py-12 text-center text-slate-500">Loading…</div>

  const sections = [
    { key: 'misconfigs', label: 'Misconfigs', count: misconfigs.length, icon: AlertOctagon },
    { key: 'ports', label: 'Open Ports', count: ports.length, icon: Network },
    { key: 'vulns', label: 'CVEs', count: vulns.length, icon: Shield },
    { key: 'highrisk', label: 'High-Risk SW', count: highRisk.length, icon: AlertTriangle },
  ]

  return (
    <div className="space-y-4">
      {/* Section nav */}
      <div className="flex flex-wrap gap-2">
        {sections.map(s => {
          const Icon = s.icon
          return (
            <button key={s.key} onClick={() => setSection(s.key)}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                section === s.key ? 'bg-blue-900/40 border-blue-700 text-blue-300' : 'border-slate-700 text-slate-400 hover:border-slate-600'
              }`}>
              <Icon size={12} />
              {s.label}
              {s.count > 0 && (
                <span className="ml-1 bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded-full">{s.count}</span>
              )}
            </button>
          )
        })}
      </div>

      {section === 'misconfigs' && (
        <div className="space-y-2">
          {misconfigs.length === 0 && <div className="py-10 text-center text-slate-500 text-sm">No misconfigurations found</div>}
          {misconfigs.map((m, i) => (
            <div key={i} className="bg-slate-900 border border-slate-700 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <SeverityBadge sev={m.severity} />
                    <span className="text-xs text-slate-500 capitalize">{m.category}</span>
                  </div>
                  <div className="text-sm font-medium text-white">{m.title}</div>
                  {m.description && <div className="text-xs text-slate-400 mt-1">{m.description}</div>}
                  {m.remediation && (
                    <div className="mt-2 text-xs text-slate-400 bg-slate-800 rounded p-2 border border-slate-700">
                      <span className="text-slate-500">Remediation: </span>{m.remediation}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {section === 'ports' && (
        <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-700 bg-slate-800/50">
                <th className="px-4 py-3 font-medium">Port</th>
                <th className="px-4 py-3 font-medium">Protocol</th>
                <th className="px-4 py-3 font-medium">Process</th>
                <th className="px-4 py-3 font-medium">PID</th>
                <th className="px-4 py-3 font-medium">Bind</th>
                <th className="px-4 py-3 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {ports.map((p, i) => (
                <tr key={i} className="border-b border-slate-800 hover:bg-slate-800/30">
                  <td className="px-4 py-2 font-mono text-sm font-bold text-white">{p.port}</td>
                  <td className="px-4 py-2 text-xs text-slate-400 uppercase">{p.protocol}</td>
                  <td className="px-4 py-2 text-xs text-slate-300">{p.process_name || '—'}</td>
                  <td className="px-4 py-2 text-xs font-mono text-slate-500">{p.process_pid || '—'}</td>
                  <td className="px-4 py-2 text-xs font-mono text-slate-400">{p.bind_address || '—'}</td>
                  <td className="px-4 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${p.state === 'listen' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-700 text-slate-400'}`}>
                      {p.state || '—'}
                    </span>
                  </td>
                </tr>
              ))}
              {!ports.length && (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-500">No open port data</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {section === 'vulns' && (
        <div className="space-y-2">
          {vulns.length === 0 && <div className="py-10 text-center text-slate-500 text-sm">No CVEs detected</div>}
          {vulns.map((v, i) => (
            <div key={i} className="bg-slate-900 border border-slate-700 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <SeverityBadge sev={v.severity} />
                    {v.cve_id && (
                      <span className="text-xs font-mono text-blue-400">{v.cve_id}</span>
                    )}
                    {v.cvss_score != null && (
                      <span className="text-xs text-slate-500">CVSS: {v.cvss_score}</span>
                    )}
                  </div>
                  <div className="text-sm font-medium text-white">{v.software_name} {v.software_version && `(${v.software_version})`}</div>
                  {v.description && <div className="text-xs text-slate-400 mt-1 line-clamp-2">{v.description}</div>}
                </div>
                {v.status === 'remediated' && (
                  <CheckCircle2 size={14} className="text-emerald-400 shrink-0 mt-1" />
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {section === 'highrisk' && (
        <div className="space-y-2">
          {highRisk.length === 0 && <div className="py-10 text-center text-slate-500 text-sm">No high-risk software detected</div>}
          {highRisk.map((h, i) => (
            <div key={i} className="bg-slate-900 border border-slate-700 rounded-xl p-4 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <SeverityBadge sev={h.severity || 'high'} />
                  <span className="text-xs text-slate-500 capitalize">{h.match_type}</span>
                </div>
                <div className="text-sm font-medium text-white">{h.software_name}</div>
                {h.software_version && <div className="text-xs text-slate-400 mt-0.5">v{h.software_version}</div>}
                {h.reason && <div className="text-xs text-slate-500 mt-1">{h.reason}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Network tab ──────────────────────────────────────────────────────────────

function NetworkTab({ agentId }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    api.get(`/agents/${agentId}/network`)
      .then(r => setData(r.data))
      .catch(() => setData({ nics: [], dns_servers: [], default_gateway: null }))
      .finally(() => setLoading(false))
  }, [agentId])

  useEffect(() => { load() }, [load])

  const requestRefresh = async () => {
    setRefreshing(true)
    try {
      await api.post('/agents/maintenance/sync-all', { agent_ids: [agentId] })
        .catch(() => api.post(`/agents/${agentId}/trigger-update`))
      setRefreshMsg('Inventory refresh queued — data will update on next agent check-in')
    } catch {
      setRefreshMsg('Could not queue refresh')
    }
    setRefreshing(false)
    setTimeout(() => setRefreshMsg(null), 5000)
  }

  if (loading) return <div className="py-12 text-center text-slate-500">Loading…</div>

  const nics = data?.nics || []
  const dns = data?.dns_servers || []
  const gateway = data?.default_gateway

  return (
    <div className="space-y-6">
      {/* Header actions */}
      <div className="flex items-center gap-3">
        {refreshMsg && (
          <span className="text-xs text-blue-400">{refreshMsg}</span>
        )}
        <button onClick={requestRefresh} disabled={refreshing}
          className="ml-auto flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-400 hover:border-slate-600 transition-colors">
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          Refresh from Agent
        </button>
      </div>

      {(!dns.length && !gateway) && (
        <div className="text-xs text-slate-500 bg-slate-800/50 border border-slate-700 rounded-lg px-4 py-3">
          DNS servers and default gateway will appear after the agent checks in with the updated binary. Use "Refresh from Agent" to request a fresh inventory.
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-slate-900 border border-slate-700 rounded-xl p-4">
          <div className="text-xs text-slate-400 mb-1">Interfaces</div>
          <div className="text-2xl font-bold text-white">{nics.length}</div>
          <div className="text-xs text-slate-500 mt-1">
            {nics.filter(n => n.is_up !== false).length} up · {nics.filter(n => n.is_up === false).length} down
          </div>
        </div>
        <div className="bg-slate-900 border border-slate-700 rounded-xl p-4">
          <div className="text-xs text-slate-400 mb-1">Default Gateway</div>
          <div className="text-sm font-bold text-white font-mono mt-1">{gateway || '—'}</div>
        </div>
        <div className="bg-slate-900 border border-slate-700 rounded-xl p-4">
          <div className="text-xs text-slate-400 mb-1">DNS Servers</div>
          <div className="space-y-0.5 mt-1">
            {dns.length > 0 ? dns.map((d, i) => (
              <div key={i} className="text-xs font-mono text-white">{d}</div>
            )) : <div className="text-sm text-slate-500">—</div>}
          </div>
        </div>
      </div>

      {/* Interfaces table */}
      <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-700 bg-slate-800/50 flex items-center gap-2">
          <Network size={14} className="text-blue-400" />
          <span className="text-sm font-medium text-white">Network Interfaces</span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400 border-b border-slate-700">
              <th className="px-5 py-3 font-medium">Interface</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">MAC Address</th>
              <th className="px-5 py-3 font-medium">IP Addresses</th>
              <th className="px-5 py-3 font-medium">MTU</th>
              <th className="px-5 py-3 font-medium">Flags</th>
            </tr>
          </thead>
          <tbody>
            {nics.map((nic, i) => {
              const isUp = nic.is_up !== false  // default true if not present
              const ips = nic.ips || []
              const ipv4 = ips.filter(ip => !ip.includes(':'))
              const ipv6 = ips.filter(ip => ip.includes(':'))
              return (
                <tr key={i} className="border-b border-slate-800 hover:bg-slate-800/30">
                  <td className="px-5 py-3">
                    <div className="font-medium text-white text-sm">{nic.name}</div>
                  </td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full font-medium ${
                      isUp ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-700 text-slate-400'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${isUp ? 'bg-emerald-400' : 'bg-slate-500'}`} />
                      {isUp ? 'Up' : 'Down'}
                    </span>
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-slate-400">{nic.mac || '—'}</td>
                  <td className="px-5 py-3">
                    <div className="space-y-0.5">
                      {ipv4.map((ip, j) => (
                        <div key={j} className="font-mono text-xs text-white">{ip}</div>
                      ))}
                      {ipv6.map((ip, j) => (
                        <div key={j} className="font-mono text-xs text-slate-500">{ip}</div>
                      ))}
                      {ips.length === 0 && <span className="text-slate-600 text-xs">No address</span>}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-xs font-mono text-slate-400">{nic.mtu || '—'}</td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(nic.flags || []).map((f, j) => (
                        <span key={j} className="text-xs bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded border border-slate-700">{f}</span>
                      ))}
                      {!nic.flags?.length && <span className="text-slate-600 text-xs">—</span>}
                    </div>
                  </td>
                </tr>
              )
            })}
            {!nics.length && (
              <tr><td colSpan={6} className="px-5 py-10 text-center text-slate-500">
                No network data yet — will populate on next agent check-in
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}


// ── Queue tab ─────────────────────────────────────────────────────────────────

const CMD_META = {
  patch_scan:        { label: 'Patch Scan',          color: 'text-teal-400 bg-teal-500/10 border-teal-800/40' },
  apply_patches:     { label: 'Apply Patches',        color: 'text-blue-400 bg-blue-500/10 border-blue-800/40' },
  update_agent:      { label: 'Update Agent',         color: 'text-purple-400 bg-purple-500/10 border-purple-800/40' },
  restart_machine:   { label: 'Restart Machine',      color: 'text-red-400 bg-red-500/10 border-red-800/40' },
  collect_inventory: { label: 'Collect Inventory',    color: 'text-yellow-400 bg-yellow-500/10 border-yellow-800/40' },
  service_control:   { label: 'Service Control',      color: 'text-slate-300 bg-slate-700 border-slate-600' },
  software_uninstall:{ label: 'Uninstall Software',   color: 'text-orange-400 bg-orange-500/10 border-orange-800/40' },
  ad_sync:           { label: 'AD Sync',              color: 'text-indigo-400 bg-indigo-500/10 border-indigo-800/40' },
}

function QueueTab({ agentId }) {
  const [commands, setCommands] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAll, setShowAll] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    api.get(`/agents/${agentId}/queue`, { params: { include_picked: showAll } })
      .then(r => setCommands(r.data || []))
      .catch(() => setCommands([]))
      .finally(() => setLoading(false))
  }, [agentId, showAll])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex gap-2">
          <button onClick={() => setShowAll(false)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${!showAll ? 'bg-blue-900/40 border-blue-700 text-blue-300' : 'border-slate-700 text-slate-400 hover:border-slate-600'}`}>
            Pending Only
          </button>
          <button onClick={() => setShowAll(true)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${showAll ? 'bg-blue-900/40 border-blue-700 text-blue-300' : 'border-slate-700 text-slate-400 hover:border-slate-600'}`}>
            All (last 100)
          </button>
        </div>
        <button onClick={load} className="ml-auto text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-400 hover:border-slate-600 flex items-center gap-1.5">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {loading ? (
        <div className="py-12 text-center text-slate-500">Loading…</div>
      ) : (
        <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-700 bg-slate-800/50">
                <th className="px-5 py-3 font-medium">Command</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Payload</th>
                <th className="px-5 py-3 font-medium">Queued At</th>
                <th className="px-5 py-3 font-medium">Picked Up</th>
              </tr>
            </thead>
            <tbody>
              {commands.map((cmd, i) => {
                const meta = CMD_META[cmd.command_type] || { label: cmd.command_type, color: 'text-slate-400 bg-slate-700 border-slate-600' }
                const isPending = cmd.status === 'pending'
                // Summarise payload
                const payload = cmd.payload || {}
                const payloadSummary = Object.keys(payload).length > 0
                  ? Object.entries(payload)
                      .filter(([k]) => !['password', 'token', 'secret'].includes(k))
                      .slice(0, 3)
                      .map(([k, v]) => `${k}: ${String(v).slice(0, 30)}`)
                      .join(' · ')
                  : '—'
                return (
                  <tr key={i} className={`border-b border-slate-800 hover:bg-slate-800/30 ${isPending ? 'bg-blue-950/10' : ''}`}>
                    <td className="px-5 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${meta.color}`}>
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      {isPending ? (
                        <span className="flex items-center gap-1.5 text-xs text-yellow-400">
                          <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" /> Pending
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-xs text-slate-500">
                          <CheckCircle2 size={12} /> Delivered
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-400 max-w-xs truncate font-mono">{payloadSummary}</td>
                    <td className="px-5 py-3 text-xs text-slate-400">
                      {cmd.created_at ? new Date(cmd.created_at).toLocaleString() : '—'}
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-400">
                      {cmd.picked_up_at ? new Date(cmd.picked_up_at).toLocaleString() : '—'}
                    </td>
                  </tr>
                )
              })}
              {!commands.length && (
                <tr><td colSpan={5} className="px-5 py-10 text-center text-slate-500">
                  {showAll ? 'No commands in the last 100 entries' : 'No pending commands'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}


// ── SIEM tab ──────────────────────────────────────────────────────────────────

function SiemTab({ agentId }) {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [levelFilter, setLevelFilter] = useState('')
  const [total, setTotal] = useState(0)

  useEffect(() => {
    setLoading(true)
    const params = { agent_id: agentId, limit: 200 }
    if (levelFilter) params.level = levelFilter
    siemApi.events(params)
      .then(r => {
        setEvents(r.data.events || [])
        setTotal(r.data.total || 0)
      })
      .finally(() => setLoading(false))
  }, [agentId, levelFilter])

  const levels = ['', 'critical', 'error', 'warning', 'info', 'debug']
  const levelCounts = {}
  events.forEach(e => { levelCounts[e.level] = (levelCounts[e.level] || 0) + 1 })

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs text-slate-400">Filter:</span>
        {levels.map(l => (
          <button key={l || 'all'} onClick={() => setLevelFilter(l)}
            className={`text-xs px-3 py-1 rounded-full border transition-colors capitalize ${
              levelFilter === l ? 'bg-blue-900/40 border-blue-700 text-blue-300' : 'border-slate-700 text-slate-400 hover:border-slate-600'
            }`}>
            {l || 'All'} {l && levelCounts[l] ? `(${levelCounts[l]})` : ''}
          </button>
        ))}
        <span className="ml-auto text-xs text-slate-500">{total} total events</span>
      </div>

      {loading ? (
        <div className="py-12 text-center text-slate-500">Loading…</div>
      ) : (
        <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-700 bg-slate-800/50">
                <th className="px-4 py-3 font-medium">Time</th>
                <th className="px-4 py-3 font-medium">Level</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Event ID</th>
                <th className="px-4 py-3 font-medium">Message</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev, i) => (
                <tr key={i} className="border-b border-slate-800 hover:bg-slate-800/30">
                  <td className="px-4 py-2 text-xs text-slate-500 whitespace-nowrap">
                    {ev.time ? new Date(ev.time).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2"><LevelBadge level={ev.level} /></td>
                  <td className="px-4 py-2 text-xs text-slate-400">{ev.log_source}</td>
                  <td className="px-4 py-2 text-xs font-mono text-slate-500">{ev.event_id || '—'}</td>
                  <td className="px-4 py-2 text-xs text-slate-300 max-w-sm truncate" title={ev.message}>{ev.message}</td>
                </tr>
              ))}
              {!events.length && (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-500">No SIEM events in this window</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Metrics tab ───────────────────────────────────────────────────────────────

function MetricsTab({ agentId }) {
  const [cpu, setCpu] = useState([])
  const [mem, setMem] = useState([])
  const [loading, setLoading] = useState(true)
  const [hours, setHours] = useState(24)

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      agentsApi.metrics(agentId, 'cpu_percent', hours),
      agentsApi.metrics(agentId, 'memory_percent', hours),
    ]).then(([c, m]) => {
      setCpu(c.data.data || [])
      setMem(m.data.data || [])
    }).finally(() => setLoading(false))
  }, [agentId, hours])

  useEffect(() => { load() }, [load])

  const avg = arr => arr.length ? (arr.reduce((s, d) => s + d.value, 0) / arr.length).toFixed(1) : '—'
  const peak = arr => arr.length ? Math.max(...arr.map(d => d.value)).toFixed(1) : '—'

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        {[1, 6, 24, 48].map(h => (
          <button key={h} onClick={() => setHours(h)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
              hours === h ? 'bg-blue-900/40 border-blue-700 text-blue-300' : 'border-slate-700 text-slate-400 hover:border-slate-600'
            }`}>
            {h}h
          </button>
        ))}
        <button onClick={load} className="ml-auto text-xs px-3 py-1.5 rounded-lg border border-slate-700 text-slate-400 hover:border-slate-600">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {loading ? (
        <div className="py-12 text-center text-slate-500">Loading metrics…</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* CPU */}
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Cpu size={15} className="text-blue-400" /> CPU Usage
              </h3>
              <div className="text-right">
                <div className="text-xs text-slate-500">Avg <span className="text-white font-medium">{avg(cpu)}%</span></div>
                <div className="text-xs text-slate-500">Peak <span className="text-yellow-400 font-medium">{peak(cpu)}%</span></div>
              </div>
            </div>
            <Sparkline data={cpu} color="#3b82f6" height={60} />
            {!cpu.length && <div className="text-xs text-slate-600 text-center py-4">No CPU metrics collected yet</div>}
          </div>

          {/* Memory */}
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <MemoryStick size={15} className="text-purple-400" /> Memory Usage
              </h3>
              <div className="text-right">
                <div className="text-xs text-slate-500">Avg <span className="text-white font-medium">{avg(mem)}%</span></div>
                <div className="text-xs text-slate-500">Peak <span className="text-yellow-400 font-medium">{peak(mem)}%</span></div>
              </div>
            </div>
            <Sparkline data={mem} color="#a855f7" height={60} />
            {!mem.length && <div className="text-xs text-slate-600 text-center py-4">No memory metrics collected yet</div>}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AgentDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [agent, setAgent] = useState(null)
  const [services, setServices] = useState([])
  const [software, setSoftware] = useState([])
  const [tab, setTab] = useState('overview')
  const [loading, setLoading] = useState(true)
  const [swSearch, setSwSearch] = useState('')
  const [svcSearch, setSvcSearch] = useState('')
  const [svcAction, setSvcAction] = useState({})
  const [uninstallState, setUninstallState] = useState({})
  const [confirmUninstall, setConfirmUninstall] = useState(null)
  const [diskExcludes, setDiskExcludes] = useState({})
  const [diskExcludeToggling, setDiskExcludeToggling] = useState({})
  const [updateState, setUpdateState] = useState(null)
  const [showRemote, setShowRemote] = useState(false)
  const [overviewCounts, setOverviewCounts] = useState({ patches: 0, threats: 0, siem: 0 })

  const reloadServices = useCallback(() => {
    agentsApi.services(id).then(r => setServices(r.data))
  }, [id])

  async function handleDiskExclude(mountpoint, currentExcluded) {
    setDiskExcludeToggling(prev => ({ ...prev, [mountpoint]: true }))
    try {
      await storageApi.setExclude(id, mountpoint, !currentExcluded)
      setDiskExcludes(prev => ({ ...prev, [mountpoint]: !currentExcluded }))
    } catch {}
    setDiskExcludeToggling(prev => ({ ...prev, [mountpoint]: false }))
  }

  useEffect(() => {
    Promise.all([
      agentsApi.get(id),
      agentsApi.services(id),
      storageApi.getExcludes(id),
    ]).then(([agentRes, svcRes, excRes]) => {
      setAgent(agentRes.data)
      setServices(svcRes.data)
      setDiskExcludes(excRes.data || {})
    }).finally(() => setLoading(false))

    // Load overview badge counts in background
    Promise.allSettled([
      api.get(`/patches/agents/${id}/updates`),
      api.get(`/threats/misconfigs/${id}`),
      siemApi.events({ agent_id: id, limit: 1 }),
    ]).then(([p, t, s]) => {
      setOverviewCounts({
        patches: p.status === 'fulfilled' ? (p.value.data?.length || 0) : 0,
        threats: t.status === 'fulfilled' ? (t.value.data?.length || 0) : 0,
        siem:    s.status === 'fulfilled' ? (s.value.data?.total || 0) : 0,
      })
    })
  }, [id])

  useEffect(() => {
    if (tab === 'software' && software.length === 0) {
      agentsApi.software(id).then(r => setSoftware(r.data))
    }
  }, [tab, id])

  const doServiceAction = async (svcName, action) => {
    setSvcAction(prev => ({ ...prev, [svcName]: 'loading' }))
    try {
      await api.post(`/agents/${id}/service-control`, { service_name: svcName, action })
      const optimisticStatus = action === 'start' || action === 'restart' ? 'running' : 'stopped'
      setServices(prev => prev.map(s => s.service_name === svcName ? { ...s, status: optimisticStatus } : s))
      setSvcAction(prev => ({ ...prev, [svcName]: 'done' }))
      setTimeout(() => {
        reloadServices()
        setSvcAction(prev => { const n = { ...prev }; delete n[svcName]; return n })
      }, 7000)
    } catch {
      setSvcAction(prev => ({ ...prev, [svcName]: 'error' }))
      setTimeout(() => setSvcAction(prev => { const n = { ...prev }; delete n[svcName]; return n }), 3000)
    }
  }

  const doUninstall = async (name, version) => {
    setConfirmUninstall(null)
    setUninstallState(prev => ({ ...prev, [name]: 'loading' }))
    try {
      await api.post(`/agents/${id}/software-uninstall`, { name, version })
      setUninstallState(prev => ({ ...prev, [name]: 'done' }))
      setTimeout(() => {
        agentsApi.software(id).then(r => setSoftware(r.data))
        setUninstallState(prev => { const n = { ...prev }; delete n[name]; return n })
      }, 8000)
    } catch {
      setUninstallState(prev => ({ ...prev, [name]: 'error' }))
      setTimeout(() => setUninstallState(prev => { const n = { ...prev }; delete n[name]; return n }), 3000)
    }
  }

  const triggerUpdate = async () => {
    setUpdateState('loading')
    try {
      await api.post(`/agents/${id}/trigger-update`)
      setUpdateState('queued')
      setTimeout(() => setUpdateState(null), 5000)
    } catch {
      setUpdateState('error')
      setTimeout(() => setUpdateState(null), 3000)
    }
  }

  const toggleExcludeFromReports = async () => {
    const newVal = !agent.exclude_from_reports
    try {
      await api.patch(`/agents/${id}`, { exclude_from_reports: newVal })
      setAgent(prev => ({ ...prev, exclude_from_reports: newVal }))
    } catch {}
  }

  if (loading) return (
    <div className="flex justify-center py-16">
      <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
    </div>
  )
  if (!agent) return <div className="text-red-400">Agent not found</div>

  const filteredSW = software.filter(s => !swSearch || s.name.toLowerCase().includes(swSearch.toLowerCase()))
  const filteredSvc = services.filter(s => !svcSearch ||
    s.service_name.toLowerCase().includes(svcSearch.toLowerCase()) ||
    (s.display_name || '').toLowerCase().includes(svcSearch.toLowerCase())
  )

  const isOnline = agent.status === 'online'
  const lastSeenAgo = agent.last_seen
    ? (() => {
        const diff = Date.now() - new Date(agent.last_seen).getTime()
        if (diff < 60000) return 'just now'
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
        return `${Math.floor(diff / 86400000)}d ago`
      })()
    : 'never'

  return (
    <div>
      {/* ── Header ── */}
      <div className="flex items-start gap-4 mb-6">
        <Link to="/agents" className="text-slate-400 hover:text-white mt-1">
          <ArrowLeft size={20} />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-bold text-white">{agent.display_name || agent.hostname}</h1>
            {agent.display_name && agent.display_name !== agent.hostname && (
              <span className="text-sm text-slate-500 font-mono">{agent.hostname}</span>
            )}
            <StatusBadge status={agent.status} />
            {agent.agent_version && (
              <span className="text-xs text-slate-500 font-mono bg-slate-800 px-2 py-0.5 rounded border border-slate-700">
                v{agent.agent_version}
              </span>
            )}
            {agent.asset_type && (
              <span className="text-xs text-slate-400 bg-slate-800 px-2 py-0.5 rounded border border-slate-700 capitalize">
                {agent.asset_type}
              </span>
            )}
            {agent.group_name && (
              <span className="text-xs px-2 py-0.5 rounded border font-medium"
                style={{ color: agent.group_color || '#94a3b8', borderColor: `${agent.group_color}40` || '#334155', background: `${agent.group_color}15` || 'transparent' }}>
                {agent.group_name}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <span className="text-sm text-slate-400">{agent.ip_address}</span>
            <span className="text-slate-600">·</span>
            <span className="text-sm text-slate-400">{friendlyOS(agent.os_name, agent.os_version)}</span>
            {agent.os_arch && <span className="text-xs text-slate-500">({agent.os_arch})</span>}
            <span className="text-slate-600">·</span>
            <span className="text-xs text-slate-500 flex items-center gap-1">
              <Clock size={11} /> Last seen {lastSeenAgo}
            </span>
          </div>
          {agent.tags?.length > 0 && (
            <div className="flex gap-1.5 mt-1.5 flex-wrap">
              {agent.tags.map(t => (
                <span key={t} className="text-xs bg-slate-800 text-slate-400 px-2 py-0.5 rounded border border-slate-700">{t}</span>
              ))}
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
          {agent.os_name?.toLowerCase().includes('windows') ? (
            <>
              <button onClick={() => navigate(`/terminal/${id}`)}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300">
                <Terminal size={12} /> Terminal
              </button>
              <button onClick={() => navigate(`/rdp/${id}`)}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300">
                <Monitor size={12} /> RDP
              </button>
              <button onClick={() => setShowRemote(true)}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-blue-900/40 hover:bg-blue-800/50 border border-blue-700/50 text-blue-300">
                <MonitorSmartphone size={12} /> Remote
              </button>
            </>
          ) : (
            <button onClick={() => navigate(`/terminal/${id}`)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300">
              <Terminal size={12} /> Terminal
            </button>
          )}
          <button onClick={triggerUpdate} disabled={updateState === 'loading' || updateState === 'queued'}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
              updateState === 'queued' ? 'bg-green-900/40 border-green-700 text-green-400' :
              updateState === 'error'  ? 'bg-red-900/40 border-red-700 text-red-400' :
              'bg-slate-700 hover:bg-slate-600 border-slate-600 text-slate-300'
            }`}>
            <RefreshCw size={12} className={updateState === 'loading' ? 'animate-spin' : ''} />
            {updateState === 'queued' ? 'Queued' : updateState === 'error' ? 'Failed' : 'Update Agent'}
          </button>
        </div>
      </div>

      {/* ── Overview stat cards ── */}
      {tab === 'overview' && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <StatCard icon={Package} label="Pending Updates" value={overviewCounts.patches}
            color={overviewCounts.patches > 0 ? 'yellow' : 'green'}
            onClick={() => setTab('patches')} />
          <StatCard icon={Shield} label="Misconfigs" value={overviewCounts.threats}
            color={overviewCounts.threats > 0 ? 'red' : 'green'}
            onClick={() => setTab('security')} />
          <StatCard icon={Radio} label="SIEM Events (24h)" value={overviewCounts.siem}
            color={overviewCounts.siem > 0 ? 'purple' : 'slate'}
            onClick={() => setTab('siem')} />
          <StatCard icon={Activity} label="Status" value={isOnline ? 'Online' : 'Offline'}
            sub={`Last seen ${lastSeenAgo}`}
            color={isOnline ? 'green' : 'slate'} />
        </div>
      )}

      {/* ── Tabs ── */}
      <div className="flex gap-0 border-b border-slate-700 mb-6 overflow-x-auto">
        <Tab active={tab === 'overview'} onClick={() => setTab('overview')}>
          <Info size={13} /> Overview
        </Tab>
        <Tab active={tab === 'patches'} onClick={() => setTab('patches')} badge={overviewCounts.patches}>
          <Package size={13} /> Patches
        </Tab>
        <Tab active={tab === 'security'} onClick={() => setTab('security')} badge={overviewCounts.threats}>
          <Shield size={13} /> Security
        </Tab>
        <Tab active={tab === 'siem'} onClick={() => setTab('siem')}>
          <Radio size={13} /> SIEM
        </Tab>
        <Tab active={tab === 'network'} onClick={() => setTab('network')}>
          <Network size={13} /> Network
        </Tab>
        <Tab active={tab === 'metrics'} onClick={() => setTab('metrics')}>
          <BarChart2 size={13} /> Metrics
        </Tab>
        <Tab active={tab === 'services'} onClick={() => setTab('services')}>
          <Server size={13} /> Services ({services.length})
        </Tab>
        <Tab active={tab === 'software'} onClick={() => setTab('software')}>
          <Layers size={13} /> Software
        </Tab>
        <Tab active={tab === 'queue'} onClick={() => setTab('queue')}>
          <Zap size={13} /> Queue
        </Tab>
        <Tab active={tab === 'history'} onClick={() => setTab('history')}>
          <History size={13} /> History
        </Tab>
      </div>

      {/* ── Overview ── */}
      {tab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* System Info */}
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
              <Settings2 size={16} className="text-blue-400" /> System Information
            </h3>
            <InfoRow label="Hostname" value={agent.hostname} mono />
            {agent.display_name && agent.display_name !== agent.hostname && (
              <InfoRow label="Display Name" value={agent.display_name} />
            )}
            {agent.description && (
              <InfoRow label="Description" value={agent.description} />
            )}
            <InfoRow label="IP Address" value={agent.ip_address} mono />
            <InfoRow label="OS" value={friendlyOS(agent.os_name, agent.os_version)} />
            <InfoRow label="OS Version" value={agent.os_version} />
            <InfoRow label="Architecture" value={agent.os_arch} />
            <InfoRow label="Asset Type" value={agent.asset_type} />
            <InfoRow label="Group" value={agent.group_name} />
            <InfoRow label="Agent Version" value={agent.agent_version ? `v${agent.agent_version}` : null} mono />
            <InfoRow label="Agent Type" value={agent.agent_type} />
            <InfoRow label="Registered" value={agent.registered_at ? new Date(agent.registered_at).toLocaleString() : null} />
            <InfoRow label="Last Seen" value={agent.last_seen ? new Date(agent.last_seen).toLocaleString() : 'Never'} />
            <div className="flex justify-between items-center py-2">
              <span className="text-sm text-slate-400">Exclude from Reports</span>
              <button onClick={toggleExcludeFromReports}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${agent.exclude_from_reports ? 'bg-yellow-500' : 'bg-slate-600'}`}>
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${agent.exclude_from_reports ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
              </button>
            </div>
          </div>

          {/* Hardware */}
          {agent.hardware && (
            <div className="bg-slate-900 border border-slate-700 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
                <Cpu size={16} className="text-blue-400" /> Hardware
              </h3>
              <InfoRow label="CPU" value={agent.hardware.cpu_model} />
              <InfoRow label="CPU Cores / Threads" value={
                [agent.hardware.cpu_cores, agent.hardware.cpu_threads].filter(Boolean).join(' / ') || null
              } />
              <InfoRow label="RAM" value={agent.hardware.ram_total_gb ? `${Number(agent.hardware.ram_total_gb).toFixed(1)} GB` : null} />
              {agent.hardware.gpu?.length > 0 && agent.hardware.gpu.map((g, i) => (
                <InfoRow key={i} label={`GPU ${i > 0 ? i + 1 : ''}`} value={g.model || g.name || String(g)} />
              ))}
              <InfoRow label="Serial Number" value={agent.hardware.serial_number} mono />
              <InfoRow label="Asset Tag" value={agent.hardware.asset_tag} mono />
              <InfoRow label="BIOS Vendor" value={agent.hardware.bios_vendor} />
              <InfoRow label="BIOS Version" value={agent.hardware.bios_version} mono />
              <InfoRow label="Motherboard" value={agent.hardware.motherboard_model} />
            </div>
          )}

          {/* Disk Storage */}
          {agent.hardware?.disks?.length > 0 && (
            <div className="bg-slate-900 border border-slate-700 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
                <HardDrive size={16} className="text-blue-400" /> Disk Storage
              </h3>
              <div className="space-y-4">
                {agent.hardware.disks.map((disk, i) => {
                  const total = disk.size_gb || 1
                  const free = disk.free_gb ?? 0
                  const used = total - free
                  const pct = Math.round((used / total) * 100)
                  const isCritical = pct >= 90
                  const isWarning = pct >= 75
                  const barColor = isCritical ? 'bg-red-500' : isWarning ? 'bg-yellow-500' : 'bg-blue-500'
                  const mount = disk.name || disk.mountpoint || '/'
                  const isExcluded = !!diskExcludes[mount]
                  const isToggling = !!diskExcludeToggling[mount]
                  return (
                    <div key={i} className={`rounded-lg p-3 border ${isExcluded ? 'border-slate-700 bg-slate-800/30 opacity-60' : isCritical ? 'border-red-800 bg-red-900/20' : 'border-slate-700 bg-slate-800/50'}`}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium text-white flex items-center gap-1.5">
                          {isCritical && !isExcluded && <AlertTriangle size={13} className="text-red-400" />}
                          {isExcluded && <EyeOff size={13} className="text-slate-500" />}
                          {disk.name}
                          {disk.filesystem && <span className="text-xs text-slate-500 font-normal">({disk.filesystem})</span>}
                        </span>
                        <span className={`text-xs font-bold ${isCritical && !isExcluded ? 'text-red-400' : isWarning && !isExcluded ? 'text-yellow-400' : 'text-slate-300'}`}>
                          {pct}% used
                        </span>
                      </div>
                      <div className="w-full bg-slate-700 rounded-full h-1.5 mb-2">
                        <div className={`h-1.5 rounded-full transition-all ${isExcluded ? 'bg-slate-600' : barColor}`} style={{ width: `${pct}%` }} />
                      </div>
                      <div className="flex justify-between items-center text-xs text-slate-400">
                        <span>{free.toFixed(1)} GB free · {total.toFixed(1)} GB total</span>
                        <label className="flex items-center gap-1.5 cursor-pointer select-none text-slate-500 hover:text-slate-300 transition-colors">
                          {isToggling
                            ? <Loader2 size={11} className="animate-spin" />
                            : <input type="checkbox" checked={isExcluded} onChange={() => handleDiskExclude(mount, isExcluded)}
                                className="w-3 h-3 accent-amber-500 cursor-pointer" />
                          }
                          <EyeOff size={10} /> Exclude
                        </label>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Bottom stat cards */}
          <div className={`grid grid-cols-2 gap-4 ${agent.hardware ? '' : 'lg:col-span-2'}`}>
            <div className="bg-slate-900 border border-slate-700 rounded-xl p-4 cursor-pointer hover:border-slate-600 transition-colors"
              onClick={() => setTab('software')}>
              <div className="flex items-center gap-2 mb-1">
                <Layers size={14} className="text-slate-400" />
                <span className="text-xs text-slate-400">Software Packages</span>
                <ChevronRight size={12} className="text-slate-600 ml-auto" />
              </div>
              <div className="text-2xl font-bold text-white">{agent.software_count}</div>
            </div>
            <div className="bg-slate-900 border border-slate-700 rounded-xl p-4 cursor-pointer hover:border-slate-600 transition-colors"
              onClick={() => setTab('services')}>
              <div className="flex items-center gap-2 mb-1">
                <Server size={14} className="text-slate-400" />
                <span className="text-xs text-slate-400">Services</span>
                <ChevronRight size={12} className="text-slate-600 ml-auto" />
              </div>
              <div className="text-2xl font-bold text-white">{agent.service_count}</div>
            </div>
          </div>
        </div>
      )}

      {/* ── Patches ── */}
      {tab === 'patches' && <PatchesTab agentId={id} />}

      {/* ── Security ── */}
      {tab === 'security' && <SecurityTab agentId={id} />}

      {/* ── SIEM ── */}
      {tab === 'siem' && <SiemTab agentId={id} />}

      {/* ── Network ── */}
      {tab === 'network' && <NetworkTab agentId={id} />}

      {/* ── Metrics ── */}
      {tab === 'metrics' && <MetricsTab agentId={id} />}

      {/* ── Services ── */}
      {tab === 'services' && (
        <div>
          <div className="mb-4">
            <input type="text" placeholder="Search services…" value={svcSearch}
              onChange={e => setSvcSearch(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-sm text-white w-64 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-slate-700 bg-slate-800/50">
                  <th className="px-5 py-3 font-medium">Service Name</th>
                  <th className="px-5 py-3 font-medium">Display Name</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Startup</th>
                  <th className="px-5 py-3 font-medium">PID</th>
                  <th className="px-5 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredSvc.map(svc => {
                  const st = svcAction[svc.service_name]
                  const isRunning = svc.status === 'running'
                  return (
                    <tr key={svc.id} className="border-b border-slate-800 hover:bg-slate-800/40">
                      <td className="px-5 py-2.5 font-mono text-xs text-slate-300">{svc.service_name}</td>
                      <td className="px-5 py-2.5 text-slate-300 text-sm">{svc.display_name || '—'}</td>
                      <td className="px-5 py-2.5"><StatusBadge status={svc.status} /></td>
                      <td className="px-5 py-2.5 text-slate-400 text-xs capitalize">{svc.startup_type || '—'}</td>
                      <td className="px-5 py-2.5 text-slate-400 font-mono text-xs">{svc.pid || '—'}</td>
                      <td className="px-5 py-2.5">
                        <div className="flex items-center gap-1">
                          {st === 'loading' ? (
                            <RefreshCw size={13} className="text-blue-400 animate-spin" />
                          ) : st === 'error' ? (
                            <span className="text-xs text-red-400">Error</span>
                          ) : (
                            <>
                              {!isRunning && (
                                <button onClick={() => doServiceAction(svc.service_name, 'start')} title="Start"
                                  className="p-1 rounded hover:bg-emerald-900/40 text-emerald-400"><Play size={13} /></button>
                              )}
                              {isRunning && (
                                <button onClick={() => doServiceAction(svc.service_name, 'stop')} title="Stop"
                                  className="p-1 rounded hover:bg-red-900/40 text-slate-400 hover:text-red-400"><Square size={13} /></button>
                              )}
                              <button onClick={() => doServiceAction(svc.service_name, 'restart')} title="Restart"
                                className="p-1 rounded hover:bg-yellow-900/40 text-slate-500 hover:text-yellow-400"><RotateCcw size={13} /></button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {filteredSvc.length === 0 && (
                  <tr><td colSpan={6} className="px-5 py-12 text-center text-slate-500">No services match</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Software ── */}
      {tab === 'software' && (
        <div>
          <div className="mb-4">
            <input type="text" placeholder="Search software…" value={swSearch}
              onChange={e => setSwSearch(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-sm text-white w-64 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-slate-700 bg-slate-800/50">
                  <th className="px-5 py-3 font-medium">Name</th>
                  <th className="px-5 py-3 font-medium">Version</th>
                  <th className="px-5 py-3 font-medium">Publisher</th>
                  <th className="px-5 py-3 font-medium">Install Date</th>
                  <th className="px-5 py-3 font-medium">Size</th>
                  <th className="px-5 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {filteredSW.map(sw => {
                  const st = uninstallState[sw.name]
                  return (
                    <tr key={sw.id} className="border-b border-slate-800 hover:bg-slate-800/40">
                      <td className="px-5 py-2 text-slate-200 text-sm">{sw.name}</td>
                      <td className="px-5 py-2 text-slate-400 text-xs font-mono">{sw.version || '—'}</td>
                      <td className="px-5 py-2 text-slate-400 text-xs">{sw.publisher || '—'}</td>
                      <td className="px-5 py-2 text-slate-400 text-xs">{sw.install_date || '—'}</td>
                      <td className="px-5 py-2 text-slate-400 text-xs">{sw.size_mb ? `${sw.size_mb.toFixed(0)} MB` : '—'}</td>
                      <td className="px-5 py-2 text-right">
                        {st === 'loading' ? (
                          <RefreshCw size={12} className="text-blue-400 animate-spin ml-auto" />
                        ) : st === 'done' ? (
                          <span className="text-xs text-emerald-400">Queued</span>
                        ) : st === 'error' ? (
                          <span className="text-xs text-red-400">Error</span>
                        ) : (
                          <button onClick={() => setConfirmUninstall({ name: sw.name, version: sw.version })}
                            title="Uninstall" className="text-slate-600 hover:text-red-400">
                            <Trash2 size={13} />
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
                {filteredSW.length === 0 && (
                  <tr><td colSpan={6} className="px-5 py-12 text-center text-slate-500">No software data yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Queue ── */}
      {tab === 'queue' && <QueueTab agentId={id} />}

      {/* ── History ── */}
      {tab === 'history' && (
        <div className="bg-slate-900 border border-slate-700 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-5 flex items-center gap-2">
            <History size={15} className="text-blue-400" /> Agent Event History
          </h3>
          <HistoryTab agentId={id} />
        </div>
      )}

      {/* ── Modals ── */}
      {confirmUninstall && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 w-full max-w-sm shadow-xl">
            <h2 className="text-white font-semibold text-lg mb-2">Uninstall Application</h2>
            <p className="text-slate-400 text-sm mb-4">
              Silently uninstall <strong className="text-white">{confirmUninstall.name}</strong>
              {confirmUninstall.version ? ` (${confirmUninstall.version})` : ''}?
            </p>
            <div className="flex gap-3">
              <button onClick={() => doUninstall(confirmUninstall.name, confirmUninstall.version)}
                className="flex-1 bg-red-600 hover:bg-red-500 text-white py-2 rounded-lg text-sm font-medium">
                Uninstall
              </button>
              <button onClick={() => setConfirmUninstall(null)}
                className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-300 py-2 rounded-lg text-sm">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showRemote && (
        <RemoteControl agentId={id} hostname={agent.hostname} onClose={() => setShowRemote(false)} />
      )}
    </div>
  )
}
