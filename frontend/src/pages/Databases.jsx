import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Database, Plus, RefreshCw, CheckCircle, XCircle,
  AlertCircle, Clock, Activity, Server, Search, ChevronRight
} from 'lucide-react'
import api from '../api/client'

const DB_SUBTYPES = new Set([
  'mysql', 'postgresql', 'redis', 'mongodb', 'mssql', 'oracle', 'db2',
  'cassandra', 'memcached', 'hbase', 'sap_hana', 'sybase', 'informix',
  'mariadb', 'sqlite',
  'pg_plugin', 'mysql_plugin', 'mssql_plugin', 'mongodb_plugin',
  'redis_plugin', 'elasticsearch_plugin', 'opensearch_plugin',
  'couchdb_plugin', 'influxdb_plugin', 'couchbase_plugin',
  'cassandra_plugin', 'memcached_plugin', 'oracle_plugin',
  'sap_hana_plugin', 'mariadb_plugin',
])

const DB_LABELS = {
  mysql: 'MySQL', postgresql: 'PostgreSQL', redis: 'Redis',
  mongodb: 'MongoDB', mssql: 'MS SQL Server', oracle: 'Oracle',
  db2: 'IBM DB2', cassandra: 'Cassandra', memcached: 'Memcached',
  hbase: 'HBase', sap_hana: 'SAP HANA', sybase: 'Sybase / ASE',
  informix: 'IBM Informix', mariadb: 'MariaDB',
  pg_plugin: 'PostgreSQL (Plugin)', mysql_plugin: 'MySQL (Plugin)',
  mssql_plugin: 'MS SQL (Plugin)', mongodb_plugin: 'MongoDB (Plugin)',
  redis_plugin: 'Redis (Plugin)', elasticsearch_plugin: 'Elasticsearch',
  opensearch_plugin: 'OpenSearch', sap_hana_plugin: 'SAP HANA (Plugin)',
  mariadb_plugin: 'MariaDB (Plugin)',
}

const STATUS_COLORS = {
  up:      { bg: 'bg-emerald-900/30', border: 'border-emerald-700/40', dot: 'bg-emerald-400', text: 'text-emerald-400' },
  down:    { bg: 'bg-red-900/30',     border: 'border-red-700/40',     dot: 'bg-red-400',     text: 'text-red-400' },
  timeout: { bg: 'bg-orange-900/30',  border: 'border-orange-700/40',  dot: 'bg-orange-400',  text: 'text-orange-400' },
  unknown: { bg: 'bg-slate-800/50',   border: 'border-slate-700',      dot: 'bg-slate-500',   text: 'text-slate-400' },
}

function StatusIcon({ status, size = 14 }) {
  if (status === 'up')      return <CheckCircle size={size} className="text-emerald-400" />
  if (status === 'down')    return <XCircle size={size} className="text-red-400" />
  if (status === 'timeout') return <AlertCircle size={size} className="text-orange-400" />
  return <Clock size={size} className="text-slate-500" />
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString()
}

