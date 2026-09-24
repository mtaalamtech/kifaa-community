import { useState, useEffect, useCallback } from 'react'
import { CheckCircle, XCircle, RefreshCw, TrendingUp, AlertTriangle, Camera, ChevronDown, ChevronUp, Printer, LayoutDashboard, FileText } from 'lucide-react'

const API = '/api/v1'
const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('kifaa_token')}` })
async function apiFetch(path, opts = {}) {
  const res = await fetch(API + path, { headers: { ...authHeaders(), 'Content-Type': 'application/json' }, ...opts })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

// ── Trend chart ────────────────────────────────────────────────────────────────

const TREND_SERIES = [
  { key: 'overall',       label: 'Overall',      color: '#3b82f6' },
  { key: 'patch',         label: 'Patch',        color: '#22c55e' },
  { key: 'vulnerability', label: 'Vulnerability', color: '#f97316' },
  { key: 'configuration', label: 'Config',       color: '#a855f7' },
  { key: 'protection',    label: 'Protection',   color: '#06b6d4' },
  { key: 'license',       label: 'License',      color: '#eab308' },
]

function TrendChart({ data }) {
  const [hovered, setHovered] = useState(null)
  const [activeSeries, setActiveSeries] = useState(new Set(['overall', 'patch', 'vulnerability']))

  if (!data || data.length === 0) {
    return (
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 text-center text-slate-500 text-sm">
        No trend data yet — click <strong className="text-slate-400">Save Snapshot</strong> to start recording daily scores.
      </div>
    )
  }

  const W = 700, H = 180, PAD = { top: 16, right: 12, bottom: 32, left: 36 }
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const n = data.length

  const xPos = i => PAD.left + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW)
  const yPos = v => PAD.top + innerH - ((v ?? 0) / 100) * innerH

  // Y gridlines at 0, 25, 50, 75, 100
  const gridLines = [0, 25, 50, 75, 100]

  function toggleSeries(key) {
    setActiveSeries(prev => {
      const next = new Set(prev)
      if (next.has(key)) { if (next.size > 1) next.delete(key) }
      else next.add(key)
      return next
    })
  }

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-white font-medium text-sm">30-Day Compliance Trend</h3>
        <span className="text-xs text-slate-500">{data.length} snapshot{data.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Legend / toggles */}
      <div className="flex flex-wrap gap-2 mb-4">
        {TREND_SERIES.map(s => (
          <button key={s.key} onClick={() => toggleSeries(s.key)}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs transition-colors border ${
              activeSeries.has(s.key)
                ? 'border-slate-600 bg-slate-700 text-white'
                : 'border-slate-700 bg-slate-800/40 text-slate-500'
            }`}>
            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: activeSeries.has(s.key) ? s.color : '#475569' }} />
            {s.label}
          </button>
        ))}
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 200 }}
        onMouseLeave={() => setHovered(null)}>
        {/* Grid */}
        {gridLines.map(v => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={yPos(v)} y2={yPos(v)}
              stroke="#334155" strokeWidth={v === 80 ? 1 : 0.5} strokeDasharray={v === 80 ? '4 3' : undefined} />
            <text x={PAD.left - 4} y={yPos(v) + 4} textAnchor="end" fontSize={9} fill="#64748b">{v}</text>
          </g>
        ))}
        {/* 80% threshold label */}
        <text x={W - PAD.right + 2} y={yPos(80) + 4} fontSize={9} fill="#475569">80%</text>

        {/* X axis labels — show first, last, and every ~5th */}
        {data.map((d, i) => {
          const show = i === 0 || i === n - 1 || (n > 5 && i % Math.ceil(n / 6) === 0)
          if (!show) return null
          return (
            <text key={i} x={xPos(i)} y={H - 4} textAnchor="middle" fontSize={9} fill="#64748b">
              {d.date?.slice(5)}
            </text>
          )
        })}

        {/* Lines per active series */}
        {TREND_SERIES.filter(s => activeSeries.has(s.key)).map(s => {
          const pts = data.map((d, i) => d[s.key] != null ? `${xPos(i)},${yPos(d[s.key])}` : null).filter(Boolean)
          if (pts.length < 2) return null
          return (
            <polyline key={s.key} points={pts.join(' ')} fill="none"
              stroke={s.color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
          )
        })}

        {/* Dots + hover areas */}
        {data.map((d, i) => (
          <g key={i}>
            <rect x={xPos(i) - 6} y={PAD.top} width={12} height={innerH}
              fill="transparent"
              onMouseEnter={() => setHovered(i)} />
            {TREND_SERIES.filter(s => activeSeries.has(s.key) && d[s.key] != null).map(s => (
              <circle key={s.key} cx={xPos(i)} cy={yPos(d[s.key])} r={hovered === i ? 3.5 : 2}
                fill={s.color} stroke="#1e293b" strokeWidth={1} />
            ))}
          </g>
        ))}

        {/* Hover tooltip */}
        {hovered !== null && (() => {
          const d = data[hovered]
          const x = xPos(hovered)
          const tipX = x > W * 0.7 ? x - 88 : x + 10
          const visibleSeries = TREND_SERIES.filter(s => activeSeries.has(s.key) && d[s.key] != null)
          const tipH = 18 + visibleSeries.length * 14
          return (
            <g>
              <line x1={x} x2={x} y1={PAD.top} y2={H - PAD.bottom} stroke="#475569" strokeWidth={1} strokeDasharray="3 2" />
              <rect x={tipX} y={PAD.top} width={82} height={tipH} rx={4} fill="#0f172a" stroke="#334155" strokeWidth={1} />
              <text x={tipX + 6} y={PAD.top + 12} fontSize={9} fill="#94a3b8">{d.date}</text>
              {visibleSeries.map((s, j) => (
                <g key={s.key}>
                  <circle cx={tipX + 10} cy={PAD.top + 20 + j * 14} r={3} fill={s.color} />
                  <text x={tipX + 17} y={PAD.top + 24 + j * 14} fontSize={9} fill="#e2e8f0">
                    {s.label}: {d[s.key]}%
                  </text>
                </g>
              ))}
            </g>
          )
        })()}
      </svg>
    </div>
  )
}

