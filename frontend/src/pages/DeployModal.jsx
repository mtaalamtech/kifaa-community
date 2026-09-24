import { useState, useEffect, useRef } from 'react'
import {
  X, Terminal, Play, RefreshCw, Monitor, Server,
  Eye, EyeOff, Trash2, ChevronRight, Info, KeyRound, UserMinus,
  Wifi, WifiOff, CircleDot,
} from 'lucide-react'
import api from '../api/client'

const inputCls = "w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"

const STATUS_COLORS = {
  pending: 'text-slate-400',
  running: 'text-yellow-400',
  success: 'text-green-400',
  failed:  'text-red-400',
}

function LogLine({ line }) {
  const color =
    line.startsWith('[ERROR]') || line.startsWith('[ERR]') ? 'text-red-400' :
    line.startsWith('[SUCCESS]') ? 'text-green-400' :
    line.startsWith('[WARN]')    ? 'text-yellow-400' :
    line.startsWith('[RUN]')     ? 'text-blue-300' :
    line.startsWith('[INFO]')    ? 'text-slate-300' :
    'text-slate-500'
  return <div className={`${color} leading-relaxed`}>{line || '\u00A0'}</div>
}

// ── Live Log Viewer ──────────────────────────────────────────────────────────
function JobLogs({ job: initial, onBack }) {
  const [job, setJob] = useState(initial)
  const logRef = useRef(null)

  useEffect(() => {
    if (job.status !== 'pending' && job.status !== 'running') return
    const t = setInterval(async () => {
      try {
        const r = await api.get(`/deployment/jobs/${job.id}/logs`)
        setJob(j => ({ ...j, logs: r.data.logs, status: r.data.status }))
        if (r.data.status !== 'pending' && r.data.status !== 'running') clearInterval(t)
      } catch { clearInterval(t) }
    }, 1500)
    return () => clearInterval(t)
  }, [job.id, job.status])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [job.logs])

  const lines = (job.logs || '').split('\n')

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-slate-400 hover:text-white text-sm flex items-center gap-1">
          ← Back to history
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-white">{job.target_host}</span>
            <span className="text-xs text-slate-500 capitalize">{job.os_type}</span>
            <span className={`text-xs font-bold uppercase ${STATUS_COLORS[job.status]}`}>
              {job.status}
              {job.status === 'running' && <RefreshCw size={10} className="inline ml-1 animate-spin" />}
            </span>
          </div>
          <div className="text-xs text-slate-600 mt-0.5">
            {job.username}@{job.target_host}:{job.target_port}
            {job.started_at && ` · started ${new Date(job.started_at).toLocaleTimeString()}`}
            {job.finished_at && ` · finished ${new Date(job.finished_at).toLocaleTimeString()}`}
          </div>
        </div>
      </div>

      <div ref={logRef}
        className="bg-black border border-slate-700 rounded-xl p-4 h-[420px] overflow-y-auto font-mono text-xs space-y-0.5">
        {lines.length <= 1 && !lines[0]
          ? <div className="text-slate-600 italic">Waiting for deployment to start...</div>
          : lines.map((l, i) => <LogLine key={i} line={l} />)}
        {(job.status === 'pending' || job.status === 'running') && (
          <div className="text-slate-600 animate-pulse mt-1">▌</div>
        )}
      </div>
    </div>
  )
}

