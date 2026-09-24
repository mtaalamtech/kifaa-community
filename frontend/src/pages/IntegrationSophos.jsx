import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Shield, ArrowLeft, RefreshCw, AlertTriangle, Clock,
  CheckCircle, XCircle, Download, Search, FileSpreadsheet,
  Skull, WifiOff, Bug, Key, CalendarX, CalendarClock, Plus, Trash2, Edit3, X,
  FileText, ChevronDown,
} from 'lucide-react'
import { integrationsApi } from '../api/client'

// ── EOL OS detection ────────────────────────────────────────────────────────
const EOL_PATTERNS = [
  'Windows 7', 'Windows XP', 'Windows Vista',
  'Server 2003', 'Server 2008', 'Server 2012', 'Windows 8',
]
function isEOL(osName) {
  return EOL_PATTERNS.some(p => (osName || '').includes(p))
}
function isStale(lastSeen, days = 7) {
  if (!lastSeen) return true
  return (Date.now() - new Date(lastSeen).getTime()) > days * 86400000
}

// ── Badges ──────────────────────────────────────────────────────────────────
function HealthBadge({ status }) {
  const map = {
    good:       'bg-green-900/40 text-green-300 border-green-700',
    suspicious: 'bg-yellow-900/40 text-yellow-300 border-yellow-700',
    bad:        'bg-red-900/40 text-red-300 border-red-700',
    unknown:    'bg-slate-800 text-slate-400 border-slate-600',
  }
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border capitalize ${map[status] || map.unknown}`}>
      {status || 'unknown'}
    </span>
  )
}

function SeverityBadge({ severity }) {
  const map = {
    high:   'bg-red-900/40 text-red-300 border-red-700',
    medium: 'bg-yellow-900/40 text-yellow-300 border-yellow-700',
    low:    'bg-blue-900/40 text-blue-300 border-blue-700',
  }
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border capitalize ${map[severity] || 'bg-slate-800 text-slate-400 border-slate-600'}`}>
      {severity || 'info'}
    </span>
  )
}

