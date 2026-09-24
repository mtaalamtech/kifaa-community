import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Package, Upload, Link2, Trash2, Play, RefreshCw, CheckCircle,
  XCircle, Clock, ChevronDown, ChevronRight, Plus, Search, Filter
} from 'lucide-react'
import api, { agentsApi } from '../api/client'

const deployApi = {
  listPackages: () => api.get('/software-deploy/packages'),
  createPackage: (data) => api.post('/software-deploy/packages', data),
  uploadPackage: (formData) => api.post('/software-deploy/packages/upload', formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
  deletePackage: (id) => api.delete(`/software-deploy/packages/${id}`),
  deploy: (data) => api.post('/software-deploy/deploy', data),
  listJobs: (params) => api.get('/software-deploy/jobs', { params }),
}

const STATUS_ICON = {
  success: <CheckCircle size={14} className="text-emerald-400" />,
  failed: <XCircle size={14} className="text-red-400" />,
  pending: <Clock size={14} className="text-yellow-400" />,
  running: <RefreshCw size={14} className="text-blue-400 animate-spin" />,
}

const OS_BADGE = { windows: 'bg-blue-900/40 text-blue-300', linux: 'bg-emerald-900/40 text-emerald-300', any: 'bg-slate-700 text-slate-300' }

function fmtBytes(b) {
  if (!b) return '—'
  if (b < 1024) return `${b} B`
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1048576).toFixed(1)} MB`
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleString()
}

export default function SoftwareDeploy() {
  const [tab, setTab] = useState('catalog')
  const [packages, setPackages] = useState([])
  const [jobs, setJobs] = useState([])
  const [agents, setAgents] = useState([])
  const [loading, setLoading] = useState(true)
  const [jobsLoading, setJobsLoading] = useState(false)
  const [expandedJobs, setExpandedJobs] = useState(new Set())

  // Deploy state
  const [selectedPkg, setSelectedPkg] = useState(null)
  const [selectedAgents, setSelectedAgents] = useState(new Set())
  const [agentSearch, setAgentSearch] = useState('')
  const [deploying, setDeploying] = useState(false)

  // Add package modal
  const [showAddModal, setShowAddModal] = useState(false)
  const [addMode, setAddMode] = useState('url') // url or upload
  const [addForm, setAddForm] = useState({ name: '', version: '', description: '', download_url: '', installer_type: 'exe', install_args: '', os_type: 'windows', checksum_sha256: '' })
  const [uploadFile, setUploadFile] = useState(null)
  const [adding, setAdding] = useState(false)
  const fileInputRef = useRef(null)

  const loadPackages = useCallback(() => {
    return deployApi.listPackages().then(r => setPackages(r.data)).catch(() => {})
  }, [])

  const loadJobs = useCallback(() => {
    setJobsLoading(true)
    return deployApi.listJobs({ limit: 200 }).then(r => setJobs(r.data)).catch(() => {}).finally(() => setJobsLoading(false))
  }, [])

  useEffect(() => {
    Promise.all([loadPackages(), agentsApi.list({ limit: 500 }).then(r => setAgents(r.data?.agents || r.data || []))]).finally(() => setLoading(false))
    loadJobs()
    const t = setInterval(loadJobs, 15000)
    return () => clearInterval(t)
  }, [loadPackages, loadJobs])

  const addPackage = async () => {
    setAdding(true)
    try {
      if (addMode === 'url') {
        await deployApi.createPackage(addForm)
      } else {
        if (!uploadFile) { alert('Select a file'); setAdding(false); return }
        const fd = new FormData()
        fd.append('file', uploadFile)
        Object.entries(addForm).forEach(([k, v]) => { if (v) fd.append(k, v) })
        await deployApi.uploadPackage(fd)
      }
      await loadPackages()
      setShowAddModal(false)
      setAddForm({ name: '', version: '', description: '', download_url: '', installer_type: 'exe', install_args: '', os_type: 'windows', checksum_sha256: '' })
      setUploadFile(null)
    } catch (e) {
      alert('Failed: ' + (e.response?.data?.detail || e.message))
    } finally {
      setAdding(false)
    }
  }

  const deletePackage = async (id) => {
    if (!confirm('Delete this package?')) return
    await deployApi.deletePackage(id).catch(() => {})
    setPackages(ps => ps.filter(p => p.id !== id))
    if (selectedPkg?.id === id) setSelectedPkg(null)
  }

  const deploy = async () => {
    if (!selectedPkg || selectedAgents.size === 0) return
    setDeploying(true)
    try {
      await deployApi.deploy({ package_id: selectedPkg.id, agent_ids: [...selectedAgents] })
      setSelectedAgents(new Set())
      setTab('jobs')
      await loadJobs()
    } catch (e) {
      alert('Deploy failed: ' + (e.response?.data?.detail || e.message))
    } finally {
      setDeploying(false)
    }
  }

  const toggleAgent = (id) => {
    setSelectedAgents(prev => {
      const s = new Set(prev)
      s.has(id) ? s.delete(id) : s.add(id)
      return s
    })
  }

  const filteredAgents = agents.filter(a => {
    if (agentSearch) {
      const q = agentSearch.toLowerCase()
      return a.hostname?.toLowerCase().includes(q) || a.ip_address?.includes(q)
    }
    return true
  })

  const toggleJob = (id) => setExpandedJobs(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })

  const Tab = ({ k, label }) => (
    <button onClick={() => setTab(k)} className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === k ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-400 hover:text-white'}`}>
      {label}
    </button>
  )

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Package size={24} className="text-blue-400" /> Software Deployment
          </h1>
          <p className="text-slate-400 text-sm mt-1">Upload packages and deploy to agents silently</p>
        </div>
        <button onClick={() => setShowAddModal(true)} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium">
          <Plus size={14} /> Add Package
        </button>
      </div>

      <div className="flex gap-1 border-b border-slate-700">
        <Tab k="catalog" label={`Package Catalog (${packages.length})`} />
        <Tab k="deploy" label="Deploy" />
        <Tab k="jobs" label={`Job History (${jobs.length})`} />
      </div>

      {/* ── Catalog ── */}
      {tab === 'catalog' && (
        <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-700 bg-slate-800/50">
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">Version</th>
                <th className="px-5 py-3 font-medium">OS</th>
                <th className="px-5 py-3 font-medium">Type</th>
                <th className="px-5 py-3 font-medium">Size</th>
                <th className="px-5 py-3 font-medium">Added</th>
                <th className="px-5 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {packages.map(p => (
                <tr key={p.id} className="border-b border-slate-800 hover:bg-slate-800/40">
                  <td className="px-5 py-3 font-medium text-white">
                    {p.name}
                    {p.description && <div className="text-xs text-slate-500 mt-0.5 font-normal">{p.description}</div>}
                  </td>
                  <td className="px-5 py-3 text-slate-400 font-mono text-xs">{p.version || '—'}</td>
                  <td className="px-5 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${OS_BADGE[p.os_type] || OS_BADGE.any}`}>{p.os_type || 'any'}</span>
                  </td>
                  <td className="px-5 py-3 text-slate-400 text-xs font-mono uppercase">{p.installer_type || '—'}</td>
                  <td className="px-5 py-3 text-slate-400 text-xs">{fmtBytes(p.size_bytes)}</td>
                  <td className="px-5 py-3 text-slate-400 text-xs">{fmtDate(p.created_at)}</td>
                  <td className="px-5 py-3 text-right">
                    <button onClick={() => { setSelectedPkg(p); setTab('deploy') }} className="text-xs text-blue-400 hover:text-blue-300 mr-3">Deploy</button>
                    <button onClick={() => deletePackage(p.id)} className="text-slate-500 hover:text-red-400"><Trash2 size={13} /></button>
                  </td>
                </tr>
              ))}
              {packages.length === 0 && !loading && (
                <tr><td colSpan={7} className="px-5 py-12 text-center text-slate-500">No packages yet. Add a package to get started.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Deploy ── */}
      {tab === 'deploy' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Package selection */}
          <div>
            <h3 className="text-sm font-semibold text-slate-300 mb-3">1. Select Package</h3>
            <div className="space-y-2">
              {packages.map(p => (
                <button key={p.id} onClick={() => setSelectedPkg(p)}
                  className={`w-full text-left px-4 py-3 rounded-xl border transition-colors ${selectedPkg?.id === p.id ? 'bg-blue-900/30 border-blue-600/60 text-white' : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-600'}`}>
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-slate-500 mt-0.5 font-mono">{p.version} · {p.os_type} · {p.installer_type?.toUpperCase()}</div>
                </button>
              ))}
              {packages.length === 0 && <div className="text-slate-500 text-sm py-4">No packages. Add one first.</div>}
            </div>
          </div>

          {/* Agent selection */}
          <div>
            <h3 className="text-sm font-semibold text-slate-300 mb-3">2. Select Target Agents</h3>
            <div className="relative mb-3">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={agentSearch} onChange={e => setAgentSearch(e.target.value)}
                placeholder="Search agents…"
                className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-9 pr-3 py-2 text-sm text-white" />
            </div>
            <div className="max-h-72 overflow-y-auto space-y-1.5">
              {filteredAgents.map(a => (
                <label key={a.id} className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${selectedAgents.has(a.id) ? 'bg-blue-900/20 border border-blue-700/40' : 'bg-slate-800 border border-transparent hover:border-slate-600'}`}>
                  <input type="checkbox" checked={selectedAgents.has(a.id)} onChange={() => toggleAgent(a.id)} className="rounded" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white truncate">{a.hostname}</div>
                    <div className="text-xs text-slate-500">{a.ip_address} · {a.os_name}</div>
                  </div>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${a.status === 'online' ? 'bg-emerald-900/40 text-emerald-400' : 'bg-slate-700 text-slate-400'}`}>{a.status}</span>
                </label>
              ))}
            </div>

            {/* Deploy button */}
            <div className="mt-4 pt-4 border-t border-slate-700">
              <div className="text-xs text-slate-500 mb-3">
                {selectedPkg ? `Package: ${selectedPkg.name}` : 'No package selected'} · {selectedAgents.size} agent{selectedAgents.size !== 1 ? 's' : ''} selected
              </div>
              <button onClick={deploy} disabled={!selectedPkg || selectedAgents.size === 0 || deploying}
                className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white py-2.5 rounded-lg text-sm font-medium disabled:opacity-40">
                <Play size={14} /> {deploying ? 'Deploying…' : `Deploy to ${selectedAgents.size} Agent${selectedAgents.size !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Jobs ── */}
      {tab === 'jobs' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <span className="text-sm text-slate-400">{jobs.length} job{jobs.length !== 1 ? 's' : ''}</span>
            <button onClick={loadJobs} className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 rounded-lg">
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
          <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-slate-700 bg-slate-800/50">
                  <th className="px-5 py-3 font-medium w-8"></th>
                  <th className="px-5 py-3 font-medium">Agent</th>
                  <th className="px-5 py-3 font-medium">Package</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Triggered By</th>
                  <th className="px-5 py-3 font-medium">Queued</th>
                  <th className="px-5 py-3 font-medium">Finished</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map(j => (
                  <>
                    <tr key={j.id} onClick={() => j.output && toggleJob(j.id)}
                      className={`border-b border-slate-800 ${j.output ? 'cursor-pointer hover:bg-slate-800/40' : ''}`}>
                      <td className="px-3 py-2.5 text-slate-500">
                        {j.output ? (expandedJobs.has(j.id) ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}
                      </td>
                      <td className="px-5 py-2.5 font-medium text-white">{j.hostname || j.agent_id?.slice(0, 8)}</td>
                      <td className="px-5 py-2.5 text-slate-300">{j.package_name || '—'} {j.package_version ? <span className="text-xs text-slate-500 font-mono">{j.package_version}</span> : ''}</td>
                      <td className="px-5 py-2.5">
                        <span className="flex items-center gap-1.5">{STATUS_ICON[j.status]} <span className="capitalize text-xs text-slate-300">{j.status}</span></span>
                        {j.error_message && <div className="text-xs text-red-400/80 mt-0.5 font-mono truncate max-w-xs">{j.error_message}</div>}
                      </td>
                      <td className="px-5 py-2.5 text-slate-400 text-xs">{j.triggered_by || '—'}</td>
                      <td className="px-5 py-2.5 text-slate-400 text-xs">{fmtDate(j.queued_at)}</td>
                      <td className="px-5 py-2.5 text-slate-400 text-xs">{fmtDate(j.finished_at)}</td>
                    </tr>
                    {expandedJobs.has(j.id) && j.output && (
                      <tr key={`${j.id}-out`} className="border-b border-slate-800 bg-slate-950">
                        <td colSpan={7} className="px-5 py-3">
                          <pre className="text-xs text-slate-300 font-mono whitespace-pre-wrap break-all max-h-48 overflow-y-auto">{j.output}</pre>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
                {jobs.length === 0 && (
                  <tr><td colSpan={7} className="px-5 py-12 text-center text-slate-500">No deployment jobs yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add package modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 w-full max-w-lg shadow-xl max-h-screen overflow-y-auto">
            <h2 className="text-white font-semibold text-lg mb-4">Add Package</h2>

            <div className="flex gap-2 mb-4">
              <button onClick={() => setAddMode('url')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm ${addMode === 'url' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300'}`}>
                <Link2 size={13} /> URL
              </button>
              <button onClick={() => setAddMode('upload')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm ${addMode === 'upload' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300'}`}>
                <Upload size={13} /> Upload
              </button>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Name *</label>
                  <input value={addForm.name} onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white" />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Version</label>
                  <input value={addForm.version} onChange={e => setAddForm(f => ({ ...f, version: e.target.value }))}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white" />
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">Description</label>
                <input value={addForm.description} onChange={e => setAddForm(f => ({ ...f, description: e.target.value }))}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white" />
              </div>
              {addMode === 'url' ? (
                <>
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Download URL *</label>
                    <input value={addForm.download_url} onChange={e => setAddForm(f => ({ ...f, download_url: e.target.value }))}
                      placeholder="https://..."
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white font-mono" />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">SHA-256 Checksum (optional)</label>
                    <input value={addForm.checksum_sha256} onChange={e => setAddForm(f => ({ ...f, checksum_sha256: e.target.value }))}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-xs text-white font-mono" />
                  </div>
                </>
              ) : (
                <div>
                  <label className="text-xs text-slate-400 block mb-1">File *</label>
                  <input ref={fileInputRef} type="file" onChange={e => setUploadFile(e.target.files[0])}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:bg-slate-600 file:text-white" />
                  {uploadFile && <div className="text-xs text-slate-500 mt-1">{uploadFile.name} · {fmtBytes(uploadFile.size)}</div>}
                </div>
              )}
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Installer Type</label>
                  <select value={addForm.installer_type} onChange={e => setAddForm(f => ({ ...f, installer_type: e.target.value }))}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white">
                    <option value="exe">EXE</option>
                    <option value="msi">MSI</option>
                    <option value="ps1">PowerShell</option>
                    <option value="deb">DEB</option>
                    <option value="rpm">RPM</option>
                    <option value="sh">Shell Script</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Target OS</label>
                  <select value={addForm.os_type} onChange={e => setAddForm(f => ({ ...f, os_type: e.target.value }))}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white">
                    <option value="windows">Windows</option>
                    <option value="linux">Linux</option>
                    <option value="any">Any</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Install Args</label>
                  <input value={addForm.install_args} onChange={e => setAddForm(f => ({ ...f, install_args: e.target.value }))}
                    placeholder="/qn /S"
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white font-mono" />
                </div>
              </div>
            </div>

            <div className="flex gap-3 mt-5">
              <button onClick={addPackage} disabled={adding || !addForm.name}
                className="flex-1 bg-blue-600 hover:bg-blue-500 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50">
                {adding ? 'Adding…' : 'Add Package'}
              </button>
              <button onClick={() => setShowAddModal(false)} className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-300 py-2 rounded-lg text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
