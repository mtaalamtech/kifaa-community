import { useState, useEffect, useCallback } from 'react'
import { Bell, Plus, Trash2, Check, CheckCheck, AlertTriangle, Info, Zap, Settings, X } from 'lucide-react'
import api from '../api/client'

const SEVERITY_STYLE = {
  critical: 'bg-red-100 text-red-700 border border-red-200',
  warning:  'bg-yellow-100 text-yellow-700 border border-yellow-200',
  info:     'bg-blue-100 text-blue-700 border border-blue-200',
}

const STATUS_STYLE = {
  open:         'bg-red-50 text-red-600',
  acknowledged: 'bg-yellow-50 text-yellow-600',
  resolved:     'bg-green-50 text-green-600',
}

const METRIC_OPTIONS = [
  { value: 'cpu_percent',      label: 'CPU %' },
  { value: 'memory_percent',   label: 'Memory %' },
  { value: 'swap_percent',     label: 'Swap %' },
  { value: 'disk_percent',     label: 'Disk %' },
  { value: 'uptime_seconds',   label: 'Uptime (seconds)' },
]

const DEFAULT_RULE = {
  name: '', description: '', rule_type: 'metric',
  metric_name: 'cpu_percent', condition: '>', threshold: 90,
  duration_minutes: 5, severity: 'warning', applies_to: 'all',
  agent_id: '', group_id: '', notify_channels: [], is_active: true,
}

