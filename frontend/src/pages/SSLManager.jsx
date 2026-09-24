import { useEffect, useState } from 'react'
import { sslApi, agentsApi } from '../api/client'
import api from '../api/client'
import { Shield, Plus, Download, Upload, Trash2, X, Loader2, RefreshCw, AlertTriangle, CheckCircle2, XCircle, Lock, RotateCcw, ToggleLeft, ToggleRight, Server } from 'lucide-react'

const statusColor = {
  csr_pending:  'bg-yellow-500/20 text-yellow-400',
  active:       'bg-emerald-500/20 text-emerald-400',
  expired:      'bg-red-500/20 text-red-400',
  revoked:      'bg-slate-700 text-slate-400',
  superseded:   'bg-slate-700 text-slate-400',
}

function ExpiryCell({ validUntil, daysUntilExpiry }) {
  if (!validUntil) return <span className="text-slate-500">—</span>
  const date = new Date(validUntil).toLocaleDateString()
  if (daysUntilExpiry === null || daysUntilExpiry === undefined) return <span className="text-slate-400 text-xs">{date}</span>
  if (daysUntilExpiry < 0) return (
    <span className="text-red-400 text-xs flex items-center gap-1">
      <AlertTriangle size={11} /> {date} (expired)
    </span>
  )
  if (daysUntilExpiry <= 14) return (
    <span className="text-red-400 text-xs flex items-center gap-1 font-medium">
      <AlertTriangle size={11} /> {date} ({daysUntilExpiry}d left)
    </span>
  )
  if (daysUntilExpiry <= 30) return (
    <span className="text-yellow-400 text-xs flex items-center gap-1">
      <AlertTriangle size={11} /> {date} ({daysUntilExpiry}d left)
    </span>
  )
  return <span className="text-slate-400 text-xs">{date} ({daysUntilExpiry}d)</span>
}