function fmtLatency(ms) {
  if (ms == null || ms === 0) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export default function Databases() {
  const [monitors, setMonitors] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const navigate = useNavigate()

  const load = useCallback(() => {
    setLoading(true)
    // Fetch both Databases and Database Plugins categories
    Promise.all([
      api.get('/monitoring/monitors', { params: { category: 'Databases', limit: 500 } }),
      api.get('/monitoring/monitors', { params: { category: 'Database Plugins', limit: 500 } }),
    ]).then(([r1, r2]) => {
      const all = [...(r1.data.monitors || r1.data || []), ...(r2.data.monitors || r2.data || [])]
      // Also include any tcp/db_plugin monitors not in those categories
      const seen = new Set(all.map(m => m.id))
      setMonitors(all.filter(m => DB_SUBTYPES.has(m.subtype) || !seen.has(m.id) ? DB_SUBTYPES.has(m.subtype) : false))
    }).catch(() => {
      // fallback: fetch all and filter
      api.get('/monitoring/monitors', { params: { limit: 500 } }).then(r => {
        const all = r.data.monitors || r.data || []
        setMonitors(all.filter(m => DB_SUBTYPES.has(m.subtype)))
      })
    }).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [load])

  const filtered = monitors.filter(m => {
    if (filterStatus && m.last_status !== filterStatus) return false
    if (search) {
      const q = search.toLowerCase()
      return m.name?.toLowerCase().includes(q) || m.host?.toLowerCase().includes(q) ||
             m.subtype?.toLowerCase().includes(q)
    }
    return true
  })

  const stats = {
    total: monitors.length,
    up: monitors.filter(m => m.last_status === 'up').length,
    down: monitors.filter(m => m.last_status === 'down').length,
    unknown: monitors.filter(m => !m.last_status || m.last_status === 'unknown').length,
  }

  // Group by subtype
  const groups = {}
  filtered.forEach(m => {
    const key = m.subtype || 'other'
    if (!groups[key]) groups[key] = []
    groups[key].push(m)
  })

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Database size={24} className="text-blue-400" /> Database Monitoring
          </h1>
          <p className="text-slate-400 text-sm mt-1">Health, latency and uptime for all monitored databases</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={load} className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 px-3 py-2 rounded-lg text-sm">
            <RefreshCw size={14} /> Refresh
          </button>
          <button onClick={() => navigate('/monitoring')} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium">
            <Plus size={14} /> Add Database
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Total', value: stats.total, color: 'text-white', bg: 'bg-slate-800' },
          { label: 'Online', value: stats.up, color: 'text-emerald-400', bg: 'bg-emerald-900/20' },
          { label: 'Offline', value: stats.down, color: 'text-red-400', bg: 'bg-red-900/20' },
          { label: 'Unknown', value: stats.unknown, color: 'text-slate-400', bg: 'bg-slate-800' },
        ].map(s => (
          <div key={s.label} className={`${s.bg} border border-slate-700 rounded-xl p-4`}>
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            <div className="text-sm text-slate-400 mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search databases…"
            className="bg-slate-700 border border-slate-600 rounded-lg pl-9 pr-3 py-2 text-sm text-white w-56" />
        </div>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
          className="bg-slate-700 border border-slate-600 text-white text-sm rounded-lg px-3 py-2">
          <option value="">All statuses</option>
          <option value="up">Online</option>
          <option value="down">Offline</option>
          <option value="timeout">Timeout</option>
          <option value="unknown">Unknown</option>
        </select>
        <span className="text-sm text-slate-500 ml-auto">{filtered.length} database{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {loading ? (
        <div className="py-24 text-center text-slate-500">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="py-24 text-center">
          <Database size={40} className="mx-auto text-slate-600 mb-4" />
          <p className="text-slate-400 mb-2">No database monitors found</p>
          <p className="text-sm text-slate-500 mb-4">Add a monitor for MySQL, PostgreSQL, SAP HANA, MSSQL, or any other database.</p>
          <button onClick={() => navigate('/monitoring')} className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium">
            Add First Database Monitor
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([subtype, items]) => (
            <div key={subtype}>
              <h3 className="text-sm font-semibold text-slate-300 mb-3 flex items-center gap-2">
                <Database size={14} className="text-blue-400" />
                {DB_LABELS[subtype] || subtype.toUpperCase()}
                <span className="text-slate-600 font-normal">({items.length})</span>
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {items.map(m => {
                  const sc = STATUS_COLORS[m.last_status] || STATUS_COLORS.unknown
                  return (
                    <div key={m.id}
                      onClick={() => navigate(`/monitoring/${m.id}`)}
                      className={`${sc.bg} border ${sc.border} rounded-xl p-4 cursor-pointer hover:brightness-110 transition-all`}>
                      <div className="flex items-start justify-between gap-2 mb-3">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-white truncate">{m.name}</div>
                          <div className="text-xs text-slate-400 font-mono mt-0.5 truncate">
                            {m.host}{m.port ? `:${m.port}` : ''}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <div className={`w-2 h-2 rounded-full ${sc.dot} ${m.last_status === 'up' ? 'animate-pulse' : ''}`} />
                          <span className={`text-xs font-medium ${sc.text} capitalize`}>{m.last_status || 'unknown'}</span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-xs text-slate-500">
                        <div className="flex items-center gap-1">
                          <Activity size={11} />
                          <span>{fmtLatency(m.last_latency_ms)}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <Clock size={11} />
                          <span>{m.last_checked ? fmtDate(m.last_checked) : 'Never checked'}</span>
                        </div>
                        <ChevronRight size={13} className="text-slate-600" />
                      </div>
                      {m.last_message && m.last_status !== 'up' && (
                        <div className="mt-2 text-xs text-red-400/80 truncate font-mono">{m.last_message}</div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
