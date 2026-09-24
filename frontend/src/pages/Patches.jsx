import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ShieldCheck, RefreshCw, Server, AlertTriangle, CheckCircle2,
  ChevronDown, ChevronRight, Play, Trash2, Clock,
  Terminal, X, Download, Loader2, RotateCcw, History,
  CalendarClock, Pencil, Plus,
} from 'lucide-react'
import api from '../api/client'
import { patchSchedulesApi } from '../api/client'

// ── Helpers ────────────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const map = {
    running:    'bg-blue-900/40 text-blue-300 border-blue-700',
    success:    'bg-green-900/40 text-green-400 border-green-800',
    failed:     'bg-red-900/40 text-red-400 border-red-800',
    pending:    'bg-slate-700 text-slate-300 border-slate-600',
    timed_out:  'bg-orange-900/40 text-orange-400 border-orange-800',
  }
  return <span className={`px-2 py-0.5 rounded-full text-xs border font-medium ${map[status] || map.pending}`}>{status}</span>
}

function CategoryBadge({ cat }) {
  if (cat === 'security') return <span className="px-1.5 py-0.5 rounded text-xs bg-red-900/40 text-red-400 border border-red-800">security</span>
  return <span className="px-1.5 py-0.5 rounded text-xs bg-slate-700 text-slate-400 border border-slate-600">{cat || 'upgrade'}</span>
}

// ── Credential Modal ───────────────────────────────────────────────────────────

function CredentialModal({ agent, onClose, onSaved }) {
  const [form, setForm] = useState({
    connect_type: 'linux', username: '', password: '', ssh_key: '',
    port: 22, use_sudo: true, host_override: '', winrm_port: 5985, domain: '',
  })
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    api.get(`/patches/credentials/${agent.id}`).then(r => {
      if (r.data && r.data.username) {
        setForm(f => ({ ...f, ...r.data, password: '', ssh_key: '' }))
      }
      setLoaded(true)
    })
  }, [agent.id])

  const f = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  async function save() {
    setSaving(true)
    try {
      await api.put(`/patches/credentials/${agent.id}`, form)
      onSaved()
      onClose()
    } finally { setSaving(false) }
  }

  if (!loaded) return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-8 text-slate-400">Loading…</div>
    </div>
  )

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <h2 className="font-semibold text-white flex items-center gap-2">
            <Settings size={16} className="text-blue-400" />
            SSH / WinRM Credentials — {agent.hostname}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Connection Type</label>
            <select value={form.connect_type} onChange={e => f('connect_type', e.target.value)}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
              <option value="linux">Linux (SSH)</option>
              <option value="windows_winrm">Windows WinRM (Win 8 / Server 2012+)</option>
              <option value="windows_smb">Windows SMB Legacy (XP / 7 / 2003 / 2008)</option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Host Override <span className="text-slate-600">(optional)</span></label>
              <input value={form.host_override} onChange={e => f('host_override', e.target.value)}
                placeholder="Use agent IP if blank"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                {form.connect_type === 'windows_winrm' ? 'WinRM Port' : 'SSH Port'}
              </label>
              <input type="number" value={form.connect_type === 'windows_winrm' ? form.winrm_port : form.port}
                onChange={e => f(form.connect_type === 'windows_winrm' ? 'winrm_port' : 'port', Number(e.target.value))}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Username</label>
              <input value={form.username} onChange={e => f('username', e.target.value)}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Password {form.connect_type === 'linux' && <span className="text-slate-600">(or use SSH key)</span>}
              </label>
              <input type="password" value={form.password} onChange={e => f('password', e.target.value)}
                placeholder="Leave blank to keep saved"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            </div>
          </div>

          {form.connect_type !== 'linux' && (
            <div>
              <label className="block text-xs text-slate-400 mb-1">Domain <span className="text-slate-600">(optional)</span></label>
              <input value={form.domain} onChange={e => f('domain', e.target.value)}
                placeholder="CORP or leave blank for local account"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            </div>
          )}

          {form.connect_type === 'linux' && (
            <>
              <div>
                <label className="block text-xs text-slate-400 mb-1">SSH Private Key <span className="text-slate-600">(optional)</span></label>
                <textarea value={form.ssh_key} onChange={e => f('ssh_key', e.target.value)}
                  rows={3} placeholder="Paste PEM key here, or leave blank to use password"
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-blue-500 resize-none" />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.use_sudo} onChange={e => f('use_sudo', e.target.checked)}
                  className="rounded border-slate-600 bg-slate-900" />
                <span className="text-sm text-slate-300">Use sudo for package manager commands</span>
              </label>
            </>
          )}

          {form.connect_type === 'windows_smb' && (
            <div className="bg-yellow-900/20 border border-yellow-800 rounded-lg px-4 py-3 text-xs text-yellow-300">
              SMB/Legacy scan provides limited info (OS patch level only). Full update enumeration requires WinRM.
            </div>
          )}
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-700">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
          <button onClick={save} disabled={saving || !form.username}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm rounded-lg">
            {saving ? 'Saving…' : 'Save Credentials'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Job Output Modal ───────────────────────────────────────────────────────────

function JobOutputModal({ jobId, onClose }) {
  const [job, setJob] = useState(null)
  const outputRef = useRef(null)
  const pollRef = useRef(null)

  const fetchJob = useCallback(async () => {
    try {
      const r = await api.get(`/patches/jobs/${jobId}`)
      setJob(r.data)
      if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
      if (['success', 'failed', 'timed_out'].includes(r.data.status)) {
        clearInterval(pollRef.current)
      }
    } catch {}
  }, [jobId])

  useEffect(() => {
    fetchJob()
    pollRef.current = setInterval(fetchJob, 2000)
    return () => clearInterval(pollRef.current)
  }, [fetchJob])

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-3xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700">
          <div className="flex items-center gap-3">
            <Terminal size={15} className="text-green-400" />
            <span className="text-sm font-medium text-white">Job Output</span>
            {job && <StatusBadge status={job.status} />}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>
        <div ref={outputRef} className="flex-1 overflow-auto p-4 font-mono text-xs text-green-300 bg-black/40 whitespace-pre-wrap break-all">
          {job
            ? (job.output
                ? job.output.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
                : job.status === 'timed_out'
                  ? '(job timed out — agent did not report output within 2 hours)'
                  : '(waiting for output…)')
            : 'Loading…'}
        </div>
        {job && ['running', 'pending'].includes(job.status) && (
          <div className="px-5 py-2 border-t border-slate-700 text-xs text-slate-500 flex items-center gap-2">
            <Loader2 size={12} className="animate-spin" /> Running — agent will report output when complete…
          </div>
        )}
      </div>
    </div>
  )
}

