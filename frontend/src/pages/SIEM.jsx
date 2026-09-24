import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Shield, RefreshCw, Search, Filter, AlertTriangle,
  Info, XCircle, ChevronDown, ChevronRight, Clock,
  Monitor, Server, Download
} from 'lucide-react'
import { siemApi } from '../api/client'

// ── Helpers ────────────────────────────────────────────────────────────────

const LEVELS = ['critical', 'error', 'warning', 'info', 'debug']
const LEVEL_STYLES = {
  critical: 'bg-red-900/60 text-red-200 border-red-700',
  error:    'bg-red-900/40 text-red-300 border-red-800',
  warning:  'bg-yellow-900/40 text-yellow-300 border-yellow-800',
  info:     'bg-blue-900/30 text-blue-300 border-blue-800',
  debug:    'bg-slate-700 text-slate-400 border-slate-600',
}
const LEVEL_DOT = {
  critical: 'bg-red-500',
  error:    'bg-red-400',
  warning:  'bg-yellow-400',
  info:     'bg-blue-400',
  debug:    'bg-slate-500',
}
const SOURCE_LABELS = {
  windows_security: 'Win Security',
  windows_system:   'Win System',
  windows_app:      'Win Application',
  journal:          'Linux Journal',
  syslog:           'Syslog',
}

function LevelBadge({ level }) {
  const cls = LEVEL_STYLES[level] || LEVEL_STYLES.info
  return (
    <span className={`px-2 py-0.5 rounded border text-xs font-medium ${cls}`}>
      {level}
    </span>
  )
}

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString()
}

