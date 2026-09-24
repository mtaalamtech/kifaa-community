import { useState, useEffect, useCallback } from 'react'
import {
  Fish, Plus, Play, RefreshCw, Trash2, Mail, MousePointerClick,
  Eye, AlertTriangle, CheckCircle, XCircle, ChevronRight,
  ArrowLeft, Upload, X, Copy, Pencil, Users, BarChart3,
  ShieldAlert, Clock, Send,
} from 'lucide-react'
import { phishingApi } from '../api/client'

// ── Helpers ────────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const map = {
    draft:     'bg-slate-700 text-slate-300 border-slate-600',
    sending:   'bg-blue-900/40 text-blue-300 border-blue-700',
    running:   'bg-green-900/40 text-green-400 border-green-800',
    completed: 'bg-slate-700 text-slate-400 border-slate-600',
    paused:    'bg-yellow-900/40 text-yellow-400 border-yellow-800',
    error:     'bg-red-900/40 text-red-400 border-red-800',
  }
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs border font-medium ${map[status] || map.draft}`}>
      {status}
    </span>
  )
}

function SendBadge({ status }) {
  if (status === 'sent') return <span className="text-xs text-green-400 flex items-center gap-1"><CheckCircle size={12} />Sent</span>
  if (status === 'failed') return <span className="text-xs text-red-400 flex items-center gap-1"><XCircle size={12} />Failed</span>
  return <span className="text-xs text-slate-500 flex items-center gap-1"><Clock size={12} />Pending</span>
}

function RateBar({ label, value, color = 'blue', icon: Icon }) {
  const colors = {
    blue: 'bg-blue-500',
    yellow: 'bg-yellow-500',
    orange: 'bg-orange-500',
    red: 'bg-red-500',
  }
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-slate-400 flex items-center gap-1">{Icon && <Icon size={11} />}{label}</span>
        <span className="text-white font-medium">{value}%</span>
      </div>
      <div className="h-2 bg-slate-700 rounded-full">
        <div className={`h-full rounded-full ${colors[color]}`} style={{ width: `${Math.min(value, 100)}%` }} />
      </div>
    </div>
  )
}

// ── Campaign Create/Edit Modal ──────────────────────────────────────────────

function CampaignModal({ campaign, templates, smtpChannels, onClose, onSaved }) {
  const isEdit = !!campaign
  const [form, setForm] = useState({
    name: campaign?.name || '',
    description: campaign?.description || '',
    template_id: campaign?.template_id || '',
    smtp_channel_id: campaign?.smtp_channel_id || '',
    base_url: campaign?.base_url || window.location.origin,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))

  async function save() {
    if (!form.name.trim()) { setError('Name is required'); return }
    if (!form.template_id) { setError('Select a template'); return }
    setSaving(true); setError('')
    try {
      if (isEdit) {
        await phishingApi.updateCampaign(campaign.id, form)
      } else {
        await phishingApi.createCampaign(form)
      }
      onSaved()
      onClose()
    } catch (e) {
      setError(e.response?.data?.detail || 'Save failed')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <h2 className="font-semibold text-white flex items-center gap-2">
            <Fish size={16} className="text-red-400" />
            {isEdit ? 'Edit Campaign' : 'New Campaign'}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>
        <div className="p-6 space-y-4">
          {error && <div className="p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">{error}</div>}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Campaign Name *</label>
            <input value={form.name} onChange={e => f('name', e.target.value)}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
              placeholder="e.g. Q2 2025 Phishing Awareness Test" />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Description</label>
            <input value={form.description} onChange={e => f('description', e.target.value)}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
              placeholder="Optional notes" />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Template *</label>
            <select value={form.template_id} onChange={e => f('template_id', e.target.value)}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500">
              <option value="">— Select a template —</option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.name} ({t.category})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">SMTP Channel</label>
            <select value={form.smtp_channel_id} onChange={e => f('smtp_channel_id', e.target.value)}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500">
              <option value="">— Select SMTP channel —</option>
              {smtpChannels.map(c => (
                <option key={c.id} value={c.id}>{c.name} ({c.host})</option>
              ))}
            </select>
            {smtpChannels.length === 0 && (
              <p className="text-xs text-yellow-400 mt-1">No SMTP channels configured — add one in Settings → Notifications</p>
            )}
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Tracking Base URL *</label>
            <input value={form.base_url} onChange={e => f('base_url', e.target.value)}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500 font-mono"
              placeholder="https://kifaa.kenyanut.com" />
            <p className="text-xs text-slate-500 mt-1">Public URL of this server — used in tracking links embedded in emails</p>
          </div>
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-700">
          <button onClick={onClose} className="px-4 py-2 text-sm bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg">Cancel</button>
          <button onClick={save} disabled={saving}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white rounded-lg">
            {saving ? <RefreshCw size={14} className="animate-spin" /> : null}
            {isEdit ? 'Save' : 'Create Campaign'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Add Targets Modal ───────────────────────────────────────────────────────

function TargetsModal({ campaignId, onClose, onSaved }) {
  const [mode, setMode] = useState('manual') // manual | csv
  const [form, setForm] = useState({ email: '', first_name: '', last_name: '', department: '' })
  const [csvText, setCsvText] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  async function addOne() {
    if (!form.email.trim()) return
    setSaving(true)
    try {
      await phishingApi.addTarget(campaignId, form)
      setMsg(`Added ${form.email}`)
      setForm({ email: '', first_name: '', last_name: '', department: '' })
      onSaved()
    } catch (e) { setMsg(e.response?.data?.detail || 'Error') }
    finally { setSaving(false) }
  }

  async function importCsv() {
    const lines = csvText.trim().split('\n').filter(Boolean)
    const targets = []
    for (const line of lines) {
      const parts = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''))
      if (!parts[0]) continue
      targets.push({ email: parts[0], first_name: parts[1] || '', last_name: parts[2] || '', department: parts[3] || '' })
    }
    if (!targets.length) return
    setSaving(true)
    try {
      const r = await phishingApi.importTargets(campaignId, targets)
      setMsg(`Imported ${r.data.added} targets`)
      setCsvText('')
      onSaved()
    } catch (e) { setMsg('Import failed') }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <h2 className="font-semibold text-white flex items-center gap-2"><Users size={16} className="text-blue-400" />Add Targets</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>
        <div className="p-6">
          <div className="flex gap-2 mb-4">
            {['manual', 'csv'].map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${mode === m ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-700 border-slate-600 text-slate-300 hover:bg-slate-600'}`}>
                {m === 'manual' ? 'Add One' : 'CSV Import'}
              </button>
            ))}
          </div>

          {mode === 'manual' ? (
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Email *</label>
                <input value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                  placeholder="employee@company.com" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">First Name</label>
                  <input value={form.first_name} onChange={e => setForm(p => ({ ...p, first_name: e.target.value }))}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Last Name</label>
                  <input value={form.last_name} onChange={e => setForm(p => ({ ...p, last_name: e.target.value }))}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
                </div>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Department</label>
                <input value={form.department} onChange={e => setForm(p => ({ ...p, department: e.target.value }))}
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                  placeholder="Finance, HR, IT…" />
              </div>
              <button onClick={addOne} disabled={saving || !form.email}
                className="w-full py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-lg">
                Add Target
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-slate-400">Paste CSV: <span className="font-mono">email,first_name,last_name,department</span> (one per line)</p>
              <textarea rows={8} value={csvText} onChange={e => setCsvText(e.target.value)}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-blue-500"
                placeholder={"john.doe@company.com,John,Doe,Finance\njane.smith@company.com,Jane,Smith,HR"} />
              <button onClick={importCsv} disabled={saving || !csvText.trim()}
                className="w-full py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-lg flex items-center justify-center gap-2">
                <Upload size={14} />Import CSV
              </button>
            </div>
          )}

          {msg && <p className="mt-3 text-sm text-green-400">{msg}</p>}
        </div>
      </div>
    </div>
  )
}