function CreateCSRModal({ onClose, onCreated }) {
  const [form, setForm] = useState({
    name: '', common_name: '', san_names: '',
    organization: '', org_unit: '', country: 'KE',
    state: '', city: '', email: '',
    key_type: 'RSA', key_size: 2048, used_for: 'platform',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  useEffect(() => {
    api.get('/settings/system/general').then(r => {
      const g = r.data || {}
      setForm(f => ({
        ...f,
        organization: g.csr_organization || f.organization,
        org_unit:     g.csr_org_unit     || f.org_unit,
        country:      g.csr_country      || f.country,
        state:        g.csr_state        || f.state,
        city:         g.csr_city         || f.city,
        email:        g.csr_email        || f.email,
      }))
    }).catch(() => {})
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const payload = {
        ...form,
        san_names: form.san_names ? form.san_names.split(',').map(s => s.trim()).filter(Boolean) : [],
        key_size: parseInt(form.key_size),
      }
      const { data } = await sslApi.createCSR(payload)
      setResult(data)
      onCreated()
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to generate CSR')
    } finally {
      setLoading(false)
    }
  }

  function f(field) {
    return e => setForm({ ...form, [field]: e.target.value })
  }

  const inputClass = "w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"

  if (result) {
    return (
      <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
        <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-xl w-full">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">CSR Generated</h2>
            <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20} /></button>
          </div>
          <p className="text-sm text-slate-400 mb-4">
            Download this CSR and send it to your Certificate Authority. Once you receive the signed certificate, upload it back here.
          </p>
          <pre className="bg-slate-950 rounded-lg p-4 text-xs text-green-400 overflow-auto max-h-48 mb-4">
            {result.csr_content}
          </pre>
          <div className="flex gap-3">
            <a
              href={sslApi.downloadCSR(result.id)}
              download
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-lg"
            >
              <Download size={16} /> Download CSR
            </a>
            <a
              href={sslApi.downloadKey(result.id)}
              download
              className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-yellow-400 text-sm px-4 py-2 rounded-lg"
            >
              <Download size={16} /> Download Key
            </a>
            <button onClick={onClose} className="text-sm text-slate-400 hover:text-white px-4 py-2">
              Close
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-white">Generate CSR</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20} /></button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-xs text-slate-400 mb-1">Name (label for this cert)</label>
              <input className={inputClass} value={form.name} onChange={f('name')} placeholder="Platform SSL" required />
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-slate-400 mb-1">Common Name (CN)</label>
              <input className={inputClass} value={form.common_name} onChange={f('common_name')} placeholder="kifaa.kenyanut.com" required />
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-slate-400 mb-1">SANs (comma-separated: domain, IP)</label>
              <input className={inputClass} value={form.san_names} onChange={f('san_names')} placeholder="www.kifaa.kenyanut.com, 192.168.0.7" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Organization</label>
              <input className={inputClass} value={form.organization} onChange={f('organization')} placeholder="KenyaNut Ltd" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Org Unit</label>
              <input className={inputClass} value={form.org_unit} onChange={f('org_unit')} placeholder="IT" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Country (2-letter)</label>
              <input className={inputClass} value={form.country} onChange={f('country')} maxLength={2} placeholder="KE" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">State</label>
              <input className={inputClass} value={form.state} onChange={f('state')} placeholder="Nairobi" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">City</label>
              <input className={inputClass} value={form.city} onChange={f('city')} placeholder="Nairobi" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Email</label>
              <input className={inputClass} type="email" value={form.email} onChange={f('email')} placeholder="admin@example.com" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Key Type</label>
              <select className={inputClass} value={form.key_type} onChange={f('key_type')}>
                <option value="RSA">RSA</option>
                <option value="ECDSA">ECDSA (P-256)</option>
              </select>
            </div>
            {form.key_type === 'RSA' && (
              <div>
                <label className="block text-xs text-slate-400 mb-1">Key Size</label>
                <select className={inputClass} value={form.key_size} onChange={f('key_size')}>
                  <option value={2048}>2048 bit</option>
                  <option value={4096}>4096 bit</option>
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs text-slate-400 mb-1">Used For</label>
              <select className={inputClass} value={form.used_for} onChange={f('used_for')}>
                <option value="platform">Platform (Nginx)</option>
                <option value="agent">Agent TLS</option>
                <option value="monitoring">Monitoring</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          {error && (
            <div className="bg-red-900/30 border border-red-700 text-red-300 text-sm rounded-lg px-4 py-2">
              {error}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={loading}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-5 py-2.5 rounded-lg"
            >
              {loading && <Loader2 size={14} className="animate-spin" />}
              Generate CSR & Private Key
            </button>
            <button type="button" onClick={onClose} className="text-sm text-slate-400 hover:text-white px-4 py-2">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}

function UploadCertModal({ cert, onClose, onUploaded }) {
  const [file, setFile] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(null)

  const isKeyMismatch = error.toLowerCase().includes('does not match') || error.toLowerCase().includes('key match')

  async function handleUpload() {
    if (!file) return
    setLoading(true)
    setError('')
    setSuccess(null)
    try {
      const res = await sslApi.uploadCert(cert.id, file)
      setSuccess(res.data)
      onUploaded()
    } catch (err) {
      setError(err.response?.data?.detail || 'Upload failed')
    } finally {
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
        <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-md w-full">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">Certificate Uploaded</h2>
            <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20} /></button>
          </div>
          <div className="flex items-center gap-3 bg-green-900/30 border border-green-700 rounded-xl px-4 py-3 mb-4">
            <CheckCircle2 size={18} className="text-green-400 flex-shrink-0" />
            <div className="text-sm text-green-300">
              Certificate matches private key and has been activated.
            </div>
          </div>
          <div className="space-y-2 text-sm mb-5">
            <div className="flex justify-between">
              <span className="text-slate-400">Issued by</span>
              <span className="text-white font-mono text-xs">{success.issued_by}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Valid from</span>
              <span className="text-white text-xs">{new Date(success.valid_from).toLocaleDateString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Expires</span>
              <span className="text-white text-xs">{new Date(success.valid_until).toLocaleDateString()}</span>
            </div>
          </div>
          <button onClick={onClose} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg">Close</button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-md w-full">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Upload Signed Certificate</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20} /></button>
        </div>
        <p className="text-sm text-slate-400 mb-1">
          Upload the <strong className="text-white">.crt</strong> or <strong className="text-white">.pem</strong> file signed by your CA for:
        </p>
        <p className="text-blue-400 font-mono text-sm mb-4">{cert.common_name}</p>

        <div className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 mb-4 text-xs text-slate-400">
          The server will verify that the uploaded certificate matches the private key generated with the CSR for this record.
          Uploading a certificate from a different key pair will be rejected.
        </div>

        <input
          type="file"
          accept=".pem,.crt,.cer"
          onChange={e => { setFile(e.target.files[0]); setError('') }}
          className="block w-full text-sm text-slate-400 mb-4"
        />

        {error && (
          <div className={`rounded-xl px-4 py-3 mb-4 text-sm border ${
            isKeyMismatch
              ? 'bg-red-900/30 border-red-600 text-red-200'
              : 'bg-red-900/20 border-red-700/60 text-red-300'
          }`}>
            <div className="flex items-start gap-2">
              <XCircle size={16} className="text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-medium mb-0.5">
                  {isKeyMismatch ? 'Certificate / Key Mismatch' : 'Upload Failed'}
                </div>
                <div className="text-xs opacity-90">{error}</div>
                {isKeyMismatch && (
                  <div className="mt-2 text-xs text-red-300/70">
                    Make sure you are uploading the <strong>.crt</strong> returned by your CA for the CSR that was downloaded from <em>this</em> record — not a certificate from a different key pair.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={handleUpload}
            disabled={!file || loading}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            Upload & Verify
          </button>
          <button onClick={onClose} className="text-sm text-slate-400 hover:text-white px-4 py-2">Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ── Deploy certificate to agent modal ─────────────────────────────────────────

const SERVER_TYPES = [
  { value: 'nginx',        label: 'Nginx',            os: 'linux' },
  { value: 'apache2',      label: 'Apache2 (Debian)', os: 'linux' },
  { value: 'apache_httpd', label: 'Apache httpd (RHEL)', os: 'linux' },
  { value: 'ibm_http',     label: 'IBM HTTP Server',  os: 'linux' },
  { value: 'iis',          label: 'IIS (Windows)',    os: 'windows' },
  { value: 'other',        label: 'Other / Custom',   os: 'linux' },
]

const SERVER_DEFAULTS = {
  nginx:        { cert: '/etc/nginx/ssl/certs/{domain}.crt',    key: '/etc/nginx/ssl/private/{domain}.key',    service: 'nginx' },
  apache2:      { cert: '/etc/ssl/certs/{domain}.crt',           key: '/etc/ssl/private/{domain}.key',           service: 'apache2' },
  apache_httpd: { cert: '/etc/httpd/ssl/certs/{domain}.crt',     key: '/etc/httpd/ssl/private/{domain}.key',     service: 'httpd' },
  ibm_http:     { cert: '/opt/IBM/HTTPServer/ssl/{domain}.crt',  key: '/opt/IBM/HTTPServer/ssl/{domain}.key',    service: 'ibmhttpd' },
  iis:          { cert: '',                                       key: '',                                        service: 'W3SVC' },
  other:        { cert: '/etc/ssl/certs/{domain}.crt',           key: '/etc/ssl/private/{domain}.key',           service: '' },
}

function DeployModal({ cert, onClose }) {
  const [agents, setAgents]   = useState([])
  const [form, setForm]       = useState({
    agent_id: '', server_type: 'nginx',
    cert_path: '', key_path: '', service_name: '', restart_service: true,
  })
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const [result, setResult]   = useState(null)

  const inputClass = "w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
  const domain = cert.common_name

  useEffect(() => {
    agentsApi.list({ limit: 200 }).then(r => setAgents(r.data?.agents || r.data || [])).catch(() => {})
  }, [])

  function fillDefaults(serverType) {
    const d = SERVER_DEFAULTS[serverType] || SERVER_DEFAULTS.other
    const slug = domain.replace(/\./g, '_')
    setForm(f => ({
      ...f,
      server_type:  serverType,
      cert_path:    d.cert.replace('{domain}', slug),
      key_path:     d.key.replace('{domain}', slug),
      service_name: d.service,
    }))
  }

  // Pre-fill defaults on first render
  useEffect(() => { fillDefaults('nginx') }, [])

  async function handleDeploy(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const { data } = await sslApi.deploy(cert.id, {
        agent_id:        form.agent_id,
        server_type:     form.server_type,
        cert_path:       form.cert_path,
        key_path:        form.key_path,
        service_name:    form.service_name,
        restart_service: form.restart_service,
      })
      setResult(data)
    } catch (err) {
      setError(err.response?.data?.detail || 'Deployment failed')
    } finally {
      setLoading(false)
    }
  }

  const isIIS = form.server_type === 'iis'

  if (result) return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-md w-full">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <CheckCircle2 size={20} className="text-emerald-400" /> Deployed
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20} /></button>
        </div>
        <div className="bg-emerald-900/30 border border-emerald-700/50 rounded-xl px-4 py-3 text-emerald-300 text-sm mb-4">
          Certificate deployed to <strong>{result.agent}</strong>.
        </div>
        {result.cert_path && (
          <div className="text-xs text-slate-400 space-y-1 mb-4 font-mono">
            <div>Cert: <span className="text-slate-200">{result.cert_path}</span></div>
            <div>Key:  <span className="text-slate-200">{result.key_path}</span></div>
          </div>
        )}
        {result.service_restarted !== undefined && (
          <div className={`text-xs px-3 py-2 rounded-lg mb-3 ${result.service_restarted ? 'bg-emerald-900/20 text-emerald-400' : 'bg-yellow-900/20 text-yellow-400'}`}>
            Service restart: {result.service_restarted ? 'success' : `failed — ${result.service_restart_error || 'unknown error'}`}
          </div>
        )}
        <button onClick={onClose} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg">Close</button>
      </div>
    </div>
  )

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Server size={18} className="text-blue-400" /> Deploy Certificate to Server
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20} /></button>
        </div>

        <div className="bg-slate-800/60 rounded-xl px-4 py-2 mb-4 text-xs text-slate-400 font-mono">
          {domain}
        </div>

        <form onSubmit={handleDeploy} className="space-y-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Target Agent *</label>
            <select
              className={inputClass}
              value={form.agent_id}
              onChange={e => setForm({ ...form, agent_id: e.target.value })}
              required
            >
              <option value="">— Select agent —</option>
              {agents.map(a => (
                <option key={a.id} value={a.id}>
                  {a.display_name || a.hostname} ({a.ip_address || 'no IP'})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1">Web Server Type *</label>
            <select
              className={inputClass}
              value={form.server_type}
              onChange={e => fillDefaults(e.target.value)}
            >
              {SERVER_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {!isIIS && (
            <>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Certificate destination path *</label>
                <input
                  className={inputClass}
                  value={form.cert_path}
                  onChange={e => setForm({ ...form, cert_path: e.target.value })}
                  placeholder="/etc/nginx/ssl/certs/domain.crt"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Private key destination path *</label>
                <input
                  className={inputClass}
                  value={form.key_path}
                  onChange={e => setForm({ ...form, key_path: e.target.value })}
                  placeholder="/etc/nginx/ssl/private/domain.key"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Service name (systemctl restart)</label>
                <input
                  className={inputClass}
                  value={form.service_name}
                  onChange={e => setForm({ ...form, service_name: e.target.value })}
                  placeholder="nginx"
                />
              </div>
            </>
          )}

          {isIIS && (
            <div className="bg-blue-900/20 border border-blue-700/40 rounded-xl px-4 py-3 text-xs text-blue-300">
              IIS deployment converts the certificate to PFX and imports it into the Windows
              certificate store via WinRM, then binds it to the Default Web Site on port 443.
              Ensure WinRM credentials are configured for the selected agent.
            </div>
          )}

          <button
            type="button"
            onClick={() => setForm({ ...form, restart_service: !form.restart_service })}
            className="flex items-center gap-3 w-full text-left p-3 rounded-lg bg-slate-800 hover:bg-slate-700/60 border border-slate-700 transition-colors"
          >
            {form.restart_service
              ? <ToggleRight size={22} className="text-blue-400 flex-shrink-0" />
              : <ToggleLeft  size={22} className="text-slate-500 flex-shrink-0" />}
            <div>
              <div className="text-sm text-white">Restart service after deploy</div>
              <div className="text-xs text-slate-500">Sends systemctl restart to apply the new certificate</div>
            </div>
          </button>

          {error && (
            <div className="bg-red-900/30 border border-red-700 text-red-300 text-sm rounded-lg px-4 py-3">
              <XCircle size={14} className="inline mr-2" />{error}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={loading}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-5 py-2.5 rounded-lg"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <Server size={14} />}
              Deploy Certificate
            </button>
            <button type="button" onClick={onClose} className="text-sm text-slate-400 hover:text-white px-4 py-2">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Let's Encrypt modal ────────────────────────────────────────────────────────

function LetsEncryptModal({ onClose, onIssued, onDeploy }) {
  const [form, setForm] = useState({
    domain: '', extra_domains: '', email: '',
    staging: false, auto_renew: true,
  })
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState('')
  const [result, setResult]         = useState(null)
  const [preflight, setPreflight]   = useState(null)
  const [pfLoading, setPfLoading]   = useState(false)

  const inputClass = "w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
  const f = field => e => setForm({ ...form, [field]: e.target.value })
  const toggle = field => () => setForm({ ...form, [field]: !form[field] })

  async function runPreflight(domain) {
    if (!domain || !domain.includes('.')) return
    setPfLoading(true)
    setPreflight(null)
    try {
      const { data } = await sslApi.lePreflight(domain)
      setPreflight(data)
    } catch (e) {
      setPreflight({ ready: false, warnings: [e.response?.data?.detail || 'Preflight check failed'] })
    } finally {
      setPfLoading(false)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const payload = {
        domain:        form.domain.trim(),
        extra_domains: form.extra_domains ? form.extra_domains.split(',').map(s => s.trim()).filter(Boolean) : [],
        email:         form.email.trim(),
        staging:       form.staging,
        auto_renew:    form.auto_renew,
      }
      const { data } = await sslApi.leRequest(payload)
      setResult(data)
      onIssued()
    } catch (err) {
      setError(err.response?.data?.detail || 'Certificate request failed')
    } finally {
      setLoading(false)
    }
  }

  if (result) return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-md w-full">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <CheckCircle2 size={20} className="text-emerald-400" /> Certificate Issued
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20} /></button>
        </div>
        <div className="space-y-3 mb-5 text-sm">
          <div className="bg-emerald-900/30 border border-emerald-700/50 rounded-xl px-4 py-3 text-emerald-300">
            Let's Encrypt certificate successfully issued for <strong>{result.domain}</strong>.
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <span className="text-slate-400">Issued by</span>
            <span className="text-white">{result.issued_by}</span>
            <span className="text-slate-400">Expires</span>
            <span className="text-white">{new Date(result.valid_until).toLocaleDateString()} ({result.days_until_expiry}d)</span>
            <span className="text-slate-400">Auto-renewal</span>
            <span className={result.auto_renew ? 'text-emerald-400' : 'text-slate-400'}>{result.auto_renew ? 'Enabled' : 'Disabled'}</span>
          </div>
          <p className="text-xs text-slate-500">
            The certificate is stored on the server. Use <strong className="text-slate-300">Deploy to Server</strong> to push it to a specific web server agent.
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => { onClose(); onDeploy(result) }}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-lg"
          >
            <Server size={14} /> Deploy to Server
          </button>
          <button onClick={onClose} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg">Close</button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Lock size={18} className="text-emerald-400" /> Request Let's Encrypt Certificate
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20} /></button>
        </div>

        <div className="bg-blue-900/20 border border-blue-700/40 rounded-xl px-4 py-3 mb-4 text-xs text-blue-300">
          <strong>Prerequisites:</strong> The server must be reachable from the internet on port 80 for the ACME HTTP-01 challenge.
          Ensure your domain's DNS A record points to this server's public IP.
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Domain (CN) *</label>
            <div className="flex gap-2">
              <input
                className={inputClass}
                value={form.domain}
                onChange={f('domain')}
                onBlur={e => runPreflight(e.target.value.trim())}
                placeholder="kifaa.example.com"
                required
              />
              <button
                type="button"
                onClick={() => runPreflight(form.domain.trim())}
                disabled={pfLoading || !form.domain}
                className="flex-shrink-0 flex items-center gap-1.5 px-3 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 border border-slate-600 text-slate-300 text-xs rounded-lg"
                title="Check DNS and port 80 reachability"
              >
                {pfLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                Check
              </button>
            </div>
          </div>

          {/* Preflight result */}
          {pfLoading && (
            <div className="flex items-center gap-2 text-xs text-slate-400 px-1">
              <Loader2 size={12} className="animate-spin" /> Checking DNS and port 80…
            </div>
          )}
          {preflight && !pfLoading && (
            <div className={`rounded-xl border px-4 py-3 text-xs space-y-2 ${preflight.ready ? 'bg-emerald-900/20 border-emerald-700/50' : 'bg-yellow-900/20 border-yellow-700/50'}`}>
              <div className="flex items-center gap-2 font-medium">
                {preflight.ready
                  ? <><CheckCircle2 size={13} className="text-emerald-400" /><span className="text-emerald-300">Ready — DNS and port 80 look good</span></>
                  : <><AlertTriangle size={13} className="text-yellow-400" /><span className="text-yellow-300">Setup required before requesting certificate</span></>}
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-slate-400 font-mono">
                {preflight.domain_ip  && <><span>Domain resolves to</span><span className="text-white">{preflight.domain_ip}</span></>}
                {preflight.server_ip  && <><span>Server public IP</span><span className={preflight.dns_ok ? 'text-emerald-400' : 'text-red-400'}>{preflight.server_ip}</span></>}
                {preflight.domain_ip  && <><span>DNS match</span><span className={preflight.dns_ok ? 'text-emerald-400' : 'text-red-400'}>{preflight.dns_ok ? '✓ yes' : '✗ no'}</span></>}
                {preflight.domain_ip  && <><span>Port 80</span><span className={preflight.port_ok ? 'text-emerald-400' : preflight.behind_nat ? 'text-yellow-400' : 'text-red-400'}>{preflight.port_ok ? '✓ open' : preflight.behind_nat ? '? (behind NAT)' : '✗ closed'}</span></>}
                {preflight.behind_nat !== undefined && <><span>NAT detected</span><span className="text-slate-300">{preflight.behind_nat ? 'yes' : 'no'}</span></>}
              </div>
              {preflight.warnings?.length > 0 && (
                <div className="space-y-1 pt-1 border-t border-yellow-700/30">
                  {preflight.warnings.map((w, i) => <p key={i} className="text-yellow-300">{w}</p>)}
                </div>
              )}
              {preflight.suggestions?.length > 0 && (
                <div className="space-y-1">
                  {preflight.suggestions.map((s, i) => (
                    <p key={i} className="font-mono bg-slate-900/60 px-2 py-1 rounded text-slate-300">→ {s}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          <div>
            <label className="block text-xs text-slate-400 mb-1">Additional domains (comma-separated SANs)</label>
            <input className={inputClass} value={form.extra_domains} onChange={f('extra_domains')} placeholder="www.kifaa.example.com" />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Email (Let's Encrypt account / expiry notices) *</label>
            <input className={inputClass} type="email" value={form.email} onChange={f('email')} placeholder="admin@example.com" required />
          </div>

          <div className="space-y-2">
            {[
              { key: 'auto_renew', label: 'Auto-renew before expiry', sub: 'Automatically renews 30 days before expiry via scheduled task' },
              { key: 'staging',    label: 'Use staging (test only)', sub: "Uses Let's Encrypt staging — no rate limits but cert not trusted" },
            ].map(({ key, label, sub }) => (
              <button
                key={key}
                type="button"
                onClick={toggle(key)}
                className="flex items-center gap-3 w-full text-left p-3 rounded-lg bg-slate-800 hover:bg-slate-700/60 border border-slate-700 transition-colors"
              >
                {form[key]
                  ? <ToggleRight size={22} className="text-blue-400 flex-shrink-0" />
                  : <ToggleLeft  size={22} className="text-slate-500 flex-shrink-0" />}
                <div>
                  <div className="text-sm text-white">{label}</div>
                  <div className="text-xs text-slate-500">{sub}</div>
                </div>
              </button>
            ))}
          </div>

          {loading && (
            <div className="bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-300">
              <div className="flex items-center gap-2 mb-1">
                <Loader2 size={14} className="animate-spin text-blue-400" />
                <span>Requesting certificate from Let's Encrypt…</span>
              </div>
              <div className="text-xs text-slate-500">This may take up to 2 minutes. The server is completing the ACME challenge.</div>
            </div>
          )}

          {error && (
            <div className="bg-red-900/30 border border-red-700 text-red-300 text-sm rounded-lg px-4 py-3">
              <XCircle size={14} className="inline mr-2" />{error}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={loading}
              className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm px-5 py-2.5 rounded-lg"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
              Request Free Certificate
            </button>
            <button type="button" onClick={onClose} className="text-sm text-slate-400 hover:text-white px-4 py-2">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function SSLManager() {
  const [tab, setTab]         = useState('certs')   // 'certs' | 'letsencrypt'
  const [certs, setCerts] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [showLE, setShowLE]         = useState(false)
  const [uploadFor, setUploadFor] = useState(null)
  const [renewResult, setRenewResult] = useState(null)
  const [renewing, setRenewing] = useState(null)
  const [leRenewing, setLeRenewing] = useState(null)
  const [nginxReloading, setNginxReloading] = useState(false)
  const [deployFor, setDeployFor] = useState(null)  // cert object to deploy

  function loadCerts() {
    sslApi.list().then(r => setCerts(r.data)).finally(() => setLoading(false))
  }

  useEffect(() => { loadCerts() }, [])

  async function toggleAutoRenew(cert) {
    await sslApi.setAutoRenew(cert.id, !cert.auto_renew)
    loadCerts()
  }

  async function leRenewCert(cert) {
    if (!confirm(`Re-request a new Let's Encrypt certificate for ${cert.common_name}?`)) return
    setLeRenewing(cert.id)
    try {
      await sslApi.leRenew(cert.id)
      loadCerts()
    } catch (e) {
      alert(e.response?.data?.detail || 'Renewal failed')
    } finally {
      setLeRenewing(null)
    }
  }

  async function reloadNginx() {
    setNginxReloading(true)
    try {
      const { data } = await sslApi.leReloadNginx()
      alert(`nginx reloaded: ${data.message}`)
    } catch (e) {
      alert(e.response?.data?.detail || 'nginx reload failed')
    } finally {
      setNginxReloading(false)
    }
  }

  async function deleteCert(id) {
    if (!confirm('Delete this certificate and its private key? This cannot be undone.')) return
    await sslApi.delete(id)
    loadCerts()
  }

  async function renewCert(cert) {
    if (!confirm(`Generate a new CSR for ${cert.common_name}?\n\nThe current certificate will be marked superseded once the new one is signed and uploaded.`)) return
    setRenewing(cert.id)
    try {
      const { data } = await api.post(`/ssl/${cert.id}/renew`)
      setRenewResult(data)
      loadCerts()
    } catch (e) {
      alert(e.response?.data?.detail || 'Renewal failed')
    } finally {
      setRenewing(null)
    }
  }

  const leCerts = certs.filter(c => c.provider === 'letsencrypt')

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">SSL / Certificate Management</h1>
          <p className="text-sm text-slate-400 mt-0.5">Generate CSRs, manage keys, and get free certificates from Let's Encrypt</p>
        </div>
        <div className="flex gap-2">
          {tab === 'letsencrypt' && (
            <>
              <button
                onClick={reloadNginx}
                disabled={nginxReloading}
                className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 border border-slate-600 text-white text-sm px-3 py-2 rounded-lg"
                title="Send nginx -s reload to the nginx container"
              >
                {nginxReloading ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                Reload Nginx
              </button>
              <button
                onClick={() => setShowLE(true)}
                className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm px-4 py-2 rounded-lg"
              >
                <Lock size={16} /> Request Free Cert
              </button>
            </>
          )}
          {tab === 'certs' && (
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-lg"
            >
              <Plus size={16} /> Generate CSR
            </button>
          )}
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 mb-5 bg-slate-800/60 p-1 rounded-xl w-fit border border-slate-700/50">
        {[
          { key: 'letsencrypt', label: "Let's Encrypt", icon: Lock },
          { key: 'certs',       label: 'Manual / CSR',  icon: Shield },
        ].map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === key
                ? 'bg-slate-700 text-white shadow'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      {/* ── Let's Encrypt tab ─────────────────────────────────────────────── */}
      {tab === 'letsencrypt' && (
        <>
          <div className="bg-emerald-900/20 border border-emerald-700/40 rounded-xl p-4 mb-4 text-sm text-emerald-300">
            <strong>Free SSL from Let's Encrypt.</strong> Certificates are valid for 90 days and renew automatically.
            The server must be publicly reachable on port 80 to complete the ACME HTTP-01 challenge.
            Once issued, the cert is installed directly to Nginx — no manual steps required.
          </div>

          {/* Expiry warnings for LE certs */}
          {leCerts.filter(c => c.days_until_expiry !== null && c.days_until_expiry <= 30 && c.status === 'active').map(c => (
            <div key={c.id} className={`flex items-center gap-3 rounded-xl px-4 py-3 mb-3 text-sm border ${
              c.days_until_expiry <= 14
                ? 'bg-red-900/20 border-red-700/50 text-red-300'
                : 'bg-yellow-900/20 border-yellow-700/50 text-yellow-300'
            }`}>
              <AlertTriangle size={16} />
              <span><strong>{c.common_name}</strong> expires in <strong>{c.days_until_expiry}d</strong>.</span>
              <button
                onClick={() => leRenewCert(c)}
                disabled={leRenewing === c.id}
                className="ml-auto flex items-center gap-1.5 px-3 py-1 bg-yellow-600 hover:bg-yellow-500 disabled:opacity-50 text-white text-xs rounded-lg"
              >
                <RefreshCw size={11} className={leRenewing === c.id ? 'animate-spin' : ''} /> Renew Now
              </button>
            </div>
          ))}

          <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-slate-700 bg-slate-800/50">
                  <th className="px-5 py-3 font-medium">Domain</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Expires</th>
                  <th className="px-5 py-3 font-medium">Auto-renew</th>
                  <th className="px-5 py-3 font-medium">Environment</th>
                  <th className="px-5 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {leCerts.map(cert => (
                  <tr key={cert.id} className="border-b border-slate-800 hover:bg-slate-800/40">
                    <td className="px-5 py-3 text-white font-mono text-xs">{cert.common_name}</td>
                    <td className="px-5 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[cert.status] || 'bg-slate-700 text-slate-400'}`}>
                        {cert.status}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <ExpiryCell validUntil={cert.valid_until} daysUntilExpiry={cert.days_until_expiry} />
                    </td>
                    <td className="px-5 py-3">
                      <button
                        onClick={() => toggleAutoRenew(cert)}
                        className={`flex items-center gap-1.5 text-xs font-medium ${cert.auto_renew ? 'text-emerald-400 hover:text-emerald-300' : 'text-slate-500 hover:text-slate-400'}`}
                        title={cert.auto_renew ? 'Auto-renew on — click to disable' : 'Auto-renew off — click to enable'}
                      >
                        {cert.auto_renew
                          ? <ToggleRight size={18} />
                          : <ToggleLeft  size={18} />}
                        {cert.auto_renew ? 'On' : 'Off'}
                      </button>
                    </td>
                    <td className="px-5 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${cert.le_staging ? 'bg-yellow-900/40 text-yellow-400' : 'bg-emerald-900/30 text-emerald-400'}`}>
                        {cert.le_staging ? 'Staging' : 'Production'}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => setDeployFor(cert)}
                          className="text-blue-400 hover:text-blue-300 text-xs flex items-center gap-1"
                        >
                          <Server size={12} /> Deploy
                        </button>
                        <button
                          onClick={() => leRenewCert(cert)}
                          disabled={leRenewing === cert.id}
                          className="text-sky-400 hover:text-sky-300 disabled:opacity-40 text-xs flex items-center gap-1"
                        >
                          <RefreshCw size={12} className={leRenewing === cert.id ? 'animate-spin' : ''} /> Renew
                        </button>
                        <a href={sslApi.downloadCert(cert.id)} download className="text-emerald-400 hover:text-emerald-300 text-xs flex items-center gap-1">
                          <Download size={12} /> Cert
                        </a>
                        <a href={sslApi.downloadKey(cert.id)} download className="text-yellow-400 hover:text-yellow-300 text-xs flex items-center gap-1">
                          <Download size={12} /> Key
                        </a>
                      </div>
                    </td>
                  </tr>
                ))}
                {leCerts.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-5 py-14 text-center">
                      <Lock size={32} className="text-slate-700 mx-auto mb-3" />
                      <p className="text-slate-500 text-sm">No Let's Encrypt certificates yet.</p>
                      <p className="text-slate-600 text-xs mt-1">Click <strong className="text-slate-400">Request Free Cert</strong> to get a free 90-day SSL certificate.</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── Manual / CSR tab ──────────────────────────────────────────────── */}
      {tab === 'certs' && (<>
      {/* Info banner */}
      <div className="bg-blue-900/20 border border-blue-700/40 rounded-xl p-4 mb-4 text-sm text-blue-300">
        <strong>How it works:</strong> Generate a CSR → download and send to your CA (e.g. DigiCert, ZeroSSL) →
        upload the signed certificate back → it will be available for use in Nginx.
        To renew, click <strong>Renew</strong> on an active cert — a fresh CSR is generated with the same domain details.
      </div>

      {/* Expiry warnings */}
      {certs.filter(c => c.days_until_expiry !== null && c.days_until_expiry <= 30 && c.status === 'active').map(c => (
        <div key={c.id} className={`flex items-center gap-3 rounded-xl px-4 py-3 mb-3 text-sm border ${
          c.days_until_expiry <= 14
            ? 'bg-red-900/20 border-red-700/50 text-red-300'
            : 'bg-yellow-900/20 border-yellow-700/50 text-yellow-300'
        }`}>
          <AlertTriangle size={16} />
          <span>
            <strong>{c.common_name}</strong> expires in <strong>{c.days_until_expiry} day{c.days_until_expiry !== 1 ? 's' : ''}</strong>.
          </span>
          <button
            onClick={() => renewCert(c)}
            disabled={renewing === c.id}
            className="ml-auto flex items-center gap-1.5 px-3 py-1 bg-yellow-600 hover:bg-yellow-500 disabled:opacity-50 text-white text-xs rounded-lg font-medium transition-colors"
          >
            <RefreshCw size={11} className={renewing === c.id ? 'animate-spin' : ''} />
            Renew Now
          </button>
        </div>
      ))}

      <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-700 bg-slate-800/50">
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Common Name</th>
                <th className="px-5 py-3 font-medium">Type</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Expires</th>
                <th className="px-5 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {certs.map(cert => (
                <tr key={cert.id} className="border-b border-slate-800 hover:bg-slate-800/40">
                  <td className="px-5 py-3 text-white font-medium">{cert.name}</td>
                  <td className="px-5 py-3 text-slate-300 font-mono text-xs">{cert.common_name}</td>
                  <td className="px-5 py-3 text-slate-400 text-xs">{cert.key_type} {cert.key_size}</td>
                  <td className="px-5 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[cert.status] || 'bg-slate-700 text-slate-400'}`}>
                      {cert.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <ExpiryCell validUntil={cert.valid_until} daysUntilExpiry={cert.days_until_expiry} />
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      {cert.status === 'csr_pending' && (
                        <>
                          <a
                            href={sslApi.downloadCSR(cert.id)}
                            download
                            className="text-blue-400 hover:text-blue-300 text-xs flex items-center gap-1"
                          >
                            <Download size={13} /> CSR
                          </a>
                          <button
                            onClick={() => setUploadFor(cert)}
                            className="text-emerald-400 hover:text-emerald-300 text-xs flex items-center gap-1"
                          >
                            <Upload size={13} /> Upload Cert
                          </button>
                        </>
                      )}
                      {(cert.status === 'active' || cert.status === 'expired') && (
                        <>
                          <button
                            onClick={() => renewCert(cert)}
                            disabled={renewing === cert.id}
                            className="text-sky-400 hover:text-sky-300 disabled:opacity-40 text-xs flex items-center gap-1"
                            title="Renew — generate new CSR for the same domain"
                          >
                            <RefreshCw size={12} className={renewing === cert.id ? 'animate-spin' : ''} />
                            Renew
                          </button>
                          <a
                            href={sslApi.downloadCert(cert.id)}
                            download
                            className="text-emerald-400 hover:text-emerald-300 text-xs flex items-center gap-1"
                            title="Download certificate"
                          >
                            <Download size={13} /> Cert
                          </a>
                        </>
                      )}
                      <a
                        href={sslApi.downloadKey(cert.id)}
                        download
                        className="text-yellow-400 hover:text-yellow-300 text-xs flex items-center gap-1"
                        title="Download private key"
                      >
                        <Download size={13} /> Key
                      </a>
                      <button
                        onClick={() => deleteCert(cert.id)}
                        className="text-red-400 hover:text-red-300"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {certs.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-slate-500">
                    No certificates yet. Generate a CSR to get started.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      </>)}

      {showCreate && (
        <CreateCSRModal onClose={() => setShowCreate(false)} onCreated={loadCerts} />
      )}
      {showLE && (
        <LetsEncryptModal
          onClose={() => setShowLE(false)}
          onIssued={loadCerts}
          onDeploy={certData => {
            // After LE issue, open deploy modal. certData has {id, domain}
            // We need the full cert object — find it in certs list or build a minimal one
            const found = certs.find(c => c.id === certData.id)
            setDeployFor(found || { id: certData.id, common_name: certData.domain })
          }}
        />
      )}
      {deployFor && (
        <DeployModal cert={deployFor} onClose={() => setDeployFor(null)} />
      )}
      {uploadFor && (
        <UploadCertModal cert={uploadFor} onClose={() => setUploadFor(null)} onUploaded={loadCerts} />
      )}
      {renewResult && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-xl w-full">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-semibold text-white">Renewal CSR Generated</h2>
              <button onClick={() => setRenewResult(null)} className="text-slate-400 hover:text-white"><X size={20} /></button>
            </div>
            <p className="text-sm text-slate-400 mb-1">
              New CSR for <span className="text-white font-medium">{renewResult.common_name}</span>.
              The previous certificate is marked <span className="text-slate-300 font-medium">superseded</span> and stays active until you deploy the new one.
            </p>
            <p className="text-xs text-slate-500 mb-4">Send this CSR to your CA. Once you receive the signed certificate, use <strong className="text-slate-400">Upload Cert</strong> on the new row.</p>
            <pre className="bg-slate-950 rounded-lg p-4 text-xs text-green-400 overflow-auto max-h-40 mb-4">
              {renewResult.csr_content}
            </pre>
            <div className="flex gap-3">
              <a
                href={sslApi.downloadCSR(renewResult.id)}
                download
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-lg"
              >
                <Download size={16} /> Download CSR
              </a>
              <a
                href={sslApi.downloadKey(renewResult.id)}
                download
                className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-yellow-400 text-sm px-4 py-2 rounded-lg"
              >
                <Download size={16} /> Download Key
              </a>
              <button onClick={() => setRenewResult(null)} className="text-sm text-slate-400 hover:text-white px-4 py-2">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
