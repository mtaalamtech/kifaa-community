import { useState, useEffect, useCallback } from 'react'
import {
  Activity, Plus, Trash2, Settings, X, RefreshCw, ChevronRight, Pencil,
  Globe, Database, Server, Mail, Layers, Box, Network, Radio,
  Shield, Search, Code, Plug, HardDrive, Cloud, Zap, AlertTriangle,
  CheckCircle2, Clock, Eye, Copy,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import api from '../api/client'

// Status config
const ST = {
  up:       { label: 'UP',       dot: 'bg-green-400',  badge: 'bg-green-900/50 text-green-300 border border-green-800',   text: 'text-green-400' },
  down:     { label: 'DOWN',     dot: 'bg-red-400',    badge: 'bg-red-900/50 text-red-300 border border-red-800',         text: 'text-red-400' },
  timeout:  { label: 'TIMEOUT',  dot: 'bg-yellow-400', badge: 'bg-yellow-900/50 text-yellow-300 border border-yellow-800', text: 'text-yellow-400' },
  unknown:  { label: '—',        dot: 'bg-slate-500',  badge: 'bg-slate-700 text-slate-400 border border-slate-600',      text: 'text-slate-400' },
  inactive: { label: 'INACTIVE', dot: 'bg-slate-600',  badge: 'bg-slate-800 text-slate-500 border border-slate-700',      text: 'text-slate-500' },
}

const getST = (m) => (!m.is_active ? ST.inactive : ST[m.last_status] || ST.unknown)

// Category icons
const CAT_ICONS = {
  'Network':              Radio,
  'Web / HTTP':           Globe,
  'Databases':            Database,
  'Database Plugins':     Database,
  'Services':             Server,
  'Mail Servers':         Mail,
  'Middleware':           Layers,
  'Virtualization / Cloud': Cloud,
  'Custom':               Plug,
}

// Map icon name strings from catalog to components
const ICON_MAP = {
  radio: Radio, globe: Globe, shield: Shield, search: Search, code: Code,
  plug: Plug, network: Network, database: Database, server: Server,
  mail: Mail, layers: Layers, box: Box, 'hard-drive': HardDrive,
  cloud: Cloud, zap: Zap, shuffle: Activity, folder: Activity, users: Activity, terminal: Activity,
}

const inputCls = "w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"

// ── Add / Edit Monitor Wizard ──────────────────────────────────────────────────
function AddMonitorWizard({ catalog, onClose, onSaved, editMonitor = null }) {
  const isEdit  = !!editMonitor?.id          // true only when editing existing (has id)
  const prefill = !!editMonitor              // true for both edit AND clone

  // Jump straight to configure step when editing or cloning
  const [step, setStep] = useState(prefill ? 3 : 1)
  const [selectedCategory, setSelectedCategory] = useState(prefill ? editMonitor.category : null)
  const [selectedType, setSelectedType] = useState(prefill ? {
    check: editMonitor.monitor_type,
    subtype: editMonitor.subtype,
    label: editMonitor.subtype?.replace(/_/g, ' ') || editMonitor.monitor_type,
    port: editMonitor.port,
  } : null)
  const [typeSearch, setTypeSearch] = useState('')
  const [form, setForm] = useState(prefill ? {
    name: editMonitor.name || '',
    host: editMonitor.host || '',
    port: editMonitor.port ? String(editMonitor.port) : '',
    config: editMonitor.config || {},
    check_interval_seconds: editMonitor.check_interval_seconds || 60,
    timeout_seconds: editMonitor.timeout_seconds || 10,
    is_active: editMonitor.is_active !== false,
    agent_id: editMonitor.agent_id || '',
  } : {
    name: '', host: '', port: '', config: {},
    check_interval_seconds: 60, timeout_seconds: 10, is_active: true, agent_id: '',
  })
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [agents, setAgents] = useState([])
  const set = (k, v) => { setTestResult(null); setForm(f => ({ ...f, [k]: v })) }
  const setConfig = (k, v) => { setTestResult(null); setForm(f => ({ ...f, config: { ...f.config, [k]: v } })) }

  // Load agents list when db_plugin type is selected
  useEffect(() => {
    if (selectedType?.check === 'db_plugin' && agents.length === 0) {
      api.get('/agents?status=online').then(r => setAgents(r.data || [])).catch(() => {})
    }
  }, [selectedType])

  async function runTest() {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await api.post('/monitoring/monitors/test', {
        monitor_type: selectedType.check,
        host: form.host,
        port: form.port ? parseInt(form.port) : null,
        config: form.config,
        timeout_seconds: form.timeout_seconds,
      })
      setTestResult(r.data)
    } catch (e) {
      setTestResult({ ok: false, status: 'error', message: e.response?.data?.detail || 'Request failed', latency_ms: null })
    } finally {
      setTesting(false)
    }
  }

  // Flat list of all types for search
  const allTypes = Object.entries(catalog).flatMap(([cat, types]) =>
    types.map(t => ({ ...t, category: cat }))
  )
  const searchResults = typeSearch.trim()
    ? allTypes.filter(t =>
        t.label.toLowerCase().includes(typeSearch.toLowerCase()) ||
        t.subtype.toLowerCase().includes(typeSearch.toLowerCase()) ||
        t.category.toLowerCase().includes(typeSearch.toLowerCase())
      )
    : []

  function pickCategory(cat) {
    setSelectedCategory(cat)
    setStep(2)
  }

  function pickType(t) {
    setSelectedType(t)
    setForm(f => ({
      ...f,
      port: t.port || '',
      name: t.label,
      config: t.check === 'http' ? { scheme: t.port === 443 ? 'https' : 'http', path: '/', expected_status: 200 }
            : t.check === 'snmp' ? { community: 'public', oid: '1.3.6.1.2.1.1.1.0' }
            : t.check === 'dns'  ? { record_type: 'A' }
            : t.check === 'db_plugin' ? { username: '', password: '', database: '' }
            : {},
    }))
    setStep(3)
  }

  async function save() {
    setSaving(true)
    try {
      const payload = {
        ...form,
        port: form.port ? parseInt(form.port) : null,
        monitor_type: selectedType.check,
        category: selectedCategory,
        subtype: selectedType.subtype,
        agent_id: form.agent_id || null,
      }
      if (isEdit) {
        await api.put(`/monitoring/monitors/${editMonitor.id}`, payload)
      } else {
        await api.post('/monitoring/monitors', payload)
      }
      onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  function renderConfigFields() {
    if (!selectedType) return null
    const cfg = form.config

    const commonFields = (
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className="text-xs text-slate-400 mb-1 block">Host / IP</label>
            <input value={form.host} onChange={e => set('host', e.target.value)}
              className={inputCls} placeholder="hostname or IP address" />
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Port</label>
            <input type="number" value={form.port} onChange={e => set('port', e.target.value)}
              className={inputCls} placeholder={selectedType.port || '—'} />
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
      </div>
    )

    const httpExtra = selectedType.check === 'http' && (
      <div className="space-y-3 mt-3 pt-3 border-t border-slate-700">
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
            <input type="number" value={cfg.expected_status || 200} onChange={e => setConfig('expected_status', parseInt(e.target.value))} className={inputCls} />
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Path</label>
            <input value={cfg.path || '/'} onChange={e => setConfig('path', e.target.value)} className={inputCls} placeholder="/" />
          </div>
        </div>
        <div>
          <label className="text-xs text-slate-400 mb-1 block">Content Match <span className="text-slate-600">(optional)</span></label>
          <input value={cfg.content_match || ''} onChange={e => setConfig('content_match', e.target.value)}
            className={inputCls} placeholder="e.g. 'OK' — alert if not found in response" />
        </div>
      </div>
    )

    const snmpExtra = selectedType.check === 'snmp' && (
      <div className="space-y-3 mt-3 pt-3 border-t border-slate-700">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Community String</label>
            <input value={cfg.community || 'public'} onChange={e => setConfig('community', e.target.value)} className={inputCls} placeholder="public" />
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">SNMP Version</label>
            <select value={cfg.version || '2c'} onChange={e => setConfig('version', e.target.value)} className={inputCls}>
              <option value="1">v1</option>
              <option value="2c">v2c</option>
            </select>
          </div>
        </div>
        <div>
          <label className="text-xs text-slate-400 mb-1 block">OID to poll</label>
          <input value={cfg.oid || '1.3.6.1.2.1.1.1.0'} onChange={e => setConfig('oid', e.target.value)}
            className={inputCls} placeholder="1.3.6.1.2.1.1.1.0 (sysDescr)" />
        </div>
      </div>
    )

    const dnsExtra = selectedType.check === 'dns' && (
      <div className="space-y-3 mt-3 pt-3 border-t border-slate-700">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Lookup Hostname</label>
            <input value={cfg.lookup_hostname || form.host} onChange={e => setConfig('lookup_hostname', e.target.value)}
              className={inputCls} placeholder="example.com" />
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Record Type</label>
            <select value={cfg.record_type || 'A'} onChange={e => setConfig('record_type', e.target.value)} className={inputCls}>
              {['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA'].map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
        </div>
      </div>
    )

    const dbExtra = selectedCategory === 'Databases' && (
      <div className="space-y-3 mt-3 pt-3 border-t border-slate-700">
        <div className="text-xs text-slate-400 font-medium uppercase tracking-wide">Database Connection <span className="text-slate-600 normal-case">(optional)</span></div>
        <div>
          <label className="text-xs text-slate-400 mb-1 block">Database Name <span className="text-slate-600">(optional)</span></label>
          <input value={cfg.database || ''} onChange={e => setConfig('database', e.target.value)}
            className={inputCls} placeholder="e.g. mydb, master, postgres" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Username <span className="text-slate-600">(optional)</span></label>
            <input value={cfg.username || ''} onChange={e => setConfig('username', e.target.value)}
              className={inputCls} placeholder="e.g. monitor_user" autoComplete="off" />
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Password <span className="text-slate-600">(optional)</span></label>
            <input type="password" value={cfg.password || ''} onChange={e => setConfig('password', e.target.value)}
              className={inputCls} placeholder="leave blank if not required" autoComplete="new-password" />
          </div>
        </div>
        <p className="text-xs text-slate-600 bg-slate-900 rounded-lg px-3 py-2">
          If credentials are omitted, the check will attempt a TCP connection to confirm the port is reachable. Provide credentials to verify authentication succeeds.
        </p>
      </div>
    )

    const dbPluginExtra = selectedType?.check === 'db_plugin' && (
      <div className="space-y-3 mt-3 pt-3 border-t border-slate-700">
        <div>
          <label className="text-xs text-slate-400 mb-1 block">Agent <span className="text-red-400">*</span></label>
          <select value={form.agent_id || ''} onChange={e => set('agent_id', e.target.value)} className={inputCls}>
            <option value="">— Select an agent to run this check —</option>
            {agents.map(a => (
              <option key={a.id} value={a.id}>{a.hostname}{a.display_name ? ` (${a.display_name})` : ''} — {a.ip_address || 'no IP'}</option>
            ))}
          </select>
          <p className="text-xs text-slate-500 mt-1">The selected agent must be on the same network as the database.</p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Database Name <span className="text-slate-600">(optional)</span></label>
            <input value={cfg.database || ''} onChange={e => setConfig('database', e.target.value)}
              className={inputCls} placeholder="e.g. mydb" />
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Username <span className="text-slate-600">(optional)</span></label>
            <input value={cfg.username || ''} onChange={e => setConfig('username', e.target.value)}
              className={inputCls} placeholder="monitor_user" autoComplete="off" />
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Password <span className="text-slate-600">(optional)</span></label>
            <input type="password" value={cfg.password || ''} onChange={e => setConfig('password', e.target.value)}
              className={inputCls} placeholder="••••••" autoComplete="new-password" />
          </div>
        </div>
        <div className="bg-blue-900/20 border border-blue-800/50 rounded-lg px-3 py-2.5 text-xs text-blue-300">
          The agent will connect to the database from its local network and report health back to the server. Checks run via the agent heartbeat.
        </div>
      </div>
    )

    return (
      <div>
        {commonFields}
        {httpExtra}
        {snmpExtra}
        {dnsExtra}
        {dbExtra}
        {dbPluginExtra}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="p-5 border-b border-slate-700 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-white">
                {isEdit ? `Edit Monitor — ${editMonitor.name}` : editMonitor ? `Clone Monitor — ${editMonitor.name}` : 'Add New Monitor'}
              </h2>
              {step < 3 && (
                <div className="flex items-center gap-1 mt-1">
                  {['Category', 'Type', 'Configure'].map((s, i) => (
                    <span key={s} className="flex items-center gap-1">
                      <span className={`text-xs ${step > i + 1 ? 'text-green-400' : step === i + 1 ? 'text-blue-400 font-medium' : 'text-slate-500'}`}>
                        {step > i + 1 ? '✓ ' : ''}{s}
                      </span>
                      {i < 2 && <ChevronRight size={12} className="text-slate-600" />}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
          </div>
          {/* Search — visible on steps 1 and 2 */}
          {step < 3 && (
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                value={typeSearch}
                onChange={e => setTypeSearch(e.target.value)}
                placeholder="Search monitor types… e.g. nginx, mysql, ping, ssl"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg pl-9 pr-4 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus={step === 1}
              />
              {typeSearch && (
                <button onClick={() => setTypeSearch('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white">
                  <X size={13} />
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {/* Step 1 — category or search results */}
          {step === 1 && (
            <div>
              {searchResults.length > 0 ? (
                <div>
                  <p className="text-xs text-slate-500 mb-3">{searchResults.length} result{searchResults.length !== 1 ? 's' : ''} for "{typeSearch}"</p>
                  <div className="grid grid-cols-2 gap-2">
                    {searchResults.map(t => {
                      const Icon = ICON_MAP[t.icon] || Activity
                      return (
                        <button key={`${t.category}-${t.subtype}`} onClick={() => {
                          setSelectedCategory(t.category)
                          setTypeSearch('')
                          pickType(t)
                        }}
                          className="flex items-center gap-3 p-3 bg-slate-700 hover:bg-slate-600 border border-slate-600 hover:border-blue-500 rounded-lg text-left transition-all">
                          <Icon size={16} className="text-blue-400 flex-shrink-0" />
                          <div className="min-w-0">
                            <div className="text-sm text-white truncate">{t.label}</div>
                            <div className="text-xs text-slate-500">{t.category}{t.port ? ` · Port ${t.port}` : ''}</div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ) : typeSearch ? (
                <div className="text-center py-10 text-slate-500 text-sm">
                  No monitor types found for "{typeSearch}"
                </div>
              ) : (
                <div>
                  <p className="text-sm text-slate-400 mb-4">Select a monitor category</p>
                  <div className="grid grid-cols-2 gap-3">
                    {Object.entries(catalog).map(([cat, types]) => {
                      const Icon = CAT_ICONS[cat] || Activity
                      return (
                        <button key={cat} onClick={() => pickCategory(cat)}
                          className="flex items-center gap-3 p-4 bg-slate-700 hover:bg-slate-600 border border-slate-600 hover:border-blue-500 rounded-xl text-left transition-all group">
                          <div className="w-10 h-10 rounded-lg bg-slate-800 group-hover:bg-blue-600/20 flex items-center justify-center flex-shrink-0 transition-colors">
                            <Icon size={20} className="text-blue-400" />
                          </div>
                          <div>
                            <div className="text-sm font-medium text-white">{cat}</div>
                            <div className="text-xs text-slate-400">{types.length} monitor types</div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 2 — type */}
          {step === 2 && selectedCategory && (
            <div>
              <button onClick={() => { setStep(1); setTypeSearch('') }}
                className="text-xs text-slate-400 hover:text-white mb-4 flex items-center gap-1">
                ← Back to categories
              </button>
              <p className="text-sm text-slate-400 mb-3">{selectedCategory}</p>
              {(() => {
                const types = catalog[selectedCategory] || []
                const visible = typeSearch
                  ? types.filter(t => t.label.toLowerCase().includes(typeSearch.toLowerCase()) || t.subtype.includes(typeSearch.toLowerCase()))
                  : types
                return (
                  <>
                    {typeSearch && <p className="text-xs text-slate-500 mb-3">{visible.length} result{visible.length !== 1 ? 's' : ''}</p>}
                    <div className="grid grid-cols-2 gap-2">
                      {visible.map(t => {
                        const Icon = ICON_MAP[t.icon] || Activity
                        return (
                          <button key={t.subtype} onClick={() => pickType(t)}
                            className="flex items-center gap-3 p-3 bg-slate-700 hover:bg-slate-600 border border-slate-600 hover:border-blue-500 rounded-lg text-left transition-all">
                            <Icon size={16} className="text-blue-400 flex-shrink-0" />
                            <div>
                              <div className="text-sm text-white">{t.label}</div>
                              {t.port && <div className="text-xs text-slate-500">Port {t.port} · {t.check.toUpperCase()}</div>}
                            </div>
                          </button>
                        )
                      })}
                      {visible.length === 0 && (
                        <div className="col-span-2 text-center py-6 text-slate-500 text-sm">
                          No types match "{typeSearch}" in {selectedCategory}
                        </div>
                      )}
                    </div>
                  </>
                )
              })()}
            </div>
          )}

          {/* Step 3 — configure */}
          {step === 3 && selectedType && (
            <div>
              <button onClick={() => setStep(2)} className="text-xs text-slate-400 hover:text-white mb-4 flex items-center gap-1">
                ← Back to types
              </button>
              <div className="flex items-center gap-2 mb-4 p-3 bg-slate-700 rounded-lg">
                <div className="w-8 h-8 rounded-lg bg-blue-600/20 flex items-center justify-center">
                  {(() => { const Icon = ICON_MAP[selectedType.icon] || Activity; return <Icon size={16} className="text-blue-400" /> })()}
                </div>
                <div>
                  <div className="text-sm font-medium text-white">{selectedType.label}</div>
                  <div className="text-xs text-slate-400">{selectedCategory} · {selectedType.check.toUpperCase()} check</div>
                </div>
              </div>
              <div className="mb-4">
                <label className="text-xs text-slate-400 mb-1 block">Monitor Name</label>
                <input value={form.name} onChange={e => set('name', e.target.value)}
                  className={inputCls} placeholder={`e.g. Production ${selectedType.label}`} />
              </div>
              {renderConfigFields()}
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer mt-4">
                <input type="checkbox" checked={form.is_active} onChange={e => set('is_active', e.target.checked)} />
                Active (start monitoring immediately)
              </label>
            </div>
          )}
        </div>

        {step === 3 && (
          <div className="border-t border-slate-700">
            {/* Test result banner */}
            {testResult && (
              <div className={`mx-5 mt-4 flex items-start gap-3 px-4 py-3 rounded-lg text-sm
                ${testResult.ok
                  ? 'bg-green-900/40 border border-green-800 text-green-300'
                  : 'bg-red-900/40 border border-red-800 text-red-300'}`}>
                {testResult.ok
                  ? <CheckCircle2 size={16} className="flex-shrink-0 mt-0.5" />
                  : <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />}
                <div>
                  <span className="font-medium capitalize">{testResult.status}</span>
                  {testResult.latency_ms != null && (
                    <span className="ml-2 opacity-70">{testResult.latency_ms} ms</span>
                  )}
                  {testResult.message && (
                    <div className="text-xs mt-0.5 opacity-80">{testResult.message}</div>
                  )}
                </div>
              </div>
            )}
            <div className="flex justify-between gap-3 p-5">
              {selectedType?.check !== 'db_plugin' && (
                <button
                  onClick={runTest}
                  disabled={testing || !form.host}
                  title={!form.host ? 'Enter a host first' : 'Test connectivity before saving'}
                  className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white text-sm rounded-lg transition-colors"
                >
                  {testing
                    ? <RefreshCw size={13} className="animate-spin" />
                    : <Activity size={13} />}
                  {testing ? 'Testing…' : 'Test Connection'}
                </button>
              )}
              {selectedType?.check === 'db_plugin' && (
                <div className="text-xs text-slate-500 flex items-center gap-1.5">
                  <Database size={13} />
                  Agent-based check — runs on next heartbeat
                </div>
              )}
              <div className="flex gap-3 items-center">
                <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer select-none">
                  <input type="checkbox" checked={form.is_active}
                    onChange={e => set('is_active', e.target.checked)}
                    className="w-4 h-4 rounded border-slate-600 bg-slate-700 accent-blue-500" />
                  Active
                </label>
                <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
                <button onClick={save}
                  disabled={!form.name || !form.host || saving || (selectedType?.check === 'db_plugin' && !form.agent_id)}
                  className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded-lg transition-colors">
                  {saving ? <RefreshCw size={13} className="animate-spin" /> : null}
                  {isEdit ? 'Save Changes' : 'Add Monitor'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Results Side Panel ─────────────────────────────────────────────────────────
function ResultsPanel({ monitor, onClose }) {
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get(`/monitoring/monitors/${monitor.id}/results?hours=24`)
      .then(r => setResults(r.data))
      .finally(() => setLoading(false))
  }, [monitor.id])

  const st = (s) => ST[s] || ST.unknown

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-end z-50">
      <div className="bg-slate-800 border-l border-slate-700 w-full max-w-md h-full overflow-y-auto p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-white">{monitor.name}</h2>
            <p className="text-xs text-slate-400 font-mono">{monitor.host}{monitor.port ? `:${monitor.port}` : ''}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>

        {monitor.last_message && (
          <div className="text-xs text-slate-400 bg-slate-700 rounded-lg px-3 py-2">
            {monitor.last_message}
          </div>
        )}

        <div className="text-xs text-slate-400">Last 24 hours — {results.length} checks</div>

        {loading ? <div className="text-slate-400 text-sm">Loading...</div> : (
          <div className="space-y-1">
            {results.length === 0 && <p className="text-slate-500 text-sm">No results yet.</p>}
            {results.map((r, i) => {
              const s = st(r.status)
              return (
                <div key={i} className="flex items-start gap-3 py-1.5 border-b border-slate-700">
                  <span className={`w-2 h-2 rounded-full shrink-0 mt-1 ${s.dot}`} />
                  <span className={`text-xs font-medium w-14 shrink-0 ${s.text}`}>{s.label}</span>
                  <span className="text-xs text-slate-400 flex-1">{new Date(r.time).toLocaleString()}</span>
                  <span className="text-xs text-slate-500 shrink-0">{r.latency_ms != null ? `${r.latency_ms}ms` : '—'}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Monitoring Page ───────────────────────────────────────────────────────
export default function Monitoring() {
  const [monitors, setMonitors] = useState([])
  const [catalog, setCatalog] = useState({})
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [showWizard, setShowWizard] = useState(false)
  const [editMonitor, setEditMonitor] = useState(null)
  const [selectedMonitor, setSelectedMonitor] = useState(null)
  const [filterCat, setFilterCat] = useState('all')
  const [filterGroup, setFilterGroup] = useState('')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    try {
      const params = filterGroup ? { group_id: filterGroup } : {}
      const [mRes, cRes, gRes] = await Promise.all([
        api.get('/monitoring/monitors', { params }),
        api.get('/monitoring/catalog'),
        api.get('/groups'),
      ])
      setMonitors(mRes.data)
      setCatalog(cRes.data)
      setGroups(gRes.data)
    } finally {
      setLoading(false)
    }
  }, [filterGroup])

  useEffect(() => { load() }, [load])

  async function deleteMonitor(id) {
    if (!confirm('Delete this monitor?')) return
    await api.delete(`/monitoring/monitors/${id}`)
    load()
  }

  function cloneMonitor(m) {
    // Strip id so the wizard saves as a new monitor, prefix name so user knows to rename
    setEditMonitor({ ...m, id: undefined, name: `Copy of ${m.name}` })
    setShowWizard(true)
  }

  const filtered = monitors
    .filter(m => {
      const matchCat = filterCat === 'all' || m.category === filterCat
      const matchSearch = !search || m.name.toLowerCase().includes(search.toLowerCase()) || (m.host || '').includes(search)
      return matchCat && matchSearch
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  const up       = monitors.filter(m =>  m.is_active && m.last_status === 'up').length
  const down     = monitors.filter(m =>  m.is_active && ['down', 'timeout'].includes(m.last_status)).length
  const unknown  = monitors.filter(m =>  m.is_active && m.last_status === 'unknown').length
  const inactive = monitors.filter(m => !m.is_active).length

  const allCategories = [...new Set(monitors.map(m => m.category))].filter(Boolean)

  if (loading) return <div className="p-8 text-slate-400">Loading...</div>

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Activity size={20} className="text-blue-400" /> Monitoring
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">Infrastructure and service health monitoring</p>
        </div>
        <button onClick={() => setShowWizard(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors">
          <Plus size={15} /> Add Monitor
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-5 gap-4">
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-2xl font-bold text-white">{monitors.length}</div>
          <div className="text-xs text-slate-400 mt-1">Total Monitors</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-2xl font-bold text-green-400">{up}</div>
          <div className="text-xs text-slate-400 mt-1 flex items-center gap-1"><CheckCircle2 size={11} /> Up</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-2xl font-bold text-red-400">{down}</div>
          <div className="text-xs text-slate-400 mt-1 flex items-center gap-1"><AlertTriangle size={11} /> Down / Timeout</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-2xl font-bold text-slate-400">{unknown}</div>
          <div className="text-xs text-slate-400 mt-1 flex items-center gap-1"><Clock size={11} /> Pending</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-2xl font-bold text-slate-500">{inactive}</div>
          <div className="text-xs text-slate-400 mt-1 flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-600 inline-block" /> Inactive</div>
        </div>
      </div>

      {/* Filter bar */}
      {monitors.length > 0 && (
        <div className="flex gap-3 items-center flex-wrap">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search monitors..."
              className="bg-slate-800 border border-slate-700 rounded-lg pl-8 pr-4 py-2 text-sm text-white w-56 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <select value={filterGroup} onChange={e => setFilterGroup(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
            <option value="">All Groups</option>
            {groups.map(g => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
          <div className="flex gap-1 flex-wrap">
            {['all', ...allCategories].map(cat => (
              <button key={cat} onClick={() => setFilterCat(cat)}
                className={`px-3 py-1.5 rounded-lg text-xs transition-colors capitalize
                  ${filterCat === cat ? 'bg-blue-600 text-white' : 'bg-slate-800 border border-slate-700 text-slate-400 hover:text-white'}`}>
                {cat}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Monitor table */}
      {monitors.length === 0 ? (
        <div className="text-center py-20 bg-slate-800 border border-slate-700 rounded-xl">
          <Activity size={44} className="mx-auto mb-3 text-slate-600" />
          <p className="text-slate-300 font-medium">No monitors configured</p>
          <p className="text-slate-500 text-sm mt-1">Add monitors to watch servers, websites, databases, and services</p>
          <button onClick={() => setShowWizard(true)}
            className="mt-5 flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors mx-auto">
            <Plus size={14} /> Add your first monitor
          </button>
        </div>
      ) : (
        <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-xs text-slate-400 uppercase">
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">Type</th>
                <th className="px-4 py-3 text-left">Host</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Uptime (24h)</th>
                <th className="px-4 py-3 text-left">Latency</th>
                <th className="px-4 py-3 text-left">Last Checked</th>
                <th className="px-4 py-3 text-left">Message</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {filtered.map(m => {
                const st = getST(m)
                return (
                  <tr key={m.id} className="hover:bg-slate-750 group">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${st.dot} ${m.is_active && m.last_status === 'up' ? 'animate-pulse' : ''}`} />
                        <Link to={`/monitoring/${m.id}`} className="font-medium text-white hover:text-blue-400 transition-colors">
                          {m.name}
                        </Link>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded capitalize">
                        {m.subtype?.replace(/_/g, ' ') || m.monitor_type}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-300">
                      {m.host}{m.port ? `:${m.port}` : ''}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${st.badge}`}>{st.label}</span>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {m.uptime_24h != null ? (
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${m.uptime_24h >= 99 ? 'bg-green-500' : m.uptime_24h >= 90 ? 'bg-yellow-500' : 'bg-red-500'}`}
                              style={{ width: `${m.uptime_24h}%` }}
                            />
                          </div>
                          <span className={m.uptime_24h >= 99 ? 'text-green-400' : m.uptime_24h >= 90 ? 'text-yellow-400' : 'text-red-400'}>
                            {m.uptime_24h}%
                          </span>
                        </div>
                      ) : <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {m.last_latency_ms != null
                        ? <span className={st.text}>{m.last_latency_ms} ms</span>
                        : <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {m.last_checked ? new Date(m.last_checked).toLocaleString() : 'Never'}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500 max-w-48 truncate" title={m.last_message || ''}>
                      {m.last_message || '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => setSelectedMonitor(m)}
                          className="p-1.5 text-slate-400 hover:text-blue-400 hover:bg-slate-700 rounded-lg transition-colors" title="View check history">
                          <Eye size={14} />
                        </button>
                        <button onClick={() => cloneMonitor(m)}
                          className="p-1.5 text-slate-400 hover:text-green-400 hover:bg-slate-700 rounded-lg transition-colors" title="Clone monitor">
                          <Copy size={14} />
                        </button>
                        <button onClick={() => { setEditMonitor(m); setShowWizard(true) }}
                          className="p-1.5 text-slate-400 hover:text-yellow-400 hover:bg-slate-700 rounded-lg transition-colors" title="Edit monitor">
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => deleteMonitor(m.id)}
                          className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-slate-700 rounded-lg transition-colors" title="Delete monitor">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-500">No monitors match filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {showWizard && (
        <AddMonitorWizard
          catalog={catalog}
          onClose={() => { setShowWizard(false); setEditMonitor(null) }}
          onSaved={load}
          editMonitor={editMonitor}
        />
      )}

      {selectedMonitor && (
        <ResultsPanel monitor={selectedMonitor} onClose={() => setSelectedMonitor(null)} />
      )}
    </div>
  )
}