export default function Alerts() {
  const [tab, setTab] = useState('incidents')
  const [incidents, setIncidents] = useState([])
  const [rules, setRules] = useState([])
  const [stats, setStats] = useState({})
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('open')
  const [showRuleForm, setShowRuleForm] = useState(false)
  const [editingRule, setEditingRule] = useState(null)
  const [form, setForm] = useState(DEFAULT_RULE)

  const load = useCallback(async () => {
    try {
      const [inc, rls, st] = await Promise.all([
        api.get(`/alerts/incidents?status=${statusFilter}&limit=200`),
        api.get('/alerts/rules'),
        api.get('/alerts/stats'),
      ])
      setIncidents(inc.data)
      setRules(rls.data)
      setStats(st.data)
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => { load() }, [load])

  async function ack(id) {
    await api.post(`/alerts/incidents/${id}/acknowledge`)
    load()
  }

  async function resolve(id) {
    await api.post(`/alerts/incidents/${id}/resolve`)
    load()
  }

  function openCreate() {
    setEditingRule(null)
    setForm(DEFAULT_RULE)
    setShowRuleForm(true)
  }

  function openEdit(rule) {
    setEditingRule(rule)
    setForm({ ...rule, threshold: rule.threshold ?? '', agent_id: rule.agent_id ?? '', group_id: rule.group_id ?? '' })
    setShowRuleForm(true)
  }

  async function saveRule() {
    const payload = { ...form, threshold: parseFloat(form.threshold) || 0 }
    if (editingRule) {
      await api.put(`/alerts/rules/${editingRule.id}`, payload)
    } else {
      await api.post('/alerts/rules', payload)
    }
    setShowRuleForm(false)
    load()
  }

  async function deleteRule(id) {
    if (!confirm('Delete this alert rule?')) return
    await api.delete(`/alerts/rules/${id}`)
    load()
  }

  if (loading) return <div className="p-8 text-slate-400">Loading alerts...</div>

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Bell size={20} className="text-red-400" /> Alerts
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">Monitor thresholds and incidents</p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Open',         value: stats.open || 0,         color: 'text-red-400' },
          { label: 'Critical',     value: stats.critical || 0,     color: 'text-red-500' },
          { label: 'Warning',      value: stats.warning || 0,      color: 'text-yellow-400' },
          { label: 'Acknowledged', value: stats.acknowledged || 0, color: 'text-yellow-300' },
        ].map(s => (
          <div key={s.label} className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            <div className="text-xs text-slate-400 mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-700">
        {['incidents', 'rules'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize border-b-2 transition-colors ${
              tab === t
                ? 'border-blue-500 text-white'
                : 'border-transparent text-slate-400 hover:text-white'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Incidents tab */}
      {tab === 'incidents' && (
        <div className="space-y-4">
          {/* Status filter */}
          <div className="flex gap-2">
            {['open', 'acknowledged', 'resolved'].map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 text-xs rounded-lg capitalize border transition-colors ${
                  statusFilter === s
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'text-slate-400 border-slate-700 hover:text-white'
                }`}
              >
                {s}
              </button>
            ))}
          </div>

          {incidents.length === 0 ? (
            <div className="text-center py-16 text-slate-500">
              <Bell size={40} className="mx-auto mb-3 opacity-30" />
              <p>No {statusFilter} alerts</p>
            </div>
          ) : (
            <div className="space-y-2">
              {incidents.map(inc => (
                <div key={inc.id} className="bg-slate-800 border border-slate-700 rounded-xl p-4 flex items-start gap-4">
                  <div className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${SEVERITY_STYLE[inc.severity] || SEVERITY_STYLE.info}`}>
                    {inc.severity}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white font-medium">{inc.message}</div>
                    <div className="flex items-center gap-3 mt-1">
                      {inc.agent_hostname && (
                        <span className="text-xs text-slate-400">{inc.agent_hostname}</span>
                      )}
                      <span className="text-xs text-slate-500">
                        {new Date(inc.triggered_at).toLocaleString()}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${STATUS_STYLE[inc.status]}`}>
                        {inc.status}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {inc.status === 'open' && (
                      <button
                        onClick={() => ack(inc.id)}
                        title="Acknowledge"
                        className="p-1.5 rounded-lg text-slate-400 hover:text-yellow-400 hover:bg-slate-700 transition-colors"
                      >
                        <Check size={15} />
                      </button>
                    )}
                    {inc.status !== 'resolved' && (
                      <button
                        onClick={() => resolve(inc.id)}
                        title="Resolve"
                        className="p-1.5 rounded-lg text-slate-400 hover:text-green-400 hover:bg-slate-700 transition-colors"
                      >
                        <CheckCheck size={15} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Rules tab */}
      {tab === 'rules' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              onClick={openCreate}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors"
            >
              <Plus size={15} /> New Rule
            </button>
          </div>

          {rules.length === 0 ? (
            <div className="text-center py-16 text-slate-500">
              <AlertTriangle size={40} className="mx-auto mb-3 opacity-30" />
              <p>No alert rules configured</p>
            </div>
          ) : (
            <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-xs text-slate-400 uppercase">
                    <th className="px-4 py-3 text-left">Rule</th>
                    <th className="px-4 py-3 text-left">Condition</th>
                    <th className="px-4 py-3 text-left">Severity</th>
                    <th className="px-4 py-3 text-left">Applies To</th>
                    <th className="px-4 py-3 text-left">Status</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700">
                  {rules.map(rule => (
                    <tr key={rule.id} className="hover:bg-slate-750">
                      <td className="px-4 py-3">
                        <div className="font-medium text-white">{rule.name}</div>
                        {rule.description && (
                          <div className="text-xs text-slate-500">{rule.description}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-300 font-mono text-xs">
                        {rule.metric_name} {rule.condition} {rule.threshold}
                        <span className="text-slate-500 font-sans ml-1">
                          for {rule.duration_minutes}m
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs capitalize ${SEVERITY_STYLE[rule.severity] || ''}`}>
                          {rule.severity}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-300 capitalize">{rule.applies_to}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs ${rule.is_active ? 'text-green-400' : 'text-slate-500'}`}>
                          {rule.is_active ? 'Active' : 'Disabled'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => openEdit(rule)}
                            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition-colors"
                          >
                            <Settings size={14} />
                          </button>
                          <button
                            onClick={() => deleteRule(rule.id)}
                            className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-slate-700 rounded-lg transition-colors"
                          >
                            <Trash2 size={14} />
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
      )}

      {/* Rule Form Modal */}
      {showRuleForm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-lg">
            <div className="flex items-center justify-between p-5 border-b border-slate-700">
              <h2 className="font-semibold text-white">
                {editingRule ? 'Edit Alert Rule' : 'New Alert Rule'}
              </h2>
              <button onClick={() => setShowRuleForm(false)} className="text-slate-400 hover:text-white">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="text-xs text-slate-400 mb-1 block">Rule Name</label>
                  <input
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
                    placeholder="e.g. High CPU Alert"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Metric</label>
                  <select
                    value={form.metric_name}
                    onChange={e => setForm(f => ({ ...f, metric_name: e.target.value }))}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
                  >
                    {METRIC_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Condition</label>
                  <div className="flex gap-2">
                    <select
                      value={form.condition}
                      onChange={e => setForm(f => ({ ...f, condition: e.target.value }))}
                      className="bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
                    >
                      {['>', '>=', '<', '<=', '=='].map(c => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                    <input
                      type="number"
                      value={form.threshold}
                      onChange={e => setForm(f => ({ ...f, threshold: e.target.value }))}
                      className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
                      placeholder="Threshold"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Duration (minutes)</label>
                  <input
                    type="number"
                    value={form.duration_minutes}
                    onChange={e => setForm(f => ({ ...f, duration_minutes: parseInt(e.target.value) || 5 }))}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
                    min="1"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Severity</label>
                  <select
                    value={form.severity}
                    onChange={e => setForm(f => ({ ...f, severity: e.target.value }))}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
                  >
                    {['info', 'warning', 'critical'].map(s => (
                      <option key={s} value={s} className="capitalize">{s}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Applies To</label>
                  <select
                    value={form.applies_to}
                    onChange={e => setForm(f => ({ ...f, applies_to: e.target.value }))}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
                  >
                    <option value="all">All Agents</option>
                    <option value="agent">Specific Agent</option>
                    <option value="group">Agent Group</option>
                  </select>
                </div>
                <div className="col-span-2 flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="rule-active"
                    checked={form.is_active}
                    onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))}
                    className="rounded"
                  />
                  <label htmlFor="rule-active" className="text-sm text-slate-300">Rule is active</label>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3 p-5 border-t border-slate-700">
              <button
                onClick={() => setShowRuleForm(false)}
                className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveRule}
                disabled={!form.name || !form.metric_name}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
              >
                {editingRule ? 'Save Changes' : 'Create Rule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
