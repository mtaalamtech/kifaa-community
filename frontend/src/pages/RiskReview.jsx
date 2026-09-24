import { useEffect, useState } from 'react'
import {
  TrendingUp, TrendingDown, Minus, RefreshCw, Download, FileSpreadsheet,
  ShieldCheck, AlertTriangle, CheckCircle2, XCircle, BarChart3, FileText
} from 'lucide-react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, ReferenceLine
} from 'recharts'
import api from '../api/client'

const CATEGORIES = [
  { key: 'overall',       label: 'Overall',          color: '#3b82f6', weight: null },
  { key: 'patch',         label: 'Patch Compliance', color: '#10b981', weight: 35 },
  { key: 'vulnerability', label: 'Vulnerability Mgmt',color: '#f59e0b', weight: 25 },
  { key: 'configuration', label: 'Configuration',    color: '#8b5cf6', weight: 20 },
  { key: 'protection',    label: 'Endpoint Protection',color: '#ef4444', weight: 10 },
  { key: 'license',       label: 'License Compliance',color: '#06b6d4', weight: 10 },
]

function TrendBadge({ trend, diff }) {
  if (trend === 'new' || trend === null) {
    return <span className="text-xs text-slate-500">—</span>
  }
  if (trend === 'increasing') {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
        <TrendingUp size={11} />
        +{Math.abs(diff ?? 0).toFixed(1)}%
      </span>
    )
  }
  if (trend === 'decreasing') {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30">
        <TrendingDown size={11} />
        -{Math.abs(diff ?? 0).toFixed(1)}%
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-slate-700 text-slate-400 border border-slate-600">
      <Minus size={11} />
      Stagnant
    </span>
  )
}

function ScoreCell({ score, isCurrent }) {
  if (score == null) return <span className="text-slate-600">—</span>
  const color = score >= 80 ? 'text-emerald-400' : score >= 60 ? 'text-yellow-400' : 'text-red-400'
  return (
    <span className={`font-mono font-semibold ${color} ${isCurrent ? 'text-base' : ''}`}>
      {score.toFixed(1)}
    </span>
  )
}

// Overall trend across all categories for a quarter
function quarterlySentiment(quarter) {
  const cats = ['patch', 'vulnerability', 'configuration', 'protection', 'license']
  const trends = cats.map(c => quarter[`${c}_trend`])
  const inc = trends.filter(t => t === 'increasing').length
  const dec = trends.filter(t => t === 'decreasing').length
  if (inc > dec && inc >= 2) return 'improving'
  if (dec > inc && dec >= 2) return 'deteriorating'
  return 'stable'
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-slate-800 border border-slate-600 rounded-lg p-3 text-xs shadow-xl">
      <div className="font-semibold text-white mb-2">{label}</div>
      {payload.map(p => (
        <div key={p.dataKey} className="flex justify-between gap-4" style={{ color: p.color }}>
          <span>{p.name}</span>
          <span className="font-mono">{p.value != null ? p.value.toFixed(1) : '—'}</span>
        </div>
      ))}
    </div>
  )
}