// ── API Reachability Checker ──────────────────────────────────────────────────
function ApiChecker() {
  const [state, setState] = useState('idle') // idle | checking | ok | error
  const [info, setInfo] = useState(null)

  async function check() {
    setState('checking')
    setInfo(null)
    try {
      const r = await api.get('/deployment/api-check')
      setInfo(r.data)
      setState(r.data.reachable ? 'ok' : 'error')
    } catch (e) {
      setInfo({ error: e.response?.data?.detail || e.message })
      setState('error')
    }
  }

  // Auto-check on mount
  useEffect(() => { check() }, [])

  return (
    <div className={`rounded-lg border px-3 py-2.5 flex items-center gap-3 text-sm transition-colors ${
      state === 'ok'       ? 'border-green-700/50 bg-green-900/20' :
      state === 'error'    ? 'border-red-700/50 bg-red-900/20' :
      state === 'checking' ? 'border-slate-700 bg-slate-900/40' :
                             'border-slate-700 bg-slate-900/40'
    }`}>
      <div className="flex-shrink-0">
        {state === 'checking' && <RefreshCw size={14} className="animate-spin text-slate-400" />}
        {state === 'ok'       && <Wifi size={14} className="text-green-400" />}
        {state === 'error'    && <WifiOff size={14} className="text-red-400" />}
        {state === 'idle'     && <CircleDot size={14} className="text-slate-500" />}
      </div>
      <div className="flex-1 min-w-0">
        {state === 'checking' && (
          <span className="text-slate-400 text-xs">Checking Kifaa API reachability…</span>
        )}
        {state === 'ok' && info && (
          <div>
            <span className="text-green-400 text-xs font-medium">API reachable</span>
            <span className="text-slate-500 text-xs ml-2">{info.server_url} · {info.latency_ms}ms</span>
          </div>
        )}
        {state === 'error' && info && (
          <div>
            <span className="text-red-400 text-xs font-medium">API unreachable</span>
            {info.server_url && (
              <span className="text-slate-500 text-xs ml-2">{info.server_url}</span>
            )}
            {info.error && (
              <div className="text-red-400/70 text-xs mt-0.5 truncate">{info.error}</div>
            )}
            <div className="text-amber-400/80 text-xs mt-0.5">
              Agent will deploy but may fail to register — check network/firewall to {info?.server_url}
            </div>
          </div>
        )}
        {state === 'idle' && (
          <span className="text-slate-500 text-xs">API not checked</span>
        )}
      </div>
      <button onClick={check} disabled={state === 'checking'}
        className="flex-shrink-0 text-xs text-slate-400 hover:text-white disabled:opacity-40 transition-colors px-1">
        <RefreshCw size={12} className={state === 'checking' ? 'animate-spin' : ''} />
      </button>
    </div>
  )
}

// ── Credential Picker ─────────────────────────────────────────────────────────
function CredentialPicker({ osType, onSelect }) {
  const [creds, setCreds] = useState([])
  const [loading, setLoading] = useState(true)
  const [value, setValue] = useState('')

  useEffect(() => {
    setLoading(true)
    api.get('/credentials')
      .then(r => {
        // Show credentials matching this OS or 'any'
        setCreds((r.data || []).filter(c => !c.os_type || c.os_type === 'any' || c.os_type === osType))
      })
      .catch(() => setCreds([]))
      .finally(() => setLoading(false))
  }, [osType])

  function handleChange(e) {
    const id = e.target.value
    setValue(id)
    if (!id) { onSelect(null); return }
    const cred = creds.find(c => c.id === id)
    if (cred) onSelect(cred)
  }

  return (
    <div className="bg-slate-900 border border-blue-700/40 rounded-lg p-3">
      <div className="flex items-center gap-2 mb-2">
        <KeyRound size={13} className="text-blue-400" />
        <span className="text-xs font-medium text-slate-300">Saved credential</span>
        <span className="text-xs text-slate-500 ml-auto">
          {loading ? 'Loading…' : creds.length === 0 ? 'None saved — add in Settings → Credentials' : `${creds.length} available`}
        </span>
      </div>
      <select value={value} onChange={handleChange} disabled={loading || creds.length === 0}
        className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed">
        <option value="">— enter manually —</option>
        {creds.map(c => (
          <option key={c.id} value={c.id}>
            {c.name} · {c.username}{c.domain ? `@${c.domain}` : ''}
            {c.use_sudo ? ' (sudo)' : ''}
          </option>
        ))}
      </select>
    </div>
  )
}