function fmtRelative(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ── Stat card ───────────────────────────────────────────────────────────────

function StatCard({ label, value, color = 'blue', sub }) {
  const colors = {
    red:    'border-red-500/30 bg-red-900/10 text-red-300',
    orange: 'border-orange-500/30 bg-orange-900/10 text-orange-300',
    yellow: 'border-yellow-500/30 bg-yellow-900/10 text-yellow-300',
    blue:   'border-blue-500/30 bg-blue-900/10 text-blue-300',
    slate:  'border-slate-600 bg-slate-800/40 text-slate-300',
  }
  return (
    <div className={`rounded-xl border p-4 ${colors[color]}`}>
      <div className="text-xs text-slate-400 mb-1">{label}</div>
      <div className={`text-2xl font-bold ${colors[color].split(' ')[2]}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </div>
  )
}

// ── Event row with expandable detail ────────────────────────────────────────

function EventRow({ event }) {
  const [expanded, setExpanded] = useState(false)
  const sourceLabel = SOURCE_LABELS[event.log_source] || event.log_source
  const dot = LEVEL_DOT[event.level] || LEVEL_DOT.info

  return (
    <>
      <tr
        className={`border-b border-slate-700/50 hover:bg-slate-700/20 cursor-pointer ${
          expanded ? 'bg-slate-700/30' : ''
        }`}
        onClick={() => setExpanded(v => !v)}
      >
        <td className="px-4 py-2.5 text-xs text-slate-400 whitespace-nowrap">
          <div className="flex items-center gap-1">
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {fmtTime(event.time)}
          </div>
          <div className="text-slate-600 mt-0.5">{fmtRelative(event.time)}</div>
        </td>
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
            <LevelBadge level={event.level} />
          </div>
        </td>
        <td className="px-4 py-2.5 text-xs">
          <span className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 text-xs">
            {sourceLabel}
          </span>
        </td>
        <td className="px-4 py-2.5 text-xs text-slate-400">
          {event.hostname || event.source_ip || '—'}
        </td>
        <td className="px-4 py-2.5 text-xs text-slate-500">
          {event.event_id || '—'}
        </td>
        <td className="px-4 py-2.5 max-w-xs">
          <p className="text-sm text-slate-300 truncate">{event.message}</p>
          {event.channel && (
            <p className="text-xs text-slate-500 mt-0.5">{event.channel}</p>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-800/50 border-b border-slate-700/50">
          <td colSpan={6} className="px-6 py-4">
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <div className="text-slate-500 mb-1 font-medium">Message</div>
                <pre className="text-slate-300 whitespace-pre-wrap break-words font-mono text-xs bg-slate-900/50 rounded p-3 max-h-48 overflow-y-auto">
                  {event.message}
                </pre>
              </div>
              <div>
                <div className="text-slate-500 mb-1 font-medium">Metadata</div>
                <div className="space-y-1 text-slate-400">
                  <div><span className="text-slate-500">ID:</span> {event.id}</div>
                  {event.agent_id && <div><span className="text-slate-500">Agent:</span> {event.hostname} ({event.agent_id.slice(0,8)}...)</div>}
                  {event.source_ip && <div><span className="text-slate-500">Source IP:</span> {event.source_ip}</div>}
                  {event.event_id && <div><span className="text-slate-500">Event ID:</span> {event.event_id}</div>}
                  {event.channel && <div><span className="text-slate-500">Channel:</span> {event.channel}</div>}
                  <div><span className="text-slate-500">Source:</span> {event.log_source}</div>
                </div>
                {event.raw_data && Object.keys(event.raw_data).length > 0 && (
                  <div className="mt-2">
                    <div className="text-slate-500 mb-1 font-medium">Raw Data</div>
                    <pre className="text-slate-500 text-xs bg-slate-900/50 rounded p-2 max-h-32 overflow-y-auto">
                      {JSON.stringify(event.raw_data, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ── Timeline bar chart ───────────────────────────────────────────────────────

function TimelineChart({ timeline }) {
  if (!timeline?.length) return null
  const max = Math.max(...timeline.map(b => b.count), 1)
  return (
    <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 mb-6">
      <div className="text-sm font-medium text-slate-300 mb-3">Event Volume</div>
      <div className="flex items-end gap-1 h-16">
        {timeline.map((b, i) => {
          const h = Math.max(2, Math.round((b.count / max) * 56))
          const hour = new Date(b.bucket).getHours()
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-1 group relative">
              <div
                className="w-full bg-blue-600/60 rounded-sm hover:bg-blue-500/80 transition-colors"
                style={{ height: h }}
              />
              <div className="hidden group-hover:block absolute bottom-full mb-1 bg-slate-700 text-white text-xs rounded px-2 py-1 whitespace-nowrap z-10">
                {new Date(b.bucket).toLocaleString()}: {b.count}
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex justify-between text-xs text-slate-600 mt-1">
        <span>{timeline[0] ? new Date(timeline[0].bucket).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : ''}</span>
        <span>{timeline[timeline.length-1] ? new Date(timeline[timeline.length-1].bucket).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : ''}</span>
      </div>
    </div>
  )
}

// ── Main SIEM page ──────────────────────────────────────────────────────────

export default function SIEM() {
  const [stats, setStats] = useState(null)
  const [events, setEvents] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [sources, setSources] = useState([])

  // Filters
  const [timeRange, setTimeRange] = useState('24h')
  const [search, setSearch] = useState('')
  const [filterLevel, setFilterLevel] = useState('')
  const [filterSource, setFilterSource] = useState('')
  const [filterAgent, setFilterAgent] = useState('')
  const [page, setPage] = useState(0)

  const PAGE_SIZE = 100
  const searchRef = useRef(null)

  const timeRanges = {
    '1h':  1,
    '6h':  6,
    '24h': 24,
    '3d':  72,
    '7d':  168,
  }

  const getTimeParams = useCallback(() => {
    const hours = timeRanges[timeRange] || 24
    const to = new Date()
    const from = new Date(to.getTime() - hours * 3600 * 1000)
    return { from: from.toISOString(), to: to.toISOString() }
  }, [timeRange])

  const loadStats = useCallback(async () => {
    try {
      const r = await siemApi.stats(getTimeParams())
      setStats(r.data)
    } catch { setStats(null) }
  }, [getTimeParams])

  const loadEvents = useCallback(async () => {
    setLoading(true)
    try {
      const params = {
        ...getTimeParams(),
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }
      if (filterLevel) params.level = filterLevel
      if (filterSource) params.log_source = filterSource
      if (filterAgent) params.agent_id = filterAgent
      if (search) params.q = search

      const r = await siemApi.events(params)
      setEvents(r.data.events || [])
      setTotal(r.data.total || 0)
    } catch { setEvents([]) }
    setLoading(false)
  }, [getTimeParams, filterLevel, filterSource, filterAgent, search, page])

  const loadSources = useCallback(async () => {
    try {
      const r = await siemApi.sources()
      setSources(r.data || [])
    } catch { setSources([]) }
  }, [])

  useEffect(() => {
    loadStats()
    loadEvents()
    loadSources()
  }, [loadStats, loadEvents, loadSources])

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const t = setInterval(() => {
      loadStats()
      if (page === 0 && !filterLevel && !filterSource && !filterAgent && !search) {
        loadEvents()
      }
    }, 30000)
    return () => clearInterval(t)
  }, [loadStats, loadEvents, page, filterLevel, filterSource, filterAgent, search])

  const handleSearch = (e) => {
    e.preventDefault()
    setPage(0)
    loadEvents()
  }

  const s = stats || {}

  return (
    <div className="p-6 max-w-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Shield className="w-6 h-6 text-blue-400" />
          <div>
            <h1 className="text-xl font-bold text-white">SIEM — Event Log</h1>
            <p className="text-xs text-slate-400">Security & system event collection from agents and syslog</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Time range */}
          <div className="flex gap-1 bg-slate-800 border border-slate-700 rounded-lg p-1">
            {Object.keys(timeRanges).map(r => (
              <button
                key={r}
                onClick={() => { setTimeRange(r); setPage(0) }}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  timeRange === r ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          <button
            onClick={() => { loadStats(); loadEvents() }}
            className="flex items-center gap-2 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-sm transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <StatCard
          label="Total Events"
          value={(s.total_events ?? 0).toLocaleString()}
          color="blue"
          sub={`Last ${timeRange}`}
        />
        <StatCard
          label="Critical"
          value={(s.by_level?.critical ?? 0).toLocaleString()}
          color={s.by_level?.critical > 0 ? 'red' : 'slate'}
        />
        <StatCard
          label="Errors"
          value={(s.by_level?.error ?? 0).toLocaleString()}
          color={s.by_level?.error > 0 ? 'orange' : 'slate'}
        />
        <StatCard
          label="Warnings"
          value={(s.by_level?.warning ?? 0).toLocaleString()}
          color={s.by_level?.warning > 0 ? 'yellow' : 'slate'}
        />
        <StatCard
          label="Info / Debug"
          value={((s.by_level?.info ?? 0) + (s.by_level?.debug ?? 0)).toLocaleString()}
          color="slate"
        />
      </div>

      {/* By source breakdown */}
      {s.by_log_source && Object.keys(s.by_log_source).length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {Object.entries(s.by_log_source).slice(0, 6).map(([src, cnt]) => (
            <button
              key={src}
              onClick={() => { setFilterSource(src === filterSource ? '' : src); setPage(0) }}
              className={`p-3 rounded-xl border text-left transition-colors ${
                filterSource === src
                  ? 'border-blue-500 bg-blue-900/20'
                  : 'border-slate-700 bg-slate-800/40 hover:border-slate-600'
              }`}
            >
              <div className="text-xs text-slate-400">{SOURCE_LABELS[src] || src}</div>
              <div className="text-lg font-bold text-white mt-0.5">{cnt.toLocaleString()}</div>
            </button>
          ))}
        </div>
      )}

      {/* Top agents */}
      {s.top_agents?.length > 0 && (
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 mb-6">
          <div className="text-sm font-medium text-slate-300 mb-3">Top Sources by Agent</div>
          <div className="flex flex-wrap gap-2">
            {s.top_agents.slice(0, 8).map(a => (
              <button
                key={a.agent_id}
                onClick={() => { setFilterAgent(a.agent_id === filterAgent ? '' : a.agent_id); setPage(0) }}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs transition-colors ${
                  filterAgent === a.agent_id
                    ? 'border-blue-500 bg-blue-900/20 text-blue-300'
                    : 'border-slate-600 bg-slate-700 text-slate-300 hover:border-slate-500'
                }`}
              >
                <Monitor className="w-3 h-3" />
                {a.hostname || a.agent_id.slice(0, 8)}
                <span className="text-slate-500">{a.count.toLocaleString()}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Timeline */}
      {s.timeline?.length > 0 && <TimelineChart timeline={s.timeline} />}

      {/* Event table */}
      <div className="bg-slate-800/60 border border-slate-700 rounded-xl overflow-hidden">
        {/* Filters toolbar */}
        <div className="p-4 border-b border-slate-700 flex flex-wrap gap-3 items-center">
          <form onSubmit={handleSearch} className="relative flex-1 min-w-52">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              ref={searchRef}
              className="w-full pl-9 pr-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:border-blue-500"
              placeholder="Search messages…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </form>

          <select
            className="px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500"
            value={filterLevel}
            onChange={e => { setFilterLevel(e.target.value); setPage(0) }}
          >
            <option value="">All Levels</option>
            {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
          </select>

          <select
            className="px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500"
            value={filterSource}
            onChange={e => { setFilterSource(e.target.value); setPage(0) }}
          >
            <option value="">All Sources</option>
            {sources.map(s => <option key={s} value={s}>{SOURCE_LABELS[s] || s}</option>)}
          </select>

          {(filterLevel || filterSource || filterAgent || search) && (
            <button
              onClick={() => { setFilterLevel(''); setFilterSource(''); setFilterAgent(''); setSearch(''); setPage(0) }}
              className="flex items-center gap-1.5 px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-400 hover:text-white rounded-lg text-sm transition-colors"
            >
              <XCircle className="w-3.5 h-3.5" />Clear
            </button>
          )}

          <div className="ml-auto text-xs text-slate-500">
            {total.toLocaleString()} events
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-slate-400 text-xs bg-slate-800/40">
                <th className="text-left px-4 py-3 w-40">Time</th>
                <th className="text-left px-4 py-3 w-28">Level</th>
                <th className="text-left px-4 py-3 w-32">Source</th>
                <th className="text-left px-4 py-3 w-36">Agent / IP</th>
                <th className="text-left px-4 py-3 w-20">Event ID</th>
                <th className="text-left px-4 py-3">Message</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-slate-500">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" />
                    Loading events...
                  </td>
                </tr>
              ) : events.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-16 text-center">
                    <Shield className="w-10 h-10 text-slate-600 mx-auto mb-3" />
                    <div className="text-slate-400 text-sm">No events found</div>
                    <div className="text-slate-600 text-xs mt-1">
                      Configure agents to push events, or send syslog to UDP port 514
                    </div>
                  </td>
                </tr>
              ) : (
                events.map((ev, i) => <EventRow key={ev.id || i} event={ev} />)
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="border-t border-slate-700 px-4 py-3 flex items-center justify-between text-xs text-slate-400">
            <span>
              Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total.toLocaleString()}
            </span>
            <div className="flex gap-2">
              <button
                disabled={page === 0}
                onClick={() => setPage(p => p - 1)}
                className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 rounded text-slate-300 transition-colors"
              >
                Previous
              </button>
              <button
                disabled={(page + 1) * PAGE_SIZE >= total}
                onClick={() => setPage(p => p + 1)}
                className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 rounded text-slate-300 transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Help footer */}
      <div className="mt-6 bg-slate-800/40 border border-slate-700/50 rounded-xl p-4 text-xs text-slate-500">
        <div className="font-medium text-slate-400 mb-2 flex items-center gap-1.5">
          <Info className="w-3.5 h-3.5" />
          How to send events to Kifaa SIEM
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <span className="text-slate-400">Network devices (syslog):</span> Send UDP syslog to{' '}
            <code className="bg-slate-700 px-1 rounded text-slate-300">192.168.0.7:514</code>{' '}
            (RFC 3164 or RFC 5424)
          </div>
          <div>
            <span className="text-slate-400">Agents:</span> Kifaa agents v1.3+ automatically push
            Windows Event Log and Linux journal entries every 5 minutes
          </div>
        </div>
      </div>
    </div>
  )
}