function CategoryBadge({ category }) {
  const map = {
    malware:          'bg-red-900/40 text-red-300 border-red-700',
    pua:              'bg-orange-900/40 text-orange-300 border-orange-700',
    runtimedetections:'bg-purple-900/40 text-purple-300 border-purple-700',
    security:         'bg-yellow-900/40 text-yellow-300 border-yellow-700',
    connectivity:     'bg-blue-900/40 text-blue-300 border-blue-700',
    updating:         'bg-slate-800 text-slate-400 border-slate-600',
    general:          'bg-slate-800 text-slate-400 border-slate-600',
  }
  const key = (category || '').toLowerCase()
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border capitalize ${map[key] || 'bg-slate-800 text-slate-400 border-slate-600'}`}>
      {category || 'unknown'}
    </span>
  )
}

// ── CSV export ──────────────────────────────────────────────────────────────
function exportEndpointsCSV(endpoints, filename = 'sophos-endpoints.csv') {
  const headers = ['Hostname', 'Health', 'OS', 'IP Address', 'Group', 'Last Seen', 'Tamper Protection', 'EOL', 'Stale']
  const rows = endpoints.map(ep => [
    ep.hostname || '',
    ep.health_status || '',
    ep.os_name || '',
    ep.ip_address || '',
    ep.group_name || '',
    ep.last_seen ? new Date(ep.last_seen).toLocaleString() : 'Never',
    ep.tamper_protection ? 'Yes' : 'No',
    isEOL(ep.os_name) ? 'Yes' : 'No',
    isStale(ep.last_seen) ? 'Yes' : 'No',
  ])
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

function exportAlertsCSV(alerts) {
  const headers = ['Severity', 'Category', 'Description', 'Endpoint', 'Raised At']
  const rows = alerts.map(a => [
    a.severity || '', a.category || '', a.description || '',
    a.endpoint_hostname || '', a.raised_at ? new Date(a.raised_at).toLocaleString() : '',
  ])
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = 'sophos-alerts.csv'; a.click()
  URL.revokeObjectURL(url)
}

// ── Endpoints table ─────────────────────────────────────────────────────────
function EndpointTable({ rows, emptyMsg }) {
  return rows.length === 0 ? (
    <div className="p-8 text-center text-slate-400 text-sm">{emptyMsg || 'No endpoints.'}</div>
  ) : (
    <table className="w-full text-sm">
      <thead className="text-slate-400 text-xs uppercase tracking-wider border-b border-slate-700">
        <tr>
          <th className="px-4 py-2 text-left">Hostname</th>
          <th className="px-4 py-2 text-left">Health</th>
          <th className="px-4 py-2 text-left">OS</th>
          <th className="px-4 py-2 text-left">IP</th>
          <th className="px-4 py-2 text-left">Group</th>
          <th className="px-4 py-2 text-left">Last Seen</th>
          <th className="px-4 py-2 text-left">Tamper</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-700">
        {rows.map((ep, i) => (
          <tr key={i} className="hover:bg-slate-700/30">
            <td className="px-4 py-2.5 text-white font-medium">{ep.hostname}</td>
            <td className="px-4 py-2.5"><HealthBadge status={ep.health_status} /></td>
            <td className="px-4 py-2.5 text-xs">
              <span className={isEOL(ep.os_name) ? 'text-red-400 font-medium' : 'text-slate-400'}>
                {ep.os_name || '—'}
                {isEOL(ep.os_name) && <span className="ml-1 text-red-500">(EOL)</span>}
              </span>
            </td>
            <td className="px-4 py-2.5 text-slate-400 text-xs font-mono">{ep.ip_address || '—'}</td>
            <td className="px-4 py-2.5 text-slate-400 text-xs">{ep.group_name || '—'}</td>
            <td className="px-4 py-2.5 text-xs">
              <span className={isStale(ep.last_seen) ? 'text-orange-400' : 'text-slate-500'}>
                {ep.last_seen ? new Date(ep.last_seen).toLocaleDateString() : 'Never'}
              </span>
            </td>
            <td className="px-4 py-2.5">
              {ep.tamper_protection
                ? <CheckCircle size={14} className="text-green-400" />
                : <XCircle size={14} className="text-slate-500" />}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── License status badge ─────────────────────────────────────────────────────
function LicenseBadge({ status }) {
  const map = {
    active:        'bg-green-900/40 text-green-300 border-green-700',
    perpetual:     'bg-blue-900/40 text-blue-300 border-blue-700',
    expiring_soon: 'bg-yellow-900/40 text-yellow-300 border-yellow-700',
    expired:       'bg-red-900/40 text-red-300 border-red-700',
  }
  const labels = { active: 'Active', perpetual: 'Perpetual', expiring_soon: 'Expiring Soon', expired: 'Expired' }
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${map[status] || map.active}`}>
      {labels[status] || status}
    </span>
  )
}

// ── License add/edit modal ───────────────────────────────────────────────────
const EMPTY_LIC = { product_name: '', license_type: 'subscription', starts_at: '', expires_at: '', quantity: '', used_quantity: '' }

