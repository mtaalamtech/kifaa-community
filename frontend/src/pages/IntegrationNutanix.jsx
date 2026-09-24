import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, RefreshCw, Server, Cpu, MemoryStick,
  AlertTriangle, Search, Bell, CheckCircle
} from 'lucide-react'
import { integrationsApi } from '../api/client'

function StatCard({ title, value, sub, color = 'cyan', icon: Icon }) {
  const colors = {
    cyan: 'border-cyan-500/30 bg-cyan-900/10',
    blue: 'border-blue-500/30 bg-blue-900/10',
    green: 'border-green-500/30 bg-green-900/10',
    red: 'border-red-500/30 bg-red-900/10',
    yellow: 'border-yellow-500/30 bg-yellow-900/10',
    slate: 'border-slate-600 bg-slate-800/40',
  }
  return (
    <div className={`rounded-xl border p-5 ${colors[color]}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-slate-400">{title}</span>
        {Icon && <Icon className="w-4 h-4 text-slate-500" />}
      </div>
      <div className="text-2xl font-bold text-white">{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
    </div>
  )
}

function SeverityBadge({ severity }) {
  if (severity === 'CRITICAL') return <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-900/50 text-red-300 border border-red-700">Critical</span>
  if (severity === 'WARNING') return <span className="px-2 py-0.5 rounded text-xs font-medium bg-yellow-900/50 text-yellow-300 border border-yellow-700">Warning</span>
  return <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-900/40 text-blue-300 border border-blue-700">{severity || 'Info'}</span>
}

function PowerBadge({ state }) {
  if (state === 'ON') return <span className="px-2 py-0.5 rounded text-xs font-medium bg-green-900/50 text-green-300 border border-green-700">ON</span>
  return <span className="px-2 py-0.5 rounded text-xs font-medium bg-slate-700 text-slate-400 border border-slate-600">{state || 'OFF'}</span>
}

function fmtHz(hz) {
  if (!hz) return '—'
  if (hz >= 1e9) return `${(hz / 1e9).toFixed(1)} GHz`
  return `${(hz / 1e6).toFixed(0)} MHz`
}

function fmtMb(mb) {
  if (!mb) return '—'
  if (mb >= 1024 * 1024) return `${(mb / 1024 / 1024).toFixed(1)} TB`
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb} MB`
}

export default function IntegrationNutanix() {
  const navigate = useNavigate()
  const [dash, setDash] = useState(null)
  const [clusters, setClusters] = useState([])
  const [vms, setVms] = useState([])
  const [hosts, setHosts] = useState([])
  const [alerts, setAlerts] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('vms')
  const [search, setSearch] = useState('')
  const [powerFilter, setPowerFilter] = useState('')
  const [sevFilter, setSevFilter] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const [d, cl, v, h, al] = await Promise.all([
        integrationsApi.nutanix.dashboard(),
        integrationsApi.nutanix.clusters(),
        integrationsApi.nutanix.vms(),
        integrationsApi.nutanix.hosts(),
        integrationsApi.nutanix.alerts(),
      ])
      setDash(d.data)
      setClusters(cl.data || [])
      setVms(v.data || [])
      setHosts(h.data || [])
      setAlerts(al.data || [])
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const filteredVms = vms.filter(vm => {
    if (powerFilter && vm.power_state !== powerFilter) return false
    if (search) {
      const q = search.toLowerCase()
      return (vm.name || '').toLowerCase().includes(q) || (vm.cluster_name || '').toLowerCase().includes(q)
    }
    return true
  })

  const filteredAlerts = alerts.filter(a => {
    if (sevFilter && a.severity !== sevFilter) return false
    return true
  })

  if (loading) return (
    <div className="p-8 text-slate-400 flex items-center gap-2">
      <RefreshCw className="w-4 h-4 animate-spin" />Loading Nutanix data...
    </div>
  )

  const d = dash || {}
  const plugin = d.plugin || {}

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/integrations')} className="text-slate-400 hover:text-white transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <Server className="w-6 h-6 text-cyan-400" />
          <div>
            <h1 className="text-xl font-bold text-white">Nutanix Prism</h1>
            <p className="text-xs text-slate-400">
              {plugin.last_sync_at ? `Last sync: ${new Date(plugin.last_sync_at).toLocaleString()}` : 'Not synced yet'}
            </p>
          </div>
        </div>
        <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-sm transition-colors">
          <RefreshCw className="w-4 h-4" />Refresh
        </button>
      </div>

      {plugin.status === 'error' && (
        <div className="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {plugin.last_error || 'Connection error'}
        </div>
      )}
      {plugin.status === 'disconnected' && (
        <div className="mb-4 p-3 bg-slate-800 border border-slate-600 rounded-lg text-slate-400 text-sm">
          Nutanix integration is not connected. Configure credentials in the Integrations hub.
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard title="Clusters" value={d.clusters?.total ?? 0} color="cyan" icon={Server} />
        <StatCard title="VMs" value={d.vms?.total ?? 0} sub={`${d.vms?.powered_on ?? 0} powered on`} color="blue" icon={Cpu} />
        <StatCard title="Hosts" value={d.hosts?.total ?? 0} sub={fmtHz(d.hosts?.total_cpu_hz)} color="slate" icon={Server} />
        <StatCard
          title="Active Alerts"
          value={d.alerts?.total ?? 0}
          sub={d.alerts?.critical > 0 ? `${d.alerts.critical} critical` : 'None critical'}
          color={d.alerts?.critical > 0 ? 'red' : d.alerts?.warning > 0 ? 'yellow' : 'green'}
          icon={Bell}
        />
      </div>

      {/* VM power breakdown */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4">
          <h3 className="text-sm font-medium text-slate-300 mb-3">VM Power State</h3>
          <div className="flex gap-6">
            <div className="text-center">
              <div className="text-2xl font-bold text-green-400">{d.vms?.powered_on ?? 0}</div>
              <div className="text-xs text-slate-400">Powered On</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-slate-400">{d.vms?.powered_off ?? 0}</div>
              <div className="text-xs text-slate-400">Powered Off</div>
            </div>
          </div>
        </div>
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4">
          <h3 className="text-sm font-medium text-slate-300 mb-3">Alert Summary</h3>
          <div className="flex gap-6">
            <div className="text-center">
              <div className="text-2xl font-bold text-red-400">{d.alerts?.critical ?? 0}</div>
              <div className="text-xs text-slate-400">Critical</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-yellow-400">{d.alerts?.warning ?? 0}</div>
              <div className="text-xs text-slate-400">Warning</div>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-slate-800/60 border border-slate-700 rounded-xl p-1 w-fit">
        {[
          { id: 'vms', label: `VMs (${vms.length})` },
          { id: 'hosts', label: `Hosts (${hosts.length})` },
          { id: 'clusters', label: `Clusters (${clusters.length})` },
          { id: 'alerts', label: `Alerts (${alerts.length})` },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t.id ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* VMs tab */}
      {tab === 'vms' && (
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-700 flex gap-3 flex-wrap">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                className="w-full pl-9 pr-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500"
                placeholder="Search VMs..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <select
              className="px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none"
              value={powerFilter}
              onChange={e => setPowerFilter(e.target.value)}
            >
              <option value="">All States</option>
              <option value="ON">Powered On</option>
              <option value="OFF">Powered Off</option>
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 text-xs">
                  <th className="text-left px-4 py-3">Name</th>
                  <th className="text-left px-4 py-3">Power</th>
                  <th className="text-left px-4 py-3">vCPUs</th>
                  <th className="text-left px-4 py-3">Memory</th>
                  <th className="text-left px-4 py-3">Cluster</th>
                  <th className="text-left px-4 py-3">Host</th>
                  <th className="text-left px-4 py-3">OS</th>
                </tr>
              </thead>
              <tbody>
                {filteredVms.map((vm, i) => (
                  <tr key={vm.vm_id || i} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                    <td className="px-4 py-3 font-medium text-white">{vm.name}</td>
                    <td className="px-4 py-3"><PowerBadge state={vm.power_state} /></td>
                    <td className="px-4 py-3 text-slate-300">{vm.num_vcpus || 0}</td>
                    <td className="px-4 py-3 text-slate-300 text-xs">{fmtMb(vm.memory_mb)}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{vm.cluster_name || '—'}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{vm.host_name || '—'}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{vm.guest_os || '—'}</td>
                  </tr>
                ))}
                {filteredVms.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">No VMs found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Hosts tab */}
      {tab === 'hosts' && (
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 text-xs">
                  <th className="text-left px-4 py-3">Host</th>
                  <th className="text-left px-4 py-3">IP</th>
                  <th className="text-left px-4 py-3">Hypervisor</th>
                  <th className="text-left px-4 py-3">CPUs</th>
                  <th className="text-left px-4 py-3">CPU Capacity</th>
                  <th className="text-left px-4 py-3">Memory</th>
                  <th className="text-left px-4 py-3">Cluster</th>
                  <th className="text-left px-4 py-3">VMs</th>
                </tr>
              </thead>
              <tbody>
                {hosts.map((h, i) => (
                  <tr key={h.host_id || i} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                    <td className="px-4 py-3 font-medium text-white text-xs">{h.name}</td>
                    <td className="px-4 py-3 text-slate-400 font-mono text-xs">{h.ip_address || '—'}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{h.hypervisor_type || '—'}</td>
                    <td className="px-4 py-3 text-slate-300">{h.num_cpus}</td>
                    <td className="px-4 py-3 text-slate-300 text-xs">{fmtHz(h.cpu_capacity_hz)}</td>
                    <td className="px-4 py-3 text-slate-300 text-xs">{fmtMb(h.memory_capacity_mb)}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{h.cluster_name || '—'}</td>
                    <td className="px-4 py-3 text-slate-300">{h.num_vms ?? '—'}</td>
                  </tr>
                ))}
                {hosts.length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-500">No hosts found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Clusters tab */}
      {tab === 'clusters' && (
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 text-xs">
                  <th className="text-left px-4 py-3">Name</th>
                  <th className="text-left px-4 py-3">UUID</th>
                  <th className="text-left px-4 py-3">Nodes</th>
                  <th className="text-left px-4 py-3">Version</th>
                  <th className="text-left px-4 py-3">Hypervisor</th>
                </tr>
              </thead>
              <tbody>
                {clusters.map((cl, i) => (
                  <tr key={cl.cluster_id || i} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                    <td className="px-4 py-3 font-medium text-white">{cl.name}</td>
                    <td className="px-4 py-3 text-slate-400 font-mono text-xs">{cl.cluster_uuid || '—'}</td>
                    <td className="px-4 py-3 text-slate-300">{cl.num_nodes ?? '—'}</td>
                    <td className="px-4 py-3 text-slate-300 text-xs">{cl.version || '—'}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{cl.hypervisor || '—'}</td>
                  </tr>
                ))}
                {clusters.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">No clusters found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Alerts tab */}
      {tab === 'alerts' && (
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-700 flex gap-3">
            <select
              className="px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none"
              value={sevFilter}
              onChange={e => setSevFilter(e.target.value)}
            >
              <option value="">All Severities</option>
              <option value="CRITICAL">Critical</option>
              <option value="WARNING">Warning</option>
              <option value="INFO">Info</option>
            </select>
          </div>
          <div className="divide-y divide-slate-700/50">
            {filteredAlerts.map((a, i) => (
              <div key={a.alert_id || i} className="p-4 hover:bg-slate-700/20 flex items-start gap-3">
                <div className="mt-0.5">
                  {a.severity === 'CRITICAL' ? (
                    <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
                  ) : a.severity === 'WARNING' ? (
                    <AlertTriangle className="w-4 h-4 text-yellow-400 flex-shrink-0" />
                  ) : (
                    <CheckCircle className="w-4 h-4 text-blue-400 flex-shrink-0" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <SeverityBadge severity={a.severity} />
                    {a.entity_type && <span className="text-xs text-slate-500">{a.entity_type}</span>}
                    {a.resolved && <span className="text-xs text-green-500">Resolved</span>}
                  </div>
                  <p className="text-sm text-slate-300">{a.title || a.message || 'No description'}</p>
                  {a.created_at && (
                    <p className="text-xs text-slate-500 mt-1">{new Date(a.created_at).toLocaleString()}</p>
                  )}
                </div>
              </div>
            ))}
            {filteredAlerts.length === 0 && (
              <div className="p-8 text-center text-slate-500">No alerts found</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
