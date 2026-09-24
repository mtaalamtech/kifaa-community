import { useEffect, useState, useCallback } from 'react'
import { agentsApi, groupsApi } from '../api/client'
import api from '../api/client'
import { Link } from 'react-router-dom'
import {
  Search, Download, Terminal, RefreshCw, Power, RotateCcw,
  Server, Cpu, Monitor, Laptop, Network, Box,
  Plus, Pencil, Trash2, Users, ArrowUpCircle,
  Wifi, WifiOff, Activity, PowerOff, PlayCircle,
} from 'lucide-react'
import DeployModal from './DeployModal'
import { friendlyOS } from '../utils/osName'

// ── Asset Types ───────────────────────────────────────────────────────────────

const ASSET_TYPES = [
  { value: 'bare_metal_server',  label: 'Bare Metal Server',  Icon: Server  },
  { value: 'virtual_server',     label: 'Virtual Server',     Icon: Cpu     },
  { value: 'virtual_endpoint',   label: 'Virtual Endpoint',   Icon: Monitor },
  { value: 'physical_endpoint',  label: 'Physical Endpoint',  Icon: Laptop  },
  { value: 'network_device',     label: 'Network Device',     Icon: Network },
  { value: 'other',              label: 'Other',              Icon: Box     },
]

const ASSET_MAP = Object.fromEntries(ASSET_TYPES.map(a => [a.value, a]))

function AssetBadge({ assetType }) {
  if (!assetType) return <span className="text-slate-500">—</span>
  const t = ASSET_MAP[assetType]
  if (!t) return <span className="text-slate-400 text-xs">{assetType}</span>
  const { Icon, label } = t
  return (
    <span className="flex items-center gap-1 text-xs text-slate-300">
      <Icon size={12} className="text-slate-400" />
      {label}
    </span>
  )
}

function GroupBadge({ group_name, group_color }) {
  if (!group_name) return <span className="text-slate-500">—</span>
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border font-medium"
      style={{
        backgroundColor: (group_color || '#3B82F6') + '22',
        borderColor: (group_color || '#3B82F6') + '55',
        color: group_color || '#3B82F6',
      }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ backgroundColor: group_color || '#3B82F6' }}
      />
      {group_name}
    </span>
  )
}