// Gauge arc component (SVG)
function GaugeArc({ score, size = 160 }) {
  const r = size * 0.38
  const cx = size / 2
  const cy = size / 2 + 10
  const startAngle = -210
  const totalAngle = 240
  const angle = startAngle + (score / 100) * totalAngle

  const toRad = a => (a * Math.PI) / 180
  const arcX = (a, radius) => cx + radius * Math.cos(toRad(a))
  const arcY = (a, radius) => cy + radius * Math.sin(toRad(a))

  const trackPath = `M ${arcX(startAngle, r)} ${arcY(startAngle, r)} A ${r} ${r} 0 1 1 ${arcX(startAngle + totalAngle, r)} ${arcY(startAngle + totalAngle, r)}`
  const fillPath = score > 0
    ? `M ${arcX(startAngle, r)} ${arcY(startAngle, r)} A ${r} ${r} 0 ${(score / 100) * totalAngle > 180 ? 1 : 0} 1 ${arcX(angle, r)} ${arcY(angle, r)}`
    : ''

  const color = score >= 80 ? '#22c55e' : score >= 60 ? '#eab308' : '#ef4444'

  return (
    <svg width={size} height={size * 0.72} viewBox={`0 0 ${size} ${size * 0.72}`} className="mx-auto">
      <path d={trackPath} fill="none" stroke="#334155" strokeWidth={size * 0.06} strokeLinecap="round" />
      {fillPath && <path d={fillPath} fill="none" stroke={color} strokeWidth={size * 0.06} strokeLinecap="round" />}
      <text x={cx} y={cy - 4} textAnchor="middle" fontSize={size * 0.22} fontWeight="bold" fill={color}>
        {Math.round(score)}%
      </text>
      <text x={cx} y={cy + size * 0.14} textAnchor="middle" fontSize={size * 0.09} fill="#94a3b8">
        Overall
      </text>
    </svg>
  )
}

