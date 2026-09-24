import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ListTodo, RefreshCw, XCircle, RotateCcw, Trash2, Terminal,
  Clock, CheckCircle2, AlertTriangle, Loader2, Play, X, Filter,
  CalendarClock, Plus, Pencil, ToggleLeft, ToggleRight, Users, Monitor, FlaskConical,
} from 'lucide-react'
import api from '../api/client'
import { agentsApi, groupsApi, rebootSchedulesApi } from '../api/client'

// ─── Shared helpers ────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const map = {
    pending:   'bg-yellow-900/40 text-yellow-300 border-yellow-700',
    sent:      'bg-blue-900/40 text-blue-300 border-blue-700',
    running:   'bg-blue-900/40 text-blue-300 border-blue-700',
    success:   'bg-green-900/40 text-green-400 border-green-700',
    failed:    'bg-red-900/40 text-red-400 border-red-700',
    cancelled: 'bg-slate-700 text-slate-400 border-slate-600',
  }
  const icons = {
    pending:   <Clock size={10} />,
    sent:      <Play size={10} />,
    running:   <Loader2 size={10} className="animate-spin" />,
    success:   <CheckCircle2 size={10} />,
    failed:    <AlertTriangle size={10} />,
    cancelled: <XCircle size={10} />,
  }
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border font-medium ${map[status] || map.cancelled}`}>
      {icons[status]} {status}
    </span>
  )
}

function TypeBadge({ type, source }) {
  const labels = {
    patch_scan:   { label: 'Patch Scan', color: 'bg-purple-900/40 text-purple-300 border-purple-700' },
    update_agent: { label: 'Agent Update', color: 'bg-orange-900/40 text-orange-300 border-orange-700' },
    scan:         { label: 'Patch Scan', color: 'bg-purple-900/40 text-purple-300 border-purple-700' },
    apply:        { label: 'Apply Patches', color: 'bg-green-900/40 text-green-300 border-green-700' },
  }
  const t = labels[type] || { label: type, color: 'bg-slate-700 text-slate-300 border-slate-600' }
  return <span className={`px-2 py-0.5 rounded text-xs border font-medium ${t.color}`}>{t.label}</span>
}

// ─── Task output modal ─────────────────────────────────────────────────────────

function JobOutputModal({ jobId, onClose }) {
  const [job, setJob] = useState(null)
  const outputRef = useRef(null)
  const pollRef = useRef(null)

  const fetchJob = useCallback(async () => {
    try {
      const r = await api.get(`/patches/jobs/${jobId}`)
      setJob(r.data)
      if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
      if (['success', 'failed', 'cancelled'].includes(r.data.status)) clearInterval(pollRef.current)
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
            <span className="text-sm font-medium text-white">Task Output</span>
            {job && <StatusBadge status={job.status} />}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>
        <div ref={outputRef} className="flex-1 overflow-auto p-4 font-mono text-xs text-green-300 bg-black/40 whitespace-pre-wrap">
          {job ? (job.output || '(no output yet)') : 'Loading…'}
        </div>
        {job && ['running', 'pending'].includes(job.status) && (
          <div className="px-5 py-2 border-t border-slate-700 text-xs text-slate-500 flex items-center gap-2">
            <Loader2 size={12} className="animate-spin" /> Running…
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Reboot Schedule helpers ───────────────────────────────────────────────────

const DOW_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function freqLabel(s, tzName) {
  const hh = String(s.hour_utc).padStart(2, '0')
  const mm = String(s.minute_utc).padStart(2, '0')
  const tzShort = tzName ? tzName.split('/').pop().replace(/_/g, ' ') : 'UTC'
  const time = `${hh}:${mm} ${tzShort}`
  if (s.frequency === 'daily') return `Daily — ${time}`
  if (s.frequency === 'weekly') return `Weekly — ${DOW_LABELS[s.day_of_week ?? 0]} ${time}`
  if (s.frequency === 'monthly') return `Monthly — Day ${s.day_of_month}, ${time}`
  return s.frequency
}

// ─── Schedule modal ────────────────────────────────────────────────────────────

const EMPTY_FORM = {
  name: '',
  target_type: 'agent',
  agent_id: '',
  group_id: '',
  frequency: 'daily',
  day_of_week: 0,
  day_of_month: 1,
  hour_utc: 2,
  minute_utc: 0,
  mode: 'announced',
  delay_seconds: 60,
}

function ScheduleModal({ initial, agents, groups, tzName, onSave, onClose }) {
  const [form, setForm] = useState(initial ? {
    name: initial.name,
    target_type: initial.target_type,
    agent_id: initial.agent_id || '',
    group_id: initial.group_id || '',
    frequency: initial.frequency,
    day_of_week: initial.day_of_week ?? 0,
    day_of_month: initial.day_of_month ?? 1,
    hour_utc: initial.hour_utc,
    minute_utc: initial.minute_utc,
    mode: initial.mode,
    delay_seconds: initial.delay_seconds,
  } : { ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function handleSave() {
    if (!form.name.trim()) return alert('Name is required')
    if (form.target_type === 'agent' && !form.agent_id) return alert('Select an agent')
    if (form.target_type === 'group' && !form.group_id) return alert('Select a group')
    setSaving(true)
    try {
      const payload = {
        ...form,
        agent_id: form.target_type === 'agent' ? form.agent_id : null,
        group_id: form.target_type === 'group' ? form.group_id : null,
        day_of_week: form.frequency === 'weekly' ? Number(form.day_of_week) : null,
        day_of_month: form.frequency === 'monthly' ? Number(form.day_of_month) : null,
        hour_utc: Number(form.hour_utc),
        minute_utc: Number(form.minute_utc),
        delay_seconds: Number(form.delay_seconds),
      }
      if (initial) {
        await rebootSchedulesApi.update(initial.id, payload)
      } else {
        await rebootSchedulesApi.create(payload)
      }
      onSave()
    } catch (e) {
      alert(e?.response?.data?.detail || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500'
  const labelCls = 'block text-xs text-slate-400 mb-1'

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
          <div className="flex items-center gap-2 text-white font-medium">
            <CalendarClock size={16} className="text-blue-400" />
            {initial ? 'Edit Schedule' : 'New Reboot Schedule'}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={18} /></button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          {/* Name */}
          <div>
            <label className={labelCls}>Schedule Name</label>
            <input className={inputCls} value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Nightly servers reboot" />
          </div>

          {/* Target type */}
          <div>
            <label className={labelCls}>Target Type</label>
            <div className="flex gap-2">
              {['agent', 'group'].map(t => (
                <button key={t}
                  onClick={() => set('target_type', t)}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${form.target_type === t
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-slate-700 border-slate-600 text-slate-300 hover:bg-slate-600'}`}>
                  {t === 'agent' ? <><Monitor size={13} className="inline mr-1" />Agent</> : <><Users size={13} className="inline mr-1" />Group</>}
                </button>
              ))}
            </div>
          </div>

          {/* Agent / Group selector */}
          {form.target_type === 'agent' ? (
            <div>
              <label className={labelCls}>Agent</label>
              <select className={inputCls} value={form.agent_id} onChange={e => set('agent_id', e.target.value)}>
                <option value="">— select agent —</option>
                {agents.map(a => <option key={a.id} value={a.id}>{a.hostname}</option>)}
              </select>
            </div>
          ) : (
            <div>
              <label className={labelCls}>Group</label>
              <select className={inputCls} value={form.group_id} onChange={e => set('group_id', e.target.value)}>
                <option value="">— select group —</option>
                {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
          )}

          {/* Frequency */}
          <div>
            <label className={labelCls}>Frequency</label>
            <select className={inputCls} value={form.frequency} onChange={e => set('frequency', e.target.value)}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>

          {/* Day of week (weekly only) */}
          {form.frequency === 'weekly' && (
            <div>
              <label className={labelCls}>Day of Week</label>
              <select className={inputCls} value={form.day_of_week} onChange={e => set('day_of_week', Number(e.target.value))}>
                {DOW_LABELS.map((d, i) => <option key={i} value={i}>{d}</option>)}
              </select>
            </div>
          )}

          {/* Day of month (monthly only) */}
          {form.frequency === 'monthly' && (
            <div>
              <label className={labelCls}>Day of Month</label>
              <select className={inputCls} value={form.day_of_month} onChange={e => set('day_of_month', Number(e.target.value))}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
          )}

          {/* Time */}
          <div>
            <label className={labelCls}>Time</label>
            <div className="flex gap-2">
              <select className={inputCls} value={form.hour_utc} onChange={e => set('hour_utc', Number(e.target.value))}>
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{String(i).padStart(2, '0')}</option>
                ))}
              </select>
              <select className={inputCls} value={form.minute_utc} onChange={e => set('minute_utc', Number(e.target.value))}>
                {[0, 15, 30, 45].map(m => (
                  <option key={m} value={m}>{String(m).padStart(2, '0')}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Reboot mode */}
          <div>
            <label className={labelCls}>Reboot Mode</label>
            <div className="flex gap-2">
              {['announced', 'silent'].map(mode => (
                <button key={mode}
                  onClick={() => set('mode', mode)}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${form.mode === mode
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-slate-700 border-slate-600 text-slate-300 hover:bg-slate-600'}`}>
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Delay seconds (announced only) */}
          {form.mode === 'announced' && (
            <div>
              <label className={labelCls}>Delay Before Reboot (seconds)</label>
              <input type="number" min={0} className={inputCls}
                value={form.delay_seconds}
                onChange={e => set('delay_seconds', Number(e.target.value))} />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-slate-700">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded-lg">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-50 flex items-center gap-2">
            {saving && <Loader2 size={13} className="animate-spin" />}
            {initial ? 'Save Changes' : 'Create Schedule'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Schedules tab ─────────────────────────────────────────────────────────────

function SchedulesTab() {
  const [schedules, setSchedules] = useState([])
  const [loading, setLoading] = useState(true)
  const [agents, setAgents] = useState([])
  const [groups, setGroups] = useState([])
  const [tzName, setTzName] = useState('UTC')
  const [modal, setModal] = useState(null) // null | 'create' | schedule obj

  const load = useCallback(async () => {
    try {
      const r = await rebootSchedulesApi.list()
      setSchedules(r.data)
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    agentsApi.list().then(r => setAgents(r.data || [])).catch(() => {})
    groupsApi.list().then(r => setGroups(r.data || [])).catch(() => {})
    rebootSchedulesApi.timezone().then(r => setTzName(r.data.timezone || 'UTC')).catch(() => {})
  }, [load])

  async function handleToggle(id) {
    try {
      await rebootSchedulesApi.toggle(id)
      await load()
    } catch (e) {
      alert(e?.response?.data?.detail || 'Toggle failed')
    }
  }

  async function handleTest(s) {
    if (!confirm(`Send a test reboot command for "${s.name}" now?\n\nMode: ${s.mode}${s.mode === 'announced' ? ` (${s.delay_seconds}s warning)` : ''}`)) return
    try {
      const r = await rebootSchedulesApi.test(s.id)
      alert(`Test fired — ${r.data.fired} agent(s) queued for reboot.`)
    } catch (e) {
      alert(e?.response?.data?.detail || 'Test failed')
    }
  }

  async function handleDelete(s) {
    if (!confirm(`Delete schedule "${s.name}"?`)) return
    try {
      await rebootSchedulesApi.delete(s.id)
      setSchedules(prev => prev.filter(x => x.id !== s.id))
    } catch (e) {
      alert(e?.response?.data?.detail || 'Delete failed')
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400">Automated reboot schedules for agents and groups</p>
        <div className="flex items-center gap-2">
          <button onClick={load} className="flex items-center gap-1.5 px-3 py-2 text-xs bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 rounded-lg">
            <RefreshCw size={12} /> Refresh
          </button>
          <button onClick={() => setModal('create')}
            className="flex items-center gap-1.5 px-3 py-2 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium">
            <Plus size={13} /> New Schedule
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-700 text-xs text-slate-400 uppercase bg-slate-800/60">
              <th className="px-4 py-3 text-left">Name</th>
              <th className="px-4 py-3 text-left">Target</th>
              <th className="px-4 py-3 text-left">Frequency</th>
              <th className="px-4 py-3 text-left">Next Run</th>
              <th className="px-4 py-3 text-left">Mode</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {loading ? (
              <tr><td colSpan={7} className="py-12 text-center text-slate-500">Loading…</td></tr>
            ) : schedules.length === 0 ? (
              <tr><td colSpan={7} className="py-12 text-center text-slate-500">No schedules yet — click "New Schedule" to create one</td></tr>
            ) : schedules.map(s => (
              <tr key={s.id} className="hover:bg-slate-700/30">
                <td className="px-4 py-2.5 font-medium text-white">{s.name}</td>
                <td className="px-4 py-2.5">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border font-medium ${
                    s.target_type === 'agent'
                      ? 'bg-blue-900/40 text-blue-300 border-blue-700'
                      : 'bg-purple-900/40 text-purple-300 border-purple-700'
                  }`}>
                    {s.target_type === 'agent' ? <Monitor size={10} /> : <Users size={10} />}
                    {s.target_name || s.target_type}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-300">{freqLabel(s, tzName)}</td>
                <td className="px-4 py-2.5 text-xs text-slate-400">
                  {s.next_run_at ? new Date(s.next_run_at).toLocaleString() : '—'}
                </td>
                <td className="px-4 py-2.5">
                  <span className={`px-2 py-0.5 rounded text-xs border font-medium ${
                    s.mode === 'announced'
                      ? 'bg-yellow-900/40 text-yellow-300 border-yellow-700'
                      : 'bg-slate-700 text-slate-300 border-slate-600'
                  }`}>{s.mode}</span>
                </td>
                <td className="px-4 py-2.5">
                  <button onClick={() => handleToggle(s.id)}
                    className="flex items-center gap-1.5 text-xs font-medium transition-colors"
                    title={s.is_enabled ? 'Click to disable' : 'Click to enable'}>
                    {s.is_enabled
                      ? <><ToggleRight size={16} className="text-green-400" /><span className="text-green-400">Enabled</span></>
                      : <><ToggleLeft size={16} className="text-slate-500" /><span className="text-slate-500">Disabled</span></>}
                  </button>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => handleTest(s)} title="Test — fire now"
                      className="p-1.5 text-slate-400 hover:text-green-400 hover:bg-slate-700 rounded-lg">
                      <FlaskConical size={14} />
                    </button>
                    <button onClick={() => setModal(s)} title="Edit"
                      className="p-1.5 text-slate-400 hover:text-blue-400 hover:bg-slate-700 rounded-lg">
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => handleDelete(s)} title="Delete"
                      className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-slate-700 rounded-lg">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <ScheduleModal
          initial={modal === 'create' ? null : modal}
          agents={agents}
          groups={groups}
          tzName={tzName}
          onSave={() => { setModal(null); load() }}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  )
}

// ─── Main Tasks page ───────────────────────────────────────────────────────────

export default function Tasks() {
  const [activeTab, setActiveTab] = useState('tasks')
  const [tasks, setTasks] = useState([])
  const [stats, setStats] = useState({ pending: 0, running: 0, failed: 0, success: 0 })
  const [loading, setLoading] = useState(true)
  const [source, setSource] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [acting, setActing] = useState(new Set())
  const [viewJobId, setViewJobId] = useState(null)
  const pollRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const [tasksRes, statsRes] = await Promise.all([
        api.get(`/tasks?source=${source}`),
        api.get('/tasks/stats'),
      ])
      setTasks(tasksRes.data)
      setStats(statsRes.data)
    } catch {}
    setLoading(false)
  }, [source])

  useEffect(() => {
    setLoading(true)
    load()
    pollRef.current = setInterval(load, 8000)
    return () => clearInterval(pollRef.current)
  }, [load])

  async function act(taskId, action) {
    setActing(s => new Set(s).add(taskId))
    try {
      if (action === 'delete') {
        await api.delete(`/tasks/${taskId}`)
        setTasks(t => t.filter(x => x.id !== taskId))
      } else {
        await api.post(`/tasks/${taskId}/${action}`)
        await load()
      }
    } catch (e) {
      alert(e?.response?.data?.detail || `${action} failed`)
    } finally {
      setActing(s => { const n = new Set(s); n.delete(taskId); return n })
    }
  }

  const filtered = tasks.filter(t => {
    if (statusFilter !== 'all' && t.status !== statusFilter) return false
    if (search && !t.hostname.toLowerCase().includes(search.toLowerCase()) && !t.task_type.includes(search)) return false
    return true
  })

  const canCancel = t => ['pending', 'running'].includes(t.status)
  const canRetry  = t => ['sent', 'failed', 'cancelled'].includes(t.status)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <ListTodo size={20} className="text-blue-400" /> Tasks
        </h1>
        <p className="text-sm text-slate-400 mt-0.5">Monitor and manage all background tasks, agent commands, and reboot schedules</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-700">
        <button
          onClick={() => setActiveTab('tasks')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'tasks'
            ? 'border-blue-500 text-blue-400'
            : 'border-transparent text-slate-400 hover:text-slate-200'}`}>
          <span className="flex items-center gap-1.5"><ListTodo size={14} /> Activity</span>
        </button>
        <button
          onClick={() => setActiveTab('schedules')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'schedules'
            ? 'border-blue-500 text-blue-400'
            : 'border-transparent text-slate-400 hover:text-slate-200'}`}>
          <span className="flex items-center gap-1.5"><CalendarClock size={14} /> Reboot Schedules</span>
        </button>
      </div>

      {activeTab === 'schedules' ? (
        <SchedulesTab />
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-4 gap-4">
            {[
              { label: 'Pending', value: stats.pending, color: 'text-yellow-400', icon: Clock },
              { label: 'Running', value: stats.running, color: 'text-blue-400', icon: Loader2 },
              { label: 'Failed', value: stats.failed, color: stats.failed > 0 ? 'text-red-400' : 'text-green-400', icon: AlertTriangle },
              { label: 'Succeeded', value: stats.success, color: 'text-green-400', icon: CheckCircle2 },
            ].map(({ label, value, color, icon: Icon }) => (
              <div key={label} className="bg-slate-800 border border-slate-700 rounded-xl p-4">
                <div className={`text-2xl font-bold ${color}`}>{value}</div>
                <div className="text-xs text-slate-400 mt-1 flex items-center gap-1"><Icon size={11} /> {label}</div>
              </div>
            ))}
          </div>

          {/* Toolbar */}
          <div className="flex items-center gap-3 flex-wrap">
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search hostname or type…"
              className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white w-52 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <select value={source} onChange={e => setSource(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
              <option value="all">All Sources</option>
              <option value="command">Agent Commands</option>
              <option value="patch_job">Patch Jobs</option>
            </select>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none">
              <option value="all">All Statuses</option>
              <option value="pending">Pending</option>
              <option value="sent">Sent</option>
              <option value="running">Running</option>
              <option value="success">Success</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <div className="flex-1" />
            <button onClick={load} className="flex items-center gap-1.5 px-3 py-2 text-xs bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 rounded-lg">
              <RefreshCw size={12} /> Refresh
            </button>
          </div>

          {/* Table */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-xs text-slate-400 uppercase bg-slate-800/60">
                  <th className="px-4 py-3 text-left">Agent</th>
                  <th className="px-4 py-3 text-left">Task</th>
                  <th className="px-4 py-3 text-left">Source</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-left">Created</th>
                  <th className="px-4 py-3 text-left">Updated</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {loading ? (
                  <tr><td colSpan={7} className="py-12 text-center text-slate-500">Loading…</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={7} className="py-12 text-center text-slate-500">No tasks found</td></tr>
                ) : filtered.map(t => (
                  <tr key={t.id} className="hover:bg-slate-700/30">
                    <td className="px-4 py-2.5 font-medium text-white">{t.hostname}</td>
                    <td className="px-4 py-2.5"><TypeBadge type={t.task_type} source={t.source} /></td>
                    <td className="px-4 py-2.5">
                      <span className="text-xs text-slate-400">
                        {t.source === 'command' ? 'Agent Command' : 'Patch Job'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5"><StatusBadge status={t.status} /></td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">
                      {t.created_at ? new Date(t.created_at).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">
                      {t.updated_at ? new Date(t.updated_at).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        {t.has_output && (
                          <button onClick={() => setViewJobId(t.job_id)} title="View output"
                            className="p-1.5 text-slate-400 hover:text-green-400 hover:bg-slate-700 rounded-lg">
                            <Terminal size={14} />
                          </button>
                        )}
                        {canRetry(t) && (
                          <button onClick={() => act(t.id, 'retry')} disabled={acting.has(t.id)}
                            title="Retry"
                            className="p-1.5 text-slate-400 hover:text-blue-400 hover:bg-slate-700 rounded-lg disabled:opacity-40">
                            {acting.has(t.id) ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                          </button>
                        )}
                        {canCancel(t) && (
                          <button onClick={() => act(t.id, 'cancel')} disabled={acting.has(t.id)}
                            title="Cancel"
                            className="p-1.5 text-slate-400 hover:text-yellow-400 hover:bg-slate-700 rounded-lg disabled:opacity-40">
                            <XCircle size={14} />
                          </button>
                        )}
                        <button onClick={() => act(t.id, 'delete')} disabled={acting.has(t.id)}
                          title="Delete"
                          className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-slate-700 rounded-lg disabled:opacity-40">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {viewJobId && <JobOutputModal jobId={viewJobId} onClose={() => setViewJobId(null)} />}
        </>
      )}
    </div>
  )
}
