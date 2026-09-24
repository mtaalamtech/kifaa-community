import { useState, useEffect, useCallback } from 'react'
import {
  Settings2, Database, Bell, Shield, Save, Play, Trash2,
  Plus, X, CheckCircle2, XCircle, ChevronRight, RefreshCw,
  Mail, MessageSquare, Webhook, Send, Eye, EyeOff, Download,
  KeyRound, Pencil, Monitor, Server,
} from 'lucide-react'
import api from '../api/client'

const TABS = [
  { id: 'profile',       label: 'Profile',       icon: KeyRound },
  { id: 'general',       label: 'General',       icon: Settings2 },
  { id: 'backup',        label: 'Backup',        icon: Database },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'security',      label: 'Security',      icon: Shield },
  { id: 'credentials',   label: 'Credentials',   icon: KeyRound },
]

const CHANNEL_TYPES = [
  { value: 'smtp',             label: 'Email (SMTP)',      icon: Mail },
  { value: 'telegram',         label: 'Telegram',          icon: Send },
  { value: 'webhook_teams',    label: 'Microsoft Teams',   icon: MessageSquare },
  { value: 'webhook_slack',    label: 'Slack',             icon: MessageSquare },
  { value: 'webhook_generic',  label: 'Generic Webhook',   icon: Webhook },
]

