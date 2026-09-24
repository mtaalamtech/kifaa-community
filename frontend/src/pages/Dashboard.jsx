import { useEffect, useState } from 'react'
import { agentsApi } from '../api/client'
import { Monitor, AlertTriangle, CheckCircle2, XCircle, Wifi, Bell, Terminal, Tag } from 'lucide-react'
import { Link } from 'react-router-dom'
import { friendlyOS } from '../utils/osName'

function StatCard({ label, value, icon: Icon, color, sub }) {
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

function StatusBadge({ status }) {
  const map = {
    online: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    offline: 'bg-slate-700 text-slate-400 border-slate-600',
    warning: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    maintenance: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${map[status] || map.offline}`}>
      {status}
    </span>
  )
}

export default function Dashboard() {
  const [stats, setStats] = useState(null)
  const [agents, setAgents] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      agentsApi.stats(),
      agentsApi.list(),
    ]).then(([statsRes, agentsRes]) => {
      setStats(statsRes.data)
      setAgents(agentsRes.data)
    }).catch(console.error).finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Dashboard</h1>
          <p className="text-sm text-slate-400 mt-0.5">Platform overview</p>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total Agents" value={stats?.total_agents} icon={Monitor} color="bg-blue-600" />
        <StatCard label="Online" value={stats?.online_agents} icon={CheckCircle2} color="bg-emerald-600"
          sub={stats ? `${Math.round((stats.online_agents / Math.max(stats.total_agents, 1)) * 100)}% availability` : ''} />
        <StatCard label="Offline" value={stats?.offline_agents} icon={XCircle} color="bg-slate-600" />
        <StatCard label="Open Alerts" value={stats?.open_alerts} icon={Bell}
          color={stats?.critical_alerts > 0 ? 'bg-red-600' : 'bg-yellow-600'}
          sub={stats?.critical_alerts > 0 ? `${stats.critical_alerts} critical` : 'No critical'} />
      </div>

      {/* OS + Version breakdown */}
      {stats && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
          {/* OS split */}
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
              <Monitor size={15} className="text-blue-400" /> Platform Breakdown
            </h2>
            <div className="flex items-center gap-4">
              <div className="flex-1 space-y-3">
                {[
                  { label: 'Windows', count: stats.windows_agents ?? 0, color: 'bg-blue-500', icon: Monitor, iconColor: 'text-blue-400' },
                  { label: 'Linux',   count: stats.linux_agents   ?? 0, color: 'bg-orange-500', icon: Terminal, iconColor: 'text-orange-400' },
                ].map(({ label, count, color, icon: Icon, iconColor }) => {
                  const pct = stats.total_agents > 0 ? Math.round((count / stats.total_agents) * 100) : 0
                  return (
                    <div key={label}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="flex items-center gap-1.5 text-sm text-slate-300"><Icon size={13} className={iconColor} />{label}</span>
                        <span className="text-sm font-semibold text-white">{count} <span className="text-xs font-normal text-slate-400">({pct}%)</span></span>
                      </div>
                      <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Agent version counts */}
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
              <Tag size={15} className="text-purple-400" /> Agent Version Distribution
            </h2>
            {(stats.version_breakdown ?? []).length === 0 ? (
              <div className="text-sm text-slate-500 py-4 text-center">No version data yet</div>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {(stats.version_breakdown ?? []).map((row, i) => {
                  const pct = stats.total_agents > 0 ? Math.round((row.count / stats.total_agents) * 100) : 0
                  const isWin = row.os_type === 'windows'
                  return (
                    <div key={i} className="flex items-center gap-3">
                      <span className={`text-xs w-4 flex-shrink-0 ${isWin ? 'text-blue-400' : 'text-orange-400'}`}>
                        {isWin ? '⊞' : '🐧'}
                      </span>
                      <span className="text-xs font-mono text-slate-300 w-16 flex-shrink-0">v{row.version}</span>
                      <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${isWin ? 'bg-blue-500' : 'bg-orange-500'}`}
                          style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs text-slate-400 w-14 text-right">{row.count} agent{row.count !== 1 ? 's' : ''}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Agent table */}
      <div className="bg-slate-900 border border-slate-700 rounded-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
          <h2 className="text-sm font-semibold text-white">All Agents</h2>
          <Link to="/agents" className="text-xs text-blue-400 hover:text-blue-300">View all →</Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-700">
                <th className="px-5 py-3 font-medium">Hostname</th>
                <th className="px-5 py-3 font-medium">IP Address</th>
                <th className="px-5 py-3 font-medium">OS</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {agents.slice(0, 10).map(agent => (
                <tr key={agent.id} className="border-b border-slate-800 hover:bg-slate-800/50 transition-colors">
                  <td className="px-5 py-3">
                    <Link to={`/agents/${agent.id}`} className="text-blue-400 hover:text-blue-300 font-medium">
                      {agent.hostname}
                    </Link>
                  </td>
                  <td className="px-5 py-3 text-slate-300">{agent.ip_address || '—'}</td>
                  <td className="px-5 py-3 text-slate-300">{friendlyOS(agent.os_name, agent.os_version)}</td>
                  <td className="px-5 py-3"><StatusBadge status={agent.status} /></td>
                  <td className="px-5 py-3 text-slate-400">
                    {agent.last_seen ? new Date(agent.last_seen).toLocaleString() : 'Never'}
                  </td>
                </tr>
              ))}
              {agents.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-12 text-center text-slate-500">
                    No agents registered yet. Deploy an agent to get started.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
