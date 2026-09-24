import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, RefreshCw, Server, Cpu, HardDrive,
  Activity, AlertTriangle, Search, Box
} from 'lucide-react'
import { integrationsApi } from '../api/client'

function StatCard({ title, value, sub, color = 'orange', icon: Icon }) {
  const colors = {
    orange: 'border-orange-500/30 bg-orange-900/10',
    blue: 'border-blue-500/30 bg-blue-900/10',
    green: 'border-green-500/30 bg-green-900/10',
    red: 'border-red-500/30 bg-red-900/10',
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

function StatusBadge({ status }) {
  if (status === 'running') return <span className="px-2 py-0.5 rounded text-xs font-medium bg-green-900/50 text-green-300 border border-green-700">running</span>
  if (status === 'stopped') return <span className="px-2 py-0.5 rounded text-xs font-medium bg-slate-700 text-slate-400 border border-slate-600">stopped</span>
  if (status === 'online') return <span className="px-2 py-0.5 rounded text-xs font-medium bg-green-900/50 text-green-300 border border-green-700">online</span>
  if (status === 'offline') return <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-900/50 text-red-300 border border-red-700">offline</span>
  return <span className="px-2 py-0.5 rounded text-xs font-medium bg-slate-700 text-slate-400 border border-slate-600">{status || 'unknown'}</span>
}

function TypeBadge({ type }) {
  if (type === 'qemu') return <span className="px-2 py-0.5 rounded text-xs bg-orange-900/40 text-orange-300 border border-orange-700">VM</span>
  if (type === 'lxc') return <span className="px-2 py-0.5 rounded text-xs bg-blue-900/40 text-blue-300 border border-blue-700">LXC</span>
  return <span className="px-2 py-0.5 rounded text-xs bg-slate-700 text-slate-400">{type}</span>
}

function fmtBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(1)} ${units[i]}`
}

function fmtUptime(secs) {
  if (!secs) return '—'
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  if (d > 0) return `${d}d ${h}h`
  return `${h}h`
}

function MiniBar({ pct, color = 'orange' }) {
  const colors = { orange: 'bg-orange-500', blue: 'bg-blue-500', green: 'bg-green-500' }
  const barColor = pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : colors[color]
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 bg-slate-700 rounded-full">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.min(pct || 0, 100)}%` }} />
      </div>
      <span className="text-xs text-slate-400">{pct ?? 0}%</span>
    </div>
  )
}

