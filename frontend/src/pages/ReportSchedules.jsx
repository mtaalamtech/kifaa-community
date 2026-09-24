import { useState, useEffect, useCallback } from 'react'
import {
  Calendar, Plus, Pencil, Trash2, Play, Clock, Mail,
  FileText, CheckCircle, XCircle, RefreshCw, ChevronDown,
  FileDown, Send, Settings2, X
} from 'lucide-react'

const API = '/api/v1'
const token = () => localStorage.getItem('kifaa_token')
const hdrs = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` })

const DAYS_OF_WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const REPORT_TYPES = ['agents', 'monitors']
const FORMATS = ['pdf', 'csv', 'xlsx']
const FREQUENCIES = ['daily', 'weekly', 'monthly']
const STATUS_FILTERS = ['all', 'online', 'offline', 'warning']

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = [0, 15, 30, 45]

function pad(n) { return String(n).padStart(2, '0') }

function formatTime(h, m) {
  const ampm = h >= 12 ? 'PM' : 'AM'
  const hh = h % 12 || 12
  return `${hh}:${pad(m)} ${ampm}`
}

function formatNext(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function FrequencyBadge({ freq }) {
  const colors = {
    daily: 'bg-blue-900/50 text-blue-300 border-blue-700',
    weekly: 'bg-purple-900/50 text-purple-300 border-purple-700',
    monthly: 'bg-amber-900/50 text-amber-300 border-amber-700',
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium capitalize ${colors[freq] || 'bg-slate-800 text-slate-400'}`}>
      {freq}
    </span>
  )
}