// ── Linux Deploy Form ─────────────────────────────────────────────────────────
function LinuxForm({ onDeployed }) {
  const [form, setForm] = useState({
    target_host: '', target_port: 22, username: 'root',
    auth_method: 'password', password: '', ssh_key: '',
    use_sudo: true, install_dir: '',
  })
  const [credentialId, setCredentialId] = useState(null)
  const [showPw, setShowPw] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [error, setError] = useState(null)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  function handleCredSelect(cred) {
    setCredentialId(cred?.id || null)
    if (cred) {
      setForm(f => ({
        ...f,
        username: cred.username || f.username,
        target_port: cred.port || f.target_port,
        use_sudo: cred.use_sudo,
        auth_method: cred.has_ssh_key ? 'key' : 'password',
      }))
    }
  }

  async function deploy() {
    if (!form.target_host || !form.username) { setError('Host and username are required'); return }
    setDeploying(true); setError(null)
    try {
      const r = await api.post('/deployment/deploy', {
        os_type: 'linux',
        target_host: form.target_host,
        target_port: parseInt(form.target_port) || 22,
        username: form.username,
        password: form.auth_method === 'password' ? form.password : '',
        ssh_key: form.auth_method === 'key' ? form.ssh_key : '',
        use_sudo: form.use_sudo,
        install_dir: form.install_dir,
        credential_id: credentialId || undefined,
      })
      onDeployed(r.data)
    } catch (e) {
      setError(e.response?.data?.detail || 'Failed to start deployment')
    } finally { setDeploying(false) }
  }

  return (
    <div className="space-y-4">
      {error && <div className="bg-red-900/40 border border-red-700 text-red-300 text-sm rounded-lg px-4 py-2">{error}</div>}

      <CredentialPicker osType="linux" onSelect={handleCredSelect} />

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className="text-xs text-slate-400 mb-1 block">Host / IP Address</label>
          <input value={form.target_host} onChange={e => set('target_host', e.target.value)}
            className={inputCls} placeholder="192.168.1.50 or hostname" autoFocus />
        </div>
        <div>
          <label className="text-xs text-slate-400 mb-1 block">SSH Port</label>
          <input type="number" value={form.target_port} onChange={e => set('target_port', e.target.value)}
            className={inputCls} />
        </div>
      </div>

      <div>
        <label className="text-xs text-slate-400 mb-1 block">Username</label>
        <input value={form.username} onChange={e => set('username', e.target.value)}
          className={inputCls} placeholder="root or deploy user" />
      </div>

      <div>
        <label className="text-xs text-slate-400 mb-2 block">Authentication</label>
        <div className="flex gap-2 mb-3">
          {[['password', 'Password'], ['key', 'SSH Private Key']].map(([v, l]) => (
            <button key={v} onClick={() => set('auth_method', v)}
              className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                form.auth_method === v ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-800 border-slate-600 text-slate-400 hover:text-white'
              }`}>{l}</button>
          ))}
        </div>
        {form.auth_method === 'password' ? (
          <div className="relative">
            <input type={showPw ? 'text' : 'password'} value={form.password}
              onChange={e => set('password', e.target.value)} className={inputCls} autoComplete="new-password" />
            <button onClick={() => setShowPw(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400">
              {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        ) : (
          <textarea value={form.ssh_key} onChange={e => set('ssh_key', e.target.value)}
            className={`${inputCls} font-mono h-24 resize-none text-xs`}
            placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;..." />
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-700">
        <div>
          <label className="text-xs text-slate-400 mb-1 block">Install Directory <span className="text-slate-600">(optional)</span></label>
          <input value={form.install_dir} onChange={e => set('install_dir', e.target.value)}
            className={inputCls} placeholder="/opt/kifaa-agent" />
        </div>
        <div className="flex items-end pb-2">
          <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-slate-300">
            <input type="checkbox" checked={form.use_sudo} onChange={e => set('use_sudo', e.target.checked)}
              className="w-4 h-4 rounded accent-blue-500" />
            Use sudo
          </label>
        </div>
      </div>

      <ApiChecker />

      <button onClick={deploy} disabled={deploying || !form.target_host || !form.username}
        className="w-full flex items-center justify-center gap-2 py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-xl transition-colors">
        {deploying ? <><RefreshCw size={15} className="animate-spin" /> Deploying...</> : <><Play size={15} /> Deploy to Linux</>}
      </button>
    </div>
  )
}

// ── Windows Deploy Form (PDQ-style) ───────────────────────────────────────────
function WindowsForm({ onDeployed }) {
  const [form, setForm] = useState({
    target_host: '', username: '', password: '', method: 'winrm',
  })
  const [credentialId, setCredentialId] = useState(null)
  const [showPw, setShowPw] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [error, setError] = useState(null)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  function handleCredSelect(cred) {
    setCredentialId(cred?.id || null)
    if (cred) {
      const user = cred.domain ? `${cred.domain}\\${cred.username}` : cred.username
      setForm(f => ({ ...f, username: user }))
    }
  }

  async function deploy() {
    if (!form.target_host || !form.username) {
      setError('Host and username are required')
      return
    }
    if (!form.password && !credentialId) {
      setError('Password or saved credential required')
      return
    }
    setDeploying(true); setError(null)
    try {
      const r = await api.post('/deployment/deploy', {
        os_type: 'windows',
        target_host: form.target_host,
        target_port: form.method === 'smb' ? 445 : 5985,
        username: form.username,
        password: form.password,
        deploy_method: form.method,
        credential_id: credentialId || undefined,
      })
      onDeployed(r.data)
    } catch (e) {
      setError(e.response?.data?.detail || 'Failed to start deployment')
    } finally { setDeploying(false) }
  }

  // Detect username format hint
  const userHint = form.username.includes('\\')
    ? `Domain account: ${form.username}`
    : form.username.startsWith('.')
    ? `Local account: ${form.username}`
    : form.username
    ? `Will connect as .\\${form.username} (local)`
    : null

  return (
    <div className="space-y-4">
      {error && <div className="bg-red-900/40 border border-red-700 text-red-300 text-sm rounded-lg px-4 py-2">{error}</div>}

      <CredentialPicker osType="windows" onSelect={handleCredSelect} />

      {/* Method selector */}
      <div>
        <label className="text-xs text-slate-400 mb-2 block">Deployment Method</label>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => set('method', 'winrm')}
            className={`p-3 rounded-lg border-2 text-left transition-all ${
              form.method === 'winrm'
                ? 'border-blue-500 bg-blue-600/10'
                : 'border-slate-700 bg-slate-800/50 hover:border-slate-500'
            }`}
          >
            <div className={`text-sm font-medium ${form.method === 'winrm' ? 'text-white' : 'text-slate-300'}`}>
              WinRM
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              Windows 8 / 2012 R2+<br />Port 5985 (HTTP)
            </div>
          </button>
          <button
            onClick={() => set('method', 'smb')}
            className={`p-3 rounded-lg border-2 text-left transition-all ${
              form.method === 'smb'
                ? 'border-purple-500 bg-purple-600/10'
                : 'border-slate-700 bg-slate-800/50 hover:border-slate-500'
            }`}
          >
            <div className={`text-sm font-medium ${form.method === 'smb' ? 'text-white' : 'text-slate-300'}`}>
              SMB / Legacy
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              Windows XP / 7 / 2003 / 2008<br />Port 445 (SMB)
            </div>
          </button>
        </div>
      </div>

      {/* How it works */}
      {form.method === 'winrm' ? (
        <div className="bg-slate-900 border border-slate-700 rounded-lg p-3 text-xs text-slate-400 space-y-1">
          <div className="font-medium text-slate-300 flex items-center gap-1.5"><Info size={12} /> How it works</div>
          <div>1. Connects via <strong className="text-slate-300">WinRM / PowerShell remoting</strong></div>
          <div>2. Downloads agent to <code className="text-blue-400">C:\Windows\Temp\kifaa\</code></div>
          <div>3. Installs as Windows service <code className="text-blue-400">KifaaAgent</code></div>
          <div>4. <strong className="text-slate-300">Cleans up temp files</strong> on success or failure</div>
        </div>
      ) : (
        <div className="bg-slate-900 border border-slate-700 rounded-lg p-3 text-xs text-slate-400 space-y-1">
          <div className="font-medium text-slate-300 flex items-center gap-1.5"><Info size={12} /> How it works (SMB)</div>
          <div>1. Connects to <strong className="text-slate-300">ADMIN$</strong> share via SMB (port 445)</div>
          <div>2. Copies agent binary to <code className="text-purple-400">C:\Windows\Temp\kifaa\</code></div>
          <div>3. Installs service via <strong className="text-slate-300">SCM/RPC</strong> — no PowerShell needed</div>
          <div>4. Starts <code className="text-purple-400">KifaaAgent</code> service automatically</div>
        </div>
      )}

      <div>
        <label className="text-xs text-slate-400 mb-1 block">Target Host / IP</label>
        <input value={form.target_host} onChange={e => set('target_host', e.target.value)}
          className={inputCls} placeholder="192.168.1.50 or hostname" autoFocus />
      </div>

      <div>
        <label className="text-xs text-slate-400 mb-1 block">Username</label>
        <input value={form.username} onChange={e => set('username', e.target.value)}
          className={inputCls} placeholder="Administrator  or  DOMAIN\User  or  .\localadmin"
          autoComplete="off" />
        {userHint && <p className="text-xs text-blue-400 mt-1">{userHint}</p>}
      </div>

      <div>
        <label className="text-xs text-slate-400 mb-1 block">Password</label>
        <div className="relative">
          <input type={showPw ? 'text' : 'password'} value={form.password}
            onChange={e => set('password', e.target.value)} className={inputCls} autoComplete="new-password" />
          <button onClick={() => setShowPw(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400">
            {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>

      {/* Prerequisites box */}
      {form.method === 'winrm' ? (
        <div className="bg-slate-900 border border-amber-800/50 rounded-lg p-3 text-xs text-amber-300/80 space-y-1">
          <div className="font-medium">WinRM prerequisite (run once on target as Administrator)</div>
          <code className="block bg-black/50 rounded px-2 py-1 text-green-400 mt-1 select-all">
            Enable-PSRemoting -Force
          </code>
          <div className="text-slate-500 mt-1">Or via CMD: <code className="text-slate-400">winrm quickconfig -q</code></div>
        </div>
      ) : (
        <div className="bg-slate-900 border border-purple-800/50 rounded-lg p-3 text-xs text-purple-300/80 space-y-1.5">
          <div className="font-medium">SMB / Legacy requirements</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-slate-400">
            <div>✓ Port <strong className="text-slate-300">445</strong> open (SMB)</div>
            <div>✓ <strong className="text-slate-300">ADMIN$</strong> share accessible</div>
            <div>✓ <strong className="text-slate-300">IPC$</strong> share accessible</div>
            <div>✓ Domain or local <strong className="text-slate-300">admin</strong> creds</div>
            <div>✓ File &amp; Printer Sharing enabled</div>
            <div>✓ Remote Service Management</div>
          </div>
          <div className="text-slate-500 mt-1">
            Enable via: <code className="text-slate-400">netsh firewall set service FILEANDPRINT enable</code>
          </div>
        </div>
      )}

      <ApiChecker />

      <button onClick={deploy} disabled={deploying || !form.target_host || !form.username || (!form.password && !credentialId)}
        className="w-full flex items-center justify-center gap-2 py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-xl transition-colors">
        {deploying ? <><RefreshCw size={15} className="animate-spin" /> Deploying...</> : <><Play size={15} /> Deploy to Windows ({form.method.toUpperCase()})</>}
      </button>
    </div>
  )
}

// ── Job History ───────────────────────────────────────────────────────────────
function JobHistory({ onSelect, refresh }) {
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await api.get('/deployment/jobs')
      setJobs(Array.isArray(r.data) ? r.data : [])
    } catch (e) {
      setError(e.response?.data?.detail || e.message || 'Failed to load history')
      setJobs([])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [refresh])

  async function del(e, id) {
    e.stopPropagation()
    try {
      await api.delete(`/deployment/jobs/${id}`)
      setJobs(j => j.filter(x => x.id !== id))
    } catch {}
  }

  if (loading) return (
    <div className="py-10 flex items-center justify-center gap-2 text-slate-500 text-sm">
      <RefreshCw size={14} className="animate-spin" /> Loading history…
    </div>
  )

  if (error) return (
    <div className="py-6 text-center space-y-3">
      <div className="text-red-400 text-sm">{error}</div>
      <button onClick={load} className="text-xs text-slate-400 hover:text-white underline">Retry</button>
    </div>
  )

  if (jobs.length === 0) return (
    <div className="py-10 text-center text-slate-600 text-sm">No deployment history yet</div>
  )

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-slate-500">{jobs.length} job{jobs.length !== 1 ? 's' : ''}</span>
        <button onClick={load} className="text-slate-500 hover:text-white transition-colors" title="Refresh">
          <RefreshCw size={13} />
        </button>
      </div>
      {jobs.map(j => (
        <div key={j.id}
          onClick={() => onSelect(j)}
          className="flex items-center gap-3 bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 hover:border-slate-500 transition-colors group cursor-pointer">
          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
            j.status === 'success' ? 'bg-green-400' :
            j.status === 'failed'  ? 'bg-red-400' :
            j.status === 'running' ? 'bg-yellow-400 animate-pulse' : 'bg-slate-500'
          }`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-white truncate">{j.target_host}</span>
              <span className="text-xs text-slate-500 capitalize bg-slate-700 px-1.5 py-0.5 rounded">
                {j.os_type}
              </span>
            </div>
            <div className="text-xs text-slate-500">
              {j.username ? `${j.username}@` : ''}{j.target_host}
              {j.created_at ? ` · ${new Date(j.created_at).toLocaleString()}` : ''}
            </div>
          </div>
          <span className={`text-xs font-bold uppercase flex-shrink-0 ${STATUS_COLORS[j.status] || 'text-slate-400'}`}>
            {j.status}
          </span>
          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={() => onSelect(j)} title="View logs"
              className="p-1.5 text-slate-400 hover:text-blue-400 hover:bg-slate-700 rounded-lg">
              <Terminal size={13} />
            </button>
            <button onClick={e => del(e, j.id)} title="Delete"
              className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-slate-700 rounded-lg">
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Remove Agent Form ─────────────────────────────────────────────────────────
function RemoveForm() {
  const [os, setOs] = useState('windows')
  const [form, setForm] = useState({ ip: '', username: '', password: '', domain: '' })
  const [removing, setRemoving] = useState(false)
  const [logs, setLogs] = useState([])
  const [done, setDone] = useState(false)
  const [showPwd, setShowPwd] = useState(false)
  const logRef = useRef(null)
  const wsRef = useRef(null)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  function remove() {
    if (!form.ip || !form.username || (!form.password && os === 'windows')) return
    setLogs([])
    setDone(false)
    setRemoving(true)

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const token = localStorage.getItem('access_token') || sessionStorage.getItem('access_token') || ''
    const ws = new WebSocket(`${proto}://${window.location.host}/api/agent-deploy/remove?token=${token}`)
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({
        targets: [{
          ip: form.ip,
          os,
          username: form.username,
          password: form.password,
          domain: form.domain || '',
        }],
        delete_from_db: true,
      }))
    }

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'log') setLogs(l => [...l, `[${msg.level.toUpperCase()}] ${msg.msg}`])
      if (msg.type === 'complete') { setDone(true); setRemoving(false) }
      if (msg.type === 'error') { setLogs(l => [...l, `[ERROR] ${msg.msg}`]); setRemoving(false) }
    }

    ws.onerror = () => {
      setLogs(l => [...l, '[ERROR] WebSocket connection failed'])
      setRemoving(false)
    }

    ws.onclose = () => { wsRef.current = null }
  }

  const successCount = done ? logs.filter(l => l.includes('[SUCCESS]')).length : 0

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {[
          { val: 'windows', label: 'Windows', sub: 'SMB · domain or local admin', icon: Monitor },
          { val: 'linux',   label: 'Linux',   sub: 'SSH · root or sudo user',     icon: Server },
        ].map(({ val, label, sub, icon: Icon }) => (
          <button key={val} onClick={() => setOs(val)}
            className={`flex items-center gap-3 p-3.5 rounded-xl border-2 text-left transition-all ${
              os === val ? 'border-red-500 bg-red-600/10 text-white' : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-500'
            }`}>
            <Icon size={18} className={os === val ? 'text-red-400' : ''} />
            <div>
              <div className="font-medium text-sm">{label}</div>
              <div className="text-xs opacity-60">{sub}</div>
            </div>
          </button>
        ))}
      </div>

      <div>
        <label className="block text-xs text-slate-400 mb-1 font-medium uppercase tracking-wide">Target IP / Hostname</label>
        <input className={inputCls} value={form.ip} onChange={e => setForm(f => ({ ...f, ip: e.target.value }))}
          placeholder="192.168.0.48" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-slate-400 mb-1 font-medium uppercase tracking-wide">Username</label>
          <input className={inputCls} value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
            placeholder={os === 'windows' ? 'Administrator' : 'root'} />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1 font-medium uppercase tracking-wide">Password</label>
          <div className="relative">
            <input className={inputCls + ' pr-9'} type={showPwd ? 'text' : 'password'}
              value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
            <button type="button" onClick={() => setShowPwd(v => !v)}
              className="absolute right-2.5 top-2 text-slate-400 hover:text-white">
              {showPwd ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>
      </div>
      {os === 'windows' && (
        <div>
          <label className="block text-xs text-slate-400 mb-1 font-medium uppercase tracking-wide">Domain (optional)</label>
          <input className={inputCls} value={form.domain} onChange={e => setForm(f => ({ ...f, domain: e.target.value }))}
            placeholder="KENYANUT" />
        </div>
      )}

      {logs.length > 0 && (
        <div ref={logRef}
          className="bg-black/40 border border-slate-700 rounded-lg p-3 h-40 overflow-y-auto font-mono text-xs space-y-0.5">
          {logs.map((l, i) => (
            <div key={i} className={
              l.includes('[ERROR]') ? 'text-red-400' :
              l.includes('[SUCCESS]') ? 'text-green-400' :
              l.includes('[WARN]') ? 'text-yellow-400' : 'text-slate-400'
            }>{l}</div>
          ))}
          {done && (
            <div className={`mt-1 font-semibold ${successCount > 0 ? 'text-green-400' : 'text-yellow-400'}`}>
              {successCount > 0 ? '✓ Agent removed successfully' : '⚠ Removal completed with warnings'}
            </div>
          )}
        </div>
      )}

      <div className="bg-red-950/30 border border-red-800/40 rounded-xl p-3">
        <p className="text-xs text-red-300 font-medium mb-1">⚠ This will permanently:</p>
        <ul className="text-xs text-red-400 space-y-0.5 list-disc list-inside">
          <li>Stop and delete the KifaaAgent service</li>
          <li>Delete all agent files and config from the target</li>
          <li>Remove the agent from the Kifaa dashboard</li>
        </ul>
      </div>

      <button onClick={remove} disabled={removing || !form.ip || !form.username}
        className="w-full py-2.5 text-sm font-medium bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-lg transition-colors flex items-center justify-center gap-2">
        {removing ? <><RefreshCw size={14} className="animate-spin" /> Removing...</> : <><UserMinus size={14} /> Remove Agent</>}
      </button>
    </div>
  )
}

