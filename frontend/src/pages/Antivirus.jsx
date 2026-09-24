import { useEffect, useState } from 'react'
import { ShieldCheck, ShieldAlert, Shield, RefreshCw, Search, Monitor, Terminal } from 'lucide-react'
import api from '../api/client'
import { Link } from 'react-router-dom'

function SummaryCard({ label, value, sub, color, icon: Icon }) {
  return (
    <div className="bg-slate-900 border border-slate-700 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-slate-400">{label}</span>
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${color}`}>
          <Icon size={18} className="text-white" />
        </div>
      </div>
      <div className="text-3xl font-bold text-white">{value ?? '—'}</div>
      {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
    </div>
  )
}

function AVBadge({ installed, running, source }) {
  if (source === 'not_applicable') {
    return <span className="text-xs px-2 py-0.5 rounded-full bg-slate-700/60 text-slate-500 border border-slate-700">N/A</span>
  }
  if (source === 'no_report' || (installed === null && installed === undefined)) {
    return <span className="text-xs px-2 py-0.5 rounded-full bg-slate-700 text-slate-400 border border-slate-600">No report</span>
  }
  if (!installed) {
    return <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30">Not installed</span>
  }
  // Found via software inventory — Security Center didn't register it
  // (common with Sophos Central, CrowdStrike, AVG displacing Defender)
  if (source === 'software_inventory') {
    return (
      <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
        title="Found in installed applications — services confirmed running. Security Center may not register managed/EDR products.">
        Active (via SW inventory)
      </span>
    )
  }
  if (running === null) {
    return <span className="text-xs px-2 py-0.5 rounded-full bg-slate-600 text-slate-300 border border-slate-500">Installed</span>
  }
  if (!running) {
    return <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">Installed, not running</span>
  }
  return <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">Active</span>
}

function OSIcon({ osType }) {
  if (osType === 'windows') return <Monitor size={13} className="text-blue-400" />
  if (osType === 'linux')   return <Terminal size={13} className="text-orange-400" />
  return <Shield size={13} className="text-slate-400" />
}

function MiniBar({ pct, color }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className="text-xs text-slate-400 w-8 text-right">{pct}%</span>
    </div>
  )
}

export default function Antivirus() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [osFilter, setOsFilter] = useState('windows')  // default to Windows — Linux AV is N/A
  const [avFilter, setAvFilter] = useState('all')

  const load = () => {
    setLoading(true)
    api.get('/threats/av-status')
      .then(r => setData(r.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const summary = data?.summary || {}
  const agents  = data?.agents  || []

  const winProtectedPct = summary.windows_total
    ? Math.round((summary.windows_protected / summary.windows_total) * 100)
    : 0

  const filtered = agents.filter(a => {
    // OS filter — when "all" selected, exclude Linux N/A (no AV) agents unless user picks Linux
    if (osFilter === 'windows' && a.os_type !== 'windows') return false
    if (osFilter === 'linux'   && a.os_type !== 'linux') return false
    if (osFilter === 'all' && a.av_source === 'not_applicable') return false

    if (avFilter === 'active'      && !(a.av_running === true || a.av_source === 'software_inventory')) return false
    if (avFilter === 'sw_only'     && a.av_source !== 'software_inventory') return false
    if (avFilter === 'installed'   && !(a.av_installed && a.av_running === false && a.av_source !== 'software_inventory')) return false
    if (avFilter === 'missing'     && a.av_installed !== false) return false
    if (avFilter === 'no_report'   && a.av_source !== 'no_report') return false
    if (search) {
      const q = search.toLowerCase()
      if (!a.hostname?.toLowerCase().includes(q) &&
          !a.av_product?.toLowerCase().includes(q) &&
          !a.ip_address?.includes(q)) return false
    }
    return true
  })

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Antivirus Status</h1>
          <p className="text-sm text-slate-400 mt-0.5">AV product detection and protection status across all endpoints</p>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-2 px-3 py-2 text-sm bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded-lg text-slate-300 transition-colors">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {loading && !data ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <SummaryCard
              label="Windows Agents"
              value={summary.windows_total ?? 0}
              sub={`${summary.windows_protected ?? 0} protected`}
              color="bg-blue-600"
              icon={Monitor}
            />
            <SummaryCard
              label="AV Active (Windows)"
              value={summary.windows_protected ?? 0}
              sub={`${winProtectedPct}% of Windows endpoints`}
              color="bg-emerald-600"
              icon={ShieldCheck}
            />
            <SummaryCard
              label="No AV (Windows)"
              value={summary.windows_no_av ?? 0}
              sub={summary.windows_no_av > 0 ? 'Action required' : 'All protected'}
              color={summary.windows_no_av > 0 ? 'bg-red-600' : 'bg-slate-600'}
              icon={ShieldAlert}
            />
            <SummaryCard
              label="Linux Agents"
              value={summary.linux_total ?? 0}
              sub={summary.linux_with_av > 0 ? `${summary.linux_with_av} have AV` : 'AV optional on Linux'}
              color="bg-orange-600"
              icon={Terminal}
            />
          </div>

          {/* Windows coverage bar */}
          {summary.windows_total > 0 && (
            <div className="bg-slate-900 border border-slate-700 rounded-xl p-5 mb-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-white">Windows AV Coverage</span>
                <span className="text-sm text-slate-400">{summary.windows_protected}/{summary.windows_total} protected</span>
              </div>
              <MiniBar pct={winProtectedPct} color={winProtectedPct >= 90 ? 'bg-emerald-500' : winProtectedPct >= 70 ? 'bg-yellow-500' : 'bg-red-500'} />
              <div className="flex gap-4 mt-3 text-xs text-slate-400">
                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" />Active ({summary.windows_protected})</span>
                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-yellow-500" />Installed not running ({(summary.windows_av_installed ?? 0) - (summary.windows_protected ?? 0)})</span>
                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-500" />No AV ({summary.windows_no_av ?? 0})</span>
                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-slate-500" />No report ({summary.not_yet_reported ?? 0})</span>
              </div>
            </div>
          )}

          {/* Filters */}
          <div className="flex flex-wrap gap-3 mb-4">
            <div className="relative flex-1 max-w-xs">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search hostname, IP, product…"
                className="w-full bg-slate-800 border border-slate-600 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-slate-500"
              />
            </div>
            <select value={osFilter} onChange={e => setOsFilter(e.target.value)}
              className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white">
              <option value="windows">Windows</option>
              <option value="linux">Linux (AV optional)</option>
              <option value="all">All OS</option>
            </select>
            <select value={avFilter} onChange={e => setAvFilter(e.target.value)}
              className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white">
              <option value="all">All AV Status</option>
              <option value="active">Active</option>
              <option value="installed">Installed, not running</option>
              <option value="sw_only">Detected via SW inventory</option>
              <option value="missing">Not installed</option>
              <option value="no_report">No report yet</option>
            </select>
            <span className="text-xs text-slate-500 self-center">{filtered.length} agents</span>
          </div>

          {/* Table */}
          <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-slate-700">
                  <th className="px-4 py-3 font-medium">Endpoint</th>
                  <th className="px-4 py-3 font-medium">OS</th>
                  <th className="px-4 py-3 font-medium">AV Product</th>
                  <th className="px-4 py-3 font-medium">Version</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Last Scan</th>
                  <th className="px-4 py-3 font-medium">Reported</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(agent => (
                  <tr key={agent.id} className="border-b border-slate-800 hover:bg-slate-800/40 transition-colors">
                    <td className="px-4 py-3">
                      <Link to={`/agents/${agent.id}`} className="text-blue-400 hover:text-blue-300 font-medium">
                        {agent.display_name || agent.hostname}
                      </Link>
                      <div className="text-xs text-slate-500">{agent.ip_address}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <OSIcon osType={agent.os_type} />
                        <span className="text-slate-300 text-xs">{agent.os_name || agent.os_type}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {agent.av_product ? (
                        <div className="space-y-0.5">
                          {agent.av_product.split(',').map((p, i) => (
                            <div key={i} className="text-white text-xs">{p.trim()}</div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-slate-500 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {agent.av_versions?.length > 0 ? (
                        <div className="space-y-0.5">
                          {agent.av_versions.map((v, i) => (
                            <div key={i} className="text-xs font-mono text-slate-300">{v.version}</div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-slate-500 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <AVBadge installed={agent.av_installed} running={agent.av_running} source={agent.av_source} />
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400">
                      {agent.av_last_scan && agent.av_last_scan !== 'None'
                        ? (() => { try { return new Date(agent.av_last_scan).toLocaleString() } catch { return agent.av_last_scan } })()
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {agent.security_updated_at
                        ? new Date(agent.security_updated_at).toLocaleString()
                        : 'Never'}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                      {loading ? 'Loading…' : 'No agents match the current filters'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
