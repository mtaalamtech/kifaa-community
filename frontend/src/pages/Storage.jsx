import { useState, useEffect, useCallback, useRef } from 'react'
import {
  HardDrive, RefreshCw, AlertTriangle, CheckCircle2, XCircle,
  ChevronDown, ChevronRight, Loader2, Filter, EyeOff,
} from 'lucide-react'
import { storageApi, groupsApi } from '../api/client'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

// ── Helpers ───────────────────────────────────────────────────────────────────

function pctColor(pct) {
  if (pct == null) return 'text-slate-500'
  if (pct >= 90) return 'text-red-400'
  if (pct >= 80) return 'text-yellow-400'
  return 'text-green-400'
}

function pctBarColor(pct) {
  if (pct == null) return 'bg-slate-600'
  if (pct >= 90) return 'bg-red-500'
  if (pct >= 80) return 'bg-yellow-500'
  return 'bg-green-500'
}

function UsageBar({ pct }) {
  const w = Math.min(Math.max(pct ?? 0, 0), 100)
  return (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 bg-slate-700 rounded-full h-2 overflow-hidden">
        <div className={`h-2 rounded-full transition-all ${pctBarColor(pct)}`} style={{ width: `${w}%` }} />
      </div>
      <span className={`text-xs font-mono font-medium w-10 text-right ${pctColor(pct)}`}>
        {pct != null ? `${pct}%` : '—'}
      </span>
    </div>
  )
}

function StatusDot({ status }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${status === 'online' ? 'bg-green-400' : 'bg-slate-500'}`} />
  )
}

function formatGB(gb) {
  if (gb == null) return '—'
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`
  return `${gb.toFixed(1)} GB`
}

function staleness(last) {
  if (!last) return null
  const mins = (Date.now() - new Date(last)) / 60000
  if (mins > 15) return `${Math.round(mins)}m ago`
  return null
}

// ── Sparkline modal ───────────────────────────────────────────────────────────

