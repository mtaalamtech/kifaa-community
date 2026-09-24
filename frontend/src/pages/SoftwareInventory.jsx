import { useState, useEffect, useCallback, useRef } from 'react'
import api from '../api/client'
import {
  Package, Search, Download, Monitor, Server,
  RefreshCw, ShieldCheck, Trash2, X, CheckSquare,
  Square, ChevronDown, ChevronUp, Loader2, AlertTriangle,
  History, CheckCircle2, XCircle, Clock
} from 'lucide-react'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function Badge({ text, cls }) {
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{text}</span>
}

function licBadge(status) {
  const s = (status || '').toLowerCase()
  if (['licensed', 'activated', 'active'].includes(s))
    return <Badge text={status} cls="bg-emerald-700 text-emerald-100" />
  if (['trial', 'expiring'].includes(s))
    return <Badge text={status} cls="bg-yellow-600 text-yellow-100" />
  if (['unlicensed', 'expired', 'invalid'].includes(s))
    return <Badge text={status} cls="bg-red-700 text-red-100" />
  return null
}

function StatusBadge({ status }) {
  if (status === 'success')
    return <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-400"><CheckCircle2 size={13}/>Success</span>
  if (status === 'failed')
    return <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-400"><XCircle size={13}/>Failed</span>
  if (status === 'cancelled')
    return <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-400"><X size={13}/>Cancelled</span>
  return <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-400"><Clock size={13}/>Pending</span>
}

function StatCard({ icon: Icon, label, value, color = 'text-blue-400' }) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 flex items-center gap-4">
      <div className={`w-10 h-10 rounded-lg bg-slate-700 flex items-center justify-center ${color}`}>
        <Icon size={20} />
      </div>
      <div>
        <div className="text-2xl font-bold text-white">{value ?? '—'}</div>
        <div className="text-xs text-slate-400">{label}</div>
      </div>
    </div>
  )
}

// ─── Endpoint List Popup ──────────────────────────────────────────────────────

