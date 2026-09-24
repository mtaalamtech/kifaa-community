import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import api from '../api/client'
import {
  ShieldCheck, AlertTriangle, CheckCircle, XCircle,
  RefreshCw, RotateCcw, TrendingUp, Info, Search,
} from 'lucide-react'

const SEV_COLOR = {
  critical:     'text-red-400 bg-red-500/15 border-red-700/40',
  non_compliant:'text-orange-400 bg-orange-500/15 border-orange-700/40',
  compliant:    'text-emerald-400 bg-emerald-500/15 border-emerald-700/40',
  unscanned:    'text-slate-400 bg-slate-700/40 border-slate-600/40',
}
const SEV_LABEL = {
  critical: 'Critical',
  non_compliant: 'Non-Compliant',
  compliant: 'Compliant',
  unscanned: 'Not Scanned',
}

function GaugeArc({ pct, size = 140 }) {
  const r = 52
  const cx = size / 2
  const cy = size / 2 + 10
  const circumference = Math.PI * r          // half-circle
  const dashOffset = circumference * (1 - pct / 100)
  const color = pct >= 80 ? '#10b981' : pct >= 60 ? '#f59e0b' : '#ef4444'

  return (
    <svg width={size} height={size * 0.65} viewBox={`0 0 ${size} ${size * 0.65}`}>
      {/* Background arc */}
      <path
        d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
        fill="none" stroke="#1e293b" strokeWidth="12" strokeLinecap="round"
      />
      {/* Value arc */}
      <path
        d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
        fill="none"
        stroke={color}
        strokeWidth="12"
        strokeLinecap="round"
        strokeDasharray={`${circumference}`}
        strokeDashoffset={dashOffset}
        style={{ transition: 'stroke-dashoffset 0.8s ease, stroke 0.4s ease' }}
      />
      <text x={cx} y={cy - 4} textAnchor="middle" fill={color} fontSize="22" fontWeight="bold">
        {pct.toFixed(1)}%
      </text>
      <text x={cx} y={cy + 16} textAnchor="middle" fill="#94a3b8" fontSize="11">
        Compliance
      </text>
    </svg>
  )
}

function KPICard({ label, value, sub, color = 'text-white', icon: Icon }) {
  return (
    <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1">
        {Icon && <Icon size={14} className={color} />}
        <span className="text-xs text-slate-400">{label}</span>
      </div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  )
}

