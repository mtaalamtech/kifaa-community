import { useState, useEffect, useCallback } from 'react'
import { consolidationApi } from '../api/client'
import * as XLSX from 'xlsx'
import {
  Layers, RefreshCw, Sparkles, Download, ChevronDown, ChevronUp,
  CheckCircle, AlertTriangle, XCircle, ArrowRight, Clock, Save, X, Edit2,
  Server, Cpu, MemoryStick, HardDrive, Shield, Search
} from 'lucide-react'

// ─── constants ────────────────────────────────────────────────────────────────

const ACTIONS = [
  { value: 'keep',        label: 'Keep',        color: 'bg-green-900/40 text-green-300 border-green-700' },
  { value: 'virtualize',  label: 'Virtualize',  color: 'bg-blue-900/40 text-blue-300 border-blue-700' },
  { value: 'consolidate', label: 'Consolidate', color: 'bg-purple-900/40 text-purple-300 border-purple-700' },
  { value: 'migrate',     label: 'Migrate',     color: 'bg-yellow-900/40 text-yellow-300 border-yellow-700' },
  { value: 'cloud',       label: 'Cloud',       color: 'bg-cyan-900/40 text-cyan-300 border-cyan-700' },
  { value: 'decommission',label: 'Decommission',color: 'bg-red-900/40 text-red-300 border-red-700' },
]

const STATUSES = ['draft', 'approved', 'in-progress', 'complete']

const actionStyle = (val) => ACTIONS.find(a => a.value === val)?.color || 'bg-slate-800 text-slate-400 border-slate-700'
const actionLabel = (val) => ACTIONS.find(a => a.value === val)?.label || val || '—'

function pct(v) {
  if (v == null) return '—'
  return `${v.toFixed(0)}%`
}
function gb(v) {
  if (v == null) return '—'
  return `${v.toFixed(0)} GB`
}

// ─── Edit Modal ───────────────────────────────────────────────────────────────

