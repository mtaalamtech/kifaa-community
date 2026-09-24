import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Server, ArrowLeft, RefreshCw, CheckCircle, XCircle,
  AlertTriangle, Clock, HardDrive, Shield, Database,
  ChevronDown, ChevronUp
} from 'lucide-react'
import { integrationsApi } from '../api/client'

function bytes(b) {
  if (!b) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = b, i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(1)} ${units[i]}`
}

function duration(secs) {
  if (!secs) return '—'
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
}

function BackupStatusBadge({ status }) {
  const map = {
    success: 'bg-green-900/40 text-green-300 border-green-700',
    failure: 'bg-red-900/40 text-red-300 border-red-700',
    warning: 'bg-yellow-900/40 text-yellow-300 border-yellow-700',
    active: 'bg-blue-900/40 text-blue-300 border-blue-700',
  }
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border capitalize ${map[status] || 'bg-slate-800 text-slate-400 border-slate-600'}`}>
      {status || 'unknown'}
    </span>
  )
}

function SeverityBadge({ severity }) {
  const map = {
    critical: 'bg-red-900/40 text-red-300 border-red-700',
    warning: 'bg-yellow-900/40 text-yellow-300 border-yellow-700',
    info: 'bg-blue-900/40 text-blue-300 border-blue-700',
  }
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border capitalize ${map[severity] || 'bg-slate-800 text-slate-400 border-slate-600'}`}>
      {severity || 'info'}
    </span>
  )
}

function StorageBar({ device }) {
  const pct = device.usage_pct || 0
  const barColor = pct > 90 ? 'bg-red-500' : pct > 75 ? 'bg-yellow-500' : 'bg-blue-500'
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="text-white font-medium">{device.device_name || 'Storage'}</span>
        <span className={`text-xs font-bold ${pct > 90 ? 'text-red-400' : pct > 75 ? 'text-yellow-400' : 'text-slate-300'}`}>
          {pct.toFixed(1)}%
        </span>
      </div>
      <div className="h-3 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full ${barColor} rounded-full transition-all`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>{bytes(device.used_bytes)} used</span>
        <span>{bytes(device.free_bytes)} free</span>
        <span>{bytes(device.total_bytes)} total</span>
      </div>
    </div>
  )
}

