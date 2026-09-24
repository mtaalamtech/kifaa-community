import { useState, useEffect, useCallback } from 'react'
import { KeyRound, RefreshCw, Search, AlertTriangle, CheckCircle, Clock, XCircle } from 'lucide-react'

const API = '/api/v1'
const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('kifaa_token')}` })

async function apiFetch(path) {
  const res = await fetch(API + path, { headers: authHeaders() })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

function StatusBadge({ status }) {
  switch (status) {
    case 'activated':
      return <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border bg-green-900/40 text-green-300 border-green-700"><CheckCircle size={10} /> Activated</span>
    case 'not_activated':
      return <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border bg-red-900/40 text-red-300 border-red-700"><XCircle size={10} /> Not Activated</span>
    case 'grace_period':
      return <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border bg-yellow-900/40 text-yellow-300 border-yellow-700"><Clock size={10} /> Grace Period</span>
    case 'expired':
      return <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border bg-red-900/40 text-red-300 border-red-700"><AlertTriangle size={10} /> Expired</span>
    default:
      return <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-slate-800 text-slate-400 border-slate-600 capitalize">{status || 'Unknown'}</span>
  }
}

function isExpiringSoon(expiryDate) {
  if (!expiryDate) return false
  const days = (new Date(expiryDate) - new Date()) / (1000 * 60 * 60 * 24)
  return days > 0 && days <= 30
}

function isExpired(expiryDate) {
  if (!expiryDate) return false
  return new Date(expiryDate) < new Date()
}

export default function Licenses() {
  const [licenses, setLicenses] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [groupByAgent, setGroupByAgent] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [lics, sum] = await Promise.all([
        apiFetch('/licenses'),
        apiFetch('/licenses/summary'),
      ])
      setLicenses(lics)
      setSummary(sum)
    } catch { setLicenses([]) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = licenses.filter(l => {
    const q = search.toLowerCase()
    if (q && !l.hostname?.toLowerCase().includes(q) && !l.software_name?.toLowerCase().includes(q)) return false
    if (filterStatus && l.activation_status !== filterStatus) return false
    return true
  })

  // Group by agent for agent view
  const byAgent = {}
  filtered.forEach(l => {
    const key = l.agent_id
    if (!byAgent[key]) byAgent[key] = { hostname: l.display_name || l.hostname, ip: l.ip_address, os: l.os_type, licenses: [] }
    byAgent[key].licenses.push(l)
  })

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-purple-600/20 flex items-center justify-center">
          <KeyRound size={20} className="text-purple-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">License Management</h1>
          <p className="text-sm text-slate-400">Software license and activation status across all endpoints</p>
        </div>
      </div>

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <div className="text-xs text-slate-400 mb-1">Total Licenses</div>
            <div className="text-2xl font-bold text-white">{summary.total ?? 0}</div>
          </div>
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <div className="text-xs text-slate-400 mb-1">Activated</div>
            <div className="text-2xl font-bold text-green-400">{summary.by_status?.activated?.total ?? 0}</div>
          </div>
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <div className="text-xs text-slate-400 mb-1">Not Activated</div>
            <div className="text-2xl font-bold text-red-400">{summary.by_status?.not_activated?.total ?? 0}</div>
            <div className="text-xs text-slate-500 mt-1">Grace: {summary.by_status?.grace_period?.total ?? 0}</div>
          </div>
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <div className="text-xs text-slate-400 mb-1">Expiring Soon</div>
            <div className="text-2xl font-bold text-yellow-400">{summary.expiring_soon ?? 0}</div>
            <div className="text-xs text-slate-500 mt-1">Within 30 days</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center mb-4">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className="bg-slate-800 border border-slate-600 rounded-lg pl-8 pr-3 py-2 text-sm text-white w-56"
            placeholder="Search host / software..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value)}
          className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option value="">All statuses</option>
          <option value="activated">Activated</option>
          <option value="not_activated">Not Activated</option>
          <option value="grace_period">Grace Period</option>
          <option value="expired">Expired</option>
          <option value="unknown">Unknown</option>
        </select>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setGroupByAgent(true)}
            className={`px-3 py-2 rounded-l-lg text-sm border ${groupByAgent ? 'bg-blue-600 border-blue-600 text-white' : 'bg-slate-800 border-slate-600 text-slate-400'}`}
          >
            By Agent
          </button>
          <button
            onClick={() => setGroupByAgent(false)}
            className={`px-3 py-2 rounded-r-lg text-sm border-y border-r ${!groupByAgent ? 'bg-blue-600 border-blue-600 text-white' : 'bg-slate-800 border-slate-600 text-slate-400'}`}
          >
            All Licenses
          </button>
        </div>
        <button onClick={load} className="ml-auto flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-white">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {loading ? (
        <div className="bg-slate-800 rounded-xl border border-slate-700 p-8 text-center text-slate-400">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="bg-slate-800 rounded-xl border border-slate-700 p-12 text-center">
          <KeyRound size={48} className="text-slate-600 mx-auto mb-4" />
          <div className="text-slate-300 font-medium mb-2">No licenses found</div>
          <div className="text-slate-500 text-sm">License data is collected on each inventory cycle from online agents.</div>
        </div>
      ) : groupByAgent ? (
        // Agent-grouped view
        <div className="space-y-4">
          {Object.entries(byAgent).map(([agentId, agent]) => (
            <div key={agentId} className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
              <div className="px-4 py-3 bg-slate-900 flex items-center gap-3">
                <div>
                  <span className="font-medium text-white">{agent.hostname}</span>
                  <span className="text-slate-400 text-sm ml-2">{agent.ip}</span>
                </div>
                <span className={`ml-auto text-xs px-2 py-0.5 rounded-full border capitalize ${
                  agent.os === 'windows'
                    ? 'bg-blue-900/40 text-blue-300 border-blue-700'
                    : 'bg-orange-900/40 text-orange-300 border-orange-700'
                }`}>{agent.os}</span>
              </div>
              <table className="w-full text-sm">
                <thead className="text-slate-400 text-xs uppercase tracking-wider border-b border-slate-700">
                  <tr>
                    <th className="px-4 py-2 text-left">Software</th>
                    <th className="px-4 py-2 text-left">Type</th>
                    <th className="px-4 py-2 text-left">Channel</th>
                    <th className="px-4 py-2 text-left">Status</th>
                    <th className="px-4 py-2 text-left">Partial Key</th>
                    <th className="px-4 py-2 text-left">Expiry</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700">
                  {agent.licenses.map(l => (
                    <tr key={l.id} className={`hover:bg-slate-700/30 ${isExpiringSoon(l.expiry_date) ? 'bg-yellow-900/10' : ''} ${isExpired(l.expiry_date) ? 'bg-red-900/10' : ''}`}>
                      <td className="px-4 py-2.5 text-white font-medium">{l.software_name}</td>
                      <td className="px-4 py-2.5 text-slate-400 capitalize text-xs">{l.license_type || '—'}</td>
                      <td className="px-4 py-2.5 text-slate-400 text-xs">{l.license_channel || '—'}</td>
                      <td className="px-4 py-2.5"><StatusBadge status={l.activation_status} /></td>
                      <td className="px-4 py-2.5 font-mono text-xs text-slate-300">{l.partial_key ? `*****-${l.partial_key}` : '—'}</td>
                      <td className="px-4 py-2.5 text-xs">
                        {l.expiry_date ? (
                          <span className={isExpired(l.expiry_date) ? 'text-red-400' : isExpiringSoon(l.expiry_date) ? 'text-yellow-400' : 'text-slate-400'}>
                            {new Date(l.expiry_date).toLocaleDateString()}
                            {isExpiringSoon(l.expiry_date) && ' ⚠'}
                          </span>
                        ) : <span className="text-slate-500">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      ) : (
        // Flat table view
        <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-slate-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 text-left">Host</th>
                <th className="px-4 py-3 text-left">OS</th>
                <th className="px-4 py-3 text-left">Software</th>
                <th className="px-4 py-3 text-left">License Type</th>
                <th className="px-4 py-3 text-left">Channel</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Key (last 5)</th>
                <th className="px-4 py-3 text-left">Expiry</th>
                <th className="px-4 py-3 text-left">Last Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {filtered.map(l => (
                <tr key={l.id} className={`hover:bg-slate-700/50 ${isExpiringSoon(l.expiry_date) ? 'bg-yellow-900/10' : ''} ${isExpired(l.expiry_date) ? 'bg-red-900/10' : ''}`}>
                  <td className="px-4 py-3 text-white">
                    <div className="font-medium">{l.display_name || l.hostname}</div>
                    <div className="text-xs text-slate-400">{l.ip_address}</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400 capitalize">{l.os_type || '—'}</td>
                  <td className="px-4 py-3 text-white font-medium">{l.software_name}</td>
                  <td className="px-4 py-3 text-slate-400 capitalize text-xs">{l.license_type || '—'}</td>
                  <td className="px-4 py-3 text-slate-400 text-xs">{l.license_channel || '—'}</td>
                  <td className="px-4 py-3"><StatusBadge status={l.activation_status} /></td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-300">
                    {l.partial_key
                      ? <span title="Last 5 characters of license key">XXXXX-XXXXX-XXXXX-XXXXX-<span className="text-white font-bold">{l.partial_key}</span></span>
                      : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {l.expiry_date ? (
                      <span className={isExpired(l.expiry_date) ? 'text-red-400 font-medium' : isExpiringSoon(l.expiry_date) ? 'text-yellow-400 font-medium' : 'text-slate-400'}>
                        {new Date(l.expiry_date).toLocaleDateString()}
                        {isExpiringSoon(l.expiry_date) && !isExpired(l.expiry_date) && <span className="ml-1">⚠ Soon</span>}
                        {isExpired(l.expiry_date) && <span className="ml-1">✕ Expired</span>}
                      </span>
                    ) : <span className="text-slate-500">Perpetual</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {l.updated_at ? new Date(l.updated_at).toLocaleDateString() : '—'}
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
