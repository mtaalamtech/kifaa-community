import { useState, useEffect } from 'react'
import { Monitor, Download, RefreshCw, CheckSquare, Square, Calendar, X, Users, Clock, Wifi } from 'lucide-react'
import api from '../api/client'

const CURRENT_YEAR = new Date().getFullYear()
const YEARS = Array.from({ length: 5 }, (_, i) => CURRENT_YEAR - i)
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function fmtDuration(secs) {
  if (!secs) return '—'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (h) return `${h}h ${String(m).padStart(2,'0')}m`
  return `${m}m`
}

function fmtTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

// ── Session drawer shown when a server card is clicked ─────────────────────
function SessionDrawer({ agent, onClose }) {
  const [sessions, setSessions] = useState([])
  const [active, setActive]     = useState([])
  const [loading, setLoading]   = useState(true)
  const [tab, setTab]           = useState('active') // 'active' | 'history'
  const [filterMonth, setFilterMonth] = useState(new Date().getMonth() + 1)
  const [filterYear, setFilterYear]   = useState(CURRENT_YEAR)

  const load = async () => {
    setLoading(true)
    try {
      const [actRes, histRes] = await Promise.all([
        api.get(`/rdp-report/active/${agent.id}`),
        api.get(`/rdp-report/sessions/${agent.id}?year=${filterYear}&month=${filterMonth}`),
      ])
      setActive(actRes.data)
      setSessions(histRes.data.sessions || [])
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [agent.id, filterYear, filterMonth])

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="w-full max-w-2xl bg-white h-full shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-gray-50">
          <div>
            <div className="flex items-center gap-2">
              <Monitor className="w-5 h-5 text-blue-600" />
              <h2 className="text-lg font-semibold text-gray-900">{agent.display_name}</h2>
              <span className={`w-2 h-2 rounded-full ${agent.status === 'online' ? 'bg-green-400' : 'bg-gray-300'}`} />
            </div>
            <p className="text-xs text-gray-500 mt-0.5">{agent.ip_address}</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-200 rounded-lg">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200">
          <button
            onClick={() => setTab('active')}
            className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${tab === 'active' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            <span className="flex items-center gap-2">
              <Wifi className="w-4 h-4" />
              Connected Now
              {active.length > 0 && (
                <span className="bg-green-100 text-green-700 text-xs font-bold px-1.5 py-0.5 rounded-full">{active.length}</span>
              )}
            </span>
          </button>
          <button
            onClick={() => setTab('history')}
            className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${tab === 'history' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            <span className="flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Session History
            </span>
          </button>
        </div>

        {/* Filter bar (history tab) */}
        {tab === 'history' && (
          <div className="flex items-center gap-3 px-6 py-3 bg-gray-50 border-b border-gray-100">
            <select value={filterMonth} onChange={e => setFilterMonth(Number(e.target.value))}
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              {MONTHS.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
            </select>
            <select value={filterYear} onChange={e => setFilterYear(Number(e.target.value))}
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            <button onClick={load} className="p-1.5 hover:bg-gray-200 rounded-lg">
              <RefreshCw className={`w-4 h-4 text-gray-500 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <span className="text-xs text-gray-400 ml-auto">{sessions.length} session(s)</span>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-40 text-gray-400">
              <RefreshCw className="w-6 h-6 animate-spin mb-2" />
              <p className="text-sm">Loading…</p>
            </div>
          ) : tab === 'active' ? (
            active.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 text-gray-400">
                <Users className="w-10 h-10 mb-3 text-gray-300" />
                <p className="text-sm font-medium">No active sessions</p>
                <p className="text-xs mt-1">No open RDP connections in the last 24 hours</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {active.map((s, i) => (
                  <div key={i} className="flex items-center gap-4 px-6 py-4 hover:bg-gray-50">
                    <div className="w-9 h-9 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
                      <span className="text-sm font-bold text-green-700">{(s.username || '?')[0].toUpperCase()}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm text-gray-900">{s.domain ? `${s.domain}\\${s.username}` : s.username}</p>
                      <p className="text-xs text-gray-500">From {s.source_ip || 'local'} · Connected {fmtTime(s.logon_time)}</p>
                    </div>
                    <span className="flex items-center gap-1 text-xs text-green-600 bg-green-50 px-2 py-1 rounded-full font-medium">
                      <span className="w-1.5 h-1.5 bg-green-500 rounded-full" />
                      Connected
                    </span>
                  </div>
                ))}
              </div>
            )
          ) : (
            sessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 text-gray-400">
                <Clock className="w-10 h-10 mb-3 text-gray-300" />
                <p className="text-sm font-medium">No sessions found</p>
                <p className="text-xs mt-1">No RDP sessions recorded for this period</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">User</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">From</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Logon</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Duration</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">End</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {sessions.map((s, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-6 py-3 font-medium text-gray-900">
                        {s.domain ? `${s.domain}\\${s.username}` : s.username}
                      </td>
                      <td className="px-4 py-3 text-gray-500 font-mono text-xs">{s.source_ip || '—'}</td>
                      <td className="px-4 py-3 text-gray-600 text-xs whitespace-nowrap">{fmtTime(s.logon_time)}</td>
                      <td className="px-4 py-3 text-gray-600">{fmtDuration(s.duration_seconds)}</td>
                      <td className="px-4 py-3">
                        {s.logoff_type === 'logoff' ? (
                          <span className="text-xs text-gray-500">Logoff</span>
                        ) : s.logoff_type === 'disconnect' ? (
                          <span className="text-xs text-amber-600">Disconnect</span>
                        ) : (
                          <span className="text-xs text-green-600">Active</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function RDPReport() {
  const [agents, setAgents]       = useState([])
  const [loading, setLoading]     = useState(true)
  const [selected, setSelected]   = useState(new Set())
  const [year, setYear]           = useState(CURRENT_YEAR)
  const [generating, setGenerating] = useState(false)
  const [error, setError]         = useState('')
  const [drawer, setDrawer]       = useState(null) // agent object for drill-down

  const totalOnline = agents.reduce((sum, a) => sum + (a.active_count || 0), 0)

  const fetchAgents = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.get('/rdp-report/agents')
      setAgents(res.data)
      setSelected(new Set(res.data.map(a => a.id)))
    } catch (e) {
      setError('Could not load agent list: ' + (e.response?.data?.detail || e.message))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchAgents() }, [])

  const toggle = (id) => setSelected(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  const toggleAll = () => {
    if (selected.size === agents.length) setSelected(new Set())
    else setSelected(new Set(agents.map(a => a.id)))
  }

  const download = async () => {
    if (!selected.size) { setError('Select at least one server.'); return }
    setGenerating(true)
    setError('')
    try {
      const ids = [...selected].join(',')
      const token = localStorage.getItem('token')
      const url = `${import.meta.env.VITE_API_URL}/rdp-report/xlsx?agent_ids=${encodeURIComponent(ids)}&year=${year}`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) {
        const txt = await res.text()
        throw new Error(txt || `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `rdp_report_${year}.xlsx`
      link.click()
      URL.revokeObjectURL(link.href)
    } catch (e) {
      setError('Download failed: ' + e.message)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {drawer && <SessionDrawer agent={drawer} onClose={() => setDrawer(null)} />}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-100 rounded-lg">
            <Monitor className="w-6 h-6 text-blue-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">RDP Connection Report</h1>
            <p className="text-sm text-gray-500">Click a server to see who's connected · Download XLSX for full report</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {!loading && totalOnline > 0 && (
            <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-4 py-2">
              <span className="w-2.5 h-2.5 bg-green-500 rounded-full animate-pulse" />
              <span className="text-sm font-semibold text-green-700">{totalOnline} user{totalOnline !== 1 ? 's' : ''} online now</span>
            </div>
          )}
          <button onClick={fetchAgents} disabled={loading} className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors">
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">{error}</div>
      )}

      {/* Controls */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-semibold text-gray-800">Report Settings</h2>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-gray-400" />
              <label className="text-sm text-gray-600 font-medium">Year:</label>
              <select
                value={year}
                onChange={e => setYear(Number(e.target.value))}
                className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            <button
              onClick={download}
              disabled={generating || !selected.size}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white rounded-lg text-sm font-medium transition-colors"
            >
              {generating
                ? <><RefreshCw className="w-4 h-4 animate-spin" /> Generating…</>
                : <><Download className="w-4 h-4" /> Download XLSX</>
              }
            </button>
          </div>
        </div>

        {/* Server picker */}
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-gray-700">Select Servers ({selected.size} of {agents.length}) · Click to view sessions</h3>
            <button onClick={toggleAll} className="text-xs text-blue-600 hover:underline">
              {selected.size === agents.length ? 'Deselect all' : 'Select all'}
            </button>
          </div>

          {loading ? (
            <div className="text-center py-8 text-gray-400">
              <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2" />
              <p className="text-sm">Loading servers…</p>
            </div>
          ) : agents.length === 0 ? (
            <div className="text-center py-8 text-gray-400">
              <Monitor className="w-10 h-10 mx-auto mb-3 text-gray-300" />
              <p className="text-sm font-medium">No Windows agents found</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {agents.map(agent => {
                const isSelected = selected.has(agent.id)
                return (
                  <div key={agent.id} className="relative group">
                    {/* Checkbox area */}
                    <button
                      onClick={() => toggle(agent.id)}
                      className={`w-full flex items-start gap-3 p-4 rounded-lg border-2 text-left transition-all ${
                        isSelected ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:border-gray-300'
                      }`}
                    >
                      <div className="mt-0.5 flex-shrink-0">
                        {isSelected
                          ? <CheckSquare className="w-5 h-5 text-blue-500" />
                          : <Square className="w-5 h-5 text-gray-300" />
                        }
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm text-gray-900 truncate">{agent.display_name}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{agent.ip_address}</p>
                        <p className="text-xs mt-1 flex items-center gap-1.5 flex-wrap">
                          <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${agent.status === 'online' ? 'bg-green-400' : 'bg-gray-300'}`}></span>
                          <span className="text-gray-400">{agent.status === 'online' ? 'Online' : 'Offline'}</span>
                          {agent.active_count > 0 && (
                            <span className="inline-flex items-center gap-1 bg-green-100 text-green-700 font-semibold px-1.5 py-0.5 rounded-full text-xs">
                              <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
                              {agent.active_count} online
                            </span>
                          )}
                          <span className="text-gray-300">·</span>
                          <span className="text-gray-400">{agent.session_count > 0 ? `${agent.session_count.toLocaleString()} sessions` : 'No data yet'}</span>
                        </p>
                      </div>
                    </button>
                    {/* View sessions button */}
                    <button
                      onClick={() => setDrawer(agent)}
                      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-white border border-gray-200 hover:border-blue-400 hover:text-blue-600 text-gray-500 text-xs px-2 py-1 rounded-md shadow-sm"
                    >
                      View
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Info box */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-5">
        <h3 className="font-semibold text-blue-900 mb-2 text-sm">Report Contents</h3>
        <ul className="space-y-1 text-sm text-blue-800">
          <li>• <strong>Sheet 1 — Monthly Summary:</strong> connections per server per month + yearly totals</li>
          <li>• <strong>Per-server sheets:</strong> username, source IP, logon time, logoff time, session duration</li>
          <li>• Data collected from Windows Event Log (TerminalServices-LocalSessionManager)</li>
        </ul>
      </div>
    </div>
  )
}