function TabBar({ active, onChange }) {
  return (
    <div className="flex gap-1 bg-slate-800 border border-slate-700 rounded-xl p-1 mb-6">
      {TABS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors flex-1 justify-center
            ${active === id ? 'bg-blue-600 text-white font-medium' : 'text-slate-400 hover:text-white'}`}
        >
          <Icon size={15} />
          {label}
        </button>
      ))}
    </div>
  )
}

function SectionCard({ title, children, action }) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl">
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="text-xs font-medium text-slate-300 block mb-1">{label}</label>
      {hint && <p className="text-xs text-slate-500 mb-1">{hint}</p>}
      {children}
    </div>
  )
}

const inputCls = "w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
const selectCls = "w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"

// ─── General Tab ──────────────────────────────────────────────────────────────
function GeneralTab({ settings, onSave }) {
  const [form, setForm] = useState(settings)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  return (
    <div className="space-y-5">
      <SectionCard title="Platform">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Platform Name">
            <input value={form.platform_name || ''} onChange={e => set('platform_name', e.target.value)} className={inputCls} />
          </Field>
          <Field label="Default Timezone">
            <select value={form.timezone || 'UTC'} onChange={e => set('timezone', e.target.value)} className={selectCls}>
              <option value="UTC">UTC</option>
              <option value="Africa/Nairobi">Africa/Nairobi (EAT)</option>
              <option value="America/New_York">America/New_York (EST)</option>
              <option value="America/Chicago">America/Chicago (CST)</option>
              <option value="America/Los_Angeles">America/Los_Angeles (PST)</option>
              <option value="Europe/London">Europe/London (GMT)</option>
              <option value="Europe/Berlin">Europe/Berlin (CET)</option>
              <option value="Asia/Dubai">Asia/Dubai (GST)</option>
            </select>
          </Field>
        </div>
      </SectionCard>

      <SectionCard title="Agents">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Offline Threshold (minutes)" hint="Mark agent offline after this many minutes without heartbeat">
            <input type="number" min="1" max="60" value={form.agent_offline_minutes || 5}
              onChange={e => set('agent_offline_minutes', parseInt(e.target.value) || 5)} className={inputCls} />
          </Field>
          <Field label="Metrics Retention (days)" hint="How long to keep time-series metric data">
            <input type="number" min="7" max="365" value={form.data_retention_days || 90}
              onChange={e => set('data_retention_days', parseInt(e.target.value) || 90)} className={inputCls} />
          </Field>
        </div>
      </SectionCard>

      <SectionCard title="Certificate Defaults">
        <p className="text-xs text-slate-500 mb-4">Pre-filled values when generating a new CSR. All fields are optional and can be changed at creation time.</p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Organization">
            <input value={form.csr_organization || ''} onChange={e => set('csr_organization', e.target.value)}
              className={inputCls} placeholder="KenyaNut Ltd" />
          </Field>
          <Field label="Org Unit">
            <input value={form.csr_org_unit || ''} onChange={e => set('csr_org_unit', e.target.value)}
              className={inputCls} placeholder="IT" />
          </Field>
          <Field label="Country (2-letter)">
            <input value={form.csr_country || ''} onChange={e => set('csr_country', e.target.value)}
              className={inputCls} maxLength={2} placeholder="KE" />
          </Field>
          <Field label="State / Province">
            <input value={form.csr_state || ''} onChange={e => set('csr_state', e.target.value)}
              className={inputCls} placeholder="Nairobi" />
          </Field>
          <Field label="City / Locality">
            <input value={form.csr_city || ''} onChange={e => set('csr_city', e.target.value)}
              className={inputCls} placeholder="Nairobi" />
          </Field>
          <Field label="Email">
            <input type="email" value={form.csr_email || ''} onChange={e => set('csr_email', e.target.value)}
              className={inputCls} placeholder="admin@example.com" />
          </Field>
        </div>
      </SectionCard>

      <div className="flex justify-end">
        <button onClick={() => onSave('general', form)}
          className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors">
          <Save size={14} /> Save General Settings
        </button>
      </div>
    </div>
  )
}

// ─── Backup Tab ───────────────────────────────────────────────────────────────
function BackupTab({ settings, onSave }) {
  const [form, setForm] = useState(settings)
  const [history, setHistory] = useState([])
  const [running, setRunning] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(true)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true)
    try {
      const r = await api.get('/settings/backup/history')
      setHistory(r.data)
    } finally {
      setLoadingHistory(false)
    }
  }, [])

  useEffect(() => { loadHistory() }, [loadHistory])

  async function runNow() {
    setRunning(true)
    try {
      await api.post('/settings/backup/run')
      setTimeout(loadHistory, 3000)
    } finally {
      setRunning(false)
    }
  }

  async function deleteBackup(id) {
    if (!confirm('Delete this backup record and file?')) return
    await api.delete(`/settings/backup/${id}`)
    loadHistory()
  }

  function formatBytes(b) {
    if (!b) return '—'
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
    return `${(b / 1024 / 1024).toFixed(1)} MB`
  }

  const statusBadge = (s) => {
    const map = {
      success: 'bg-green-900/50 text-green-300 border border-green-800',
      failed:  'bg-red-900/50 text-red-300 border border-red-800',
      running: 'bg-blue-900/50 text-blue-300 border border-blue-800',
    }
    return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${map[s] || 'bg-slate-700 text-slate-400'}`}>{s}</span>
  }

  return (
    <div className="space-y-5">
      <SectionCard title="Backup Configuration">
        <div className="space-y-4">
          <div className="flex items-center gap-8">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.enabled ?? true}
                onChange={e => set('enabled', e.target.checked)} className="w-4 h-4" />
              <span className="text-sm text-slate-300">Enable backups</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.auto_backup ?? true}
                onChange={e => set('auto_backup', e.target.checked)} className="w-4 h-4" />
              <span className="text-sm text-slate-300">Auto backup every 4 hours</span>
              <span className="text-xs text-slate-500">(dev mode)</span>
            </label>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <Field label="Daily Backup Time (UTC hour)" hint="Hour 0-23 to run the daily scheduled backup">
              <input type="number" min="0" max="23" value={form.scheduled_hour ?? 2}
                onChange={e => set('scheduled_hour', parseInt(e.target.value))} className={inputCls} />
            </Field>
            <Field label="Retention (days)" hint="Delete backups older than this">
              <input type="number" min="1" max="365" value={form.retention_days ?? 30}
                onChange={e => set('retention_days', parseInt(e.target.value) || 30)} className={inputCls} />
            </Field>
            <Field label="Backup Path" hint="Directory inside the container">
              <input value={form.backup_path || '/app/backups'} onChange={e => set('backup_path', e.target.value)} className={inputCls} />
            </Field>
          </div>
        </div>
      </SectionCard>

      <div className="flex justify-between items-center">
        <button onClick={runNow} disabled={running}
          className="flex items-center gap-2 px-4 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-sm rounded-lg transition-colors">
          {running ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />}
          Run Backup Now
        </button>
        <button onClick={() => onSave('backup', form)}
          className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors">
          <Save size={14} /> Save Backup Settings
        </button>
      </div>

      <SectionCard title="Backup History"
        action={<button onClick={loadHistory} className="text-slate-400 hover:text-white"><RefreshCw size={14} /></button>}>
        {loadingHistory ? (
          <div className="text-slate-400 text-sm">Loading...</div>
        ) : history.length === 0 ? (
          <div className="text-slate-500 text-sm py-4 text-center">No backups yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-400 border-b border-slate-700">
                <th className="pb-2 text-left">Filename</th>
                <th className="pb-2 text-left">Trigger</th>
                <th className="pb-2 text-left">Size</th>
                <th className="pb-2 text-left">Status</th>
                <th className="pb-2 text-left">Started</th>
                <th className="pb-2 text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {history.map(b => (
                <tr key={b.id} className="group">
                  <td className="py-2 font-mono text-xs text-slate-300">{b.filename || '—'}</td>
                  <td className="py-2 text-xs text-slate-400 capitalize">{b.trigger}</td>
                  <td className="py-2 text-xs text-slate-400">{formatBytes(b.size_bytes)}</td>
                  <td className="py-2">{statusBadge(b.status)}</td>
                  <td className="py-2 text-xs text-slate-500">{b.started_at ? new Date(b.started_at).toLocaleString() : '—'}</td>
                  <td className="py-2 text-right">
                    <button onClick={() => deleteBackup(b.id)}
                      className="opacity-0 group-hover:opacity-100 p-1 text-slate-500 hover:text-red-400 transition">
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>
    </div>
  )
}

