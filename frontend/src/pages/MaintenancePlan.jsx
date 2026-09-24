import { useState, useEffect, useCallback } from 'react'
import {
  Wrench, Plus, Pencil, Trash2, Download, ChevronDown, ChevronUp,
  Calendar, Server, AlertTriangle, CheckCircle, Clock, RotateCcw,
  X, UserPlus, Shield, ClipboardCheck, FileText, Bell, Send,
  History, CheckCircle2, XCircle, Loader2, RefreshCw, MinusCircle,
} from 'lucide-react'

// ── API helpers ────────────────────────────────────────────────────────────────
const API = '/api/v1'
const token = () => localStorage.getItem('kifaa_token')
const hdrs = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` })

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API}${path}`, { headers: hdrs(), ...opts })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res
}
async function apiJSON(path, opts = {}) {
  const res = await apiFetch(path, opts)
  return res.json()
}

// ── Constants ──────────────────────────────────────────────────────────────────
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const WEEKS = ['1st', '2nd', '3rd', '4th']
const FREQ_LABELS = { weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly' }
const RESTART_LABELS = { none: 'No Restart', notify: 'Notify Only', auto_restart: 'Auto Restart' }
const CYCLE_TYPE_LABELS = { patch: 'Patch Cycle', maintenance: 'Maintenance Cycle' }

const NOTIF_TYPES = [
  { value: 'all',                 label: 'All Reports' },
  { value: 'pre_patch',           label: 'Pre-Patch Reminder' },
  { value: 'post_patch',          label: 'Post-Patch Report' },
  { value: 'maintenance_complete',label: 'Maintenance Complete' },
  { value: 'weekly_report',       label: 'Weekly Report' },
  { value: 'monthly_report',      label: 'Monthly Report' },
  { value: 'compliance_report',   label: 'Compliance Report' },
]

const BLANK_FORM = {
  name: '',
  description: '',
  frequency: 'monthly',
  patch_day: 'Tuesday',
  patch_week: '1st',
  preferred_time: '22:00',
  pre_notification_hours: 24,
  maint_frequency: 'monthly',
  maint_day: 'Wednesday',
  maint_week: '1st',
  maint_time: '22:00',
  maint_restart_action: 'auto_restart',
  notes: '',
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function daysUntil(dateStr) {
  if (!dateStr) return null
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const target = new Date(dateStr)
  target.setHours(0, 0, 0, 0)
  return Math.round((target - now) / 86400000)
}

function nextDateColor(dateStr) {
  const d = daysUntil(dateStr)
  if (d === null) return 'text-slate-400'
  if (d <= 7) return 'text-red-400'
  if (d <= 30) return 'text-amber-400'
  return 'text-emerald-400'
}

function freqDescription(cycle) {
  const { frequency, patch_day, patch_week } = cycle
  if (frequency === 'weekly') return `Every ${patch_day}`
  if (frequency === 'monthly') return `Every ${patch_week} ${patch_day}`
  if (frequency === 'quarterly') return `Quarterly (${patch_week} ${patch_day})`
  return frequency
}

function formatDate(dateStr) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function osIcon(os_type) {
  if (!os_type) return '?'
  const t = os_type.toLowerCase()
  if (t.includes('win')) return 'Win'
  if (t.includes('linux') || t.includes('ubuntu') || t.includes('debian') || t.includes('centos') || t.includes('rhel')) return 'Linux'
  if (t.includes('mac')) return 'Mac'
  return os_type
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, colorClass, icon: Icon }) {
  return (
    <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 flex items-start gap-3">
      <div className={`p-2 rounded-lg ${colorClass.bg}`}>
        <Icon size={18} className={colorClass.icon} />
      </div>
      <div>
        <div className="text-xs text-slate-400 mb-0.5">{label}</div>
        <div className={`text-2xl font-bold ${colorClass.text}`}>{value ?? '—'}</div>
        {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
      </div>
    </div>
  )
}

function FreqBadge({ frequency }) {
  const map = {
    weekly:    'bg-blue-900/50 text-blue-300 border-blue-700',
    monthly:   'bg-purple-900/50 text-purple-300 border-purple-700',
    quarterly: 'bg-emerald-900/50 text-emerald-300 border-emerald-700',
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${map[frequency] || 'bg-slate-700 text-slate-400 border-slate-600'}`}>
      {FREQ_LABELS[frequency] || frequency}
    </span>
  )
}

function RestartBadge({ action }) {
  if (action === 'none') return null
  const map = {
    notify:       'bg-amber-900/40 text-amber-300 border-amber-700',
    auto_restart: 'bg-red-900/40 text-red-300 border-red-700',
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium flex items-center gap-1 ${map[action] || 'bg-slate-700 text-slate-400 border-slate-600'}`}>
      <RotateCcw size={10} />
      {RESTART_LABELS[action] || action}
    </span>
  )
}

function StatusDot({ status }) {
  const map = {
    online:  'bg-emerald-400',
    offline: 'bg-red-400',
    warning: 'bg-amber-400',
  }
  return <span className={`inline-block w-2 h-2 rounded-full ${map[status] || 'bg-slate-500'}`} title={status} />
}

function InputField({ label, children, required }) {
  return (
    <div>
      <label className="block text-xs text-slate-400 mb-1">
        {label}{required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  )
}

const inputCls = 'w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 placeholder-slate-500'
const selectCls = 'w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500'

// ── Cycle Modal ────────────────────────────────────────────────────────────────

function CycleModal({ editingCycle, onClose, onSaved }) {
  const [form, setForm] = useState(editingCycle ? {
    name: editingCycle.name || '',
    description: editingCycle.description || '',
    frequency: editingCycle.frequency || 'monthly',
    patch_day: editingCycle.patch_day || 'Tuesday',
    patch_week: editingCycle.patch_week || '1st',
    preferred_time: editingCycle.preferred_time || '22:00',
    pre_notification_hours: editingCycle.pre_notification_hours ?? 24,
    maint_frequency: editingCycle.maint_frequency || 'monthly',
    maint_day: editingCycle.maint_day || 'Wednesday',
    maint_week: editingCycle.maint_week || '1st',
    maint_time: editingCycle.maint_time || '22:00',
    maint_restart_action: editingCycle.maint_restart_action || 'auto_restart',
    notes: editingCycle.notes || '',
  } : { ...BLANK_FORM })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const f = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  async function save() {
    if (!form.name.trim()) { setError('Name is required.'); return }
    setSaving(true)
    setError('')
    try {
      const body = JSON.stringify(form)
      if (editingCycle) {
        await apiFetch(`/maintenance/cycles/${editingCycle.id}`, { method: 'PUT', body })
      } else {
        await apiFetch('/maintenance/cycles', { method: 'POST', body })
      }
      onSaved()
      onClose()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700 flex-shrink-0">
          <h2 className="font-semibold text-white flex items-center gap-2">
            <Wrench size={16} className="text-blue-400" />
            {editingCycle ? 'Edit Cycle' : 'New Maintenance Cycle'}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 overflow-y-auto flex-1">
          {error && (
            <div className="bg-red-900/30 border border-red-700 rounded-lg px-4 py-2 text-red-300 text-sm">
              {error}
            </div>
          )}

          <InputField label="Name" required>
            <input
              type="text"
              className={inputCls}
              placeholder="e.g. Monthly Patch Window"
              value={form.name}
              onChange={e => f('name', e.target.value)}
            />
          </InputField>

          <InputField label="Description">
            <textarea
              className={`${inputCls} resize-none`}
              rows={2}
              placeholder="Optional description"
              value={form.description}
              onChange={e => f('description', e.target.value)}
            />
          </InputField>

          {/* Patch Schedule section */}
          <div className="flex items-center gap-3 pt-2">
            <div className="text-xs font-semibold text-cyan-400 uppercase tracking-wider">Patch Schedule</div>
            <div className="flex-1 h-px bg-slate-700" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <InputField label="Frequency">
              <select className={selectCls} value={form.frequency} onChange={e => f('frequency', e.target.value)}>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
              </select>
            </InputField>

            <InputField label="Preferred Time">
              <input
                type="time"
                className={inputCls}
                value={form.preferred_time}
                onChange={e => f('preferred_time', e.target.value)}
              />
            </InputField>
          </div>

          {/* Patch Day / Week */}
          {form.frequency === 'weekly' ? (
            <InputField label="Day of Week">
              <select className={selectCls} value={form.patch_day} onChange={e => f('patch_day', e.target.value)}>
                {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </InputField>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <InputField label="Week of Month">
                <select className={selectCls} value={form.patch_week} onChange={e => f('patch_week', e.target.value)}>
                  {WEEKS.map(w => <option key={w} value={w}>{w}</option>)}
                </select>
              </InputField>
              <InputField label="Day of Week">
                <select className={selectCls} value={form.patch_day} onChange={e => f('patch_day', e.target.value)}>
                  {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </InputField>
            </div>
          )}

          <InputField label="Pre-notification Hours">
            <input
              type="number"
              className={inputCls}
              min={0}
              max={168}
              value={form.pre_notification_hours}
              onChange={e => f('pre_notification_hours', parseInt(e.target.value, 10) || 0)}
            />
          </InputField>

          {/* Maintenance Schedule section */}
          <div className="flex items-center gap-3 pt-2">
            <div className="text-xs font-semibold text-orange-400 uppercase tracking-wider">Maintenance Schedule</div>
            <div className="flex-1 h-px bg-slate-700" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <InputField label="Frequency">
              <select className={selectCls} value={form.maint_frequency} onChange={e => f('maint_frequency', e.target.value)}>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
              </select>
            </InputField>

            <InputField label="Maintenance Time">
              <input
                type="time"
                className={inputCls}
                value={form.maint_time}
                onChange={e => f('maint_time', e.target.value)}
              />
            </InputField>
          </div>

          {/* Maintenance Day / Week */}
          {form.maint_frequency === 'weekly' ? (
            <InputField label="Day of Week">
              <select className={selectCls} value={form.maint_day} onChange={e => f('maint_day', e.target.value)}>
                {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </InputField>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <InputField label="Week of Month">
                <select className={selectCls} value={form.maint_week} onChange={e => f('maint_week', e.target.value)}>
                  {WEEKS.map(w => <option key={w} value={w}>{w}</option>)}
                </select>
              </InputField>
              <InputField label="Day of Week">
                <select className={selectCls} value={form.maint_day} onChange={e => f('maint_day', e.target.value)}>
                  {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </InputField>
            </div>
          )}

          <InputField label="Restart Action">
            <select className={selectCls} value={form.maint_restart_action} onChange={e => f('maint_restart_action', e.target.value)}>
              <option value="none">No Restart</option>
              <option value="notify">Notify Only</option>
              <option value="auto_restart">Auto Restart</option>
            </select>
          </InputField>

          <InputField label="Notes">
            <textarea
              className={`${inputCls} resize-none`}
              rows={2}
              placeholder="Optional notes"
              value={form.notes}
              onChange={e => f('notes', e.target.value)}
            />
          </InputField>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-700 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {saving ? (
              <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <>{editingCycle ? <Pencil size={14} /> : <Plus size={14} />}</>
            )}
            {editingCycle ? 'Save Changes' : 'Create Cycle'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Log Maintenance Modal ──────────────────────────────────────────────────────

function LogMaintenanceModal({ agent, cycle, onClose, onSaved }) {
  const now = new Date()
  const localNow = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 16)

  const [form, setForm] = useState({
    actioned_at: localNow,
    action_type: 'patch',
    status: 'completed',
    notes: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const f = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  async function save() {
    setSaving(true)
    setError('')
    try {
      const user = JSON.parse(localStorage.getItem('kifaa_user') || '{}')
      await apiFetch('/maintenance/history', {
        method: 'POST',
        body: JSON.stringify({
          agent_id: agent.id,
          cycle_id: cycle?.id || null,
          actioned_at: form.actioned_at ? new Date(form.actioned_at).toISOString() : null,
          action_type: form.action_type,
          status: form.status,
          notes: form.notes,
          created_by: user.username || '',
        }),
      })
      onSaved()
      onClose()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const statusColors = {
    completed: 'text-emerald-400',
    failed:    'text-red-400',
    pending:   'text-amber-400',
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-md flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <h2 className="font-semibold text-white flex items-center gap-2">
            <ClipboardCheck size={16} className="text-emerald-400" />
            Log Maintenance
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
          {error && (
            <div className="bg-red-900/30 border border-red-700 rounded-lg px-4 py-2 text-red-300 text-sm">
              {error}
            </div>
          )}

          {/* Agent / Cycle context */}
          <div className="bg-slate-900/50 border border-slate-700 rounded-lg px-4 py-3 text-sm space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-slate-400 text-xs w-16">Server</span>
              <span className="text-white font-mono">{agent.hostname}</span>
            </div>
            {cycle && (
              <div className="flex items-center gap-2">
                <span className="text-slate-400 text-xs w-16">Cycle</span>
                <span className="text-slate-300">{cycle.name}</span>
              </div>
            )}
          </div>

          <InputField label="Date & Time Actioned" required>
            <input
              type="datetime-local"
              className={inputCls}
              value={form.actioned_at}
              onChange={e => f('actioned_at', e.target.value)}
            />
          </InputField>

          <div className="grid grid-cols-2 gap-4">
            <InputField label="Action Type">
              <select className={selectCls} value={form.action_type} onChange={e => f('action_type', e.target.value)}>
                <option value="patch">Patch</option>
                <option value="restart">Restart</option>
                <option value="scan">Scan</option>
                <option value="other">Other</option>
              </select>
            </InputField>

            <InputField label="Status">
              <select
                className={`${selectCls} ${statusColors[form.status] || ''}`}
                value={form.status}
                onChange={e => f('status', e.target.value)}
              >
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
                <option value="pending">Pending</option>
              </select>
            </InputField>
          </div>

          <InputField label="Notes">
            <textarea
              className={`${inputCls} resize-none`}
              rows={2}
              placeholder="Optional notes about this maintenance event"
              value={form.notes}
              onChange={e => f('notes', e.target.value)}
            />
          </InputField>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-700">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-sm text-white bg-emerald-700 hover:bg-emerald-600 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {saving
              ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              : <ClipboardCheck size={14} />}
            Log Event
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Submit Report Modal ────────────────────────────────────────────────────────

function SubmitReportModal({ cycle, agentCount, onClose, onSaved }) {
  const today = new Date().toISOString().split('T')[0]
  const [form, setForm] = useState({
    report_type: 'post_patch',
    patches_applied: 0,
    patches_failed: 0,
    servers_affected: agentCount || 0,
    services_verified: true,
    issues_found: '',
    actions_taken: '',
    rollback_required: false,
    next_steps: '',
    status: 'completed',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const f = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  async function save() {
    setSaving(true); setError('')
    try {
      const user = JSON.parse(localStorage.getItem('kifaa_user') || '{}')
      await apiFetch('/maintenance/reports', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          cycle_id: cycle?.id || null,
          group_name: cycle?.group_name || '',
          period_start: today,
          period_end: today,
          created_by: user.username || '',
        }),
      })
      onSaved()
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <h2 className="font-semibold text-white flex items-center gap-2">
            <FileText size={16} className="text-blue-400" />
            Submit Maintenance Report
            {cycle && <span className="text-xs text-slate-400 font-normal">— {cycle.name}</span>}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto flex-1">
          {error && <div className="bg-red-900/30 border border-red-700 rounded-lg px-4 py-2 text-red-300 text-sm">{error}</div>}

          <div className="grid grid-cols-2 gap-4">
            <InputField label="Report Type">
              <select className={selectCls} value={form.report_type} onChange={e => f('report_type', e.target.value)}>
                <option value="post_patch">Post-Patch Report</option>
                <option value="weekly">Weekly Report</option>
                <option value="monthly">Monthly Report</option>
              </select>
            </InputField>
            <InputField label="Status">
              <select className={selectCls} value={form.status} onChange={e => f('status', e.target.value)}>
                <option value="completed">Completed</option>
                <option value="partial">Partial</option>
                <option value="failed">Failed</option>
              </select>
            </InputField>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <InputField label="Patches Applied">
              <input type="number" className={inputCls} min={0} value={form.patches_applied} onChange={e => f('patches_applied', parseInt(e.target.value) || 0)} />
            </InputField>
            <InputField label="Patches Failed">
              <input type="number" className={inputCls} min={0} value={form.patches_failed} onChange={e => f('patches_failed', parseInt(e.target.value) || 0)} />
            </InputField>
            <InputField label="Servers Affected">
              <input type="number" className={inputCls} min={0} value={form.servers_affected} onChange={e => f('servers_affected', parseInt(e.target.value) || 0)} />
            </InputField>
          </div>

          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
              <input type="checkbox" className="w-4 h-4 accent-blue-500" checked={form.services_verified} onChange={e => f('services_verified', e.target.checked)} />
              All services verified
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
              <input type="checkbox" className="w-4 h-4 accent-red-500" checked={form.rollback_required} onChange={e => f('rollback_required', e.target.checked)} />
              Rollback required
            </label>
          </div>

          <InputField label="Issues Found">
            <textarea className={`${inputCls} resize-none`} rows={2} placeholder="Describe any issues encountered..." value={form.issues_found} onChange={e => f('issues_found', e.target.value)} />
          </InputField>

          <InputField label="Actions Taken">
            <textarea className={`${inputCls} resize-none`} rows={2} placeholder="What was done to resolve issues..." value={form.actions_taken} onChange={e => f('actions_taken', e.target.value)} />
          </InputField>

          <InputField label="Next Steps">
            <textarea className={`${inputCls} resize-none`} rows={2} placeholder="Follow-up actions required..." value={form.next_steps} onChange={e => f('next_steps', e.target.value)} />
          </InputField>
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-700">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors">Cancel</button>
          <button onClick={save} disabled={saving} className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2">
            {saving ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <FileText size={14} />}
            Submit Report
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Cycle Card ─────────────────────────────────────────────────────────────────

function CycleCard({ cycle, cycleAgents, onEdit, onDelete, onExpand, expanded, unassigned, onAgentsChanged, onReportSubmitted }) {
  const [selectedToAdd, setSelectedToAdd] = useState([])
  const [adding, setAdding] = useState(false)
  const [assignError, setAssignError] = useState('')
  const [logTarget, setLogTarget] = useState(null) // agent to log maintenance for
  const [showReportModal, setShowReportModal] = useState(false)
  const agents = cycleAgents || []
  const patchDays = daysUntil(cycle.next_maintenance_date)
  const maintDays = daysUntil(cycle.next_maint_date)
  const patchDateColor = nextDateColor(cycle.next_maintenance_date)
  const maintDateColor = nextDateColor(cycle.next_maint_date)

  async function addAgents() {
    if (!selectedToAdd.length) return
    setAdding(true)
    setAssignError('')
    try {
      await apiFetch(`/maintenance/cycles/${cycle.id}/agents`, {
        method: 'POST',
        body: JSON.stringify({ agent_ids: selectedToAdd }),
      })
      setSelectedToAdd([])
      onAgentsChanged(cycle.id)
    } catch (e) {
      setAssignError(e.message)
    } finally {
      setAdding(false)
    }
  }

  async function removeAgent(agentId) {
    try {
      await apiFetch(`/maintenance/cycles/${cycle.id}/agents/${agentId}`, { method: 'DELETE' })
      onAgentsChanged(cycle.id)
    } catch (_) { /* silent */ }
  }

  function toggleSelect(id) {
    setSelectedToAdd(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  return (
    <div className="bg-slate-800/60 border border-slate-700 rounded-xl overflow-hidden">
      {/* Card Header */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="font-semibold text-white text-sm truncate">{cycle.name}</span>
              <FreqBadge frequency={cycle.frequency} />
              {cycle.maint_restart_action && cycle.maint_restart_action !== 'none' && (
                <RestartBadge action={cycle.maint_restart_action} />
              )}
            </div>
            <div className="text-xs text-slate-400">{freqDescription(cycle)}</div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => onRunNow(cycle)}
              className="p-1.5 text-slate-400 hover:text-green-400 hover:bg-green-900/20 rounded-lg transition-colors"
              title="Run cycle now"
            >
              <RotateCcw size={14} />
            </button>
            <button
              onClick={() => onEdit(cycle)}
              className="p-1.5 text-slate-400 hover:text-blue-400 hover:bg-blue-900/20 rounded-lg transition-colors"
              title="Edit cycle"
            >
              <Pencil size={14} />
            </button>
            <button
              onClick={() => onDelete(cycle)}
              className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-900/20 rounded-lg transition-colors"
              title="Delete cycle"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        {/* Patch date */}
        {cycle.patch_status === 'today' ? (
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex w-2 h-2 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
            <span className="text-blue-300 font-semibold text-sm">
              Patching today ({formatDate(cycle.next_maintenance_date)}) at {cycle.preferred_time || '22:00'}
            </span>
          </div>
        ) : cycle.patch_status === 'overdue' ? (
          <div className="flex items-center gap-1.5 mb-1">
            <AlertTriangle size={13} className="text-red-400 flex-shrink-0" />
            <span className="text-red-400 font-semibold text-sm">
              Patch overdue since {formatDate(cycle.next_maintenance_date)} — confirm completion
            </span>
          </div>
        ) : (
          <div className={`flex items-center gap-1.5 text-sm mb-1 ${patchDateColor}`}>
            <Calendar size={13} />
            <span className="text-xs text-slate-400 mr-1">Patch:</span>
            <span className="font-medium">
              {cycle.next_maintenance_date
                ? `${formatDate(cycle.next_maintenance_date)}${patchDays !== null ? ` (in ${patchDays}d)` : ''} at ${cycle.preferred_time || '22:00'}`
                : 'Not scheduled'}
            </span>
          </div>
        )}

        {/* Restart date */}
        {cycle.restart_status === 'today' ? (
          <div className="flex items-center gap-2 mb-3">
            <span className="inline-flex w-2 h-2 rounded-full bg-orange-400 animate-pulse flex-shrink-0" />
            <span className="text-orange-300 font-semibold text-sm">
              Restarting today ({formatDate(cycle.next_maint_date)}) at {cycle.maint_time || '22:00'}
            </span>
          </div>
        ) : cycle.restart_status === 'overdue' ? (
          <div className="flex items-center gap-1.5 mb-3">
            <AlertTriangle size={13} className="text-red-400 flex-shrink-0" />
            <span className="text-red-400 font-semibold text-sm">
              Restart overdue since {formatDate(cycle.next_maint_date)} — confirm completion
            </span>
          </div>
        ) : cycle.restart_status === 'done' ? (
          <div className="flex items-center gap-1.5 mb-3">
            <CheckCircle size={13} className="text-emerald-400 flex-shrink-0" />
            <span className="text-emerald-400 text-sm">Restart completed</span>
          </div>
        ) : (
          <div className={`flex items-center gap-1.5 text-sm mb-3 ${maintDateColor}`}>
            <RotateCcw size={13} />
            <span className="text-xs text-slate-400 mr-1">Restart:</span>
            <span className="font-medium">
              {cycle.next_maint_date
                ? `${formatDate(cycle.next_maint_date)}${maintDays !== null ? ` (in ${maintDays}d)` : ''} at ${cycle.maint_time || '22:00'}`
                : 'Not scheduled'}
            </span>
          </div>
        )}

        {/* Stats row */}
        <div className="flex items-center gap-4 text-xs text-slate-400">
          <span className="flex items-center gap-1"><Server size={12} />{cycle.agent_count ?? 0} servers</span>
          <span className="flex items-center gap-1"><Clock size={12} />{cycle.total_pending ?? 0} pending</span>
          {(cycle.total_critical ?? 0) > 0 && (
            <span className="flex items-center gap-1 text-red-400">
              <AlertTriangle size={12} />{cycle.total_critical} critical
            </span>
          )}
          {cycle.preferred_time && (
            <span className="flex items-center gap-1 ml-auto"><Clock size={12} />{cycle.preferred_time}</span>
          )}
        </div>
      </div>

      {/* Expand button */}
      <button
        onClick={() => onExpand(cycle.id)}
        className="w-full flex items-center justify-center gap-1 py-2 text-xs text-slate-400 hover:text-slate-300 bg-slate-700/30 hover:bg-slate-700/60 transition-colors border-t border-slate-700"
      >
        {expanded ? <><ChevronUp size={12} />Hide servers</> : <><ChevronDown size={12} />Show servers</>}
      </button>

      {/* Expanded: agent table + add */}
      {expanded && (
        <div className="border-t border-slate-700">
          {agents.length === 0 ? (
            <div className="px-4 py-6 text-center text-slate-500 text-sm">No servers in this cycle yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-700 text-slate-400">
                    <th className="text-left px-4 py-2 font-medium">Hostname</th>
                    <th className="text-left px-4 py-2 font-medium">OS</th>
                    <th className="text-left px-4 py-2 font-medium">Status</th>
                    <th className="text-right px-4 py-2 font-medium">Pending</th>
                    <th className="text-left px-4 py-2 font-medium">Last Scanned</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {agents.map(a => (
                    <tr key={a.id} className="border-b border-slate-700/50 hover:bg-slate-700/20">
                      <td className="px-4 py-2 text-white font-mono">{a.hostname}</td>
                      <td className="px-4 py-2 text-slate-300">{osIcon(a.os_type)}</td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-1.5">
                          <StatusDot status={a.status} />
                          <span className="text-slate-400 capitalize">{a.status}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right">
                        {(a.critical_patches ?? 0) > 0
                          ? <span className="text-red-400 font-medium">{a.pending_patches}</span>
                          : <span className="text-slate-300">{a.pending_patches ?? 0}</span>}
                      </td>
                      <td className="px-4 py-2 text-slate-400">{a.last_scanned ? formatDate(a.last_scanned) : '—'}</td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setLogTarget(a)}
                            className="p-1 text-slate-500 hover:text-emerald-400 hover:bg-emerald-900/20 rounded transition-colors"
                            title="Log maintenance event"
                          >
                            <ClipboardCheck size={12} />
                          </button>
                          <button
                            onClick={() => removeAgent(a.id)}
                            className="p-1 text-slate-500 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors"
                            title="Remove from cycle"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Submit Report button */}
          <div className="px-4 py-2 border-t border-slate-700/50 flex justify-end">
            <button
              onClick={() => setShowReportModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600/20 hover:bg-blue-600/40 text-blue-300 hover:text-white border border-blue-700/50 rounded-lg transition-colors"
            >
              <FileText size={12} />
              Submit Maintenance Report
            </button>
          </div>

          {/* Add servers */}
          <div className="p-4 border-t border-slate-700/50 bg-slate-800/30">
            <div className="text-xs text-slate-400 font-medium mb-2">Add unassigned servers</div>
            {unassigned.length === 0 ? (
              <div className="text-xs text-slate-500">No unassigned servers available.</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <div className="flex flex-wrap gap-1.5 flex-1 min-w-0">
                  {unassigned.map(a => {
                    const sel = selectedToAdd.includes(a.id)
                    return (
                      <button
                        key={a.id}
                        onClick={() => toggleSelect(a.id)}
                        className={`text-xs px-2 py-1 rounded border transition-colors ${
                          sel
                            ? 'bg-blue-600 border-blue-500 text-white'
                            : 'bg-slate-700 border-slate-600 text-slate-300 hover:border-blue-500'
                        }`}
                      >
                        {a.display_name || a.hostname}
                      </button>
                    )
                  })}
                </div>
                <button
                  onClick={addAgents}
                  disabled={adding || !selectedToAdd.length}
                  className="flex items-center gap-1 px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded border border-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                >
                  {adding ? <span className="w-3 h-3 border border-white/30 border-t-white rounded-full animate-spin" /> : <UserPlus size={12} />}
                  Add
                </button>
              </div>
            )}
            {assignError && <div className="mt-2 text-xs text-red-400">{assignError}</div>}
          </div>
        </div>
      )}

      {/* Log Maintenance Modal */}
      {logTarget && (
        <LogMaintenanceModal
          agent={logTarget}
          cycle={cycle}
          onClose={() => setLogTarget(null)}
          onSaved={() => {
            setLogTarget(null)
            onAgentsChanged(cycle.id)
          }}
        />
      )}

      {/* Submit Report Modal */}
      {showReportModal && (
        <SubmitReportModal
          cycle={cycle}
          agentCount={agents.length}
          onClose={() => setShowReportModal(false)}
          onSaved={() => {
            setShowReportModal(false)
            if (onReportSubmitted) onReportSubmitted()
          }}
        />
      )}
    </div>
  )
}

// ── Unassigned Servers Panel ───────────────────────────────────────────────────

function UnassignedPanel({ agents, cycles, onAssigned }) {
  const [openDropdown, setOpenDropdown] = useState(null) // agent id with open dropdown
  const [assigning, setAssigning] = useState(null)

  async function assignTo(agentId, cycleId) {
    setAssigning(agentId)
    try {
      await apiFetch(`/maintenance/cycles/${cycleId}/agents`, {
        method: 'POST',
        body: JSON.stringify({ agent_ids: [agentId] }),
      })
      setOpenDropdown(null)
      onAssigned(cycleId)
    } catch (_) { /* silent */ } finally {
      setAssigning(null)
    }
  }

  return (
    <div className="bg-slate-800/60 border border-amber-700/40 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-700 bg-amber-900/10">
        <AlertTriangle size={15} className="text-amber-400" />
        <span className="font-semibold text-white text-sm">Unassigned Servers ({agents.length})</span>
      </div>

      {agents.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <CheckCircle size={28} className="text-emerald-400" />
          <div className="text-emerald-400 font-medium text-sm">All servers assigned</div>
          <div className="text-slate-500 text-xs">Every server belongs to a maintenance cycle.</div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-700 text-slate-400">
                <th className="text-left px-4 py-2 font-medium">Hostname</th>
                <th className="text-left px-4 py-2 font-medium">OS</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-right px-4 py-2 font-medium">Pending</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {agents.map(a => (
                <tr key={a.id} className="border-b border-slate-700/50 hover:bg-slate-700/20 relative">
                  <td className="px-4 py-2 text-white font-mono">{a.hostname}</td>
                  <td className="px-4 py-2 text-slate-300">{osIcon(a.os_type)}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1.5">
                      <StatusDot status={a.status} />
                      <span className="text-slate-400 capitalize">{a.status}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right">
                    {(a.pending_patches ?? 0) > 0
                      ? <span className="text-amber-400">{a.pending_patches}</span>
                      : <span className="text-slate-400">0</span>}
                  </td>
                  <td className="px-4 py-2 text-right relative">
                    <button
                      onClick={() => setOpenDropdown(openDropdown === a.id ? null : a.id)}
                      disabled={assigning === a.id}
                      className="flex items-center gap-1 px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white rounded border border-slate-600 transition-colors"
                    >
                      <UserPlus size={11} />
                      Assign
                      <ChevronDown size={10} />
                    </button>
                    {openDropdown === a.id && (
                      <div className="absolute right-4 top-full mt-1 z-20 bg-slate-800 border border-slate-600 rounded-lg shadow-xl min-w-[180px]">
                        {cycles.length === 0 ? (
                          <div className="px-3 py-2 text-xs text-slate-400">No cycles defined</div>
                        ) : (
                          cycles.map(c => (
                            <button
                              key={c.id}
                              onClick={() => assignTo(a.id, c.id)}
                              className="w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-slate-700 transition-colors first:rounded-t-lg last:rounded-b-lg"
                            >
                              {c.name}
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Notification Settings Modal ───────────────────────────────────────────────

const BLANK_NOTIF = {
  name: '',
  email: '',
  notification_type: 'post_patch',
  cycle_type_filter: 'all',
  send_time: '09:00',
  is_active: true,
}

function NotificationModal({ onClose }) {
  const [notifications, setNotifications] = useState([])
  const [form, setForm]       = useState({ ...BLANK_NOTIF })
  const [editingId, setEditingId] = useState(null)
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState('')
  const [sendingId, setSendingId] = useState(null)
  const [sendResult, setSendResult] = useState({}) // id -> { ok, msg }

  const nf = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  const load = useCallback(async () => {
    try { setNotifications(await apiJSON('/maintenance/notifications')) } catch (_) {}
  }, [])

  useEffect(() => { load() }, [load])

  async function save() {
    if (!form.email.trim()) { setError('Email is required.'); return }
    setSaving(true); setError('')
    try {
      if (editingId) {
        await apiFetch(`/maintenance/notifications/${editingId}`, { method: 'PUT', body: JSON.stringify(form) })
      } else {
        await apiFetch('/maintenance/notifications', { method: 'POST', body: JSON.stringify(form) })
      }
      setForm({ ...BLANK_NOTIF }); setEditingId(null)
      await load()
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }

  async function del(id) {
    if (!window.confirm('Remove this notification?')) return
    try { await apiFetch(`/maintenance/notifications/${id}`, { method: 'DELETE' }); await load() } catch (_) {}
  }

  async function sendNow(id) {
    setSendingId(id)
    setSendResult(prev => ({ ...prev, [id]: null }))
    try {
      const res = await apiJSON(`/maintenance/notifications/${id}/send`, { method: 'POST' })
      setSendResult(prev => ({ ...prev, [id]: { ok: true, msg: res.detail || 'Sent' } }))
    } catch (e) {
      setSendResult(prev => ({ ...prev, [id]: { ok: false, msg: e.message } }))
    } finally {
      setSendingId(null)
      setTimeout(() => setSendResult(prev => { const n = { ...prev }; delete n[id]; return n }), 4000)
    }
  }

  function startEdit(n) {
    setEditingId(n.id)
    setForm({
      name: n.name || '',
      email: n.email || '',
      notification_type: n.notification_type || 'post_patch',
      cycle_type_filter: n.cycle_type_filter || 'all',
      send_time: n.send_time || '09:00',
      is_active: n.is_active ?? true,
    })
  }

  const notifTypeLabel = v => NOTIF_TYPES.find(t => t.value === v)?.label || v

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700 flex-shrink-0">
          <h2 className="font-semibold text-white flex items-center gap-2">
            <Bell size={16} className="text-blue-400" />
            Notification Settings
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Add / Edit form */}
          <div className="p-6 border-b border-slate-700 space-y-4">
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
              {editingId ? 'Edit Recipient' : 'Add Recipient'}
            </div>

            {error && <div className="bg-red-900/30 border border-red-700 rounded-lg px-4 py-2 text-red-300 text-sm">{error}</div>}

            <div className="grid grid-cols-2 gap-4">
              <InputField label="Name">
                <input type="text" className={inputCls} placeholder="e.g. IT Team" value={form.name} onChange={e => nf('name', e.target.value)} />
              </InputField>
              <InputField label="Email(s)" required>
                <textarea
                  className={`${inputCls} resize-none`}
                  rows={2}
                  placeholder={"user@company.com, manager@company.com\n(separate with commas or new lines)"}
                  value={form.email}
                  onChange={e => nf('email', e.target.value)}
                />
              </InputField>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <InputField label="Notification Type">
                <select className={selectCls} value={form.notification_type} onChange={e => nf('notification_type', e.target.value)}>
                  {NOTIF_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </InputField>
              <InputField label="Applies To">
                <select className={selectCls} value={form.cycle_type_filter} onChange={e => nf('cycle_type_filter', e.target.value)}>
                  <option value="all">All Cycles</option>
                  <option value="patch">Patch Cycles Only</option>
                  <option value="maintenance">Maintenance Cycles Only</option>
                </select>
              </InputField>
              <InputField label="Send Time">
                <input type="time" className={inputCls} value={form.send_time} onChange={e => nf('send_time', e.target.value)} />
              </InputField>
            </div>

            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input type="checkbox" className="w-4 h-4 accent-blue-500" checked={form.is_active} onChange={e => nf('is_active', e.target.checked)} />
                Active
              </label>
              <div className="flex gap-2">
                {editingId && (
                  <button onClick={() => { setEditingId(null); setForm({ ...BLANK_NOTIF }) }}
                    className="px-3 py-1.5 text-sm text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors">
                    Cancel
                  </button>
                )}
                <button onClick={save} disabled={saving}
                  className="flex items-center gap-2 px-4 py-1.5 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors disabled:opacity-50">
                  {saving ? <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Plus size={14} />}
                  {editingId ? 'Save Changes' : 'Add'}
                </button>
              </div>
            </div>
          </div>

          {/* Recipients table */}
          <div className="p-6">
            {notifications.length === 0 ? (
              <div className="text-center text-slate-500 text-sm py-8">No notification recipients configured yet.</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-700 text-slate-400">
                    <th className="text-left py-2 font-medium">Name / Email</th>
                    <th className="text-left py-2 font-medium">Notification</th>
                    <th className="text-left py-2 font-medium">Applies To</th>
                    <th className="text-left py-2 font-medium">Send Time</th>
                    <th className="text-center py-2 font-medium">Active</th>
                    <th className="text-center py-2 font-medium">Send Now</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {notifications.map(n => (
                    <tr key={n.id} className="border-b border-slate-700/40 hover:bg-slate-700/20">
                      <td className="py-2 pr-4">
                        <div className="text-white font-medium">{n.name || '—'}</div>
                        {(n.email || '').split(/[,\n]+/).map(e => e.trim()).filter(Boolean).map((e, i) => (
                          <div key={i} className="text-slate-400 text-[11px]">{e}</div>
                        ))}
                      </td>
                      <td className="py-2 pr-4 text-slate-300">{notifTypeLabel(n.notification_type)}</td>
                      <td className="py-2 pr-4">
                        <span className={`px-2 py-0.5 rounded-full border text-xs ${
                          n.cycle_type_filter === 'patch'       ? 'bg-cyan-900/40 text-cyan-300 border-cyan-700'
                        : n.cycle_type_filter === 'maintenance' ? 'bg-orange-900/40 text-orange-300 border-orange-700'
                        : 'bg-slate-700 text-slate-300 border-slate-600'}`}>
                          {n.cycle_type_filter === 'all' ? 'All' : CYCLE_TYPE_LABELS[n.cycle_type_filter] || n.cycle_type_filter}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-slate-300">{n.send_time || '—'}</td>
                      <td className="py-2 text-center">
                        <span className={`inline-block w-2 h-2 rounded-full ${n.is_active ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                      </td>
                      <td className="py-2 text-center">
                        <div className="flex flex-col items-center gap-0.5">
                          <button
                            onClick={() => sendNow(n.id)}
                            disabled={sendingId === n.id}
                            title="Send notification now"
                            className="p-1 text-slate-500 hover:text-blue-400 rounded transition-colors disabled:opacity-40"
                          >
                            {sendingId === n.id
                              ? <span className="inline-block w-3 h-3 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin" />
                              : <Send size={12} />
                            }
                          </button>
                          {sendResult[n.id] && (
                            <span className={`text-[10px] ${sendResult[n.id].ok ? 'text-emerald-400' : 'text-red-400'}`}>
                              {sendResult[n.id].msg}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2">
                        <div className="flex items-center gap-1 justify-end">
                          <button onClick={() => startEdit(n)} className="p-1 text-slate-500 hover:text-blue-400 rounded transition-colors"><Pencil size={12} /></button>
                          <button onClick={() => del(n.id)} className="p-1 text-slate-500 hover:text-red-400 rounded transition-colors"><Trash2 size={12} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── History Table with expandable output + Re-run button ──────────────────────

function HistoryTable({ history, onRefresh }) {
  const [expanded, setExpanded] = useState(null)
  const [rerunning, setRerunning] = useState({})

  const toggle = (id) => setExpanded(prev => prev === id ? null : id)

  const handleRerun = async (h) => {
    if (!window.confirm(`Re-run patching for ${h.hostname}?`)) return
    setRerunning(p => ({ ...p, [h.id]: true }))
    try {
      const res = await apiFetch(`/maintenance/history/${h.id}/rerun`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        alert('Re-run failed: ' + (err.detail || res.statusText))
      } else {
        const data = await res.json().catch(() => ({}))
        if (data.queued_offline) alert(data.message || 'Queued — will run when agent comes back online')
        onRefresh()
      }
    } catch (e) {
      alert('Re-run failed: ' + e.message)
    } finally {
      setRerunning(p => ({ ...p, [h.id]: false }))
    }
  }

  const statusMap = {
    completed: { cls: 'text-emerald-300 bg-emerald-900/30 border-emerald-700/50', icon: <CheckCircle2 size={11} /> },
    failed:    { cls: 'text-red-300 bg-red-900/30 border-red-700/50',             icon: <XCircle size={11} /> },
    pending:   { cls: 'text-amber-300 bg-amber-900/30 border-amber-700/50',       icon: <Clock size={11} /> },
    partial:   { cls: 'text-orange-300 bg-orange-900/30 border-orange-700/50',    icon: <AlertTriangle size={11} /> },
    skipped:   { cls: 'text-slate-400 bg-slate-700/30 border-slate-600/50',       icon: <MinusCircle size={11} /> },
    scheduled: { cls: 'text-blue-300 bg-blue-900/30 border-blue-700/50',          icon: <Clock size={11} /> },
  }
  const actionMap = {
    patch:   { cls: 'text-cyan-300 bg-cyan-900/30 border-cyan-700/50' },
    restart: { cls: 'text-orange-300 bg-orange-900/30 border-orange-700/50' },
    scan:    { cls: 'text-purple-300 bg-purple-900/30 border-purple-700/50' },
    other:   { cls: 'text-slate-300 bg-slate-700/50 border-slate-600' },
  }

  return (
    <div className="bg-slate-800/60 border border-slate-700 rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-700 bg-slate-800/80 text-slate-400">
              <th className="w-6 px-2 py-3" />
              <th className="text-left px-4 py-3 font-medium">Date & Time</th>
              <th className="text-left px-4 py-3 font-medium">Server</th>
              <th className="text-left px-4 py-3 font-medium">Cycle</th>
              <th className="text-center px-4 py-3 font-medium">Action</th>
              <th className="text-center px-4 py-3 font-medium">Status</th>
              <th className="text-left px-4 py-3 font-medium">Notes</th>
              <th className="text-center px-4 py-3 font-medium">Re-run</th>
            </tr>
          </thead>
          <tbody>
            {history.map(h => {
              const st = statusMap[h.status] || statusMap.pending
              const ac = actionMap[h.action_type] || actionMap.other
              const dt = h.actioned_at
                ? new Date(h.actioned_at).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
                : '—'
              const isExpanded = expanded === h.id
              const canRerun = (h.status === 'failed' || h.status === 'pending' || h.status === 'skipped') && h.action_type === 'patch'
              return (
                <>
                  <tr
                    key={h.id}
                    className="border-b border-slate-700/40 hover:bg-slate-700/20 transition-colors cursor-pointer"
                    onClick={() => (h.output || h.packages?.length) && toggle(h.id)}
                  >
                    <td className="px-2 py-2.5 text-slate-500">
                      {(h.output || h.packages?.length) ? (
                        isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 text-slate-300 whitespace-nowrap">{dt}</td>
                    <td className="px-4 py-2.5">
                      <div className="text-white font-medium font-mono">{h.hostname || '—'}</div>
                      {h.display_name && h.display_name !== h.hostname && (
                        <div className="text-slate-500 text-[10px]">{h.display_name}</div>
                      )}
                      <div className="text-slate-500 text-[10px] capitalize">{h.os_type || ''}</div>
                    </td>
                    <td className="px-4 py-2.5 text-slate-300">{h.cycle_name || '—'}</td>
                    <td className="px-4 py-2.5 text-center">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium capitalize ${ac.cls}`}>
                        {h.action_type || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium capitalize ${st.cls}`}>
                        {st.icon}{h.status || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-400 max-w-xs truncate" title={h.notes}>{h.notes || '—'}</td>
                    <td className="px-4 py-2.5 text-center" onClick={e => e.stopPropagation()}>
                      {canRerun && (
                        <button
                          onClick={() => handleRerun(h)}
                          disabled={rerunning[h.id]}
                          title="Re-queue patching for this server"
                          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-blue-700/30 hover:bg-blue-700/60 text-blue-300 border border-blue-700/50 disabled:opacity-40 transition-colors"
                        >
                          {rerunning[h.id]
                            ? <Loader2 size={11} className="animate-spin" />
                            : <RefreshCw size={11} />}
                          Re-run
                        </button>
                      )}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr key={`${h.id}-detail`} className="bg-slate-900/50 border-b border-slate-700/40">
                      <td colSpan={8} className="px-6 py-4 space-y-3">
                        {h.packages?.length > 0 && (
                          <div>
                            <div className="text-xs font-semibold text-slate-400 mb-1">Packages ({h.packages.length})</div>
                            <ul className="text-xs text-slate-300 space-y-0.5 max-h-32 overflow-y-auto">
                              {h.packages.map((p, i) => <li key={i} className="font-mono">• {p}</li>)}
                            </ul>
                          </div>
                        )}
                        {h.output && (
                          <div>
                            <div className="text-xs font-semibold text-slate-400 mb-1">
                              Output
                              {h.finished_at && (
                                <span className="ml-2 font-normal text-slate-500">
                                  completed {new Date(h.finished_at).toLocaleString()}
                                </span>
                              )}
                            </div>
                            <pre className="text-[11px] text-slate-300 bg-slate-950 rounded p-3 overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto font-mono">
                              {h.output}
                            </pre>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function MaintenancePlan() {
  const [overview, setOverview] = useState(null)
  const [cycles, setCycles] = useState([])
  const [unassigned, setUnassigned] = useState([])
  const [expandedCycles, setExpandedCycles] = useState(new Set())
  const [cycleAgents, setCycleAgents] = useState({}) // id -> agents[]
  const [showModal, setShowModal] = useState(false)
  const [editingCycle, setEditingCycle] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reports, setReports] = useState([])
  const [showNotifications, setShowNotifications] = useState(false)
  const [activeTab, setActiveTab] = useState('cycles') // 'cycles' | 'history'
  const [history, setHistory] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)

  // ── Data loading ─────────────────────────────────────────────────────────────

  const loadOverview = useCallback(async () => {
    try {
      const data = await apiJSON('/maintenance/overview')
      setOverview(data)
    } catch (_) {}
  }, [])

  const loadCycles = useCallback(async () => {
    try {
      const data = await apiJSON('/maintenance/cycles')
      setCycles(data)
    } catch (_) {}
  }, [])

  const loadUnassigned = useCallback(async () => {
    try {
      const data = await apiJSON('/maintenance/unassigned-agents')
      setUnassigned(data)
    } catch (_) {}
  }, [])

  const loadReports = useCallback(async () => {
    try {
      const data = await apiJSON('/maintenance/reports?limit=50')
      setReports(data)
    } catch (_) {}
  }, [])

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const data = await apiJSON('/maintenance/history?limit=500')
      setHistory(data)
    } catch (_) {}
    finally { setHistoryLoading(false) }
  }, [])

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      await Promise.all([loadOverview(), loadCycles(), loadUnassigned(), loadReports(), loadHistory()])
    } catch (e) {
      setError(e.message)
    } finally {

      setLoading(false)
    }
  }, [loadOverview, loadCycles, loadUnassigned, loadReports, loadHistory])

  useEffect(() => { loadAll() }, [loadAll])

  // ── Expand / agent fetch ─────────────────────────────────────────────────────

  const handleExpand = useCallback(async (cycleId) => {
    setExpandedCycles(prev => {
      const next = new Set(prev)
      if (next.has(cycleId)) { next.delete(cycleId) }
      else { next.add(cycleId) }
      return next
    })
    // Fetch agents (always refresh on expand — guard only skips if already loaded with data)
    if (!cycleAgents[cycleId] || cycleAgents[cycleId].length === 0) {
      try {
        const data = await apiJSON(`/maintenance/cycles/${cycleId}/agents`)
        setCycleAgents(prev => ({ ...prev, [cycleId]: data }))
      } catch (_) {}
    }
  }, [cycleAgents])

  const refreshCycleAgents = useCallback(async (cycleId) => {
    try {
      const data = await apiJSON(`/maintenance/cycles/${cycleId}/agents`)
      setCycleAgents(prev => ({ ...prev, [cycleId]: data }))
    } catch (_) {}
    // Reload unassigned and overview too
    await Promise.all([loadUnassigned(), loadOverview(), loadCycles()])
  }, [loadUnassigned, loadOverview, loadCycles])

  // ── CRUD ─────────────────────────────────────────────────────────────────────

  function openCreate() { setEditingCycle(null); setShowModal(true) }
  function openEdit(cycle) { setEditingCycle(cycle); setShowModal(true) }
  function closeModal() { setShowModal(false); setEditingCycle(null) }

  async function handleSaved() {
    setCycleAgents({})
    await loadAll()
  }

  async function handleRunNow(cycle) {
    if (!window.confirm(`Run "${cycle.name}" now? Patches will be queued for all online agents; offline agents will be logged as skipped.`)) return
    try {
      const res = await apiFetch(`/maintenance/cycles/${cycle.id}/run-now`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) { alert(`Run failed: ${data.detail || res.statusText}`); return }
      const summary = data.results.map(r => `${r.hostname}: ${r.status}`).join('\n')
      alert(`Cycle "${data.cycle}" triggered:\n\n${summary}`)
      await Promise.all([loadHistory(), loadOverview()])
    } catch (e) {
      alert(`Run failed: ${e.message}`)
    }
  }

  async function handleDelete(cycle) {
    if (!window.confirm(`Delete cycle "${cycle.name}"? This will unassign all servers from it.`)) return
    try {
      await apiFetch(`/maintenance/cycles/${cycle.id}`, { method: 'DELETE' })
      setCycleAgents(prev => { const n = { ...prev }; delete n[cycle.id]; return n })
      setExpandedCycles(prev => { const n = new Set(prev); n.delete(cycle.id); return n })
      await Promise.all([loadCycles(), loadUnassigned(), loadOverview()])
    } catch (e) {
      alert(`Delete failed: ${e.message}`)
    }
  }

  // ── Export ───────────────────────────────────────────────────────────────────

  async function handleExport() {
    try {
      const res = await apiFetch('/maintenance/export/xlsx')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'maintenance_plan.xlsx'
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      alert(`Export failed: ${e.message}`)
    }
  }

  async function handleReportExport(type) {
    try {
      const res = await apiFetch(`/maintenance/reports/export/xlsx?report_type=${type}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${type}_maintenance_report_${new Date().toISOString().split('T')[0]}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      alert(`Export failed: ${e.message}`)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-900 text-white p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2 mb-1">
            <Wrench size={22} className="text-blue-400" />
            Maintenance Plan
          </h1>
          <p className="text-slate-400 text-sm">Server patching cycles and maintenance scheduling</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => setShowNotifications(true)}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors border border-slate-600"
            title="Notification settings"
          >
            <Bell size={15} />
            Notifications
          </button>
          <button
            onClick={() => handleReportExport('weekly')}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors border border-slate-600"
          >
            <FileText size={15} />
            Weekly Report
          </button>
          <button
            onClick={() => handleReportExport('monthly')}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors border border-slate-600"
          >
            <FileText size={15} />
            Monthly Report
          </button>
          <button
            onClick={handleExport}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-emerald-700 hover:bg-emerald-600 rounded-lg transition-colors border border-emerald-600"
          >
            <Download size={15} />
            Export XLSX
          </button>
          <button
            onClick={openCreate}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors"
          >
            <Plus size={15} />
            New Cycle
          </button>
        </div>
      </div>

      {/* Stats bar */}
      {overview && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Total Servers"
            value={overview.total_agents}
            icon={Server}
            colorClass={{ bg: 'bg-blue-900/30', icon: 'text-blue-400', text: 'text-blue-300' }}
          />
          <StatCard
            label="Compliant"
            value={overview.compliant_agents}
            sub={overview.compliance_pct != null ? `${overview.compliance_pct.toFixed(1)}% compliance` : undefined}
            icon={Shield}
            colorClass={{ bg: 'bg-emerald-900/30', icon: 'text-emerald-400', text: 'text-emerald-300' }}
          />
          <StatCard
            label="Pending Patches"
            value={overview.total_pending_patches}
            sub={`${overview.unassigned_agents ?? 0} unassigned servers`}
            icon={Clock}
            colorClass={{ bg: 'bg-amber-900/30', icon: 'text-amber-400', text: 'text-amber-300' }}
          />
          <StatCard
            label="Critical Patches"
            value={overview.critical_pending_patches}
            icon={AlertTriangle}
            colorClass={{ bg: 'bg-red-900/30', icon: 'text-red-400', text: 'text-red-300' }}
          />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mb-4 bg-red-900/30 border border-red-700 rounded-lg px-4 py-3 text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-20 text-slate-400">
          <span className="w-6 h-6 border-2 border-slate-600 border-t-blue-400 rounded-full animate-spin mr-3" />
          Loading maintenance data…
        </div>
      )}

      {/* Tab bar */}
      {!loading && (
        <div className="flex items-center gap-1 mb-6 border-b border-slate-700">
          <button
            onClick={() => setActiveTab('cycles')}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
              activeTab === 'cycles'
                ? 'border-blue-500 text-white'
                : 'border-transparent text-slate-400 hover:text-white'
            }`}
          >
            <Wrench size={14} />
            Cycles
            <span className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-slate-700 text-slate-300">{cycles.length}</span>
          </button>
          <button
            onClick={() => { setActiveTab('history'); loadHistory() }}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
              activeTab === 'history'
                ? 'border-blue-500 text-white'
                : 'border-transparent text-slate-400 hover:text-white'
            }`}
          >
            <History size={14} />
            History
            {history.length > 0 && (
              <span className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-slate-700 text-slate-300">{history.length}</span>
            )}
          </button>
        </div>
      )}

      {/* Main content */}
      {!loading && activeTab === 'cycles' && (
        <>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left — Cycles list */}
          <div className="lg:col-span-2 space-y-4">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">
                Maintenance Cycles ({cycles.length})
              </h2>
            </div>

            {cycles.length === 0 ? (
              <div className="bg-slate-800/60 border border-slate-700 rounded-xl flex flex-col items-center gap-3 py-12">
                <Wrench size={32} className="text-slate-600" />
                <div className="text-slate-400 text-sm">No maintenance cycles defined yet.</div>
                <button
                  onClick={openCreate}
                  className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors"
                >
                  <Plus size={14} />
                  Create your first cycle
                </button>
              </div>
            ) : (
              cycles.map(cycle => (
                <CycleCard
                  key={cycle.id}
                  cycle={cycle}
                  cycleAgents={cycleAgents[cycle.id]}
                  expanded={expandedCycles.has(cycle.id)}
                  unassigned={unassigned}
                  onRunNow={handleRunNow}
                  onEdit={openEdit}
                  onDelete={handleDelete}
                  onExpand={handleExpand}
                  onAgentsChanged={refreshCycleAgents}
                  onReportSubmitted={() => { loadReports(); loadHistory(); loadCycles() }}
                />
              ))
            )}
          </div>

          {/* Right — Unassigned */}
          <div className="lg:col-span-1">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">
                Unassigned Servers
              </h2>
            </div>
            <UnassignedPanel
              agents={unassigned}
              cycles={cycles}
              onAssigned={refreshCycleAgents}
            />
          </div>
        </div>

        {/* Reports section */}
        {reports.length > 0 && (
          <div className="mt-8">
            <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider mb-3">
              Recent Maintenance Reports ({reports.length})
            </h2>
            <div className="bg-slate-800/60 border border-slate-700 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-700 text-slate-400">
                      <th className="text-left px-4 py-2 font-medium">Date</th>
                      <th className="text-left px-4 py-2 font-medium">Type</th>
                      <th className="text-left px-4 py-2 font-medium">Group</th>
                      <th className="text-left px-4 py-2 font-medium">Cycle</th>
                      <th className="text-right px-4 py-2 font-medium">Applied</th>
                      <th className="text-right px-4 py-2 font-medium">Failed</th>
                      <th className="text-right px-4 py-2 font-medium">Servers</th>
                      <th className="text-center px-4 py-2 font-medium">Status</th>
                      <th className="text-left px-4 py-2 font-medium">By</th>
                      <th className="px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {reports.map(r => {
                      const statusColors = {
                        completed: 'text-emerald-400 bg-emerald-900/20 border-emerald-700/50',
                        failed:    'text-red-400 bg-red-900/20 border-red-700/50',
                        partial:   'text-amber-400 bg-amber-900/20 border-amber-700/50',
                      }
                      return (
                        <tr key={r.id} className="border-b border-slate-700/50 hover:bg-slate-700/20">
                          <td className="px-4 py-2 text-slate-300">{r.created_at ? new Date(r.created_at).toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric'}) : '—'}</td>
                          <td className="px-4 py-2 text-slate-300">{(r.report_type || '').replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}</td>
                          <td className="px-4 py-2 text-slate-400">{r.group_name || '—'}</td>
                          <td className="px-4 py-2 text-slate-300">{r.cycle_name || '—'}</td>
                          <td className="px-4 py-2 text-right text-emerald-400 font-medium">{r.patches_applied}</td>
                          <td className="px-4 py-2 text-right">
                            <span className={r.patches_failed > 0 ? 'text-red-400 font-medium' : 'text-slate-400'}>{r.patches_failed}</span>
                          </td>
                          <td className="px-4 py-2 text-right text-slate-300">{r.servers_affected}</td>
                          <td className="px-4 py-2 text-center">
                            <span className={`px-2 py-0.5 rounded-full border text-xs font-medium ${statusColors[r.status] || 'text-slate-400 border-slate-600'}`}>
                              {(r.status || '').charAt(0).toUpperCase() + (r.status || '').slice(1)}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-slate-400">{r.created_by || '—'}</td>
                          <td className="px-2 py-2">
                            <button
                              onClick={async () => {
                                if (!window.confirm('Delete this report?')) return
                                try { await apiFetch(`/maintenance/reports/${r.id}`, { method: 'DELETE' }); loadReports() } catch (_) {}
                              }}
                              className="p-1 text-slate-500 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors"
                            >
                              <Trash2 size={12} />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
        </>
      )}

      {/* ── History Tab ───────────────────────────────────────────────────────── */}
      {!loading && activeTab === 'history' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">
              Maintenance History ({history.length} entries)
            </h2>
            <button
              onClick={loadHistory}
              disabled={historyLoading}
              className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors disabled:opacity-50"
            >
              {historyLoading
                ? <Loader2 size={14} className="animate-spin" />
                : <RefreshCw size={14} />}
              Refresh
            </button>
          </div>

          {historyLoading && history.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-slate-400">
              <Loader2 size={20} className="animate-spin mr-3" />
              Loading history…
            </div>
          ) : history.length === 0 ? (
            <div className="bg-slate-800/60 border border-slate-700 rounded-xl flex flex-col items-center gap-3 py-16">
              <History size={32} className="text-slate-600" />
              <div className="text-slate-400 text-sm">No maintenance history recorded yet.</div>
              <div className="text-slate-500 text-xs">Use "Log Maintenance" on a server within a cycle to record actions.</div>
            </div>
          ) : (
            <HistoryTable history={history} onRefresh={loadHistory} />
          )}
        </div>
      )}

      {/* Cycle Modal */}
      {showModal && (
        <CycleModal
          editingCycle={editingCycle}
          onClose={closeModal}
          onSaved={handleSaved}
        />
      )}

      {/* Notification Settings Modal */}
      {showNotifications && (
        <NotificationModal onClose={() => setShowNotifications(false)} />
      )}
    </div>
  )
}