function EndpointListModal({ software, osType, onClose }) {
  const [agents, setAgents]   = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get('/software/inventory/agents', { params: { name: software.name, os_type: osType } })
      .then(r => setAgents(r.data))
      .catch(() => setAgents([]))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl shadow-2xl w-full max-w-xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <div>
            <h3 className="text-white font-semibold">{software.name}</h3>
            <p className="text-slate-400 text-xs mt-0.5">{agents.length} endpoint{agents.length !== 1 ? 's' : ''} with this software</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20} /></button>
        </div>
        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-7 h-7 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : agents.length === 0 ? (
            <div className="text-center py-10 text-slate-500">No agents found</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 bg-slate-800/80 sticky top-0">
                  {['Hostname', 'IP Address', 'OS', 'Version', 'Status'].map(h => (
                    <th key={h} className="text-left px-4 py-3 text-xs text-slate-400 font-semibold uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {agents.map(a => (
                  <tr key={a.id} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                    <td className="px-4 py-3 text-white font-medium text-sm">
                      {a.hostname}
                      {a.display_name && a.display_name !== a.hostname && (
                        <span className="text-slate-500 text-xs ml-1">({a.display_name})</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{a.ip_address || '—'}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs capitalize">{a.os_type}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{a.versions || '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${a.status === 'online' ? 'bg-emerald-900/50 text-emerald-400' : 'bg-slate-700 text-slate-500'}`}>
                        {a.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="px-6 py-3 border-t border-slate-700 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm">Close</button>
        </div>
      </div>
    </div>
  )
}

// ─── Batch Uninstall Modal ────────────────────────────────────────────────────

function UninstallModal({ selected, osType, onClose, onDone }) {
  const [agentMap, setAgentMap]       = useState({})
  const [loadingMap, setLoadingMap]   = useState({})
  const [expandedMap, setExpandedMap] = useState({})
  const [chosenAgents, setChosenAgents] = useState({})
  const [submitting, setSubmitting]   = useState(false)
  const [result, setResult]           = useState(null)
  const [error, setError]             = useState(null)

  useEffect(() => {
    selected.forEach(sw => {
      setLoadingMap(m => ({ ...m, [sw.name]: true }))
      api.get('/software/inventory/agents', { params: { name: sw.name, os_type: osType } })
        .then(r => {
          const agents = r.data
          setAgentMap(m => ({ ...m, [sw.name]: agents }))
          setChosenAgents(prev => ({ ...prev, [sw.name]: new Set(agents.map(a => a.id)) }))
          setExpandedMap(m => ({ ...m, [sw.name]: true }))
        })
        .catch(() => {
          setAgentMap(m => ({ ...m, [sw.name]: [] }))
          setChosenAgents(prev => ({ ...prev, [sw.name]: new Set() }))
        })
        .finally(() => setLoadingMap(m => ({ ...m, [sw.name]: false })))
    })
  }, [])

  function toggleAgent(name, id) {
    setChosenAgents(prev => {
      const s = new Set(prev[name] || [])
      s.has(id) ? s.delete(id) : s.add(id)
      return { ...prev, [name]: s }
    })
  }

  function toggleAll(name) {
    const agents = agentMap[name] || []
    setChosenAgents(prev => {
      const s = prev[name] || new Set()
      const allSelected = agents.every(a => s.has(a.id))
      return { ...prev, [name]: allSelected ? new Set() : new Set(agents.map(a => a.id)) }
    })
  }

  const totalDispatch = selected.reduce((acc, sw) => acc + (chosenAgents[sw.name]?.size || 0), 0)

  async function handleUninstall() {
    setSubmitting(true); setError(null)
    try {
      const items = selected.map(sw => ({
        name: sw.name, version: '',
        agent_ids: [...(chosenAgents[sw.name] || [])],
      })).filter(i => i.agent_ids.length > 0)
      if (!items.length) { setError('No agents selected'); setSubmitting(false); return }
      const r = await api.post('/software/inventory/uninstall', { items })
      setResult(r.data)
    } catch (e) {
      setError(e.response?.data?.detail || 'Uninstall failed')
    } finally { setSubmitting(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <div className="flex items-center gap-3">
            <Trash2 size={18} className="text-red-400" />
            <h3 className="text-white font-semibold text-lg">Batch Uninstall</h3>
            <span className="text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full">
              {selected.length} title{selected.length !== 1 ? 's' : ''}
            </span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20} /></button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-4">
          {result ? (
            <div className="space-y-4">
              <div className={`rounded-xl p-4 border ${result.dispatched > 0 ? 'border-emerald-600 bg-emerald-900/20' : 'border-red-600 bg-red-900/20'}`}>
                <div className="font-semibold text-white mb-1">
                  {result.dispatched} uninstall command{result.dispatched !== 1 ? 's' : ''} queued
                </div>
                <div className="text-slate-400 text-sm">
                  Commands queued. Uninstall runs on each agent's next check-in. Track progress in the <strong className="text-white">History</strong> tab.
                </div>
              </div>
              {result.errors?.length > 0 && (
                <div className="bg-red-900/20 border border-red-700 rounded-xl p-4 text-sm text-red-300">
                  <div className="font-semibold mb-1">Errors ({result.errors.length})</div>
                  <ul className="space-y-1 list-disc list-inside">{result.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
                </div>
              )}
            </div>
          ) : (
            <>
              <p className="text-slate-400 text-sm">Select which endpoints to uninstall from. Commands execute on next agent check-in.</p>
              {selected.map(sw => {
                const agents   = agentMap[sw.name] || []
                const loading  = loadingMap[sw.name]
                const chosen   = chosenAgents[sw.name] || new Set()
                const expanded = expandedMap[sw.name] !== false
                const allSel   = agents.length > 0 && agents.every(a => chosen.has(a.id))
                const someSel  = !allSel && agents.some(a => chosen.has(a.id))
                return (
                  <div key={sw.name} className="border border-slate-700 rounded-xl overflow-hidden">
                    <div className="flex items-center gap-3 px-4 py-3 bg-slate-700/50 cursor-pointer select-none"
                      onClick={() => setExpandedMap(m => ({ ...m, [sw.name]: !expanded }))}>
                      <button onClick={e => { e.stopPropagation(); toggleAll(sw.name) }}
                        className="text-slate-400 hover:text-white flex-shrink-0"
                        disabled={loading || agents.length === 0}>
                        {allSel ? <CheckSquare size={16} className="text-blue-400" />
                          : someSel ? <CheckSquare size={16} className="text-blue-300 opacity-60" />
                          : <Square size={16} />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="text-white font-medium text-sm truncate">{sw.name}</div>
                        {sw.publisher && <div className="text-slate-500 text-xs truncate">{sw.publisher}</div>}
                      </div>
                      <span className="text-xs text-slate-400 flex-shrink-0">
                        {loading ? '…' : `${chosen.size}/${agents.length} agents`}
                      </span>
                      {expanded ? <ChevronUp size={14} className="text-slate-500" /> : <ChevronDown size={14} className="text-slate-500" />}
                    </div>
                    {expanded && (
                      <div className="divide-y divide-slate-700/50">
                        {loading ? (
                          <div className="flex items-center gap-2 px-4 py-3 text-slate-500 text-sm">
                            <Loader2 size={14} className="animate-spin" /> Loading agents…
                          </div>
                        ) : agents.length === 0 ? (
                          <div className="px-4 py-3 text-slate-500 text-sm">No active agents found</div>
                        ) : agents.map(agent => (
                          <label key={agent.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-700/40 cursor-pointer">
                            <input type="checkbox" checked={chosen.has(agent.id)}
                              onChange={() => toggleAgent(sw.name, agent.id)} className="accent-blue-500" />
                            <div className="flex-1 min-w-0">
                              <span className="text-white text-sm font-medium">{agent.hostname}</span>
                              {agent.display_name && agent.display_name !== agent.hostname && (
                                <span className="text-slate-500 text-xs ml-2">({agent.display_name})</span>
                              )}
                              <span className="text-slate-500 text-xs ml-2">{agent.ip_address}</span>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <span className="text-slate-500 text-xs">{agent.versions}</span>
                              <span className={`text-xs px-1.5 py-0.5 rounded ${agent.status === 'online' ? 'bg-emerald-900/50 text-emerald-400' : 'bg-slate-700 text-slate-500'}`}>
                                {agent.status}
                              </span>
                            </div>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
              {error && (
                <div className="bg-red-900/30 border border-red-700 rounded-lg p-3 text-red-300 text-sm flex items-center gap-2">
                  <AlertTriangle size={14} /> {error}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-700">
          {result ? (
            <button onClick={onDone} className="ml-auto px-5 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium">Close</button>
          ) : (
            <>
              <span className="text-slate-400 text-sm">{totalDispatch} command{totalDispatch !== 1 ? 's' : ''} will be queued</span>
              <div className="flex gap-3">
                <button onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm">Cancel</button>
                <button onClick={handleUninstall} disabled={submitting || totalDispatch === 0}
                  className="flex items-center gap-2 px-5 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-semibold disabled:opacity-50">
                  {submitting ? <><Loader2 size={14} className="animate-spin" /> Queuing…</>
                    : <><Trash2 size={14} /> Uninstall {totalDispatch} command{totalDispatch !== 1 ? 's' : ''}</>}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── History Tab ──────────────────────────────────────────────────────────────

function HistoryTab() {
  const [jobs, setJobs]         = useState([])
  const [loading, setLoading]   = useState(false)
  const [search, setSearch]     = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [expanded, setExpanded] = useState(null)
  const [cancelling, setCancelling] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.get('/software/uninstall-jobs', {
        params: { software_name: search.trim(), status: statusFilter }
      })
      setJobs(r.data)
    } catch { setJobs([]) }
    finally { setLoading(false) }
  }, [search, statusFilter])

  const cancelJob = useCallback(async (jobId) => {
    setCancelling(jobId)
    try {
      await api.patch(`/software/uninstall-jobs/${jobId}`, { status: 'cancelled' })
      setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: 'cancelled' } : j))
    } catch {} finally { setCancelling(null) }
  }, [])

  useEffect(() => { load() }, [load])

  // Group by software name
  const grouped = jobs.reduce((acc, j) => {
    const k = j.software_name
    if (!acc[k]) acc[k] = []
    acc[k].push(j)
    return acc
  }, {})

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
            placeholder="Filter by software name…"
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select
          className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
          value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="all">All Statuses</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
          <option value="pending">Pending</option>
        </select>
        <button onClick={load} className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
        <span className="text-slate-500 text-sm ml-auto">{jobs.length} job{jobs.length !== 1 ? 's' : ''}</span>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="w-7 h-7 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-12 text-center text-slate-500">
          No uninstall history found
        </div>
      ) : (
        <div className="space-y-3">
          {Object.entries(grouped).map(([swName, swJobs]) => {
            const successCount = swJobs.filter(j => j.status === 'success').length
            const failedCount  = swJobs.filter(j => j.status === 'failed').length
            const pendingCount = swJobs.filter(j => j.status === 'pending').length
            const isExpanded   = expanded === swName

            return (
              <div key={swName} className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
                {/* Software group header */}
                <button
                  onClick={() => setExpanded(isExpanded ? null : swName)}
                  className="w-full flex items-center gap-4 px-5 py-4 hover:bg-slate-700/40 transition-colors text-left"
                >
                  <Package size={16} className="text-slate-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-white font-semibold text-sm">{swName}</div>
                    <div className="text-slate-500 text-xs mt-0.5">{swJobs.length} job{swJobs.length !== 1 ? 's' : ''}</div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    {successCount > 0 && <span className="flex items-center gap-1 text-xs text-emerald-400"><CheckCircle2 size={12}/>{successCount}</span>}
                    {failedCount  > 0 && <span className="flex items-center gap-1 text-xs text-red-400"><XCircle size={12}/>{failedCount}</span>}
                    {pendingCount > 0 && <span className="flex items-center gap-1 text-xs text-amber-400"><Clock size={12}/>{pendingCount}</span>}
                    {isExpanded ? <ChevronUp size={14} className="text-slate-500" /> : <ChevronDown size={14} className="text-slate-500" />}
                  </div>
                </button>

                {/* Job rows */}
                {isExpanded && (
                  <div className="border-t border-slate-700">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-700/60 bg-slate-700/20">
                          {['Endpoint', 'IP', 'OS', 'Version', 'Status', 'Triggered By', 'Queued', 'Finished', 'Output', ''].map(h => (
                            <th key={h} className="text-left px-4 py-2.5 text-xs text-slate-400 font-semibold uppercase tracking-wide whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {swJobs.map(job => (
                          <tr key={job.id} className="border-b border-slate-700/30 hover:bg-slate-700/20">
                            <td className="px-4 py-3 text-white font-medium text-sm">
                              {job.hostname || '—'}
                              {job.display_name && job.display_name !== job.hostname && (
                                <span className="text-slate-500 text-xs ml-1">({job.display_name})</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-slate-400 text-xs">{job.ip_address || '—'}</td>
                            <td className="px-4 py-3 text-slate-400 text-xs capitalize">{job.os_type || '—'}</td>
                            <td className="px-4 py-3 text-slate-400 text-xs">{job.software_version || '—'}</td>
                            <td className="px-4 py-3"><StatusBadge status={job.status} /></td>
                            <td className="px-4 py-3 text-slate-400 text-xs">{job.triggered_by || '—'}</td>
                            <td className="px-4 py-3 text-slate-500 text-xs whitespace-nowrap">
                              {job.queued_at ? new Date(job.queued_at).toLocaleString() : '—'}
                            </td>
                            <td className="px-4 py-3 text-slate-500 text-xs whitespace-nowrap">
                              {job.finished_at ? new Date(job.finished_at).toLocaleString() : '—'}
                            </td>
                            <td className="px-4 py-3 text-xs max-w-[200px]">
                              {job.error_message
                                ? <span className="text-red-400 truncate block" title={job.error_message}>{job.error_message}</span>
                                : job.output
                                ? <span className="text-slate-400 truncate block" title={job.output}>{job.output.slice(0, 80)}{job.output.length > 80 ? '…' : ''}</span>
                                : <span className="text-slate-600">—</span>
                              }
                            </td>
                            <td className="px-4 py-3">
                              {job.status === 'pending' && (
                                <button
                                  onClick={() => cancelJob(job.id)}
                                  disabled={cancelling === job.id}
                                  className="text-xs text-slate-500 hover:text-red-400 transition-colors disabled:opacity-50"
                                  title="Cancel this pending job"
                                >
                                  {cancelling === job.id ? <Loader2 size={13} className="animate-spin"/> : <X size={13}/>}
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'windows', label: 'Windows', icon: Monitor },
  { id: 'linux',   label: 'Linux',   icon: Server  },
  { id: 'history', label: 'Uninstall History', icon: History },
]

export default function SoftwareInventory() {
  const [tab, setTab]             = useState('windows')
  const [debouncedSearch, setDS]  = useState('')
  const [search, setSearch]       = useState('')
  const [items, setItems]         = useState([])
  const [total, setTotal]         = useState(0)
  const [page, setPage]           = useState(1)
  const [loading, setLoading]     = useState(false)
  const [exporting, setExporting] = useState(false)
  const [stats, setStats]         = useState(null)
  const [selected, setSelected]   = useState(new Set())
  const [showUninstall, setShowUninstall] = useState(false)
  const [endpointModal, setEndpointModal] = useState(null) // software item
  const perPage = 100

  useEffect(() => {
    const t = setTimeout(() => setSearch(debouncedSearch), 350)
    return () => clearTimeout(t)
  }, [debouncedSearch])

  const loadStats = useCallback(async () => {
    try { const r = await api.get('/software/inventory/stats'); setStats(r.data) } catch {}
  }, [])

  const load = useCallback(async () => {
    if (tab === 'history') return
    setLoading(true)
    try {
      const r = await api.get('/software/inventory', {
        params: { os_type: tab, search: search.trim(), page, per_page: perPage }
      })
      setItems(r.data.items); setTotal(r.data.total)
    } catch { setItems([]) } finally { setLoading(false) }
  }, [tab, search, page])

  useEffect(() => { loadStats() }, [loadStats])
  useEffect(() => { setPage(1); setSelected(new Set()) }, [tab, search])
  useEffect(() => { load() }, [load])

  function toggleSelect(name) {
    setSelected(prev => { const s = new Set(prev); s.has(name) ? s.delete(name) : s.add(name); return s })
  }
  function toggleAll() {
    setSelected(selected.size === items.length ? new Set() : new Set(items.map(i => i.name)))
  }

  const selectedItems = items.filter(i => selected.has(i.name))
  const allSelected   = items.length > 0 && selected.size === items.length
  const someSelected  = !allSelected && selected.size > 0

  async function handleExport() {
    setExporting(true)
    try {
      const token = localStorage.getItem('kifaa_token')
      const res = await fetch('/api/v1/software/inventory/export', { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error('Export failed')
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href = url; a.download = `software_inventory_${new Date().toISOString().slice(0,10)}.xlsx`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (e) { alert(e.message || 'Export failed') }
    finally { setExporting(false) }
  }

  const totalPages = Math.ceil(total / perPage)
  const osType = tab === 'history' ? 'all' : tab

  return (
    <div className="space-y-6 pb-24">
      {endpointModal && (
        <EndpointListModal software={endpointModal} osType={osType} onClose={() => setEndpointModal(null)} />
      )}
      {showUninstall && (
        <UninstallModal
          selected={selectedItems} osType={tab}
          onClose={() => setShowUninstall(false)}
          onDone={() => { setShowUninstall(false); setSelected(new Set()); load() }}
        />
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <Package className="text-blue-400" size={28} />
            Software Inventory
          </h1>
          <p className="text-slate-400 text-sm mt-1">Distinct software titles across all active endpoints</p>
        </div>
        {tab !== 'history' && (
          <button onClick={handleExport} disabled={exporting}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium disabled:opacity-50">
            <Download size={16} />{exporting ? 'Generating…' : 'Export XLSX'}
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard icon={Package}     label="Total Distinct Titles"  value={stats?.distinct_titles}  color="text-blue-400" />
        <StatCard icon={Monitor}     label="Windows Titles"         value={stats?.windows_titles}   color="text-sky-400" />
        <StatCard icon={Server}      label="Linux Titles"           value={stats?.linux_titles}     color="text-purple-400" />
        <StatCard icon={ShieldCheck} label="Licensed Entries"       value={stats?.licensed_entries} color="text-emerald-400" />
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-4 flex-wrap border-b border-slate-700">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === id ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-400 hover:text-white hover:border-slate-500'
            }`}>
            <Icon size={15} />{label}
          </button>
        ))}
        {tab !== 'history' && (
          <div className="ml-auto flex items-center gap-3 pb-1">
            <div className="relative min-w-[220px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                placeholder="Search by name or publisher…"
                value={debouncedSearch} onChange={e => setDS(e.target.value)} />
            </div>
            <button onClick={load} className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg">
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        )}
      </div>

      {/* Tab content */}
      {tab === 'history' ? (
        <HistoryTab />
      ) : (
        <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
            <span className="text-sm text-slate-400">
              {loading ? 'Loading…' : `${total.toLocaleString()} ${tab} title${total !== 1 ? 's' : ''}`}
            </span>
            {totalPages > 1 && (
              <div className="flex items-center gap-2 text-sm">
                <button onClick={() => setPage(p => Math.max(1,p-1))} disabled={page===1}
                  className="px-2 py-1 rounded bg-slate-700 text-slate-300 disabled:opacity-40 hover:bg-slate-600">‹</button>
                <span className="text-slate-400">{page}/{totalPages}</span>
                <button onClick={() => setPage(p => Math.min(totalPages,p+1))} disabled={page===totalPages}
                  className="px-2 py-1 rounded bg-slate-700 text-slate-300 disabled:opacity-40 hover:bg-slate-600">›</button>
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 bg-slate-800/80">
                  <th className="px-4 py-3 w-10">
                    <button onClick={toggleAll} className="text-slate-400 hover:text-white">
                      {allSelected ? <CheckSquare size={16} className="text-blue-400" />
                        : someSelected ? <CheckSquare size={16} className="text-blue-300 opacity-60" />
                        : <Square size={16} />}
                    </button>
                  </th>
                  {['Software Name','Publisher','Version(s)','Endpoints','Size (MB)','Last Seen','License Status','License Type','Expiry'].map(h => (
                    <th key={h} className="text-left px-4 py-3 text-xs text-slate-400 font-semibold uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={10} className="text-center py-12">
                    <div className="inline-block w-7 h-7 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  </td></tr>
                ) : items.length === 0 ? (
                  <tr><td colSpan={10} className="text-center py-12 text-slate-500">
                    No {tab} software found{debouncedSearch ? ` matching "${debouncedSearch}"` : ''}
                  </td></tr>
                ) : items.map((item, i) => {
                  const isSel = selected.has(item.name)
                  return (
                    <tr key={`${item.name}-${i}`} onClick={() => toggleSelect(item.name)}
                      className={`border-b border-slate-700/50 cursor-pointer transition-colors align-top ${isSel ? 'bg-blue-900/20 hover:bg-blue-900/30' : 'hover:bg-slate-700/30'}`}>
                      <td className="px-4 py-4" onClick={e => e.stopPropagation()}>
                        <button onClick={() => toggleSelect(item.name)} className="text-slate-400 hover:text-white mt-0.5">
                          {isSel ? <CheckSquare size={16} className="text-blue-400" /> : <Square size={16} />}
                        </button>
                      </td>
                      <td className="px-4 py-4 text-white font-medium min-w-[220px] max-w-[320px]">
                        <div className="break-words leading-snug">{item.name}</div>
                      </td>
                      <td className="px-4 py-4 text-slate-300 min-w-[140px] max-w-[220px]">
                        <div className="break-words text-xs leading-relaxed">{item.publisher || '—'}</div>
                      </td>
                      <td className="px-4 py-4 text-slate-300 min-w-[100px] max-w-[180px]">
                        <div className="break-words text-xs leading-relaxed">{item.versions || '—'}</div>
                      </td>
                      {/* Clickable endpoint count */}
                      <td className="px-4 py-4 text-center" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={() => setEndpointModal(item)}
                          className="inline-flex items-center gap-1 bg-slate-700 hover:bg-blue-700 text-slate-200 text-xs font-semibold px-2.5 py-1.5 rounded-full transition-colors"
                          title="Click to see endpoint list"
                        >
                          <Monitor size={11} />{item.endpoint_count}
                        </button>
                      </td>
                      <td className="px-4 py-4 text-slate-400 text-xs text-center whitespace-nowrap">
                        {item.size_mb != null ? item.size_mb.toFixed(1) : '—'}
                      </td>
                      <td className="px-4 py-4 text-slate-400 text-xs whitespace-nowrap text-center">
                        {item.last_seen ? new Date(item.last_seen).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-4 py-4 text-center">
                        {item.license_status ? licBadge(item.license_status) : <span className="text-slate-600 text-xs">—</span>}
                      </td>
                      <td className="px-4 py-4 text-slate-400 text-xs text-center whitespace-nowrap">{item.license_type || '—'}</td>
                      <td className="px-4 py-4 text-xs text-center whitespace-nowrap">
                        {item.license_expiry ? (() => {
                          const exp = new Date(item.license_expiry)
                          const d   = Math.ceil((exp - Date.now()) / 86400000)
                          const cls = d < 0 ? 'text-red-400' : d < 30 ? 'text-amber-400' : 'text-slate-400'
                          return <span className={cls} title={exp.toLocaleDateString()}>
                            {d < 0 ? `Expired ${Math.abs(d)}d ago` : d < 30 ? `${d}d left` : exp.toLocaleDateString()}
                          </span>
                        })() : <span className="text-slate-600">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700">
              <span className="text-xs text-slate-500">
                Showing {((page-1)*perPage)+1}–{Math.min(page*perPage,total)} of {total.toLocaleString()}
              </span>
              <div className="flex items-center gap-2">
                {[['«',1],['‹ Prev',page-1],['Next ›',page+1],['»',totalPages]].map(([lbl, pg], idx) => (
                  <button key={idx}
                    onClick={() => setPage(Math.max(1, Math.min(totalPages, pg)))}
                    disabled={lbl.includes('«') || lbl.includes('‹') ? page===1 : page===totalPages}
                    className="px-2 py-1 rounded bg-slate-700 text-slate-300 text-xs disabled:opacity-40 hover:bg-slate-600">
                    {lbl}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Floating action bar */}
      {selected.size > 0 && tab !== 'history' && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-4
                        bg-slate-900 border border-slate-600 shadow-2xl rounded-2xl px-6 py-3">
          <span className="text-white font-semibold text-sm">
            {selected.size} title{selected.size !== 1 ? 's' : ''} selected
          </span>
          <button onClick={() => setSelected(new Set())} className="text-slate-400 hover:text-white text-sm">Clear</button>
          <button onClick={() => setShowUninstall(true)}
            className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-semibold">
            <Trash2 size={15} /> Batch Uninstall
          </button>
        </div>
      )}
    </div>
  )
}