// ── Agent Updates Drawer ───────────────────────────────────────────────────────

function AgentUpdatesDrawer({ agent, onClose, onApply }) {
  const [updates, setUpdates] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(new Set())
  const [applying, setApplying] = useState(false)
  const [filter, setFilter] = useState('all')
  const [rebootAfter, setRebootAfter] = useState(false)
  const [rebootMode, setRebootMode] = useState('announced')
  const [rebootDelay, setRebootDelay] = useState(60)

  useEffect(() => {
    api.get(`/patches/agents/${agent.id}/updates`).then(r => {
      setUpdates(r.data)
      setLoading(false)
    })
  }, [agent.id])

  const filtered = filter === 'all' ? updates : updates.filter(u => u.category === filter)

  // Use KB number as the apply identifier for Windows patches; fall back to package_name for Linux
  function patchKey(u) {
    return (u.current_version && u.current_version.startsWith('KB')) ? u.current_version : u.package_name
  }

  function toggleAll() {
    if (selected.size === filtered.length) setSelected(new Set())
    else setSelected(new Set(filtered.map(u => patchKey(u))))
  }

  async function applySelected() {
    if (selected.size === 0) return
    setApplying(true)
    try {
      const r = await api.post('/patches/apply', {
        agent_id: agent.id,
        packages: [...selected],
        reboot_after: rebootAfter,
        reboot_mode: rebootMode,
        reboot_delay_seconds: rebootDelay,
      })
      onApply(r.data.job_id)
      onClose()
    } finally { setApplying(false) }
  }

  const secCount = updates.filter(u => u.category === 'security').length

  return (
    <div className="fixed inset-0 bg-black/60 flex justify-end z-40">
      <div className="bg-slate-800 border-l border-slate-700 w-full max-w-xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
          <div>
            <h3 className="font-semibold text-white">{agent.hostname}</h3>
            <p className="text-xs text-slate-400 mt-0.5">{updates.length} pending update{updates.length !== 1 ? 's' : ''}{secCount > 0 ? ` · ${secCount} security` : ''}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>

        <div className="px-5 py-3 border-b border-slate-700 flex items-center gap-3">
          <select value={filter} onChange={e => setFilter(e.target.value)}
            className="bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none">
            <option value="all">All Categories</option>
            <option value="security">Security</option>
            <option value="upgrade">Upgrades</option>
            <option value="unknown">Unknown</option>
          </select>
          <span className="text-xs text-slate-500">{selected.size} selected</span>
          <button onClick={toggleAll} className="text-xs text-blue-400 hover:text-blue-300 ml-auto">
            {selected.size === filtered.length ? 'Deselect All' : 'Select All'}
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="py-12 text-center text-slate-500">Loading updates…</div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center text-slate-500">
              {updates.length === 0 ? 'No pending updates — system is up to date' : 'No updates match filter'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-400 uppercase border-b border-slate-700">
                  <th className="px-4 py-2 w-8"></th>
                  <th className="px-4 py-2 text-left">Update Description</th>
                  <th className="px-4 py-2 text-left">KB / Severity</th>
                  <th className="px-4 py-2 text-left">Category</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {filtered.map(u => (
                  <tr key={u.id} className={`hover:bg-slate-700/30 cursor-pointer ${selected.has(patchKey(u)) ? 'bg-blue-900/10' : ''}`}
                    onClick={() => setSelected(s => { const n = new Set(s); const k = patchKey(u); n.has(k) ? n.delete(k) : n.add(k); return n })}>
                    <td className="px-4 py-2">
                      <input type="checkbox" readOnly checked={selected.has(patchKey(u))}
                        className="rounded border-slate-600 bg-slate-900" />
                    </td>
                    <td className="px-4 py-2 text-xs text-white max-w-md">
                      <div className="font-medium">{u.package_name}</div>
                      {u.description && u.description !== u.package_name && (
                        <div className="text-slate-400 mt-0.5 truncate max-w-sm" title={u.description}>{u.description}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {u.current_version && <div className="font-mono text-slate-300">{u.current_version}</div>}
                      {u.available_version && u.available_version !== 'Unknown' && (
                        <div className="text-slate-500">{u.available_version}</div>
                      )}
                    </td>
                    <td className="px-4 py-2"><CategoryBadge cat={u.category} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Reboot options */}
        <div className="px-5 py-3 border-t border-slate-700 bg-slate-800/60">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={rebootAfter} onChange={e => setRebootAfter(e.target.checked)}
              className="rounded border-slate-600 bg-slate-900 accent-blue-500" />
            <span className="text-xs text-slate-300 font-medium">Reboot after patching</span>
          </label>
          {rebootAfter && (
            <div className="mt-2 flex items-center gap-3 pl-5">
              <div className="flex gap-1">
                {['silent', 'announced'].map(m => (
                  <button key={m} onClick={() => setRebootMode(m)}
                    className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors ${rebootMode === m
                      ? 'bg-blue-600 border-blue-500 text-white'
                      : 'bg-slate-700 border-slate-600 text-slate-300 hover:bg-slate-600'}`}>
                    {m.charAt(0).toUpperCase() + m.slice(1)}
                  </button>
                ))}
              </div>
              {rebootMode === 'announced' && (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-slate-400">Delay</span>
                  <input type="number" min={30} max={3600} value={rebootDelay}
                    onChange={e => setRebootDelay(Number(e.target.value))}
                    className="w-16 bg-slate-700 border border-slate-600 rounded px-2 py-0.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
                  <span className="text-xs text-slate-400">sec</span>
                </div>
              )}
              <span className="text-xs text-yellow-400 ml-auto">⚠ Will reboot on success</span>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-slate-700 flex items-center justify-between">
          <span className="text-xs text-slate-500">
            {agent.last_scanned ? `Last scanned: ${new Date(agent.last_scanned).toLocaleString()}` : 'Not yet scanned'}
          </span>
          <button onClick={applySelected} disabled={selected.size === 0 || applying}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-40 text-white text-sm rounded-lg">
            {applying ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            Apply {selected.size > 0 ? `(${selected.size})` : 'Selected'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Update History Drawer ──────────────────────────────────────────────────────

function UpdateHistoryDrawer({ agent, onClose }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    api.get(`/patches/agents/${agent.id}/update-history`).then(r => {
      setItems(r.data || [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [agent.id])

  const filtered = filter === 'all' ? items : items.filter(i => i.category === filter)

  function ResultBadge({ result }) {
    if (result === 'success') return <span className="px-1.5 py-0.5 rounded text-xs bg-green-900/40 text-green-400 border border-green-800">success</span>
    if (result === 'failed') return <span className="px-1.5 py-0.5 rounded text-xs bg-red-900/40 text-red-400 border border-red-800">failed</span>
    if (result === 'aborted') return <span className="px-1.5 py-0.5 rounded text-xs bg-orange-900/40 text-orange-400 border border-orange-800">aborted</span>
    if (result === 'success_with_errors') return <span className="px-1.5 py-0.5 rounded text-xs bg-yellow-900/40 text-yellow-400 border border-yellow-800">partial</span>
    return <span className="px-1.5 py-0.5 rounded text-xs bg-slate-700 text-slate-400 border border-slate-600">{result || '—'}</span>
  }

  const categories = [...new Set(items.map(i => i.category).filter(Boolean))]

  return (
    <div className="fixed inset-0 bg-black/60 flex justify-end z-40">
      <div className="bg-slate-800 border-l border-slate-700 w-full max-w-2xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
          <div>
            <h3 className="font-semibold text-white flex items-center gap-2">
              <History size={16} className="text-blue-400" />
              Update History — {agent.hostname}
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">{items.length} update record{items.length !== 1 ? 's' : ''}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>

        <div className="px-5 py-3 border-b border-slate-700 flex items-center gap-3">
          <select value={filter} onChange={e => setFilter(e.target.value)}
            className="bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none">
            <option value="all">All Categories</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <span className="text-xs text-slate-500">{filtered.length} shown</span>
        </div>

        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="py-12 text-center text-slate-500">Loading history…</div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center text-slate-500">
              {items.length === 0 ? 'No update history — agent may not have reported yet' : 'No records match filter'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-400 uppercase border-b border-slate-700 bg-slate-800/60">
                  <th className="px-4 py-2 text-left">Title / Package</th>
                  <th className="px-4 py-2 text-left">KB</th>
                  <th className="px-4 py-2 text-left">Category</th>
                  <th className="px-4 py-2 text-left">Result</th>
                  <th className="px-4 py-2 text-left">Installed At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {filtered.map((it, idx) => (
                  <tr key={idx} className="hover:bg-slate-700/30">
                    <td className="px-4 py-2 text-xs text-white max-w-xs">
                      <div className="truncate" title={it.title}>{it.title || '—'}</div>
                    </td>
                    <td className="px-4 py-2 text-xs font-mono text-slate-300">
                      {it.kb || <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <CategoryBadge cat={it.category} />
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <ResultBadge result={it.result} />
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-400">
                      {it.installed_at
                        ? new Date(it.installed_at).toLocaleString()
                        : <span className="text-slate-600">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Agents Tab ─────────────────────────────────────────────────────────────────

function AgentsTab() {
  const [agents, setAgents] = useState([])
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(new Set())
  const [scanMsg, setScanMsg] = useState({})
  const [updatesAgent, setUpdatesAgent] = useState(null)
  const [historyAgent, setHistoryAgent] = useState(null)
  const [viewJobId, setViewJobId] = useState(null)
  const [scanningAll, setScanningAll] = useState(false)
  const [scanAllMsg, setScanAllMsg] = useState('')
  const [search, setSearch] = useState('')
  const [filterGroup, setFilterGroup] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = filterGroup ? { group_id: filterGroup } : {}
      const [r, gr] = await Promise.all([
        api.get('/patches/agents', { params }),
        api.get('/groups'),
      ])
      setAgents(r.data)
      setGroups(gr.data)
    } finally { setLoading(false) }
  }, [filterGroup])

  useEffect(() => { load() }, [load])

  // Auto-refresh every 5s while any agent is actively being patched
  useEffect(() => {
    const anyPatching = agents.some(a => a.is_patching)
    if (!anyPatching) return
    const id = setInterval(() => {
      const params = filterGroup ? { group_id: filterGroup } : {}
      api.get('/patches/agents', { params }).then(r => setAgents(r.data)).catch(() => {})
    }, 5000)
    return () => clearInterval(id)
  }, [agents, filterGroup])

  async function scan(agentId) {
    setScanning(s => new Set(s).add(agentId))
    try {
      const r = await api.post(`/patches/scan/${agentId}`)
      if (r.data.method === 'agent_pull') {
        setScanMsg(m => ({ ...m, [agentId]: 'Queued — results after next heartbeat (~60s)' }))
        setTimeout(() => setScanMsg(m => { const n = {...m}; delete n[agentId]; return n }), 8000)
        setTimeout(load, 10000)
      } else if (r.data.job_id) {
        setViewJobId(r.data.job_id)
        setTimeout(load, 5000)
      }
    } catch {
      setScanMsg(m => ({ ...m, [agentId]: 'Scan request failed' }))
      setTimeout(() => setScanMsg(m => { const n = {...m}; delete n[agentId]; return n }), 5000)
    } finally {
      setScanning(s => { const n = new Set(s); n.delete(agentId); return n })
    }
  }

  async function scanAll() {
    setScanningAll(true)
    try {
      const r = await api.post('/patches/scan-all-agent-pull')
      setScanAllMsg(`Queued scans for ${r.data.queued} online agent(s)`)
      setTimeout(() => setScanAllMsg(''), 6000)
      setTimeout(load, 12000)
    } catch {
      setScanAllMsg('Scan all failed')
      setTimeout(() => setScanAllMsg(''), 4000)
    } finally { setScanningAll(false) }
  }

  const filtered = agents.filter(a =>
    !search ||
    a.hostname.toLowerCase().includes(search.toLowerCase()) ||
    (a.ip_address || '').includes(search)
  )

  const totalPending = agents.reduce((s, a) => s + a.pending_count, 0)
  const totalSecurity = agents.reduce((s, a) => s + a.security_count, 0)
  const agentsNeedingUpdates = agents.filter(a => a.pending_count > 0).length
  const agentsPatching = agents.filter(a => a.is_patching).length

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-2xl font-bold text-white">{agents.length}</div>
          <div className="text-xs text-slate-400 mt-1 flex items-center gap-1"><Server size={11}/> Total Agents</div>
        </div>
        <div className={`border rounded-xl p-4 ${agentsPatching > 0 ? 'bg-blue-950/40 border-blue-700/60' : 'bg-slate-800 border-slate-700'}`}>
          <div className="flex items-center gap-2">
            <div className={`text-2xl font-bold ${agentsPatching > 0 ? 'text-blue-300' : 'text-slate-500'}`}>{agentsPatching}</div>
            {agentsPatching > 0 && (
              <span className="relative flex h-2.5 w-2.5 mt-0.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-400" />
              </span>
            )}
          </div>
          <div className="text-xs text-slate-400 mt-1 flex items-center gap-1"><Loader2 size={11} className={agentsPatching > 0 ? 'animate-spin text-blue-400' : ''}/> Actively Patching</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className={`text-2xl font-bold ${totalPending > 0 ? 'text-yellow-400' : 'text-green-400'}`}>{totalPending}</div>
          <div className="text-xs text-slate-400 mt-1 flex items-center gap-1"><ShieldCheck size={11}/> Pending Updates</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className={`text-2xl font-bold ${totalSecurity > 0 ? 'text-red-400' : 'text-green-400'}`}>{totalSecurity}</div>
          <div className="text-xs text-slate-400 mt-1 flex items-center gap-1"><AlertTriangle size={11}/> Security Updates</div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search hostname or IP…"
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white w-56 focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <select value={filterGroup} onChange={e => setFilterGroup(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
          <option value="">All Groups</option>
          {groups.map(g => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        <div className="flex-1" />
        {scanAllMsg && <span className="text-xs text-green-400">{scanAllMsg}</span>}
        <button onClick={load} className="flex items-center gap-1.5 px-3 py-2 text-xs bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 rounded-lg">
          <RefreshCw size={12} /> Refresh
        </button>
        <button onClick={scanAll} disabled={scanningAll}
          className="flex items-center gap-1.5 px-3 py-2 text-xs bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-lg">
          {scanningAll ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          Scan All Online
        </button>
      </div>

      {/* Table */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-700 text-xs text-slate-400 uppercase bg-slate-800/60">
              <th className="px-4 py-3 text-left">Hostname</th>
              <th className="px-4 py-3 text-left">OS</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-left">Patching</th>
              <th className="px-4 py-3 text-center">Pending</th>
              <th className="px-4 py-3 text-center">Security</th>
              <th className="px-4 py-3 text-center">Restart</th>
              <th className="px-4 py-3 text-left">Last Scanned</th>
              <th className="px-4 py-3 text-right">Actions</th>
              <th className="px-4 py-3 text-center">History</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {loading ? (
              <tr><td colSpan={10} className="py-12 text-center text-slate-500">Loading…</td></tr>
            ) : filtered.map(a => (
              <tr key={a.id} className={`hover:bg-slate-700/30 ${a.is_patching ? 'bg-blue-950/20' : ''}`}>
                <td className="px-4 py-2.5">
                  <div className="font-medium text-white">{a.hostname}</div>
                  <div className="text-xs text-slate-500 font-mono">{a.ip_address}</div>
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-400">
                  {a.os_name || a.os_type || '—'}
                </td>
                <td className="px-4 py-2.5">
                  {a.status === 'online'
                    ? <span className="text-xs text-green-400 flex items-center gap-1"><CheckCircle2 size={11}/> Online</span>
                    : <span className="text-xs text-slate-500">{a.status}</span>}
                </td>
                <td className="px-4 py-2.5">
                  {a.is_patching ? (
                    <button
                      onClick={() => setViewJobId(a.active_job_id)}
                      title="Click to view live patch output"
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-600/25 text-blue-300 border border-blue-500/60 hover:bg-blue-600/40 transition-colors">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-400" />
                      </span>
                      {a.active_job_status === 'running' ? 'Patching…' : 'Queued'}
                    </button>
                  ) : (
                    <span className="text-slate-700 text-xs">—</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-center">
                  {a.pending_count > 0
                    ? <button onClick={() => setUpdatesAgent(a)}
                        className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-yellow-900/40 text-yellow-400 border border-yellow-800 hover:bg-yellow-800/40">
                        {a.pending_count}
                      </button>
                    : <span className="text-slate-600 text-xs">—</span>}
                </td>
                <td className="px-4 py-2.5 text-center">
                  {a.security_count > 0
                    ? <span className="text-xs font-bold text-red-400">{a.security_count}</span>
                    : <span className="text-slate-600 text-xs">—</span>}
                </td>
                <td className="px-4 py-2.5 text-center">
                  {a.restart_pending
                    ? <span className="inline-flex items-center gap-1 text-xs text-amber-400 bg-amber-500/15 border border-amber-700/40 rounded-full px-2 py-0.5">
                        <RotateCcw size={10} /> Restart
                      </span>
                    : <span className="text-slate-700">—</span>}
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-500">
                  {a.last_scanned ? new Date(a.last_scanned).toLocaleString() : 'Never'}
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center justify-end gap-2">
                    {scanMsg[a.id] ? (
                      <span className="text-xs text-green-400">{scanMsg[a.id]}</span>
                    ) : null}
                    <button onClick={() => scan(a.id)}
                      disabled={scanning.has(a.id) || a.status !== 'online' || a.is_patching}
                      title={a.is_patching ? 'Agent is currently being patched' : a.status !== 'online' ? 'Agent must be online to scan' : 'Queue patch scan on agent'}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-slate-700 hover:bg-blue-600 disabled:opacity-40 text-slate-200 hover:text-white rounded-lg transition-colors">
                      {scanning.has(a.id) ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                      Scan
                    </button>
                    {a.pending_count > 0 && (
                      <button onClick={() => setUpdatesAgent(a)}
                        disabled={a.is_patching}
                        title={a.is_patching ? 'Wait for current patching to complete' : undefined}
                        className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-yellow-600/20 hover:bg-yellow-600/40 border border-yellow-700 text-yellow-300 rounded-lg transition-colors disabled:opacity-40">
                        <Download size={12} /> Updates
                      </button>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-center">
                  <button onClick={() => setHistoryAgent(a)} title="View installed update history"
                    className="flex items-center gap-1 px-2 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white rounded-lg transition-colors mx-auto">
                    <History size={12} />
                  </button>
                </td>
              </tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={10} className="py-12 text-center text-slate-500">No agents found</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {updatesAgent && (
        <AgentUpdatesDrawer
          agent={updatesAgent}
          onClose={() => setUpdatesAgent(null)}
          onApply={jobId => { setUpdatesAgent(null); setViewJobId(jobId) }}
        />
      )}
      {historyAgent && (
        <UpdateHistoryDrawer agent={historyAgent} onClose={() => setHistoryAgent(null)} />
      )}
      {viewJobId && <JobOutputModal jobId={viewJobId} onClose={() => { setViewJobId(null); load() }} />}
    </div>
  )
}

// ── Jobs Tab ───────────────────────────────────────────────────────────────────

function JobsTab() {
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [viewJobId, setViewJobId] = useState(null)
  const [typeFilter, setTypeFilter] = useState('all')

  const load = useCallback(async () => {
    try {
      const r = await api.get('/patches/jobs?limit=200')
      setJobs(r.data)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  // Auto-refresh every 4s while any job is pending or running
  useEffect(() => {
    const hasActive = jobs.some(j => j.status === 'pending' || j.status === 'running')
    if (!hasActive) return
    const id = setInterval(load, 4000)
    return () => clearInterval(id)
  }, [jobs, load])

  const filtered = typeFilter === 'all' ? jobs : jobs.filter(j => j.job_type === typeFilter)

  async function deleteJob(id) {
    await api.delete(`/patches/jobs/${id}`)
    setJobs(js => js.filter(j => j.id !== id))
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
          <option value="all">All Types</option>
          <option value="scan">Scan</option>
          <option value="apply">Apply</option>
        </select>
        <div className="flex-1" />
        <button onClick={load} className="flex items-center gap-1.5 px-3 py-2 text-xs bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 rounded-lg">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-700 text-xs text-slate-400 uppercase bg-slate-800/60">
              <th className="px-4 py-3 text-left">Agent</th>
              <th className="px-4 py-3 text-left">Type</th>
              <th className="px-4 py-3 text-left">Packages</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-left">Triggered</th>
              <th className="px-4 py-3 text-left">Started</th>
              <th className="px-4 py-3 text-left">Duration</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {loading ? (
              <tr><td colSpan={8} className="py-12 text-center text-slate-500">Loading…</td></tr>
            ) : filtered.map(j => {
              const dur = j.finished_at && j.started_at
                ? Math.round((new Date(j.finished_at) - new Date(j.started_at)) / 1000)
                : null
              return (
                <tr key={j.id} className="hover:bg-slate-700/30">
                  <td className="px-4 py-2.5 font-medium text-white">{j.hostname}</td>
                  <td className="px-4 py-2.5">
                    <span className={`px-2 py-0.5 rounded text-xs border font-medium ${j.job_type === 'apply' ? 'bg-green-900/40 text-green-400 border-green-800' : 'bg-blue-900/40 text-blue-400 border-blue-800'}`}>
                      {j.job_type}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-400 max-w-xs truncate">
                    {j.packages?.length > 0 ? j.packages.join(', ') : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-4 py-2.5"><StatusBadge status={j.status} /></td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">{j.triggered_by}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">
                    {j.started_at ? new Date(j.started_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">
                    {j.status === 'running' ? <span className="text-blue-400">Running…</span>
                      : dur !== null ? `${dur}s` : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => setViewJobId(j.id)} title="View output"
                        className="p-1.5 text-slate-400 hover:text-green-400 hover:bg-slate-700 rounded-lg">
                        <Terminal size={14} />
                      </button>
                      <button onClick={() => deleteJob(j.id)} title="Delete job"
                        className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-slate-700 rounded-lg">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={8} className="py-12 text-center text-slate-500">No patch jobs yet</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {viewJobId && <JobOutputModal jobId={viewJobId} onClose={() => setViewJobId(null)} />}
    </div>
  )
}

// ── Schedule Modal ─────────────────────────────────────────────────────────────

const DAYS_OF_WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MINUTES_OPTIONS = [0, 15, 30, 45]

const EMPTY_SCHEDULE = {
  name: '',
  description: '',
  target_type: 'all',
  agent_id: '',
  group_id: '',
  os_filter: 'all',
  categories: ['security'],
  frequency: 'weekly',
  scheduled_at: '',
  day_of_week: 0,
  day_of_month: 1,
  hour_utc: 2,
  minute_utc: 0,
  reboot_after: false,
  reboot_mode: 'silent',
  reboot_delay_seconds: 60,
  is_active: true,
}

function ScheduleModal({ schedule, agents, groups, onClose, onSaved }) {
  const isEdit = !!schedule
  const [form, setForm] = useState(isEdit ? {
    name: schedule.name || '',
    description: schedule.description || '',
    target_type: schedule.target_type || 'all',
    agent_id: schedule.agent_id || '',
    group_id: schedule.group_id || '',
    os_filter: schedule.os_filter || 'all',
    categories: schedule.categories || ['security'],
    frequency: schedule.frequency || 'weekly',
    scheduled_at: schedule.scheduled_at ? schedule.scheduled_at.slice(0, 16) : '',
    day_of_week: schedule.day_of_week ?? 0,
    day_of_month: schedule.day_of_month ?? 1,
    hour_utc: schedule.hour_utc ?? 2,
    minute_utc: schedule.minute_utc ?? 0,
    reboot_after: schedule.reboot_after ?? false,
    reboot_mode: schedule.reboot_mode || 'silent',
    reboot_delay_seconds: schedule.reboot_delay_seconds ?? 60,
    is_active: schedule.is_active ?? true,
  } : { ...EMPTY_SCHEDULE })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [tzName, setTzName] = useState('UTC')

  useEffect(() => {
    patchSchedulesApi.getTimezone().then(r => setTzName(r.timezone || 'UTC')).catch(() => {})
  }, [])

  const f = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  function toggleCategory(cat) {
    setForm(prev => {
      const cats = prev.categories.includes(cat)
        ? prev.categories.filter(c => c !== cat)
        : [...prev.categories, cat]
      return { ...prev, categories: cats }
    })
  }

  async function save() {
    if (!form.name.trim()) { setError('Name is required'); return }
    if (form.categories.length === 0) { setError('Select at least one category'); return }
    setSaving(true)
    setError('')
    try {
      const payload = {
        ...form,
        agent_id: form.agent_id || null,
        group_id: form.group_id || null,
        scheduled_at: form.scheduled_at || null,
        day_of_week: form.day_of_week !== '' ? Number(form.day_of_week) : null,
        day_of_month: form.day_of_month !== '' ? Number(form.day_of_month) : null,
        hour_utc: Number(form.hour_utc),
        minute_utc: Number(form.minute_utc),
        reboot_delay_seconds: Number(form.reboot_delay_seconds),
      }
      if (isEdit) {
        await patchSchedulesApi.update(schedule.id, payload)
      } else {
        await patchSchedulesApi.create(payload)
      }
      onSaved()
      onClose()
    } catch (e) {
      setError(e.response?.data?.detail || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-xl my-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <h2 className="font-semibold text-white flex items-center gap-2">
            <CalendarClock size={16} className="text-blue-400" />
            {isEdit ? 'Edit Patch Schedule' : 'New Patch Schedule'}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>

        <div className="p-6 space-y-5">
          {/* Name + Description */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Name <span className="text-red-400">*</span></label>
              <input value={form.name} onChange={e => f('name', e.target.value)}
                placeholder="e.g. Weekly Security Patches"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Description <span className="text-slate-600">(optional)</span></label>
              <input value={form.description} onChange={e => f('description', e.target.value)}
                placeholder="Short description"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
            </div>
          </div>

          {/* Target */}
          <div>
            <label className="block text-xs text-slate-400 mb-2">Target</label>
            <div className="grid grid-cols-2 gap-2">
              {[
                { v: 'all', l: 'All Agents' },
                { v: 'os', l: 'By OS' },
                { v: 'group', l: 'Specific Group' },
                { v: 'agent', l: 'Specific Agent' },
              ].map(opt => (
                <button key={opt.v} onClick={() => f('target_type', opt.v)}
                  className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors text-left ${
                    form.target_type === opt.v
                      ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                      : 'bg-slate-900 border-slate-600 text-slate-400 hover:border-slate-500'
                  }`}>
                  {opt.l}
                </button>
              ))}
            </div>
            {(form.target_type === 'all' || form.target_type === 'os') && (
              <div className="mt-3">
                <label className="block text-xs text-slate-400 mb-1">OS Filter</label>
                <select value={form.os_filter} onChange={e => f('os_filter', e.target.value)}
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
                  <option value="all">All OS</option>
                  <option value="windows">Windows only</option>
                  <option value="linux">Linux only</option>
                </select>
              </div>
            )}
            {form.target_type === 'group' && (
              <div className="mt-3">
                <label className="block text-xs text-slate-400 mb-1">Group</label>
                <select value={form.group_id} onChange={e => f('group_id', e.target.value)}
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
                  <option value="">— select group —</option>
                  {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </div>
            )}
            {form.target_type === 'agent' && (
              <div className="mt-3">
                <label className="block text-xs text-slate-400 mb-1">Agent</label>
                <select value={form.agent_id} onChange={e => f('agent_id', e.target.value)}
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
                  <option value="">— select agent —</option>
                  {agents.map(a => <option key={a.id} value={a.id}>{a.hostname}</option>)}
                </select>
              </div>
            )}
          </div>

          {/* Categories */}
          <div>
            <label className="block text-xs text-slate-400 mb-2">Patch Categories</label>
            <div className="flex flex-wrap gap-2">
              {[
                { v: 'security', l: 'Security', cls: 'bg-red-900/30 border-red-700 text-red-300' },
                { v: 'upgrade', l: 'Upgrades', cls: 'bg-blue-900/30 border-blue-700 text-blue-300' },
                { v: 'update', l: 'Updates', cls: 'bg-slate-700 border-slate-600 text-slate-300' },
              ].map(cat => (
                <button key={cat.v} onClick={() => toggleCategory(cat.v)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                    form.categories.includes(cat.v)
                      ? cat.cls + ' ring-1 ring-offset-0 ring-blue-500'
                      : 'bg-slate-900 border-slate-700 text-slate-500 hover:border-slate-500'
                  }`}>
                  {form.categories.includes(cat.v) ? '✓ ' : ''}{cat.l}
                </button>
              ))}
            </div>
          </div>

          {/* Frequency */}
          <div>
            <label className="block text-xs text-slate-400 mb-2">Frequency</label>
            <div className="grid grid-cols-4 gap-2">
              {['daily', 'weekly', 'monthly', 'once'].map(freq => (
                <button key={freq} onClick={() => f('frequency', freq)}
                  className={`px-3 py-2 rounded-lg text-xs font-medium border capitalize transition-colors ${
                    form.frequency === freq
                      ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                      : 'bg-slate-900 border-slate-600 text-slate-400 hover:border-slate-500'
                  }`}>
                  {freq}
                </button>
              ))}
            </div>

            {form.frequency === 'weekly' && (
              <div className="mt-3">
                <label className="block text-xs text-slate-400 mb-1">Day of Week</label>
                <select value={form.day_of_week} onChange={e => f('day_of_week', Number(e.target.value))}
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
                  {DAYS_OF_WEEK.map((d, i) => <option key={i} value={i}>{d}</option>)}
                </select>
              </div>
            )}

            {form.frequency === 'monthly' && (
              <div className="mt-3">
                <label className="block text-xs text-slate-400 mb-1">Day of Month</label>
                <select value={form.day_of_month} onChange={e => f('day_of_month', Number(e.target.value))}
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
                  {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>
            )}

            {form.frequency === 'once' && (
              <div className="mt-3">
                <label className="block text-xs text-slate-400 mb-1">Run At</label>
                <input type="datetime-local" value={form.scheduled_at} onChange={e => f('scheduled_at', e.target.value)}
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
              </div>
            )}
          </div>

          {/* Time (hidden for 'once' since time is embedded in scheduled_at) */}
          {form.frequency !== 'once' && (
            <div>
              <label className="block text-xs text-slate-400 mb-2">Time</label>
              <div className="flex gap-3 items-center">
                <div className="flex-1">
                  <label className="block text-xs text-slate-500 mb-1">Hour (0–23)</label>
                  <input type="number" min={0} max={23} value={form.hour_utc}
                    onChange={e => f('hour_utc', Math.max(0, Math.min(23, Number(e.target.value))))}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-slate-500 mb-1">Minute</label>
                  <select value={form.minute_utc} onChange={e => f('minute_utc', Number(e.target.value))}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
                    {MINUTES_OPTIONS.map(m => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Reboot */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="text-xs text-slate-400">Reboot after patching</label>
              <button onClick={() => f('reboot_after', !form.reboot_after)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  form.reboot_after ? 'bg-blue-600' : 'bg-slate-700'
                }`}>
                <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                  form.reboot_after ? 'translate-x-4.5' : 'translate-x-0.5'
                }`} />
              </button>
            </div>
            {form.reboot_after && (
              <div className="grid grid-cols-2 gap-3 pl-2 border-l-2 border-blue-800">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Reboot Mode</label>
                  <select value={form.reboot_mode} onChange={e => f('reboot_mode', e.target.value)}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
                    <option value="silent">Silent</option>
                    <option value="announced">Announced</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Delay (seconds)</label>
                  <input type="number" min={0} max={3600} value={form.reboot_delay_seconds}
                    onChange={e => f('reboot_delay_seconds', Number(e.target.value))}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500" />
                </div>
              </div>
            )}
          </div>

          {error && <p className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-700">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors">Cancel</button>
          <button onClick={save} disabled={saving}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-lg transition-colors">
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            {isEdit ? 'Save Changes' : 'Create Schedule'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Schedule History Modal ─────────────────────────────────────────────────────

function RunStatusBadge({ status }) {
  const map = {
    queued:    'bg-blue-900/40 text-blue-300 border-blue-700',
    success:   'bg-green-900/40 text-green-400 border-green-800',
    partial:   'bg-yellow-900/40 text-yellow-400 border-yellow-800',
    failed:    'bg-red-900/40 text-red-400 border-red-800',
    skipped:   'bg-slate-700 text-slate-400 border-slate-600',
    running:   'bg-blue-900/40 text-blue-300 border-blue-700',
    completed: 'bg-green-900/40 text-green-400 border-green-800',
  }
  return <span className={`px-2 py-0.5 rounded-full text-xs border font-medium ${map[status] || map.skipped}`}>{status}</span>
}

function HistoryModal({ schedule, onClose }) {
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [expandedRun, setExpandedRun] = useState(null)
  const [runJobs, setRunJobs] = useState({})
  const [loadingJobs, setLoadingJobs] = useState(new Set())

  useEffect(() => {
    setLoading(true)
    patchSchedulesApi.history(schedule.id).then(r => {
      setRuns(r.data)
    }).catch(() => setRuns([])).finally(() => setLoading(false))
  }, [schedule.id])

  async function toggleRun(runId) {
    if (expandedRun === runId) { setExpandedRun(null); return }
    setExpandedRun(runId)
    if (runJobs[runId]) return
    setLoadingJobs(s => new Set(s).add(runId))
    try {
      const r = await patchSchedulesApi.runJobs(schedule.id, runId)
      setRunJobs(j => ({ ...j, [runId]: r.data }))
    } catch {
      setRunJobs(j => ({ ...j, [runId]: [] }))
    } finally {
      setLoadingJobs(s => { const n = new Set(s); n.delete(runId); return n })
    }
  }

  function fmtDuration(fired, completed) {
    if (!fired || !completed) return '—'
    const secs = Math.round((new Date(completed) - new Date(fired)) / 1000)
    if (secs < 60) return `${secs}s`
    return `${Math.floor(secs / 60)}m ${secs % 60}s`
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-4xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700 flex-shrink-0">
          <h2 className="font-semibold text-white flex items-center gap-2">
            <History size={16} className="text-blue-400" />
            Run History — {schedule.name}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>
        <div className="overflow-auto flex-1">
          {loading ? (
            <div className="py-16 text-center text-slate-500">Loading…</div>
          ) : runs.length === 0 ? (
            <div className="py-16 text-center text-slate-500">No runs recorded yet — run the schedule to see history</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-xs text-slate-400 uppercase bg-slate-800/60 sticky top-0">
                  <th className="px-4 py-3 text-left">Fired At</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-left">Agents</th>
                  <th className="px-4 py-3 text-center">Total Jobs</th>
                  <th className="px-4 py-3 text-center">Success</th>
                  <th className="px-4 py-3 text-center">Failed</th>
                  <th className="px-4 py-3 text-center">Pending</th>
                  <th className="px-4 py-3 text-left">Duration</th>
                  <th className="px-4 py-3 text-right">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {runs.map(run => (
                  <>
                    <tr key={run.id} className="hover:bg-slate-700/30">
                      <td className="px-4 py-2.5 text-xs text-slate-300 whitespace-nowrap">
                        {run.fired_at ? new Date(run.fired_at).toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-2.5"><RunStatusBadge status={run.status} /></td>
                      <td className="px-4 py-2.5 text-xs text-slate-400">
                        {run.agents_queued} / {run.agents_targeted} queued
                      </td>
                      <td className="px-4 py-2.5 text-center text-xs text-slate-300">{run.total_jobs}</td>
                      <td className="px-4 py-2.5 text-center text-xs text-green-400 font-medium">{run.success_count}</td>
                      <td className="px-4 py-2.5 text-center text-xs">
                        <span className={run.failed_count > 0 ? 'text-red-400 font-medium' : 'text-slate-500'}>{run.failed_count}</span>
                      </td>
                      <td className="px-4 py-2.5 text-center text-xs text-slate-500">{run.pending_count + run.running_count}</td>
                      <td className="px-4 py-2.5 text-xs text-slate-400">{fmtDuration(run.fired_at, run.completed_at)}</td>
                      <td className="px-4 py-2.5 text-right">
                        {run.total_jobs > 0 && (
                          <button onClick={() => toggleRun(run.id)}
                            className="p-1.5 text-slate-400 hover:text-blue-400 hover:bg-slate-700 rounded-lg transition-colors">
                            {loadingJobs.has(run.id)
                              ? <Loader2 size={14} className="animate-spin" />
                              : expandedRun === run.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        )}
                      </td>
                    </tr>
                    {expandedRun === run.id && runJobs[run.id] && (
                      <tr key={`${run.id}-jobs`}>
                        <td colSpan={9} className="px-0 py-0 bg-slate-900/60">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b border-slate-700 text-slate-500 uppercase">
                                <th className="px-8 py-2 text-left">Agent</th>
                                <th className="px-4 py-2 text-left">Status</th>
                                <th className="px-4 py-2 text-left">Packages</th>
                                <th className="px-4 py-2 text-left">Started</th>
                                <th className="px-4 py-2 text-left">Finished</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800">
                              {runJobs[run.id].length === 0 ? (
                                <tr><td colSpan={5} className="px-8 py-3 text-slate-600">No jobs found for this run</td></tr>
                              ) : runJobs[run.id].map(job => (
                                <tr key={job.job_id} className="hover:bg-slate-800/60">
                                  <td className="px-8 py-2 text-slate-300 font-medium">{job.hostname}</td>
                                  <td className="px-4 py-2"><StatusBadge status={job.status} /></td>
                                  <td className="px-4 py-2 text-slate-400 max-w-xs truncate"
                                    title={(job.packages || []).join(', ')}>
                                    {(job.packages || []).length} package{(job.packages || []).length !== 1 ? 's' : ''}
                                  </td>
                                  <td className="px-4 py-2 text-slate-500 whitespace-nowrap">
                                    {job.started_at ? new Date(job.started_at).toLocaleTimeString() : '—'}
                                  </td>
                                  <td className="px-4 py-2 text-slate-500 whitespace-nowrap">
                                    {job.finished_at ? new Date(job.finished_at).toLocaleTimeString() : '—'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="px-6 py-4 border-t border-slate-700 flex-shrink-0 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg">Close</button>
        </div>
      </div>
    </div>
  )
}

// ── Schedules Tab ──────────────────────────────────────────────────────────────

function SchedulesTab() {
  const [schedules, setSchedules] = useState([])
  const [agents, setAgents] = useState([])
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editSchedule, setEditSchedule] = useState(null)
  const [historySchedule, setHistorySchedule] = useState(null)
  const [runMsg, setRunMsg] = useState({})
  const [running, setRunning] = useState(new Set())
  const [tzName, setTzName] = useState('UTC')

  useEffect(() => {
    patchSchedulesApi.getTimezone().then(r => setTzName(r.timezone || 'UTC')).catch(() => {})
  }, [])

  const loadSchedules = useCallback(async () => {
    setLoading(true)
    try {
      const [sr, ar, gr] = await Promise.all([
        patchSchedulesApi.list(),
        api.get('/agents?limit=500'),
        api.get('/groups'),
      ])
      setSchedules(sr.data)
      setAgents(ar.data?.agents || ar.data || [])
      setGroups(gr.data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadSchedules() }, [loadSchedules])

  async function deleteSchedule(id) {
    if (!window.confirm('Delete this schedule?')) return
    await patchSchedulesApi.delete(id)
    setSchedules(s => s.filter(x => x.id !== id))
  }

  async function runNow(id) {
    setRunning(s => new Set(s).add(id))
    try {
      const r = await patchSchedulesApi.runNow(id)
      setRunMsg(m => ({ ...m, [id]: `Queued for ${r.data.agents_queued} agent(s)` }))
      setTimeout(() => setRunMsg(m => { const n = {...m}; delete n[id]; return n }), 5000)
    } catch (e) {
      setRunMsg(m => ({ ...m, [id]: e.response?.data?.detail || 'Failed' }))
      setTimeout(() => setRunMsg(m => { const n = {...m}; delete n[id]; return n }), 4000)
    } finally {
      setRunning(s => { const n = new Set(s); n.delete(id); return n })
    }
  }

  function openCreate() { setEditSchedule(null); setShowModal(true) }
  function openEdit(s) { setEditSchedule(s); setShowModal(true) }

  function formatFrequency(s) {
    const t = `${String(s.hour_utc).padStart(2,'0')}:${String(s.minute_utc).padStart(2,'0')}`
    if (s.frequency === 'once') return `Once — ${s.scheduled_at ? new Date(s.scheduled_at).toLocaleString() : '—'}`
    if (s.frequency === 'daily') return `Daily at ${t}`
    if (s.frequency === 'weekly') {
      const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
      return `Weekly ${days[s.day_of_week ?? 0]} at ${t}`
    }
    if (s.frequency === 'monthly') {
      return `Monthly day ${s.day_of_month} at ${t}`
    }
    return s.frequency
  }

  function formatTarget(s) {
    if (s.target_type === 'all') return s.os_filter !== 'all' ? `All ${s.os_filter}` : 'All Agents'
    if (s.target_type === 'os') return s.os_filter !== 'all' ? `${s.os_filter} agents` : 'All Agents'
    if (s.target_type === 'group') return s.target_name ? `Group: ${s.target_name}` : 'Group'
    if (s.target_type === 'agent') return s.target_name || 'Specific Agent'
    return s.target_type
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex-1" />
        <button onClick={loadSchedules} className="flex items-center gap-1.5 px-3 py-2 text-xs bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 rounded-lg">
          <RefreshCw size={12} /> Refresh
        </button>
        <button onClick={openCreate}
          className="flex items-center gap-1.5 px-3 py-2 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg">
          <Plus size={12} /> New Schedule
        </button>
      </div>

      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-700 text-xs text-slate-400 uppercase bg-slate-800/60">
              <th className="px-4 py-3 text-left">Name</th>
              <th className="px-4 py-3 text-left">Target</th>
              <th className="px-4 py-3 text-left">Categories</th>
              <th className="px-4 py-3 text-left">Schedule</th>
              <th className="px-4 py-3 text-left">Next Run</th>
              <th className="px-4 py-3 text-left">Last Run</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {loading ? (
              <tr><td colSpan={8} className="py-12 text-center text-slate-500">Loading…</td></tr>
            ) : schedules.length === 0 ? (
              <tr><td colSpan={8} className="py-12 text-center text-slate-500">
                No patch schedules yet — create one to automate patching
              </td></tr>
            ) : schedules.map(s => (
              <tr key={s.id} className="hover:bg-slate-700/30">
                <td className="px-4 py-2.5">
                  <div className="font-medium text-white">{s.name}</div>
                  {s.description && <div className="text-xs text-slate-500 mt-0.5">{s.description}</div>}
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-400">{formatTarget(s)}</td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {(s.categories || []).map(cat => (
                      <CategoryBadge key={cat} cat={cat} />
                    ))}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-400">{formatFrequency(s)}</td>
                <td className="px-4 py-2.5 text-xs text-slate-400">
                  {s.next_run ? new Date(s.next_run).toLocaleString() : <span className="text-slate-600">—</span>}
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-500">
                  {s.last_run ? new Date(s.last_run).toLocaleString() : <span className="text-slate-600">Never</span>}
                </td>
                <td className="px-4 py-2.5">
                  {s.is_active
                    ? <span className="px-2 py-0.5 rounded-full text-xs border bg-green-900/30 text-green-400 border-green-800">Active</span>
                    : <span className="px-2 py-0.5 rounded-full text-xs border bg-slate-700 text-slate-400 border-slate-600">Inactive</span>}
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center justify-end gap-1.5">
                    {runMsg[s.id] && (
                      <span className="text-xs text-green-400 mr-1">{runMsg[s.id]}</span>
                    )}
                    <button onClick={() => runNow(s.id)} disabled={running.has(s.id)} title="Run now"
                      className="p-1.5 text-slate-400 hover:text-green-400 hover:bg-slate-700 disabled:opacity-40 rounded-lg transition-colors">
                      {running.has(s.id) ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                    </button>
                    <button onClick={() => setHistorySchedule(s)} title="View history"
                      className="p-1.5 text-slate-400 hover:text-purple-400 hover:bg-slate-700 rounded-lg transition-colors">
                      <History size={14} />
                    </button>
                    <button onClick={() => openEdit(s)} title="Edit"
                      className="p-1.5 text-slate-400 hover:text-blue-400 hover:bg-slate-700 rounded-lg transition-colors">
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => deleteSchedule(s.id)} title="Delete"
                      className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-slate-700 rounded-lg transition-colors">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <ScheduleModal
          schedule={editSchedule}
          agents={agents}
          groups={groups}
          onClose={() => setShowModal(false)}
          onSaved={loadSchedules}
        />
      )}

      {historySchedule && (
        <HistoryModal
          schedule={historySchedule}
          onClose={() => setHistorySchedule(null)}
        />
      )}
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'agents',    label: 'Agents',    icon: Server },
  { key: 'jobs',      label: 'Job History', icon: Clock },
  { key: 'schedules', label: 'Schedules', icon: CalendarClock },
]

export default function Patches() {
  const [tab, setTab] = useState('agents')
  const ActiveTab = tab === 'agents' ? AgentsTab : tab === 'jobs' ? JobsTab : SchedulesTab

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <ShieldCheck size={20} className="text-blue-400" /> Patch Management
        </h1>
        <p className="text-sm text-slate-400 mt-0.5">Scan and apply OS/package updates across agents — scans run automatically via agent heartbeat</p>
      </div>

      <div className="flex gap-1 border-b border-slate-700">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}>
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      <ActiveTab />
    </div>
  )
}
