import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, RefreshCw, Server, Cpu, MemoryStick, HardDrive,
  Activity, CheckCircle, XCircle, AlertTriangle, Search, Download
} from 'lucide-react'
import { integrationsApi } from '../api/client'
import api from '../api/client'

function StatCard({ title, value, sub, color = 'blue', icon: Icon }) {
  const colors = {
    blue: 'border-blue-500/30 bg-blue-900/10',
    green: 'border-green-500/30 bg-green-900/10',
    red: 'border-red-500/30 bg-red-900/10',
    yellow: 'border-yellow-500/30 bg-yellow-900/10',
    violet: 'border-violet-500/30 bg-violet-900/10',
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

function UsageBar({ label, pct, used, total, color = 'violet' }) {
  const colors = {
    violet: 'bg-violet-500',
    blue: 'bg-blue-500',
    green: 'bg-green-500',
    red: 'bg-red-500',
    amber: 'bg-amber-500',
  }
  const barColor = pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : colors[color]
  return (
    <div className="mb-3">
      <div className="flex justify-between text-xs text-slate-400 mb-1">
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      {used !== undefined && (
        <div className="text-xs text-slate-500 mt-0.5">{used} / {total}</div>
      )}
    </div>
  )
}

function PowerBadge({ state }) {
  if (state === 'POWERED_ON') return <span className="px-2 py-0.5 rounded text-xs font-medium bg-green-900/50 text-green-300 border border-green-700">ON</span>
  if (state === 'POWERED_OFF') return <span className="px-2 py-0.5 rounded text-xs font-medium bg-slate-700 text-slate-400 border border-slate-600">OFF</span>
  return <span className="px-2 py-0.5 rounded text-xs font-medium bg-yellow-900/50 text-yellow-300 border border-yellow-700">{state}</span>
}

function ConnBadge({ state }) {
  if (state === 'CONNECTED') return <span className="flex items-center gap-1 text-xs text-green-400"><CheckCircle className="w-3 h-3" />Connected</span>
  return <span className="flex items-center gap-1 text-xs text-red-400"><XCircle className="w-3 h-3" />{state}</span>
}

function fmtMb(mb) {
  if (!mb) return '0 GB'
  if (mb >= 1024 * 1024) return `${(mb / 1024 / 1024).toFixed(1)} TB`
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb} MB`
}

export default function IntegrationVMware() {
  const navigate = useNavigate()
  const [dash, setDash] = useState(null)
  const [vms, setVms] = useState([])
  const [hosts, setHosts] = useState([])
  const [datastores, setDatastores] = useState([])
  const [clusters, setClusters] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('vms')
  const [search, setSearch] = useState('')
  const [powerFilter, setPowerFilter] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const [d, v, h, ds, cl] = await Promise.all([
        integrationsApi.vmware.dashboard(),
        integrationsApi.vmware.vms(),
        integrationsApi.vmware.hosts(),
        integrationsApi.vmware.datastores(),
        integrationsApi.vmware.clusters(),
      ])
      setDash(d.data)
      setVms(v.data || [])
      setHosts(h.data || [])
      setDatastores(ds.data || [])
      setClusters(cl.data || [])
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const exportVms = async () => {
    try {
      const r = await api.get('/integrations/vmware/vms/export', { responseType: 'blob' })
      const url = URL.createObjectURL(r.data)
      const a = document.createElement('a')
      a.href = url; a.download = `vmware_vms_${new Date().toISOString().slice(0,10)}.xlsx`; a.click()
      URL.revokeObjectURL(url)
    } catch (e) { console.error(e) }
  }

  const filteredVms = vms.filter(vm => {
    if (powerFilter && vm.power_state !== powerFilter) return false
    if (search) {
      const q = search.toLowerCase()
      return (vm.name || '').toLowerCase().includes(q) ||
        (vm.guest_os || '').toLowerCase().includes(q) ||
        (vm.ip_address || '').toLowerCase().includes(q)
    }
    return true
  })

  if (loading) return (
    <div className="p-8 text-slate-400 flex items-center gap-2">
      <RefreshCw className="w-4 h-4 animate-spin" />Loading VMware data...
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
          <Server className="w-6 h-6 text-violet-400" />
          <div>
            <h1 className="text-xl font-bold text-white">VMware vCenter</h1>
            <p className="text-xs text-slate-400">
              {plugin.last_sync_at ? `Last sync: ${new Date(plugin.last_sync_at).toLocaleString()}` : 'Not synced yet'}
            </p>
          </div>
        </div>
        <button onClick={load} className="flex items-center gap-2 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-sm transition-colors">
          <RefreshCw className="w-4 h-4" />Refresh
        </button>
      </div>

      {/* Status alert */}
      {plugin.status === 'error' && (
        <div className="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {plugin.last_error || 'Connection error'}
        </div>
      )}
      {plugin.status === 'disconnected' && (
        <div className="mb-4 p-3 bg-slate-800 border border-slate-600 rounded-lg text-slate-400 text-sm">
          VMware integration is not connected. Configure credentials in the Integrations hub.
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard title="Total VMs" value={d.vms?.total ?? 0} sub={`${d.vms?.powered_on ?? 0} powered on`} color="violet" icon={Server} />
        <StatCard title="Hosts" value={d.hosts?.total ?? 0} sub={`${d.hosts?.connected ?? 0} connected`} color="blue" icon={Cpu} />
        <StatCard title="Datastores" value={d.datastores?.total ?? 0} sub={`${d.datastores?.usage_pct ?? 0}% used`} color={d.datastores?.usage_pct >= 85 ? 'red' : 'slate'} icon={HardDrive} />
        <StatCard title="Clusters" value={d.clusters?.total ?? 0} color="slate" icon={Activity} />
      </div>

      {/* Resource usage bars */}
      {(d.hosts?.total > 0 || d.datastores?.total > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4">
            <h3 className="text-sm font-medium text-slate-300 mb-3">Host CPU Usage</h3>
            <UsageBar label="Cluster CPU" pct={d.hosts?.cpu_usage_pct ?? 0} color="violet" />
          </div>
          <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4">
            <h3 className="text-sm font-medium text-slate-300 mb-3">Host Memory Usage</h3>
            <UsageBar label="Cluster Memory" pct={d.hosts?.memory_usage_pct ?? 0} color="blue" />
          </div>
          <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4">
            <h3 className="text-sm font-medium text-slate-300 mb-3">Datastore Usage</h3>
            <UsageBar
              label="Storage"
              pct={d.datastores?.usage_pct ?? 0}
              used={fmtMb((d.datastores?.total_mb ?? 0) - (d.datastores?.free_mb ?? 0))}
              total={fmtMb(d.datastores?.total_mb ?? 0)}
            />
          </div>
        </div>
      )}

      {/* VM power state breakdown */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        {[
          { label: 'Powered On', count: d.vms?.powered_on ?? 0, color: 'text-green-400' },
          { label: 'Powered Off', count: d.vms?.powered_off ?? 0, color: 'text-slate-400' },
          { label: 'Suspended', count: d.vms?.suspended ?? 0, color: 'text-yellow-400' },
        ].map(item => (
          <div key={item.label} className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 text-center">
            <div className={`text-2xl font-bold ${item.color}`}>{item.count}</div>
            <div className="text-xs text-slate-400 mt-1">{item.label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-slate-800/60 border border-slate-700 rounded-xl p-1 w-fit">
        {[
          { id: 'vms', label: `VMs (${vms.length})` },
          { id: 'hosts', label: `Hosts (${hosts.length})` },
          { id: 'datastores', label: `Datastores (${datastores.length})` },
          { id: 'clusters', label: `Clusters (${clusters.length})` },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t.id ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'
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
                className="w-full pl-9 pr-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:border-violet-500"
                placeholder="Search VMs..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <select
              className="px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:border-violet-500"
              value={powerFilter}
              onChange={e => setPowerFilter(e.target.value)}
            >
              <option value="">All States</option>
              <option value="POWERED_ON">Powered On</option>
              <option value="POWERED_OFF">Powered Off</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
            <button
              onClick={exportVms}
              className="flex items-center gap-2 px-3 py-2 bg-violet-700 hover:bg-violet-600 text-white rounded-lg text-sm transition-colors ml-auto"
            >
              <Download className="w-4 h-4" />Export XLSX
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 text-xs">
                  <th className="text-left px-4 py-3">Name</th>
                  <th className="text-left px-4 py-3">Power</th>
                  <th className="text-left px-4 py-3">OS</th>
                  <th className="text-left px-4 py-3">CPUs</th>
                  <th className="text-left px-4 py-3">Memory</th>
                  <th className="text-left px-4 py-3">IP</th>
                  <th className="text-left px-4 py-3">Host</th>
                  <th className="text-left px-4 py-3">Date Created</th>
                </tr>
              </thead>
              <tbody>
                {filteredVms.map((vm, i) => (
                  <tr key={vm.vm_id || i} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                    <td className="px-4 py-3 font-medium text-white">{vm.name}</td>
                    <td className="px-4 py-3"><PowerBadge state={vm.power_state} /></td>
                    <td className="px-4 py-3 text-slate-300 text-xs">{vm.guest_os || '—'}</td>
                    <td className="px-4 py-3 text-slate-300">{vm.cpu_count || 0}</td>
                    <td className="px-4 py-3 text-slate-300">{fmtMb(vm.memory_mb)}</td>
                    <td className="px-4 py-3 text-slate-400 font-mono text-xs">{vm.ip_address || '—'}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{vm.host_name || '—'}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs">
                      {vm.vcenter_created_at ? new Date(vm.vcenter_created_at).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
                {filteredVms.length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-500">No VMs found</td></tr>
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
                  <th className="text-left px-4 py-3">Connection</th>
                  <th className="text-left px-4 py-3">Power</th>
                  <th className="text-left px-4 py-3">Cores</th>
                  <th className="text-left px-4 py-3">CPU Usage</th>
                  <th className="text-left px-4 py-3">Memory</th>
                  <th className="text-left px-4 py-3">Mem Usage</th>
                  <th className="text-left px-4 py-3">Cluster</th>
                </tr>
              </thead>
              <tbody>
                {hosts.map((h, i) => (
                  <tr key={h.host_id || i} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                    <td className="px-4 py-3 font-medium text-white text-xs">{h.name}</td>
                    <td className="px-4 py-3"><ConnBadge state={h.connection_state} /></td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{h.power_state}</td>
                    <td className="px-4 py-3 text-slate-300">{h.cpu_cores}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-16 bg-slate-700 rounded-full">
                          <div className="h-full bg-violet-500 rounded-full" style={{ width: `${Math.min(h.cpu_usage_pct, 100)}%` }} />
                        </div>
                        <span className="text-xs text-slate-400">{h.cpu_usage_pct}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-300 text-xs">{fmtMb(h.memory_mb)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-16 bg-slate-700 rounded-full">
                          <div className={`h-full rounded-full ${h.memory_usage_pct >= 90 ? 'bg-red-500' : h.memory_usage_pct >= 75 ? 'bg-amber-500' : 'bg-blue-500'}`} style={{ width: `${Math.min(h.memory_usage_pct, 100)}%` }} />
                        </div>
                        <span className="text-xs text-slate-400">{h.memory_usage_pct}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{h.cluster_name || '—'}</td>
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

      {/* Datastores tab */}
      {tab === 'datastores' && (
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 text-xs">
                  <th className="text-left px-4 py-3">Name</th>
                  <th className="text-left px-4 py-3">Type</th>
                  <th className="text-left px-4 py-3">Total</th>
                  <th className="text-left px-4 py-3">Free</th>
                  <th className="text-left px-4 py-3 min-w-32">Usage</th>
                  <th className="text-left px-4 py-3">Accessible</th>
                </tr>
              </thead>
              <tbody>
                {datastores.map((ds, i) => (
                  <tr key={ds.ds_id || i} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                    <td className="px-4 py-3 font-medium text-white">{ds.name}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{ds.ds_type || '—'}</td>
                    <td className="px-4 py-3 text-slate-300 text-xs">{fmtMb(ds.capacity_mb)}</td>
                    <td className="px-4 py-3 text-slate-300 text-xs">{fmtMb(ds.free_mb)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 bg-slate-700 rounded-full min-w-16">
                          <div className={`h-full rounded-full ${ds.usage_pct >= 90 ? 'bg-red-500' : ds.usage_pct >= 75 ? 'bg-amber-500' : 'bg-violet-500'}`} style={{ width: `${Math.min(ds.usage_pct, 100)}%` }} />
                        </div>
                        <span className="text-xs text-slate-400 w-10">{ds.usage_pct}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {ds.accessible ? <CheckCircle className="w-4 h-4 text-green-400" /> : <XCircle className="w-4 h-4 text-red-400" />}
                    </td>
                  </tr>
                ))}
                {datastores.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-500">No datastores found</td></tr>
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
                  <th className="text-left px-4 py-3">HA</th>
                  <th className="text-left px-4 py-3">DRS</th>
                  <th className="text-left px-4 py-3">Hosts</th>
                  <th className="text-left px-4 py-3">VMs</th>
                  <th className="text-left px-4 py-3">Total Cores</th>
                  <th className="text-left px-4 py-3">Total Memory</th>
                </tr>
              </thead>
              <tbody>
                {clusters.map((cl, i) => (
                  <tr key={cl.cluster_id || i} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                    <td className="px-4 py-3 font-medium text-white">{cl.name}</td>
                    <td className="px-4 py-3">
                      {cl.ha_enabled ? <CheckCircle className="w-4 h-4 text-green-400" /> : <XCircle className="w-4 h-4 text-slate-600" />}
                    </td>
                    <td className="px-4 py-3">
                      {cl.drs_enabled ? <CheckCircle className="w-4 h-4 text-green-400" /> : <XCircle className="w-4 h-4 text-slate-600" />}
                    </td>
                    <td className="px-4 py-3 text-slate-300">{cl.host_count ?? '—'}</td>
                    <td className="px-4 py-3 text-slate-300">{cl.vm_count ?? '—'}</td>
                    <td className="px-4 py-3 text-slate-300">{cl.cpu_cores ?? '—'}</td>
                    <td className="px-4 py-3 text-slate-300 text-xs">{cl.memory_mb ? fmtMb(cl.memory_mb) : '—'}</td>
                  </tr>
                ))}
                {clusters.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">No clusters found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