function generateExportHTML(quarters, evidence) {
  const today = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
  const currentQ = quarters.find(q => q.is_current) || quarters[quarters.length - 1]
  const prevQ = currentQ ? quarters[quarters.indexOf(currentQ) - 1] : null

  const overallSentiment = currentQ ? quarterlySentiment(currentQ) : 'unknown'
  const sentimentColor = overallSentiment === 'improving' ? '#10b981' : overallSentiment === 'deteriorating' ? '#ef4444' : '#f59e0b'

  const qRows = quarters.map(q => {
    const cats = CATEGORIES.filter(c => c.key !== 'overall')
    return `
      <tr style="border-bottom:1px solid #334155">
        <td style="padding:8px 12px;font-weight:${q.is_current ? '700' : '400'};color:${q.is_current ? '#3b82f6' : '#cbd5e1'}">${q.quarter}${q.is_current ? ' ★' : ''}</td>
        <td style="padding:8px 12px;font-family:monospace;color:${(q.overall ?? 0) >= 80 ? '#10b981' : (q.overall ?? 0) >= 60 ? '#f59e0b' : '#ef4444'}">${q.overall != null ? q.overall.toFixed(1) : '—'}</td>
        ${cats.map(c => `<td style="padding:8px 12px;font-family:monospace;color:${(q[c.key] ?? 0) >= 80 ? '#10b981' : (q[c.key] ?? 0) >= 60 ? '#f59e0b' : '#ef4444'}">${q[c.key] != null ? q[c.key].toFixed(1) : '—'}</td>`).join('')}
        <td style="padding:8px 12px">${q.overall_trend === 'increasing' ? '<span style="color:#10b981">↑ Increasing</span>' : q.overall_trend === 'decreasing' ? '<span style="color:#ef4444">↓ Decreasing</span>' : q.overall_trend === 'new' ? '<span style="color:#94a3b8">—</span>' : '<span style="color:#f59e0b">→ Stagnant</span>'}</td>
      </tr>`
  }).join('')

  const nonCompliant = evidence.filter(a => !a.compliant)
  const evidenceRows = evidence.map(a => `
    <tr style="border-bottom:1px solid #1e293b">
      <td style="padding:6px 10px;color:#cbd5e1">${a.display_name || a.hostname}</td>
      <td style="padding:6px 10px;color:#94a3b8">${a.ip_address || '—'}</td>
      <td style="padding:6px 10px;color:#94a3b8">${a.os_type || '—'}</td>
      <td style="padding:6px 10px;font-family:monospace;color:${a.overall_score >= 80 ? '#10b981' : '#ef4444'}">${a.overall_score.toFixed(1)}</td>
      <td style="padding:6px 10px;color:${a.critical_patches > 0 ? '#ef4444' : '#10b981'}">${a.critical_patches}</td>
      <td style="padding:6px 10px;color:${a.crit_vulns > 0 ? '#ef4444' : '#10b981'}">${a.crit_vulns}</td>
      <td style="padding:6px 10px;color:${a.av_status === 'pass' ? '#10b981' : '#ef4444'}">${a.av_status === 'pass' ? 'Protected' : 'Unprotected'}</td>
      <td style="padding:6px 10px;color:${a.compliant ? '#10b981' : '#ef4444'}">${a.compliant ? '✓ Compliant' : '✗ Non-compliant'}</td>
    </tr>`).join('')

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Risk Review Report — ${today}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 32px; }
    h1 { color: #fff; font-size: 24px; margin-bottom: 4px; }
    h2 { color: #94a3b8; font-size: 13px; font-weight: 400; margin: 0 0 32px; }
    h3 { color: #cbd5e1; font-size: 16px; margin: 32px 0 12px; border-bottom: 1px solid #334155; padding-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 8px; overflow: hidden; margin-bottom: 24px; }
    thead tr { background: #0f172a; }
    th { padding: 10px 12px; text-align: left; font-size: 11px; color: #64748b; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
    .sentiment-box { display: inline-block; padding: 8px 20px; border-radius: 8px; font-size: 14px; font-weight: 700; border: 1px solid; margin-bottom: 24px; }
    .summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px; }
    .summary-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px; }
    .summary-card .val { font-size: 28px; font-weight: 700; margin: 4px 0; }
    .summary-card .lbl { font-size: 12px; color: #64748b; }
    @media print { body { background: white; color: #1e293b; } table { background: #f8fafc; } th { color: #64748b; background: #f1f5f9; } }
  </style>
</head>
<body>
  <h1>Quarterly Risk Review Report</h1>
  <h2>Generated: ${today} &nbsp;|&nbsp; Kifaa Endpoint Management Platform</h2>

  <div class="sentiment-box" style="color:${sentimentColor};border-color:${sentimentColor};background:${sentimentColor}22">
    Overall Security Posture: ${overallSentiment.toUpperCase()}
    ${currentQ ? ` — Overall Score ${currentQ.overall != null ? currentQ.overall.toFixed(1) : '—'}%` : ''}
    ${currentQ && prevQ && currentQ.overall != null && prevQ.overall != null ? ` (${currentQ.overall > prevQ.overall ? '+' : ''}${(currentQ.overall - prevQ.overall).toFixed(1)}% vs ${prevQ.quarter})` : ''}
  </div>

  <div class="summary-grid">
    <div class="summary-card">
      <div class="lbl">Total Endpoints</div>
      <div class="val" style="color:#3b82f6">${evidence.length}</div>
    </div>
    <div class="summary-card">
      <div class="lbl">Compliant Endpoints</div>
      <div class="val" style="color:#10b981">${evidence.filter(a => a.compliant).length}</div>
    </div>
    <div class="summary-card">
      <div class="lbl">Non-Compliant Endpoints</div>
      <div class="val" style="color:${nonCompliant.length > 0 ? '#ef4444' : '#10b981'}">${nonCompliant.length}</div>
    </div>
  </div>

  <h3>Quarterly Score History</h3>
  <table>
    <thead>
      <tr>
        <th>Quarter</th><th>Overall</th><th>Patch (35%)</th><th>Vuln (25%)</th><th>Config (20%)</th><th>Protection (10%)</th><th>License (10%)</th><th>Trend</th>
      </tr>
    </thead>
    <tbody>${qRows}</tbody>
  </table>

  <h3>Current Quarter Trend Analysis</h3>
  ${currentQ ? `
  <table>
    <thead><tr><th>Category</th><th>Current Score</th><th>Previous Quarter</th><th>Change</th><th>Assessment</th></tr></thead>
    <tbody>
      ${CATEGORIES.filter(c => c.key !== 'overall').map(c => {
        const curr = currentQ[c.key]
        const prev = currentQ[`${c.key}_prev`]
        const trend = currentQ[`${c.key}_trend`]
        const diff = curr != null && prev != null ? curr - prev : null
        return `<tr style="border-bottom:1px solid #334155">
          <td style="padding:8px 12px;color:#cbd5e1">${c.label} <span style="color:#475569;font-size:11px">(${c.weight}%)</span></td>
          <td style="padding:8px 12px;font-family:monospace;color:${(curr ?? 0) >= 80 ? '#10b981' : (curr ?? 0) >= 60 ? '#f59e0b' : '#ef4444'}">${curr != null ? curr.toFixed(1) : '—'}</td>
          <td style="padding:8px 12px;font-family:monospace;color:#94a3b8">${prev != null ? prev.toFixed(1) : '—'}</td>
          <td style="padding:8px 12px;font-family:monospace;color:${diff == null ? '#94a3b8' : diff >= 0 ? '#10b981' : '#ef4444'}">${diff != null ? (diff >= 0 ? '+' : '') + diff.toFixed(1) + '%' : '—'}</td>
          <td style="padding:8px 12px">${trend === 'increasing' ? '<span style="color:#10b981">↑ Increasing</span>' : trend === 'decreasing' ? '<span style="color:#ef4444">↓ Decreasing</span>' : trend === 'new' ? '<span style="color:#94a3b8">Baseline</span>' : '<span style="color:#f59e0b">→ Stagnant</span>'}</td>
        </tr>`
      }).join('')}
    </tbody>
  </table>` : '<p style="color:#64748b">No current quarter data available.</p>'}

  <h3>Evidence — Per-Endpoint Compliance Status (Current)</h3>
  <table>
    <thead><tr><th>Endpoint</th><th>IP Address</th><th>OS</th><th>Overall</th><th>Critical Patches</th><th>Critical CVEs</th><th>AV Status</th><th>Review Status</th></tr></thead>
    <tbody>${evidenceRows}</tbody>
  </table>

  <p style="color:#475569;font-size:11px;margin-top:32px;border-top:1px solid #1e293b;padding-top:16px">
    Report generated by Kifaa Endpoint Management Platform on ${today}.<br>
    Compliance threshold: Overall score ≥ 80. Scores calculated from live endpoint data at time of export.
  </p>
</body>
</html>`
}

// Returns "YYYY-MM" for the previous calendar month
function prevMonth() {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function RiskReview() {
  const [activeTab, setActiveTab]       = useState('quarterly')
  const [quarters, setQuarters]         = useState([])
  const [months, setMonths]             = useState([])
  const [evidence, setEvidence]         = useState([])
  const [loading, setLoading]           = useState(true)
  const [activeChart, setActiveChart]   = useState('overall')
  const [selectedMonth, setSelectedMonth] = useState(prevMonth)
  const [exportingMonth, setExportingMonth] = useState(false)
  const [dashboardQ, setDashboardQ]     = useState(null)   // quarterly
  const [dashboardM, setDashboardM]     = useState(null)   // monthly

  const load = () => {
    setLoading(true)
    Promise.all([
      api.get('/compliance/quarterly'),
      api.get('/compliance/monthly'),
      api.get('/compliance/risk-evidence'),
    ]).then(([qRes, mRes, evRes]) => {
      setQuarters(qRes.data || [])
      setMonths(mRes.data || [])
      setEvidence(evRes.data || [])
    }).catch(() => {}).finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const currentQ = quarters.find(q => q.is_current) || quarters[quarters.length - 1]
  const currentM = months.find(m => m.is_current) || months[months.length - 1]
  const sentiment = currentQ ? quarterlySentiment(currentQ) : null

  // Shown dashboard entry — falls back to current period
  const shownDashboard = activeTab === 'quarterly'
    ? (dashboardQ ?? currentQ)
    : (dashboardM ?? currentM)

  // Chart data: quarterly always, monthly when on that tab
  const chartDataQ = quarters.map(q => ({
    name: q.quarter,
    ...Object.fromEntries(CATEGORIES.map(c => [c.key, q[c.key]])),
  }))
  const chartDataM = months.map(m => ({
    name: m.label,
    ...Object.fromEntries(CATEGORIES.map(c => [c.key, m[c.key]])),
  }))

  const handleExport = () => {
    const html = generateExportHTML(quarters, evidence)
    const blob = new Blob([html], { type: 'text/html' })
    const url  = URL.createObjectURL(blob)
    const win  = window.open(url, '_blank')
    if (win) {
      win.addEventListener('load', () => {
        setTimeout(() => win.print(), 500)
      })
    }
  }

  const handleXlsx = () => {
    const token = localStorage.getItem('kifaa_token')
    fetch(`/api/v1/compliance/risk-review/xlsx`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.blob())
      .then(blob => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `risk_review_${new Date().toISOString().slice(0, 10)}.xlsx`
        a.click()
        URL.revokeObjectURL(url)
      })
  }

  const handleMonthXlsx = () => {
    if (!selectedMonth) return
    setExportingMonth(true)
    const token = localStorage.getItem('kifaa_token')
    fetch(`/api/v1/compliance/risk-review/xlsx?month=${selectedMonth}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.blob())
      .then(blob => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `risk_review_${selectedMonth}.xlsx`
        a.click()
        URL.revokeObjectURL(url)
      })
      .finally(() => setExportingMonth(false))
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
      </div>
    )
  }

  const compliantCount    = evidence.filter(a => a.compliant).length
  const nonCompliantCount = evidence.filter(a => !a.compliant).length
  const complianceRate    = evidence.length > 0 ? Math.round((compliantCount / evidence.length) * 100) : 0

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-white">Risk Review</h1>
          <p className="text-sm text-slate-400 mt-0.5">Compliance history and risk trend analysis</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={load} disabled={loading}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded-lg text-slate-300 transition-colors">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button onClick={handleXlsx}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-emerald-700 hover:bg-emerald-600 border border-emerald-600 rounded-lg text-white transition-colors">
            <FileSpreadsheet size={14} />
            Export XLSX
          </button>
          <button onClick={handleExport}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-blue-600 hover:bg-blue-700 border border-blue-500 rounded-lg text-white transition-colors">
            <Download size={14} />
            Export PDF
          </button>
          <div className="flex items-center gap-1 border border-slate-600 rounded-lg overflow-hidden">
            <input
              type="month"
              value={selectedMonth}
              onChange={e => setSelectedMonth(e.target.value)}
              max={new Date().toISOString().slice(0, 7)}
              className="px-2 py-2 text-sm bg-slate-800 text-slate-300 border-0 outline-none"
            />
            <button
              onClick={handleMonthXlsx}
              disabled={exportingMonth || !selectedMonth}
              className="flex items-center gap-1.5 px-3 py-2 text-sm bg-violet-700 hover:bg-violet-600 text-white transition-colors disabled:opacity-50"
            >
              <FileSpreadsheet size={14} />
              {exportingMonth ? 'Exporting…' : 'Export Month'}
            </button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-slate-900 border border-slate-700 rounded-xl p-1 w-fit">
        {[
          { key: 'quarterly', label: 'Quarterly' },
          { key: 'monthly',   label: 'Monthly'   },
        ].map(t => (
          <button key={t.key} onClick={() => { setActiveTab(t.key); setDashboardQ(null); setDashboardM(null) }}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === t.key
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:text-white'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Sentiment banner */}
      {sentiment && currentQ && (
        <div className={`rounded-xl border p-4 mb-6 flex items-center gap-4 ${
          sentiment === 'improving'     ? 'bg-emerald-500/10 border-emerald-500/30' :
          sentiment === 'deteriorating' ? 'bg-red-500/10 border-red-500/30' :
                                          'bg-yellow-500/10 border-yellow-500/30'
        }`}>
          {sentiment === 'improving' ? <TrendingUp size={22} className="text-emerald-400 flex-shrink-0" /> :
           sentiment === 'deteriorating' ? <TrendingDown size={22} className="text-red-400 flex-shrink-0" /> :
           <Minus size={22} className="text-yellow-400 flex-shrink-0" />}
          <div>
            <div className={`font-semibold text-sm ${
              sentiment === 'improving' ? 'text-emerald-400' :
              sentiment === 'deteriorating' ? 'text-red-400' : 'text-yellow-400'
            }`}>
              {sentiment === 'improving' ? 'Security Posture Improving' :
               sentiment === 'deteriorating' ? 'Security Posture Deteriorating — Action Required' :
               'Security Posture Stable'}
            </div>
            <div className="text-xs text-slate-400 mt-0.5">
              Current quarter ({currentQ.quarter}): Overall score{' '}
              <span className="font-mono text-white">{currentQ.overall?.toFixed(1) ?? '—'}%</span>
              {currentQ.overall_prev != null && currentQ.overall != null && (
                <span className={`ml-2 ${currentQ.overall >= currentQ.overall_prev ? 'text-emerald-400' : 'text-red-400'}`}>
                  ({currentQ.overall >= currentQ.overall_prev ? '+' : ''}{(currentQ.overall - currentQ.overall_prev).toFixed(1)}% vs {quarters[quarters.indexOf(currentQ) - 1]?.quarter})
                </span>
              )}
            </div>
          </div>
          <div className="ml-auto text-right">
            <div className="text-xs text-slate-500">Endpoint compliance rate</div>
            <div className={`text-2xl font-bold ${complianceRate >= 80 ? 'text-emerald-400' : complianceRate >= 60 ? 'text-yellow-400' : 'text-red-400'}`}>
              {complianceRate}%
            </div>
            <div className="text-xs text-slate-500">{compliantCount}/{evidence.length} endpoints</div>
          </div>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Current Score', value: currentQ?.overall != null ? `${currentQ.overall.toFixed(1)}%` : '—',
            icon: BarChart3, color: 'bg-blue-600',
            sub: currentQ?.overall != null ? (currentQ.overall >= 80 ? 'Compliant' : 'Below threshold') : '' },
          { label: 'Compliant Endpoints', value: compliantCount, icon: CheckCircle2, color: 'bg-emerald-600',
            sub: `${complianceRate}% of total` },
          { label: 'Non-Compliant', value: nonCompliantCount, icon: XCircle,
            color: nonCompliantCount > 0 ? 'bg-red-600' : 'bg-slate-600',
            sub: nonCompliantCount > 0 ? 'Action required' : 'All compliant' },
          { label: 'Quarters Tracked', value: quarters.length, icon: FileText, color: 'bg-purple-600',
            sub: quarters.length > 0 ? `${quarters[0]?.quarter} — ${quarters[quarters.length - 1]?.quarter}` : '' },
        ].map(({ label, value, icon: Icon, color, sub }) => (
          <div key={label} className="bg-slate-900 border border-slate-700 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-slate-400">{label}</span>
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${color}`}>
                <Icon size={18} className="text-white" />
              </div>
            </div>
            <div className="text-3xl font-bold text-white">{value}</div>
            {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
          </div>
        ))}
      </div>

      {/* Trend chart */}
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-white">
            Score Trend by {activeTab === 'quarterly' ? 'Quarter' : 'Month'}
          </h2>
          <div className="flex gap-1">
            {CATEGORIES.map(c => (
              <button key={c.key}
                onClick={() => setActiveChart(c.key)}
                className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                  activeChart === c.key
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-slate-800 border-slate-600 text-slate-400 hover:text-white'
                }`}
              >
                {c.key === 'overall' ? 'Overall' : c.label.split(' ')[0]}
              </button>
            ))}
          </div>
        </div>
        {(() => {
          const chartData = activeTab === 'quarterly' ? chartDataQ : chartDataM
          return chartData.length >= 2 ? (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                <XAxis dataKey="name" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis domain={[0, 100]} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} width={32} />
                <Tooltip content={<CustomTooltip />} />
                <ReferenceLine y={80} stroke="#374151" strokeDasharray="4 2" label={{ value: '80%', fill: '#4b5563', fontSize: 10, position: 'right' }} />
                <Line type="monotone" dataKey={activeChart}
                  name={CATEGORIES.find(c => c.key === activeChart)?.label || activeChart}
                  stroke={CATEGORIES.find(c => c.key === activeChart)?.color || '#3b82f6'}
                  strokeWidth={2.5} dot={{ r: 4 }} activeDot={{ r: 6 }}
                  connectNulls />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-40 text-slate-500 text-sm">
              <div className="text-center">
                <BarChart3 size={32} className="mx-auto mb-2 text-slate-600" />
                <div>Insufficient history for trend chart</div>
                <div className="text-xs mt-1">At least 2 {activeTab === 'quarterly' ? 'quarters' : 'months'} of snapshots needed</div>
              </div>
            </div>
          )
        })()}
      </div>

      {/* Score history table — quarterly or monthly */}
      <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden mb-6">
        <div className="px-5 py-4 border-b border-slate-700">
          <h2 className="text-sm font-semibold text-white">
            {activeTab === 'quarterly' ? 'Quarterly Score History' : 'Monthly Score History'}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Average daily snapshot scores per {activeTab === 'quarterly' ? 'quarter' : 'month'}. Click a row to view its score dashboard.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-700">
                <th className="px-4 py-3 font-medium">{activeTab === 'quarterly' ? 'Quarter' : 'Month'}</th>
                {CATEGORIES.map(c => (
                  <th key={c.key} className="px-4 py-3 font-medium">
                    {c.label}
                    {c.weight && <span className="text-slate-600 ml-1">({c.weight}%)</span>}
                  </th>
                ))}
                <th className="px-4 py-3 font-medium">Trend</th>
              </tr>
            </thead>
            <tbody>
              {activeTab === 'quarterly' ? (
                quarters.length === 0 ? (
                  <tr><td colSpan={CATEGORIES.length + 2} className="px-4 py-10 text-center text-slate-500">No quarterly data yet.</td></tr>
                ) : quarters.map(q => {
                  const isSelected = shownDashboard?.quarter === q.quarter
                  return (
                    <tr key={q.quarter}
                      onClick={() => setDashboardQ(isSelected ? null : q)}
                      className={`border-b border-slate-800 transition-colors cursor-pointer
                        ${isSelected ? 'bg-violet-900/20 ring-1 ring-inset ring-violet-500/40' :
                          q.is_current ? 'bg-blue-900/10 hover:bg-blue-900/20' : 'hover:bg-slate-800/40'}`}>
                      <td className="px-4 py-3 font-medium">
                        <span className={isSelected ? 'text-violet-400' : q.is_current ? 'text-blue-400' : 'text-white'}>{q.quarter}</span>
                        {q.is_current && <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-blue-600/30 text-blue-400 border border-blue-500/30">Live</span>}
                        {isSelected && <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-violet-600/30 text-violet-400 border border-violet-500/30">Selected</span>}
                      </td>
                      {CATEGORIES.map(c => (
                        <td key={c.key} className="px-4 py-3">
                          <ScoreCell score={q[c.key]} isCurrent={q.is_current} />
                        </td>
                      ))}
                      <td className="px-4 py-3">
                        <TrendBadge trend={q.overall_trend}
                          diff={q.overall != null && q.overall_prev != null ? q.overall - q.overall_prev : null} />
                      </td>
                    </tr>
                  )
                })
              ) : (
                months.length === 0 ? (
                  <tr><td colSpan={CATEGORIES.length + 2} className="px-4 py-10 text-center text-slate-500">No monthly data yet.</td></tr>
                ) : months.map(m => {
                  const isSelected = shownDashboard?.month === m.month
                  return (
                    <tr key={m.month}
                      onClick={() => setDashboardM(isSelected ? null : m)}
                      className={`border-b border-slate-800 transition-colors cursor-pointer
                        ${isSelected ? 'bg-violet-900/20 ring-1 ring-inset ring-violet-500/40' :
                          m.is_current ? 'bg-blue-900/10 hover:bg-blue-900/20' : 'hover:bg-slate-800/40'}`}>
                      <td className="px-4 py-3 font-medium">
                        <span className={isSelected ? 'text-violet-400' : m.is_current ? 'text-blue-400' : 'text-white'}>{m.label}</span>
                        {m.is_current && <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-blue-600/30 text-blue-400 border border-blue-500/30">Live</span>}
                        {isSelected && <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-violet-600/30 text-violet-400 border border-violet-500/30">Selected</span>}
                      </td>
                      {CATEGORIES.map(c => (
                        <td key={c.key} className="px-4 py-3">
                          <ScoreCell score={m[c.key]} isCurrent={m.is_current} />
                        </td>
                      ))}
                      <td className="px-4 py-3">
                        <TrendBadge trend={m.overall_trend}
                          diff={m.overall != null && m.overall_prev != null ? m.overall - m.overall_prev : null} />
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Per-category score dashboard — shows selected period (defaults to current) */}
      {shownDashboard && (
        <div className="bg-slate-900 border border-slate-700 rounded-xl p-5 mb-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-white">
                Score Dashboard — {shownDashboard.quarter ?? shownDashboard.label}
                {shownDashboard.is_current && (
                  <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-blue-600/30 text-blue-400 border border-blue-500/30">Live</span>
                )}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {!shownDashboard.is_current
                  ? `Historical average scores for this ${activeTab === 'quarterly' ? 'quarter' : 'month'}`
                  : 'Click any row in the table above to view a different period'}
              </p>
            </div>
            {/* Overall score badge */}
            {shownDashboard.overall != null && (
              <div className={`text-right px-4 py-2 rounded-lg border ${
                shownDashboard.overall >= 80 ? 'bg-emerald-500/10 border-emerald-500/30' :
                shownDashboard.overall >= 60 ? 'bg-yellow-500/10 border-yellow-500/30' :
                'bg-red-500/10 border-red-500/30'
              }`}>
                <div className="text-xs text-slate-400">Overall Score</div>
                <div className={`text-2xl font-bold font-mono ${
                  shownDashboard.overall >= 80 ? 'text-emerald-400' :
                  shownDashboard.overall >= 60 ? 'text-yellow-400' : 'text-red-400'
                }`}>{shownDashboard.overall.toFixed(1)}%</div>
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {CATEGORIES.filter(c => c.key !== 'overall').map(c => {
              const score  = shownDashboard[c.key]
              const prev   = shownDashboard[`${c.key}_prev`]
              const trend  = shownDashboard[`${c.key}_trend`]
              const diff   = score != null && prev != null ? score - prev : null
              const scoreColor = score == null ? 'text-slate-500' : score >= 80 ? 'text-emerald-400' : score >= 60 ? 'text-yellow-400' : 'text-red-400'
              return (
                <div key={c.key} className="bg-slate-800/60 rounded-lg p-4 border border-slate-700">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-slate-300">{c.label}</span>
                    <span className="text-xs text-slate-500">{c.weight}% weight</span>
                  </div>
                  <div className="flex items-end justify-between">
                    <div>
                      <div className={`text-2xl font-bold font-mono ${scoreColor}`}>
                        {score != null ? `${score.toFixed(1)}%` : '—'}
                      </div>
                      {prev != null && (
                        <div className="text-xs text-slate-500 mt-0.5">Prev: {prev.toFixed(1)}%</div>
                      )}
                    </div>
                    <TrendBadge trend={trend} diff={diff} />
                  </div>
                  {/* Mini progress bar */}
                  {score != null && (
                    <div className="mt-3 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${
                        score >= 80 ? 'bg-emerald-500' : score >= 60 ? 'bg-yellow-500' : 'bg-red-500'
                      }`} style={{ width: `${Math.min(score, 100)}%` }} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Non-compliant agents highlight */}
      {nonCompliantCount > 0 && (
        <div className="bg-slate-900 border border-red-500/30 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-700 bg-red-500/5">
            <div className="flex items-center gap-2">
              <AlertTriangle size={16} className="text-red-400" />
              <h2 className="text-sm font-semibold text-white">Non-Compliant Endpoints ({nonCompliantCount})</h2>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">Endpoints below 80% overall compliance score</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-slate-700">
                  <th className="px-4 py-3 font-medium">Endpoint</th>
                  <th className="px-4 py-3 font-medium">Overall</th>
                  <th className="px-4 py-3 font-medium">Patch</th>
                  <th className="px-4 py-3 font-medium">Vuln</th>
                  <th className="px-4 py-3 font-medium">Config</th>
                  <th className="px-4 py-3 font-medium">Protection</th>
                  <th className="px-4 py-3 font-medium">Crit Patches</th>
                  <th className="px-4 py-3 font-medium">Crit CVEs</th>
                </tr>
              </thead>
              <tbody>
                {evidence.filter(a => !a.compliant).map(a => (
                  <tr key={a.hostname} className="border-b border-slate-800 hover:bg-slate-800/40">
                    <td className="px-4 py-3">
                      <div className="text-white font-medium text-sm">{a.display_name || a.hostname}</div>
                      <div className="text-xs text-slate-500">{a.ip_address}</div>
                    </td>
                    <td className="px-4 py-3"><ScoreCell score={a.overall_score} /></td>
                    <td className="px-4 py-3"><ScoreCell score={a.patch_score} /></td>
                    <td className="px-4 py-3"><ScoreCell score={a.vuln_score} /></td>
                    <td className="px-4 py-3"><ScoreCell score={a.config_score} /></td>
                    <td className="px-4 py-3"><ScoreCell score={a.protection_score} /></td>
                    <td className="px-4 py-3">
                      <span className={a.critical_patches > 0 ? 'text-red-400 font-semibold' : 'text-slate-500'}>{a.critical_patches}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={a.crit_vulns > 0 ? 'text-red-400 font-semibold' : 'text-slate-500'}>{a.crit_vulns}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