// ── Status Badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const map = {
    online:  'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    offline: 'bg-slate-700 text-slate-400 border-slate-600',
    warning: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${map[status] || map.offline}`}>
      {status}
    </span>
  )
}

// ── Restart Modal ─────────────────────────────────────────────────────────────

function RestartModal({ agent, onClose, onConfirm }) {
  const [mode, setMode] = useState('announced')
  const [delay, setDelay] = useState(60)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-md p-6 shadow-xl">
        <h2 className="text-white font-semibold text-lg mb-1">Restart Machine</h2>
        <p className="text-slate-400 text-sm mb-5">
          Queue a restart command for <span className="text-white font-medium">{agent.hostname}</span>.
          The agent will execute it on the next heartbeat.
        </p>
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-slate-400 mb-2 font-medium uppercase tracking-wide">Mode</label>
            <div className="flex gap-3">
              <button
                onClick={() => setMode('announced')}
                className={`flex-1 py-2 px-3 rounded-lg border text-sm font-medium transition-colors ${
                  mode === 'announced'
                    ? 'bg-yellow-500/20 border-yellow-500/50 text-yellow-300'
                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500'
                }`}
              >
                Announced
              </button>
              <button
                onClick={() => setMode('silent')}
                className={`flex-1 py-2 px-3 rounded-lg border text-sm font-medium transition-colors ${
                  mode === 'silent'
                    ? 'bg-red-500/20 border-red-500/50 text-red-300'
                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500'
                }`}
              >
                Silent
              </button>
            </div>
            <p className="text-xs text-slate-500 mt-2">
              {mode === 'announced'
                ? 'Broadcasts a warning to logged-in users, then restarts after the delay.'
                : 'Restarts immediately without any warning to users.'}
            </p>
          </div>
          {mode === 'announced' && (
            <div>
              <label className="block text-xs text-slate-400 mb-1 font-medium uppercase tracking-wide">
                Delay (seconds)
              </label>
              <input
                type="number" min={30} max={3600} value={delay}
                onChange={e => setDelay(Number(e.target.value))}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-500"
              />
            </div>
          )}
        </div>
        <div className="flex gap-3 mt-6">
          <button onClick={onClose}
            className="flex-1 py-2 text-sm bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded-lg transition-colors">
            Cancel
          </button>
          <button
            onClick={() => onConfirm(mode, mode === 'announced' ? delay : 0)}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${
              mode === 'silent' ? 'bg-red-600 hover:bg-red-500 text-white' : 'bg-yellow-600 hover:bg-yellow-500 text-white'
            }`}
          >
            {mode === 'silent' ? 'Restart Now' : `Restart in ${delay}s`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Shutdown Confirm Modal ────────────────────────────────────────────────────

function ShutdownModal({ agent, onClose, onConfirm }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-slate-900 border border-red-800/60 rounded-xl w-full max-w-sm p-6 shadow-xl">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-red-600/20 flex items-center justify-center flex-shrink-0">
            <PowerOff size={18} className="text-red-400" />
          </div>
          <h2 className="text-white font-semibold text-lg">Shutdown Machine</h2>
        </div>
        <p className="text-slate-400 text-sm mb-6">
          This will immediately shut down <span className="text-white font-medium">{agent.hostname}</span>.
          All connected users will be disconnected. The machine will not restart automatically.
        </p>
        <div className="flex gap-3">
          <button onClick={onClose}
            className="flex-1 py-2 text-sm bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded-lg transition-colors">
            Cancel
          </button>
          <button onClick={onConfirm}
            className="flex-1 py-2 text-sm font-medium bg-red-700 hover:bg-red-600 text-white rounded-lg transition-colors">
            Shut Down Now
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Edit Agent Modal ──────────────────────────────────────────────────────────

function EditAgentModal({ agent, groups, onClose, onSaved }) {
  const [form, setForm] = useState({
    display_name: agent.display_name || '',
    description: agent.description || '',
    group_id: agent.group_id || '',
    asset_type: agent.asset_type || '',
    tags: (agent.tags || []).join(', '),
    exclude_from_reports: agent.exclude_from_reports || false,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    setSaving(true)
    setError('')
    try {
      const payload = {
        display_name: form.display_name || null,
        description: form.description || null,
        group_id: form.group_id || null,
        asset_type: form.asset_type || null,
        tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
        exclude_from_reports: form.exclude_from_reports,
      }
      await api.patch(`/agents/${agent.id}`, payload)
      onSaved()
      onClose()
    } catch (e) {
      setError(e.response?.data?.detail || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-md p-6 shadow-xl">
        <h2 className="text-white font-semibold text-lg mb-4">Edit Agent — {agent.hostname}</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium uppercase tracking-wide">Display Name</label>
            <input
              type="text" value={form.display_name}
              onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
              placeholder={agent.hostname}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium uppercase tracking-wide">Description / Function</label>
            <textarea
              rows={2} value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="e.g. Primary SAP application server, finance department"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium uppercase tracking-wide">Group</label>
            <select
              value={form.group_id}
              onChange={e => setForm(f => ({ ...f, group_id: e.target.value }))}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">None</option>
              {groups.map(g => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium uppercase tracking-wide">Asset Type</label>
            <select
              value={form.asset_type}
              onChange={e => setForm(f => ({ ...f, asset_type: e.target.value }))}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">None</option>
              {ASSET_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium uppercase tracking-wide">Tags (comma-separated)</label>
            <input
              type="text" value={form.tags}
              onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
              placeholder="production, webserver, critical"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
            form.exclude_from_reports ? 'bg-yellow-500/10 border-yellow-600/40' : 'bg-slate-800 border-slate-700'
          }`} onClick={() => setForm(f => ({ ...f, exclude_from_reports: !f.exclude_from_reports }))}>
            <input
              type="checkbox"
              checked={form.exclude_from_reports}
              onChange={() => {}}
              className="mt-0.5 w-4 h-4 rounded accent-yellow-500 cursor-pointer flex-shrink-0"
            />
            <div>
              <div className={`text-sm font-medium ${form.exclude_from_reports ? 'text-yellow-400' : 'text-slate-300'}`}>
                Exclude from all reports
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                This agent will be hidden from compliance scores, patch reports, and all exported reports.
              </div>
            </div>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
        <div className="flex gap-3 mt-6">
          <button onClick={onClose}
            className="flex-1 py-2 text-sm bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded-lg transition-colors">
            Cancel
          </button>
          <button onClick={save} disabled={saving}
            className="flex-1 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors">
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Group Modal ───────────────────────────────────────────────────────────────

const PRESET_COLORS = [
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444',
  '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16',
]

function GroupModal({ group, onClose, onSaved }) {
  const isEdit = !!group
  const [form, setForm] = useState({
    name: group?.name || '',
    description: group?.description || '',
    color: group?.color || '#3B82F6',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function save() {
    setSaving(true)
    setError('')
    try {
      if (isEdit) {
        await groupsApi.update(group.id, form)
      } else {
        await groupsApi.create(form)
      }
      onSaved()
      onClose()
    } catch (e) {
      setError(e.response?.data?.detail || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-md p-6 shadow-xl">
        <h2 className="text-white font-semibold text-lg mb-4">
          {isEdit ? 'Edit Group' : 'Create Group'}
        </h2>
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium uppercase tracking-wide">Name</label>
            <input
              type="text" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Production Servers"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium uppercase tracking-wide">Description</label>
            <input
              type="text" value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Optional description"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium uppercase tracking-wide">Color</label>
            <div className="flex gap-2 flex-wrap">
              {PRESET_COLORS.map(c => (
                <button
                  key={c}
                  onClick={() => setForm(f => ({ ...f, color: c }))}
                  className={`w-7 h-7 rounded-full border-2 transition-transform ${
                    form.color === c ? 'border-white scale-110' : 'border-transparent'
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
        <div className="flex gap-3 mt-6">
          <button onClick={onClose}
            className="flex-1 py-2 text-sm bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded-lg transition-colors">
            Cancel
          </button>
          <button onClick={save} disabled={saving || !form.name.trim()}
            className="flex-1 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors">
            {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Group'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Agents Tab ────────────────────────────────────────────────────────────────

function AgentsTab({ groups }) {
  const [agents, setAgents] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterOS, setFilterOS] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterGroup, setFilterGroup] = useState('')
  const [filterAsset, setFilterAsset] = useState('')
  const ALL_COLS = ['hostname','ip_address','os','version','description','group','asset_type','status','restart','last_seen','exclude_from_reports']
  const [visibleCols, setVisibleCols] = useState(new Set(['hostname','ip_address','os','version','description','group','asset_type','status','restart','last_seen','exclude_from_reports']))
  const [showColPicker, setShowColPicker] = useState(false)
  const [showDeploy, setShowDeploy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [updatingAll, setUpdatingAll] = useState(false)
  const [updateAllMsg, setUpdateAllMsg] = useState('')
  const [updating, setUpdating] = useState(new Set())
  const [updateMsg, setUpdateMsg] = useState({})
  const [restartAgent, setRestartAgent] = useState(null)
  const [restarting, setRestarting] = useState(new Set())
  const [restartMsg, setRestartMsg] = useState({})
  const [shutdownAgent, setShutdownAgent] = useState(null)
  const [shuttingDown, setShuttingDown] = useState(new Set())
  const [shutdownMsg, setShutdownMsg] = useState({})
  const [vmwareVMs, setVmwareVMs] = useState({}) // agentId → {found, vm_name, power_state}
  const [poweringOn, setPoweringOn] = useState(new Set())
  const [powerOnMsg, setPowerOnMsg] = useState({})
  const [editAgent, setEditAgent] = useState(null)
  const [togglingExclude, setTogglingExclude] = useState(new Set())

  const load = useCallback(() => {
    agentsApi.list().then(r => setAgents(r.data)).finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  async function syncAll() {
    setSyncing(true)
    setSyncMsg('')
    try {
      const r = await api.post('/agents/maintenance/sync-all')
      setSyncMsg(`Queued sync for ${r.data.queued} online agent(s)`)
      setTimeout(() => setSyncMsg(''), 6000)
    } catch {
      setSyncMsg('Sync failed')
      setTimeout(() => setSyncMsg(''), 4000)
    } finally {
      setSyncing(false)
    }
  }

  async function updateAll() {
    setUpdatingAll(true)
    setUpdateAllMsg('')
    try {
      const r = await api.post('/agents/maintenance/update-all')
      setUpdateAllMsg(`Update queued for ${r.data.count} online agent(s)`)
      setTimeout(() => setUpdateAllMsg(''), 7000)
    } catch {
      setUpdateAllMsg('Failed to queue updates')
      setTimeout(() => setUpdateAllMsg(''), 4000)
    } finally {
      setUpdatingAll(false)
    }
  }

  async function triggerUpdate(agentId) {
    setUpdating(s => new Set(s).add(agentId))
    try {
      await api.post(`/agents/${agentId}/trigger-update`)
      setUpdateMsg(m => ({ ...m, [agentId]: 'Queued — agent will update on next heartbeat' }))
      setTimeout(() => setUpdateMsg(m => { const n = {...m}; delete n[agentId]; return n }), 6000)
    } catch {
      setUpdateMsg(m => ({ ...m, [agentId]: 'Failed to queue update' }))
    } finally {
      setUpdating(s => { const n = new Set(s); n.delete(agentId); return n })
    }
  }

  async function confirmRestart(mode, delaySeconds) {
    const agentId = restartAgent.id
    setRestartAgent(null)
    setRestarting(s => new Set(s).add(agentId))
    try {
      await api.post(`/agents/${agentId}/restart`, { mode, delay_seconds: delaySeconds })
      const label = mode === 'silent' ? 'Silent restart queued' : `Announced restart queued (${delaySeconds}s)`
      setRestartMsg(m => ({ ...m, [agentId]: label }))
      setTimeout(() => setRestartMsg(m => { const n = {...m}; delete n[agentId]; return n }), 7000)
    } catch {
      setRestartMsg(m => ({ ...m, [agentId]: 'Failed to queue restart' }))
    } finally {
      setRestarting(s => { const n = new Set(s); n.delete(agentId); return n })
    }
  }

  async function confirmShutdown() {
    const agentId = shutdownAgent.id
    setShutdownAgent(null)
    setShuttingDown(s => new Set(s).add(agentId))
    try {
      await api.post(`/agents/${agentId}/shutdown`)
      setShutdownMsg(m => ({ ...m, [agentId]: 'Shutdown queued' }))
      setTimeout(() => setShutdownMsg(m => { const n = {...m}; delete n[agentId]; return n }), 7000)
    } catch {
      setShutdownMsg(m => ({ ...m, [agentId]: 'Failed' }))
    } finally {
      setShuttingDown(s => { const n = new Set(s); n.delete(agentId); return n })
    }
  }

  async function checkVmwareVM(agentId) {
    if (vmwareVMs[agentId] !== undefined) return
    try {
      const res = await api.get(`/integrations/vmware/agent-vm/${agentId}`)
      setVmwareVMs(m => ({ ...m, [agentId]: res.data }))
    } catch {
      setVmwareVMs(m => ({ ...m, [agentId]: { found: false } }))
    }
  }

  async function powerOnVM(agentId) {
    const vm = vmwareVMs[agentId]
    if (!vm?.found) return
    setPoweringOn(s => new Set(s).add(agentId))
    try {
      await api.post('/integrations/vmware/power-on', { vm_name: vm.vm_name })
      setPowerOnMsg(m => ({ ...m, [agentId]: 'Power on sent' }))
      setVmwareVMs(m => ({ ...m, [agentId]: { ...m[agentId], power_state: 'POWERED_ON' } }))
      setTimeout(() => setPowerOnMsg(m => { const n = {...m}; delete n[agentId]; return n }), 7000)
    } catch (e) {
      setPowerOnMsg(m => ({ ...m, [agentId]: e.response?.data?.detail || 'Failed' }))
    } finally {
      setPoweringOn(s => { const n = new Set(s); n.delete(agentId); return n })
    }
  }

  const filtered = agents.filter(a => {
    const matchSearch = !search ||
      a.hostname.toLowerCase().includes(search.toLowerCase()) ||
      (a.display_name || '').toLowerCase().includes(search.toLowerCase()) ||
      (a.description || '').toLowerCase().includes(search.toLowerCase()) ||
      (a.ip_address || '').includes(search)
    const matchOS = !filterOS || a.os_type === filterOS
    const matchStatus = !filterStatus || a.status === filterStatus
    const matchGroup = !filterGroup || a.group_id === filterGroup
    const matchAsset = !filterAsset || a.asset_type === filterAsset
    return matchSearch && matchOS && matchStatus && matchGroup && matchAsset
  })

  function toggleCol(col) {
    setVisibleCols(prev => {
      const next = new Set(prev)
      if (next.has(col)) { if (next.size > 1) next.delete(col) }
      else next.add(col)
      return next
    })
  }

  async function toggleExclude(agent) {
    const newVal = !agent.exclude_from_reports
    setTogglingExclude(s => new Set(s).add(agent.id))
    // Optimistic update
    setAgents(prev => prev.map(a => a.id === agent.id ? { ...a, exclude_from_reports: newVal } : a))
    try {
      await api.patch(`/agents/${agent.id}`, { exclude_from_reports: newVal })
    } catch {
      // Revert on failure
      setAgents(prev => prev.map(a => a.id === agent.id ? { ...a, exclude_from_reports: !newVal } : a))
    } finally {
      setTogglingExclude(s => { const n = new Set(s); n.delete(agent.id); return n })
    }
  }

  const COL_LABELS = {
    hostname: 'Hostname', ip_address: 'IP Address', os: 'OS',
    version: 'Agent Version',
    description: 'Description / Function',
    group: 'Group', asset_type: 'Asset Type', status: 'Status',
    restart: 'Restart', last_seen: 'Last Seen',
    exclude_from_reports: 'Exclude from Reports',
  }

  // Status counts for widgets
  const totalAgents  = agents.length
  const onlineCount  = agents.filter(a => a.status === 'online').length
  const offlineCount = agents.filter(a => a.status === 'offline').length
  const availability = totalAgents > 0 ? Math.round((onlineCount / totalAgents) * 100) : 0

  // Compute the latest version seen across all agents for badge coloring
  const latestVersion = agents.reduce((best, a) => {
    if (!a.agent_version) return best
    if (!best) return a.agent_version
    return a.agent_version.localeCompare(best, undefined, { numeric: true }) > 0
      ? a.agent_version : best
  }, null)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <p className="text-sm text-slate-400 mt-0.5">{agents.length} registered endpoints</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {syncMsg && (
            <span className="text-xs text-slate-300 bg-slate-700 border border-slate-600 px-3 py-1 rounded-lg">{syncMsg}</span>
          )}
          {updateAllMsg && (
            <span className="text-xs text-emerald-300 bg-emerald-900/30 border border-emerald-700/40 px-3 py-1 rounded-lg">{updateAllMsg}</span>
          )}
          <button
            onClick={syncAll}
            disabled={syncing}
            title="Queue inventory sync for all online agents"
            className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-white text-sm px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} /> Sync All
          </button>
          <button
            onClick={updateAll}
            disabled={updatingAll}
            title="Push the latest agent binary to all online agents"
            className="flex items-center gap-2 bg-slate-700 hover:bg-emerald-900/40 border border-slate-600 hover:border-emerald-700/60 text-white text-sm px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
          >
            <ArrowUpCircle size={16} className={updatingAll ? 'animate-pulse' : ''} /> Update All
          </button>
          <button
            onClick={() => setShowDeploy(true)}
            className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-white text-sm px-4 py-2 rounded-lg transition-colors"
          >
            <Terminal size={16} /> Deploy Agent
          </button>
          <Link
            to="/downloads"
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-lg transition-colors"
          >
            <Download size={16} /> Download Agent
          </Link>
        </div>
      </div>

      {/* Status Widgets */}
      {!loading && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          {/* Total */}
          <button
            onClick={() => setFilterStatus('')}
            className={`text-left p-4 rounded-xl border transition-all ${
              filterStatus === ''
                ? 'bg-blue-600/20 border-blue-500/60 ring-1 ring-blue-500/40'
                : 'bg-slate-900 border-slate-700 hover:border-slate-500'
            }`}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium text-slate-400 uppercase tracking-wide">Total Agents</span>
              <div className="w-8 h-8 rounded-lg bg-blue-600/20 flex items-center justify-center">
                <Activity size={16} className="text-blue-400" />
              </div>
            </div>
            <div className="text-3xl font-bold text-white mb-1">{totalAgents}</div>
            <div className="text-xs text-slate-400">{availability}% availability</div>
          </button>

          {/* Online */}
          <button
            onClick={() => setFilterStatus(filterStatus === 'online' ? '' : 'online')}
            className={`text-left p-4 rounded-xl border transition-all ${
              filterStatus === 'online'
                ? 'bg-emerald-600/20 border-emerald-500/60 ring-1 ring-emerald-500/40'
                : 'bg-slate-900 border-slate-700 hover:border-emerald-700/60'
            }`}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium text-slate-400 uppercase tracking-wide">Online</span>
              <div className="w-8 h-8 rounded-lg bg-emerald-600/20 flex items-center justify-center">
                <Wifi size={16} className="text-emerald-400" />
              </div>
            </div>
            <div className="text-3xl font-bold text-emerald-400 mb-1">{onlineCount}</div>
            <div className="text-xs text-slate-400">
              {totalAgents > 0 ? Math.round((onlineCount / totalAgents) * 100) : 0}% of fleet
            </div>
          </button>

          {/* Offline */}
          <button
            onClick={() => setFilterStatus(filterStatus === 'offline' ? '' : 'offline')}
            className={`text-left p-4 rounded-xl border transition-all ${
              filterStatus === 'offline'
                ? 'bg-red-600/20 border-red-500/60 ring-1 ring-red-500/40'
                : 'bg-slate-900 border-slate-700 hover:border-red-700/60'
            }`}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium text-slate-400 uppercase tracking-wide">Offline</span>
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                offlineCount > 0 ? 'bg-red-600/20' : 'bg-slate-700/50'
              }`}>
                <WifiOff size={16} className={offlineCount > 0 ? 'text-red-400' : 'text-slate-500'} />
              </div>
            </div>
            <div className={`text-3xl font-bold mb-1 ${offlineCount > 0 ? 'text-red-400' : 'text-slate-400'}`}>
              {offlineCount}
            </div>
            <div className="text-xs text-slate-400">
              {offlineCount > 0 ? `${Math.round((offlineCount / totalAgents) * 100)}% of fleet` : 'All systems online'}
            </div>
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text" placeholder="Search hostname, IP or description..."
            value={search} onChange={e => setSearch(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-9 pr-4 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select value={filterOS} onChange={e => setFilterOS(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
          <option value="">All OS</option>
          <option value="windows">Windows</option>
          <option value="linux">Linux</option>
          <option value="macos">macOS</option>
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
          <option value="">All Status</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="warning">Warning</option>
        </select>
        <select value={filterGroup} onChange={e => setFilterGroup(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
          <option value="">All Groups</option>
          {groups.map(g => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        <select value={filterAsset} onChange={e => setFilterAsset(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
          <option value="">All Asset Types</option>
          {ASSET_TYPES.map(t => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>

        {/* Column visibility picker */}
        <div className="relative">
          <button
            onClick={() => setShowColPicker(v => !v)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-slate-800 border border-slate-700 rounded-lg text-slate-300 hover:text-white hover:border-slate-500 transition-colors whitespace-nowrap"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>
            Columns
          </button>
          {showColPicker && (
            <div className="absolute right-0 top-full mt-1 z-20 bg-slate-800 border border-slate-700 rounded-xl shadow-xl p-3 min-w-[160px]">
              <div className="text-xs text-slate-400 font-medium mb-2 px-1">Toggle columns</div>
              {ALL_COLS.map(col => (
                <label key={col} className="flex items-center gap-2 px-1 py-1 rounded hover:bg-slate-700 cursor-pointer text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={visibleCols.has(col)}
                    onChange={() => toggleCol(col)}
                    className="accent-blue-500"
                  />
                  {COL_LABELS[col]}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-700 bg-slate-800/50">
                {ALL_COLS.filter(c => visibleCols.has(c)).map(col => (
                  <th key={col} className="px-5 py-3 font-medium whitespace-nowrap">{COL_LABELS[col]}</th>
                ))}
                <th className="px-5 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(agent => (
                <tr key={agent.id} className="border-b border-slate-800 hover:bg-slate-800/40 transition-colors">
                  {visibleCols.has('hostname') && (
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <Link to={`/agents/${agent.id}`} className="text-blue-400 hover:text-blue-300 font-medium">
                          {agent.hostname}
                        </Link>
                        {agent.exclude_from_reports && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-500 border border-yellow-600/30" title="Excluded from all reports">
                            excl.
                          </span>
                        )}
                      </div>
                      {agent.display_name && agent.display_name !== agent.hostname && (
                        <div className="text-xs text-slate-500">{agent.display_name}</div>
                      )}
                    </td>
                  )}
                  {visibleCols.has('ip_address') && (
                    <td className="px-5 py-3 text-slate-300 font-mono text-xs">{agent.ip_address || '—'}</td>
                  )}
                  {visibleCols.has('os') && (
                    <td className="px-5 py-3 text-slate-300">{friendlyOS(agent.os_name, agent.os_version)}</td>
                  )}
                  {visibleCols.has('version') && (
                    <td className="px-5 py-3">
                      {agent.agent_version ? (
                        <span className={`inline-flex items-center font-mono text-xs px-2 py-0.5 rounded-full border ${
                          agent.agent_version === latestVersion
                            ? 'bg-emerald-500/15 text-emerald-400 border-emerald-600/40'
                            : 'bg-amber-500/15 text-amber-400 border-amber-600/40'
                        }`}>
                          v{agent.agent_version}
                        </span>
                      ) : (
                        <span className="text-slate-600 text-xs">—</span>
                      )}
                    </td>
                  )}
                  {visibleCols.has('description') && (
                    <td className="px-5 py-3 text-slate-400 text-xs max-w-[200px]">
                      {agent.description
                        ? <span title={agent.description} className="line-clamp-2">{agent.description}</span>
                        : <button onClick={() => setEditAgent(agent)} className="text-slate-600 hover:text-slate-400 italic transition-colors">Add description…</button>
                      }
                    </td>
                  )}
                  {visibleCols.has('group') && (
                    <td className="px-5 py-3">
                      <button onClick={() => setEditAgent(agent)} className="hover:opacity-80 transition-opacity" title="Edit agent">
                        <GroupBadge group_name={agent.group_name} group_color={agent.group_color} />
                      </button>
                    </td>
                  )}
                  {visibleCols.has('asset_type') && (
                    <td className="px-5 py-3">
                      <button onClick={() => setEditAgent(agent)} className="hover:opacity-80 transition-opacity" title="Edit agent">
                        <AssetBadge assetType={agent.asset_type} />
                      </button>
                    </td>
                  )}
                  {visibleCols.has('status') && (
                    <td className="px-5 py-3"><StatusBadge status={agent.status} /></td>
                  )}
                  {visibleCols.has('restart') && (
                    <td className="px-5 py-3 text-center">
                      {agent.restart_pending
                        ? <span className="inline-flex items-center gap-1 text-xs text-amber-400 bg-amber-500/15 border border-amber-700/40 rounded-full px-2 py-0.5">
                            <RotateCcw size={10} /> Restart
                          </span>
                        : <span className="text-slate-700">—</span>}
                    </td>
                  )}
                  {visibleCols.has('last_seen') && (
                    <td className="px-5 py-3 text-slate-400 text-xs">
                      {agent.last_seen ? new Date(agent.last_seen).toLocaleString() : 'Never'}
                    </td>
                  )}
                  {visibleCols.has('exclude_from_reports') && (
                    <td className="px-5 py-3 text-center">
                      <label className="inline-flex items-center cursor-pointer" title={agent.exclude_from_reports ? 'Excluded from all reports — click to include' : 'Click to exclude from all reports'}>
                        <input
                          type="checkbox"
                          checked={!!agent.exclude_from_reports}
                          disabled={togglingExclude.has(agent.id)}
                          onChange={() => toggleExclude(agent)}
                          className="w-4 h-4 rounded accent-yellow-500 cursor-pointer disabled:opacity-50"
                        />
                      </label>
                    </td>
                  )}
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setEditAgent(agent)}
                        className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 rounded-lg transition-colors"
                        title="Edit agent"
                      >
                        <Pencil size={11} />
                      </button>
                      {restartMsg[agent.id] ? (
                        <span className="text-xs text-yellow-400">{restartMsg[agent.id]}</span>
                      ) : (
                        <button
                          onClick={() => setRestartAgent(agent)}
                          disabled={restarting.has(agent.id) || agent.status !== 'online'}
                          title={agent.status !== 'online' ? 'Agent must be online to restart' : 'Restart machine'}
                          className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-slate-700 hover:bg-yellow-900/40 disabled:opacity-30 border border-slate-600 hover:border-yellow-700 text-slate-300 rounded-lg transition-colors"
                        >
                          <Power size={11} />
                          Restart
                        </button>
                      )}
                      {shutdownMsg[agent.id] ? (
                        <span className="text-xs text-red-400">{shutdownMsg[agent.id]}</span>
                      ) : (
                        <button
                          onClick={() => setShutdownAgent(agent)}
                          disabled={shuttingDown.has(agent.id) || agent.status !== 'online'}
                          title={agent.status !== 'online' ? 'Agent must be online to shut down' : 'Shut down machine'}
                          className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-slate-700 hover:bg-red-900/40 disabled:opacity-30 border border-slate-600 hover:border-red-700 text-slate-300 rounded-lg transition-colors"
                        >
                          <PowerOff size={11} />
                          Shutdown
                        </button>
                      )}
                      {agent.status === 'offline' && (() => {
                        const vm = vmwareVMs[agent.id]
                        if (vm === undefined) {
                          checkVmwareVM(agent.id)
                          return null
                        }
                        if (!vm.found) return null
                        return powerOnMsg[agent.id] ? (
                          <span className="text-xs text-green-400">{powerOnMsg[agent.id]}</span>
                        ) : (
                          <button
                            onClick={() => powerOnVM(agent.id)}
                            disabled={poweringOn.has(agent.id)}
                            title={`Power on VM: ${vm.vm_name}`}
                            className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-green-900/30 hover:bg-green-800/50 disabled:opacity-30 border border-green-800/60 hover:border-green-600 text-green-400 rounded-lg transition-colors"
                          >
                            <PlayCircle size={11} className={poweringOn.has(agent.id) ? 'animate-spin' : ''} />
                            Start
                          </button>
                        )
                      })()}
                      {updateMsg[agent.id] ? (
                        <span className="text-xs text-green-400">{updateMsg[agent.id]}</span>
                      ) : (
                        <button
                          onClick={() => triggerUpdate(agent.id)}
                          disabled={updating.has(agent.id) || agent.status !== 'online'}
                          title={agent.status !== 'online' ? 'Agent must be online to update' : 'Push update to agent'}
                          className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 disabled:opacity-30 border border-slate-600 text-slate-300 rounded-lg transition-colors"
                        >
                          <RefreshCw size={11} className={updating.has(agent.id) ? 'animate-spin' : ''} />
                          Update
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center text-slate-500">
                    {agents.length === 0 ? 'No agents registered yet.' : 'No agents match your filters.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {showDeploy && <DeployModal onClose={() => setShowDeploy(false)} />}
      {restartAgent && (
        <RestartModal
          agent={restartAgent}
          onClose={() => setRestartAgent(null)}
          onConfirm={confirmRestart}
        />
      )}
      {shutdownAgent && (
        <ShutdownModal
          agent={shutdownAgent}
          onClose={() => setShutdownAgent(null)}
          onConfirm={confirmShutdown}
        />
      )}
      {editAgent && (
        <EditAgentModal
          agent={editAgent}
          groups={groups}
          onClose={() => setEditAgent(null)}
          onSaved={() => { setEditAgent(null); load() }}
        />
      )}
    </div>
  )
}

// ── Manage Members Modal ──────────────────────────────────────────────────────

function ManageMembersModal({ group, onClose, onSaved }) {
  const [allAgents, setAllAgents] = useState([])
  const [selected, setSelected] = useState(new Set())
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      try {
        const [agentsRes, membersRes] = await Promise.all([
          agentsApi.list(),
          groupsApi.agents(group.id),
        ])
        setAllAgents(agentsRes.data || [])
        setSelected(new Set((membersRes.data || []).map(a => a.id)))
      } catch {
        setError('Failed to load agents')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [group.id])

  const filtered = allAgents.filter(a => {
    if (!search) return true
    const q = search.toLowerCase()
    return (a.hostname || '').toLowerCase().includes(q) ||
      (a.display_name || '').toLowerCase().includes(q) ||
      (a.ip_address || '').toLowerCase().includes(q)
  })

  function toggle(id) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleAll() {
    const visibleIds = filtered.map(a => a.id)
    const allSelected = visibleIds.every(id => selected.has(id))
    setSelected(prev => {
      const next = new Set(prev)
      if (allSelected) visibleIds.forEach(id => next.delete(id))
      else visibleIds.forEach(id => next.add(id))
      return next
    })
  }

  async function save() {
    setSaving(true)
    setError('')
    try {
      await groupsApi.setMembers(group.id, [...selected])
      onSaved()
      onClose()
    } catch (e) {
      setError(e.response?.data?.detail || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const visibleIds = filtered.map(a => a.id)
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selected.has(id))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-lg shadow-xl flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center gap-3 p-5 border-b border-slate-700">
          <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: group.color || '#3B82F6' }} />
          <div>
            <h2 className="text-white font-semibold">Manage Endpoints</h2>
            <p className="text-slate-400 text-xs">{group.name} · {selected.size} selected</p>
          </div>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-white text-xl leading-none">×</button>
        </div>

        {/* Search */}
        <div className="p-4 border-b border-slate-800">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search hostname, IP..."
              className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Agent list */}
        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="flex justify-center py-10">
              <div className="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full" />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-800/90 backdrop-blur">
                <tr className="text-left text-xs text-slate-400 border-b border-slate-700">
                  <th className="px-4 py-2.5 w-8">
                    <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll}
                      className="w-4 h-4 rounded accent-blue-500 cursor-pointer" />
                  </th>
                  <th className="px-4 py-2.5">Hostname</th>
                  <th className="px-4 py-2.5">IP</th>
                  <th className="px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(agent => (
                  <tr
                    key={agent.id}
                    onClick={() => toggle(agent.id)}
                    className={`border-b border-slate-800 cursor-pointer transition-colors ${
                      selected.has(agent.id) ? 'bg-blue-900/20 hover:bg-blue-900/30' : 'hover:bg-slate-800/50'
                    }`}
                  >
                    <td className="px-4 py-2.5">
                      <input type="checkbox" checked={selected.has(agent.id)} onChange={() => toggle(agent.id)}
                        onClick={e => e.stopPropagation()}
                        className="w-4 h-4 rounded accent-blue-500 cursor-pointer" />
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-white text-xs">{agent.hostname}</div>
                      {agent.display_name && agent.display_name !== agent.hostname && (
                        <div className="text-slate-500 text-xs">{agent.display_name}</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-slate-400 font-mono text-xs">{agent.ip_address || '—'}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full ${
                        agent.status === 'online'
                          ? 'bg-green-900/40 text-green-400'
                          : 'bg-slate-700 text-slate-400'
                      }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${agent.status === 'online' ? 'bg-green-400' : 'bg-slate-500'}`} />
                        {agent.status}
                      </span>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-500">No agents found</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-700 flex items-center gap-3">
          {error && <p className="text-xs text-red-400 flex-1">{error}</p>}
          {!error && <span className="text-xs text-slate-500 flex-1">{selected.size} endpoint{selected.size !== 1 ? 's' : ''} will be in this group</span>}
          <button onClick={onClose}
            className="px-4 py-2 text-sm bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded-lg transition-colors">
            Cancel
          </button>
          <button onClick={save} disabled={saving}
            className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors">
            {saving ? 'Saving...' : 'Save Members'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Groups Tab ────────────────────────────────────────────────────────────────

function GroupsTab({ groups, onGroupsChanged }) {
  const [showCreate, setShowCreate] = useState(false)
  const [editGroup, setEditGroup] = useState(null)
  const [manageGroup, setManageGroup] = useState(null)
  const [deleting, setDeleting] = useState(null)

  async function deleteGroup(id) {
    if (!confirm('Delete this group? Agents will be unassigned.')) return
    setDeleting(id)
    try {
      await groupsApi.delete(id)
      onGroupsChanged()
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <p className="text-sm text-slate-400">{groups.length} group{groups.length !== 1 ? 's' : ''}</p>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-lg transition-colors"
        >
          <Plus size={16} /> New Group
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="text-center py-20 bg-slate-900 border border-slate-700 rounded-xl">
          <Users size={44} className="mx-auto mb-3 text-slate-600" />
          <p className="text-slate-300 font-medium">No groups yet</p>
          <p className="text-slate-500 text-sm mt-1">Create groups to organise your agents</p>
          <button onClick={() => setShowCreate(true)}
            className="mt-5 flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors mx-auto">
            <Plus size={14} /> Create first group
          </button>
        </div>
      ) : (
        <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-700 bg-slate-800/50">
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Description</th>
                <th className="px-5 py-3 font-medium text-center">Members</th>
                <th className="px-5 py-3 font-medium text-center">Monitors</th>
                <th className="px-5 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(g => (
                <tr key={g.id} className="border-b border-slate-800 hover:bg-slate-800/40 transition-colors">
                  <td className="px-5 py-3">
                    <span className="flex items-center gap-2">
                      <span
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: g.color || '#3B82F6' }}
                      />
                      <span className="font-medium text-white">{g.name}</span>
                    </span>
                  </td>
                  <td className="px-5 py-3 text-slate-400">{g.description || '—'}</td>
                  <td className="px-5 py-3 text-center">
                    <span className="text-slate-300 font-medium">{g.agent_count}</span>
                  </td>
                  <td className="px-5 py-3 text-center">
                    <span className="text-slate-300 font-medium">{g.monitor_count}</span>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setManageGroup(g)}
                        className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-blue-700/30 hover:bg-blue-700/50 border border-blue-700/50 text-blue-300 rounded-lg transition-colors"
                        title="Add / remove endpoints"
                      >
                        <Users size={11} /> Endpoints
                      </button>
                      <button
                        onClick={() => setEditGroup(g)}
                        className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 rounded-lg transition-colors"
                      >
                        <Pencil size={11} /> Edit
                      </button>
                      <button
                        onClick={() => deleteGroup(g.id)}
                        disabled={deleting === g.id}
                        className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-slate-700 hover:bg-red-900/40 disabled:opacity-30 border border-slate-600 hover:border-red-700 text-slate-300 rounded-lg transition-colors"
                      >
                        <Trash2 size={11} /> Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <GroupModal
          group={null}
          onClose={() => setShowCreate(false)}
          onSaved={() => { setShowCreate(false); onGroupsChanged() }}
        />
      )}
      {editGroup && (
        <GroupModal
          group={editGroup}
          onClose={() => setEditGroup(null)}
          onSaved={() => { setEditGroup(null); onGroupsChanged() }}
        />
      )}
      {manageGroup && (
        <ManageMembersModal
          group={manageGroup}
          onClose={() => setManageGroup(null)}
          onSaved={() => { setManageGroup(null); onGroupsChanged() }}
        />
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Agents() {
  const [activeTab, setActiveTab] = useState('agents')
  const [groups, setGroups] = useState([])

  const loadGroups = useCallback(() => {
    groupsApi.list().then(r => setGroups(r.data)).catch(() => {})
  }, [])

  useEffect(() => { loadGroups() }, [loadGroups])

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Agents</h1>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-slate-800 rounded-lg p-1 w-fit border border-slate-700">
        {[
          { key: 'agents', label: 'Agents' },
          { key: 'groups', label: 'Groups' },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-1.5 text-sm rounded-md font-medium transition-colors ${
              activeTab === tab.key
                ? 'bg-slate-700 text-white'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'agents' && <AgentsTab groups={groups} />}
      {activeTab === 'groups' && (
        <GroupsTab
          groups={groups}
          onGroupsChanged={loadGroups}
        />
      )}
    </div>
  )
}