function SparklineModal({ agentId, hostname, mountpoint, onClose }) {
  const [data, setData] = useState([])
  const [hours, setHours] = useState(24)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await storageApi.history(agentId, mountpoint, hours)
      setData(r.data.map(d => ({ ...d, time: new Date(d.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })))
    } catch {}
    setLoading(false)
  }, [agentId, mountpoint, hours])

  useEffect(() => { load() }, [load])

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
          <div>
            <div className="text-sm font-semibold text-white">{hostname} — {mountpoint}</div>
            <div className="text-xs text-slate-400 mt-0.5">Disk usage history</div>
          </div>
          <div className="flex items-center gap-3">
            <select value={hours} onChange={e => setHours(Number(e.target.value))}
              className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none">
              <option value={6}>6 hours</option>
              <option value={24}>24 hours</option>
              <option value={72}>3 days</option>
              <option value={168}>7 days</option>
            </select>
            <button onClick={onClose} className="text-slate-400 hover:text-white text-lg leading-none">&times;</button>
          </div>
        </div>
        <div className="p-5">
          {loading ? (
            <div className="h-48 flex items-center justify-center text-slate-500">
              <Loader2 size={20} className="animate-spin mr-2" /> Loading…
            </div>
          ) : data.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-slate-500 text-sm">
              No historical data available yet
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={data}>
                <XAxis dataKey="time" tick={{ fill: '#94a3b8', fontSize: 10 }} tickLine={false} />
                <YAxis domain={[0, 100]} tick={{ fill: '#94a3b8', fontSize: 10 }} tickLine={false} tickFormatter={v => `${v}%`} width={36} />
                <Tooltip
                  contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: '#94a3b8' }}
                  formatter={v => [`${v}%`, 'Usage']}
                />
                <Line type="monotone" dataKey="pct" stroke="#3b82f6" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Storage() {
  const [volumes, setVolumes] = useState([])
  const [summary, setSummary] = useState({ total_volumes: 0, critical: 0, warning: 0, healthy: 0 })
  const [groups, setGroups] = useState([])
  const [groupFilter, setGroupFilter] = useState('')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState('disk_percent')
  const [sortDir, setSortDir] = useState('desc')
  const [loading, setLoading] = useState(true)
  const [sparkline, setSparkline] = useState(null) // {agentId, hostname, mountpoint}
  const [togglingKey, setTogglingKey] = useState(null) // "agentId::mountpoint" while saving
  const pollRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const [ovRes, sumRes] = await Promise.all([
        storageApi.overview(groupFilter || null),
        storageApi.summary(),
      ])
      setVolumes(ovRes.data)
      setSummary(sumRes.data)
    } catch {}
    setLoading(false)
  }, [groupFilter])

  useEffect(() => {
    setLoading(true)
    load()
    groupsApi.list().then(r => setGroups(r.data || [])).catch(() => {})
    pollRef.current = setInterval(load, 60000)
    return () => clearInterval(pollRef.current)
  }, [load])

  function toggleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  async function handleExcludeToggle(e, agentId, mountpoint, currentExcluded) {
    e.stopPropagation()
    const key = `${agentId}::${mountpoint}`
    setTogglingKey(key)
    try {
      await storageApi.setExclude(agentId, mountpoint, !currentExcluded)
      setVolumes(prev => prev.map(v =>
        v.agent_id === agentId && (v.mountpoint || '/') === mountpoint
          ? { ...v, exclude_from_reports: !currentExcluded }
          : v
      ))
    } catch {}
    setTogglingKey(null)
  }

  const filtered = volumes
    .filter(v => {
      if (!search) return true
      const q = search.toLowerCase()
      return v.hostname.toLowerCase().includes(q) || (v.mountpoint || '').toLowerCase().includes(q)
    })
    .sort((a, b) => {
      let av = a[sortKey] ?? (sortDir === 'asc' ? Infinity : -Infinity)
      let bv = b[sortKey] ?? (sortDir === 'asc' ? Infinity : -Infinity)
      if (typeof av === 'string') av = av.toLowerCase()
      if (typeof bv === 'string') bv = bv.toLowerCase()
      return sortDir === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1)
    })

  function SortTh({ label, k, className = '' }) {
    const active = sortKey === k
    return (
      <th
        className={`px-4 py-3 text-left cursor-pointer select-none hover:text-white transition-colors ${active ? 'text-white' : 'text-slate-400'} ${className}`}
        onClick={() => toggleSort(k)}
      >
        <span className="flex items-center gap-1">
          {label}
          {active && <span className="text-blue-400">{sortDir === 'asc' ? '↑' : '↓'}</span>}
        </span>
      </th>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <HardDrive size={20} className="text-blue-400" /> Storage
        </h1>
        <p className="text-sm text-slate-400 mt-0.5">Disk space usage across all agents — auto-refreshes every minute</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Total Volumes', value: summary.total_volumes, icon: HardDrive,    color: 'text-slate-300' },
          { label: 'Critical (≥90%)', value: summary.critical,    icon: XCircle,       color: 'text-red-400'   },
          { label: 'Warning (≥80%)',  value: summary.warning,     icon: AlertTriangle, color: 'text-yellow-400'},
          { label: 'Healthy (<80%)',  value: summary.healthy,     icon: CheckCircle2,  color: 'text-green-400' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <div className={`text-2xl font-bold ${color}`}>{value}</div>
            <div className={`text-xs mt-1 flex items-center gap-1 ${color} opacity-70`}>
              <Icon size={11} /> {label}
            </div>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search host or mount…"
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white w-52 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <select value={groupFilter} onChange={e => setGroupFilter(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
          <option value="">All Groups</option>
          {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <div className="flex-1" />
        <button onClick={load} className="flex items-center gap-1.5 px-3 py-2 text-xs bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 rounded-lg">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {/* Table */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-700 text-xs uppercase bg-slate-800/60">
              <SortTh label="Agent"      k="hostname"     />
              <SortTh label="Group"      k="group_name"   />
              <SortTh label="Mount"      k="mountpoint"   />
              <SortTh label="Usage"      k="disk_percent" className="w-48" />
              <SortTh label="Used"       k="used_gb"      />
              <SortTh label="Free"       k="free_gb"      />
              <SortTh label="Total"      k="total_gb"     />
              <th className="px-4 py-3 text-left text-slate-400">Updated</th>
              <th className="px-4 py-3 text-center text-slate-400 whitespace-nowrap">
                <span className="flex items-center gap-1 justify-center">
                  <EyeOff size={11} /> Exclude from Reports
                </span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {loading ? (
              <tr><td colSpan={9} className="py-16 text-center text-slate-500">
                <Loader2 size={18} className="animate-spin inline mr-2" />Loading storage data…
              </td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={9} className="py-16 text-center text-slate-500">
                {volumes.length === 0
                  ? 'No disk data yet — agents send metrics every heartbeat (up to 30 min for tags to populate)'
                  : 'No volumes match the current filter'}
              </td></tr>
            ) : filtered.map((v, i) => {
              const stale = staleness(v.last_updated)
              const excluded = v.exclude_from_reports
              const toggleKey = `${v.agent_id}::${v.mountpoint || '/'}`
              const isSaving = togglingKey === toggleKey
              return (
                <tr key={`${v.agent_id}-${v.mountpoint}-${i}`}
                  className={`hover:bg-slate-700/30 cursor-pointer ${excluded ? 'opacity-50' : ''}`}
                  onClick={() => setSparkline({ agentId: v.agent_id, hostname: v.hostname, mountpoint: v.mountpoint || '/' })}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <StatusDot status={v.agent_status} />
                      <span className="font-medium text-white">{v.hostname}</span>
                      {excluded && (
                        <span className="text-xs bg-slate-700 text-slate-400 rounded px-1.5 py-0.5 flex items-center gap-1">
                          <EyeOff size={9} /> excluded
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    {v.group_name
                      ? <span className="flex items-center gap-1.5 text-xs text-slate-300">
                          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: v.group_color || '#64748b' }} />
                          {v.group_name}
                        </span>
                      : <span className="text-slate-600 text-xs">—</span>}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-300">{v.mountpoint || '/'}</td>
                  <td className="px-4 py-2.5 w-48"><UsageBar pct={v.disk_percent} /></td>
                  <td className="px-4 py-2.5 text-xs text-slate-300">{formatGB(v.used_gb)}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-300">{formatGB(v.free_gb)}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-400">{formatGB(v.total_gb)}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">
                    {stale
                      ? <span className="text-yellow-500">{stale}</span>
                      : v.last_updated ? new Date(v.last_updated).toLocaleTimeString() : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-center" onClick={e => e.stopPropagation()}>
                    {isSaving ? (
                      <Loader2 size={14} className="animate-spin inline text-slate-400" />
                    ) : (
                      <input
                        type="checkbox"
                        checked={excluded}
                        title={excluded ? 'Click to include in reports' : 'Click to exclude from reports'}
                        onChange={e => handleExcludeToggle(e, v.agent_id, v.mountpoint || '/', excluded)}
                        className="w-4 h-4 accent-amber-500 cursor-pointer"
                      />
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {sparkline && (
        <SparklineModal
          agentId={sparkline.agentId}
          hostname={sparkline.hostname}
          mountpoint={sparkline.mountpoint}
          onClose={() => setSparkline(null)}
        />
      )}
    </div>
  )
}
