import { useEffect, useState, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  ArrowLeft, Activity, CheckCircle2, AlertTriangle, Clock,
  RefreshCw, Wifi, Globe, Database, Server, Shield, Radio, Layers, Cloud, Plug, Pencil
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell
} from 'recharts'
import api from '../api/client'

const ST = {
  up:      { label: 'UP',      bg: 'bg-green-500',  text: 'text-green-400',  badge: 'bg-green-900/50 text-green-300 border border-green-800' },
  down:    { label: 'DOWN',    bg: 'bg-red-500',    text: 'text-red-400',    badge: 'bg-red-900/50 text-red-300 border border-red-800' },
  warning: { label: 'WARNING', bg: 'bg-yellow-500', text: 'text-yellow-400', badge: 'bg-yellow-900/50 text-yellow-300 border border-yellow-800' },
  timeout: { label: 'TIMEOUT', bg: 'bg-orange-500', text: 'text-orange-400', badge: 'bg-orange-900/50 text-orange-300 border border-orange-800' },
  unknown: { label: '—',       bg: 'bg-slate-600',  text: 'text-slate-400',  badge: 'bg-slate-700 text-slate-400 border border-slate-600' },
}

const TYPE_ICONS = {
  ping: Radio, tcp: Wifi, http: Globe, https: Shield,
  ssl_cert: Shield, dns: Globe, database: Database,
  snmp: Radio, service: Server, smtp: Server,
  imap: Server, pop3: Server, ftp: Server,
  default: Activity,
}

function formatUptime(seconds) {
  if (seconds == null) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatDatetime(iso) {
  if (!iso) return 'Never'
  return new Date(iso).toLocaleString()
}

// Availability history bar — horizontal colored segments
function AvailabilityBar({ timeseries }) {
  if (!timeseries || timeseries.length === 0) {
    return (
      <div className="h-8 rounded-lg bg-slate-700 flex items-center justify-center text-xs text-slate-500">
        No data available
      </div>
    )
  }
  return (
    <div className="flex gap-px h-8 rounded-lg overflow-hidden">
      {timeseries.map((pt, i) => {
        const color = pt.is_down ? 'bg-red-500' : pt.avg_latency == null ? 'bg-slate-600' : 'bg-green-500'
        const t = new Date(pt.time)
        const tLabel = isNaN(t) ? '' : t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        const tooltip = `${tLabel}: ${pt.down ? 'Down' : pt.avg_latency != null ? `${Math.round(pt.avg_latency)}ms` : 'Unknown'}`
        return (
          <div
            key={i}
            title={tooltip}
            className={`flex-1 ${color} hover:opacity-75 transition-opacity cursor-default`}
          />
        )
      })}
    </div>
  )
}

// Hourly status grid — 24 colored squares
function HourlyGrid({ hourly }) {
  if (!hourly || hourly.length === 0) {
    return (
      <div className="grid grid-cols-12 gap-1.5">
        {Array.from({ length: 24 }, (_, i) => (
          <div key={i} className="w-full aspect-square rounded bg-slate-700" title={`Hour ${i}`} />
        ))}
      </div>
    )
  }

  const now = new Date()
  return (
    <div className="grid grid-cols-12 gap-1.5">
      {hourly.map((h, i) => {
        const status = h.status || 'unknown'
        const st = ST[status] || ST.unknown
        const hd = new Date(h.hour)
        const hourLabel = isNaN(hd) ? `H${i}` : hd.toLocaleTimeString([], { hour: '2-digit', hour12: false })
        const tooltip = `${hourLabel} — ${st.label}${h.avg_latency ? ` · ${Math.round(h.avg_latency)}ms avg` : ''}`
        return (
          <div
            key={i}
            title={tooltip}
            className={`aspect-square rounded ${st.bg} hover:opacity-75 transition-opacity cursor-default`}
          />
        )
      })}
    </div>
  )
}

// Custom tooltip for recharts
function LatencyTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-xs">
      <div className="text-slate-400 mb-1">{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color }}>{p.name}: {p.value != null ? `${Math.round(p.value)}ms` : '—'}</div>
      ))}
    </div>
  )
}

