import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Zap, ArrowLeft, RefreshCw, CheckCircle, XCircle,
  AlertTriangle, Battery, Activity, Thermometer, Clock,
  Plus, Pencil, Trash2, X, Shield, PowerOff, ChevronUp,
  ChevronDown, AlertOctagon, Timer, Settings2
} from 'lucide-react'
import { integrationsApi, agentsApi } from '../api/client'

function runtime(secs) {
  if (!secs && secs !== 0) return '—'
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
}

function StatusBadge({ status }) {
  const map = {
    online:        { cls: 'bg-green-900/40 text-green-300 border-green-700',   label: 'Online' },
    on_battery:    { cls: 'bg-yellow-900/40 text-yellow-300 border-yellow-700', label: 'On Battery' },
    low_battery:   { cls: 'bg-red-900/40 text-red-300 border-red-700',         label: 'Low Battery' },
    on_bypass:     { cls: 'bg-orange-900/40 text-orange-300 border-orange-700', label: 'On Bypass' },
    on_smart_boost:{ cls: 'bg-blue-900/40 text-blue-300 border-blue-700',      label: 'Smart Boost' },
    on_smart_trim: { cls: 'bg-purple-900/40 text-purple-300 border-purple-700', label: 'Smart Trim' },
    offline:       { cls: 'bg-slate-800 text-slate-400 border-slate-600',      label: 'Offline' },
    unknown:       { cls: 'bg-slate-800 text-slate-400 border-slate-600',      label: 'Unknown' },
  }
  const s = map[status] || map.unknown
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${s.cls}`}>
      {s.label}
    </span>
  )
}

function BatteryBar({ pct }) {
  if (pct == null) return <span className="text-slate-500">—</span>
  const color = pct > 50 ? 'bg-green-500' : pct > 20 ? 'bg-yellow-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-2 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm text-white">{pct}%</span>
    </div>
  )
}

function LoadBar({ pct }) {
  if (pct == null) return <span className="text-slate-500">—</span>
  const color = pct > 80 ? 'bg-red-500' : pct > 60 ? 'bg-yellow-500' : 'bg-blue-500'
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-2 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm text-white">{pct}%</span>
    </div>
  )
}

const EMPTY_FORM = { name: '', host: '', snmp_community: 'public', snmp_version: '2c' }

function DeviceModal({ device, onClose, onSaved }) {
  const [form, setForm] = useState(device
    ? { name: device.name, host: device.host, snmp_community: device.snmp_community || 'public', snmp_version: device.snmp_version || '2c' }
    : { ...EMPTY_FORM }
  )
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const handleSave = async () => {
    if (!form.name.trim() || !form.host.trim()) { setErr('Name and host are required'); return }
    setSaving(true); setErr(null)
    try {
      if (device) {
        await integrationsApi.apcUps.updateDevice(device.id, form)
      } else {
        await integrationsApi.apcUps.createDevice(form)
      }
      onSaved()
      onClose()
    } catch (e) {
      setErr(e.response?.data?.detail || e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-md">
        <div className="flex items-center gap-3 p-5 border-b border-slate-700">
          <Zap size={18} className="text-yellow-400" />
          <h2 className="font-semibold text-white">{device ? 'Edit UPS Device' : 'Add UPS Device'}</h2>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-white"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          {err && <div className="text-red-400 text-sm bg-red-900/20 border border-red-700 rounded px-3 py-2">{err}</div>}
          {[
            { key: 'name',           label: 'Display Name',    placeholder: 'Server Room UPS' },
            { key: 'host',           label: 'Host / IP',        placeholder: '192.168.0.224' },
            { key: 'snmp_community', label: 'SNMP Community',   placeholder: 'public' },
          ].map(({ key, label, placeholder }) => (
            <div key={key}>
              <label className="block text-xs text-slate-400 mb-1">{label}</label>
              <input
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-yellow-500"
                value={form[key]}
                placeholder={placeholder}
                onChange={e => f(key, e.target.value)}
              />
            </div>
          ))}
          <div>
            <label className="block text-xs text-slate-400 mb-1">SNMP Version</label>
            <select
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-yellow-500"
              value={form.snmp_version}
              onChange={e => f('snmp_version', e.target.value)}
            >
              <option value="1">v1</option>
              <option value="2c">v2c</option>
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-3 p-5 border-t border-slate-700">
          <button onClick={onClose} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg">Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-yellow-600 hover:bg-yellow-700 text-white text-sm rounded-lg disabled:opacity-50"
          >
            {saving ? 'Saving…' : device ? 'Save Changes' : 'Add Device'}
          </button>
        </div>
      </div>
    </div>
  )
}

function PolicyModal({ devices, policy, onClose, onSaved }) {
  const isEdit = !!policy
  const [form, setForm] = useState({
    name: policy?.name || '',
    device_id: policy?.device_id || (devices[0]?.id || ''),
    is_active: policy?.is_active ?? true,
    trigger_runtime_seconds: policy ? Math.floor(policy.trigger_runtime_seconds / 60) : 10,
    trigger_battery_pct: policy?.trigger_battery_pct ?? 20,
    trigger_mode: policy?.trigger_mode || 'any',
    cancel_window_seconds: policy ? Math.floor(policy.cancel_window_seconds / 60) : 2,
    delay_between_agents_seconds: policy?.delay_between_agents_seconds ?? 30,
    notify_bot: policy?.notify_bot ?? true,
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const handleSave = async () => {
    if (!form.name.trim() || !form.device_id) { setErr('Name and UPS device are required'); return }
    setSaving(true); setErr(null)
    try {
      const payload = {
        ...form,
        trigger_runtime_seconds: parseInt(form.trigger_runtime_seconds) * 60,
        trigger_battery_pct: parseInt(form.trigger_battery_pct),
        cancel_window_seconds: parseInt(form.cancel_window_seconds) * 60,
        delay_between_agents_seconds: parseInt(form.delay_between_agents_seconds),
      }
      if (isEdit) {
        await integrationsApi.apcUps.updateShutdownPolicy(policy.id, payload)
      } else {
        await integrationsApi.apcUps.createShutdownPolicy(payload)
      }
      onSaved()
    } catch (e) {
      setErr(e.response?.data?.detail || e.message)
      setSaving(false)
    }
  }

  const upsStatusMap = {
    online: 'bg-green-900/40 text-green-300 border-green-700',
    on_battery: 'bg-yellow-900/40 text-yellow-300 border-yellow-700',
    low_battery: 'bg-red-900/40 text-red-300 border-red-700',
    offline: 'bg-slate-800 text-slate-400 border-slate-600',
    unknown: 'bg-slate-800 text-slate-400 border-slate-600',
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center gap-3 p-5 border-b border-slate-700 sticky top-0 bg-slate-800 z-10">
          <PowerOff size={18} className="text-red-400" />
          <h2 className="font-semibold text-white">{isEdit ? 'Edit Shutdown Policy' : 'New Shutdown Policy'}</h2>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-white"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-5">
          {err && <div className="text-red-400 text-sm bg-red-900/20 border border-red-700 rounded px-3 py-2">{err}</div>}

          <div>
            <label className="block text-xs text-slate-400 mb-1">Policy Name</label>
            <input
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-red-500"
              value={form.name}
              placeholder="Server Room Shutdown Policy"
              onChange={e => f('name', e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1">UPS Device</label>
            <select
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
              value={form.device_id}
              onChange={e => f('device_id', e.target.value)}
            >
              {devices.map(d => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.host}) — {d.status}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-2">Trigger Mode</label>
            <div className="space-y-2">
              {[
                { value: 'any', label: 'Either threshold (any)', desc: 'Trigger if runtime OR battery is low' },
                { value: 'all', label: 'Both thresholds (all)', desc: 'Trigger only if BOTH runtime AND battery are low' },
              ].map(opt => (
                <label key={opt.value} className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="radio"
                    name="trigger_mode"
                    value={opt.value}
                    checked={form.trigger_mode === opt.value}
                    onChange={() => f('trigger_mode', opt.value)}
                    className="mt-0.5 accent-red-500"
                  />
                  <div>
                    <div className="text-sm text-white">{opt.label}</div>
                    <div className="text-xs text-slate-400">{opt.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Runtime Threshold (minutes)</label>
              <input
                type="number"
                min="1"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
                value={form.trigger_runtime_seconds}
                onChange={e => f('trigger_runtime_seconds', e.target.value)}
              />
              <p className="text-xs text-slate-500 mt-1">Trigger when runtime falls below this</p>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Battery Threshold (%)</label>
              <input
                type="number"
                min="1"
                max="100"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
                value={form.trigger_battery_pct}
                onChange={e => f('trigger_battery_pct', e.target.value)}
              />
              <p className="text-xs text-slate-500 mt-1">Trigger when battery falls below this</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Cancel Window (minutes)</label>
              <input
                type="number"
                min="1"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
                value={form.cancel_window_seconds}
                onChange={e => f('cancel_window_seconds', e.target.value)}
              />
              <p className="text-xs text-slate-500 mt-1">Time to cancel before shutdown executes</p>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Delay Between Servers (seconds)</label>
              <input
                type="number"
                min="0"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
                value={form.delay_between_agents_seconds}
                onChange={e => f('delay_between_agents_seconds', e.target.value)}
              />
              <p className="text-xs text-slate-500 mt-1">Wait between each server shutdown</p>
            </div>
          </div>

          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.notify_bot}
                onChange={e => f('notify_bot', e.target.checked)}
                className="accent-red-500"
              />
              <span className="text-sm text-slate-300">Notify via bot</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={e => f('is_active', e.target.checked)}
                className="accent-red-500"
              />
              <span className="text-sm text-slate-300">Policy active</span>
            </label>
          </div>
        </div>
        <div className="flex justify-end gap-3 p-5 border-t border-slate-700 sticky bottom-0 bg-slate-800">
          <button onClick={onClose} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg">Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-red-700 hover:bg-red-600 text-white text-sm rounded-lg disabled:opacity-50"
          >
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Policy'}
          </button>
        </div>
      </div>
    </div>
  )
}

function AgentOrderModal({ policyId, policyName, onClose, onSaved }) {
  const [orderedAgents, setOrderedAgents] = useState([])
  const [allAgents, setAllAgents] = useState([])
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)

  useEffect(() => {
    const load = async () => {
      try {
        const [policyAgentsRes, allAgentsRes] = await Promise.all([
          integrationsApi.apcUps.getPolicyAgents(policyId),
          agentsApi.list(),
        ])
        const policyAgents = policyAgentsRes.data
        const all = allAgentsRes.data || []
        const policyAgentIds = new Set(policyAgents.map(a => a.agent_id))
        setOrderedAgents(policyAgents)
        setAllAgents(all.filter(a => !policyAgentIds.has(a.id)))
      } catch (e) {
        setErr(e.response?.data?.detail || e.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [policyId])

  const moveUp = (i) => {
    if (i === 0) return
    setOrderedAgents(prev => {
      const next = [...prev]
      ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
      return next
    })
  }

  const moveDown = (i) => {
    setOrderedAgents(prev => {
      if (i === prev.length - 1) return prev
      const next = [...prev]
      ;[next[i], next[i + 1]] = [next[i + 1], next[i]]
      return next
    })
  }

  const addAgent = (agent) => {
    setOrderedAgents(prev => [...prev, {
      agent_id: agent.id,
      hostname: agent.hostname,
      os_type: agent.os_type,
      status: agent.status,
      shutdown_order: prev.length + 1,
    }])
    setAllAgents(prev => prev.filter(a => a.id !== agent.id))
  }

  const removeAgent = (agentId) => {
    const removed = orderedAgents.find(a => a.agent_id === agentId)
    setOrderedAgents(prev => prev.filter(a => a.agent_id !== agentId))
    if (removed) {
      setAllAgents(prev => [...prev, {
        id: removed.agent_id,
        hostname: removed.hostname,
        os_type: removed.os_type,
        status: removed.status,
      }])
    }
  }

  const handleSave = async () => {
    setSaving(true); setErr(null)
    try {
      await integrationsApi.apcUps.setPolicyAgents(policyId, {
        agents: orderedAgents.map((a, i) => ({ agent_id: a.agent_id, shutdown_order: i + 1 }))
      })
      onSaved()
    } catch (e) {
      setErr(e.response?.data?.detail || e.message)
      setSaving(false)
    }
  }

  const osBadge = (os) => {
    if (!os) return 'bg-slate-700 text-slate-400'
    return os.toLowerCase().includes('windows') ? 'bg-blue-900/40 text-blue-300' : 'bg-green-900/40 text-green-300'
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center gap-3 p-5 border-b border-slate-700 sticky top-0 bg-slate-800 z-10">
          <Settings2 size={18} className="text-blue-400" />
          <div>
            <h2 className="font-semibold text-white">Manage Servers — {policyName}</h2>
            <p className="text-xs text-slate-400 mt-0.5">Set the order in which servers will be shut down</p>
          </div>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-white"><X size={18} /></button>
        </div>

        {loading ? (
          <div className="p-8 text-center text-slate-400">Loading agents...</div>
        ) : (
          <div className="p-5 space-y-6">
            {err && <div className="text-red-400 text-sm bg-red-900/20 border border-red-700 rounded px-3 py-2">{err}</div>}

            {/* Shutdown order list */}
            <div>
              <h3 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                <PowerOff size={13} className="text-red-400" />
                Shutdown Order ({orderedAgents.length} server{orderedAgents.length !== 1 ? 's' : ''})
              </h3>
              {orderedAgents.length === 0 ? (
                <div className="text-center text-slate-500 py-6 bg-slate-900/40 rounded-lg border border-slate-700 text-sm">
                  No servers added. Add servers from the list below.
                </div>
              ) : (
                <div className="space-y-2">
                  {orderedAgents.map((agent, i) => (
                    <div key={agent.agent_id} className="flex items-center gap-3 bg-slate-700/40 border border-slate-600 rounded-lg px-3 py-2.5">
                      <span className="text-xs font-bold text-slate-400 w-5 text-center">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`w-1.5 h-1.5 rounded-full ${agent.status === 'online' ? 'bg-green-400' : 'bg-slate-500'}`} />
                          <span className="text-sm text-white font-medium truncate">{agent.hostname}</span>
                        </div>
                        {agent.os_type && (
                          <span className={`text-xs px-1.5 py-0.5 rounded mt-0.5 inline-block ${osBadge(agent.os_type)}`}>
                            {agent.os_type}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => moveUp(i)}
                          disabled={i === 0}
                          className="p-1 text-slate-400 hover:text-white disabled:opacity-30 rounded"
                        >
                          <ChevronUp size={14} />
                        </button>
                        <button
                          onClick={() => moveDown(i)}
                          disabled={i === orderedAgents.length - 1}
                          className="p-1 text-slate-400 hover:text-white disabled:opacity-30 rounded"
                        >
                          <ChevronDown size={14} />
                        </button>
                        <button
                          onClick={() => removeAgent(agent.agent_id)}
                          className="p-1 text-slate-400 hover:text-red-400 rounded ml-1"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Available agents */}
            {allAgents.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-white mb-3">Available Agents</h3>
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {allAgents.map(agent => (
                    <div key={agent.id} className="flex items-center gap-3 bg-slate-900/40 border border-slate-700 rounded-lg px-3 py-2">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${agent.status === 'online' ? 'bg-green-400' : 'bg-slate-500'}`} />
                      <span className="text-sm text-slate-300 flex-1 truncate">{agent.hostname}</span>
                      {agent.os_type && (
                        <span className={`text-xs px-1.5 py-0.5 rounded ${osBadge(agent.os_type)}`}>
                          {agent.os_type}
                        </span>
                      )}
                      <button
                        onClick={() => addAgent(agent)}
                        className="text-xs text-blue-400 hover:text-blue-300 font-medium px-2 py-0.5 rounded border border-blue-700/50 hover:bg-blue-900/20"
                      >
                        + Add
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-3 p-5 border-t border-slate-700 sticky bottom-0 bg-slate-800">
          <button onClick={onClose} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg">Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving || loading}
            className="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white text-sm rounded-lg disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save Order'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function IntegrationApcUps() {
  const navigate = useNavigate()
  const [dashboard, setDashboard] = useState(null)
  const [devices, setDevices] = useState([])
  const [policies, setPolicies] = useState([])
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState(null)
  const [modal, setModal] = useState(null) // null | 'add' | {device}
  const [policyModal, setPolicyModal] = useState(null)  // null | 'new' | {policy object}
  const [agentModal, setAgentModal] = useState(null)    // null | {policy_id, policy_name}
  const [cancellingEvent, setCancellingEvent] = useState(null)  // event_id being cancelled
  const [countdown, setCountdown] = useState({})  // event_id → seconds remaining

  const load = useCallback(async () => {
    try {
      const [d, devs, pols, evts] = await Promise.all([
        integrationsApi.apcUps.dashboard(),
        integrationsApi.apcUps.devices(),
        integrationsApi.apcUps.shutdownPolicies(),
        integrationsApi.apcUps.shutdownEvents(),
      ])
      setDashboard(d.data)
      setDevices(devs.data)
      setPolicies(pols.data)
      setEvents(evts.data)
      setError(null)
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Countdown timer for pending shutdown events
  useEffect(() => {
    const pending = events.filter(e => e.status === 'pending' && e.cancel_deadline)
    if (pending.length === 0) {
      setCountdown({})
      return
    }
    const timer = setInterval(() => {
      const now = Date.now()
      const newCountdown = {}
      pending.forEach(e => {
        const deadline = new Date(e.cancel_deadline).getTime()
        const secs = Math.max(0, Math.floor((deadline - now) / 1000))
        newCountdown[e.id] = secs
      })
      setCountdown(newCountdown)
    }, 1000)
    return () => clearInterval(timer)
  }, [events])

  const handleSync = async () => {
    setSyncing(true)
    try {
      await integrationsApi.apcUps.sync()
      setTimeout(load, 3000)
    } catch (e) {
      alert('Sync failed: ' + (e.response?.data?.detail || e.message))
    } finally {
      setSyncing(false)
    }
  }

  const handleDelete = async (device) => {
    if (!window.confirm(`Delete ${device.name} (${device.host})?`)) return
    try {
      await integrationsApi.apcUps.deleteDevice(device.id)
      load()
    } catch (e) {
      alert('Delete failed: ' + (e.response?.data?.detail || e.message))
    }
  }

  const handleCancelEvent = async (eventId) => {
    setCancellingEvent(eventId)
    try {
      await integrationsApi.apcUps.cancelShutdownEvent(eventId)
      await load()
    } catch (e) {
      alert('Cancel failed: ' + (e.response?.data?.detail || e.message))
    } finally {
      setCancellingEvent(null)
    }
  }

  const handleTogglePolicy = async (id, is_active) => {
    try {
      await integrationsApi.apcUps.updateShutdownPolicy(id, { is_active })
      load()
    } catch (e) {
      alert('Failed: ' + (e.response?.data?.detail || e.message))
    }
  }

  const handleDeletePolicy = async (id, name) => {
    if (!window.confirm(`Delete shutdown policy "${name}"?`)) return
    try {
      await integrationsApi.apcUps.deleteShutdownPolicy(id)
      load()
    } catch (e) {
      alert('Delete failed: ' + (e.response?.data?.detail || e.message))
    }
  }

  if (loading) return (
    <div className="p-6 text-slate-400 text-center">Loading APC UPS data...</div>
  )

  const plug = dashboard?.plugin || {}
  const dev  = dashboard?.devices || {}
  const pendingEvents = events.filter(e => e.status === 'pending')

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/integrations')}
          className="text-slate-400 hover:text-white p-2 rounded-lg hover:bg-slate-800 transition-colors">
          <ArrowLeft size={18} />
        </button>
        <div className="w-10 h-10 rounded-xl bg-yellow-600/20 flex items-center justify-center">
          <Zap size={20} className="text-yellow-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">APC UPS</h1>
          <p className="text-slate-400 text-sm">Power management — SNMP monitoring</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border ${
            plug.status === 'connected'
              ? 'bg-green-900/40 text-green-300 border-green-700'
              : 'bg-slate-800 text-slate-400 border-slate-600'
          }`}>
            {plug.status === 'connected' ? <CheckCircle size={10} /> : <XCircle size={10} />}
            {plug.status === 'connected' ? 'Connected' : 'Not configured'}
          </span>
          <button
            onClick={() => setModal('add')}
            className="flex items-center gap-2 px-4 py-2 bg-yellow-600 hover:bg-yellow-700 text-white text-sm rounded-lg transition-colors"
          >
            <Plus size={14} /> Add Device
          </button>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing…' : 'Sync Now'}
          </button>
        </div>
      </div>

      {/* Active shutdown event banners */}
      {pendingEvents.map(e => (
        <div key={e.id} className="bg-red-900/40 border border-red-600 rounded-xl p-4 flex items-center gap-4">
          <AlertOctagon size={20} className="text-red-400 shrink-0 animate-pulse" />
          <div className="flex-1">
            <div className="font-semibold text-red-300">UPS SHUTDOWN PENDING — {e.device_name}</div>
            <div className="text-sm text-red-200 mt-0.5">{e.trigger_reason}</div>
            <div className="text-xs text-red-400 mt-1">
              Policy: {e.policy_name} · {e.agents_total} server(s) ·
              {countdown[e.id] != null
                ? ` Shutdown in ${Math.floor(countdown[e.id] / 60)}m ${countdown[e.id] % 60}s`
                : ' Calculating...'}
            </div>
          </div>
          <button
            onClick={() => handleCancelEvent(e.id)}
            disabled={cancellingEvent === e.id}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold rounded-lg disabled:opacity-50 shrink-0"
          >
            {cancellingEvent === e.id ? 'Cancelling…' : 'Cancel Shutdown'}
          </button>
        </div>
      ))}

      {error && (
        <div className="bg-red-900/30 border border-red-700 text-red-300 rounded-lg px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {plug.last_error && (
        <div className="bg-red-900/30 border border-red-700 text-red-300 rounded-lg px-4 py-3 text-sm">
          Last sync error: {plug.last_error}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
        {[
          { label: 'Total',       value: dev.total ?? 0,        cls: 'text-slate-200' },
          { label: 'Online',      value: dev.online ?? 0,       cls: 'text-green-400' },
          { label: 'On Battery',  value: dev.on_battery ?? 0,   cls: 'text-yellow-400' },
          { label: 'Low Battery', value: dev.low_battery ?? 0,  cls: 'text-red-400' },
          { label: 'On Bypass',   value: dev.on_bypass ?? 0,    cls: 'text-orange-400' },
          { label: 'Offline',     value: dev.offline ?? 0,      cls: 'text-slate-400' },
          { label: 'Avg Load',    value: dev.avg_load_pct != null ? `${dev.avg_load_pct}%` : '—', cls: 'text-blue-400' },
        ].map(c => (
          <div key={c.label} className="bg-slate-800 border border-slate-700 rounded-xl p-4 text-center">
            <div className={`text-2xl font-bold ${c.cls}`}>{c.value}</div>
            <div className="text-xs text-slate-400 mt-1">{c.label}</div>
          </div>
        ))}
      </div>

      {/* Device table */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between">
          <h2 className="font-semibold text-white">UPS Devices</h2>
          <span className="text-xs text-slate-400">
            {plug.last_sync_at
              ? `Last sync: ${new Date(plug.last_sync_at).toLocaleString()}`
              : 'Never synced'}
          </span>
        </div>

        {devices.length === 0 ? (
          <div className="text-center text-slate-400 py-12">
            <Zap size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">No UPS devices found.</p>
            <p className="text-xs mt-1 text-slate-500">
              Add devices via the API — configure host IP and SNMP community in the database.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-400 border-b border-slate-700 bg-slate-800/60">
                  <th className="px-4 py-3 text-left">Device</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-left">Battery</th>
                  <th className="px-4 py-3 text-left">Load</th>
                  <th className="px-4 py-3 text-left">Runtime</th>
                  <th className="px-4 py-3 text-left">Input V</th>
                  <th className="px-4 py-3 text-left">Output V</th>
                  <th className="px-4 py-3 text-left">Temp</th>
                  <th className="px-4 py-3 text-left">Last Polled</th>
                  <th className="px-4 py-3 text-center">Actions</th>
                </tr>
              </thead>
              <tbody>
                {devices.map(d => (
                  <tr key={d.id} className="border-b border-slate-700/50 hover:bg-slate-700/20 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-white">{d.name}</div>
                      <div className="text-xs text-slate-500">{d.host} · SNMP {d.snmp_version} · community: {d.snmp_community}</div>
                      {d.model && <div className="text-xs text-slate-500">{d.model}</div>}
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={d.status} /></td>
                    <td className="px-4 py-3"><BatteryBar pct={d.battery_capacity_pct} /></td>
                    <td className="px-4 py-3"><LoadBar pct={d.output_load_pct} /></td>
                    <td className="px-4 py-3">
                      <span className="text-slate-300">{runtime(d.battery_runtime_seconds)}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-300">
                      {d.input_voltage_v != null ? `${d.input_voltage_v} V` : '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-300">
                      {d.output_voltage_v != null ? `${d.output_voltage_v} V` : '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-300">
                      {d.battery_temp_c != null ? `${d.battery_temp_c} °C` : '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-500 text-xs">
                      {d.last_polled_at
                        ? new Date(d.last_polled_at).toLocaleString()
                        : 'Never'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => setModal(d)}
                          title="Edit"
                          className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => handleDelete(d)}
                          title="Delete"
                          className="p-1.5 rounded text-slate-400 hover:text-red-400 hover:bg-red-900/20 transition-colors"
                        >
                          <Trash2 size={13} />
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

      {/* Shutdown Policies */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PowerOff size={16} className="text-red-400" />
            <h2 className="font-semibold text-white">Shutdown Policies</h2>
          </div>
          <button
            onClick={() => setPolicyModal('new')}
            className="flex items-center gap-2 px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white text-sm rounded-lg"
          >
            <Plus size={13} /> Add Policy
          </button>
        </div>
        {policies.length === 0 ? (
          <div className="text-center text-slate-400 py-10">
            <Shield size={28} className="mx-auto mb-2 opacity-30" />
            <p className="text-sm">No shutdown policies configured.</p>
            <p className="text-xs mt-1 text-slate-500">Add a policy to automatically shut down servers when UPS power is critical.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
            {policies.map(p => (
              <div key={p.id} className={`rounded-xl border p-4 space-y-3 ${p.is_active ? 'bg-slate-700/40 border-slate-600' : 'bg-slate-800/40 border-slate-700 opacity-60'}`}>
                {/* Policy header */}
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium text-white text-sm">{p.name}</div>
                    <div className="text-xs text-slate-400 mt-0.5">{p.device_name} · {p.device_host}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleTogglePolicy(p.id, !p.is_active)}
                      className={`px-2 py-0.5 rounded text-xs font-medium border ${
                        p.is_active
                          ? 'bg-green-900/40 text-green-300 border-green-700 hover:bg-green-900/60'
                          : 'bg-slate-700 text-slate-400 border-slate-600 hover:bg-slate-600'
                      }`}
                    >
                      {p.is_active ? 'Active' : 'Disabled'}
                    </button>
                    <button onClick={() => setPolicyModal(p)} className="p-1 text-slate-400 hover:text-white rounded">
                      <Pencil size={12} />
                    </button>
                    <button onClick={() => handleDeletePolicy(p.id, p.name)} className="p-1 text-slate-400 hover:text-red-400 rounded">
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
                {/* Triggers */}
                <div className="text-xs text-slate-300 space-y-1">
                  <div className="flex items-center gap-1.5">
                    <Timer size={11} className="text-yellow-400" />
                    <span>Runtime &lt; <strong>{Math.floor(p.trigger_runtime_seconds / 60)}m</strong> {p.trigger_mode === 'all' ? 'AND' : 'OR'} Battery &lt; <strong>{p.trigger_battery_pct}%</strong></span>
                  </div>
                  <div className="flex items-center gap-1.5 text-slate-400">
                    <Clock size={11} />
                    <span>{Math.floor(p.cancel_window_seconds / 60)}m cancel window · {p.delay_between_agents_seconds}s between servers</span>
                  </div>
                </div>
                {/* Footer */}
                <div className="flex items-center justify-between pt-1 border-t border-slate-700">
                  <span className="text-xs text-slate-400">{p.agent_count} server{p.agent_count !== 1 ? 's' : ''} in shutdown order</span>
                  <button
                    onClick={() => setAgentModal({ policy_id: p.id, policy_name: p.name })}
                    className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
                  >
                    <Settings2 size={11} /> Manage Servers
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Shutdown Events */}
      {events.length > 0 && (
        <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-700">
            <h2 className="font-semibold text-white flex items-center gap-2">
              <AlertOctagon size={15} className="text-orange-400" />
              Recent Shutdown Events
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-400 border-b border-slate-700 bg-slate-800/60">
                  <th className="px-4 py-3 text-left">Triggered</th>
                  <th className="px-4 py-3 text-left">UPS / Policy</th>
                  <th className="px-4 py-3 text-left">Reason</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-left">Servers</th>
                  <th className="px-4 py-3 text-center">Action</th>
                </tr>
              </thead>
              <tbody>
                {events.map(e => {
                  const evStatusMap = {
                    pending:   { cls: 'bg-yellow-900/40 text-yellow-300 border-yellow-700',   label: 'Pending' },
                    executing: { cls: 'bg-orange-900/40 text-orange-300 border-orange-700',   label: 'Executing' },
                    completed: { cls: 'bg-green-900/40 text-green-300 border-green-700',      label: 'Completed' },
                    cancelled: { cls: 'bg-slate-800 text-slate-400 border-slate-600',         label: 'Cancelled' },
                    failed:    { cls: 'bg-red-900/40 text-red-300 border-red-700',            label: 'Failed' },
                  }
                  const es = evStatusMap[e.status] || evStatusMap.failed
                  return (
                    <tr key={e.id} className="border-b border-slate-700/50 hover:bg-slate-700/20">
                      <td className="px-4 py-3 text-slate-400 text-xs whitespace-nowrap">
                        {e.triggered_at ? new Date(e.triggered_at).toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-white text-xs font-medium">{e.device_name}</div>
                        <div className="text-slate-500 text-xs">{e.policy_name}</div>
                      </td>
                      <td className="px-4 py-3 text-slate-400 text-xs max-w-xs truncate">{e.trigger_reason}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full border ${es.cls}`}>
                          {es.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-300 text-xs">
                        {e.agents_shutdown}/{e.agents_total}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {e.status === 'pending' && (
                          <button
                            onClick={() => handleCancelEvent(e.id)}
                            disabled={cancellingEvent === e.id}
                            className="px-2 py-1 bg-red-700 hover:bg-red-600 text-white text-xs rounded disabled:opacity-50"
                          >
                            {cancellingEvent === e.id ? '…' : 'Cancel'}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="text-xs text-slate-500 text-center">
        SNMP polling runs automatically every 5 minutes. Use <strong>Sync Now</strong> for an immediate update.
      </div>

      {/* Add / Edit UPS device modal */}
      {modal && (
        <DeviceModal
          device={modal === 'add' ? null : modal}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load() }}
        />
      )}

      {/* Add / Edit shutdown policy modal */}
      {policyModal && (
        <PolicyModal
          devices={devices}
          policy={policyModal === 'new' ? null : policyModal}
          onClose={() => setPolicyModal(null)}
          onSaved={() => { setPolicyModal(null); load() }}
        />
      )}

      {/* Agent order modal */}
      {agentModal && (
        <AgentOrderModal
          policyId={agentModal.policy_id}
          policyName={agentModal.policy_name}
          onClose={() => setAgentModal(null)}
          onSaved={() => { setAgentModal(null); load() }}
        />
      )}
    </div>
  )
}