function EditModal({ server, nameMap, onSave, onClose }) {
  const plan = server.plan || {}
  const [form, setForm] = useState({
    server_role:          plan.server_role       || server.detected_role || '',
    recommended_action:   plan.recommended_action || '',
    confirmed_action:     plan.confirmed_action   || '',
    destination_server_id: plan.destination_server_id || '',
    utilization_notes:    plan.utilization_notes  || '',
    dependency_notes:     plan.dependency_notes   || '',
    has_dependencies:     plan.has_dependencies   ?? false,
    retention_months:     plan.retention_months   || '',
    retention_notes:      plan.retention_notes    || '',
    target_date:          plan.target_date        || '',
    rollback_plan:        plan.rollback_plan       || '',
    confirmed_by:         plan.confirmed_by       || '',
    status:               plan.status             || 'draft',
    priority:             plan.priority           || 3,
  })
  const [saving, setSaving] = useState(false)

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function handleSave() {
    setSaving(true)
    try {
      await consolidationApi.upsert(server.agent_id, {
        ...form,
        retention_months: form.retention_months ? parseInt(form.retention_months) : null,
        priority: parseInt(form.priority),
        destination_server_id: form.destination_server_id || null,
      })
      onSave()
    } finally {
      setSaving(false)
    }
  }

  const destOptions = Object.entries(nameMap)
    .filter(([id]) => id !== server.agent_id)
    .sort((a, b) => a[1].localeCompare(b[1]))

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-xl border border-slate-700 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-slate-700">
          <div>
            <h2 className="text-white font-semibold text-lg">{server.name}</h2>
            <p className="text-slate-400 text-sm">{server.os_name} {server.os_version} · {server.ip_address}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20} /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* Role */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Server Role</label>
            <input
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
              value={form.server_role}
              onChange={e => set('server_role', e.target.value)}
              placeholder="e.g. Active Directory / DNS"
            />
          </div>

          {/* Actions row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Recommended Action</label>
              <select
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                value={form.recommended_action}
                onChange={e => set('recommended_action', e.target.value)}
              >
                <option value="">— None —</option>
                {ACTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Confirmed Action</label>
              <select
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                value={form.confirmed_action}
                onChange={e => set('confirmed_action', e.target.value)}
              >
                <option value="">— None —</option>
                {ACTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </div>
          </div>

          {/* Destination */}
          {(form.recommended_action === 'migrate' || form.confirmed_action === 'migrate' ||
            form.recommended_action === 'consolidate' || form.confirmed_action === 'consolidate') && (
            <div>
              <label className="block text-xs text-slate-400 mb-1">Destination Server</label>
              <select
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                value={form.destination_server_id}
                onChange={e => set('destination_server_id', e.target.value)}
              >
                <option value="">— Select server —</option>
                {destOptions.map(([id, name]) => (
                  <option key={id} value={id}>{name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Notes */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Utilization Notes</label>
            <textarea
              rows={2}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 resize-none"
              value={form.utilization_notes}
              onChange={e => set('utilization_notes', e.target.value)}
              placeholder="CPU/RAM observations..."
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Dependency Notes</label>
            <textarea
              rows={2}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 resize-none"
              value={form.dependency_notes}
              onChange={e => set('dependency_notes', e.target.value)}
              placeholder="Software/service dependencies..."
            />
          </div>

          {/* Has deps toggle */}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="has_deps"
              checked={form.has_dependencies}
              onChange={e => set('has_dependencies', e.target.checked)}
              className="accent-blue-500"
            />
            <label htmlFor="has_deps" className="text-sm text-slate-300">Has critical dependencies</label>
          </div>

          {/* Decommission fields */}
          {(form.recommended_action === 'decommission' || form.confirmed_action === 'decommission') && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Retention Period (months)</label>
                <input
                  type="number"
                  min={0}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                  value={form.retention_months}
                  onChange={e => set('retention_months', e.target.value)}
                  placeholder="e.g. 6"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Retention Notes</label>
                <input
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                  value={form.retention_notes}
                  onChange={e => set('retention_notes', e.target.value)}
                  placeholder="What to retain..."
                />
              </div>
            </div>
          )}

          {/* Timeline */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Target Date (max 2026-12-31)</label>
              <input
                type="date"
                max="2026-12-31"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                value={form.target_date}
                onChange={e => set('target_date', e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Priority</label>
              <select
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                value={form.priority}
                onChange={e => set('priority', e.target.value)}
              >
                <option value={1}>1 — High</option>
                <option value={2}>2 — Medium</option>
                <option value={3}>3 — Low</option>
              </select>
            </div>
          </div>

          {/* Rollback */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">Rollback Plan</label>
            <textarea
              rows={2}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 resize-none"
              value={form.rollback_plan}
              onChange={e => set('rollback_plan', e.target.value)}
              placeholder="Steps to reverse if migration fails..."
            />
          </div>

          {/* Status / Confirmed by */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Status</label>
              <select
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                value={form.status}
                onChange={e => set('status', e.target.value)}
              >
                {STATUSES.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1).replace('-', ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Confirmed By</label>
              <input
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                value={form.confirmed_by}
                onChange={e => set('confirmed_by', e.target.value)}
                placeholder="Name / initials"
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 p-5 border-t border-slate-700">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-slate-300 hover:bg-slate-700">Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
          >
            <Save size={15} />
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Export ───────────────────────────────────────────────────────────────────

function buildExcel(data) {
  const wb = XLSX.utils.book_new()
  const { servers, name_map: nameMap, generated_at } = data

  // Sheet 1: Summary
  const actionCounts = {}
  ACTIONS.forEach(a => { actionCounts[a.label] = 0 })
  servers.forEach(s => {
    const action = s.plan?.confirmed_action || s.plan?.recommended_action || 'unassigned'
    const label = actionLabel(action)
    actionCounts[label] = (actionCounts[label] || 0) + 1
  })
  const summaryData = [
    ['Server Consolidation Assessment'],
    [`Generated: ${new Date(generated_at).toLocaleString()}`],
    [],
    ['Action', 'Count'],
    ...Object.entries(actionCounts).map(([a, c]) => [a, c]),
    [],
    ['Total Servers', servers.length],
  ]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryData), 'Summary')

  // Sheet 2: Server Assessment
  const assessHeaders = [
    'Server Name', 'Hostname', 'IP Address', 'OS', 'OS Version',
    'CPU Cores', 'RAM (GB)', 'CPU Avg %', 'RAM Avg %', 'CPU Peak %', 'RAM Peak %',
    'Disk Total (GB)', 'Disk Used (GB)', 'Disk Free (GB)', 'Disk Used %',
    'Detected Role', 'Confirmed Role',
    'Recommended Action', 'Confirmed Action', 'Destination Server',
    'Priority', 'Target Date', 'Status', 'Confirmed By',
  ]
  const assessRows = servers.map(s => {
    const p = s.plan || {}
    return [
      s.name, s.hostname, s.ip_address,
      s.os_name, s.os_version,
      s.cpu_cores || '', s.ram_total_gb || '',
      s.cpu_avg_pct != null ? s.cpu_avg_pct : '',
      s.ram_avg_pct != null ? s.ram_avg_pct : '',
      s.cpu_peak_pct != null ? s.cpu_peak_pct : '',
      s.ram_peak_pct != null ? s.ram_peak_pct : '',
      s.disk_total_gb || '', s.disk_used_gb || '', s.disk_free_gb || '',
      s.disk_used_pct != null ? s.disk_used_pct : '',
      s.detected_role,
      p.server_role || '',
      actionLabel(p.recommended_action),
      actionLabel(p.confirmed_action),
      p.destination_server_id ? (nameMap[p.destination_server_id] || p.destination_server_id) : '',
      p.priority || '',
      p.target_date || '',
      p.status || '',
      p.confirmed_by || '',
    ]
  })
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([assessHeaders, ...assessRows]), 'Server Assessment')

  // Sheet 3: License Dependencies
  const licHeaders = [
    'Server Name', 'Hostname', 'Software / Product', 'License Type',
    'Confirmed Action', 'Notes',
  ]
  const licRows = []
  servers.forEach(s => {
    const action = actionLabel(s.plan?.confirmed_action || s.plan?.recommended_action)
    ;(s.licenses || []).forEach(lic => {
      licRows.push([
        s.name, s.hostname,
        lic.software_name, lic.license_type,
        action,
        s.plan?.dependency_notes || '',
      ])
    })
  })
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([licHeaders, ...licRows]), 'License Dependencies')

  // Sheet 4: Storage Assessment
  const storHeaders = [
    'Server Name', 'Hostname', 'Disk Total (GB)', 'Disk Used (GB)',
    'Disk Free (GB)', 'Disk Used %', 'Confirmed Action', 'Notes',
  ]
  const storRows = servers.map(s => [
    s.name, s.hostname,
    s.disk_total_gb || '',
    s.disk_used_gb  || '',
    s.disk_free_gb  || '',
    s.disk_used_pct != null ? `${s.disk_used_pct}%` : '',
    actionLabel(s.plan?.confirmed_action || s.plan?.recommended_action),
    s.plan?.utilization_notes || '',
  ])
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([storHeaders, ...storRows]), 'Storage Assessment')

  // Sheet 5: Timeline & Rollout
  const timelineHeaders = [
    'Server Name', 'Hostname', 'Priority', 'Confirmed Action',
    'Target Date', 'Status', 'Confirmed By', 'Rollback Plan',
  ]
  const timelineRows = servers
    .filter(s => s.plan?.confirmed_action || s.plan?.recommended_action)
    .sort((a, b) => (a.plan?.priority || 3) - (b.plan?.priority || 3))
    .map(s => {
      const p = s.plan || {}
      return [
        s.name, s.hostname,
        p.priority === 1 ? 'High' : p.priority === 2 ? 'Medium' : 'Low',
        actionLabel(p.confirmed_action || p.recommended_action),
        p.target_date || '',
        p.status || 'draft',
        p.confirmed_by || '',
        p.rollback_plan || '',
      ]
    })
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([timelineHeaders, ...timelineRows]), 'Timeline & Rollout')

  // Sheet 6: Retention Plan — covers decommission AND migrate servers
  const retHeaders = [
    'Server Name', 'Hostname', 'OS', 'OS Version', 'Serial Number',
    'Confirmed Action', 'Confirmed Role',
    'Retention Period (months)', 'Retention Plan / Notes',
    'Target Date', 'Status', 'Confirmed By',
  ]
  const retRows = servers
    .filter(s => {
      const act = s.plan?.confirmed_action || s.plan?.recommended_action
      return act === 'decommission' || act === 'migrate'
    })
    .sort((a, b) => (a.plan?.priority || 3) - (b.plan?.priority || 3))
    .map(s => {
      const p = s.plan || {}
      const action = actionLabel(p.confirmed_action || p.recommended_action)
      return [
        s.name,
        s.hostname,
        s.os_name || '',
        s.os_version || '',
        s.serial_number || '',
        action,
        p.server_role || s.detected_role || '',
        p.retention_months != null ? p.retention_months : '',
        p.retention_notes || '',
        p.target_date || '',
        p.status || 'draft',
        p.confirmed_by || '',
      ]
    })
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([retHeaders, ...retRows]), 'Retention Plan')

  return wb
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Consolidation() {
  const [data, setData]           = useState(null)
  const [loading, setLoading]     = useState(true)
  const [suggesting, setSuggesting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError]         = useState(null)
  const [editServer, setEditServer] = useState(null)
  const [search, setSearch]       = useState('')
  const [filterAction, setFilterAction] = useState('')
  const [sortField, setSortField] = useState('name')
  const [sortDir, setSortDir]     = useState('asc')

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await consolidationApi.data()
      setData(res.data)
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  async function handleAutoSuggest() {
    setSuggesting(true)
    try {
      await consolidationApi.autoSuggest()
      await fetchData()
    } catch (e) {
      alert('Auto-suggest failed: ' + (e.response?.data?.detail || e.message))
    } finally {
      setSuggesting(false)
    }
  }

  async function handleExport() {
    if (!data) return
    setExporting(true)
    try {
      const wb = buildExcel(data)
      const date = new Date().toISOString().slice(0, 10)
      XLSX.writeFile(wb, `Server_Consolidation_${date}.xlsx`)
    } finally {
      setExporting(false)
    }
  }

  function handleSort(field) {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir('asc')
    }
  }

  const SortIcon = ({ field }) => {
    if (sortField !== field) return null
    return sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />
  }

  // ── derived values ──

  const servers = data?.servers || []
  const nameMap = data?.name_map || {}

  const actionCounts = {}
  ACTIONS.forEach(a => { actionCounts[a.value] = 0 })
  servers.forEach(s => {
    const act = s.plan?.confirmed_action || s.plan?.recommended_action
    if (act) actionCounts[act] = (actionCounts[act] || 0) + 1
  })
  const unassigned = servers.filter(s => !s.plan?.recommended_action && !s.plan?.confirmed_action).length

  const filtered = servers
    .filter(s => {
      if (search) {
        const q = search.toLowerCase()
        if (!s.name?.toLowerCase().includes(q) &&
            !s.hostname?.toLowerCase().includes(q) &&
            !s.ip_address?.toLowerCase().includes(q) &&
            !s.detected_role?.toLowerCase().includes(q)) return false
      }
      if (filterAction) {
        const act = s.plan?.confirmed_action || s.plan?.recommended_action
        if (act !== filterAction) return false
      }
      return true
    })
    .sort((a, b) => {
      let av, bv
      switch (sortField) {
        case 'name':    av = a.name; bv = b.name; break
        case 'cpu':     av = a.cpu_avg_pct ?? -1; bv = b.cpu_avg_pct ?? -1; break
        case 'ram':     av = a.ram_avg_pct ?? -1; bv = b.ram_avg_pct ?? -1; break
        case 'disk':    av = a.disk_used_pct ?? -1; bv = b.disk_used_pct ?? -1; break
        case 'action':  av = a.plan?.confirmed_action || a.plan?.recommended_action || ''; bv = b.plan?.confirmed_action || b.plan?.recommended_action || ''; break
        case 'priority':av = a.plan?.priority ?? 9; bv = b.plan?.priority ?? 9; break
        default:        av = a.name; bv = b.name
      }
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv
      return sortDir === 'asc' ? cmp : -cmp
    })

  // ── render ──

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw size={24} className="animate-spin text-blue-400" />
        <span className="ml-3 text-slate-400">Loading server inventory…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-900/20 border border-red-700 rounded-xl p-6 text-red-300">
        <p className="font-semibold">Failed to load consolidation data</p>
        <p className="text-sm mt-1">{error}</p>
        <button onClick={fetchData} className="mt-3 px-4 py-2 rounded-lg bg-red-800 hover:bg-red-700 text-sm text-white">Retry</button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Layers size={22} className="text-blue-400" />
          <div>
            <h1 className="text-xl font-bold text-white">Server Consolidation</h1>
            <p className="text-sm text-slate-400">{servers.length} servers · assessment &amp; migration planning</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={fetchData}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-slate-700 hover:bg-slate-600 text-slate-300"
          >
            <RefreshCw size={14} /> Refresh
          </button>
          <button
            onClick={handleAutoSuggest}
            disabled={suggesting}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-purple-700 hover:bg-purple-600 text-white disabled:opacity-50"
          >
            <Sparkles size={14} />
            {suggesting ? 'Analysing…' : 'Auto-Suggest'}
          </button>
          <button
            onClick={handleExport}
            disabled={exporting}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-green-700 hover:bg-green-600 text-white disabled:opacity-50"
          >
            <Download size={14} />
            {exporting ? 'Exporting…' : 'Export Excel'}
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        {ACTIONS.map(a => (
          <button
            key={a.value}
            onClick={() => setFilterAction(filterAction === a.value ? '' : a.value)}
            className={`rounded-xl border p-3 text-left transition-all ${
              filterAction === a.value
                ? a.color + ' border-opacity-100'
                : 'bg-slate-800/60 border-slate-700 hover:border-slate-600'
            }`}
          >
            <div className="text-2xl font-bold text-white">{actionCounts[a.value] || 0}</div>
            <div className="text-xs text-slate-400 mt-0.5">{a.label}</div>
          </button>
        ))}
        <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-3">
          <div className="text-2xl font-bold text-slate-500">{unassigned}</div>
          <div className="text-xs text-slate-500 mt-0.5">Unassigned</div>
        </div>
      </div>

      {/* Search / filter bar */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
            placeholder="Search server name, IP, role…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        {filterAction && (
          <button
            onClick={() => setFilterAction('')}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-slate-700 text-slate-300 hover:bg-slate-600"
          >
            <X size={13} /> Clear filter
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-slate-800/60 rounded-xl border border-slate-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-xs text-slate-400">
                <th className="text-left px-4 py-3 cursor-pointer hover:text-white select-none whitespace-nowrap" onClick={() => handleSort('name')}>
                  <span className="flex items-center gap-1">Server <SortIcon field="name" /></span>
                </th>
                <th className="text-left px-3 py-3 whitespace-nowrap">OS</th>
                <th className="text-left px-3 py-3 whitespace-nowrap">Detected Role</th>
                <th className="text-right px-3 py-3 cursor-pointer hover:text-white select-none whitespace-nowrap" onClick={() => handleSort('cpu')}>
                  <span className="flex items-center justify-end gap-1">CPU Avg <SortIcon field="cpu" /></span>
                </th>
                <th className="text-right px-3 py-3 cursor-pointer hover:text-white select-none whitespace-nowrap" onClick={() => handleSort('ram')}>
                  <span className="flex items-center justify-end gap-1">RAM Avg <SortIcon field="ram" /></span>
                </th>
                <th className="text-right px-3 py-3 cursor-pointer hover:text-white select-none whitespace-nowrap" onClick={() => handleSort('disk')}>
                  <span className="flex items-center justify-end gap-1">Disk <SortIcon field="disk" /></span>
                </th>
                <th className="text-left px-3 py-3 cursor-pointer hover:text-white select-none whitespace-nowrap" onClick={() => handleSort('action')}>
                  <span className="flex items-center gap-1">Action <SortIcon field="action" /></span>
                </th>
                <th className="text-left px-3 py-3 whitespace-nowrap">Destination</th>
                <th className="text-left px-3 py-3 whitespace-nowrap">Target Date</th>
                <th className="text-left px-3 py-3 cursor-pointer hover:text-white select-none whitespace-nowrap" onClick={() => handleSort('priority')}>
                  <span className="flex items-center gap-1">Priority <SortIcon field="priority" /></span>
                </th>
                <th className="text-left px-3 py-3 whitespace-nowrap">Status</th>
                <th className="text-right px-4 py-3 whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={12} className="text-center py-12 text-slate-500">
                    {search || filterAction ? 'No servers match the current filter.' : 'No servers found.'}
                  </td>
                </tr>
              )}
              {filtered.map(s => {
                const p = s.plan || {}
                const action = p.confirmed_action || p.recommended_action
                const destName = p.destination_server_id ? (nameMap[p.destination_server_id] || '—') : ''
                const isConfirmed = !!p.confirmed_action
                const cpuHigh = s.cpu_avg_pct > 70
                const ramHigh = s.ram_avg_pct > 80
                const diskHigh = s.disk_used_pct > 85

                return (
                  <tr key={s.agent_id} className="border-b border-slate-700/50 hover:bg-slate-700/20 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-white text-sm">{s.name}</div>
                      <div className="text-xs text-slate-500">{s.ip_address}</div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="text-xs text-slate-300 max-w-[120px] truncate" title={`${s.os_name} ${s.os_version}`}>
                        {s.os_name}
                      </div>
                      <div className="text-xs text-slate-500">{s.os_version}</div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="text-xs text-slate-300 max-w-[160px]" title={p.server_role || s.detected_role}>
                        {p.server_role || s.detected_role}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <span className={`text-sm font-mono ${cpuHigh ? 'text-red-400' : 'text-slate-300'}`}>
                        {pct(s.cpu_avg_pct)}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <span className={`text-sm font-mono ${ramHigh ? 'text-red-400' : 'text-slate-300'}`}>
                        {pct(s.ram_avg_pct)}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <span className={`text-sm font-mono ${diskHigh ? 'text-orange-400' : 'text-slate-300'}`}>
                        {pct(s.disk_used_pct)}
                      </span>
                      {s.disk_used_gb != null && (
                        <div className="text-xs text-slate-500">{gb(s.disk_used_gb)} / {gb(s.disk_total_gb)}</div>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {action ? (
                        <div className="space-y-1">
                          {p.recommended_action && !isConfirmed && (
                            <span className={`inline-block px-2 py-0.5 rounded-md text-xs border ${actionStyle(p.recommended_action)}`}>
                              {actionLabel(p.recommended_action)}
                            </span>
                          )}
                          {isConfirmed && (
                            <div className="flex items-center gap-1">
                              <span className={`inline-block px-2 py-0.5 rounded-md text-xs border ${actionStyle(p.confirmed_action)}`}>
                                {actionLabel(p.confirmed_action)}
                              </span>
                              <CheckCircle size={12} className="text-green-400" />
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-600 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {destName ? (
                        <div className="flex items-center gap-1 text-xs text-slate-300">
                          <ArrowRight size={11} className="text-slate-500" />
                          {destName}
                        </div>
                      ) : (
                        <span className="text-slate-600 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {p.target_date ? (
                        <div className="flex items-center gap-1 text-xs text-slate-300">
                          <Clock size={11} className="text-slate-500" />
                          {p.target_date}
                        </div>
                      ) : (
                        <span className="text-slate-600 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {p.priority ? (
                        <span className={`text-xs font-medium ${
                          p.priority === 1 ? 'text-red-400' :
                          p.priority === 2 ? 'text-yellow-400' : 'text-slate-400'
                        }`}>
                          {p.priority === 1 ? 'High' : p.priority === 2 ? 'Med' : 'Low'}
                        </span>
                      ) : <span className="text-slate-600 text-xs">—</span>}
                    </td>
                    <td className="px-3 py-3">
                      {p.status ? (
                        <span className={`text-xs px-2 py-0.5 rounded-full border ${
                          p.status === 'complete'    ? 'bg-green-900/40 text-green-300 border-green-700' :
                          p.status === 'in-progress' ? 'bg-blue-900/40 text-blue-300 border-blue-700' :
                          p.status === 'approved'    ? 'bg-purple-900/40 text-purple-300 border-purple-700' :
                          'bg-slate-800 text-slate-400 border-slate-700'
                        }`}>
                          {p.status}
                        </span>
                      ) : <span className="text-slate-600 text-xs">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setEditServer(s)}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 ml-auto"
                      >
                        <Edit2 size={12} /> Edit
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Table footer */}
        <div className="px-4 py-3 border-t border-slate-700 flex items-center justify-between text-xs text-slate-500">
          <span>Showing {filtered.length} of {servers.length} servers</span>
          {data?.generated_at && (
            <span>Data as of {new Date(data.generated_at).toLocaleTimeString()}</span>
          )}
        </div>
      </div>

      {/* Notes legend */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-slate-800/40 rounded-xl border border-slate-700 p-4">
          <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
            <Shield size={14} className="text-blue-400" /> How Auto-Suggest Works
          </h3>
          <ul className="text-xs text-slate-400 space-y-1">
            <li>• <span className="text-green-400">Keep</span> — AD/DNS, high utilisation (&gt;70% CPU / &gt;80% RAM)</li>
            <li>• <span className="text-yellow-400">Migrate</span> — MSSQL, SAP, legacy OS (2008/2012 R2)</li>
            <li>• <span className="text-cyan-400">Cloud</span> — Linux web servers with low on-prem dependency</li>
            <li>• <span className="text-purple-400">Consolidate</span> — Low utilisation (&lt;20% CPU, &lt;35% RAM)</li>
            <li>• <span className="text-blue-400">Virtualize</span> — Very low utilisation (&lt;10% CPU, &lt;20% RAM)</li>
            <li>• <span className="text-red-400">Decommission</span> — Desktops, end-of-life servers with no active role</li>
          </ul>
        </div>
        <div className="bg-slate-800/40 rounded-xl border border-slate-700 p-4">
          <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-2">
            <Clock size={14} className="text-yellow-400" /> Timeline Constraints
          </h3>
          <ul className="text-xs text-slate-400 space-y-1">
            <li>• All target dates must be set before <span className="text-white">31 Dec 2026</span></li>
            <li>• Priority 1 (High) actions should target H1 2026</li>
            <li>• Priority 2 (Medium) actions — H2 2026</li>
            <li>• Legacy OS (2008 R2) servers are end-of-life and high priority</li>
            <li>• Confirmed actions lock the recommendation — re-edit to change</li>
            <li>• Export generates a full 6-sheet report for management review</li>
          </ul>
        </div>
      </div>

      {/* Edit modal */}
      {editServer && (
        <EditModal
          server={editServer}
          nameMap={nameMap}
          onSave={async () => { setEditServer(null); await fetchData() }}
          onClose={() => setEditServer(null)}
        />
      )}
    </div>
  )
}