function ScoreBar({ score, target }) {
  const pct = Math.min(100, score ?? 0)
  const color = pct >= 80 ? 'bg-green-500' : pct >= 60 ? 'bg-yellow-500' : 'bg-red-500'
  return (
    <div className="mt-2">
      <div className="flex justify-between text-xs text-slate-400 mb-1">
        <span>{pct}%</span>
        <span>Target: {target}%</span>
      </div>
      <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function CategoryCard({ label, data, weight }) {
  if (!data) return null
  const score = data.score ?? 0
  const color = score >= 80 ? 'text-green-400' : score >= 60 ? 'text-yellow-400' : 'text-red-400'
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium text-white">{label}</div>
        <span className="text-xs text-slate-500">{weight}% weight</span>
      </div>
      <div className={`text-3xl font-bold ${color}`}>{score}%</div>
      <ScoreBar score={score} target={data.target ?? 100} />
    </div>
  )
}

function AgentTable({ agents }) {
  if (!agents || agents.length === 0) return null

  function scoreColor(s) {
    if (s === null || s === undefined) return 'text-slate-500'
    return s >= 80 ? 'text-green-400' : s >= 60 ? 'text-yellow-400' : 'text-red-400'
  }

  return (
    <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
      <div className="px-4 py-3 bg-slate-900 flex items-center justify-between">
        <h3 className="text-white font-medium">Per-Agent Compliance</h3>
        <span className="text-xs text-slate-400">{agents.length} agents</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-slate-400 text-xs uppercase tracking-wider border-b border-slate-700">
            <tr>
              <th className="px-4 py-3 text-left">Host</th>
              <th className="px-4 py-3 text-left">Patch</th>
              <th className="px-4 py-3 text-left">Vulnerab.</th>
              <th className="px-4 py-3 text-left">Config</th>
              <th className="px-4 py-3 text-left">Protection</th>
              <th className="px-4 py-3 text-left">License</th>
              <th className="px-4 py-3 text-left">Overall</th>
              <th className="px-4 py-3 text-left">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {agents.map(a => (
              <tr key={a.id} className="hover:bg-slate-700/30">
                <td className="px-4 py-3 text-white">
                  <div className="font-medium">{a.display_name || a.hostname}</div>
                  <div className="text-xs text-slate-400">{a.ip_address}</div>
                </td>
                <td className={`px-4 py-3 font-mono text-sm ${scoreColor(a.patch_score)}`}>
                  {a.patch_score !== null ? `${a.patch_score}%` : '—'}
                </td>
                <td className={`px-4 py-3 font-mono text-sm ${scoreColor(a.vuln_score)}`}>
                  {a.vuln_score !== null ? `${a.vuln_score}%` : '—'}
                </td>
                <td className={`px-4 py-3 font-mono text-sm ${scoreColor(a.config_score)}`}>
                  {a.config_score !== null ? `${a.config_score}%` : '—'}
                </td>
                <td className={`px-4 py-3 font-mono text-sm ${scoreColor(a.protection_score)}`}>
                  {a.protection_score !== null ? `${a.protection_score}%` : '—'}
                </td>
                <td className={`px-4 py-3 font-mono text-sm ${scoreColor(a.license_score)}`}>
                  {a.license_score !== null ? `${a.license_score}%` : '—'}
                </td>
                <td className={`px-4 py-3 font-mono font-bold text-sm ${scoreColor(a.overall_score)}`}>
                  {a.overall_score}%
                </td>
                <td className="px-4 py-3">
                  {a.compliant
                    ? <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border bg-green-900/40 text-green-300 border-green-700"><CheckCircle size={10} /> Compliant</span>
                    : <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border bg-red-900/40 text-red-300 border-red-700"><XCircle size={10} /> Non-Compliant</span>
                  }
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Executive Summary ──────────────────────────────────────────────────────────

function DonutChart({ compliant, total, size = 120 }) {
  const pct = total > 0 ? compliant / total : 0
  const r = 44, cx = size / 2, cy = size / 2
  const circ = 2 * Math.PI * r
  const dash = pct * circ
  const color = pct >= 0.8 ? '#22c55e' : pct >= 0.6 ? '#eab308' : '#ef4444'
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1e293b" strokeWidth={14} />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={14}
        strokeDasharray={`${dash} ${circ - dash}`}
        strokeDashoffset={circ * 0.25}
        strokeLinecap="round" style={{ transition: 'stroke-dasharray 0.6s ease' }} />
      <text x={cx} y={cy - 4} textAnchor="middle" fontSize="16" fontWeight="bold" fill={color}>{compliant}</text>
      <text x={cx} y={cy + 14} textAnchor="middle" fontSize="10" fill="#94a3b8">of {total}</text>
    </svg>
  )
}

function BarChart({ categories }) {
  const entries = [
    { label: 'Patch', score: categories.patch?.score ?? 0, color: '#22c55e', target: 95 },
    { label: 'Vuln', score: categories.vulnerability?.score ?? 0, color: '#f97316', target: 100 },
    { label: 'Config', score: categories.configuration?.score ?? 0, color: '#a855f7', target: 90 },
    { label: 'Protection', score: categories.protection?.score ?? 0, color: '#06b6d4', target: 100 },
    { label: 'License', score: categories.license?.score ?? 0, color: '#eab308', target: 100 },
  ]
  const W = 500, H = 180, pad = { top: 10, bottom: 40, left: 40, right: 10 }
  const chartW = W - pad.left - pad.right
  const chartH = H - pad.top - pad.bottom
  const barW = chartW / entries.length
  const gridLines = [0, 25, 50, 75, 80, 100]

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {/* grid */}
      {gridLines.map(v => {
        const y = pad.top + chartH * (1 - v / 100)
        return (
          <g key={v}>
            <line x1={pad.left} y1={y} x2={W - pad.right} y2={y}
              stroke={v === 80 ? '#fbbf24' : '#1e293b'}
              strokeWidth={v === 80 ? 1.5 : 0.5}
              strokeDasharray={v === 80 ? '4 3' : undefined} />
            <text x={pad.left - 4} y={y + 3.5} textAnchor="end" fontSize="9" fill="#475569">{v}</text>
          </g>
        )
      })}
      {/* bars */}
      {entries.map((e, i) => {
        const x = pad.left + i * barW + barW * 0.15
        const bw = barW * 0.7
        const bh = chartH * (e.score / 100)
        const y = pad.top + chartH - bh
        const tc = e.score >= 80 ? '#22c55e' : e.score >= 60 ? '#eab308' : '#ef4444'
        return (
          <g key={e.label}>
            <rect x={x} y={pad.top} width={bw} height={chartH} fill="#0f172a" rx={3} />
            <rect x={x} y={y} width={bw} height={bh} fill={tc} fillOpacity={0.85} rx={3}
              style={{ transition: 'height 0.6s ease, y 0.6s ease' }} />
            <text x={x + bw / 2} y={y - 4} textAnchor="middle" fontSize="9.5" fontWeight="bold" fill={tc}>{e.score}%</text>
            <text x={x + bw / 2} y={H - 8} textAnchor="middle" fontSize="9" fill="#64748b">{e.label}</text>
          </g>
        )
      })}
    </svg>
  )
}

function ExecutiveSummary({ dashboard, agents, trend }) {
  const cats = dashboard?.categories || {}
  const total = agents.length
  const compliant = agents.filter(a => a.compliant).length
  const nonCompliant = total - compliant
  const overall = dashboard?.overall ?? 0
  const overallColor = overall >= 80 ? 'text-green-400' : overall >= 60 ? 'text-yellow-400' : 'text-red-400'
  const overallBg = overall >= 80 ? 'bg-green-900/20 border-green-700' : overall >= 60 ? 'bg-yellow-900/20 border-yellow-700' : 'bg-red-900/20 border-red-700'
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  const critCVEs = cats.vulnerability?.critical_open ?? 0
  const highCVEs = cats.vulnerability?.high_open ?? 0
  const configPct = cats.configuration?.score ?? 0
  const protPct = cats.protection?.score ?? 0

  // Top non-compliant agents for attention list
  const atRisk = agents
    .filter(a => !a.compliant)
    .sort((a, b) => a.overall_score - b.overall_score)
    .slice(0, 5)

  // Trend delta (last vs first point)
  const trendDelta = trend.length >= 2
    ? ((trend[trend.length - 1]?.overall ?? 0) - (trend[0]?.overall ?? 0)).toFixed(1)
    : null

  return (
    <div className="space-y-6 print:space-y-4">
      {/* Print header */}
      <div className="hidden print:flex items-center justify-between pb-3 border-b border-slate-600">
        <div>
          <div className="text-lg font-bold text-white">Security Compliance Executive Summary</div>
          <div className="text-sm text-slate-400">{today}</div>
        </div>
        <div className="text-right text-sm text-slate-400">CONFIDENTIAL</div>
      </div>

      {/* Row 1: headline KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className={`rounded-xl border p-5 flex flex-col items-center text-center ${overallBg}`}>
          <div className={`text-5xl font-black ${overallColor}`}>{overall}%</div>
          <div className="text-sm text-slate-300 mt-1 font-medium">Overall Compliance</div>
          <div className={`mt-2 text-xs px-2 py-0.5 rounded-full font-medium ${overall >= 80 ? 'bg-green-700/40 text-green-300' : 'bg-red-700/40 text-red-300'}`}>
            {overall >= 80 ? '✓ Compliant' : '✗ Non-Compliant'}
          </div>
          {trendDelta !== null && (
            <div className={`text-xs mt-1 ${parseFloat(trendDelta) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {parseFloat(trendDelta) >= 0 ? '▲' : '▼'} {Math.abs(trendDelta)}% vs 30d ago
            </div>
          )}
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 flex flex-col items-center text-center">
          <DonutChart compliant={compliant} total={total} size={90} />
          <div className="text-xs text-slate-400 mt-2">Endpoint Compliance</div>
          <div className="text-xs text-slate-500">{nonCompliant > 0 ? `${nonCompliant} need attention` : 'All endpoints compliant'}</div>
        </div>

        <div className={`rounded-xl border p-5 flex flex-col justify-center ${critCVEs > 0 ? 'bg-red-900/20 border-red-700' : 'bg-slate-800 border-slate-700'}`}>
          <div className={`text-4xl font-black ${critCVEs > 0 ? 'text-red-400' : 'text-green-400'}`}>{critCVEs}</div>
          <div className="text-sm text-slate-300 mt-1">Critical CVEs Open</div>
          <div className="text-xs text-slate-500 mt-0.5">{highCVEs} High severity</div>
          <div className="text-xs text-slate-600 mt-1">Target: 0 critical</div>
        </div>

        <div className={`rounded-xl border p-5 flex flex-col justify-center ${protPct < 80 ? 'bg-red-900/20 border-red-700' : 'bg-slate-800 border-slate-700'}`}>
          <div className={`text-4xl font-black ${protPct >= 80 ? 'text-green-400' : protPct >= 60 ? 'text-yellow-400' : 'text-red-400'}`}>{protPct}%</div>
          <div className="text-sm text-slate-300 mt-1">Endpoint Protection</div>
          <div className="text-xs text-slate-500 mt-0.5">AV + Firewall enabled</div>
          <div className="text-xs text-slate-600 mt-1">Target: 100%</div>
        </div>
      </div>

      {/* Row 2: bar chart + category breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
          <div className="text-sm font-medium text-white mb-3">Compliance by Category</div>
          <BarChart categories={cats} />
          <div className="flex items-center gap-2 mt-2">
            <div className="w-3 h-0.5 bg-yellow-400" style={{borderTop: '2px dashed #fbbf24', width: '20px'}}></div>
            <span className="text-xs text-slate-500">80% threshold</span>
          </div>
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
          <div className="text-sm font-medium text-white mb-4">Category Scorecard</div>
          <div className="space-y-3">
            {[
              { label: 'Patch & Update Compliance', key: 'patch', weight: '35%', target: 95 },
              { label: 'Vulnerability Management', key: 'vulnerability', weight: '25%', target: 100 },
              { label: 'Configuration Compliance', key: 'configuration', weight: '20%', target: 90 },
              { label: 'Endpoint Protection', key: 'protection', weight: '10%', target: 100 },
              { label: 'License Compliance', key: 'license', weight: '10%', target: 100 },
            ].map(item => {
              const score = cats[item.key]?.score ?? 0
              const color = score >= 80 ? 'bg-green-500' : score >= 60 ? 'bg-yellow-500' : 'bg-red-500'
              const textColor = score >= 80 ? 'text-green-400' : score >= 60 ? 'text-yellow-400' : 'text-red-400'
              return (
                <div key={item.key}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-300">{item.label}</span>
                      <span className="text-xs text-slate-600">{item.weight}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500">Target: {item.target}%</span>
                      <span className={`text-sm font-bold font-mono ${textColor}`}>{score}%</span>
                    </div>
                  </div>
                  <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${color}`} style={{ width: `${score}%`, transition: 'width 0.6s ease' }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Row 3: attention required + quick stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2 bg-slate-800 border border-slate-700 rounded-xl p-5">
          <div className="text-sm font-medium text-white mb-3 flex items-center gap-2">
            <AlertTriangle size={14} className="text-amber-400" /> Endpoints Requiring Attention
          </div>
          {atRisk.length === 0 ? (
            <div className="text-sm text-green-400 flex items-center gap-2 py-4">
              <CheckCircle size={14} /> All endpoints are compliant
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 border-b border-slate-700">
                  <th className="pb-2 text-left">Endpoint</th>
                  <th className="pb-2 text-right">Score</th>
                  <th className="pb-2 text-right">CVEs</th>
                  <th className="pb-2 text-right">Patches</th>
                  <th className="pb-2 text-right">Config</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {atRisk.map(a => (
                  <tr key={a.id}>
                    <td className="py-2 text-white font-medium">{a.display_name || a.hostname}<span className="text-slate-500 ml-1 font-normal">{a.ip_address}</span></td>
                    <td className={`py-2 text-right font-bold font-mono ${a.overall_score >= 60 ? 'text-yellow-400' : 'text-red-400'}`}>{a.overall_score}%</td>
                    <td className={`py-2 text-right ${a.crit_vulns > 0 ? 'text-red-400' : 'text-slate-400'}`}>{(a.crit_vulns ?? 0) + (a.high_vulns ?? 0)}</td>
                    <td className={`py-2 text-right ${a.critical_patches > 0 ? 'text-amber-400' : 'text-slate-400'}`}>{a.critical_patches ?? 0}</td>
                    <td className={`py-2 text-right ${(a.config_score ?? 100) < 80 ? 'text-amber-400' : 'text-slate-400'}`}>{a.config_score !== null ? `${a.config_score}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 space-y-4">
          <div className="text-sm font-medium text-white">Quick Stats</div>
          {[
            { label: 'Total Endpoints', value: total, color: 'text-white' },
            { label: 'Fully Compliant', value: compliant, color: 'text-green-400' },
            { label: 'Non-Compliant', value: nonCompliant, color: nonCompliant > 0 ? 'text-red-400' : 'text-green-400' },
            { label: 'Critical CVEs', value: critCVEs, color: critCVEs > 0 ? 'text-red-400' : 'text-green-400' },
            { label: 'High CVEs', value: highCVEs, color: highCVEs > 0 ? 'text-amber-400' : 'text-green-400' },
            { label: 'Config Checks Pass', value: cats.configuration?.passed ?? '—', color: 'text-blue-400' },
            { label: 'Config Checks Fail', value: (cats.configuration?.total ?? 0) - (cats.configuration?.passed ?? 0), color: 'text-slate-400' },
          ].map(s => (
            <div key={s.label} className="flex items-center justify-between text-sm">
              <span className="text-slate-400">{s.label}</span>
              <span className={`font-bold font-mono ${s.color}`}>{s.value}</span>
            </div>
          ))}
          <div className="pt-2 border-t border-slate-700 text-xs text-slate-600">Generated: {today}</div>
        </div>
      </div>
    </div>
  )
}

export default function ComplianceDashboard() {
  const [dashboard, setDashboard] = useState(null)
  const [agents, setAgents] = useState([])
  const [trend, setTrend] = useState([])
  const [loading, setLoading] = useState(true)
  const [snapshotting, setSnapshotting] = useState(false)
  const [view, setView] = useState('executive') // 'executive' | 'detail'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [dash, agts, trendData] = await Promise.all([
        apiFetch('/compliance/dashboard'),
        apiFetch('/compliance/per-agent'),
        apiFetch('/compliance/trend?days=30').catch(() => []),
      ])
      setDashboard(dash)
      setAgents(agts)
      setTrend(trendData)
    } catch { }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function takeSnapshot() {
    setSnapshotting(true)
    try {
      await apiFetch('/compliance/snapshot', { method: 'POST' })
      alert('Compliance snapshot saved')
    } catch (e) { alert('Failed: ' + e.message) }
    setSnapshotting(false)
  }

  const cats = dashboard?.categories || {}
  const totalAgents = agents.length
  const compliantAgents = agents.filter(a => a.compliant).length

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-green-600/20 flex items-center justify-center">
            <TrendingUp size={20} className="text-green-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Compliance Dashboard</h1>
            <p className="text-sm text-slate-400">Unified security compliance scoring</p>
          </div>
        </div>
        <div className="flex gap-2 print:hidden">
          {/* View toggle */}
          <div className="flex bg-slate-800 border border-slate-700 rounded-lg p-0.5">
            <button onClick={() => setView('executive')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${view === 'executive' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}>
              <FileText size={13} /> Executive
            </button>
            <button onClick={() => setView('detail')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${view === 'detail' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}>
              <LayoutDashboard size={13} /> Detail
            </button>
          </div>
          <button onClick={() => window.print()}
            className="flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm">
            <Printer size={14} /> Print
          </button>
          <button onClick={takeSnapshot} disabled={snapshotting}
            className="flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm disabled:opacity-50">
            <Camera size={14} /> {snapshotting ? 'Saving...' : 'Snapshot'}
          </button>
          <button onClick={load}
            className="flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="bg-slate-800 rounded-xl border border-slate-700 p-12 text-center text-slate-400">Loading compliance data...</div>
      ) : view === 'executive' ? (
        <ExecutiveSummary dashboard={dashboard} agents={agents} trend={trend} />
      ) : (
        <>
          {/* Overall gauge + summary */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 flex flex-col items-center">
              <GaugeArc score={dashboard?.overall ?? 0} size={180} />
              <div className="mt-3 flex items-center gap-2">
                {dashboard?.compliant
                  ? <><CheckCircle size={16} className="text-green-400" /><span className="text-green-400 font-medium text-sm">Compliant</span></>
                  : <><AlertTriangle size={16} className="text-red-400" /><span className="text-red-400 font-medium text-sm">Non-Compliant</span></>
                }
              </div>
              <div className="text-xs text-slate-500 mt-1">Threshold: 80%</div>
            </div>

            <div className="md:col-span-2 grid grid-cols-2 gap-3">
              <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
                <div className="text-xs text-slate-400 mb-1">Compliant Agents</div>
                <div className="text-2xl font-bold text-green-400">{compliantAgents}</div>
                <div className="text-xs text-slate-500">of {totalAgents} total</div>
              </div>
              <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
                <div className="text-xs text-slate-400 mb-1">Non-Compliant</div>
                <div className="text-2xl font-bold text-red-400">{totalAgents - compliantAgents}</div>
                <div className="text-xs text-slate-500">require attention</div>
              </div>
              <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
                <div className="text-xs text-slate-400 mb-1">Critical CVEs Open</div>
                <div className="text-2xl font-bold text-red-400">{cats.vulnerability?.critical_open ?? '—'}</div>
                <div className="text-xs text-slate-500">Target: 0</div>
              </div>
              <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
                <div className="text-xs text-slate-400 mb-1">Config Checks Passed</div>
                <div className="text-2xl font-bold text-blue-400">{cats.configuration?.passed ?? '—'}</div>
                <div className="text-xs text-slate-500">of {cats.configuration?.total ?? '—'} total</div>
              </div>
            </div>
          </div>

          {/* Category scores */}
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
            <CategoryCard label="Patch Compliance" data={cats.patch} weight={35} />
            <CategoryCard label="Vulnerability Mgmt" data={cats.vulnerability} weight={25} />
            <CategoryCard label="Configuration" data={cats.configuration} weight={20} />
            <CategoryCard label="Endpoint Protection" data={cats.protection} weight={10} />
            <CategoryCard label="License Compliance" data={cats.license} weight={10} />
          </div>

          {/* Trend chart */}
          <TrendChart data={trend} />

          {/* Per-agent table */}
          <AgentTable agents={agents} />
        </>
      )}
    </div>
  )
}
