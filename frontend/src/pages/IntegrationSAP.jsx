import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, RefreshCw, Database, Users, User, Briefcase,
  Lock, Unlock, CheckCircle, XCircle, AlertTriangle,
  Search, ChevronDown,
} from 'lucide-react'
import { integrationsApi } from '../api/client'

const LICENSE_COLORS = {
  professional: 'bg-purple-900/40 text-purple-300 border border-purple-700/50',
  financial: 'bg-blue-900/40 text-blue-300 border border-blue-700/50',
  logistics: 'bg-green-900/40 text-green-300 border border-green-700/50',
  unknown: 'bg-slate-700/60 text-slate-400 border border-slate-600/50',
}

const LICENSE_LABELS = {
  professional: 'Professional',
  financial: 'Financial',
  logistics: 'Logistics',
  unknown: 'Unknown',
}

function LicenseBadge({ type }) {
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${LICENSE_COLORS[type] || LICENSE_COLORS.unknown}`}>
      {LICENSE_LABELS[type] || type}
    </span>
  )
}

function StatCard({ icon: Icon, label, value, sub, color = 'text-slate-300' }) {
  return (
    <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-4">
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 bg-slate-700/50 rounded-lg">
          <Icon className={`w-4 h-4 ${color}`} />
        </div>
        <span className="text-slate-400 text-sm">{label}</span>
      </div>
      <p className={`text-2xl font-bold ${color}`}>{value ?? '—'}</p>
      {sub && <p className="text-slate-500 text-xs mt-1">{sub}</p>}
    </div>
  )
}

function LicenseBar({ label, count, total, color }) {
  const pct = total > 0 ? Math.round(count / total * 100) : 0
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-slate-300">{label}</span>
        <span className="text-slate-400">{count} <span className="text-slate-500">({pct}%)</span></span>
      </div>
      <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function LicenseDropdown({ value, onChange }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
    >
      <option value="professional">Professional</option>
      <option value="financial">Financial</option>
      <option value="logistics">Logistics</option>
      <option value="unknown">Unknown</option>
    </select>
  )
}

export default function IntegrationSAP() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [dashboard, setDashboard] = useState(null)
  const [users, setUsers] = useState([])
  const [employees, setEmployees] = useState([])
  const [tab, setTab] = useState('overview')
  const [search, setSearch] = useState('')
  const [licFilter, setLicFilter] = useState('')
  const [lockedFilter, setLockedFilter] = useState('')
  const [empSearch, setEmpSearch] = useState('')
  const [empActiveFilter, setEmpActiveFilter] = useState('')
  const [empSapFilter, setEmpSapFilter] = useState('')
  const [savingLicense, setSavingLicense] = useState({})
  const [error, setError] = useState(null)

  const loadDashboard = useCallback(async () => {
    try {
      const r = await integrationsApi.sap.dashboard()
      setDashboard(r.data)
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    }
  }, [])

  const loadUsers = useCallback(async () => {
    try {
      const params = {}
      if (search) params.search = search
      if (licFilter) params.license_type = licFilter
      if (lockedFilter) params.locked = lockedFilter
      const r = await integrationsApi.sap.users(params)
      setUsers(r.data)
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    }
  }, [search, licFilter, lockedFilter])

  const loadEmployees = useCallback(async () => {
    try {
      const params = {}
      if (empSearch) params.search = empSearch
      if (empActiveFilter) params.active = empActiveFilter
      if (empSapFilter) params.has_sap_access = empSapFilter
      const r = await integrationsApi.sap.employees(params)
      setEmployees(r.data)
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    }
  }, [empSearch, empActiveFilter, empSapFilter])

  useEffect(() => {
    setLoading(true)
    Promise.all([loadDashboard(), loadUsers(), loadEmployees()])
      .finally(() => setLoading(false))
  }, [loadDashboard, loadUsers, loadEmployees])

  const handleLicenseChange = async (internalKey, newType) => {
    setSavingLicense(p => ({ ...p, [internalKey]: true }))
    try {
      await integrationsApi.sap.updateLicense(internalKey, newType)
      setUsers(prev => prev.map(u =>
        u.internal_key === internalKey ? { ...u, license_type: newType } : u
      ))
    } catch (e) {
      alert('Failed to update license: ' + (e.response?.data?.detail || e.message))
    }
    setSavingLicense(p => ({ ...p, [internalKey]: false }))
  }

  const refresh = () => {
    setLoading(true)
    Promise.all([loadDashboard(), loadUsers(), loadEmployees()])
      .finally(() => setLoading(false))
  }

  const inactiveUsers = users.filter(u => {
    if (!u.last_logout_date) return false
    const days = Math.floor((Date.now() - new Date(u.last_logout_date)) / 86400000)
    return days > 90 && !u.locked && u.active
  })

  const lic = dashboard?.licenses || {}
  const totalLicensed = (lic.professional || 0) + (lic.financial || 0) + (lic.logistics || 0)

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/integrations')}
            className="p-2 hover:bg-slate-700 rounded-lg transition-colors text-slate-400 hover:text-slate-200">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="p-2 bg-amber-600/20 rounded-lg">
            <Database className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-100">SAP Business One</h1>
            <p className="text-slate-400 text-sm">
              {dashboard?.plugin?.last_sync_at
                ? `Last synced ${new Date(dashboard.plugin.last_sync_at).toLocaleString()}`
                : 'Not yet synced'}
            </p>
          </div>
        </div>
        <button onClick={refresh}
          className="flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg text-sm transition-colors">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Plugin status banner */}
      {dashboard?.plugin?.status === 'error' && dashboard.plugin.last_error && (
        <div className="bg-red-900/20 border border-red-700/50 rounded-xl p-3 flex items-center gap-2 text-red-300 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{dashboard.plugin.last_error}</span>
        </div>
      )}

      {/* Inactive users warning */}
      {inactiveUsers.length > 0 && (
        <div className="bg-amber-900/20 border border-amber-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            <span className="text-amber-300 font-medium text-sm">
              {inactiveUsers.length} user{inactiveUsers.length !== 1 ? 's' : ''} inactive for over 90 days (not locked)
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {inactiveUsers.slice(0, 8).map(u => (
              <span key={u.internal_key} className="px-2 py-1 bg-amber-900/30 border border-amber-700/40 rounded text-amber-200 text-xs">
                {u.user_code}
              </span>
            ))}
            {inactiveUsers.length > 8 && (
              <span className="text-amber-500 text-xs self-center">+{inactiveUsers.length - 8} more</span>
            )}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-slate-800/40 rounded-xl p-1 w-fit">
        {['overview', 'users', 'employees'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors capitalize ${
              tab === t
                ? 'bg-slate-700 text-slate-100'
                : 'text-slate-400 hover:text-slate-200'
            }`}>
            {t}
          </button>
        ))}
      </div>

      {/* ── Overview ── */}
      {tab === 'overview' && (
        <div className="space-y-6">
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <StatCard icon={Users} label="SAP Users" value={dashboard?.users?.total} color="text-amber-400" />
            <StatCard icon={CheckCircle} label="Active" value={dashboard?.users?.active} color="text-green-400" />
            <StatCard icon={Lock} label="Locked" value={dashboard?.users?.locked} color="text-red-400" />
            <StatCard icon={AlertTriangle} label="Inactive 90d" value={dashboard?.users?.inactive_90d} color="text-amber-400" />
            <StatCard icon={Briefcase} label="Employees" value={dashboard?.employees?.total} color="text-blue-400" />
            <StatCard icon={User} label="With SAP Access" value={dashboard?.employees?.with_sap_access} color="text-purple-400" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* License breakdown */}
            <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-5">
              <h3 className="text-slate-200 font-semibold mb-4">License Distribution</h3>
              <div className="space-y-4">
                <LicenseBar label="Professional" count={lic.professional || 0} total={totalLicensed} color="bg-purple-500" />
                <LicenseBar label="Financial" count={lic.financial || 0} total={totalLicensed} color="bg-blue-500" />
                <LicenseBar label="Logistics" count={lic.logistics || 0} total={totalLicensed} color="bg-green-500" />
                {lic.unknown > 0 && (
                  <LicenseBar label="Unknown" count={lic.unknown} total={totalLicensed + lic.unknown} color="bg-slate-500" />
                )}
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3 pt-4 border-t border-slate-700/50">
                {[
                  { label: 'Professional', val: lic.professional || 0, cls: 'text-purple-400' },
                  { label: 'Financial', val: lic.financial || 0, cls: 'text-blue-400' },
                  { label: 'Logistics', val: lic.logistics || 0, cls: 'text-green-400' },
                ].map(({ label, val, cls }) => (
                  <div key={label} className="text-center">
                    <p className={`text-xl font-bold ${cls}`}>{val}</p>
                    <p className="text-slate-500 text-xs">{label}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Department breakdown */}
            <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-5">
              <h3 className="text-slate-200 font-semibold mb-4">Users by Department</h3>
              {(dashboard?.departments || []).length === 0 ? (
                <p className="text-slate-500 text-sm">No data available</p>
              ) : (
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {(dashboard?.departments || []).map(d => (
                    <div key={d.name} className="flex items-center gap-3">
                      <span className="text-slate-300 text-sm flex-1 truncate">{d.name}</span>
                      <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-amber-500 rounded-full"
                          style={{ width: `${Math.min(100, d.count / (dashboard?.users?.total || 1) * 100 * 3)}%` }}
                        />
                      </div>
                      <span className="text-slate-400 text-xs w-6 text-right">{d.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Employee access summary */}
          <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-5">
            <h3 className="text-slate-200 font-semibold mb-4">Employee Access Overview</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: 'Total Employees', val: dashboard?.employees?.total, cls: 'text-slate-200' },
                { label: 'Active', val: dashboard?.employees?.active, cls: 'text-green-400' },
                { label: 'With SAP Access', val: dashboard?.employees?.with_sap_access, cls: 'text-amber-400' },
                { label: 'No SAP Access', val: dashboard?.employees?.no_sap_access, cls: 'text-slate-400' },
              ].map(({ label, val, cls }) => (
                <div key={label} className="bg-slate-700/40 rounded-lg p-3 text-center">
                  <p className={`text-2xl font-bold ${cls}`}>{val ?? '—'}</p>
                  <p className="text-slate-500 text-xs mt-1">{label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Users Tab ── */}
      {tab === 'users' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="flex flex-wrap gap-3">
            <div className="relative flex-1 min-w-48">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search users..."
                className="w-full bg-slate-700/50 border border-slate-600/50 rounded-lg pl-9 pr-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <select
              value={licFilter}
              onChange={e => setLicFilter(e.target.value)}
              className="bg-slate-700/50 border border-slate-600/50 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">All License Types</option>
              <option value="professional">Professional</option>
              <option value="financial">Financial</option>
              <option value="logistics">Logistics</option>
              <option value="unknown">Unknown</option>
            </select>
            <select
              value={lockedFilter}
              onChange={e => setLockedFilter(e.target.value)}
              className="bg-slate-700/50 border border-slate-600/50 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">All Status</option>
              <option value="false">Active</option>
              <option value="true">Locked</option>
            </select>
          </div>

          <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-700/40 border-b border-slate-700/50">
                  <tr>
                    {['User Code', 'Name', 'Department', 'Job Title', 'License', 'Last Activity', 'Status'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-slate-400 font-medium text-xs uppercase tracking-wide">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/30">
                  {users.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                        {loading ? 'Loading…' : 'No users found'}
                      </td>
                    </tr>
                  ) : users.map(u => {
                    const lastDate = u.last_logout_date ? new Date(u.last_logout_date) : null
                    const daysSince = lastDate
                      ? Math.floor((Date.now() - lastDate) / 86400000)
                      : null
                    const isInactive = daysSince !== null && daysSince > 90
                    return (
                      <tr key={u.internal_key}
                        className={`hover:bg-slate-700/30 transition-colors ${u.locked ? 'opacity-60' : ''}`}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {u.superuser && (
                              <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" title="Superuser" />
                            )}
                            <span className="text-slate-200 font-mono text-xs">{u.user_code}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-300">
                          {u.employee_first_name
                            ? `${u.employee_first_name} ${u.employee_last_name}`
                            : u.user_name}
                        </td>
                        <td className="px-4 py-3 text-slate-400 text-xs">{u.department_name || '—'}</td>
                        <td className="px-4 py-3 text-slate-400 text-xs">{u.job_title || '—'}</td>
                        <td className="px-4 py-3">
                          <LicenseDropdown
                            value={u.license_type || 'unknown'}
                            onChange={v => handleLicenseChange(u.internal_key, v)}
                          />
                          {savingLicense[u.internal_key] && (
                            <span className="ml-1 text-slate-500 text-xs">saving…</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {lastDate ? (
                            <span className={`text-xs ${isInactive ? 'text-amber-400' : 'text-slate-400'}`}>
                              {daysSince === 0 ? 'Today' : `${daysSince}d ago`}
                              {isInactive && ' ⚠'}
                            </span>
                          ) : (
                            <span className="text-slate-600 text-xs">Never</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {u.locked ? (
                            <span className="flex items-center gap-1 text-red-400 text-xs">
                              <Lock className="w-3 h-3" /> Locked
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-green-400 text-xs">
                              <CheckCircle className="w-3 h-3" /> Active
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2 border-t border-slate-700/50 text-slate-500 text-xs">
              {users.length} user{users.length !== 1 ? 's' : ''} shown
            </div>
          </div>
        </div>
      )}

      {/* ── Employees Tab ── */}
      {tab === 'employees' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="flex flex-wrap gap-3">
            <div className="relative flex-1 min-w-48">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={empSearch}
                onChange={e => setEmpSearch(e.target.value)}
                placeholder="Search employees..."
                className="w-full bg-slate-700/50 border border-slate-600/50 rounded-lg pl-9 pr-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <select
              value={empActiveFilter}
              onChange={e => setEmpActiveFilter(e.target.value)}
              className="bg-slate-700/50 border border-slate-600/50 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">All Employees</option>
              <option value="true">Active Only</option>
              <option value="false">Terminated</option>
            </select>
            <select
              value={empSapFilter}
              onChange={e => setEmpSapFilter(e.target.value)}
              className="bg-slate-700/50 border border-slate-600/50 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">All Access</option>
              <option value="true">Has SAP Access</option>
              <option value="false">No SAP Access</option>
            </select>
          </div>

          <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-700/40 border-b border-slate-700/50">
                  <tr>
                    {['Name', 'Department', 'Job Title', 'Contact', 'SAP Access', 'Status'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-slate-400 font-medium text-xs uppercase tracking-wide">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/30">
                  {employees.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                        {loading ? 'Loading…' : 'No employees found'}
                      </td>
                    </tr>
                  ) : employees.map(e => (
                    <tr key={e.employee_id}
                      className={`hover:bg-slate-700/30 transition-colors ${!e.active ? 'opacity-50' : ''}`}>
                      <td className="px-4 py-3">
                        <p className="text-slate-200">{e.first_name} {e.last_name}</p>
                        {e.email && <p className="text-slate-500 text-xs">{e.email}</p>}
                      </td>
                      <td className="px-4 py-3 text-slate-400 text-xs">{e.department_name || '—'}</td>
                      <td className="px-4 py-3 text-slate-400 text-xs">{e.job_title || '—'}</td>
                      <td className="px-4 py-3">
                        <div className="space-y-0.5">
                          {e.mobile_phone && <p className="text-slate-400 text-xs">{e.mobile_phone}</p>}
                          {e.office_phone && <p className="text-slate-500 text-xs">{e.office_phone}</p>}
                          {!e.mobile_phone && !e.office_phone && <span className="text-slate-600 text-xs">—</span>}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {e.has_sap_access ? (
                          <div>
                            <span className="flex items-center gap-1 text-amber-400 text-xs">
                              <CheckCircle className="w-3 h-3" /> {e.sap_user_code}
                            </span>
                          </div>
                        ) : (
                          <span className="text-slate-500 text-xs">No access</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {e.active ? (
                          <span className="flex items-center gap-1 text-green-400 text-xs">
                            <CheckCircle className="w-3 h-3" /> Active
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-red-400 text-xs">
                            <XCircle className="w-3 h-3" /> Terminated
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2 border-t border-slate-700/50 text-slate-500 text-xs">
              {employees.length} employee{employees.length !== 1 ? 's' : ''} shown
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