// ─── Notification Channel Form ─────────────────────────────────────────────────
function ChannelForm({ channel, onClose, onSaved }) {
  const isEdit = !!channel
  const [form, setForm] = useState(isEdit ? {
    name: channel.name, type: channel.type,
    is_active: channel.is_active, config: { ...channel.config },
  } : { name: '', type: 'smtp', is_active: true, config: {} })
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [saving, setSaving] = useState(false)
  const [showSecret, setShowSecret] = useState(false)

  const setConfig = (k, v) => setForm(f => ({ ...f, config: { ...f.config, [k]: v } }))
  const cfg = form.config

  async function save() {
    setSaving(true)
    try {
      if (isEdit) {
        await api.put(`/settings/notifications/${channel.id}`, form)
      } else {
        await api.post('/settings/notifications', form)
      }
      onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  async function test() {
    setTesting(true)
    setTestResult(null)
    try {
      if (isEdit) {
        await api.post(`/settings/notifications/${channel.id}/test`)
      } else {
        // Test inline using current form values without saving
        await api.post('/settings/notifications/test-inline', { type: form.type, config: form.config })
      }
      setTestResult({ ok: true, msg: 'Test notification sent successfully.' })
    } catch (e) {
      setTestResult({ ok: false, msg: e.response?.data?.detail || 'Failed to send test.' })
    } finally {
      setTesting(false)
    }
  }

  function renderFields() {
    if (form.type === 'smtp') return (
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <Field label="SMTP Host"><input value={cfg.host || ''} onChange={e => setConfig('host', e.target.value)} className={inputCls} placeholder="smtp.gmail.com" /></Field>
          </div>
          <Field label="Port"><input type="number" value={cfg.port || 587} onChange={e => setConfig('port', parseInt(e.target.value))} className={inputCls} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Username"><input value={cfg.username || ''} onChange={e => setConfig('username', e.target.value)} className={inputCls} /></Field>
          <Field label="Password">
            <div className="relative">
              <input type={showSecret ? 'text' : 'password'} value={cfg.password || ''} onChange={e => setConfig('password', e.target.value)} className={inputCls + ' pr-9'} />
              <button type="button" onClick={() => setShowSecret(s => !s)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400">{showSecret ? <EyeOff size={14} /> : <Eye size={14} />}</button>
            </div>
          </Field>
        </div>
        <Field label="From Address"><input value={cfg.from_address || ''} onChange={e => setConfig('from_address', e.target.value)} className={inputCls} placeholder="alerts@yourdomain.com" /></Field>
        <Field label="To Addresses" hint="Comma-separated list of recipient emails">
          <input value={Array.isArray(cfg.to_addresses) ? cfg.to_addresses.join(', ') : (cfg.to_addresses || '')}
            onChange={e => setConfig('to_addresses', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
            className={inputCls} placeholder="admin@company.com, ops@company.com" />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
          <input type="checkbox" checked={cfg.use_tls ?? true} onChange={e => setConfig('use_tls', e.target.checked)} />
          Use TLS/STARTTLS
        </label>
      </div>
    )

    if (form.type === 'telegram') return (
      <div className="space-y-3">
        <Field label="Bot Token" hint="Create a bot via @BotFather and paste the token here">
          <div className="relative">
            <input type={showSecret ? 'text' : 'password'} value={cfg.bot_token || ''} onChange={e => setConfig('bot_token', e.target.value)} className={inputCls + ' pr-9'} placeholder="123456:ABC-DEF..." />
            <button type="button" onClick={() => setShowSecret(s => !s)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400">{showSecret ? <EyeOff size={14} /> : <Eye size={14} />}</button>
          </div>
        </Field>
        <Field label="Chat ID" hint="The chat or group ID to send messages to. Use @userinfobot to find yours.">
          <input value={cfg.chat_id || ''} onChange={e => setConfig('chat_id', e.target.value)} className={inputCls} placeholder="-1001234567890" />
        </Field>
      </div>
    )

    if (form.type === 'webhook_teams') return (
      <div className="space-y-3">
        <Field label="Incoming Webhook URL" hint="From Teams → Channel → Connectors → Incoming Webhook">
          <input value={cfg.url || ''} onChange={e => setConfig('url', e.target.value)} className={inputCls} placeholder="https://outlook.office.com/webhook/..." />
        </Field>
      </div>
    )

    if (form.type === 'webhook_slack') return (
      <div className="space-y-3">
        <Field label="Incoming Webhook URL" hint="From Slack App → Incoming Webhooks → Add New Webhook">
          <input value={cfg.url || ''} onChange={e => setConfig('url', e.target.value)} className={inputCls} placeholder="https://hooks.slack.com/services/..." />
        </Field>
      </div>
    )

    if (form.type === 'webhook_generic') return (
      <div className="space-y-3">
        <Field label="Webhook URL">
          <input value={cfg.url || ''} onChange={e => setConfig('url', e.target.value)} className={inputCls} placeholder="https://your-system.com/webhook" />
        </Field>
        <Field label="Custom Headers (JSON)" hint='Optional. e.g. {"Authorization": "Bearer token"}'>
          <textarea value={typeof cfg.headers === 'object' ? JSON.stringify(cfg.headers) : (cfg.headers || '')}
            onChange={e => setConfig('headers', e.target.value)}
            className={inputCls + ' h-20 resize-none font-mono text-xs'} placeholder='{"X-Api-Key": "your-key"}' />
        </Field>
      </div>
    )

    return null
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-slate-700">
          <h2 className="font-semibold text-white">{isEdit ? 'Edit' : 'New'} Notification Channel</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className={inputCls} placeholder="e.g. Ops Team Email" />
            </Field>
            <Field label="Type">
              <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value, config: {} }))} className={selectCls}>
                {CHANNEL_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
          </div>

          {renderFields()}

          <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
            <input type="checkbox" checked={form.is_active} onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} />
            Active
          </label>

          {testResult && (
            <div className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg ${testResult.ok ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'}`}>
              {testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
              {testResult.msg}
            </div>
          )}
        </div>
        <div className="flex justify-between gap-3 p-5 border-t border-slate-700">
          <button onClick={test} disabled={testing}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white rounded-lg transition-colors">
            {testing ? <RefreshCw size={13} className="animate-spin" /> : <Send size={13} />} Test
          </button>
          <div className="flex gap-3">
            <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
            <button onClick={save} disabled={!form.name || saving}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded-lg transition-colors">
              {saving ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
              {isEdit ? 'Save' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Notifications Tab ────────────────────────────────────────────────────────
function NotificationsTab() {
  const [channels, setChannels] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState(null)

  const load = useCallback(async () => {
    try {
      const r = await api.get('/settings/notifications')
      setChannels(r.data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function deleteChannel(id) {
    if (!confirm('Delete this notification channel?')) return
    await api.delete(`/settings/notifications/${id}`)
    load()
  }

  const typeLabel = (t) => CHANNEL_TYPES.find(x => x.value === t)?.label || t

  const typeIcon = (t) => {
    if (t === 'smtp') return <Mail size={14} className="text-blue-400" />
    if (t === 'telegram') return <Send size={14} className="text-sky-400" />
    if (t === 'webhook_teams') return <MessageSquare size={14} className="text-purple-400" />
    if (t === 'webhook_slack') return <MessageSquare size={14} className="text-yellow-400" />
    return <Webhook size={14} className="text-slate-400" />
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400">Configure where alerts and system notifications are sent.</p>
        <button onClick={() => { setEditing(null); setShowForm(true) }}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors">
          <Plus size={14} /> Add Channel
        </button>
      </div>

      {loading ? (
        <div className="text-slate-400 text-sm">Loading...</div>
      ) : channels.length === 0 ? (
        <div className="bg-slate-800 border border-slate-700 rounded-xl py-16 text-center">
          <Bell size={36} className="mx-auto mb-3 text-slate-600" />
          <p className="text-slate-400 text-sm">No notification channels configured.</p>
          <button onClick={() => { setEditing(null); setShowForm(true) }}
            className="mt-3 text-blue-400 hover:text-blue-300 text-sm">Add your first channel</button>
        </div>
      ) : (
        <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-400 border-b border-slate-700">
                <th className="px-5 py-3 text-left">Name</th>
                <th className="px-5 py-3 text-left">Type</th>
                <th className="px-5 py-3 text-left">Status</th>
                <th className="px-5 py-3 text-left">Created</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {channels.map(ch => (
                <tr key={ch.id} className="group hover:bg-slate-750">
                  <td className="px-5 py-3 font-medium text-white">{ch.name}</td>
                  <td className="px-5 py-3">
                    <span className="flex items-center gap-1.5 text-slate-300">{typeIcon(ch.type)} {typeLabel(ch.type)}</span>
                  </td>
                  <td className="px-5 py-3">
                    {ch.is_active
                      ? <span className="text-xs text-green-400 flex items-center gap-1"><CheckCircle2 size={12} /> Active</span>
                      : <span className="text-xs text-slate-500 flex items-center gap-1"><XCircle size={12} /> Disabled</span>}
                  </td>
                  <td className="px-5 py-3 text-xs text-slate-500">{ch.created_at ? new Date(ch.created_at).toLocaleDateString() : '—'}</td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => { setEditing(ch); setShowForm(true) }}
                        className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 text-white rounded-lg">Edit</button>
                      <button onClick={() => deleteChannel(ch.id)}
                        className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-slate-700 rounded-lg">
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

      {showForm && (
        <ChannelForm
          channel={editing}
          onClose={() => setShowForm(false)}
          onSaved={load}
        />
      )}
    </div>
  )
}

// ─── Security Tab ─────────────────────────────────────────────────────────────
function SecurityTab({ settings, onSave }) {
  const [form, setForm] = useState(settings)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  return (
    <div className="space-y-5">
      <SectionCard title="Authentication">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Session Timeout (hours)" hint="Auto-logout after this many hours of inactivity">
            <input type="number" min="1" max="168" value={form.session_timeout_hours || 24}
              onChange={e => set('session_timeout_hours', parseInt(e.target.value) || 24)} className={inputCls} />
          </Field>
        </div>
      </SectionCard>

      <SectionCard title="Agent Registration">
        <div className="space-y-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={form.allow_agent_self_register ?? true}
              onChange={e => set('allow_agent_self_register', e.target.checked)} className="w-4 h-4" />
            <div>
              <span className="text-sm text-white">Allow agent self-registration</span>
              <p className="text-xs text-slate-500">Agents can register using the shared secret. Disable to require manual approval.</p>
            </div>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={form.require_2fa ?? false}
              onChange={e => set('require_2fa', e.target.checked)} className="w-4 h-4" />
            <div>
              <span className="text-sm text-white">Require 2FA</span>
              <p className="text-xs text-slate-500 italic">Coming soon — not yet enforced.</p>
            </div>
          </label>
        </div>
      </SectionCard>

      <div className="flex justify-end">
        <button onClick={() => onSave('security', form)}
          className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors">
          <Save size={14} /> Save Security Settings
        </button>
      </div>
    </div>
  )
}

// ─── Credentials Tab ─────────────────────────────────────────────────────────

const BLANK_CRED = {
  name: '', description: '', os_type: 'any',
  username: '', password: '', ssh_key: '', domain: '',
  port: '', use_sudo: false,
}

function CredModal({ cred, onClose, onSaved }) {
  const isEdit = !!cred
  const [form, setForm] = useState(isEdit ? {
    ...BLANK_CRED, ...cred, password: '', ssh_key: '',
  } : { ...BLANK_CRED })
  const [showPw, setShowPw] = useState(false)
  const [authMode, setAuthMode] = useState('password')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function save() {
    if (!form.name.trim() || !form.username.trim()) { setErr('Name and username are required'); return }
    setSaving(true); setErr(null)
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description,
        os_type: form.os_type,
        username: form.username.trim(),
        domain: form.domain || null,
        port: form.port ? parseInt(form.port) : null,
        use_sudo: form.use_sudo,
      }
      if (authMode === 'password' && form.password) payload.password = form.password
      if (authMode === 'key' && form.ssh_key) payload.ssh_key = form.ssh_key

      if (isEdit) {
        await api.put(`/credentials/${cred.id}`, payload)
      } else {
        await api.post('/credentials', payload)
      }
      onSaved()
    } catch (e) {
      setErr(e.response?.data?.detail || 'Save failed')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
          <h3 className="font-semibold text-white">{isEdit ? 'Edit Credential' : 'New Credential'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          {err && <div className="bg-red-900/40 border border-red-700 text-red-300 text-sm rounded-lg px-3 py-2">{err}</div>}

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-xs text-slate-400 mb-1 block">Credential Name *</label>
              <input value={form.name} onChange={e => set('name', e.target.value)}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="e.g. Linux Prod Admin" />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Target OS</label>
              <select value={form.os_type} onChange={e => set('os_type', e.target.value)}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
                <option value="any">Any</option>
                <option value="linux">Linux</option>
                <option value="windows">Windows</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Port <span className="text-slate-600">(optional)</span></label>
              <input type="number" value={form.port} onChange={e => set('port', e.target.value)}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none"
                placeholder="default" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Username *</label>
              <input value={form.username} onChange={e => set('username', e.target.value)}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none"
                placeholder="root / admin" autoComplete="off" />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Domain <span className="text-slate-600">(Windows)</span></label>
              <input value={form.domain} onChange={e => set('domain', e.target.value)}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none"
                placeholder="CORP or leave empty" />
            </div>
          </div>

          {form.os_type !== 'windows' && (
            <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-slate-300">
              <input type="checkbox" checked={form.use_sudo} onChange={e => set('use_sudo', e.target.checked)}
                className="w-4 h-4 rounded accent-blue-500" />
              Use sudo for privileged commands
            </label>
          )}

          <div>
            <label className="text-xs text-slate-400 mb-2 block">Authentication</label>
            <div className="flex gap-2 mb-3">
              {[['password', 'Password'], ['key', 'SSH Key']].map(([v, l]) => (
                <button key={v} onClick={() => setAuthMode(v)}
                  className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                    authMode === v ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-800 border-slate-600 text-slate-400 hover:text-white'
                  }`}>{l}</button>
              ))}
            </div>
            {authMode === 'password' ? (
              <div className="relative">
                <input type={showPw ? 'text' : 'password'} value={form.password}
                  onChange={e => set('password', e.target.value)}
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none pr-9"
                  placeholder={isEdit ? 'Leave blank to keep existing' : 'Password'} autoComplete="new-password" />
                <button onClick={() => setShowPw(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400">
                  {showPw ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            ) : (
              <textarea value={form.ssh_key} onChange={e => set('ssh_key', e.target.value)}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white font-mono h-24 resize-none focus:outline-none text-xs"
                placeholder={isEdit ? 'Leave blank to keep existing\n-----BEGIN ... KEY-----' : '-----BEGIN ... KEY-----'} />
            )}
          </div>

          <div>
            <label className="text-xs text-slate-400 mb-1 block">Description <span className="text-slate-600">(optional)</span></label>
            <input value={form.description} onChange={e => set('description', e.target.value)}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none"
              placeholder="e.g. Production Linux servers, sudo required" />
          </div>
        </div>
        <div className="px-5 pb-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white rounded-lg border border-slate-600 hover:border-slate-500">Cancel</button>
          <button onClick={save} disabled={saving}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg flex items-center gap-2">
            {saving ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
            {isEdit ? 'Update' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

function CredentialsTab() {
  const [creds, setCreds] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)

  const load = async () => {
    setLoading(true)
    try { const r = await api.get('/credentials'); setCreds(r.data) }
    catch (e) { console.error(e) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  async function del(id) {
    if (!confirm('Delete this credential?')) return
    await api.delete(`/credentials/${id}`)
    load()
  }

  const OS_ICON = { linux: <Server size={13} className="text-emerald-400" />, windows: <Monitor size={13} className="text-blue-400" />, any: <KeyRound size={13} className="text-slate-400" /> }
  const OS_LABEL = { linux: 'Linux', windows: 'Windows', any: 'Any OS' }

  return (
    <div className="space-y-4">
      <SectionCard title="Deployment Credentials"
        action={
          <button onClick={() => { setEditing(null); setShowModal(true) }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-lg">
            <Plus size={13} /> Add Credential
          </button>
        }>
        <p className="text-xs text-slate-500 mb-4">Saved credentials for agent deployment. Passwords are stored server-side and never returned to the browser after saving.</p>

        {loading ? (
          <div className="py-8 text-center text-slate-500 text-sm">Loading...</div>
        ) : creds.length === 0 ? (
          <div className="py-8 text-center text-slate-600 text-sm">No credentials yet — add one to use in agent deployment.</div>
        ) : (
          <div className="space-y-2">
            {creds.map(c => (
              <div key={c.id} className="flex items-center gap-3 bg-slate-900 border border-slate-700 rounded-lg px-4 py-3">
                <div className="flex-shrink-0">{OS_ICON[c.os_type] || OS_ICON.any}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-white text-sm">{c.name}</span>
                    <span className="text-xs text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">{OS_LABEL[c.os_type]}</span>
                    {c.use_sudo && <span className="text-xs text-amber-400 bg-amber-900/30 border border-amber-700/40 px-1.5 py-0.5 rounded">sudo</span>}
                    {c.has_password && <span className="text-xs text-slate-500">password</span>}
                    {c.has_ssh_key && <span className="text-xs text-slate-500">SSH key</span>}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {c.domain ? `${c.domain}\\${c.username}` : c.username}
                    {c.port ? ` · port ${c.port}` : ''}
                    {c.description ? ` · ${c.description}` : ''}
                  </div>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => { setEditing(c); setShowModal(true) }}
                    className="p-1.5 text-slate-400 hover:text-blue-400 hover:bg-slate-700 rounded-lg">
                    <Pencil size={13} />
                  </button>
                  <button onClick={() => del(c.id)}
                    className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-slate-700 rounded-lg">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {showModal && (
        <CredModal
          cred={editing}
          onClose={() => { setShowModal(false); setEditing(null) }}
          onSaved={() => { setShowModal(false); setEditing(null); load() }}
        />
      )}
    </div>
  )
}

// ─── Main Settings Page ───────────────────────────────────────────────────────
function ProfileTab() {
  const user = JSON.parse(localStorage.getItem('kifaa_user') || '{}')
  const [form, setForm] = useState({ current_password: '', new_password: '', confirm_password: '' })
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null) // { type: 'ok'|'err', text }
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNew, setShowNew] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (form.new_password !== form.confirm_password) {
      setMsg({ type: 'err', text: 'New passwords do not match' })
      return
    }
    if (form.new_password.length < 8) {
      setMsg({ type: 'err', text: 'New password must be at least 8 characters' })
      return
    }
    setSaving(true)
    setMsg(null)
    try {
      await api.put('/auth/me/password', {
        current_password: form.current_password,
        new_password: form.new_password,
      })
      setMsg({ type: 'ok', text: 'Password changed successfully' })
      setForm({ current_password: '', new_password: '', confirm_password: '' })
    } catch (err) {
      const detail = err.response?.data?.detail || 'Failed to change password'
      setMsg({ type: 'err', text: detail })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6 max-w-xl">
      {/* Account info */}
      <SectionCard title="Account Information">
        <div className="space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-slate-400">Username</span>
            <span className="text-white font-medium">{user.username}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-slate-400">Role</span>
            <span className="capitalize text-white font-medium">{user.role}</span>
          </div>
          {user.full_name && (
            <div className="flex justify-between text-sm">
              <span className="text-slate-400">Full name</span>
              <span className="text-white font-medium">{user.full_name}</span>
            </div>
          )}
        </div>
      </SectionCard>

      {/* Change password */}
      <SectionCard title="Change Password">
        <form onSubmit={handleSubmit} className="space-y-4">
          {msg && (
            <div className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg border ${
              msg.type === 'ok'
                ? 'bg-green-900/30 border-green-700 text-green-300'
                : 'bg-red-900/30 border-red-700 text-red-300'
            }`}>
              {msg.type === 'ok' ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
              {msg.text}
            </div>
          )}

          <Field label="Current Password">
            <div className="relative">
              <input
                type={showCurrent ? 'text' : 'password'}
                value={form.current_password}
                onChange={e => setForm(f => ({ ...f, current_password: e.target.value }))}
                required
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 pr-10"
              />
              <button type="button" onClick={() => setShowCurrent(v => !v)}
                className="absolute right-3 top-2.5 text-slate-400 hover:text-white">
                {showCurrent ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </Field>

          <Field label="New Password" hint="Minimum 8 characters">
            <div className="relative">
              <input
                type={showNew ? 'text' : 'password'}
                value={form.new_password}
                onChange={e => setForm(f => ({ ...f, new_password: e.target.value }))}
                required
                minLength={8}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 pr-10"
              />
              <button type="button" onClick={() => setShowNew(v => !v)}
                className="absolute right-3 top-2.5 text-slate-400 hover:text-white">
                {showNew ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </Field>

          <Field label="Confirm New Password">
            <input
              type="password"
              value={form.confirm_password}
              onChange={e => setForm(f => ({ ...f, confirm_password: e.target.value }))}
              required
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </Field>

          <button type="submit" disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded-lg font-medium">
            <Save size={14} /> {saving ? 'Saving...' : 'Change Password'}
          </button>
        </form>
      </SectionCard>
    </div>
  )
}

export default function Settings() {
  const [tab, setTab] = useState('general')
  const [allSettings, setAllSettings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    api.get('/settings/system').then(r => {
      setAllSettings(r.data)
    }).catch(console.error).finally(() => setLoading(false))
  }, [])

  async function handleSave(key, value) {
    await api.put(`/settings/system/${key}`, value)
    setAllSettings(s => ({ ...s, [key]: value }))
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  if (loading) return <div className="p-8 text-slate-400">Loading settings...</div>

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Settings2 size={20} className="text-blue-400" /> Settings
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">Platform configuration and integrations</p>
        </div>
        {saved && (
          <div className="flex items-center gap-2 text-green-400 text-sm bg-green-900/30 border border-green-800 px-3 py-1.5 rounded-lg">
            <CheckCircle2 size={14} /> Saved
          </div>
        )}
      </div>

      <TabBar active={tab} onChange={setTab} />

      {tab === 'profile' && <ProfileTab />}
      {tab === 'general' && (
        <GeneralTab settings={allSettings?.general || {}} onSave={handleSave} />
      )}
      {tab === 'backup' && (
        <BackupTab settings={allSettings?.backup || {}} onSave={handleSave} />
      )}
      {tab === 'notifications' && (
        <NotificationsTab />
      )}
      {tab === 'security' && (
        <SecurityTab settings={allSettings?.security || {}} onSave={handleSave} />
      )}
      {tab === 'credentials' && (
        <CredentialsTab />
      )}
    </div>
  )
}