export default function IntegrationUnitrends() {
  const navigate = useNavigate()
  const [dash, setDash] = useState(null)
  const [backups, setBackups] = useState([])
  const [clients, setClients] = useState([])
  const [alerts, setAlerts] = useState([])
  const [storage, setStorage] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [backupFilter, setBackupFilter] = useState('')
  const [clientFilter, setClientFilter] = useState('')
  const [showAllAlerts, setShowAllAlerts] = useState(false)
  const [backupDays, setBackupDays] = useState(7)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [d, b, c, a, s] = await Promise.all([
        integrationsApi.unitrends.dashboard(),
        integrationsApi.unitrends.backups({ days: backupDays }),
        integrationsApi.unitrends.clients(),
        integrationsApi.unitrends.alerts(),
        integrationsApi.unitrends.storage(),
      ])
      setDash(d.data)
      setBackups(b.data)
      setClients(c.data)
      setAlerts(a.data)
      setStorage(s.data)
    } catch (e) {
      console.error('Unitrends load error:', e)
    }
    setLoading(false)
  }, [backupDays])

  useEffect(() => { load() }, [load])

  const handleSync = async () => {
    setSyncing(true)
    try {
      await integrationsApi.sync('unitrends')
      setTimeout(load, 3000) // reload after 3s to show updated data
    } catch (e) {
      alert('Sync failed: ' + (e.response?.data?.detail || e.message))
    }
    setSyncing(false)
  }

  const filteredBackups = backups.filter(b =>
    (!backupFilter || b.client_name?.toLowerCase().includes(backupFilter.toLowerCase()) ||
     b.instance_name?.toLowerCase().includes(backupFilter.toLowerCase()))
  )

  const filteredClients = clients.filter(c =>
    (!clientFilter || c.client_name?.toLowerCase().includes(clientFilter.toLowerCase()) ||
     c.ip_address?.includes(clientFilter))
  )

  const successRate = dash?.success_rate_7d ?? 0
  const successRateColor = successRate >= 95 ? 'text-green-400' : successRate >= 80 ? 'text-yellow-400' : 'text-red-400'

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate('/integrations')} className="text-slate-400 hover:text-white">
          <ArrowLeft size={20} />
        </button>
        <div className="w-10 h-10 rounded-xl bg-blue-600/20 flex items-center justify-center">
          <Server size={20} className="text-blue-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Kaseya Unitrends</h1>
          <p className="text-sm text-slate-400">Backup & disaster recovery dashboard</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {dash?.plugin?.last_sync_at && (
            <span className="text-xs text-slate-500 flex items-center gap-1">
              <Clock size={11} />
              {new Date(dash.plugin.last_sync_at).toLocaleString()}
            </span>
          )}
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-white disabled:opacity-50"
          >
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>
        </div>
      </div>

      {/* Not connected banner */}
      {dash?.plugin?.status !== 'connected' && !loading && (
        <div className="bg-yellow-900/30 border border-yellow-700 rounded-xl p-4 mb-6 flex items-center gap-3">
          <AlertTriangle size={18} className="text-yellow-400" />
          <div>
            <div className="text-yellow-300 font-medium">Not connected</div>
            <div className="text-yellow-400 text-sm">Configure and test the Unitrends integration from the Integrations hub.</div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center text-slate-400 py-16">Loading Unitrends data...</div>
      ) : (
        <div className="space-y-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
              <div className="text-xs text-slate-400 mb-1">Backups (24h)</div>
              <div className="text-2xl font-bold text-white">{dash?.backups_24h?.total ?? 0}</div>
              <div className="text-xs text-slate-500 mt-1">
                <span className="text-green-400">{dash?.backups_24h?.success ?? 0} ok</span>
                {' · '}
                <span className="text-red-400">{dash?.backups_24h?.failed ?? 0} failed</span>
              </div>
            </div>
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
              <div className="text-xs text-slate-400 mb-1">Success Rate (7d)</div>
              <div className={`text-2xl font-bold ${successRateColor}`}>{successRate}%</div>
              <div className="text-xs text-slate-500 mt-1">7-day rolling average</div>
            </div>
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
              <div className="text-xs text-slate-400 mb-1">Active Alerts</div>
              <div className={`text-2xl font-bold ${(dash?.alerts?.total ?? 0) > 0 ? 'text-red-400' : 'text-green-400'}`}>
                {dash?.alerts?.total ?? 0}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                {dash?.alerts?.critical ?? 0} critical
              </div>
            </div>
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
              <div className="text-xs text-slate-400 mb-1">Protected Clients</div>
              <div className="text-2xl font-bold text-white">{dash?.clients?.total ?? 0}</div>
              <div className="text-xs text-slate-500 mt-1">
                <span className="text-green-400">{dash?.clients?.online ?? 0} online</span>
              </div>
            </div>
          </div>

          {/* Storage */}
          {storage.length > 0 && (
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <HardDrive size={16} className="text-slate-400" />
                <h2 className="text-sm font-semibold text-white">Storage Usage</h2>
              </div>
              <div className="space-y-4">
                {storage.map((dev, i) => <StorageBar key={i} device={dev} />)}
              </div>
            </div>
          )}

          {/* Alerts */}
          {alerts.length > 0 && (
            <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
              <div className="px-5 py-3 bg-slate-900 flex items-center gap-2">
                <AlertTriangle size={15} className="text-red-400" />
                <h2 className="text-sm font-semibold text-white">Active Alerts ({alerts.length})</h2>
                <button onClick={() => setShowAllAlerts(!showAllAlerts)} className="ml-auto text-slate-400 hover:text-white text-xs flex items-center gap-1">
                  {showAllAlerts ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  {showAllAlerts ? 'Show less' : 'Show all'}
                </button>
              </div>
              <div className="divide-y divide-slate-700">
                {(showAllAlerts ? alerts : alerts.slice(0, 5)).map((a, i) => (
                  <div key={i} className="px-5 py-3 flex items-start gap-3">
                    <SeverityBadge severity={a.severity} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-white">{a.message}</div>
                      {a.alert_time && (
                        <div className="text-xs text-slate-500 mt-0.5">{new Date(a.alert_time).toLocaleString()}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent Backups */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
            <div className="px-5 py-3 bg-slate-900 flex items-center gap-3">
              <Shield size={15} className="text-blue-400" />
              <h2 className="text-sm font-semibold text-white">Recent Backups</h2>
              <div className="ml-auto flex items-center gap-2">
                <select
                  value={backupDays}
                  onChange={e => setBackupDays(Number(e.target.value))}
                  className="bg-slate-800 border border-slate-600 rounded-lg px-2 py-1 text-xs text-white"
                >
                  <option value={1}>Last 24h</option>
                  <option value={7}>Last 7 days</option>
                  <option value={14}>Last 14 days</option>
                  <option value={30}>Last 30 days</option>
                </select>
                <input
                  value={backupFilter}
                  onChange={e => setBackupFilter(e.target.value)}
                  placeholder="Filter by client..."
                  className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-1 text-xs text-white w-40"
                />
              </div>
            </div>
            {filteredBackups.length === 0 ? (
              <div className="p-8 text-center text-slate-400 text-sm">No backups found for this period.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-slate-400 text-xs uppercase tracking-wider border-b border-slate-700">
                    <tr>
                      <th className="px-4 py-2 text-left">Client</th>
                      <th className="px-4 py-2 text-left">Instance</th>
                      <th className="px-4 py-2 text-left">Type</th>
                      <th className="px-4 py-2 text-left">Status</th>
                      <th className="px-4 py-2 text-left">Started</th>
                      <th className="px-4 py-2 text-left">Duration</th>
                      <th className="px-4 py-2 text-left">Size</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700">
                    {filteredBackups.slice(0, 100).map((b, i) => (
                      <tr key={i} className="hover:bg-slate-700/30">
                        <td className="px-4 py-2.5 text-white font-medium">{b.client_name || '—'}</td>
                        <td className="px-4 py-2.5 text-slate-400 text-xs">{b.instance_name || '—'}</td>
                        <td className="px-4 py-2.5 text-slate-400 text-xs capitalize">{b.backup_type || '—'}</td>
                        <td className="px-4 py-2.5"><BackupStatusBadge status={b.status} /></td>
                        <td className="px-4 py-2.5 text-xs text-slate-400">
                          {b.start_time ? new Date(b.start_time).toLocaleString() : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-slate-400">{duration(b.duration_seconds)}</td>
                        <td className="px-4 py-2.5 text-xs text-slate-400">{bytes(b.size_bytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Protected Clients */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
            <div className="px-5 py-3 bg-slate-900 flex items-center gap-3">
              <Database size={15} className="text-slate-400" />
              <h2 className="text-sm font-semibold text-white">Protected Clients ({clients.length})</h2>
              <input
                value={clientFilter}
                onChange={e => setClientFilter(e.target.value)}
                placeholder="Filter..."
                className="ml-auto bg-slate-800 border border-slate-600 rounded-lg px-3 py-1 text-xs text-white w-40"
              />
            </div>
            {filteredClients.length === 0 ? (
              <div className="p-8 text-center text-slate-400 text-sm">No clients found.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-slate-400 text-xs uppercase tracking-wider border-b border-slate-700">
                  <tr>
                    <th className="px-4 py-2 text-left">Name</th>
                    <th className="px-4 py-2 text-left">OS</th>
                    <th className="px-4 py-2 text-left">IP</th>
                    <th className="px-4 py-2 text-left">Status</th>
                    <th className="px-4 py-2 text-left">Last Backup</th>
                    <th className="px-4 py-2 text-left">Total Backups</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700">
                  {filteredClients.map((c, i) => (
                    <tr key={i} className="hover:bg-slate-700/30">
                      <td className="px-4 py-2.5 text-white font-medium">{c.client_name}</td>
                      <td className="px-4 py-2.5 text-slate-400 text-xs capitalize">{c.os || '—'}</td>
                      <td className="px-4 py-2.5 text-slate-400 text-xs font-mono">{c.ip_address || '—'}</td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full border capitalize ${
                          c.status === 'online'
                            ? 'bg-green-900/40 text-green-300 border-green-700'
                            : 'bg-slate-800 text-slate-400 border-slate-600'
                        }`}>{c.status || 'unknown'}</span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-slate-400">
                        {c.last_backup ? new Date(c.last_backup).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-slate-400">{c.total_backups ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
