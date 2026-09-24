import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plug, Server, Shield, Cloud, Database, Zap,
  RefreshCw, CheckCircle, XCircle, AlertTriangle,
  Clock, Settings, ArrowRight, ToggleLeft, ToggleRight,
  Plus, Trash2
} from 'lucide-react'
import { integrationsApi } from '../api/client'

const PLUGIN_ICONS = {
  unitrends: Server,
  sophos: Shield,
  o365: Cloud,
  sap: Database,
  vmware: Server,
  proxmox: Server,
  nutanix: Database,
  apc_ups: Zap,
}

const PLUGIN_COLORS = {
  unitrends: 'blue',
  sophos: 'red',
  o365: 'indigo',
  sap: 'amber',
  vmware: 'violet',
  proxmox: 'orange',
  nutanix: 'cyan',
  apc_ups: 'yellow',
}

const PLUGIN_ROUTES = {
  unitrends: '/integrations/unitrends',
  sophos: '/integrations/sophos',
  o365: '/integrations/o365',
  sap: '/integrations/sap',
  vmware: '/integrations/vmware',
  proxmox: '/integrations/proxmox',
  nutanix: '/integrations/nutanix',
  apc_ups: '/integrations/apc-ups',
}

// Config field definitions per plugin type
const CONFIG_FIELDS = {
  unitrends: [
    { key: 'host', label: 'Appliance IP / Hostname', placeholder: '192.168.0.28', type: 'text', required: true },
    { key: 'username', label: 'Username', placeholder: 'root', type: 'text' },
    { key: 'password', label: 'Password', placeholder: '••••••••', type: 'password' },
    { key: 'verify_ssl', label: 'Verify SSL Certificate', type: 'checkbox' },
  ],
  sophos: [
    { key: 'client_id', label: 'Client ID', placeholder: 'OAuth2 client ID', type: 'text', required: true },
    { key: 'client_secret', label: 'Client Secret', placeholder: '••••••••', type: 'password', required: true },
  ],
  o365: [
    { key: 'tenant_id', label: 'Tenant ID (Directory ID)', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', type: 'text', required: true },
    { key: 'client_id', label: 'Application (Client) ID', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', type: 'text', required: true },
    { key: 'client_secret', label: 'Client Secret', placeholder: '••••••••', type: 'password', required: true },
  ],
  sap: [
    { key: 'host', label: 'SAP B1 Server (IP:Port)', placeholder: '192.168.0.17:50001', type: 'text', required: true },
    { key: 'username', label: 'SAP Username', placeholder: 'manager', type: 'text' },
    { key: 'password', label: 'Password', placeholder: '••••••••', type: 'password' },
    { key: 'company_db', label: 'Company Database', placeholder: 'SBK_KNC_ACC', type: 'text', required: true },
  ],
  vmware: [
    { key: 'host', label: 'vCenter IP / Hostname', placeholder: 'vcenter.example.com', type: 'text', required: true },
    { key: 'username', label: 'Username', placeholder: 'administrator@vsphere.local', type: 'text' },
    { key: 'password', label: 'Password', placeholder: '••••••••', type: 'password' },
    { key: 'verify_ssl', label: 'Verify SSL Certificate', type: 'checkbox' },
  ],
  proxmox: [
    { key: 'host', label: 'Proxmox IP / Hostname', placeholder: '192.168.1.10', type: 'text', required: true },
    { key: 'username', label: 'Username', placeholder: 'root@pam', type: 'text' },
    { key: 'password', label: 'Password', placeholder: '••••••••', type: 'password' },
    { key: 'token_id', label: 'API Token ID (optional)', placeholder: 'mytoken', type: 'text' },
    { key: 'token_secret', label: 'API Token Secret (optional)', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', type: 'password' },
    { key: 'verify_ssl', label: 'Verify SSL Certificate', type: 'checkbox' },
  ],
  nutanix: [
    { key: 'host', label: 'Prism IP / Hostname', placeholder: '192.168.1.100', type: 'text', required: true },
    { key: 'username', label: 'Username', placeholder: 'admin', type: 'text' },
    { key: 'password', label: 'Password', placeholder: '••••••••', type: 'password' },
    { key: 'port', label: 'Port', placeholder: '9440', type: 'text' },
    { key: 'verify_ssl', label: 'Verify SSL Certificate', type: 'checkbox' },
  ],
}

function StatusBadge({ status }) {
  const map = {
    connected: { icon: CheckCircle, cls: 'text-green-400 bg-green-900/40 border-green-700', label: 'Connected' },
    disconnected: { icon: XCircle, cls: 'text-slate-400 bg-slate-800 border-slate-600', label: 'Disconnected' },
    error: { icon: AlertTriangle, cls: 'text-red-400 bg-red-900/40 border-red-700', label: 'Error' },
    syncing: { icon: RefreshCw, cls: 'text-blue-400 bg-blue-900/40 border-blue-700', label: 'Syncing' },
  }
  const s = map[status] || map.disconnected
  const Icon = s.icon
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${s.cls}`}>
      <Icon size={10} />{s.label}
    </span>
  )
}

function ConfigModal({ plugin, onClose, onSaved }) {
  const [cfg, setCfg] = useState({})
  const [isEnabled, setIsEnabled] = useState(plugin.is_enabled)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [esxiTestResults, setEsxiTestResults] = useState({})
  const [esxiTesting, setEsxiTesting] = useState({})
  const fields = CONFIG_FIELDS[plugin.plugin_type] || []

  useEffect(() => {
    integrationsApi.getConfig(plugin.plugin_type)
      .then(r => {
        setCfg(r.data.config || {})
        setIsEnabled(r.data.is_enabled)
      })
      .catch(() => {})
  }, [plugin.plugin_type])

  const handleSave = async () => {
    setSaving(true)
    try {
      await integrationsApi.updateConfig(plugin.plugin_type, { ...cfg, is_enabled: isEnabled })
      onSaved()
      onClose()
    } catch (e) {
      alert('Save failed: ' + (e.response?.data?.detail || e.message))
    }
    setSaving(false)
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      // Save first so test uses latest creds
      await integrationsApi.updateConfig(plugin.plugin_type, { ...cfg, is_enabled: true })
      const r = await integrationsApi.test(plugin.plugin_type)
      setTestResult(r.data)
    } catch (e) {
      setTestResult({ ok: false, message: e.response?.data?.detail || e.message })
    }
    setTesting(false)
  }

  const handleTestEsxi = async (i, esxi) => {
    setEsxiTesting(p => ({ ...p, [i]: true }))
    setEsxiTestResults(p => ({ ...p, [i]: null }))
    try {
      const r = await integrationsApi.testEsxi({ host: esxi.host, username: esxi.username, password: esxi.password, verify_ssl: esxi.verify_ssl })
      setEsxiTestResults(p => ({ ...p, [i]: r.data }))
    } catch (e) {
      setEsxiTestResults(p => ({ ...p, [i]: { ok: false, message: e.response?.data?.detail || e.message } }))
    }
    setEsxiTesting(p => ({ ...p, [i]: false }))
  }

  const Icon = PLUGIN_ICONS[plugin.plugin_type] || Plug
  const color = PLUGIN_COLORS[plugin.plugin_type] || 'slate'

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-lg">
        {/* Header */}
        <div className="flex items-center gap-3 p-6 border-b border-slate-700">
          <div className={`w-10 h-10 rounded-xl bg-${color}-600/20 flex items-center justify-center`}>
            <Icon size={20} className={`text-${color}-400`} />
          </div>
          <div>
            <div className="text-white font-semibold">{plugin.display_name}</div>
            <div className="text-slate-400 text-sm">Configure integration settings</div>
          </div>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-white text-xl leading-none">×</button>
        </div>

        <div className="p-6 space-y-4">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-300">Enable Integration</span>
            <button onClick={() => setIsEnabled(!isEnabled)} className="text-slate-400 hover:text-white">
              {isEnabled
                ? <ToggleRight size={28} className="text-green-400" />
                : <ToggleLeft size={28} />}
            </button>
          </div>

          {fields.length === 0 && (
            <div className="text-slate-400 text-sm text-center py-4">
              This integration is coming soon — no configuration required yet.
            </div>
          )}

          {/* Config fields */}
          {fields.map(f => (
            <div key={f.key}>
              <label className="block text-xs text-slate-400 mb-1">{f.label}{f.required && <span className="text-red-400 ml-0.5">*</span>}</label>
              {f.type === 'checkbox' ? (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!cfg[f.key]}
                    onChange={e => setCfg(p => ({ ...p, [f.key]: e.target.checked }))}
                    className="w-4 h-4"
                  />
                  <span className="text-sm text-slate-300">Enabled</span>
                </label>
              ) : (
                <input
                  type={f.type}
                  value={cfg[f.key] ?? ''}
                  placeholder={f.placeholder}
                  onChange={e => setCfg(p => ({ ...p, [f.key]: e.target.value }))}
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500"
                />
              )}
            </div>
          ))}

          {/* Standalone ESXi hosts — VMware only */}
          {plugin.plugin_type === 'vmware' && (
            <div className="border-t border-slate-700 pt-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-slate-200">Standalone ESXi Hosts</span>
                <button
                  onClick={() => setCfg(p => ({
                    ...p,
                    standalone_esxi: [...(p.standalone_esxi || []), { host: '', username: 'root', password: '', verify_ssl: false }]
                  }))}
                  className="flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300"
                >
                  <Plus size={12} /> Add Host
                </button>
              </div>
              {(cfg.standalone_esxi || []).length === 0 && (
                <p className="text-xs text-slate-500">No standalone ESXi hosts configured. Click "Add Host" to add hosts not managed by vCenter.</p>
              )}
              {(cfg.standalone_esxi || []).map((esxi, i) => (
                <div key={i} className="bg-slate-900 border border-slate-700 rounded-lg p-3 mb-2 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-400 font-medium">ESXi Host {i + 1}</span>
                    <button
                      onClick={() => setCfg(p => ({
                        ...p,
                        standalone_esxi: (p.standalone_esxi || []).filter((_, idx) => idx !== i)
                      }))}
                      className="text-red-400 hover:text-red-300"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  {[
                    { key: 'host', label: 'IP / Hostname', placeholder: '192.168.0.X', type: 'text' },
                    { key: 'username', label: 'Username', placeholder: 'root', type: 'text' },
                    { key: 'password', label: 'Password', placeholder: '••••••••', type: 'password' },
                  ].map(f => (
                    <div key={f.key}>
                      <label className="block text-xs text-slate-500 mb-1">{f.label}</label>
                      <input
                        type={f.type}
                        value={esxi[f.key] ?? ''}
                        placeholder={f.placeholder}
                        onChange={e => setCfg(p => {
                          const arr = [...(p.standalone_esxi || [])]
                          arr[i] = { ...arr[i], [f.key]: e.target.value }
                          return { ...p, standalone_esxi: arr }
                        })}
                        className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-white placeholder-slate-500"
                      />
                    </div>
                  ))}
                  <button
                    onClick={() => handleTestEsxi(i, esxi)}
                    disabled={esxiTesting[i] || !esxi.host}
                    className="mt-1 flex items-center gap-1.5 text-xs text-violet-400 hover:text-violet-300 disabled:opacity-50"
                  >
                    {esxiTesting[i] ? <RefreshCw size={11} className="animate-spin" /> : <CheckCircle size={11} />}
                    Test Connection
                  </button>
                  {esxiTestResults[i] && (
                    <div className={`rounded p-2 text-xs ${esxiTestResults[i].ok ? 'bg-green-900/30 text-green-300' : 'bg-red-900/30 text-red-300'}`}>
                      {esxiTestResults[i].ok ? '✓ ' : '✗ '}{esxiTestResults[i].message}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Test result */}
          {testResult && (
            <div className={`rounded-lg p-3 text-sm ${testResult.ok ? 'bg-green-900/30 border border-green-700 text-green-300' : 'bg-red-900/30 border border-red-700 text-red-300'}`}>
              {testResult.ok ? '✓ ' : '✗ '}{testResult.message}
              {testResult.info && (
                <pre className="text-xs mt-1 opacity-70 whitespace-pre-wrap">
                  {JSON.stringify(testResult.info, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 px-6 pb-6">
          {fields.length > 0 && (
            <button
              onClick={handleTest}
              disabled={testing}
              className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm disabled:opacity-50"
            >
              {testing ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle size={14} />}
              Test Connection
            </button>
          )}
          <div className="flex-1" />
          <button onClick={onClose} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm">Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function PluginCard({ plugin, onConfigure, onSync, onNavigate }) {
  const Icon = PLUGIN_ICONS[plugin.plugin_type] || Plug
  const color = PLUGIN_COLORS[plugin.plugin_type] || 'slate'
  const route = PLUGIN_ROUTES[plugin.plugin_type]
  const [syncing, setSyncing] = useState(false)

  const handleSync = async (e) => {
    e.stopPropagation()
    setSyncing(true)
    try {
      await onSync(plugin.plugin_type)
    } finally {
      setTimeout(() => setSyncing(false), 2000)
    }
  }

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 flex flex-col gap-4 hover:border-slate-600 transition-colors">
      {/* Top row */}
      <div className="flex items-start gap-4">
        <div className={`w-12 h-12 rounded-xl bg-${color}-600/20 flex items-center justify-center flex-shrink-0`}>
          <Icon size={24} className={`text-${color}-400`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-white font-semibold">{plugin.display_name}</div>
          <div className="text-slate-400 text-sm mt-0.5 leading-snug">{plugin.description}</div>
        </div>
        <StatusBadge status={plugin.is_enabled ? plugin.status : 'disconnected'} />
      </div>

      {/* Last sync */}
      {plugin.last_sync_at && (
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <Clock size={11} />
          Last sync: {new Date(plugin.last_sync_at).toLocaleString()}
        </div>
      )}
      {plugin.last_error && plugin.is_enabled && (
        <div className="text-xs text-red-400 bg-red-900/20 rounded-lg px-3 py-1.5 border border-red-900">
          {plugin.last_error}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 mt-auto pt-2 border-t border-slate-700">
        <button
          onClick={() => {
            // If plugin has a dedicated page and no modal config fields, go there directly
            const hasFields = (CONFIG_FIELDS[plugin.plugin_type] || []).length > 0
            if (route && !hasFields) {
              onNavigate(route)
            } else {
              onConfigure(plugin)
            }
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white rounded-lg text-xs"
        >
          <Settings size={13} /> Configure
        </button>
        {plugin.is_enabled && (
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white rounded-lg text-xs disabled:opacity-50"
          >
            <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
            Sync Now
          </button>
        )}
        {route && plugin.is_enabled && (CONFIG_FIELDS[plugin.plugin_type] || []).length > 0 && (
          <button
            onClick={() => onNavigate(route)}
            className={`ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-${color}-600/20 hover:bg-${color}-600/40 text-${color}-400 rounded-lg text-xs`}
          >
            Open <ArrowRight size={12} />
          </button>
        )}
        {plugin.plugin_type === 'sap' && (
          <span className="ml-auto text-xs text-slate-500 italic">Coming soon</span>
        )}
      </div>
    </div>
  )
}

export default function Integrations() {
  const navigate = useNavigate()
  const [plugins, setPlugins] = useState([])
  const [loading, setLoading] = useState(true)
  const [configModal, setConfigModal] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await integrationsApi.list()
      setPlugins(r.data)
    } catch { setPlugins([]) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const handleSync = async (pluginType) => {
    try {
      await integrationsApi.sync(pluginType)
    } catch (e) {
      alert('Sync failed: ' + (e.response?.data?.detail || e.message))
    }
  }

  const connectedCount = plugins.filter(p => p.is_enabled && p.status === 'connected').length

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-blue-600/20 flex items-center justify-center">
          <Plug size={20} className="text-blue-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Plugins & Integrations</h1>
          <p className="text-sm text-slate-400">Connect external systems to Kifaa for unified visibility</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-sm text-slate-400">
            {connectedCount} of {plugins.length} connected
          </span>
          <button onClick={load} className="flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-white">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center text-slate-400 py-16">Loading integrations...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {plugins.map(p => (
            <PluginCard
              key={p.plugin_type}
              plugin={p}
              onConfigure={setConfigModal}
              onSync={handleSync}
              onNavigate={navigate}
            />
          ))}
        </div>
      )}

      {configModal && (
        <ConfigModal
          plugin={configModal}
          onClose={() => setConfigModal(null)}
          onSaved={load}
        />
      )}
    </div>
  )
}