function FormatBadge({ fmt }) {
  const colors = {
    pdf: 'bg-red-900/40 text-red-300',
    csv: 'bg-green-900/40 text-green-300',
    xlsx: 'bg-emerald-900/40 text-emerald-300',
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded font-mono uppercase ${colors[fmt] || 'bg-slate-800 text-slate-400'}`}>
      {fmt}
    </span>
  )
}

const DEFAULT_FORM = {
  name: '',
  report_type: 'agents',
  format: 'pdf',
  frequency: 'daily',
  hour: 8,
  minute: 0,
  day_of_week: 0,
  day_of_month: 1,
  email_to: '',
  channel_ids: [],
  status_filter: 'all',
  is_active: true,
}

function ScheduleModal({ schedule, onClose, onSaved }) {
  const isEdit = !!schedule
  const [form, setForm] = useState(isEdit ? {
    ...schedule,
    email_to: (schedule.email_to || []).join(', '),
  } : DEFAULT_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function save() {
    setError('')
    if (!form.name.trim()) { setError('Name is required'); return }
    setSaving(true)
    try {
      const emails = form.email_to
        .split(/[\s,]+/)
        .map(e => e.trim())
        .filter(Boolean)

      const body = {
        ...form,
        hour: parseInt(form.hour),
        minute: parseInt(form.minute),
        day_of_week: parseInt(form.day_of_week),
        day_of_month: parseInt(form.day_of_month),
        email_to: emails,
      }

      const url = isEdit ? `${API}/report-schedules/${schedule.id}` : `${API}/report-schedules`
      const method = isEdit ? 'PUT' : 'POST'
      const res = await fetch(url, { method, headers: hdrs(), body: JSON.stringify(body) })
      if (!res.ok) throw new Error(await res.text())
      onSaved()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-lg shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <div className="flex items-center gap-2 text-white font-semibold">
            <Calendar size={18} className="text-blue-400" />
            {isEdit ? 'Edit Schedule' : 'New Report Schedule'}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">×</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {error && <div className="bg-red-900/30 border border-red-700 text-red-300 text-sm px-3 py-2 rounded">{error}</div>}

          {/* Name */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Schedule Name *</label>
            <input
              value={form.name}
              onChange={e => set('name', e.target.value)}
              placeholder="e.g. Weekly Agent Summary"
              className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Report type + Format */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Report Type</label>
              <select
                value={form.report_type}
                onChange={e => set('report_type', e.target.value)}
                className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              >
                {REPORT_TYPES.map(t => (
                  <option key={t} value={t} className="capitalize">{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Format</label>
              <select
                value={form.format}
                onChange={e => set('format', e.target.value)}
                className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              >
                {FORMATS.map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}
              </select>
            </div>
          </div>

          {/* Status filter */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Status Filter</label>
            <select
              value={form.status_filter}
              onChange={e => set('status_filter', e.target.value)}
              className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
            >
              {STATUS_FILTERS.map(s => (
                <option key={s} value={s} className="capitalize">{s === 'all' ? 'All statuses' : s.charAt(0).toUpperCase() + s.slice(1) + ' only'}</option>
              ))}
            </select>
          </div>

          {/* Frequency */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Frequency</label>
            <div className="flex gap-2">
              {FREQUENCIES.map(f => (
                <button
                  key={f}
                  onClick={() => set('frequency', f)}
                  className={`flex-1 py-2 rounded text-sm font-medium capitalize transition-colors ${
                    form.frequency === f
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-900 border border-slate-600 text-slate-400 hover:text-white'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          {/* Day of week (weekly) */}
          {form.frequency === 'weekly' && (
            <div>
              <label className="block text-xs text-slate-400 mb-1">Day of Week</label>
              <select
                value={form.day_of_week}
                onChange={e => set('day_of_week', parseInt(e.target.value))}
                className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              >
                {DAYS_OF_WEEK.map((d, i) => <option key={i} value={i}>{d}</option>)}
              </select>
            </div>
          )}

          {/* Day of month (monthly) */}
          {form.frequency === 'monthly' && (
            <div>
              <label className="block text-xs text-slate-400 mb-1">Day of Month</label>
              <select
                value={form.day_of_month}
                onChange={e => set('day_of_month', parseInt(e.target.value))}
                className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              >
                {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                  <option key={d} value={d}>{d === 1 ? '1st' : d === 2 ? '2nd' : d === 3 ? '3rd' : `${d}th`}</option>
                ))}
              </select>
            </div>
          )}

          {/* Time */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Time (UTC)</label>
            <div className="flex gap-2">
              <select
                value={form.hour}
                onChange={e => set('hour', parseInt(e.target.value))}
                className="flex-1 bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              >
                {HOURS.map(h => (
                  <option key={h} value={h}>{pad(h)}:00</option>
                ))}
              </select>
              <select
                value={form.minute}
                onChange={e => set('minute', parseInt(e.target.value))}
                className="flex-1 bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              >
                {MINUTES.map(m => (
                  <option key={m} value={m}>:{pad(m)}</option>
                ))}
              </select>
            </div>
            <div className="text-xs text-slate-500 mt-1">
              Sends at {formatTime(form.hour, form.minute)} UTC
            </div>
          </div>

          {/* Email recipients */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Email Recipients</label>
            <textarea
              value={form.email_to}
              onChange={e => set('email_to', e.target.value)}
              placeholder="admin@company.com, ops@company.com"
              rows={2}
              className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 resize-none"
            />
            <div className="text-xs text-slate-500 mt-1">Separate multiple addresses with commas or newlines</div>
          </div>

          {/* Active toggle */}
          <label className="flex items-center gap-3 cursor-pointer">
            <div
              onClick={() => set('is_active', !form.is_active)}
              className={`w-10 h-6 rounded-full transition-colors relative ${form.is_active ? 'bg-blue-600' : 'bg-slate-600'}`}
            >
              <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${form.is_active ? 'left-5' : 'left-1'}`} />
            </div>
            <span className="text-sm text-slate-300">Schedule active</span>
          </label>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-700">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
          <button
            onClick={save}
            disabled={saving}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded-lg font-medium"
          >
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Schedule'}
          </button>
        </div>
      </div>
    </div>
  )
}

function WeeklyHealthReportCard({ showToast }) {
  const [recipients, setRecipients] = useState([])
  const [savedRecipients, setSavedRecipients] = useState([])
  const [inputEmail, setInputEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState(null)
  const [showConfig, setShowConfig] = useState(false)
  const [loadingPreview, setLoadingPreview] = useState(false)

  function loadConfig() {
    fetch(`${API}/report-schedules/weekly-health-report/config`, { headers: hdrs() })
      .then(r => r.json())
      .then(d => {
        const list = d.recipients || []
        setRecipients(list)
        setSavedRecipients(list)
      })
      .catch(() => {})
  }

  useEffect(() => { loadConfig() }, [])

  // Include any typed-but-not-added email when saving
  async function saveRecipients() {
    const extra = inputEmail.trim().toLowerCase()
    const finalList = extra && extra.includes('@') && !recipients.includes(extra)
      ? [...recipients, extra]
      : recipients
    setSaving(true)
    try {
      const res = await fetch(`${API}/report-schedules/weekly-health-report/config`, {
        method: 'PUT', headers: hdrs(),
        body: JSON.stringify({ recipients: finalList }),
      })
      if (!res.ok) throw new Error()
      setRecipients(finalList)
      setSavedRecipients(finalList)
      setInputEmail('')
      showToast(`Saved ${finalList.length} recipient${finalList.length !== 1 ? 's' : ''}`)
      setShowConfig(false)
    } catch {
      showToast('Failed to save recipients', 'error')
    } finally { setSaving(false) }
  }

  function cancelConfig() {
    setRecipients(savedRecipients)
    setInputEmail('')
    setShowConfig(false)
  }

  async function sendNow() {
    setSending(true)
    try {
      const res = await fetch(`${API}/report-schedules/weekly-health-report/send-now`, {
        method: 'POST', headers: hdrs(),
      })
      if (!res.ok) throw new Error()
      showToast('Report queued — will be emailed shortly')
    } catch {
      showToast('Failed to queue report', 'error')
    } finally { setSending(false) }
  }

  async function loadPreview() {
    setLoadingPreview(true)
    try {
      const res = await fetch(`${API}/report-schedules/weekly-health-report/preview`, { headers: hdrs() })
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail || 'Preview failed') }
      const d = await res.json()
      setPreview(d)
    } catch (e) {
      showToast(e.message || 'Preview failed', 'error')
    } finally { setLoadingPreview(false) }
  }

  function addEmail() {
    const e = inputEmail.trim().toLowerCase()
    if (!e || !e.includes('@')) return
    if (!recipients.includes(e)) setRecipients(p => [...p, e])
    setInputEmail('')
  }

  const hasUnsaved = showConfig && (
    inputEmail.trim().includes('@') ||
    JSON.stringify(recipients) !== JSON.stringify(savedRecipients)
  )

  return (
    <div className="bg-slate-800 border border-blue-500/30 rounded-xl p-5">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-600/20 rounded-lg">
            <FileDown size={20} className="text-blue-400" />
          </div>
          <div>
            <h2 className="text-white font-semibold">Weekly Server Health Status Report</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Word document report (.docx) — auto-sent every <span className="text-slate-300">Monday at 08:00 EAT</span>
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={loadingPreview ? null : loadPreview}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg"
          >
            <RefreshCw size={13} className={loadingPreview ? 'animate-spin' : ''} />
            Preview Data
          </button>
          <button
            onClick={() => { setShowConfig(v => !v); if (showConfig) cancelConfig() }}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg ${
              showConfig ? 'bg-blue-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
            }`}
          >
            <Settings2 size={13} />
            Recipients {savedRecipients.length > 0 && `(${savedRecipients.length})`}
          </button>
          <button
            onClick={sendNow}
            disabled={sending || savedRecipients.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-medium"
          >
            <Send size={13} className={sending ? 'animate-pulse' : ''} />
            {sending ? 'Queuing…' : 'Send Now'}
          </button>
        </div>
      </div>

      {/* Recipients config panel */}
      {showConfig && (
        <div className="mb-4 p-4 bg-slate-700/50 rounded-lg border border-slate-600">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-slate-300 font-medium">Email Recipients</span>
            {/* Save/Cancel always at top — always visible */}
            <div className="flex gap-2">
              <button
                onClick={saveRecipients}
                disabled={saving}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded-lg disabled:opacity-50 font-medium"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={cancelConfig}
                className="px-3 py-1.5 bg-slate-600 hover:bg-slate-500 text-white text-xs rounded-lg"
              >
                Cancel
              </button>
            </div>
          </div>

          {/* Current recipients */}
          {recipients.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {recipients.map(r => (
                <span key={r} className="flex items-center gap-1 px-2 py-1 bg-blue-900/40 border border-blue-700/40 text-blue-300 text-xs rounded-full">
                  <Mail size={10} />
                  {r}
                  <button
                    onClick={() => setRecipients(p => p.filter(x => x !== r))}
                    className="ml-1 hover:text-red-400"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Add email input */}
          <div className="flex gap-2">
            <input
              type="email"
              value={inputEmail}
              onChange={e => setInputEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addEmail()}
              placeholder="manager@company.com"
              className="flex-1 bg-slate-800 border border-slate-600 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={addEmail}
              disabled={!inputEmail.trim().includes('@')}
              className="px-3 py-2 bg-slate-600 hover:bg-slate-500 disabled:opacity-40 text-white text-sm rounded-lg"
            >
              Add
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-2">
            Press Enter or click Add, then Save. You can add multiple addresses.
          </p>
        </div>
      )}

      {/* Preview panel */}
      {preview && (
        <div className="mt-3 p-4 bg-slate-700/30 rounded-lg border border-slate-600 text-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-slate-300 font-medium">Report Preview — {preview.period}</span>
            <button onClick={() => setPreview(null)} className="text-xs text-slate-500 hover:text-slate-400">Dismiss</button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Servers', value: preview.agent_count, color: 'text-white' },
              { label: 'Healthy', value: preview.summary?.healthy, color: 'text-green-400' },
              { label: 'Warning', value: preview.summary?.warning, color: 'text-amber-400' },
              { label: 'Critical', value: preview.summary?.critical, color: 'text-red-400' },
              { label: 'Availability', value: `${preview.summary?.availability}%`, color: 'text-blue-400' },
              { label: 'Alerts (week)', value: preview.alert_count, color: 'text-orange-400' },
              { label: 'Compliance', value: `${preview.compliance?.overall}%`, color: 'text-purple-400' },
              { label: 'Risks', value: preview.risk_count, color: 'text-slate-300' },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-slate-800 rounded-lg p-3">
                <div className={`text-lg font-bold ${color}`}>{value ?? '–'}</div>
                <div className="text-xs text-slate-400">{label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Info row */}
      <div className="mt-3 flex items-center gap-4 text-xs text-slate-500">
        <span className={`flex items-center gap-1 ${savedRecipients.length > 0 ? 'text-green-500' : 'text-amber-500'}`}>
          <Mail size={12} />
          {savedRecipients.length > 0
            ? `${savedRecipients.length} recipient${savedRecipients.length !== 1 ? 's' : ''} configured`
            : 'No recipients — click Recipients to add'}
        </span>
        <span className="flex items-center gap-1"><Clock size={12} /> Auto-sends Monday 08:00 EAT</span>
        <span className="flex items-center gap-1"><FileText size={12} /> .docx</span>
      </div>
    </div>
  )
}

export default function ReportSchedules() {
  const [schedules, setSchedules] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editTarget, setEditTarget] = useState(null)
  const [runningId, setRunningId] = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const [toast, setToast] = useState(null)

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/report-schedules`, { headers: hdrs() })
      if (res.ok) setSchedules(await res.json())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function runNow(s) {
    setRunningId(s.id)
    try {
      const res = await fetch(`${API}/report-schedules/${s.id}/run-now`, { method: 'POST', headers: hdrs() })
      if (!res.ok) throw new Error()
      showToast(`"${s.name}" queued — report will be emailed shortly`)
    } catch {
      showToast('Failed to queue report', 'error')
    } finally {
      setRunningId(null)
    }
  }

  async function del(s) {
    if (!confirm(`Delete schedule "${s.name}"?`)) return
    setDeletingId(s.id)
    try {
      await fetch(`${API}/report-schedules/${s.id}`, { method: 'DELETE', headers: hdrs() })
      setSchedules(p => p.filter(x => x.id !== s.id))
      showToast('Schedule deleted')
    } catch {
      showToast('Delete failed', 'error')
    } finally {
      setDeletingId(null)
    }
  }

  async function toggleActive(s) {
    try {
      const res = await fetch(`${API}/report-schedules/${s.id}`, {
        method: 'PUT',
        headers: hdrs(),
        body: JSON.stringify({ is_active: !s.is_active }),
      })
      if (!res.ok) throw new Error()
      setSchedules(p => p.map(x => x.id === s.id ? { ...x, is_active: !x.is_active } : x))
    } catch {
      showToast('Update failed', 'error')
    }
  }

  function openCreate() { setEditTarget(null); setShowModal(true) }
  function openEdit(s) { setEditTarget(s); setShowModal(true) }

  function onSaved() {
    setShowModal(false)
    load()
    showToast(editTarget ? 'Schedule updated' : 'Schedule created')
  }

  const activeCount = schedules.filter(s => s.is_active).length

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Calendar size={22} className="text-blue-400" />
            Report Schedules
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">Automate report delivery via email on a recurring schedule</p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg font-medium"
        >
          <Plus size={16} />
          New Schedule
        </button>
      </div>

      {/* Weekly Health Report Card */}
      <WeeklyHealthReportCard showToast={showToast} />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Total Schedules', value: schedules.length, color: 'text-white' },
          { label: 'Active', value: activeCount, color: 'text-green-400' },
          { label: 'Paused', value: schedules.length - activeCount, color: 'text-slate-400' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <div className={`text-2xl font-bold ${color}`}>{value}</div>
            <div className="text-xs text-slate-400 mt-1">{label}</div>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
        {loading ? (
          <div className="text-center text-slate-400 py-16">Loading schedules…</div>
        ) : schedules.length === 0 ? (
          <div className="text-center py-16">
            <Calendar size={40} className="text-slate-600 mx-auto mb-3" />
            <div className="text-slate-400 text-sm">No schedules yet</div>
            <div className="text-slate-500 text-xs mt-1">Create one to start sending automated reports</div>
            <button
              onClick={openCreate}
              className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg"
            >
              Create First Schedule
            </button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-xs text-slate-400">
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">Report</th>
                <th className="text-left px-4 py-3 font-medium">Frequency</th>
                <th className="text-left px-4 py-3 font-medium">Time (UTC)</th>
                <th className="text-left px-4 py-3 font-medium">Next Run</th>
                <th className="text-left px-4 py-3 font-medium">Last Run</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-left px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {schedules.map(s => (
                <tr key={s.id} className="hover:bg-slate-700/30 transition-colors">
                  {/* Name */}
                  <td className="px-4 py-3">
                    <div className="font-medium text-white">{s.name}</div>
                    {s.email_to?.length > 0 && (
                      <div className="flex items-center gap-1 text-xs text-slate-500 mt-0.5">
                        <Mail size={11} />
                        {s.email_to.length === 1 ? s.email_to[0] : `${s.email_to[0]} +${s.email_to.length - 1} more`}
                      </div>
                    )}
                  </td>

                  {/* Report type + format */}
                  <td className="px-4 py-3">
                    <div className="capitalize text-slate-300">{s.report_type}</div>
                    <div className="mt-0.5">
                      <FormatBadge fmt={s.format} />
                    </div>
                  </td>

                  {/* Frequency */}
                  <td className="px-4 py-3">
                    <FrequencyBadge freq={s.frequency} />
                    {s.frequency === 'weekly' && (
                      <div className="text-xs text-slate-500 mt-0.5">{DAYS_OF_WEEK[s.day_of_week || 0]}</div>
                    )}
                    {s.frequency === 'monthly' && (
                      <div className="text-xs text-slate-500 mt-0.5">Day {s.day_of_month}</div>
                    )}
                  </td>

                  {/* Time */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 text-slate-300">
                      <Clock size={13} className="text-slate-500" />
                      {formatTime(s.hour, s.minute)}
                    </div>
                  </td>

                  {/* Next run */}
                  <td className="px-4 py-3 text-slate-300 text-xs">
                    {s.is_active ? formatNext(s.next_run) : <span className="text-slate-600">Paused</span>}
                  </td>

                  {/* Last run */}
                  <td className="px-4 py-3 text-slate-400 text-xs">
                    {formatNext(s.last_run)}
                  </td>

                  {/* Status toggle */}
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleActive(s)}
                      title={s.is_active ? 'Pause schedule' : 'Activate schedule'}
                    >
                      {s.is_active
                        ? <CheckCircle size={18} className="text-green-400 hover:text-green-300" />
                        : <XCircle size={18} className="text-slate-500 hover:text-slate-400" />}
                    </button>
                  </td>

                  {/* Actions */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => runNow(s)}
                        disabled={runningId === s.id}
                        title="Run now"
                        className="p-1.5 rounded text-slate-400 hover:text-green-400 hover:bg-slate-700 disabled:opacity-40 transition-colors"
                      >
                        {runningId === s.id
                          ? <RefreshCw size={15} className="animate-spin" />
                          : <Play size={15} />}
                      </button>
                      <button
                        onClick={() => openEdit(s)}
                        title="Edit"
                        className="p-1.5 rounded text-slate-400 hover:text-yellow-400 hover:bg-slate-700 transition-colors"
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        onClick={() => del(s)}
                        disabled={deletingId === s.id}
                        title="Delete"
                        className="p-1.5 rounded text-slate-400 hover:text-red-400 hover:bg-slate-700 disabled:opacity-40 transition-colors"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Info box */}
      <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4 flex gap-3 text-sm text-slate-400">
        <FileText size={18} className="text-blue-400 flex-shrink-0 mt-0.5" />
        <div>
          <div className="text-slate-300 font-medium mb-1">How scheduled reports work</div>
          <ul className="space-y-0.5 text-xs">
            <li>• Kifaa checks for due schedules every 5 minutes</li>
            <li>• Reports are generated server-side and attached to the email</li>
            <li>• Emails are sent using the SMTP notification channel configured in Settings</li>
            <li>• Use "Run Now" to send a report immediately without waiting for the schedule</li>
          </ul>
        </div>
      </div>

      {/* Modal */}
      {showModal && (
        <ScheduleModal
          schedule={editTarget}
          onClose={() => setShowModal(false)}
          onSaved={onSaved}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 px-4 py-3 rounded-lg shadow-xl text-sm font-medium z-50 ${
          toast.type === 'error' ? 'bg-red-600 text-white' : 'bg-green-600 text-white'
        }`}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