export default function IntegrationProxmox() {
  const navigate = useNavigate()
  const [dash, setDash] = useState(null)
  const [nodes, setNodes] = useState([])
  const [vms, setVms] = useState([])
  const [storage, setStorage] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('vms')
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const [d, n, v, s] = await Promise.all([
        integrationsApi.proxmox.dashboard(),
        integrationsApi.proxmox.nodes(),
        integrationsApi.proxmox.vms(),
        integrationsApi.proxmox.storage(),
      ])
      setDash(d.data)
      setNodes(n.data || [])
      setVms(v.data || [])
      setStorage(s.data || [])
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const filteredVms = vms.filter(vm => {
    if (typeFilter && vm.type !== typeFilter) return false
    if (statusFilter && vm.status !== statusFilter) return false
    if (search) {
      const q = search.toLowerCase()
      return (vm.name || '').toLowerCase().includes(q) || (vm.node_name || '').toLowerCase().includes(q)
    }
    return true
  })

  if (loading) return (
    <div className="p-8 text-slate-400 flex items-center gap-2">
      <RefreshCw className="w-4 h-4 animate-spin" />Loading Proxmox data...
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
          <Server className="w-6 h-6 text-orange-400" />
          <div>
            <h1 className="text-xl font-bold text-white">Proxmox VE</h1>
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
          Proxmox integration is not connected. Configure credentials in the Integrations hub.
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard title="Nodes" value={d.nodes?.total ?? 0} sub={`${d.nodes?.online ?? 0} online`} color="orange" icon={Server} />
        <StatCard title="VMs & Containers" value={d.vms?.total ?? 0} sub={`${d.vms?.running ?? 0} running`} color="blue" icon={Box} />
        <StatCard title="Storage Pools" value={d.storage?.total ?? 0} sub={`${d.storage?.usage_pct ?? 0}% used`} color={d.storage?.usage_pct >= 85 ? 'red' : 'slate'} icon={HardDrive} />
        <StatCard title="Total CPUs" value={d.nodes?.total_cpus ?? 0} color="slate" icon={Cpu} />
      </div>

      {/* VM type breakdown */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        {[
          { label: 'KVM VMs', count: d.vms?.vms ?? 0, color: 'text-orange-400' },
          { label: 'Containers', count: d.vms?.containers ?? 0, color: 'text-blue-400' },
          { label: 'Running', count: d.vms?.running ?? 0, color: 'text-green-400' },
          { label: 'Stopped', count: d.vms?.stopped ?? 0, color: 'text-slate-400' },
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
          { id: 'vms', label: `VMs & Containers (${vms.length})` },
          { id: 'nodes', label: `Nodes (${nodes.length})` },
          { id: 'storage', label: `Storage (${storage.length})` },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t.id ? 'bg-orange-600 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* VMs/Containers tab */}
      {tab === 'vms' && (
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-700 flex gap-3 flex-wrap">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                className="w-full pl-9 pr-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:border-orange-500"
                placeholder="Search..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <select
              className="px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none"
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value)}
            >
              <option value="">All Types</option>
              <option value="qemu">KVM VM</option>
              <option value="lxc">LXC Container</option>
            </select>
            <select
              className="px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none"
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
            >
              <option value="">All States</option>
              <option value="running">Running</option>
              <option value="stopped">Stopped</option>
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 text-xs">
                  <th className="text-left px-4 py-3">VMID</th>
                  <th className="text-left px-4 py-3">Name</th>
                  <th className="text-left px-4 py-3">Type</th>
                  <th className="text-left px-4 py-3">Status</th>
                  <th className="text-left px-4 py-3">Node</th>
                  <th className="text-left px-4 py-3">CPU</th>
                  <th className="text-left px-4 py-3">Memory</th>
                  <th className="text-left px-4 py-3">Uptime</th>
                </tr>
              </thead>
              <tbody>
                {filteredVms.map((vm, i) => (
                  <tr key={vm.vm_id || i} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                    <td className="px-4 py-3 text-slate-400 text-xs font-mono">{vm.vmid}</td>
                    <td className="px-4 py-3 font-medium text-white">{vm.name || `VM ${vm.vmid}`}</td>
                    <td className="px-4 py-3"><TypeBadge type={vm.type} /></td>
                    <td className="px-4 py-3"><StatusBadge status={vm.status} /></td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{vm.node_name}</td>
                    <td className="px-4 py-3 text-slate-300 text-xs">{vm.cpus} vCPU</td>
                    <td className="px-4 py-3 text-slate-300 text-xs">
                      {vm.status === 'running' ? (
                        <span>{fmtBytes(vm.mem)} / {fmtBytes(vm.maxmem)}</span>
                      ) : (
                        <span className="text-slate-500">{fmtBytes(vm.maxmem)}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{fmtUptime(vm.uptime_seconds)}</td>
                  </tr>
                ))}
                {filteredVms.length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-500">No VMs/containers found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Nodes tab */}
      {tab === 'nodes' && (
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 text-xs">
                  <th className="text-left px-4 py-3">Node</th>
                  <th className="text-left px-4 py-3">Status</th>
                  <th className="text-left px-4 py-3">CPUs</th>
                  <th className="text-left px-4 py-3">CPU Usage</th>
                  <th className="text-left px-4 py-3">Memory</th>
                  <th className="text-left px-4 py-3">Mem Usage</th>
                  <th className="text-left px-4 py-3">Disk Usage</th>
                  <th className="text-left px-4 py-3">Uptime</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((n, i) => (
                  <tr key={n.node_id || i} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                    <td className="px-4 py-3 font-medium text-white">{n.name}</td>
                    <td className="px-4 py-3"><StatusBadge status={n.status} /></td>
                    <td className="px-4 py-3 text-slate-300">{n.maxcpu}</td>
                    <td className="px-4 py-3"><MiniBar pct={n.cpu_usage_pct} color="orange" /></td>
                    <td className="px-4 py-3 text-slate-300 text-xs">{fmtBytes(n.maxmem)}</td>
                    <td className="px-4 py-3"><MiniBar pct={n.mem_usage_pct} color="blue" /></td>
                    <td className="px-4 py-3"><MiniBar pct={n.disk_usage_pct} color="green" /></td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{fmtUptime(n.uptime_seconds)}</td>
                  </tr>
                ))}
                {nodes.length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-500">No nodes found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Storage tab */}
      {tab === 'storage' && (
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 text-xs">
                  <th className="text-left px-4 py-3">Name</th>
                  <th className="text-left px-4 py-3">Node</th>
                  <th className="text-left px-4 py-3">Type</th>
                  <th className="text-left px-4 py-3">Total</th>
                  <th className="text-left px-4 py-3">Used</th>
                  <th className="text-left px-4 py-3 min-w-32">Usage</th>
                  <th className="text-left px-4 py-3">Shared</th>
                </tr>
              </thead>
              <tbody>
                {storage.map((s, i) => (
                  <tr key={s.stor_id || i} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                    <td className="px-4 py-3 font-medium text-white">{s.name}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{s.node_name}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{s.storage_type || '—'}</td>
                    <td className="px-4 py-3 text-slate-300 text-xs">{fmtBytes(s.total_bytes)}</td>
                    <td className="px-4 py-3 text-slate-300 text-xs">{fmtBytes(s.used_bytes)}</td>
                    <td className="px-4 py-3"><MiniBar pct={s.usage_pct} /></td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{s.shared ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
                {storage.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">No storage pools found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