function InfoRow({ label, value }) {
  return (
    <div className="flex justify-between py-2 border-b border-slate-800 last:border-0">
      <span className="text-sm text-slate-400">{label}</span>
      <span className="text-sm text-white font-medium font-mono">{value ?? '—'}</span>
    </div>
  )
}

const inputCls = "w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"

function EditModal({ monitor, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: monitor.name || '',
    host: monitor.host || '',
    port: monitor.port ? String(monitor.port) : '',
    check_interval_seconds: monitor.check_interval_seconds || 60,
    timeout_seconds: monitor.timeout_seconds || 10,
    is_active: monitor.is_active !== false,
    config: monitor.config || {},
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setConfig = (k, v) => setForm(f => ({ ...f, config: { ...f.config, [k]: v } }))
  const cfg = form.config

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await api.put(`/monitoring/monitors/${monitor.id}`, {
        ...form,
        port: form.port ? parseInt(form.port) : null,
      })
      onSaved()
      onClose()
    } catch (e) {
      setError(e.response?.data?.detail || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const isDb = monitor.category === 'Databases'
  const isHttp = monitor.monitor_type === 'http'
  const isSnmp = monitor.monitor_type === 'snmp'
  const isDns = monitor.monitor_type === 'dns'

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-xl max-h-[90vh] flex flex-col">
        <div className="p-5 border-b border-slate-700 flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-white">Edit Monitor</h2>
            <p className="text-xs text-slate-400 mt-0.5">{monitor.subtype?.replace(/_/g, ' ') || monitor.monitor_type} · {monitor.category}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {error && <div className="bg-red-900/40 border border-red-700 text-red-300 text-sm rounded-lg px-4 py-2">{error}</div>}

          {/* Basic fields */}
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Display Name</label>
            <input value={form.name} onChange={e => set('name', e.target.value)} className={inputCls} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="text-xs text-slate-400 mb-1 block">Host / IP</label>
              <input value={form.host} onChange={e => set('host', e.target.value)} className={inputCls} placeholder="hostname or IP" />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Port</label>
              <input type="number" value={form.port} onChange={e => set('port', e.target.value)} className={inputCls} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Check Interval (sec)</label>
              <input type="number" min="10" value={form.check_interval_seconds}
                onChange={e => set('check_interval_seconds', parseInt(e.target.value) || 60)} className={inputCls} />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Timeout (sec)</label>
              <input type="number" min="1" max="60" value={form.timeout_seconds}
                onChange={e => set('timeout_seconds', parseInt(e.target.value) || 10)} className={inputCls} />
            </div>
          </div>

          {/* HTTP config */}
          {isHttp && (
            <div className="space-y-3 pt-3 border-t border-slate-700">
              <div className="text-xs text-slate-400 font-medium uppercase tracking-wide">HTTP Settings</div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Scheme</label>
                  <select value={cfg.scheme || 'http'} onChange={e => setConfig('scheme', e.target.value)} className={inputCls}>
                    <option value="http">HTTP</option>
                    <option value="https">HTTPS</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Expected Status</label>
                  <input type="number" value={cfg.expected_status || 200}
                    onChange={e => setConfig('expected_status', parseInt(e.target.value))} className={inputCls} />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Path</label>
                  <input value={cfg.path || '/'} onChange={e => setConfig('path', e.target.value)} className={inputCls} />
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Content Match <span className="text-slate-600">(optional)</span></label>
                <input value={cfg.content_match || ''} onChange={e => setConfig('content_match', e.target.value)}
                  className={inputCls} placeholder="Alert if string not found in response" />
              </div>
            </div>
          )}

          {/* SNMP config */}
          {isSnmp && (
            <div className="space-y-3 pt-3 border-t border-slate-700">
              <div className="text-xs text-slate-400 font-medium uppercase tracking-wide">SNMP Settings</div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Community String</label>
                  <input value={cfg.community || 'public'} onChange={e => setConfig('community', e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Version</label>
                  <select value={cfg.version || '2c'} onChange={e => setConfig('version', e.target.value)} className={inputCls}>
                    <option value="1">v1</option><option value="2c">v2c</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">OID</label>
                <input value={cfg.oid || ''} onChange={e => setConfig('oid', e.target.value)} className={inputCls} placeholder="1.3.6.1.2.1.1.1.0" />
              </div>
            </div>
          )}

          {/* DNS config */}
          {isDns && (
            <div className="space-y-3 pt-3 border-t border-slate-700">
              <div className="text-xs text-slate-400 font-medium uppercase tracking-wide">DNS Settings</div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Lookup Hostname</label>
                  <input value={cfg.lookup_hostname || ''} onChange={e => setConfig('lookup_hostname', e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Record Type</label>
                  <select value={cfg.record_type || 'A'} onChange={e => setConfig('record_type', e.target.value)} className={inputCls}>
                    {['A','AAAA','CNAME','MX','NS','TXT','SOA'].map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Database credentials */}
          {isDb && (
            <div className="space-y-3 pt-3 border-t border-slate-700">
              <div className="text-xs text-slate-400 font-medium uppercase tracking-wide">Database Connection <span className="text-slate-600 normal-case">(optional)</span></div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Database Name <span className="text-slate-600">(optional)</span></label>
                <input value={cfg.database || ''} onChange={e => setConfig('database', e.target.value)} className={inputCls} placeholder="e.g. mydb, master, postgres" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Username <span className="text-slate-600">(optional)</span></label>
                  <input value={cfg.username || ''} onChange={e => setConfig('username', e.target.value)} className={inputCls} autoComplete="off" />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Password <span className="text-slate-600">(optional)</span></label>
                  <input type="password" value={cfg.password || ''} onChange={e => setConfig('password', e.target.value)} className={inputCls} autoComplete="new-password" />
                </div>
              </div>
            </div>
          )}

          {/* Active toggle */}
          <div className="pt-3 border-t border-slate-700">
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <input type="checkbox" checked={form.is_active} onChange={e => set('is_active', e.target.checked)}
                className="w-4 h-4 rounded border-slate-600 bg-slate-700 accent-blue-500" />
              <span className="text-sm text-slate-300">Monitor is active</span>
            </label>
          </div>
        </div>

        <div className="p-5 border-t border-slate-700 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
          <button onClick={save} disabled={!form.name || !form.host || saving}
            className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded-lg transition-colors">
            {saving && <RefreshCw size={13} className="animate-spin" />}
            Save Changes
          </button>
        </div>
      </div>
    </div>
  )
}

export default function MonitorDetail() {
  const { id } = useParams()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('performance')
  const [refreshing, setRefreshing] = useState(false)
  const [showEdit, setShowEdit] = useState(false)

  const load = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true)
    try {
      const r = await api.get(`/monitoring/monitors/${id}/stats`)
      setData(r.data)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  // Auto-refresh every 60s
  useEffect(() => {
    const t = setInterval(() => load(false), 60000)
    return () => clearInterval(t)
  }, [load])

  if (loading) return (
    <div className="flex justify-center py-20">
      <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
    </div>
  )

  if (!data?.monitor) return (
    <div className="text-center py-20 text-red-400">Monitor not found</div>
  )

  const { monitor, availability_24h, availability_today, last_downtime, uptime_seconds, hourly, timeseries } = data
  const st = ST[monitor.last_status] || ST.unknown
  const Icon = TYPE_ICONS[monitor.monitor_type] || TYPE_ICONS.default

  // Prepare response time chart data — use timeseries (5-min buckets)
  const chartData = (timeseries || []).map(pt => {
    const d = new Date(pt.time)
    const label = isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return {
      time: label,
      avg: pt.avg_latency != null ? Math.round(pt.avg_latency) : null,
      max: pt.max_latency != null ? Math.round(pt.max_latency) : null,
      isDown: pt.down,
    }
  })

  return (
    <div className="space-y-5">
      {/* Back + Header */}
      <div className="flex items-center gap-4">
        <Link to="/monitoring" className="text-slate-400 hover:text-white transition-colors">
          <ArrowLeft size={20} />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-slate-800 border border-slate-700 rounded-lg">
              <Icon size={16} className="text-blue-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">{monitor.name}</h1>
              <p className="text-sm text-slate-400 font-mono">
                {monitor.host}{monitor.port ? `:${monitor.port}` : ''}
              </p>
            </div>
            <span className={`ml-2 px-2.5 py-0.5 rounded-full text-xs font-semibold ${st.badge}`}>
              {st.label}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowEdit(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded-lg transition-colors"
            title="Edit monitor configuration"
          >
            <Pencil size={14} /> Edit
          </button>
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
            title="Refresh"
          >
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {showEdit && (
        <EditModal
          monitor={monitor}
          onClose={() => setShowEdit(false)}
          onSaved={() => load(true)}
        />
      )}

      {/* Stats bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-xs text-slate-400 mb-2 flex items-center gap-1.5">
            <Activity size={11} /> Health Status
          </div>
          <div className={`text-lg font-bold ${st.text}`}>{st.label}</div>
          <div className="text-xs text-slate-500 mt-0.5">
            {monitor.last_message?.slice(0, 40) || 'No message'}
          </div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-xs text-slate-400 mb-2 flex items-center gap-1.5">
            <CheckCircle2 size={11} /> Availability (24h)
          </div>
          <div className={`text-lg font-bold ${availability_24h >= 99 ? 'text-green-400' : availability_24h >= 95 ? 'text-yellow-400' : 'text-red-400'}`}>
            {availability_24h != null ? `${availability_24h.toFixed(2)}%` : '—'}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">Today: {availability_today != null ? `${availability_today.toFixed(2)}%` : '—'}</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-xs text-slate-400 mb-2 flex items-center gap-1.5">
            <Clock size={11} /> Today's Uptime
          </div>
          <div className="text-lg font-bold text-white font-mono">{formatUptime(uptime_seconds)}</div>
          <div className="text-xs text-slate-500 mt-0.5">HH:MM:SS</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-xs text-slate-400 mb-2 flex items-center gap-1.5">
            <AlertTriangle size={11} /> Last Downtime
          </div>
          <div className="text-sm font-medium text-white">
            {last_downtime ? new Date(last_downtime).toLocaleDateString() : 'None recorded'}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {last_downtime ? new Date(last_downtime).toLocaleTimeString() : ''}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-700">
        {[
          { key: 'performance', label: 'Performance Overview' },
          { key: 'info', label: 'Monitor Information' },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t.key
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Performance Overview tab */}
      {tab === 'performance' && (
        <div className="space-y-6">
          {/* Availability history bar */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-white">Availability History — Last 6 Hours</h3>
              <div className="flex items-center gap-3 text-xs text-slate-500">
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-green-500 inline-block" /> Up</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-red-500 inline-block" /> Down</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-slate-600 inline-block" /> Unknown</span>
              </div>
            </div>
            <AvailabilityBar timeseries={timeseries} />
            <div className="flex justify-between text-xs text-slate-600 mt-1.5">
              <span>6 hours ago</span>
              <span>Now</span>
            </div>
          </div>

          {/* Hourly status grid */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-white mb-4">Performance History — Last 24 Hours</h3>
            <HourlyGrid hourly={hourly} />
            <div className="flex justify-between text-xs text-slate-600 mt-2">
              <span>24h ago</span>
              <span>Now</span>
            </div>
          </div>

          {/* Response time chart */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-white">Response Time — Last 6 Hours</h3>
              {monitor.last_latency_ms != null && (
                <span className="text-xs text-slate-400">
                  Current: <span className={`font-semibold ${st.text}`}>{monitor.last_latency_ms} ms</span>
                </span>
              )}
            </div>
            {chartData.length === 0 ? (
              <div className="h-48 flex items-center justify-center text-slate-500 text-sm">
                No response time data available
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chartData} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis
                    dataKey="time"
                    tick={{ fill: '#64748b', fontSize: 10 }}
                    tickLine={false}
                    axisLine={{ stroke: '#334155' }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fill: '#64748b', fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    unit="ms"
                  />
                  <Tooltip content={<LatencyTooltip />} />
                  <Bar dataKey="avg" name="Avg" radius={[2, 2, 0, 0]} maxBarSize={20}>
                    {chartData.map((entry, i) => (
                      <Cell key={i} fill={entry.isDown ? '#ef4444' : '#3b82f6'} />
                    ))}
                  </Bar>
                  <Bar dataKey="max" name="Max" fill="#6366f1" opacity={0.5} radius={[2, 2, 0, 0]} maxBarSize={20} />
                </BarChart>
              </ResponsiveContainer>
            )}
            <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
              <span className="flex items-center gap-1.5"><span className="w-3 h-2 rounded-sm bg-blue-500 inline-block" /> Avg latency</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-2 rounded-sm bg-indigo-500 opacity-60 inline-block" /> Max latency</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-2 rounded-sm bg-red-500 inline-block" /> Downtime</span>
            </div>
          </div>

          {/* 7-day availability */}
          {data.daily && data.daily.length > 0 && (
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-white mb-4">7-Day Availability</h3>
              <div className="grid grid-cols-7 gap-2">
                {data.daily.map((d, i) => {
                  const pct = d.up_pct ?? 0
                  const color = pct >= 99 ? 'bg-green-500' : pct >= 95 ? 'bg-yellow-500' : 'bg-red-500'
                  const textColor = pct >= 99 ? 'text-green-400' : pct >= 95 ? 'text-yellow-400' : 'text-red-400'
                  const dd = new Date(d.day)
                  const dayLabel = isNaN(dd) ? `D${i}` : dd.toLocaleDateString([], { weekday: 'short' })
                  return (
                    <div key={i} className="text-center">
                      <div className="text-xs text-slate-500 mb-1">{dayLabel}</div>
                      <div className="h-16 bg-slate-700 rounded-lg overflow-hidden flex flex-col justify-end">
                        <div
                          className={`w-full ${color} transition-all`}
                          style={{ height: `${pct}%` }}
                        />
                      </div>
                      <div className={`text-xs font-medium mt-1 ${textColor}`}>
                        {pct.toFixed(0)}%
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Monitor Information tab */}
      {tab === 'info' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-white mb-4">Monitor Details</h3>
            <InfoRow label="Name" value={monitor.name} />
            <InfoRow label="Type" value={monitor.subtype?.replace(/_/g, ' ') || monitor.monitor_type} />
            <InfoRow label="Category" value={monitor.category} />
            <InfoRow label="Host / Target" value={monitor.host} />
            <InfoRow label="Port" value={monitor.port} />
            <InfoRow label="Check Interval" value={monitor.check_interval_seconds ? `${monitor.check_interval_seconds}s` : null} />
            <InfoRow label="Timeout" value={monitor.timeout_seconds ? `${monitor.timeout_seconds}s` : null} />
            <InfoRow label="Active" value={monitor.is_active ? 'Yes' : 'No'} />
          </div>

          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-white mb-4">Current Status</h3>
            <InfoRow label="Status" value={st.label} />
            <InfoRow label="Last Latency" value={monitor.last_latency_ms != null ? `${monitor.last_latency_ms} ms` : null} />
            <InfoRow label="Last Checked" value={monitor.last_checked ? formatDatetime(monitor.last_checked) : 'Never'} />
            <InfoRow label="Last Message" value={monitor.last_message} />
            <InfoRow label="Consecutive Failures" value={monitor.consecutive_failures ?? 0} />
            <InfoRow label="Created" value={monitor.created_at ? formatDatetime(monitor.created_at) : null} />
          </div>

          {monitor.config && Object.keys(monitor.config).length > 0 && (
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 md:col-span-2">
              <h3 className="text-sm font-semibold text-white mb-4">Configuration</h3>
              {Object.entries(monitor.config).map(([k, v]) => (
                <InfoRow key={k} label={k.replace(/_/g, ' ')} value={String(v)} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
