import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Cloud, ArrowLeft, RefreshCw, AlertTriangle, Clock, CheckCircle, XCircle, Users } from 'lucide-react'
import { integrationsApi } from '../api/client'

function LicenseBar({ sku }) {
  const pct = sku.usage_pct || 0
  const barColor = pct > 95 ? 'bg-red-500' : pct > 80 ? 'bg-yellow-500' : 'bg-indigo-500'
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="text-white truncate max-w-xs">{sku.sku_name}</span>
        <div className="flex items-center gap-3 text-xs text-slate-400 ml-4 flex-shrink-0">
          <span className={pct > 95 ? 'text-red-400 font-medium' : ''}>{sku.consumed_units} / {sku.total_units}</span>
          <span className={`font-bold ${pct > 95 ? 'text-red-400' : pct > 80 ? 'text-yellow-400' : 'text-slate-300'}`}>{pct.toFixed(0)}%</span>
        </div>
      </div>
      <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full ${barColor} rounded-full`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      {sku.unused > 0 && (
        <div className="text-xs text-slate-500">{sku.unused} unused license{sku.unused > 1 ? 's' : ''}</div>
      )}
    </div>
  )
}

export default function IntegrationO365() {
  const navigate = useNavigate()
  const [dash, setDash] = useState(null)
  const [users, setUsers] = useState([])
  const [licenses, setLicenses] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [search, setSearch] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [showDisabled, setShowDisabled] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [d, u, l] = await Promise.all([
        integrationsApi.o365.dashboard(),
        integrationsApi.o365.users(),
        integrationsApi.o365.licenses(),
      ])
      setDash(d.data)
      setUsers(u.data)
      setLicenses(l.data)
    } catch (e) { console.error(e) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const handleSync = async () => {
    setSyncing(true)
    try {
      await integrationsApi.sync('o365')
      setTimeout(load, 3000)
    } catch (e) { alert('Sync failed: ' + (e.response?.data?.detail || e.message)) }
    setSyncing(false)
  }

  const daysSince = (dateStr) => {
    if (!dateStr) return null
    return Math.floor((new Date() - new Date(dateStr)) / (1000 * 60 * 60 * 24))
  }

  const filteredUsers = users.filter(u => {
    if (!showDisabled && !u.account_enabled) return false
    if (showInactive) {
      const ds = daysSince(u.last_sign_in)
      if (ds !== null && ds < 30) return false
      if (ds === null && !u.account_enabled) return false
    }
    if (search && !u.display_name?.toLowerCase().includes(search.toLowerCase()) &&
        !u.email?.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate('/integrations')} className="text-slate-400 hover:text-white">
          <ArrowLeft size={20} />
        </button>
        <div className="w-10 h-10 rounded-xl bg-indigo-600/20 flex items-center justify-center">
          <Cloud size={20} className="text-indigo-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Office 365</h1>
          <p className="text-sm text-slate-400">Microsoft 365 users, sign-in activity, and license utilization</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {dash?.plugin?.last_sync_at && (
            <span className="text-xs text-slate-500 flex items-center gap-1">
              <Clock size={11} />{new Date(dash.plugin.last_sync_at).toLocaleString()}
            </span>
          )}
          <button onClick={handleSync} disabled={syncing}
            className="flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-white disabled:opacity-50">
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>
        </div>
      </div>

      {dash?.plugin?.status !== 'connected' && !loading && (
        <div className="bg-yellow-900/30 border border-yellow-700 rounded-xl p-4 mb-6 flex items-center gap-3">
          <AlertTriangle size={18} className="text-yellow-400" />
          <div>
            <div className="text-yellow-300 font-medium">Not connected</div>
            <div className="text-yellow-400 text-sm">Configure the Office 365 integration from the Integrations hub.</div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center text-slate-400 py-16">Loading Office 365 data...</div>
      ) : (
        <div className="space-y-6">
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {[
              { label: 'Total Users', value: dash?.users?.total ?? 0, color: 'text-white' },
              { label: 'Active', value: dash?.users?.active ?? 0, color: 'text-green-400' },
              { label: 'Disabled', value: dash?.users?.disabled ?? 0, color: 'text-slate-400' },
              { label: 'Inactive 30d', value: dash?.users?.inactive_30d ?? 0, color: 'text-yellow-400' },
              { label: 'Total Licenses', value: dash?.licenses?.total ?? 0, color: 'text-white',
                sub: `${dash?.licenses?.unused ?? 0} unused` },
            ].map((c, i) => (
              <div key={i} className="bg-slate-800 border border-slate-700 rounded-xl p-4">
                <div className="text-xs text-slate-400 mb-1">{c.label}</div>
                <div className={`text-2xl font-bold ${c.color}`}>{c.value}</div>
                {c.sub && <div className="text-xs text-slate-500 mt-1">{c.sub}</div>}
              </div>
            ))}
          </div>

          {/* License utilization */}
          {licenses.length > 0 && (
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <Users size={15} className="text-indigo-400" />
                <h2 className="text-sm font-semibold text-white">License Utilization</h2>
              </div>
              <div className="space-y-4">
                {licenses.map((lic, i) => <LicenseBar key={i} sku={lic} />)}
              </div>
            </div>
          )}

          {/* Users table */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
            <div className="px-5 py-3 bg-slate-900 flex flex-wrap items-center gap-3">
              <Users size={15} className="text-slate-400" />
              <h2 className="text-sm font-semibold text-white">Users ({filteredUsers.length})</h2>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
                  <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
                  Inactive only (30d)
                </label>
                <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
                  <input type="checkbox" checked={showDisabled} onChange={e => setShowDisabled(e.target.checked)} />
                  Show disabled
                </label>
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search name / email..."
                  className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-1 text-xs text-white w-44" />
              </div>
            </div>
            {filteredUsers.length === 0 ? (
              <div className="p-8 text-center text-slate-400 text-sm">No users found.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-slate-400 text-xs uppercase tracking-wider border-b border-slate-700">
                    <tr>
                      <th className="px-4 py-2 text-left">Name</th>
                      <th className="px-4 py-2 text-left">Email</th>
                      <th className="px-4 py-2 text-left">Status</th>
                      <th className="px-4 py-2 text-left">Last Sign-in</th>
                      <th className="px-4 py-2 text-left">Licenses</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700">
                    {filteredUsers.slice(0, 200).map((u, i) => {
                      const ds = daysSince(u.last_sign_in)
                      const inactive = ds === null || ds > 30
                      return (
                        <tr key={i} className={`hover:bg-slate-700/30 ${!u.account_enabled ? 'opacity-50' : ''}`}>
                          <td className="px-4 py-2.5 text-white font-medium">{u.display_name}</td>
                          <td className="px-4 py-2.5 text-slate-400 text-xs">{u.email || '—'}</td>
                          <td className="px-4 py-2.5">
                            {u.account_enabled
                              ? <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-green-900/40 text-green-300 border-green-700">Active</span>
                              : <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-slate-800 text-slate-400 border-slate-600">Disabled</span>}
                          </td>
                          <td className="px-4 py-2.5 text-xs">
                            {u.last_sign_in
                              ? <span className={inactive && u.account_enabled ? 'text-yellow-400' : 'text-slate-400'}>
                                  {new Date(u.last_sign_in).toLocaleDateString()}
                                  {inactive && u.account_enabled && <span className="ml-1 text-yellow-500">({ds}d ago)</span>}
                                </span>
                              : <span className="text-slate-600">Never</span>}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-slate-500">
                            {(u.assigned_licenses || []).length > 0 ? `${u.assigned_licenses.length} license${u.assigned_licenses.length > 1 ? 's' : ''}` : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
