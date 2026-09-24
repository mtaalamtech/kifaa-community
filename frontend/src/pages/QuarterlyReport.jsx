import { useState, useEffect, useCallback } from 'react'
import { quarterlyApi } from '../api/client'
import {
  BarChart2, Shield, AlertTriangle, CheckCircle, XCircle,
  Clock, FileText, Users, TrendingUp, Download, Plus, Edit2,
  Trash2, Save, X, ChevronDown
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function currentQuarter() {
  const m = new Date().getMonth() + 1
  if (m <= 3) return 1
  if (m <= 6) return 2
  if (m <= 9) return 3
  return 4
}

function currentYear() {
  return new Date().getFullYear()
}

function ragColor(status) {
  if (status === 'green') return { border: 'border-emerald-500', bg: 'bg-emerald-900/20', dot: 'bg-emerald-400', text: 'text-emerald-400' }
  if (status === 'amber') return { border: 'border-amber-500', bg: 'bg-amber-900/20', dot: 'bg-amber-400', text: 'text-amber-400' }
  return { border: 'border-red-500', bg: 'bg-red-900/20', dot: 'bg-red-500', text: 'text-red-400' }
}

function computePatchRag(pct) {
  if (pct >= 95) return 'green'
  if (pct >= 80) return 'amber'
  return 'red'
}
function computeEndpointRag(av, thr) {
  const min = Math.min(av, thr)
  if (min >= 100) return 'green'
  if (min >= 90) return 'amber'
  return 'red'
}
function computeVulnRag(critOpen, avgDays) {
  if (critOpen === 0) return 'green'
  if (avgDays === null || avgDays <= 14) return 'amber'
  return 'red'
}
function computePhishRag(clickPct, campaigns) {
  if (!campaigns) return 'amber'   // no simulations run — don't claim On Target
  if (clickPct < 5) return 'green'
  if (clickPct < 10) return 'amber'
  return 'red'
}
function computeIncRag(sla_pct) {
  if (sla_pct === null || sla_pct === undefined) return 'amber'
  if (sla_pct >= 90) return 'green'
  if (sla_pct >= 70) return 'amber'
  return 'red'
}
function computeFndRag(closure_pct) {
  if (closure_pct >= 90) return 'green'
  if (closure_pct >= 70) return 'amber'
  return 'red'
}

function RAGDot({ status }) {
  const c = ragColor(status)
  return <span className={`inline-block w-3 h-3 rounded-full ${c.dot} flex-shrink-0`} />
}

function RAGLabel({ status }) {
  const map = { green: 'On Target', amber: 'Watch', red: 'Action Required' }
  const c = ragColor(status)
  return <span className={`text-xs font-semibold ${c.text}`}>{map[status] || '—'}</span>
}

// Status / priority badge helpers
const STATUS_BADGE = {
  pending:        'bg-slate-600 text-slate-200',
  started:        'bg-blue-700 text-blue-100',
  in_progress:    'bg-yellow-600 text-yellow-100',
  closed:         'bg-emerald-700 text-emerald-100',
  not_achievable: 'bg-red-700 text-red-100',
}
const PRIORITY_BADGE = {
  low:      'bg-slate-600 text-slate-200',
  medium:   'bg-yellow-600 text-yellow-100',
  high:     'bg-orange-600 text-orange-100',
  critical: 'bg-red-700 text-red-100',
}
const SEVERITY_BADGE = {
  low:      'bg-blue-700 text-blue-100',
  medium:   'bg-yellow-600 text-yellow-100',
  high:     'bg-orange-600 text-orange-100',
  critical: 'bg-red-700 text-red-100',
}
const INC_STATUS_BADGE = {
  open:      'bg-red-700 text-red-100',
  contained: 'bg-yellow-600 text-yellow-100',
  resolved:  'bg-blue-700 text-blue-100',
  closed:    'bg-emerald-700 text-emerald-100',
}
const SOURCE_BADGE = {
  internal: 'bg-blue-700 text-blue-100',
  external: 'bg-purple-700 text-purple-100',
}

function Badge({ text, cls }) {
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {text}
    </span>
  )
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

function ErrorMsg({ msg }) {
  return (
    <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-300 text-sm">
      {msg}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Modal base
// ---------------------------------------------------------------------------
function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <h3 className="text-white font-semibold text-lg">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X size={20} />
          </button>
        </div>
        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-4">
          {children}
        </div>
      </div>
    </div>
  )
}

function Field({ label, required, children }) {
  return (
    <div>
      <label className="block text-xs text-slate-400 mb-1">
        {label}{required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  )
}

const inputCls = 'w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500'
const selectCls = inputCls
const textareaCls = `${inputCls} resize-none`

// ---------------------------------------------------------------------------
// Scorecard tab
// ---------------------------------------------------------------------------
function currentQuarterOf() {
  const m = new Date().getMonth() + 1
  const q = Math.ceil(m / 3)
  return { q, y: new Date().getFullYear() }
}

function ScorecardTab({ quarter, year }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState(null)

  const { q: curQ, y: curY } = currentQuarterOf()
  const isCurrentQuarter = quarter === curQ && year === curY

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await quarterlyApi.scorecard(quarter, year)
      setData(res.data)
    } catch (e) {
      setError(e.response?.data?.detail || 'Failed to load scorecard')
    } finally {
      setLoading(false)
    }
  }, [quarter, year])

  useEffect(() => { load() }, [load])

  async function saveSnapshot() {
    setSaving(true)
    setSaveMsg(null)
    try {
      await quarterlyApi.saveSnapshot(quarter, year)
      setSaveMsg('Snapshot saved')
      load()
    } catch (e) {
      setSaveMsg(e.response?.data?.detail || 'Save failed')
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(null), 4000)
    }
  }

  if (loading) return <Spinner />
  if (error) return <ErrorMsg msg={error} />
  if (!data) return null

  const patch    = data.patch || {}
  const endpoint = data.endpoint || {}
  const vuln     = data.vulnerability || {}
  const phi      = data.phishing || {}
  const inc      = data.incidents || {}
  const fnd      = data.findings || {}

  const patchRag    = patch.error ? 'red' : patch.no_data ? 'amber' : computePatchRag(patch.compliant_pct ?? 0)
  const endpointRag = endpoint.error ? 'red' : endpoint.no_data ? 'amber' : computeEndpointRag(endpoint.av_pct ?? 0, endpoint.threat_free_pct ?? 0)
  const vulnRag     = vuln.error     ? 'red' : vuln.no_data ? 'amber' : computeVulnRag(vuln.critical_open ?? 0, vuln.avg_days_to_remediate)
  const phiRag      = phi.error      ? 'red' : computePhishRag(phi.click_pct ?? 0, phi.campaigns ?? 0)
  const incRag      = inc.error      ? 'red' : computeIncRag(inc.within_sla_pct)
  const fndRag      = fnd.error      ? 'red' : computeFndRag(fnd.closure_pct ?? 0)

  function MetricCard({ section, area, rag, children }) {
    const c = ragColor(rag)
    return (
      <div className={`border ${c.border} ${c.bg} rounded-xl p-5 flex flex-col gap-3`}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-xs text-slate-400 font-medium uppercase tracking-wide">{section}</div>
            <div className="text-white font-semibold text-sm mt-0.5">{area}</div>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 flex-shrink-0">
            <RAGDot status={rag} />
            <RAGLabel status={rag} />
          </div>
        </div>
        <div className="space-y-2 text-sm">{children}</div>
      </div>
    )
  }

  function Stat({ label, value, target }) {
    return (
      <div className="flex items-center justify-between">
        <span className="text-slate-400 text-xs">{label}</span>
        <div className="text-right">
          <span className="text-white font-semibold">{value ?? '—'}</span>
          {target && <span className="text-slate-500 text-xs ml-2">/ {target}</span>}
        </div>
      </div>
    )
  }

  const snapAt = data?.patch?.snapshot_at || data?.endpoint?.snapshot_at
  const snapBy = data?.patch?.snapshot_by || data?.endpoint?.snapshot_by

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="text-slate-400 text-sm">
          Security posture for Q{quarter} {year}
          {!isCurrentQuarter && snapAt && (
            <span className="ml-3 text-xs text-slate-500">
              Snapshot saved {new Date(snapAt).toLocaleString()} {snapBy ? `by ${snapBy}` : ''}
            </span>
          )}
        </div>
        {!isCurrentQuarter && (
          <div className="flex items-center gap-3">
            <button
              onClick={saveSnapshot}
              disabled={saving}
              className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium disabled:opacity-50"
            >
              <TrendingUp size={13} />
              {saving ? 'Saving…' : 'Save Snapshot for Q' + quarter + ' ' + year}
            </button>
            {saveMsg && (
              <span className={`text-xs ${saveMsg === 'Snapshot saved' ? 'text-emerald-400' : 'text-red-400'}`}>
                {saveMsg}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Technical SC row */}
      <div>
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Technical SC</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <MetricCard section="Technical SC" area="Patch & Update Compliance" rag={patchRag}>
            {patch.error
              ? <span className="text-red-400 text-xs">{patch.error}</span>
              : patch.no_data
                ? <div className="space-y-1">
                    <span className="text-amber-400 text-xs block">{patch.message || 'No snapshot for this quarter'}</span>
                    <span className="text-slate-500 text-xs">Use "Save Snapshot" to record current state for Q{quarter} {year}</span>
                  </div>
                : <>
                    <Stat label="Devices patched" value={`${patch.compliant_pct}%`} target="≥ 95%" />
                    <Stat label="Compliant agents" value={`${patch.compliant_agents} / ${patch.total_agents}`} />
                    {patch.snapshot_at && <span className="text-slate-600 text-xs">Snapshot: {new Date(patch.snapshot_at).toLocaleDateString()}</span>}
                  </>
            }
          </MetricCard>

          <MetricCard section="Technical SC" area="Endpoint Protection" rag={endpointRag}>
            {endpoint.error
              ? <span className="text-red-400 text-xs">{endpoint.error}</span>
              : endpoint.no_data
                ? <div className="space-y-1">
                    <span className="text-amber-400 text-xs block">{endpoint.message || 'No snapshot for this quarter'}</span>
                    <span className="text-slate-500 text-xs">Use "Save Snapshot" to record current state for Q{quarter} {year}</span>
                  </div>
                : <>
                    <Stat label="AV active" value={`${endpoint.av_pct}%`} target="100%" />
                    <Stat label="Threat-free" value={`${endpoint.threat_free_pct}%`} target="100%" />
                    <Stat label="Total agents" value={endpoint.total} />
                    {endpoint.snapshot_at && <span className="text-slate-600 text-xs">Snapshot: {new Date(endpoint.snapshot_at).toLocaleDateString()}</span>}
                  </>
            }
          </MetricCard>

          <MetricCard section="Technical SC" area="Vulnerability Management" rag={vulnRag}>
            {vuln.error
              ? <span className="text-red-400 text-xs">{vuln.error}</span>
              : vuln.no_data
                ? <span className="text-amber-400 text-xs">No vulnerability data for this quarter</span>
                : <>
                    <Stat label="Critical open" value={vuln.critical_open} target="0" />
                    <Stat label="Avg days to remediate" value={vuln.avg_days_to_remediate != null ? `${vuln.avg_days_to_remediate}d` : 'N/A'} target="≤ 14d" />
                  </>
            }
          </MetricCard>
        </div>
      </div>

      {/* User SC row */}
      <div>
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">User SC</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <MetricCard section="User SC" area="Phishing Simulation" rag={phiRag}>
            {phi.error
              ? <span className="text-red-400 text-xs">{phi.error}</span>
              : phi.campaigns === 0
                ? <span className="text-amber-400 text-xs">No simulation conducted this quarter</span>
                : <>
                    <Stat label="Click rate" value={`${phi.click_pct}%`} target="< 5%" />
                    <Stat label="Clicked / sent" value={`${phi.total_clicked} / ${phi.total_sent}`} />
                    <Stat label="Campaigns" value={phi.campaigns} />
                  </>
            }
          </MetricCard>
        </div>
      </div>

      {/* Governance row */}
      <div>
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Governance & Audit SC</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <MetricCard section="Governance & Audit SC" area="Incident Reporting & Resolution" rag={incRag}>
            {inc.error
              ? <span className="text-red-400 text-xs">{inc.error}</span>
              : <>
                  <Stat label="Total incidents" value={inc.total} />
                  <Stat label="Avg contain time" value={inc.avg_contain_hours != null ? `${inc.avg_contain_hours}h` : 'N/A'} />
                  <Stat label="Within SLA" value={inc.within_sla_pct != null ? `${inc.within_sla_pct}%` : 'N/A'} target="≥ 90%" />
                </>
            }
          </MetricCard>

          <MetricCard section="Governance & Audit SC" area="Audit Findings" rag={fndRag}>
            {fnd.error
              ? <span className="text-red-400 text-xs">{fnd.error}</span>
              : <>
                  <Stat label="Total findings" value={fnd.total} />
                  <Stat label="Closed on time" value={fnd.closed_on_time} />
                  <Stat label="Closure rate" value={`${fnd.closure_pct}%`} target="≥ 90%" />
                </>
            }
          </MetricCard>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Audit Findings tab
// ---------------------------------------------------------------------------
const FINDING_STATUSES   = ['pending', 'started', 'in_progress', 'closed', 'not_achievable']
const RISK_RATING_OPTIONS = ['low', 'medium', 'high', 'critical']

const RISK_RATING_BADGE = {
  low:      'bg-slate-600 text-slate-200',
  medium:   'bg-yellow-600 text-yellow-100',
  high:     'bg-orange-600 text-orange-100',
  critical: 'bg-red-700 text-red-100',
}

function RatingColorSwatch({ color }) {
  if (!color) return <span className="text-slate-500 text-xs">—</span>
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-4 h-4 rounded border border-slate-600 flex-shrink-0" style={{ backgroundColor: color }} />
      <span className="text-xs text-slate-400">{color}</span>
    </span>
  )
}

function FindingModal({ finding, year, categories, onClose, onSaved }) {
  const isEdit = !!finding
  const [form, setForm] = useState({
    title:                       finding?.title || '',
    observation:                 finding?.observation || '',
    source:                      finding?.source || 'internal',
    area:                        finding?.area || (categories[0]?.name || 'Other'),
    year:                        finding?.year || year,
    due_date:                    finding?.due_date || '',
    risk_rating:                 finding?.risk_rating || 'medium',
    rating_color:                finding?.rating_color || '',
    status:                      finding?.status || 'pending',
    reason:                      finding?.reason || '',
    risk_implication:            finding?.risk_implication || '',
    recommendation:              finding?.recommendation || '',
    prev_management_comments:    finding?.prev_management_comments || '',
    current_management_comments: finding?.current_management_comments || '',
    individual_responsible:      finding?.individual_responsible || '',
    implementation:              finding?.implementation || '',
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  function set(key, val) { setForm(f => ({ ...f, [key]: val })) }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.title.trim()) { setErr('Finding Title is required'); return }
    if (form.status === 'not_achievable' && !form.reason.trim()) {
      setErr('Reason is required when status is Not Achievable'); return
    }
    setSaving(true); setErr(null)
    try {
      if (isEdit) {
        await quarterlyApi.updateFinding(finding.id, form)
      } else {
        await quarterlyApi.createFinding({ ...form, year: parseInt(form.year) })
      }
      onSaved(); onClose()
    } catch (e) {
      setErr(e.response?.data?.detail || 'Save failed')
    } finally { setSaving(false) }
  }

  return (
    <Modal title={isEdit ? 'Edit Audit Finding' : 'New Audit Finding'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4 pr-1">
        {err && <ErrorMsg msg={err} />}

        {/* Status + Year */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Status">
            <select className={selectCls} value={form.status} onChange={e => set('status', e.target.value)}>
              {FINDING_STATUSES.map(s => (
                <option key={s} value={s}>{s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>
              ))}
            </select>
          </Field>
          <Field label="Year" required>
            <input type="number" className={inputCls} value={form.year} onChange={e => set('year', e.target.value)} min={2000} max={2100} />
          </Field>
        </div>

        {/* Area */}
        <Field label="Area">
          <select className={selectCls} value={form.area} onChange={e => set('area', e.target.value)}>
            {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
        </Field>

        {/* Finding Title */}
        <Field label="Finding Title" required>
          <input className={inputCls} value={form.title} onChange={e => set('title', e.target.value)} placeholder="Brief title of the audit finding" />
        </Field>

        {/* Observation */}
        <Field label="Observation">
          <textarea className={textareaCls} rows={3} value={form.observation} onChange={e => set('observation', e.target.value)} placeholder="Describe what was observed during the audit…" />
        </Field>

        {/* Risk Implication */}
        <Field label="Risk Implication">
          <textarea className={textareaCls} rows={2} value={form.risk_implication} onChange={e => set('risk_implication', e.target.value)} placeholder="What risk does this finding pose if unresolved?" />
        </Field>

        {/* Recommendation */}
        <Field label="Recommendation">
          <textarea className={textareaCls} rows={2} value={form.recommendation} onChange={e => set('recommendation', e.target.value)} placeholder="Recommended actions to address this finding…" />
        </Field>

        {/* Previous Management Comments */}
        <Field label="Previous Management Comments">
          <textarea className={textareaCls} rows={2} value={form.prev_management_comments} onChange={e => set('prev_management_comments', e.target.value)} placeholder="Management comments from previous review…" />
        </Field>

        {/* Current Management Comments */}
        <Field label="Current Management Comments / Action Points">
          <textarea className={textareaCls} rows={2} value={form.current_management_comments} onChange={e => set('current_management_comments', e.target.value)} placeholder="Current management response and action points…" />
        </Field>

        {/* Risk Rating + Rating Color */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Risk Rating">
            <select className={selectCls} value={form.risk_rating} onChange={e => set('risk_rating', e.target.value)}>
              {RISK_RATING_OPTIONS.map(r => (
                <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
              ))}
            </select>
          </Field>
          <Field label="Rating Color">
            <div className="flex items-center gap-2">
              <input
                type="color"
                className="h-[38px] w-12 bg-slate-700 border border-slate-600 rounded-lg cursor-pointer p-1"
                value={form.rating_color || '#94a3b8'}
                onChange={e => set('rating_color', e.target.value)}
              />
              <input
                className={`${inputCls} flex-1`}
                value={form.rating_color}
                onChange={e => set('rating_color', e.target.value)}
                placeholder="#hex or color name"
              />
            </div>
          </Field>
        </div>

        {/* Individual Responsible */}
        <Field label="Individual Responsible">
          <input className={inputCls} value={form.individual_responsible} onChange={e => set('individual_responsible', e.target.value)} placeholder="Name of person responsible for implementation" />
        </Field>

        {/* Implementation */}
        <Field label="Implementation">
          <textarea className={textareaCls} rows={2} value={form.implementation} onChange={e => set('implementation', e.target.value)} placeholder="Implementation progress and notes…" />
        </Field>

        {/* Due Date + Source */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Due Date">
            <input type="date" className={inputCls} value={form.due_date || ''} onChange={e => set('due_date', e.target.value)} />
          </Field>
          <Field label="Source">
            <select className={selectCls} value={form.source} onChange={e => set('source', e.target.value)}>
              <option value="internal">Internal</option>
              <option value="external">External</option>
            </select>
          </Field>
        </div>

        {form.status === 'not_achievable' && (
          <Field label="Reason (required)" required>
            <textarea className={textareaCls} rows={2} value={form.reason} onChange={e => set('reason', e.target.value)} placeholder="Explain why this finding cannot be achieved…" />
          </Field>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 text-sm">Cancel</button>
          <button type="submit" disabled={saving} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50">
            {saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Create Finding')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function FindingsTab({ year }) {
  const [findings, setFindings] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [sourceFilter, setSourceFilter] = useState('all')
  const [modal, setModal] = useState(null) // null | 'new' | finding_obj

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [fRes, cRes] = await Promise.all([
        quarterlyApi.findings(null, sourceFilter),
        quarterlyApi.categories(),
      ])
      setFindings(fRes.data)
      setCategories(cRes.data)
    } catch (e) {
      setError(e.response?.data?.detail || 'Failed to load findings')
    } finally { setLoading(false) }
  }, [sourceFilter])

  useEffect(() => { load() }, [load])

  async function handleDelete(id) {
    if (!window.confirm('Delete this audit finding?')) return
    try { await quarterlyApi.deleteFinding(id); load() }
    catch (e) { alert(e.response?.data?.detail || 'Delete failed') }
  }

  return (
    <div className="space-y-4">
      {modal && (
        <FindingModal
          finding={modal === 'new' ? null : modal}
          year={year}
          categories={categories}
          onClose={() => setModal(null)}
          onSaved={load}
        />
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <select
          className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
          value={sourceFilter}
          onChange={e => setSourceFilter(e.target.value)}
        >
          <option value="all">All Sources</option>
          <option value="internal">Internal</option>
          <option value="external">External</option>
        </select>
        <div className="ml-auto">
          <button
            onClick={() => setModal('new')}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium"
          >
            <Plus size={16} /> New Finding
          </button>
        </div>
      </div>

      {loading ? <Spinner /> : error ? <ErrorMsg msg={error} /> : (
        <div className="overflow-x-auto rounded-xl border border-slate-700">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 bg-slate-800/80">
                {['Status', 'Source', 'Area', 'Finding Title', 'Risk Rating', 'Rating Color', 'Individual Responsible', 'Implementation', 'Due Date', ''].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs text-slate-400 font-semibold uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {findings.length === 0 ? (
                <tr><td colSpan={10} className="text-center py-10 text-slate-500">No audit findings found</td></tr>
              ) : findings.map(f => (
                <tr
                  key={f.id}
                  onClick={() => setModal(f)}
                  className="border-b border-slate-700/50 hover:bg-slate-700/40 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3">
                    <Badge text={f.status?.replace(/_/g, ' ')} cls={STATUS_BADGE[f.status] || 'bg-slate-600 text-white'} />
                  </td>
                  <td className="px-4 py-3">
                    <Badge text={f.source} cls={SOURCE_BADGE[f.source] || 'bg-slate-600 text-white'} />
                  </td>
                  <td className="px-4 py-3 text-slate-300 whitespace-nowrap">{f.area || '—'}</td>
                  <td className="px-4 py-3 text-white max-w-[220px]">
                    <div className="truncate font-medium">{f.title}</div>
                    {f.observation && <div className="text-xs text-slate-500 truncate mt-0.5">{f.observation}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <Badge text={f.risk_rating} cls={RISK_RATING_BADGE[f.risk_rating] || 'bg-slate-600 text-white'} />
                  </td>
                  <td className="px-4 py-3">
                    <RatingColorSwatch color={f.rating_color} />
                  </td>
                  <td className="px-4 py-3 text-slate-400 whitespace-nowrap text-xs">{f.individual_responsible || '—'}</td>
                  <td className="px-4 py-3 text-slate-400 max-w-[180px]">
                    <div className="truncate text-xs">{f.implementation || '—'}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-400 whitespace-nowrap text-xs">{f.due_date || '—'}</td>
                  <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setModal(f)} className="text-slate-400 hover:text-blue-400 p-1">
                        <Edit2 size={15} />
                      </button>
                      <button onClick={() => handleDelete(f.id)} className="text-slate-400 hover:text-red-400 p-1">
                        <Trash2 size={15} />
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
  )
}

// ---------------------------------------------------------------------------
// Incidents tab
// ---------------------------------------------------------------------------
function IncidentLogModal({ onClose, onSaved }) {
  const [form, setForm] = useState({
    title: '',
    description: '',
    severity: 'medium',
    detected_at: new Date().toISOString().slice(0, 16),
    reporter: '',
    notes: '',
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.title.trim()) { setErr('Title is required'); return }
    setSaving(true); setErr(null)
    try {
      await quarterlyApi.createIncident(form)
      onSaved(); onClose()
    } catch (ex) {
      setErr(ex.response?.data?.detail || 'Failed to log incident')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="Log Security Incident" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {err && <ErrorMsg msg={err} />}
        <Field label="Title" required>
          <input className={inputCls} value={form.title} onChange={e => set('title', e.target.value)} placeholder="Incident title" />
        </Field>
        <Field label="Description">
          <textarea className={textareaCls} rows={3} value={form.description} onChange={e => set('description', e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Severity" required>
            <select className={selectCls} value={form.severity} onChange={e => set('severity', e.target.value)}>
              {['low','medium','high','critical'].map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1)}</option>)}
            </select>
          </Field>
          <Field label="Reporter">
            <input className={inputCls} value={form.reporter} onChange={e => set('reporter', e.target.value)} placeholder="Name" />
          </Field>
        </div>
        <Field label="Detected At">
          <input type="datetime-local" className={inputCls} value={form.detected_at} onChange={e => set('detected_at', e.target.value)} />
        </Field>
        <Field label="Notes">
          <textarea className={textareaCls} rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} />
        </Field>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 text-sm">Cancel</button>
          <button type="submit" disabled={saving} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50">
            {saving ? 'Saving…' : 'Log Incident'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function IncidentEditModal({ incident, onClose, onSaved }) {
  const [form, setForm] = useState({
    status:       incident.status || 'open',
    contained_at: incident.contained_at ? incident.contained_at.slice(0,16) : '',
    resolved_at:  incident.resolved_at  ? incident.resolved_at.slice(0,16)  : '',
    notes:        incident.notes || '',
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true); setErr(null)
    const payload = { status: form.status, notes: form.notes }
    if (form.contained_at) payload.contained_at = form.contained_at
    if (form.resolved_at)  payload.resolved_at  = form.resolved_at
    try {
      await quarterlyApi.updateIncident(incident.id, payload)
      onSaved(); onClose()
    } catch (ex) {
      setErr(ex.response?.data?.detail || 'Failed to update incident')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`Update Incident: ${incident.title}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {err && <ErrorMsg msg={err} />}
        <Field label="Status">
          <select className={selectCls} value={form.status} onChange={e => set('status', e.target.value)}>
            {['open','contained','resolved','closed'].map(s => (
              <option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1)}</option>
            ))}
          </select>
        </Field>
        <Field label="Contained At">
          <input type="datetime-local" className={inputCls} value={form.contained_at} onChange={e => set('contained_at', e.target.value)} />
        </Field>
        <Field label="Resolved At">
          <input type="datetime-local" className={inputCls} value={form.resolved_at} onChange={e => set('resolved_at', e.target.value)} />
        </Field>
        <Field label="Notes">
          <textarea className={textareaCls} rows={3} value={form.notes} onChange={e => set('notes', e.target.value)} />
        </Field>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 text-sm">Cancel</button>
          <button type="submit" disabled={saving} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50">
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function IncidentsTab({ quarter, year }) {
  const [incidents, setIncidents] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [modal, setModal] = useState(null) // null | 'new' | incident_obj

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await quarterlyApi.incidents(quarter, year)
      setIncidents(res.data)
    } catch (e) {
      setError(e.response?.data?.detail || 'Failed to load incidents')
    } finally {
      setLoading(false)
    }
  }, [quarter, year])

  useEffect(() => { load() }, [load])

  async function handleDelete(id) {
    if (!window.confirm('Delete this security incident?')) return
    try {
      await quarterlyApi.deleteIncident(id)
      load()
    } catch (e) {
      alert(e.response?.data?.detail || 'Delete failed')
    }
  }

  function fmtDate(d) {
    if (!d) return '—'
    return new Date(d).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
  }

  function containHours(inc) {
    if (!inc.contained_at) return '—'
    const diff = (new Date(inc.contained_at) - new Date(inc.detected_at)) / 3600000
    return `${diff.toFixed(1)}h`
  }

  return (
    <div className="space-y-4">
      {modal === 'new' && (
        <IncidentLogModal onClose={() => setModal(null)} onSaved={load} />
      )}
      {modal && modal !== 'new' && (
        <IncidentEditModal incident={modal} onClose={() => setModal(null)} onSaved={load} />
      )}

      <div className="flex items-center justify-end">
        <button
          onClick={() => setModal('new')}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium"
        >
          <Plus size={16} /> Log Incident
        </button>
      </div>

      {loading ? <Spinner /> : error ? <ErrorMsg msg={error} /> : (
        <div className="overflow-x-auto rounded-xl border border-slate-700">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 bg-slate-800/80">
                {['Title','Severity','Status','Detected','Contained','Hrs to Contain','Reporter',''].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs text-slate-400 font-semibold uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {incidents.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-10 text-slate-500">No incidents for Q{quarter} {year}</td></tr>
              ) : incidents.map(inc => (
                <tr
                  key={inc.id}
                  onClick={() => setModal(inc)}
                  className="border-b border-slate-700/50 hover:bg-slate-700/40 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3 text-white font-medium max-w-[240px]">
                    <div className="truncate">{inc.title}</div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge text={inc.severity} cls={SEVERITY_BADGE[inc.severity] || 'bg-slate-600 text-white'} />
                  </td>
                  <td className="px-4 py-3">
                    <Badge text={inc.status} cls={INC_STATUS_BADGE[inc.status] || 'bg-slate-600 text-white'} />
                  </td>
                  <td className="px-4 py-3 text-slate-400 whitespace-nowrap">{fmtDate(inc.detected_at)}</td>
                  <td className="px-4 py-3 text-slate-400 whitespace-nowrap">{fmtDate(inc.contained_at)}</td>
                  <td className="px-4 py-3 text-slate-300 whitespace-nowrap">{containHours(inc)}</td>
                  <td className="px-4 py-3 text-slate-400">{inc.reporter || '—'}</td>
                  <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setModal(inc)} className="text-slate-400 hover:text-blue-400 p-1">
                        <Edit2 size={15} />
                      </button>
                      <button onClick={() => handleDelete(inc.id)} className="text-slate-400 hover:text-red-400 p-1">
                        <Trash2 size={15} />
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
  )
}

// ---------------------------------------------------------------------------
// SLA Settings tab
// ---------------------------------------------------------------------------
function SLATab() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await quarterlyApi.sla()
      setRows(res.data)
    } catch (e) {
      setError(e.response?.data?.detail || 'Failed to load SLA config')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  function update(idx, key, val) {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, [key]: parseInt(val) || 0 } : r))
  }

  async function handleSave() {
    setSaving(true); setError(null); setSuccess(false)
    try {
      await quarterlyApi.updateSla(rows.map(({ severity, contain_hours, resolve_hours }) => ({ severity, contain_hours, resolve_hours })))
      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
    } catch (e) {
      setError(e.response?.data?.detail || 'Failed to save SLA settings')
    } finally {
      setSaving(false)
    }
  }

  // ── Category management state ──
  const [categories, setCategories]     = useState([])
  const [catLoading, setCatLoading]     = useState(false)
  const [newCatName, setNewCatName]     = useState('')
  const [newCatDesc, setNewCatDesc]     = useState('')
  const [addingCat, setAddingCat]       = useState(false)
  const [catErr, setCatErr]             = useState(null)

  const loadCategories = useCallback(async () => {
    setCatLoading(true)
    try {
      const r = await quarterlyApi.categories()
      setCategories(r.data)
    } catch {}
    setCatLoading(false)
  }, [])

  useEffect(() => { loadCategories() }, [loadCategories])

  async function handleAddCategory(e) {
    e.preventDefault()
    if (!newCatName.trim()) return
    setAddingCat(true); setCatErr(null)
    try {
      await quarterlyApi.createCategory({ name: newCatName.trim(), description: newCatDesc.trim() || null })
      setNewCatName(''); setNewCatDesc('')
      loadCategories()
    } catch (e) {
      setCatErr(e.response?.data?.detail || 'Failed to add category')
    } finally { setAddingCat(false) }
  }

  async function handleDeleteCategory(id, name) {
    if (!window.confirm(`Delete category "${name}"?`)) return
    try { await quarterlyApi.deleteCategory(id); loadCategories() }
    catch (e) { alert(e.response?.data?.detail || 'Delete failed') }
  }

  if (loading) return <Spinner />
  if (error) return <ErrorMsg msg={error} />

  return (
    <div className="space-y-8 max-w-2xl">

      {/* SLA config */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-white">Incident Response SLA</h3>
        <div className="text-slate-400 text-xs">Configure response time targets by incident severity.</div>
        <div className="rounded-xl border border-slate-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 bg-slate-800/80">
                <th className="text-left px-4 py-3 text-xs text-slate-400 font-semibold uppercase tracking-wide">Severity</th>
                <th className="text-left px-4 py-3 text-xs text-slate-400 font-semibold uppercase tracking-wide">Contain Within (hrs)</th>
                <th className="text-left px-4 py-3 text-xs text-slate-400 font-semibold uppercase tracking-wide">Resolve Within (hrs)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                <tr key={row.severity} className="border-b border-slate-700/50">
                  <td className="px-4 py-3">
                    <Badge text={row.severity} cls={SEVERITY_BADGE[row.severity] || 'bg-slate-600 text-white'} />
                  </td>
                  <td className="px-4 py-3">
                    <input type="number" min={1}
                      className="w-24 bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
                      value={row.contain_hours}
                      onChange={e => update(idx, 'contain_hours', e.target.value)}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <input type="number" min={1}
                      className="w-24 bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
                      value={row.resolve_hours}
                      onChange={e => update(idx, 'resolve_hours', e.target.value)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {success && (
          <div className="flex items-center gap-2 text-emerald-400 text-sm">
            <CheckCircle size={16} /> SLA settings saved.
          </div>
        )}
        <button onClick={handleSave} disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium disabled:opacity-50"
        >
          <Save size={16} /> {saving ? 'Saving…' : 'Save SLA Settings'}
        </button>
      </div>

      {/* Category management */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-white">Audit Finding Categories</h3>
        <div className="text-slate-400 text-xs">Manage the categories available when logging audit findings.</div>

        {catLoading ? <Spinner /> : (
          <div className="rounded-xl border border-slate-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 bg-slate-800/80">
                  <th className="text-left px-4 py-3 text-xs text-slate-400 font-semibold uppercase tracking-wide">Name</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-400 font-semibold uppercase tracking-wide">Description</th>
                  <th className="px-4 py-3 w-12" />
                </tr>
              </thead>
              <tbody>
                {categories.map(cat => (
                  <tr key={cat.id} className="border-b border-slate-700/50">
                    <td className="px-4 py-2.5 text-white font-medium">{cat.name}</td>
                    <td className="px-4 py-2.5 text-slate-400 text-xs">{cat.description || '—'}</td>
                    <td className="px-4 py-2.5 text-right">
                      <button onClick={() => handleDeleteCategory(cat.id, cat.name)}
                        className="text-slate-500 hover:text-red-400 p-1 transition-colors">
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <form onSubmit={handleAddCategory} className="flex items-end gap-2 flex-wrap">
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs text-slate-400 mb-1">New Category Name</label>
            <input
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              value={newCatName}
              onChange={e => setNewCatName(e.target.value)}
              placeholder="e.g. Physical Security"
            />
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs text-slate-400 mb-1">Description (optional)</label>
            <input
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              value={newCatDesc}
              onChange={e => setNewCatDesc(e.target.value)}
              placeholder="Brief description"
            />
          </div>
          <button type="submit" disabled={addingCat || !newCatName.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-slate-600 hover:bg-slate-500 text-white rounded-lg text-sm font-medium disabled:opacity-40 self-end">
            <Plus size={14} /> {addingCat ? 'Adding…' : 'Add'}
          </button>
        </form>
        {catErr && <ErrorMsg msg={catErr} />}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
const TABS = [
  { id: 'scorecard',  label: 'Scorecard',       icon: BarChart2 },
  { id: 'findings',   label: 'Audit Findings',  icon: FileText },
  { id: 'incidents',  label: 'Incidents',        icon: AlertTriangle },
  { id: 'sla',        label: 'SLA Settings',     icon: Clock },
]

export default function QuarterlyReport() {
  const [quarter, setQuarter] = useState(currentQuarter())
  const [year, setYear]       = useState(currentYear())
  const [activeTab, setActiveTab] = useState('scorecard')
  const [exporting, setExporting] = useState(false)

  async function handleExport() {
    setExporting(true)
    try {
      const token = localStorage.getItem('kifaa_token')
      const url = `/api/v1/quarterly/report/xlsx?quarter=${quarter}&year=${year}`
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) throw new Error(`Export failed: ${res.status}`)
      const blob = await res.blob()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = `quarterly_report_Q${quarter}_${year}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(blobUrl)
    } catch (e) {
      alert(e.message || 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <BarChart2 className="text-blue-400" size={28} />
            Quarterly Security Report
          </h1>
          <p className="text-slate-400 text-sm mt-1">Security metrics and governance tracking</p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Quarter selector */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-400 font-medium">Quarter</label>
            <select
              className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              value={quarter}
              onChange={e => setQuarter(parseInt(e.target.value))}
            >
              {[1,2,3,4].map(q => <option key={q} value={q}>Q{q}</option>)}
            </select>
          </div>

          {/* Year selector */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-400 font-medium">Year</label>
            <input
              type="number"
              min={2000}
              max={2100}
              className="w-24 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              value={year}
              onChange={e => setYear(parseInt(e.target.value) || currentYear())}
            />
          </div>

          {/* Export button */}
          <button
            onClick={handleExport}
            disabled={exporting}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium disabled:opacity-50"
          >
            <Download size={16} />
            {exporting ? 'Generating…' : 'Export XLSX'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-700">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === id
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-white hover:border-slate-500'
            }`}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div>
        {activeTab === 'scorecard' && <ScorecardTab quarter={quarter} year={year} />}
        {activeTab === 'findings'  && <FindingsTab  year={year} />}
        {activeTab === 'incidents' && <IncidentsTab quarter={quarter} year={year} />}
        {activeTab === 'sla'       && <SLATab />}
      </div>
    </div>
  )
}