export default function PatchCompliance() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')   // all | critical | non_compliant | compliant | unscanned
  const [search, setSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState('')
  const [groups, setGroups] = useState([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = groupFilter ? `?group_id=${groupFilter}` : ''
      const [compRes, groupRes] = await Promise.all([
        api.get(`/patches/compliance${params}`),
        api.get('/groups'),
      ])
      setData(compRes.data)
      setGroups(groupRes.data || [])
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [groupFilter])

  useEffect(() => { load() }, [load])

  const agents = data?.agents || []
  const filtered = agents.filter(a => {
    if (filter !== 'all' && a.compliance_status !== filter) return false
    if (search && !a.hostname.toLowerCase().includes(search.toLowerCase()) &&
        !(a.ip_address || '').includes(search)) return false
    return true
  })

  const sev = data?.severity_summary || {}
  const kpiMet = data?.kpi_met
  const compPct = data?.compliance_pct ?? 0

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <ShieldCheck size={20} className="text-blue-400" />
            Patch Compliance
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">KPI target: ≥80% of scanned agents fully patched on security updates</p>
        </div>
        <div className="flex items-center gap-2">
          {groups.length > 0 && (
            <select value={groupFilter} onChange={e => setGroupFilter(e.target.value)}
              className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white">
              <option value="">All Groups</option>
              {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
          <button onClick={load} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 border border-slate-600 text-sm text-slate-300 disabled:opacity-50">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="text-center py-20 text-slate-500">Loading compliance data…</div>
      ) : (
        <>
          {/* KPI Summary row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {/* Gauge */}
            <div className={`col-span-2 md:col-span-1 flex flex-col items-center justify-center bg-slate-800/60 border rounded-xl p-4 ${kpiMet ? 'border-emerald-600/40' : 'border-red-600/40'}`}>
              <GaugeArc pct={compPct} />
              <div className={`mt-1 text-xs font-semibold px-2 py-0.5 rounded-full ${kpiMet ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                {kpiMet ? '✓ KPI Met (≥80%)' : '✗ Below KPI (80%)'}
              </div>
            </div>

            <KPICard label="Compliant Agents" value={data?.compliant ?? 0}
              sub="No pending security patches" color="text-emerald-400" icon={CheckCircle} />
            <KPICard label="Non-Compliant" value={data?.non_compliant ?? 0}
              sub="Has pending security patches" color="text-red-400" icon={XCircle} />
            <KPICard label="Not Yet Scanned" value={(data?.total_agents ?? 0) - (data?.scanned_agents ?? 0)}
              sub="No patch scan data" color="text-slate-400" icon={Info} />
          </div>

          {/* Severity breakdown */}
          <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-slate-300 mb-3">Pending Patches by Severity (All Agents)</h2>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {[
                { key: 'critical',  label: 'Critical',  color: 'text-red-400 bg-red-500/15 border-red-700/40' },
                { key: 'important', label: 'Important', color: 'text-orange-400 bg-orange-500/15 border-orange-700/40' },
                { key: 'moderate',  label: 'Moderate',  color: 'text-yellow-400 bg-yellow-500/15 border-yellow-700/40' },
                { key: 'low',       label: 'Low',       color: 'text-blue-400 bg-blue-500/15 border-blue-700/40' },
                { key: 'upgrade',   label: 'Upgrades',  color: 'text-slate-400 bg-slate-700/40 border-slate-600/40' },
              ].map(({ key, label, color }) => (
                <div key={key} className={`border rounded-lg px-3 py-2 text-center ${color}`}>
                  <div className="text-xl font-bold">{sev[key] ?? 0}</div>
                  <div className="text-xs mt-0.5">{label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Per-agent table */}
          <div className="bg-slate-800/60 border border-slate-700 rounded-xl overflow-hidden">
            {/* Toolbar */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-700">
              <div className="relative flex-1 max-w-xs">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search hostname…"
                  className="bg-slate-700 border border-slate-600 rounded-lg pl-8 pr-3 py-1.5 text-sm text-white w-full" />
              </div>
              <div className="flex gap-1.5">
                {['all', 'critical', 'non_compliant', 'compliant', 'unscanned'].map(f => (
                  <button key={f} onClick={() => setFilter(f)}
                    className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                      filter === f
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-700 text-slate-400 hover:text-white'
                    }`}>
                    {f === 'all' ? 'All' : SEV_LABEL[f]}
                  </button>
                ))}
              </div>
              <span className="text-xs text-slate-500 ml-auto">{filtered.length} agents</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-xs text-slate-400">
                    <th className="px-4 py-2 text-left font-medium">Agent</th>
                    <th className="px-4 py-2 text-left font-medium">OS</th>
                    <th className="px-4 py-2 text-center font-medium">Status</th>
                    <th className="px-4 py-2 text-center font-medium text-red-400">Critical</th>
                    <th className="px-4 py-2 text-center font-medium text-orange-400">Moderate</th>
                    <th className="px-4 py-2 text-center font-medium text-slate-400">Upgrades</th>
                    <th className="px-4 py-2 text-center font-medium">Compliance</th>
                    <th className="px-4 py-2 text-center font-medium">Restart</th>
                    <th className="px-4 py-2 text-left font-medium">Last Scan</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr><td colSpan={9} className="px-4 py-12 text-center text-slate-500">No agents match the current filter.</td></tr>
                  )}
                  {filtered.map(a => (
                    <tr key={a.id} className="border-b border-slate-700/50 hover:bg-slate-700/20">
                      <td className="px-4 py-2.5">
                        <Link to={`/agents/${a.id}`} className="font-medium text-white hover:text-blue-400 transition-colors">
                          {a.hostname}
                        </Link>
                        {a.ip_address && <div className="text-xs text-slate-500 font-mono">{a.ip_address}</div>}
                        {a.group_name && (
                          <span className="text-xs px-1.5 py-0.5 rounded-full mt-0.5 inline-block"
                            style={{ background: (a.group_color || '#374151') + '33', color: a.group_color || '#9ca3af', border: `1px solid ${(a.group_color || '#374151')}66` }}>
                            {a.group_name}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="text-xs text-slate-400">{a.os_name || a.os_type || '—'}</div>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${a.status === 'online' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-700 text-slate-400'}`}>
                          {a.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        {a.critical_pending > 0
                          ? <span className="font-bold text-red-400">{a.critical_pending}</span>
                          : <span className="text-slate-600">0</span>}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        {a.moderate_pending > 0
                          ? <span className="font-bold text-yellow-400">{a.moderate_pending}</span>
                          : <span className="text-slate-600">0</span>}
                      </td>
                      <td className="px-4 py-2.5 text-center text-slate-400">
                        {a.upgrade_pending || <span className="text-slate-600">0</span>}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={`text-xs px-2 py-0.5 rounded-full border ${SEV_COLOR[a.compliance_status] || SEV_COLOR.unscanned}`}>
                          {SEV_LABEL[a.compliance_status] || a.compliance_status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        {a.restart_pending
                          ? <span title="Pending restart" className="inline-flex items-center gap-1 text-xs text-amber-400 bg-amber-500/15 border border-amber-700/40 rounded-full px-2 py-0.5">
                              <RotateCcw size={10} /> Restart
                            </span>
                          : <span className="text-slate-700">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-slate-500">
                        {a.last_scanned
                          ? new Date(a.last_scanned).toLocaleString()
                          : <span className="text-slate-600">Never</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