// ── Template Preview Modal ──────────────────────────────────────────────────

function TemplatePreviewModal({ template, onClose, onClone }) {
  const [tab, setTab] = useState('email')
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700 flex-shrink-0">
          <div>
            <h2 className="font-semibold text-white">{template.name}</h2>
            <p className="text-xs text-slate-400 mt-0.5">From: {template.sender_name} &lt;{template.sender_email}&gt;</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => onClone(template.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg">
              <Copy size={12} />Clone
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-white ml-2"><X size={18} /></button>
          </div>
        </div>
        <div className="px-6 py-3 border-b border-slate-700 flex gap-3 flex-shrink-0">
          <button onClick={() => setTab('email')}
            className={`text-xs px-3 py-1.5 rounded-lg ${tab === 'email' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}>
            Email Body
          </button>
          {template.landing_page_html && (
            <button onClick={() => setTab('landing')}
              className={`text-xs px-3 py-1.5 rounded-lg ${tab === 'landing' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}>
              Landing Page
            </button>
          )}
        </div>
        <div className="flex-1 overflow-auto p-4">
          <div className="bg-white rounded-lg overflow-hidden">
            <div className="bg-slate-100 px-4 py-2 text-xs text-slate-500 border-b flex justify-between">
              <span>Subject: <strong>{template.subject}</strong></span>
            </div>
            <div className="p-2 min-h-64">
              <iframe
                srcDoc={tab === 'email' ? template.body_html : template.landing_page_html}
                className="w-full border-0"
                style={{ minHeight: '400px' }}
                title="Template preview"
                sandbox="allow-same-origin"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Campaign Detail View ────────────────────────────────────────────────────

function CampaignDetail({ campaign: initialCampaign, templates, smtpChannels, onBack }) {
  const [campaign, setCampaign] = useState(initialCampaign)
  const [targets, setTargets] = useState([])
  const [loading, setLoading] = useState(true)
  const [showTargetsModal, setShowTargetsModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [actionMsg, setActionMsg] = useState('')
  const [actioning, setActioning] = useState(false)

  const load = useCallback(async () => {
    try {
      const [cd, td] = await Promise.all([
        phishingApi.getCampaign(campaign.id),
        phishingApi.listTargets(campaign.id),
      ])
      setCampaign(cd.data)
      setTargets(td.data || [])
    } finally { setLoading(false) }
  }, [campaign.id])

  useEffect(() => { load() }, [load])

  async function launch() {
    setActioning(true)
    try {
      const r = await phishingApi.launchCampaign(campaign.id)
      setActionMsg(`Sending to ${r.data.targets_queued} target(s)…`)
      setTimeout(() => { setActionMsg(''); load() }, 3000)
    } catch (e) {
      setActionMsg(e.response?.data?.detail || 'Launch failed')
    } finally { setActioning(false) }
  }

  async function complete() {
    await phishingApi.completeCampaign(campaign.id)
    load()
  }

  async function reset() {
    if (!window.confirm('Reset all target status and re-queue for sending?')) return
    await phishingApi.resetCampaign(campaign.id)
    load()
  }

  async function removeTarget(tid) {
    await phishingApi.deleteTarget(campaign.id, tid)
    setTargets(t => t.filter(x => x.id !== tid))
  }

  const stats = campaign.stats || {}
  const canLaunch = ['draft', 'error'].includes(campaign.status) && targets.some(t => t.send_status === 'pending')

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-slate-400 hover:text-white"><ArrowLeft size={18} /></button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold text-white">{campaign.name}</h2>
            <StatusBadge status={campaign.status} />
          </div>
          {campaign.description && <p className="text-sm text-slate-400 mt-0.5">{campaign.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          {actionMsg && <span className="text-sm text-green-400">{actionMsg}</span>}
          <button onClick={load} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg">
            <RefreshCw size={15} />
          </button>
          <button onClick={() => setShowEditModal(true)} className="p-1.5 text-slate-400 hover:text-blue-400 hover:bg-slate-700 rounded-lg">
            <Pencil size={15} />
          </button>
          {canLaunch && (
            <button onClick={launch} disabled={actioning}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white rounded-lg">
              <Send size={14} />Launch
            </button>
          )}
          {campaign.status === 'running' && (
            <button onClick={complete}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-slate-600 hover:bg-slate-500 text-white rounded-lg">
              <CheckCircle size={14} />Mark Complete
            </button>
          )}
          {(campaign.status === 'completed' || campaign.status === 'error') && (
            <button onClick={reset}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-slate-600 hover:bg-slate-500 text-white rounded-lg">
              <RefreshCw size={14} />Reset
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Emails Sent', value: stats.sent ?? 0, total: stats.total ?? 0, icon: Mail, color: 'blue' },
          { label: 'Opened', value: stats.opened ?? 0, total: stats.sent ?? 0, icon: Eye, color: 'yellow' },
          { label: 'Clicked', value: stats.clicked ?? 0, total: stats.sent ?? 0, icon: MousePointerClick, color: 'orange' },
          { label: 'Submitted Creds', value: stats.submitted ?? 0, total: stats.sent ?? 0, icon: AlertTriangle, color: 'red' },
        ].map(s => (
          <div key={s.label} className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-slate-400">{s.label}</span>
              <s.icon size={14} className="text-slate-500" />
            </div>
            <div className="text-2xl font-bold text-white">{s.value}</div>
            {s.total > 0 && (
              <div className="text-xs text-slate-500 mt-1">{Math.round(s.value / s.total * 100)}% of {s.total}</div>
            )}
          </div>
        ))}
      </div>

      {/* Rate bars */}
      {stats.sent > 0 && (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
          <h3 className="text-sm font-medium text-slate-300 mb-4">Campaign Rates</h3>
          <div className="space-y-3">
            <RateBar label="Open Rate" value={stats.open_rate ?? 0} color="blue" icon={Eye} />
            <RateBar label="Click Rate" value={stats.click_rate ?? 0} color="orange" icon={MousePointerClick} />
            <RateBar label="Credential Submit Rate" value={stats.submit_rate ?? 0} color="red" icon={AlertTriangle} />
          </div>
        </div>
      )}

      {/* Targets table */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <h3 className="text-sm font-medium text-slate-300 flex items-center gap-2">
            <Users size={14} />Targets ({targets.length})
          </h3>
          <button onClick={() => setShowTargetsModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg">
            <Plus size={12} />Add Targets
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-xs text-slate-400 uppercase">
                <th className="px-4 py-3 text-left">Email</th>
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">Dept</th>
                <th className="px-4 py-3 text-left">Sent</th>
                <th className="px-4 py-3 text-center">Opened</th>
                <th className="px-4 py-3 text-center">Clicked</th>
                <th className="px-4 py-3 text-center">Submitted</th>
                <th className="px-4 py-3 text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/60">
              {loading ? (
                <tr><td colSpan={8} className="py-8 text-center text-slate-500">Loading…</td></tr>
              ) : targets.length === 0 ? (
                <tr><td colSpan={8} className="py-8 text-center text-slate-500">No targets yet — add some to get started</td></tr>
              ) : targets.map(t => (
                <tr key={t.id} className={`hover:bg-slate-700/30 ${t.submitted_at ? 'bg-red-900/10' : t.clicked_at ? 'bg-orange-900/10' : ''}`}>
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-300">{t.email}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-400">{[t.first_name, t.last_name].filter(Boolean).join(' ') || '—'}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">{t.department || '—'}</td>
                  <td className="px-4 py-2.5"><SendBadge status={t.send_status} /></td>
                  <td className="px-4 py-2.5 text-center">
                    {t.opened_at ? <CheckCircle size={14} className="text-blue-400 mx-auto" /> : <span className="text-slate-700">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    {t.clicked_at ? <CheckCircle size={14} className="text-orange-400 mx-auto" /> : <span className="text-slate-700">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    {t.submitted_at ? <AlertTriangle size={14} className="text-red-400 mx-auto" /> : <span className="text-slate-700">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={() => removeTarget(t.id)} className="p-1 text-slate-600 hover:text-red-400 hover:bg-slate-700 rounded">
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showTargetsModal && (
        <TargetsModal campaignId={campaign.id} onClose={() => setShowTargetsModal(false)} onSaved={load} />
      )}
      {showEditModal && (
        <CampaignModal
          campaign={campaign}
          templates={templates}
          smtpChannels={smtpChannels}
          onClose={() => setShowEditModal(false)}
          onSaved={() => { setShowEditModal(false); load() }}
        />
      )}
    </div>
  )
}

// ── Templates Tab ───────────────────────────────────────────────────────────

function TemplatesTab({ templates, loading, onRefresh }) {
  const [preview, setPreview] = useState(null)

  async function cloneTemplate(id) {
    try {
      await phishingApi.cloneTemplate(id)
      onRefresh()
      setPreview(null)
    } catch (e) {
      alert(e.response?.data?.detail || 'Clone failed')
    }
  }

  async function deleteTemplate(id, name) {
    if (!window.confirm(`Delete template "${name}"?`)) return
    try {
      await phishingApi.deleteTemplate(id)
      onRefresh()
    } catch (e) {
      alert(e.response?.data?.detail || 'Delete failed')
    }
  }

  async function openPreview(id) {
    const r = await phishingApi.getTemplate(id)
    setPreview(r.data)
  }

  const catColor = { credential: 'bg-red-900/40 text-red-300 border-red-700', awareness: 'bg-blue-900/40 text-blue-300 border-blue-700', spear: 'bg-purple-900/40 text-purple-300 border-purple-700' }

  return (
    <div>
      {loading ? (
        <div className="py-12 text-center text-slate-500">Loading…</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {templates.map(t => (
            <div key={t.id} className="bg-slate-800 border border-slate-700 rounded-xl p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <h3 className="font-medium text-white text-sm truncate">{t.name}</h3>
                    <span className={`px-1.5 py-0.5 rounded text-xs border ${catColor[t.category] || catColor.awareness}`}>{t.category}</span>
                    {t.is_builtin && <span className="px-1.5 py-0.5 rounded text-xs bg-slate-700 text-slate-400 border border-slate-600">built-in</span>}
                  </div>
                  <p className="text-xs text-slate-400 mb-0.5">Subject: {t.subject}</p>
                  <p className="text-xs text-slate-500">From: {t.sender_name} &lt;{t.sender_email}&gt;</p>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  <button onClick={() => openPreview(t.id)} title="Preview"
                    className="p-1.5 text-slate-400 hover:text-blue-400 hover:bg-slate-700 rounded-lg">
                    <Eye size={14} />
                  </button>
                  <button onClick={() => cloneTemplate(t.id)} title="Clone"
                    className="p-1.5 text-slate-400 hover:text-green-400 hover:bg-slate-700 rounded-lg">
                    <Copy size={14} />
                  </button>
                  {!t.is_builtin && (
                    <button onClick={() => deleteTemplate(t.id, t.name)} title="Delete"
                      className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-slate-700 rounded-lg">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {preview && (
        <TemplatePreviewModal template={preview} onClose={() => setPreview(null)} onClone={cloneTemplate} />
      )}
    </div>
  )
}

// ── Main Page ───────────────────────────────────────────────────────────────

export default function Phishing() {
  const [tab, setTab] = useState('campaigns')
  const [campaigns, setCampaigns] = useState([])
  const [templates, setTemplates] = useState([])
  const [smtpChannels, setSmtpChannels] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [activeCampaign, setActiveCampaign] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [cr, tr, sr] = await Promise.all([
        phishingApi.listCampaigns(),
        phishingApi.listTemplates(),
        phishingApi.smtpChannels(),
      ])
      setCampaigns(cr.data || [])
      setTemplates(tr.data || [])
      setSmtpChannels(sr.data || [])
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function deleteCampaign(id, name) {
    if (!window.confirm(`Delete campaign "${name}"? This will also delete all target data.`)) return
    await phishingApi.deleteCampaign(id)
    setCampaigns(c => c.filter(x => x.id !== id))
    if (activeCampaign?.id === id) setActiveCampaign(null)
  }

  // Aggregate stats across all campaigns
  const totals = campaigns.reduce((acc, c) => ({
    campaigns: acc.campaigns + 1,
    sent: acc.sent + (c.stats?.sent ?? 0),
    clicked: acc.clicked + (c.stats?.clicked ?? 0),
    submitted: acc.submitted + (c.stats?.submitted ?? 0),
  }), { campaigns: 0, sent: 0, clicked: 0, submitted: 0 })

  if (activeCampaign) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Fish size={20} className="text-red-400" />Phishing Simulation
          </h1>
        </div>
        <CampaignDetail
          campaign={activeCampaign}
          templates={templates}
          smtpChannels={smtpChannels}
          onBack={() => { setActiveCampaign(null); load() }}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Fish size={20} className="text-red-400" />Phishing Simulation
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">Security awareness testing — simulate phishing attacks and track employee susceptibility</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="flex items-center gap-1.5 px-3 py-2 text-xs bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 rounded-lg">
            <RefreshCw size={12} />Refresh
          </button>
          <button onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-xs bg-red-600 hover:bg-red-700 text-white rounded-lg">
            <Plus size={12} />New Campaign
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Campaigns', value: totals.campaigns, icon: BarChart3, color: 'text-slate-300' },
          { label: 'Emails Sent', value: totals.sent, icon: Mail, color: 'text-blue-400' },
          { label: 'Links Clicked', value: totals.clicked, icon: MousePointerClick, color: 'text-orange-400' },
          { label: 'Credentials Submitted', value: totals.submitted, icon: ShieldAlert, color: 'text-red-400' },
        ].map(s => (
          <div key={s.label} className="bg-slate-800 border border-slate-700 rounded-xl p-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-slate-400">{s.label}</span>
              <s.icon size={15} className={s.color} />
            </div>
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-700">
        {[
          { id: 'campaigns', label: 'Campaigns', icon: Fish },
          { id: 'templates', label: 'Templates', icon: Mail },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.id ? 'border-red-500 text-red-400' : 'border-transparent text-slate-400 hover:text-white'
            }`}>
            <t.icon size={14} />{t.label}
          </button>
        ))}
      </div>

      {/* Campaigns tab */}
      {tab === 'campaigns' && (
        <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-xs text-slate-400 uppercase bg-slate-800/60">
                <th className="px-4 py-3 text-left">Campaign</th>
                <th className="px-4 py-3 text-left">Template</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-center">Sent</th>
                <th className="px-4 py-3 text-center">Opened</th>
                <th className="px-4 py-3 text-center">Clicked</th>
                <th className="px-4 py-3 text-center">Submitted</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {loading ? (
                <tr><td colSpan={8} className="py-12 text-center text-slate-500">Loading…</td></tr>
              ) : campaigns.length === 0 ? (
                <tr><td colSpan={8} className="py-12 text-center text-slate-500">
                  No campaigns yet — create one to start testing
                </td></tr>
              ) : campaigns.map(c => (
                <tr key={c.id} className="hover:bg-slate-700/30 cursor-pointer" onClick={() => setActiveCampaign(c)}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-white">{c.name}</div>
                    {c.description && <div className="text-xs text-slate-500 mt-0.5">{c.description}</div>}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400">{c.template_name}</td>
                  <td className="px-4 py-3"><StatusBadge status={c.status} /></td>
                  <td className="px-4 py-3 text-center text-sm text-blue-400">{c.stats?.sent ?? 0}</td>
                  <td className="px-4 py-3 text-center text-xs">
                    <span className="text-yellow-400">{c.stats?.opened ?? 0}</span>
                    {c.stats?.sent > 0 && <span className="text-slate-600 ml-1">({c.stats.open_rate}%)</span>}
                  </td>
                  <td className="px-4 py-3 text-center text-xs">
                    <span className="text-orange-400">{c.stats?.clicked ?? 0}</span>
                    {c.stats?.sent > 0 && <span className="text-slate-600 ml-1">({c.stats.click_rate}%)</span>}
                  </td>
                  <td className="px-4 py-3 text-center text-xs">
                    <span className={c.stats?.submitted > 0 ? 'text-red-400 font-medium' : 'text-slate-500'}>{c.stats?.submitted ?? 0}</span>
                    {c.stats?.sent > 0 && c.stats?.submitted > 0 && <span className="text-slate-600 ml-1">({c.stats.submit_rate}%)</span>}
                  </td>
                  <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => setActiveCampaign(c)} title="Open" className="p-1.5 text-slate-400 hover:text-blue-400 hover:bg-slate-700 rounded-lg">
                        <ChevronRight size={14} />
                      </button>
                      <button onClick={() => deleteCampaign(c.id, c.name)} title="Delete" className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-slate-700 rounded-lg">
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

      {/* Templates tab */}
      {tab === 'templates' && (
        <TemplatesTab templates={templates} loading={loading} onRefresh={load} />
      )}

      {showCreate && (
        <CampaignModal
          templates={templates}
          smtpChannels={smtpChannels}
          onClose={() => setShowCreate(false)}
          onSaved={load}
        />
      )}
    </div>
  )
}