// ── Main Modal ────────────────────────────────────────────────────────────────
export default function DeployModal({ onClose }) {
  const [os, setOs] = useState('windows')
  const [view, setView] = useState('deploy')   // deploy | history | logs | remove
  const [viewingJob, setViewingJob] = useState(null)
  const [historyRefresh, setHistoryRefresh] = useState(0)

  function handleDeployed(job) {
    setViewingJob(job)
    setView('logs')
    setHistoryRefresh(n => n + 1)
  }

  const isRemove = view === 'remove'

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-lg max-h-[92vh] flex flex-col">

        {/* Header */}
        <div className="p-5 border-b border-slate-700 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="font-semibold text-white flex items-center gap-2">
              {isRemove
                ? <><UserMinus size={16} className="text-red-400" /> Remove Kifaa Agent</>
                : <><Terminal size={16} className="text-blue-400" /> Deploy Kifaa Agent</>}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {isRemove ? 'Uninstall agent remotely' : 'Remote agent deployment'}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>

        {/* Sub-tabs */}
        <div className="flex border-b border-slate-700 flex-shrink-0">
          <button onClick={() => setView('deploy')}
            className={`flex-1 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              view === 'deploy' ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-400 hover:text-white'
            }`}>
            Deploy
          </button>
          <button onClick={() => { setView('history'); setViewingJob(null) }}
            className={`flex-1 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              view === 'history' || view === 'logs' ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-400 hover:text-white'
            }`}>
            History
          </button>
          <button onClick={() => setView('remove')}
            className={`flex-1 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              view === 'remove' ? 'border-red-500 text-red-400' : 'border-transparent text-slate-400 hover:text-white'
            }`}>
            Remove
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {view === 'deploy' && (
            <div className="space-y-4">
              {/* OS Picker */}
              <div className="grid grid-cols-2 gap-3">
                {[
                  { val: 'windows', label: 'Windows', sub: 'WinRM or SMB · domain or local admin', icon: Monitor },
                  { val: 'linux',   label: 'Linux',   sub: 'SSH · root or sudo user',       icon: Server },
                ].map(({ val, label, sub, icon: Icon }) => (
                  <button key={val} onClick={() => setOs(val)}
                    className={`flex items-center gap-3 p-3.5 rounded-xl border-2 text-left transition-all ${
                      os === val ? 'border-blue-500 bg-blue-600/10 text-white' : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-500'
                    }`}>
                    <Icon size={18} className={os === val ? 'text-blue-400' : ''} />
                    <div>
                      <div className="font-medium text-sm">{label}</div>
                      <div className="text-xs opacity-60">{sub}</div>
                    </div>
                  </button>
                ))}
              </div>

              {os === 'windows' ? <WindowsForm onDeployed={handleDeployed} /> : <LinuxForm onDeployed={handleDeployed} />}
            </div>
          )}

          {view === 'history' && (
            <JobHistory onSelect={j => { setViewingJob(j); setView('logs') }} refresh={historyRefresh} />
          )}

          {view === 'logs' && viewingJob && (
            <JobLogs job={viewingJob} onBack={() => setView('history')} />
          )}

          {view === 'remove' && <RemoveForm />}
        </div>
      </div>
    </div>
  )
}