function LicenseModal({ initial, onSave, onClose }) {
  const [form, setForm] = useState(initial || EMPTY_LIC)
  const [saving, setSaving] = useState(false)
  const isEdit = Boolean(initial?.license_id)

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const handleSave = async () => {
    if (!form.product_name.trim()) return
    setSaving(true)
    try { await onSave(form) } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-md">
        <div className="flex items-center gap-3 p-5 border-b border-slate-700">
          <Key size={18} className="text-blue-400" />
          <span className="text-white font-semibold">{isEdit ? 'Edit License' : 'Add License'}</span>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-white"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Product / License Name *</label>
            <input value={form.product_name} onChange={e => set('product_name', e.target.value)}
              placeholder="e.g. Sophos Central Endpoint Advanced"
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">License Type</label>
              <select value={form.license_type} onChange={e => set('license_type', e.target.value)}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white">
                <option value="subscription">Subscription</option>
                <option value="trial">Trial</option>
                <option value="term">Term</option>
                <option value="perpetual">Perpetual</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Total Seats</label>
              <input type="number" min="0" value={form.quantity} onChange={e => set('quantity', e.target.value)}
                placeholder="0"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Start Date</label>
              <input type="date" value={form.starts_at ? form.starts_at.substring(0, 10) : ''} onChange={e => set('starts_at', e.target.value)}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Expiry Date</label>
              <input type="date" value={form.expires_at ? form.expires_at.substring(0, 10) : ''} onChange={e => set('expires_at', e.target.value)}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Used Seats</label>
            <input type="number" min="0" value={form.used_quantity} onChange={e => set('used_quantity', e.target.value)}
              placeholder="0"
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500" />
          </div>
        </div>
        <div className="flex gap-3 px-5 pb-5">
          <button onClick={onClose} className="flex-1 px-4 py-2 border border-slate-600 rounded-lg text-slate-300 text-sm hover:bg-slate-700">Cancel</button>
          <button onClick={handleSave} disabled={saving || !form.product_name.trim()}
            className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white text-sm disabled:opacity-50">
            {saving ? 'Saving…' : isEdit ? 'Update' : 'Add License'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main page ───────────────────────────────────────────────────────────────
export default function IntegrationSophos() {
  const navigate = useNavigate()
  const [dash, setDash] = useState(null)
  const [endpoints, setEndpoints] = useState([])
  const [alerts, setAlerts] = useState([])
  const [licenses, setLicenses] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [tab, setTab] = useState('endpoints')
  const [healthFilter, setHealthFilter] = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [search, setSearch] = useState('')
  const [licenseModal, setLicenseModal] = useState(null) // null=closed, {}=new, {...}=editing
  const [reportYear, setReportYear]     = useState(new Date().getFullYear())
  const [report, setReport]             = useState(null)
  const [reportLoading, setReportLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [d, ep, al, lic] = await Promise.all([
        integrationsApi.sophos.dashboard(),
        integrationsApi.sophos.endpoints(),
        integrationsApi.sophos.alerts(),
        integrationsApi.sophos.licenses(),
      ])
      setDash(d.data)
      setEndpoints(ep.data || [])
      setAlerts(al.data || [])
      setLicenses(lic.data || [])
    } catch (e) { console.error(e) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const handleSync = async () => {
    setSyncing(true)
    try {
      await integrationsApi.sync('sophos')
      setTimeout(load, 4000)
    } catch (e) { alert('Sync failed: ' + (e.response?.data?.detail || e.message)) }
    setSyncing(false)
  }

  // Derived lists
  const eolEndpoints   = endpoints.filter(ep => isEOL(ep.os_name))
  const staleEndpoints = endpoints.filter(ep => isStale(ep.last_seen))
  const filteredEndpoints = endpoints.filter(ep => {
    if (healthFilter && ep.health_status !== healthFilter) return false
    if (search && !ep.hostname?.toLowerCase().includes(search.toLowerCase()) &&
        !ep.ip_address?.includes(search) && !ep.os_name?.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })
  const filteredAlerts = alerts.filter(a => {
    if (catFilter && (a.category || '').toLowerCase() !== catFilter.toLowerCase()) return false
    if (search && !a.description?.toLowerCase().includes(search.toLowerCase()) &&
        !a.endpoint_hostname?.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const expiringLicenses = licenses.filter(l => l.expiry_status === 'expiring_soon' || l.expiry_status === 'expired')

  const handleSaveLicense = async (form) => {
    if (form.license_id) {
      await integrationsApi.sophos.updateLicense(form.license_id, form)
    } else {
      await integrationsApi.sophos.addLicense(form)
    }
    setLicenseModal(null)
    load()
  }

  const handleDeleteLicense = async (licenseId) => {
    if (!confirm('Delete this license entry?')) return
    await integrationsApi.sophos.deleteLicense(licenseId)
    load()
  }

  const loadReport = useCallback(async (yr) => {
    setReportLoading(true)
    try {
      const token = localStorage.getItem('kifaa_token')
      const res = await fetch(`/api/v1/integrations/sophos/incident-report?year=${yr}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json()
      setReport(data)
    } catch (e) { console.error(e) }
    setReportLoading(false)
  }, [])

  const handleReportTab = () => {
    if (!report || report.year !== reportYear) loadReport(reportYear)
  }

  const handleExportXlsx = (yr) => {
    const token = localStorage.getItem('kifaa_token')
    fetch(`/api/v1/integrations/sophos/incident-report/xlsx?year=${yr}`, {
      headers: { Authorization: `Bearer ${token}` }
    }).then(r => r.blob()).then(blob => {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `sophos_incident_report_${yr}.xlsx`; a.click()
      URL.revokeObjectURL(url)
    })
  }

  const TABS = [
    { id: 'endpoints',  label: `Endpoints (${endpoints.length})` },
    { id: 'stale',      label: `Not Reporting (${staleEndpoints.length})`,  warn: staleEndpoints.length > 0 },
    { id: 'eol',        label: `End of Life (${eolEndpoints.length})`,       warn: eolEndpoints.length > 0 },
    { id: 'alerts',     label: `Alerts (${alerts.length})` },
    { id: 'licenses',   label: `Licenses (${licenses.length})`, warn: expiringLicenses.length > 0 },
    { id: 'report',     label: 'Incident Report' },
  ]

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate('/integrations')} className="text-slate-400 hover:text-white">
          <ArrowLeft size={20} />
        </button>
        <div className="w-10 h-10 rounded-xl bg-red-600/20 flex items-center justify-center">
          <Shield size={20} className="text-red-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Sophos Central</h1>
          <p className="text-sm text-slate-400">Endpoint security — health, threats, EOL &amp; reporting</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {dash?.plugin?.last_sync_at && (
            <span className="text-xs text-slate-500 flex items-center gap-1">
              <Clock size={11} /> {new Date(dash.plugin.last_sync_at).toLocaleString()}
            </span>
          )}
          <button onClick={handleSync} disabled={syncing}
            className="flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-white disabled:opacity-50">
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing…' : 'Sync Now'}
          </button>
        </div>
      </div>

      {/* Not connected warning — only when data loaded but genuinely disconnected */}
      {!loading && dash && dash.plugin?.status !== 'connected' && (
        <div className="bg-yellow-900/30 border border-yellow-700 rounded-xl p-4 mb-6 flex items-center gap-3">
          <AlertTriangle size={18} className="text-yellow-400" />
          <div>
            <div className="text-yellow-300 font-medium">Integration not connected</div>
            <div className="text-yellow-400 text-sm">
              Go to Integrations hub, configure Sophos credentials and click Test Connection.
            </div>
          </div>
        </div>
      )}

      {/* License expiry warning banner */}
      {!loading && expiringLicenses.length > 0 && (
        <div className="bg-yellow-900/30 border border-yellow-700 rounded-xl p-4 mb-4 flex items-start gap-3">
          <CalendarX size={18} className="text-yellow-400 mt-0.5 shrink-0" />
          <div>
            <div className="text-yellow-300 font-medium">License Expiry Warning</div>
            <div className="text-yellow-400 text-sm mt-1 space-y-0.5">
              {expiringLicenses.map((l, i) => (
                <div key={i}>
                  <span className="font-medium">{l.product_name || 'Unknown product'}</span>
                  {l.expiry_status === 'expired'
                    ? <span className="text-red-400 ml-2">— EXPIRED</span>
                    : <span className="ml-2">— expires in <span className="font-bold">{l.days_remaining} day{l.days_remaining !== 1 ? 's' : ''}</span> ({l.expires_at ? new Date(l.expires_at).toLocaleDateString() : '?'})</span>
                  }
                </div>
              ))}
            </div>
          </div>
          <button onClick={() => setTab('licenses')} className="ml-auto text-xs text-yellow-300 hover:text-yellow-200 underline whitespace-nowrap">View Licenses</button>
        </div>
      )}

      {loading ? (
        <div className="text-center text-slate-400 py-16">Loading Sophos data…</div>
      ) : (
        <div className="space-y-6">

          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-7 gap-3">
            {[
              { label: 'Total',         value: dash?.endpoints?.total    ?? 0, color: 'text-white' },
              { label: 'Healthy',       value: dash?.endpoints?.healthy  ?? 0, color: 'text-green-400' },
              { label: 'Suspicious',    value: dash?.endpoints?.suspicious ?? 0, color: 'text-yellow-400' },
              { label: 'Unhealthy',     value: dash?.endpoints?.unhealthy ?? 0, color: (dash?.endpoints?.unhealthy ?? 0) > 0 ? 'text-red-400' : 'text-slate-400' },
              { label: 'Not Reporting', value: dash?.endpoints?.stale    ?? 0, color: (dash?.endpoints?.stale ?? 0) > 0 ? 'text-orange-400' : 'text-slate-400', icon: WifiOff },
              { label: 'End of Life',   value: dash?.endpoints?.eol      ?? 0, color: (dash?.endpoints?.eol ?? 0) > 0 ? 'text-red-400' : 'text-slate-400', icon: Skull },
              { label: 'Total Alerts',  value: dash?.alerts?.total       ?? 0, color: (dash?.alerts?.total ?? 0) > 0 ? 'text-red-400' : 'text-green-400', icon: Bug },
            ].map((c, i) => (
              <div key={i} className="bg-slate-800 border border-slate-700 rounded-xl p-4">
                <div className="flex items-center gap-1 text-xs text-slate-400 mb-1">
                  {c.icon && <c.icon size={10} />}{c.label}
                </div>
                <div className={`text-2xl font-bold ${c.color}`}>{c.value}</div>
              </div>
            ))}
          </div>

          {/* Alert category breakdown */}
          {(dash?.alerts?.categories || []).length > 0 && (
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
              <div className="text-xs text-slate-400 mb-3 font-medium uppercase tracking-wider">Alert Breakdown by Category</div>
              <div className="flex flex-wrap gap-2">
                {dash.alerts.categories.map((c, i) => (
                  <button key={i}
                    onClick={() => { setTab('alerts'); setCatFilter(c.category === catFilter ? '' : c.category) }}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs cursor-pointer transition-colors
                      ${catFilter === c.category ? 'bg-slate-600 border-slate-400' : 'bg-slate-900 border-slate-700 hover:border-slate-500'}`}>
                    <CategoryBadge category={c.category} />
                    <span className="text-white font-medium">{c.count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Tabs */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
            {/* Tab bar */}
            <div className="flex border-b border-slate-700 bg-slate-900">
              {TABS.map(t => (
                <button key={t.id} onClick={() => { setTab(t.id); if (t.id === 'report') handleReportTab() }}
                  className={`px-5 py-3 text-sm font-medium transition-colors flex items-center gap-1.5
                    ${tab === t.id
                      ? 'text-white border-b-2 border-blue-500 bg-slate-800'
                      : 'text-slate-400 hover:text-white'}`}>
                  {t.warn && <span className="w-2 h-2 rounded-full bg-orange-400 inline-block" />}
                  {t.label}
                </button>
              ))}
              {/* Search / filter bar */}
              <div className="ml-auto flex items-center gap-2 px-4">
                {tab === 'endpoints' && (
                  <select value={healthFilter} onChange={e => setHealthFilter(e.target.value)}
                    className="bg-slate-800 border border-slate-600 rounded-lg px-2 py-1 text-xs text-white">
                    <option value="">All health</option>
                    <option value="good">Good</option>
                    <option value="suspicious">Suspicious</option>
                    <option value="bad">Bad</option>
                  </select>
                )}
                {tab === 'alerts' && (
                  <select value={catFilter} onChange={e => setCatFilter(e.target.value)}
                    className="bg-slate-800 border border-slate-600 rounded-lg px-2 py-1 text-xs text-white">
                    <option value="">All categories</option>
                    {(dash?.alerts?.categories || []).map(c => (
                      <option key={c.category} value={c.category}>{c.category} ({c.count})</option>
                    ))}
                  </select>
                )}
                <div className="relative">
                  <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input value={search} onChange={e => setSearch(e.target.value)}
                    placeholder="Search…"
                    className="bg-slate-800 border border-slate-600 rounded-lg pl-7 pr-3 py-1 text-xs text-white w-32" />
                </div>
                {tab === 'endpoints' && (
                  <button onClick={() => exportEndpointsCSV(filteredEndpoints)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-xs">
                    <Download size={12} /> Export CSV
                  </button>
                )}
                {tab === 'stale' && (
                  <button onClick={() => exportEndpointsCSV(staleEndpoints, 'sophos-not-reporting.csv')}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-xs">
                    <Download size={12} /> Export CSV
                  </button>
                )}
                {tab === 'eol' && (
                  <button onClick={() => exportEndpointsCSV(eolEndpoints, 'sophos-eol.csv')}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-xs">
                    <Download size={12} /> Export CSV
                  </button>
                )}
                {tab === 'alerts' && (
                  <button onClick={() => exportAlertsCSV(filteredAlerts)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-xs">
                    <Download size={12} /> Export CSV
                  </button>
                )}
                {tab === 'report' && (
                  <div className="flex items-center gap-2">
                    <select
                      value={reportYear}
                      onChange={e => { const y = Number(e.target.value); setReportYear(y); loadReport(y) }}
                      className="bg-slate-800 border border-slate-600 rounded-lg px-2 py-1 text-xs text-white"
                    >
                      {Array.from({ length: new Date().getFullYear() - 2024 }, (_, i) => 2025 + i).map(y => (
                        <option key={y} value={y}>{y}</option>
                      ))}
                    </select>
                    <button onClick={() => handleExportXlsx(reportYear)}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded-lg text-xs">
                      <FileSpreadsheet size={12} /> Export XLSX
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Tab content */}
            {tab === 'endpoints' && <EndpointTable rows={filteredEndpoints} emptyMsg="No endpoints match your filters." />}

            {tab === 'stale' && (
              <div>
                <div className="px-5 py-3 bg-orange-900/20 border-b border-slate-700 flex items-center gap-2">
                  <WifiOff size={14} className="text-orange-400" />
                  <span className="text-sm text-orange-300">
                    {staleEndpoints.length} endpoint{staleEndpoints.length !== 1 ? 's' : ''} have not reported in over 7 days
                  </span>
                </div>
                <EndpointTable rows={staleEndpoints} emptyMsg="All endpoints are reporting normally." />
              </div>
            )}

            {tab === 'eol' && (
              <div>
                <div className="px-5 py-3 bg-red-900/20 border-b border-slate-700 flex items-center gap-2">
                  <Skull size={14} className="text-red-400" />
                  <span className="text-sm text-red-300">
                    {eolEndpoints.length} endpoint{eolEndpoints.length !== 1 ? 's' : ''} running end-of-life operating systems (Windows 7, Server 2008/2012, XP, Vista, etc.)
                  </span>
                </div>
                <EndpointTable rows={eolEndpoints} emptyMsg="No end-of-life operating systems detected." />
              </div>
            )}

            {tab === 'alerts' && (
              filteredAlerts.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-sm">No alerts found.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-slate-400 text-xs uppercase tracking-wider border-b border-slate-700">
                    <tr>
                      <th className="px-4 py-2 text-left">Severity</th>
                      <th className="px-4 py-2 text-left">Category</th>
                      <th className="px-4 py-2 text-left">Description</th>
                      <th className="px-4 py-2 text-left">Endpoint</th>
                      <th className="px-4 py-2 text-left">Raised</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700">
                    {filteredAlerts.map((a, i) => (
                      <tr key={i} className="hover:bg-slate-700/30">
                        <td className="px-4 py-2.5"><SeverityBadge severity={a.severity} /></td>
                        <td className="px-4 py-2.5"><CategoryBadge category={a.category} /></td>
                        <td className="px-4 py-2.5 text-white text-sm max-w-md">{a.description || '—'}</td>
                        <td className="px-4 py-2.5 text-slate-400 text-xs">{a.endpoint_hostname || '—'}</td>
                        <td className="px-4 py-2.5 text-xs text-slate-500 whitespace-nowrap">
                          {a.raised_at ? new Date(a.raised_at).toLocaleString() : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}

            {tab === 'licenses' && (
              <div>
                <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
                  <span className="text-xs text-slate-400">
                    {licenses.length === 0
                      ? 'No licenses recorded. Add license details manually — Sophos Central API does not expose license info at tenant level.'
                      : `${licenses.length} license${licenses.length !== 1 ? 's' : ''} tracked`}
                  </span>
                  <button onClick={() => setLicenseModal({})}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs">
                    <Plus size={12} /> Add License
                  </button>
                </div>
                {licenses.length === 0 ? (
                  <div className="p-10 text-center">
                    <Key size={32} className="text-slate-600 mx-auto mb-3" />
                    <p className="text-slate-400 text-sm mb-1">No license information available</p>
                    <p className="text-slate-500 text-xs">Add your Sophos license details manually to track expiry and get warnings before renewal.</p>
                    <button onClick={() => setLicenseModal({})}
                      className="mt-4 flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm mx-auto">
                      <Plus size={13} /> Add First License
                    </button>
                  </div>
                ) : (
                  <div className="p-4 space-y-3">
                    {licenses.map((l, i) => {
                      const usedPct = l.quantity > 0 ? Math.round((l.used_quantity / l.quantity) * 100) : 0
                      const isWarn = l.expiry_status === 'expiring_soon' || l.expiry_status === 'expired'
                      return (
                        <div key={i} className={`bg-slate-900 border rounded-xl p-4 ${isWarn ? 'border-yellow-700' : 'border-slate-700'}`}>
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex items-center gap-3">
                              <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${isWarn ? 'bg-yellow-900/30' : 'bg-slate-800'}`}>
                                {l.expiry_status === 'expired' ? <CalendarX size={16} className="text-red-400" /> :
                                 l.expiry_status === 'expiring_soon' ? <CalendarClock size={16} className="text-yellow-400" /> :
                                 <Key size={16} className="text-blue-400" />}
                              </div>
                              <div>
                                <div className="text-white font-medium text-sm">{l.product_name || 'Unknown Product'}</div>
                                <div className="text-xs text-slate-400 capitalize">{l.license_type || 'subscription'}</div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <LicenseBadge status={l.expiry_status} />
                              <button onClick={() => setLicenseModal(l)} className="text-slate-500 hover:text-slate-300">
                                <Edit3 size={13} />
                              </button>
                              <button onClick={() => handleDeleteLicense(l.license_id)} className="text-slate-500 hover:text-red-400">
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </div>

                          <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                            <div>
                              <div className="text-slate-500">Seats Used</div>
                              <div className="text-white font-medium">{l.used_quantity} / {l.quantity || '—'}</div>
                            </div>
                            <div>
                              <div className="text-slate-500">Start Date</div>
                              <div className="text-white">{l.starts_at ? new Date(l.starts_at).toLocaleDateString() : '—'}</div>
                            </div>
                            <div>
                              <div className="text-slate-500">Expiry Date</div>
                              <div className={l.expiry_status === 'expired' ? 'text-red-400 font-medium' : l.expiry_status === 'expiring_soon' ? 'text-yellow-400 font-medium' : 'text-white'}>
                                {l.expires_at ? new Date(l.expires_at).toLocaleDateString() : 'No expiry'}
                              </div>
                            </div>
                            <div>
                              <div className="text-slate-500">Days Remaining</div>
                              <div className={l.expiry_status === 'expired' ? 'text-red-400 font-medium' : l.expiry_status === 'expiring_soon' ? 'text-yellow-400 font-bold' : 'text-white'}>
                                {l.expiry_status === 'expired' ? 'Expired' :
                                 l.expiry_status === 'perpetual' ? '∞' :
                                 l.days_remaining != null ? `${l.days_remaining} day${l.days_remaining !== 1 ? 's' : ''}` : '—'}
                              </div>
                            </div>
                          </div>

                          {l.quantity > 0 && (
                            <div className="mt-3">
                              <div className="flex justify-between text-xs text-slate-500 mb-1">
                                <span>Seat utilisation</span>
                                <span>{usedPct}%</span>
                              </div>
                              <div className="w-full h-1.5 bg-slate-700 rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full transition-all ${usedPct > 90 ? 'bg-red-500' : usedPct > 75 ? 'bg-yellow-500' : 'bg-green-500'}`}
                                  style={{ width: `${Math.min(usedPct, 100)}%` }}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
            {tab === 'report' && (
              <div>
                {reportLoading ? (
                  <div className="p-12 text-center text-slate-400 text-sm">Loading incident report…</div>
                ) : !report ? (
                  <div className="p-12 text-center text-slate-400 text-sm">
                    <FileText size={32} className="mx-auto mb-3 text-slate-600" />
                    <p>Select a year above to load the incident report.</p>
                  </div>
                ) : report.incidents.length === 0 ? (
                  <div className="p-12 text-center text-slate-400 text-sm">
                    No incidents found for {reportYear}.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 z-10">
                        <tr className="border-b border-slate-700 bg-slate-900 text-slate-400 uppercase tracking-wider text-[10px]">
                          {["#","Date","Time","Incident Type","Description","Severity","Source","Source of Issue","Affected System / User","Initial Response","Resolution","Status","Logged By","Follow-up Actions"].map(h => (
                            <th key={h} className="px-3 py-2.5 text-left font-medium whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        {report.incidents.map((inc, i) => {
                          const sevColor = inc.severity === 'High' ? 'text-red-400' : inc.severity === 'Medium' ? 'text-yellow-400' : 'text-blue-400'
                          const statusColor = inc.status === 'Resolved' ? 'bg-emerald-900/40 text-emerald-300 border-emerald-700' : inc.status === 'Pending' ? 'bg-yellow-900/40 text-yellow-300 border-yellow-700' : 'bg-red-900/40 text-red-300 border-red-700'
                          return (
                            <tr key={i} className="hover:bg-slate-800/40 align-top">
                              <td className="px-3 py-2.5 text-slate-500 font-mono">{inc.no}</td>
                              <td className="px-3 py-2.5 text-slate-300 whitespace-nowrap">{inc.date}</td>
                              <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap font-mono">{inc.time}</td>
                              <td className="px-3 py-2.5 text-white font-medium min-w-[160px]">{inc.incident_type}</td>
                              <td className="px-3 py-2.5 text-slate-300 min-w-[260px] max-w-[320px] break-words leading-relaxed">{inc.description}</td>
                              <td className="px-3 py-2.5 whitespace-nowrap">
                                <span className={`font-semibold ${sevColor}`}>{inc.severity || '—'}</span>
                              </td>
                              <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap">{inc.source}</td>
                              <td className="px-3 py-2.5 text-slate-300 min-w-[140px] break-words">{inc.source_of_issue}</td>
                              <td className="px-3 py-2.5 text-slate-300 min-w-[160px] break-words">{inc.affected_system}</td>
                              <td className="px-3 py-2.5 text-slate-400 min-w-[220px] leading-relaxed">{inc.initial_response}</td>
                              <td className="px-3 py-2.5 text-slate-400 min-w-[220px] leading-relaxed">{inc.resolution}</td>
                              <td className="px-3 py-2.5 whitespace-nowrap">
                                <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${statusColor}`}>{inc.status}</span>
                              </td>
                              <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap">{inc.logged_by || <span className="text-slate-600">—</span>}</td>
                              <td className="px-3 py-2.5 text-slate-400 min-w-[160px]">{inc.follow_up || <span className="text-slate-600">—</span>}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    <div className="px-4 py-3 border-t border-slate-700 text-xs text-slate-500">
                      {report.total} incident{report.total !== 1 ? 's' : ''} for {reportYear}
                      {' · '}
                      {report.incidents.filter(i => i.status === 'Resolved').length} resolved
                      {' · '}
                      {report.incidents.filter(i => i.status === 'Open').length} open
                      {' · '}
                      {report.incidents.filter(i => i.status === 'Pending').length} pending
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* License add/edit modal */}
      {licenseModal !== null && (
        <LicenseModal
          initial={licenseModal?.license_id ? licenseModal : null}
          onSave={handleSaveLicense}
          onClose={() => setLicenseModal(null)}
        />
      )}
    </div>
  )
}
