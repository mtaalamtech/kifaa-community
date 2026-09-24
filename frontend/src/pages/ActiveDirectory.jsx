import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { adApi, agentsApi } from '../api/client'
import {
  Users, Shield, Activity, Settings2, RefreshCw,
  Lock, LockOpen, UserCheck, UserX, AlertTriangle,
  ChevronLeft, ChevronRight, Search, CheckCircle, XCircle,
  Clock, Server, Key, BarChart2, KeyRound, TimerReset, Download, Trash2, UserMinus,
  RotateCcw, Copy, Check,
} from 'lucide-react'

// ── Helpers ──────────────────────────────────────────────────────────────────

function Tab({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
        active ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-400 hover:text-white'
      }`}
    >
      {children}
    </button>
  )
}

function Badge({ type }) {
  const map = {
    active:   'bg-emerald-500/20 text-emerald-400',
    disabled: 'bg-slate-600 text-slate-400',
    locked:   'bg-red-500/20 text-red-400',
    admin:    'bg-purple-500/20 text-purple-400',
    svc:      'bg-yellow-500/20 text-yellow-400',
  }
  const labels = { active: 'Active', disabled: 'Disabled', locked: 'Locked', admin: 'Admin', svc: 'Service' }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${map[type] || 'bg-slate-700 text-slate-400'}`}>
      {labels[type] || type}
    </span>
  )
}

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

function fmtDays(d) {
  if (d === null || d === undefined) return '—'
  if (d === 0) return 'Today'
  return `${d}d ago`
}

function ScoreRing({ score }) {
  const color = score >= 80 ? '#10b981' : score >= 60 ? '#f59e0b' : '#ef4444'
  const r = 36
  const circ = 2 * Math.PI * r
  const dash = (score / 100) * circ
  return (
    <svg width="96" height="96" viewBox="0 0 96 96">
      <circle cx="48" cy="48" r={r} fill="none" stroke="#1e293b" strokeWidth="10" />
      <circle cx="48" cy="48" r={r} fill="none" stroke={color} strokeWidth="10"
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        transform="rotate(-90 48 48)" />
      <text x="48" y="53" textAnchor="middle" fill={color} fontSize="18" fontWeight="bold">{score}</text>
    </svg>
  )
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function UsersTab({ agentId, minDaysInactive = null }) {
  const isStaleView = minDaysInactive !== null
  const [users, setUsers] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [selected, setSelected] = useState(new Set())   // Set of sam_account_name
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkConfirm, setBulkConfirm] = useState(null)  // action string pending confirm
  const [autoUnlockSet, setAutoUnlockSet] = useState(() => {
    try {
      const stored = localStorage.getItem(`kifaa_autounlock_${agentId}`)
      return stored ? new Set(JSON.parse(stored)) : new Set()
    } catch { return new Set() }
  })
  const [autoUnlockCountdown, setAutoUnlockCountdown] = useState(120)
  const [autoUnlockStatus, setAutoUnlockStatus] = useState(null) // {time, found}
  const autoUnlockInterval = useRef(null)
  const autoUnlockCountdownInterval = useRef(null)
  const autoUnlockSetRef = useRef(autoUnlockSet)

  function handleExport(fmt) {
    setExporting(true)
    adApi.exportUsers(agentId, fmt)
      .then(r => downloadBlob(new Blob([r.data]), `ad_users_export.${fmt}`))
      .finally(() => setExporting(false))
  }
  const [pwdModal, setPwdModal] = useState(null) // {user, mode: 'change'|'force'}
  const [newPassword, setNewPassword] = useState('')
  const [pwdSaving, setPwdSaving] = useState(false)
  const PAGE_SIZE = 50

  // Reset selection when page/filter changes (keep autoUnlockSet — it persists across pages)
  useEffect(() => { setSelected(new Set()) }, [page, status, search])

  // Keep ref current and persist to localStorage whenever set changes
  useEffect(() => {
    autoUnlockSetRef.current = autoUnlockSet
    try {
      localStorage.setItem(`kifaa_autounlock_${agentId}`, JSON.stringify([...autoUnlockSet]))
    } catch {}
  }, [autoUnlockSet, agentId])

  function toggleAutoUnlock(sam) {
    setAutoUnlockSet(prev => {
      const next = new Set(prev)
      next.has(sam) ? next.delete(sam) : next.add(sam)
      return next
    })
  }

  // Single persistent background loop — starts on mount, runs forever until unmount.
  // Checks every 2 minutes; only acts when autoUnlockSetRef has entries.
  // Adding/removing users from the set never restarts the interval.
  useEffect(() => {
    async function checkAndUnlock() {
      const sams = [...autoUnlockSetRef.current]
      if (sams.length === 0) return
      try {
        const r = await adApi.users(agentId, { status: 'locked', page: 1, page_size: 500 })
        const lockedSams = new Set((r.data.users || []).map(u => u.sam_account_name))
        const toUnlock = sams.filter(s => lockedSams.has(s))
        if (toUnlock.length > 0) {
          await adApi.bulkAction(agentId, { action: 'unlock', sam_account_names: toUnlock })
        }
        setAutoUnlockStatus({ time: new Date(), found: toUnlock.length })
        setAutoUnlockCountdown(120)
      } catch {
        setAutoUnlockStatus(prev => prev ? { ...prev, error: true } : { time: new Date(), found: 0, error: true })
      }
    }

    autoUnlockInterval.current = setInterval(checkAndUnlock, 120000)
    autoUnlockCountdownInterval.current = setInterval(() => {
      setAutoUnlockCountdown(prev => (prev <= 1 ? 120 : prev - 1))
    }, 1000)
    return () => {
      clearInterval(autoUnlockInterval.current)
      clearInterval(autoUnlockCountdownInterval.current)
    }
  }, [agentId])

  const load = useCallback(() => {
    setLoading(true)
    adApi.users(agentId, {
      status: (status === 'autounlock' || !status) ? undefined : status,
      search: search || undefined,
      page,
      page_size: PAGE_SIZE,
      min_days_inactive: minDaysInactive ?? undefined,
    })
      .then(r => { setUsers(r.data.users); setTotal(r.data.total) })
      .finally(() => setLoading(false))
  }, [agentId, status, search, page, minDaysInactive])

  useEffect(() => { load() }, [load])

  function doAction(user, action) {
    if (!window.confirm(`${action} user "${user.sam_account_name}"?`)) return
    setActionLoading(true)
    adApi.action(agentId, { action, sam_account_name: user.sam_account_name })
      .then(() => { alert(`${action} queued.`) })
      .catch(e => alert(e.response?.data?.detail || 'Error'))
      .finally(() => setActionLoading(false))
  }

  function toggleSelect(sam) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(sam) ? next.delete(sam) : next.add(sam)
      return next
    })
  }

  function toggleSelectAll() {
    if (selected.size === users.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(users.map(u => u.sam_account_name)))
    }
  }

  function doBulkAction(action) {
    setBulkLoading(true)
    setBulkConfirm(null)
    adApi.bulkAction(agentId, { action, sam_account_names: [...selected] })
      .then(r => { alert(`${r.data.count} users queued for ${action}.`); setSelected(new Set()) })
      .catch(e => alert(e.response?.data?.detail || 'Error'))
      .finally(() => setBulkLoading(false))
  }

  function doPasswordAction() {
    if (!pwdModal) return
    const { user, mode } = pwdModal
    if (mode === 'change' && !newPassword) { alert('Enter a new password'); return }
    setPwdSaving(true)
    const payload = { action: mode === 'change' ? 'change_password' : 'force_password_change', sam_account_name: user.sam_account_name }
    if (mode === 'change') payload.new_password = newPassword
    adApi.action(agentId, payload)
      .then(() => { alert(mode === 'change' ? 'Password change queued.' : 'Force password change queued.'); setPwdModal(null); setNewPassword('') })
      .catch(e => alert(e.response?.data?.detail || 'Error'))
      .finally(() => setPwdSaving(false))
  }

  const pages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="flex gap-2">
          {['', 'active', 'disabled', 'locked', 'autounlock'].map(s => (
            <button key={s} onClick={() => { setStatus(s); setPage(1) }}
              className={`px-3 py-1.5 rounded text-sm flex items-center gap-1.5 ${
                status === s
                  ? s === 'autounlock' ? 'bg-amber-600 text-white' : 'bg-blue-600 text-white'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}>
              {s === 'autounlock' && <RefreshCw size={12} className={autoUnlockSet.size > 0 ? 'animate-spin' : ''} style={{ animationDuration: '3s' }} />}
              {s === '' ? 'All' : s === 'autounlock' ? `Auto-unlock${autoUnlockSet.size > 0 ? ` (${autoUnlockSet.size})` : ''}` : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <form className="flex gap-2 ml-auto" onSubmit={e => { e.preventDefault(); setSearch(searchInput); setPage(1) }}>
          <input value={searchInput} onChange={e => setSearchInput(e.target.value)}
            placeholder="Search name / email…"
            className="bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm text-white w-52" />
          <button type="submit" className="bg-slate-600 hover:bg-slate-500 text-white px-3 py-1.5 rounded text-sm flex items-center gap-1">
            <Search size={14} />
          </button>
        </form>
        <div className="flex gap-2">
          <button onClick={() => handleExport('csv')} disabled={exporting}
            className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white px-3 py-1.5 rounded text-sm flex items-center gap-1.5">
            <Download size={14} /> {exporting ? '…' : 'CSV'}
          </button>
          <button onClick={() => handleExport('xlsx')} disabled={exporting}
            className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white px-3 py-1.5 rounded text-sm flex items-center gap-1.5">
            <Download size={14} /> {exporting ? '…' : 'Excel'}
          </button>
        </div>
      </div>

      {/* Bulk action toolbar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-blue-900/30 border border-blue-700/40 rounded-lg">
          <span className="text-sm text-blue-300 font-medium">{selected.size} selected</span>
          <div className="flex gap-2 ml-2">
            <button onClick={() => setBulkConfirm('enable')} disabled={bulkLoading}
              className="flex items-center gap-1.5 px-3 py-1 rounded bg-blue-700/40 hover:bg-blue-700/60 text-blue-300 text-xs disabled:opacity-50">
              <UserCheck size={13} /> Enable
            </button>
            <button onClick={() => setBulkConfirm('disable')} disabled={bulkLoading}
              className="flex items-center gap-1.5 px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs disabled:opacity-50">
              <UserX size={13} /> Disable
            </button>
            <button onClick={() => setBulkConfirm('unlock')} disabled={bulkLoading}
              className="flex items-center gap-1.5 px-3 py-1 rounded bg-green-700/40 hover:bg-green-700/60 text-green-300 text-xs disabled:opacity-50">
              <LockOpen size={13} /> Unlock
            </button>
            <button onClick={() => setBulkConfirm('delete')} disabled={bulkLoading}
              className="flex items-center gap-1.5 px-3 py-1 rounded bg-red-700/40 hover:bg-red-700/60 text-red-300 text-xs disabled:opacity-50">
              <Trash2 size={13} /> Delete
            </button>
          </div>
          <button onClick={() => setSelected(new Set())} className="ml-auto text-xs text-slate-500 hover:text-slate-300">Clear</button>
        </div>
      )}

      {/* Auto-unlock monitor status bar */}
      {autoUnlockSet.size > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 bg-amber-900/15 border border-amber-700/25 rounded-lg text-xs">
          <RefreshCw size={12} className="text-amber-400 animate-spin flex-shrink-0" style={{ animationDuration: '3s' }} />
          <span className="text-amber-300 font-medium">Auto-unlock monitoring {autoUnlockSet.size} user{autoUnlockSet.size > 1 ? 's' : ''}</span>
          <span className="text-slate-500">— next check in {autoUnlockCountdown}s</span>
          {autoUnlockStatus ? (
            <span className="ml-auto text-slate-400">
              Last {autoUnlockStatus.time.toLocaleTimeString()}:&nbsp;
              {autoUnlockStatus.found === 0
                ? <span className="text-emerald-400">no lockouts found</span>
                : <span className="text-amber-300">{autoUnlockStatus.found} unlocked</span>}
              {autoUnlockStatus.error && <span className="text-red-400"> · error</span>}
            </span>
          ) : <span className="ml-auto text-slate-500">Checking now…</span>}
        </div>
      )}

      {/* Bulk confirm modal */}
      {bulkConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 w-full max-w-sm shadow-xl">
            <h2 className={`text-white font-semibold text-lg mb-3 flex items-center gap-2 ${bulkConfirm === 'delete' ? 'text-red-400' : ''}`}>
              {bulkConfirm === 'delete' && <Trash2 size={18} className="text-red-400" />}
              Confirm bulk {bulkConfirm}
            </h2>
            <p className="text-slate-400 text-sm mb-5">
              {bulkConfirm === 'delete'
                ? <><span className="text-red-300 font-semibold">This will permanently delete {selected.size} AD account{selected.size > 1 ? 's' : ''}.</span> This action cannot be undone.</>
                : <>Apply <strong className="text-white">{bulkConfirm}</strong> to <strong className="text-white">{selected.size}</strong> user{selected.size > 1 ? 's' : ''}?</>
              }
            </p>
            <div className="flex gap-3">
              <button onClick={() => doBulkAction(bulkConfirm)}
                className={`flex-1 text-white py-2 rounded-lg text-sm font-medium ${bulkConfirm === 'delete' ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'}`}>
                Confirm
              </button>
              <button onClick={() => setBulkConfirm(null)}
                className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-300 py-2 rounded-lg text-sm">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {isStaleView && (
        <div className="flex items-center gap-2 px-4 py-2 bg-amber-900/20 border border-amber-700/30 rounded-lg text-sm text-amber-300">
          <Clock size={14} />
          Showing users inactive for <strong className="text-amber-200 mx-1">{minDaysInactive}+ days</strong> — sorted by longest inactive first.
        </div>
      )}

      {loading ? (
        <div className="py-12 text-center text-slate-500">Loading users…</div>
      ) : (status === 'autounlock' && autoUnlockSet.size === 0) ? (
        <div className="py-12 text-center text-slate-500">No users have auto-unlock enabled. Use the <RefreshCw size={13} className="inline mx-1" /> button in the Actions column to enable it per user.</div>
      ) : users.length === 0 ? (
        <div className="py-12 text-center text-slate-500">
          {isStaleView ? `No users found inactive for ${minDaysInactive}+ days.` : 'No users found. Try syncing first.'}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-700">
            <table className="w-full text-sm">
              <thead className="bg-slate-800 text-slate-400">
                <tr>
                  <th className="px-4 py-3 w-8">
                    <input type="checkbox"
                      checked={users.length > 0 && selected.size === users.length}
                      onChange={toggleSelectAll}
                      className="w-4 h-4 rounded accent-blue-500 cursor-pointer" />
                  </th>
                  <th className="text-left px-4 py-3">User</th>
                  <th className="text-left px-4 py-3">Department</th>
                  <th className="text-left px-4 py-3">{isStaleView ? 'Last Logon / Inactive' : 'Last Logon'}</th>
                  {!isStaleView && <th className="text-left px-4 py-3">Pwd Expires</th>}
                  <th className="text-left px-4 py-3">Status</th>
                  <th className="text-left px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {(status === 'autounlock' ? users.filter(u => autoUnlockSet.has(u.sam_account_name)) : users).map(u => (
                  <tr key={u.sam_account_name} className={`hover:bg-slate-800/50 ${selected.has(u.sam_account_name) ? 'bg-blue-900/10' : ''}`}>
                    <td className="px-4 py-3">
                      <input type="checkbox"
                        checked={selected.has(u.sam_account_name)}
                        onChange={() => toggleSelect(u.sam_account_name)}
                        className="w-4 h-4 rounded accent-blue-500 cursor-pointer" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-white">{u.display_name || u.sam_account_name}</span>
                        {autoUnlockSet.has(u.sam_account_name) && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/20 text-amber-300 border border-amber-500/30 whitespace-nowrap">
                            <RefreshCw size={8} className="animate-spin" style={{ animationDuration: '3s' }} />
                            auto-unlock
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-400">{u.sam_account_name}{u.email ? ` · ${u.email}` : ''}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-300">{u.department || '—'}</td>
                    <td className="px-4 py-3 text-slate-300">
                      {u.last_logon ? fmtDate(u.last_logon) : <span className="text-slate-500">Never</span>}
                      {u.days_since_logon !== null && u.days_since_logon !== undefined && (
                        <div className={`text-xs font-medium mt-0.5 ${
                          u.days_since_logon >= 180 ? 'text-red-400' :
                          u.days_since_logon >= 90  ? 'text-amber-400' : 'text-slate-500'
                        }`}>{fmtDays(u.days_since_logon)}</div>
                      )}
                      {!u.last_logon && isStaleView && (
                        <div className="text-xs text-red-400 mt-0.5">Never logged in</div>
                      )}
                    </td>
                    {!isStaleView && (
                      <td className="px-4 py-3 text-slate-300">
                        {u.password_never_expires
                          ? <span className="text-orange-400 text-xs">Never</span>
                          : u.password_expires_at ? fmtDate(u.password_expires_at) : '—'
                        }
                        {u.password_expired && <div className="text-xs text-red-400">Expired</div>}
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {u.account_enabled && !u.locked_out && <Badge type="active" />}
                        {!u.account_enabled && <Badge type="disabled" />}
                        {u.locked_out && <Badge type="locked" />}
                        {u.is_admin && <Badge type="admin" />}
                        {u.is_service_account && <Badge type="svc" />}
                        {autoUnlockSet.has(u.sam_account_name) && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/20 text-amber-300 border border-amber-500/30">
                            <RefreshCw size={8} className="animate-spin" style={{ animationDuration: '3s' }} />
                            auto-unlock
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        {u.locked_out && (
                          <button onClick={() => doAction(u, 'unlock')} disabled={actionLoading}
                            title="Unlock" className="p-1.5 rounded bg-green-700/30 hover:bg-green-700/60 text-green-400">
                            <LockOpen size={14} />
                          </button>
                        )}
                        {!u.account_enabled ? (
                          <button onClick={() => doAction(u, 'enable')} disabled={actionLoading}
                            title="Enable" className="p-1.5 rounded bg-blue-700/30 hover:bg-blue-700/60 text-blue-400">
                            <UserCheck size={14} />
                          </button>
                        ) : (
                          <button onClick={() => doAction(u, 'disable')} disabled={actionLoading}
                            title="Disable" className="p-1.5 rounded bg-red-700/30 hover:bg-red-700/60 text-red-400">
                            <UserX size={14} />
                          </button>
                        )}
                        <button onClick={() => { setPwdModal({ user: u, mode: 'change' }); setNewPassword('') }}
                          title="Change Password" className="p-1.5 rounded bg-purple-700/30 hover:bg-purple-700/60 text-purple-400">
                          <KeyRound size={14} />
                        </button>
                        <button onClick={() => setPwdModal({ user: u, mode: 'force' })}
                          title="Force Password Change at Next Logon" className="p-1.5 rounded bg-orange-700/30 hover:bg-orange-700/60 text-orange-400">
                          <TimerReset size={14} />
                        </button>
                        <button
                          onClick={() => toggleAutoUnlock(u.sam_account_name)}
                          title={autoUnlockSet.has(u.sam_account_name) ? 'Disable auto-unlock for this user' : 'Enable auto-unlock for this user'}
                          className={`p-1.5 rounded transition-colors ${
                            autoUnlockSet.has(u.sam_account_name)
                              ? 'bg-amber-500/30 hover:bg-amber-500/50 text-amber-300 border border-amber-500/40'
                              : 'bg-slate-700/50 hover:bg-amber-500/20 text-slate-500 hover:text-amber-400'
                          }`}>
                          <RefreshCw size={14} className={autoUnlockSet.has(u.sam_account_name) ? 'animate-spin' : ''} style={{ animationDuration: '3s' }} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Pagination */}
          <div className="flex items-center justify-between text-sm text-slate-400">
            <span>{total} users total</span>
            <div className="flex items-center gap-2">
              <button disabled={page === 1} onClick={() => setPage(p => p - 1)}
                className="p-1 rounded hover:bg-slate-700 disabled:opacity-40"><ChevronLeft size={16} /></button>
              <span>Page {page} / {pages}</span>
              <button disabled={page >= pages} onClick={() => setPage(p => p + 1)}
                className="p-1 rounded hover:bg-slate-700 disabled:opacity-40"><ChevronRight size={16} /></button>
            </div>
          </div>
        </>
      )}

      {/* Password action modal */}
      {pwdModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 w-full max-w-sm shadow-xl">
            {pwdModal.mode === 'change' ? (
              <>
                <h2 className="text-white font-semibold text-lg mb-1 flex items-center gap-2">
                  <KeyRound size={18} className="text-purple-400" /> Change Password
                </h2>
                <p className="text-slate-400 text-sm mb-4">
                  Reset password for <strong className="text-white">{pwdModal.user.sam_account_name}</strong>.
                  Requires LDAPS (port 636) connection to the domain controller.
                </p>
                <div className="mb-4">
                  <label className="text-xs text-slate-400 block mb-1">New Password</label>
                  <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
                    autoFocus
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white" />
                </div>
              </>
            ) : (
              <>
                <h2 className="text-white font-semibold text-lg mb-1 flex items-center gap-2">
                  <TimerReset size={18} className="text-orange-400" /> Force Password Change
                </h2>
                <p className="text-slate-400 text-sm mb-4">
                  Force <strong className="text-white">{pwdModal.user.sam_account_name}</strong> to change their password at next logon. Sets <code className="text-orange-300">pwdLastSet=0</code>.
                </p>
              </>
            )}
            <div className="flex gap-3">
              <button onClick={doPasswordAction} disabled={pwdSaving}
                className="flex-1 bg-blue-600 hover:bg-blue-500 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50">
                {pwdSaving ? 'Queueing…' : 'Confirm'}
              </button>
              <button onClick={() => { setPwdModal(null); setNewPassword('') }}
                className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-300 py-2 rounded-lg text-sm">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function GroupsTab({ agentId }) {
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [exporting, setExporting] = useState(false)

  function handleExport(fmt) {
    setExporting(true)
    adApi.exportGroups(agentId, fmt)
      .then(r => downloadBlob(new Blob([r.data]), `ad_groups_export.${fmt}`))
      .finally(() => setExporting(false))
  }

  const load = useCallback(() => {
    setLoading(true)
    adApi.groups(agentId, { search: search || undefined })
      .then(r => setGroups(r.data))
      .finally(() => setLoading(false))
  }, [agentId, search])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-4">
      <div className="flex gap-3 flex-wrap items-center">
        <form className="flex gap-2" onSubmit={e => { e.preventDefault(); setSearch(searchInput) }}>
          <input value={searchInput} onChange={e => setSearchInput(e.target.value)}
            placeholder="Search groups…"
            className="bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm text-white w-64" />
          <button type="submit" className="bg-slate-600 hover:bg-slate-500 text-white px-3 py-1.5 rounded text-sm flex items-center gap-1">
            <Search size={14} />
          </button>
        </form>
        <div className="flex gap-2 ml-auto">
          <button onClick={() => handleExport('csv')} disabled={exporting}
            className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white px-3 py-1.5 rounded text-sm flex items-center gap-1.5">
            <Download size={14} /> {exporting ? '…' : 'CSV'}
          </button>
          <button onClick={() => handleExport('xlsx')} disabled={exporting}
            className="bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white px-3 py-1.5 rounded text-sm flex items-center gap-1.5">
            <Download size={14} /> {exporting ? '…' : 'Excel'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="py-12 text-center text-slate-500">Loading groups…</div>
      ) : groups.length === 0 ? (
        <div className="py-12 text-center text-slate-500">No groups found.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-700">
          <table className="w-full text-sm">
            <thead className="bg-slate-800 text-slate-400">
              <tr>
                <th className="text-left px-4 py-3">Group</th>
                <th className="text-left px-4 py-3">Type</th>
                <th className="text-left px-4 py-3">Scope</th>
                <th className="text-left px-4 py-3">Members</th>
                <th className="text-left px-4 py-3">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {groups.map(g => (
                <tr key={g.sam_account_name} className="hover:bg-slate-800/50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-white">{g.display_name || g.sam_account_name}</span>
                      {g.is_privileged && (
                        <span className="text-xs px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded">Privileged</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500">{g.sam_account_name}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-300">{g.group_type || '—'}</td>
                  <td className="px-4 py-3 text-slate-300">{g.group_scope || '—'}</td>
                  <td className="px-4 py-3 text-slate-300">{g.member_count ?? '—'}</td>
                  <td className="px-4 py-3 text-slate-400 max-w-xs truncate">{g.description || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const EVENT_COLORS = {
  4740: 'text-red-400',
  4625: 'text-orange-400',
  4767: 'text-green-400',
  4722: 'text-green-400',
  4725: 'text-slate-400',
  4720: 'text-blue-400',
  4726: 'text-red-400',
  4724: 'text-yellow-400',
  4728: 'text-blue-400',
  4732: 'text-blue-400',
  4756: 'text-blue-400',
}

const EVENT_LABELS = {
  4740: 'Locked Out', 4767: 'Unlocked', 4722: 'Enabled', 4725: 'Disabled',
  4720: 'Created', 4726: 'Deleted', 4724: 'Pwd Reset',
  4728: '+Global Grp', 4732: '+Local Grp', 4756: '+Univ Grp', 4625: 'Failed Logon',
}

function EventsTab({ agentId }) {
  const [events, setEvents] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [hours, setHours] = useState(48)
  const [filterEid, setFilterEid] = useState('')
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(null)
  const PAGE_SIZE = 100

  const load = useCallback(() => {
    setLoading(true)
    adApi.events(agentId, {
      hours, page, page_size: PAGE_SIZE,
      event_id: filterEid || undefined,
      search: search || undefined,
    })
      .then(r => { setEvents(r.data.events); setTotal(r.data.total) })
      .finally(() => setLoading(false))
  }, [agentId, hours, page, filterEid, search])

  useEffect(() => { load() }, [load])

  const pages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="space-y-4">
      <div className="flex gap-3 flex-wrap items-center">
        <select value={hours} onChange={e => { setHours(+e.target.value); setPage(1) }}
          className="bg-slate-700 border border-slate-600 text-white text-sm rounded px-3 py-1.5">
          <option value={24}>Last 24h</option>
          <option value={48}>Last 48h</option>
          <option value={168}>Last 7 days</option>
          <option value={720}>Last 30 days</option>
        </select>
        <select value={filterEid} onChange={e => { setFilterEid(e.target.value); setPage(1) }}
          className="bg-slate-700 border border-slate-600 text-white text-sm rounded px-3 py-1.5">
          <option value="">All events</option>
          {Object.entries(EVENT_LABELS).map(([id, label]) => (
            <option key={id} value={id}>{id} — {label}</option>
          ))}
        </select>
        <button onClick={load} className="bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 px-3 py-1.5 rounded text-sm flex items-center gap-1.5">
          <RefreshCw size={13} /> Refresh
        </button>
        <form className="flex gap-2 ml-auto" onSubmit={e => { e.preventDefault(); setSearch(searchInput); setPage(1) }}>
          <input value={searchInput} onChange={e => setSearchInput(e.target.value)}
            placeholder="Search user / computer / IP…"
            className="bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm text-white w-56" />
          <button type="submit" className="bg-slate-600 hover:bg-slate-500 text-white px-3 py-1.5 rounded text-sm"><Search size={14} /></button>
        </form>
      </div>

      {loading ? (
        <div className="py-12 text-center text-slate-500">Loading events…</div>
      ) : events.length === 0 ? (
        <div className="py-12 text-center text-slate-500">No events in the selected period.</div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-700">
            <table className="w-full text-sm">
              <thead className="bg-slate-800 text-slate-400">
                <tr>
                  <th className="text-left px-4 py-3">Time</th>
                  <th className="text-left px-4 py-3">Event</th>
                  <th className="text-left px-4 py-3">Target User</th>
                  <th className="text-left px-4 py-3">Subject / Actor</th>
                  <th className="text-left px-4 py-3">Source Host / IP</th>
                  <th className="text-left px-4 py-3">DC</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {events.map((ev, i) => {
                  const isLockout = ev.event_id === 4740
                  const isFailed = ev.event_id === 4625
                  const rowKey = `${ev.event_time}-${i}`
                  const isExpanded = expanded === rowKey
                  return (
                    <React.Fragment key={rowKey}>
                      <tr
                        className={`hover:bg-slate-800/50 cursor-pointer ${isLockout ? 'bg-red-950/20' : ''}`}
                        onClick={() => setExpanded(isExpanded ? null : rowKey)}
                      >
                        <td className="px-4 py-3 text-slate-400 whitespace-nowrap">{fmtDate(ev.event_time)}</td>
                        <td className="px-4 py-3">
                          <span className={`font-medium ${EVENT_COLORS[ev.event_id] || 'text-white'}`}>
                            {isLockout && <span className="mr-1">🔒</span>}
                            {ev.label}
                          </span>
                          <div className="text-xs text-slate-500">ID {ev.event_id}</div>
                        </td>
                        <td className="px-4 py-3 text-white font-medium">
                          {ev.target_user || '—'}
                          {ev.target_domain ? <span className="text-slate-400 font-normal">@{ev.target_domain}</span> : ''}
                        </td>
                        <td className="px-4 py-3 text-slate-300">{ev.subject_user || '—'}</td>
                        <td className="px-4 py-3">
                          {ev.calling_computer
                            ? <div className={`font-mono text-xs ${isLockout ? 'text-red-300' : 'text-slate-300'}`}>{ev.calling_computer}</div>
                            : <div className="text-slate-500">—</div>
                          }
                          {ev.calling_ip && (
                            <div className={`font-mono text-xs mt-0.5 ${isLockout ? 'text-red-400' : 'text-slate-500'}`}>
                              {ev.calling_ip}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-400">{ev.dc_name || '—'}</td>
                      </tr>
                      {isExpanded && (
                        <tr className={`${isLockout ? 'bg-red-950/30' : 'bg-slate-800/40'}`}>
                          <td colSpan={6} className="px-6 py-3">
                            {isLockout && (
                              <div className="mb-3 p-3 bg-red-900/30 border border-red-700/40 rounded-lg">
                                <div className="text-red-300 font-semibold text-sm mb-2 flex items-center gap-1.5">
                                  <AlertTriangle size={14} /> Account Lockout Details
                                </div>
                                <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs">
                                  <div><span className="text-slate-400">Locked account: </span><span className="text-white font-mono">{ev.target_user}{ev.target_domain ? `@${ev.target_domain}` : ''}</span></div>
                                  <div><span className="text-slate-400">Locked at: </span><span className="text-white">{fmtDate(ev.event_time)}</span></div>
                                  <div><span className="text-slate-400">Source computer: </span><span className="text-red-300 font-mono">{ev.calling_computer || 'unknown'}</span></div>
                                  <div><span className="text-slate-400">Source IP: </span><span className="text-red-300 font-mono">{ev.calling_ip || 'unresolved'}</span></div>
                                  <div><span className="text-slate-400">Detected by DC: </span><span className="text-white font-mono">{ev.dc_name || '—'}</span></div>
                                  {ev.subject_user && <div><span className="text-slate-400">Admin user: </span><span className="text-white">{ev.subject_user}</span></div>}
                                </div>
                              </div>
                            )}
                            {(isFailed || !isLockout) && (ev.calling_computer || ev.calling_ip) && (
                              <div className="mb-2 text-xs text-slate-400">
                                <span className="font-medium text-slate-300">Source: </span>
                                {ev.calling_computer && <span className="font-mono text-slate-200 mr-2">{ev.calling_computer}</span>}
                                {ev.calling_ip && <span className="font-mono text-slate-400">[{ev.calling_ip}]</span>}
                              </div>
                            )}
                            <div className="text-xs text-slate-500 font-mono break-all leading-relaxed">{ev.description}</div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-sm text-slate-400">
            <span>{total} events</span>
            <div className="flex items-center gap-2">
              <button disabled={page === 1} onClick={() => setPage(p => p - 1)}
                className="p-1 rounded hover:bg-slate-700 disabled:opacity-40"><ChevronLeft size={16} /></button>
              <span>Page {page} / {pages}</span>
              <button disabled={page >= pages} onClick={() => setPage(p => p + 1)}
                className="p-1 rounded hover:bg-slate-700 disabled:opacity-40"><ChevronRight size={16} /></button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function ComplianceTab({ agentId }) {
  const [data, setData] = useState(null)
  const [log, setLog] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      adApi.compliance(agentId),
      adApi.actionLog(agentId, 20),
    ]).then(([c, l]) => {
      setData(c.data)
      setLog(l.data)
    }).finally(() => setLoading(false))
  }, [agentId])

  if (loading) return <div className="py-12 text-center text-slate-500">Loading compliance data…</div>
  if (!data) return <div className="py-12 text-center text-slate-500">No data yet. Run a sync first.</div>

  const score = data.compliance_score || 0

  const metrics = [
    { label: 'Total Users', value: data.total_users, icon: Users, color: 'text-blue-400' },
    { label: 'Active Users', value: data.enabled_users, icon: UserCheck, color: 'text-emerald-400' },
    { label: 'Disabled Users', value: data.disabled_users, icon: UserX, color: 'text-slate-400' },
    { label: 'Locked Accounts', value: data.locked_users, icon: Lock, color: 'text-red-400' },
    { label: 'Pwd Never Expires', value: data.never_expire_passwords, icon: Key, color: 'text-orange-400' },
    { label: 'Expired Passwords', value: data.expired_passwords, icon: AlertTriangle, color: 'text-red-400' },
    { label: 'Stale (30d)', value: data.stale_users_30d, icon: Clock, color: 'text-yellow-400' },
    { label: 'Stale (90d)', value: data.stale_users_90d, icon: Clock, color: 'text-orange-400' },
    { label: 'Admin Accounts', value: data.admin_count, icon: Shield, color: 'text-purple-400' },
    { label: 'Service Accounts', value: data.service_account_count, icon: Server, color: 'text-cyan-400' },
    { label: 'Lockouts (24h)', value: data.lockouts_24h, icon: Lock, color: 'text-red-400' },
    { label: 'Failed Logons (24h)', value: data.failed_logons_24h, icon: AlertTriangle, color: 'text-orange-400' },
  ]

  return (
    <div className="space-y-6">
      {/* Score */}
      <div className="flex items-center gap-6 bg-slate-800 rounded-xl p-6">
        <ScoreRing score={score} />
        <div>
          <div className="text-xl font-bold text-white">Compliance Score</div>
          <div className="text-slate-400 text-sm mt-1">
            {score >= 80 ? 'Good — your AD is well configured.' :
             score >= 60 ? 'Fair — some issues need attention.' :
             'Poor — immediate action required.'}
          </div>
          {data.snapped_at && <div className="text-xs text-slate-500 mt-2">Last sync: {fmtDate(data.snapped_at)}</div>}
        </div>
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {metrics.map(m => {
          const Icon = m.icon
          return (
            <div key={m.label} className="bg-slate-800 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-1">
                <Icon size={14} className={m.color} />
                <span className="text-xs text-slate-400">{m.label}</span>
              </div>
              <div className={`text-2xl font-bold ${m.color}`}>{m.value ?? '—'}</div>
            </div>
          )
        })}
      </div>

      {/* Top failed logon users */}
      {data.top_failed_logon_users?.length > 0 && (
        <div className="bg-slate-800 rounded-xl p-4">
          <div className="text-sm font-medium text-white mb-3">Top Failed Logon Users (24h)</div>
          <div className="space-y-2">
            {data.top_failed_logon_users.map(u => (
              <div key={u.user} className="flex items-center justify-between text-sm">
                <span className="text-slate-300">{u.user || '(unknown)'}</span>
                <span className="text-orange-400 font-medium">{u.count} failures</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action log */}
      <div className="bg-slate-800 rounded-xl p-4">
        <div className="text-sm font-medium text-white mb-3">Recent Actions</div>
        {log.length === 0 ? (
          <div className="text-slate-500 text-sm">No actions yet.</div>
        ) : (
          <div className="space-y-2">
            {log.map(a => (
              <div key={a.action_id} className="flex items-center justify-between text-sm py-1.5 border-b border-slate-700/50 last:border-0">
                <div>
                  <span className="text-white font-medium">{a.action}</span>
                  <span className="text-slate-400 ml-2">{a.sam_account_name}</span>
                  {a.performed_by && <span className="text-slate-500 ml-2">by {a.performed_by}</span>}
                </div>
                <div className="flex items-center gap-2">
                  {a.status === 'completed' && <CheckCircle size={14} className="text-emerald-400" />}
                  {a.status === 'failed' && <XCircle size={14} className="text-red-400" />}
                  {a.status === 'pending' && <Clock size={14} className="text-yellow-400" />}
                  <span className="text-slate-500 text-xs">{fmtDate(a.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function DeletedUsersTab({ agentId }) {
  const [users, setUsers] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [restoreModal, setRestoreModal] = useState(null)  // user object
  const [restoring, setRestoring] = useState(false)
  const [restoreResult, setRestoreResult] = useState(null) // { sam, temp_password, password_set, message }
  const [copied, setCopied] = useState(false)
  const PAGE_SIZE = 50

  const load = useCallback(() => {
    setLoading(true)
    adApi.deletedUsers(agentId, { search: search || undefined, page, page_size: PAGE_SIZE })
      .then(r => { setUsers(r.data.users); setTotal(r.data.total) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [agentId, search, page])

  useEffect(() => { load() }, [load])

  function doRestore() {
    if (!restoreModal) return
    setRestoring(true)
    adApi.restoreUser(agentId, { sam_account_name: restoreModal.sam_account_name })
      .then(r => {
        setRestoreModal(null)
        setRestoreResult(r.data)
        load()
      })
      .catch(e => {
        alert('Restore failed: ' + (e.response?.data?.detail || e.message))
      })
      .finally(() => setRestoring(false))
  }

  function copyPassword(pwd) {
    navigator.clipboard.writeText(pwd).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const pages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="space-y-4">
      {/* Info banner */}
      <div className="flex items-start gap-2 px-4 py-3 bg-amber-900/20 border border-amber-700/30 rounded-lg text-sm text-amber-300">
        <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
        <div>
          This tab shows users deleted via Kifaa. Restore requires <strong>AD Recycle Bin</strong> to be enabled on the domain.
          A temporary password will be generated and the user will be forced to change it on first login.
        </div>
      </div>

      {/* Search */}
      <div className="flex gap-3 items-center">
        <form className="flex gap-2" onSubmit={e => { e.preventDefault(); setSearch(searchInput); setPage(1) }}>
          <input value={searchInput} onChange={e => setSearchInput(e.target.value)}
            placeholder="Search name / email…"
            className="bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm text-white w-64" />
          <button type="submit" className="bg-slate-600 hover:bg-slate-500 text-white px-3 py-1.5 rounded text-sm flex items-center gap-1">
            <Search size={14} />
          </button>
        </form>
        <button onClick={load} className="ml-auto bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 px-3 py-1.5 rounded text-sm flex items-center gap-1.5">
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {loading ? (
        <div className="py-12 text-center text-slate-500">Loading deleted users…</div>
      ) : users.length === 0 ? (
        <div className="py-12 text-center text-slate-500">
          No deleted users on record. Users deleted through Kifaa will appear here.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-700">
            <table className="w-full text-sm">
              <thead className="bg-slate-800 text-slate-400">
                <tr>
                  <th className="text-left px-4 py-3">User</th>
                  <th className="text-left px-4 py-3">Department / Title</th>
                  <th className="text-left px-4 py-3">Deleted</th>
                  <th className="text-left px-4 py-3">Deleted By</th>
                  <th className="text-left px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {users.map(u => (
                  <tr key={u.id} className="hover:bg-slate-800/50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-white">{u.display_name || u.sam_account_name}</div>
                      <div className="text-xs text-slate-400">{u.sam_account_name}{u.email ? ` · ${u.email}` : ''}</div>
                      {u.is_admin && (
                        <span className="text-xs px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded mt-0.5 inline-block">Admin</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-300">
                      {u.department && <div>{u.department}</div>}
                      {u.title && <div className="text-xs text-slate-500">{u.title}</div>}
                      {!u.department && !u.title && <span className="text-slate-500">—</span>}
                    </td>
                    <td className="px-4 py-3 text-slate-400">
                      {u.deleted_at ? new Date(u.deleted_at).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-300">{u.deleted_by || '—'}</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => setRestoreModal(u)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-700/30 hover:bg-emerald-700/60 text-emerald-300 text-xs font-medium"
                      >
                        <RotateCcw size={13} /> Restore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="flex items-center justify-between text-sm text-slate-400">
              <span>{total} deleted users</span>
              <div className="flex items-center gap-2">
                <button disabled={page === 1} onClick={() => setPage(p => p - 1)}
                  className="p-1 rounded hover:bg-slate-700 disabled:opacity-40"><ChevronLeft size={16} /></button>
                <span>Page {page} / {pages}</span>
                <button disabled={page >= pages} onClick={() => setPage(p => p + 1)}
                  className="p-1 rounded hover:bg-slate-700 disabled:opacity-40"><ChevronRight size={16} /></button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Restore confirm modal */}
      {restoreModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 w-full max-w-md shadow-xl">
            <h2 className="text-white font-semibold text-lg mb-1 flex items-center gap-2">
              <RotateCcw size={18} className="text-emerald-400" /> Restore User
            </h2>
            <p className="text-slate-400 text-sm mb-2">
              Restore <strong className="text-white">{restoreModal.display_name || restoreModal.sam_account_name}</strong>{' '}
              (<span className="font-mono text-slate-300">{restoreModal.sam_account_name}</span>) from the AD Recycle Bin?
            </p>
            <div className="text-xs text-slate-500 mb-5 space-y-1">
              <div>• A secure temporary password will be generated automatically</div>
              <div>• The user will be required to change it on first login</div>
              <div>• The temporary password will be shown <strong className="text-amber-300">once</strong> — copy it before closing</div>
            </div>
            <div className="flex gap-3">
              <button onClick={doRestore} disabled={restoring}
                className="flex-1 flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50">
                {restoring ? <><RefreshCw size={14} className="animate-spin" /> Restoring…</> : <><RotateCcw size={14} /> Restore</>}
              </button>
              <button onClick={() => setRestoreModal(null)} disabled={restoring}
                className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-300 py-2 rounded-lg text-sm">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Restore result modal — shows temp password */}
      {restoreResult && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 w-full max-w-md shadow-xl">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle size={20} className="text-emerald-400 flex-shrink-0" />
              <h2 className="text-white font-semibold text-lg">User Restored</h2>
            </div>

            <p className="text-slate-400 text-sm mb-4">{restoreResult.message}</p>

            {restoreResult.password_set && restoreResult.temp_password ? (
              <div className="mb-5">
                <div className="text-xs text-amber-300 font-medium mb-2 flex items-center gap-1.5">
                  <AlertTriangle size={12} /> Temporary password — copy now, will not be shown again
                </div>
                <div className="flex items-center gap-2 bg-slate-900 border border-slate-600 rounded-lg px-4 py-3">
                  <code className="text-emerald-300 font-mono text-sm flex-1 select-all tracking-wide">
                    {restoreResult.temp_password}
                  </code>
                  <button
                    onClick={() => copyPassword(restoreResult.temp_password)}
                    className="flex items-center gap-1 text-xs text-slate-400 hover:text-white px-2 py-1 rounded hover:bg-slate-700 transition-colors"
                  >
                    {copied ? <><Check size={13} className="text-emerald-400" /> Copied</> : <><Copy size={13} /> Copy</>}
                  </button>
                </div>
                <div className="mt-2 text-xs text-slate-500">
                  Send this to <strong className="text-slate-400">{restoreResult.sam_account_name}</strong> via a secure channel.
                  They will be prompted to change it on first login.
                </div>
              </div>
            ) : (
              <div className="mb-5 px-4 py-3 bg-amber-900/20 border border-amber-700/30 rounded-lg text-xs text-amber-300">
                Password could not be set automatically (LDAPS not available). Set it manually in ADUC.
              </div>
            )}

            <button onClick={() => setRestoreResult(null)}
              className="w-full bg-slate-700 hover:bg-slate-600 text-slate-300 py-2 rounded-lg text-sm font-medium">
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function SettingsTab({ agentId, onConfigSaved }) {
  const [cfg, setCfg] = useState({
    domain_fqdn: '', dc_host: '', base_dn: '', service_account: '',
    service_password: '', max_pwd_age_days: 90, sync_interval_seconds: 120,
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  // Test state
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null) // null | {success, message, latency_ms}
  const pollRef = useRef(null)

  useEffect(() => {
    adApi.getConfig(agentId).then(r => {
      if (r.data.configured) {
        setCfg(prev => ({ ...prev, ...r.data, service_password: '' }))
      }
    }).finally(() => setLoading(false))
    return () => clearInterval(pollRef.current)
  }, [agentId])

  function save(e) {
    e.preventDefault()
    setSaving(true)
    setMsg('')
    adApi.saveConfig(agentId, cfg)
      .then(() => { setMsg('Configuration saved.'); onConfigSaved?.() })
      .catch(e => setMsg('Error: ' + (e.response?.data?.detail || e.message)))
      .finally(() => setSaving(false))
  }

  function testConnection() {
    setTesting(true)
    setTestResult(null)

    adApi.test(agentId, {
      dc_host: cfg.dc_host,
      base_dn: cfg.base_dn,
      service_account: cfg.service_account,
      service_password: cfg.service_password,
      use_ssl: cfg.use_ssl || false,
    }).then(r => {
      const commandId = r.data.command_id
      // Poll every 3 seconds for up to 90 seconds
      let attempts = 0
      pollRef.current = setInterval(async () => {
        attempts++
        try {
          const res = await adApi.testResult(commandId)
          if (res.data.ready) {
            clearInterval(pollRef.current)
            setTesting(false)
            setTestResult(res.data)
          } else if (attempts >= 30) {
            clearInterval(pollRef.current)
            setTesting(false)
            setTestResult({ success: false, message: 'Timed out waiting for agent response. Make sure the agent is online.' })
          }
        } catch {
          clearInterval(pollRef.current)
          setTesting(false)
          setTestResult({ success: false, message: 'Error polling for result.' })
        }
      }, 3000)
    }).catch(e => {
      setTesting(false)
      setTestResult({ success: false, message: e.response?.data?.detail || e.message })
    })
  }

  if (loading) return <div className="py-12 text-center text-slate-500">Loading…</div>

  return (
    <form onSubmit={save} className="max-w-lg space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <label className="text-sm text-slate-400 mb-1 block">Domain FQDN *</label>
          <input value={cfg.domain_fqdn} onChange={e => setCfg({ ...cfg, domain_fqdn: e.target.value })}
            placeholder="kenyanut.com"
            className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white text-sm" required />
        </div>
        <div className="col-span-2">
          <label className="text-sm text-slate-400 mb-1 block">DC Host (optional — auto-discovered from domain FQDN if blank)</label>
          <input value={cfg.dc_host} onChange={e => setCfg({ ...cfg, dc_host: e.target.value })}
            placeholder="192.168.0.6 or dc.kenyanut.com"
            className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white text-sm" />
        </div>
        <div className="col-span-2">
          <label className="text-sm text-slate-400 mb-1 block">Base DN *</label>
          <input value={cfg.base_dn} onChange={e => setCfg({ ...cfg, base_dn: e.target.value })}
            placeholder="DC=kenyanut,DC=com"
            className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white text-sm" required />
        </div>
        <div>
          <label className="text-sm text-slate-400 mb-1 block">Service Account *</label>
          <input value={cfg.service_account} onChange={e => setCfg({ ...cfg, service_account: e.target.value })}
            placeholder="KENYANUT\mtunzi"
            className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white text-sm" required />
        </div>
        <div>
          <label className="text-sm text-slate-400 mb-1 block">Password {cfg.domain_fqdn ? '(leave blank to keep existing)' : '*'}</label>
          <input type="password" value={cfg.service_password} onChange={e => setCfg({ ...cfg, service_password: e.target.value })}
            className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white text-sm" />
        </div>
        <div>
          <label className="text-sm text-slate-400 mb-1 block">Max Password Age (days)</label>
          <input type="number" min="1" value={cfg.max_pwd_age_days} onChange={e => setCfg({ ...cfg, max_pwd_age_days: +e.target.value })}
            className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white text-sm" />
        </div>
        <div>
          <label className="text-sm text-slate-400 mb-1 block">Auto Sync Interval (seconds)</label>
          <select value={cfg.sync_interval_seconds} onChange={e => setCfg({ ...cfg, sync_interval_seconds: +e.target.value })}
            className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white text-sm">
            <option value={60}>60s — near real-time</option>
            <option value={120}>2 min</option>
            <option value={300}>5 min</option>
            <option value={600}>10 min</option>
            <option value={900}>15 min</option>
            <option value={1800}>30 min</option>
          </select>
          <p className="text-xs text-slate-500 mt-1">Server auto-queues sync on this schedule when agent is online.</p>
        </div>
      </div>

      {/* Test result banner */}
      {testResult && (
        <div className={`flex items-start gap-3 px-4 py-3 rounded-lg text-sm ${
          testResult.success
            ? 'bg-emerald-900/30 border border-emerald-700/50 text-emerald-300'
            : 'bg-red-900/30 border border-red-700/50 text-red-300'
        }`}>
          {testResult.success
            ? <CheckCircle size={16} className="mt-0.5 flex-shrink-0 text-emerald-400" />
            : <XCircle size={16} className="mt-0.5 flex-shrink-0 text-red-400" />
          }
          <div>
            <div className="font-medium">{testResult.success ? 'Connection successful' : 'Connection failed'}</div>
            <div className="text-xs mt-0.5 opacity-80">{testResult.message}</div>
            {testResult.latency_ms > 0 && (
              <div className="text-xs mt-0.5 opacity-60">Latency: {testResult.latency_ms}ms</div>
            )}
          </div>
        </div>
      )}

      {testing && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-blue-900/20 border border-blue-700/40 text-blue-300 text-sm">
          <RefreshCw size={14} className="animate-spin flex-shrink-0" />
          <span>Testing connection — waiting for agent to respond (up to 90s)…</span>
        </div>
      )}

      {msg && <div className={`text-sm ${msg.startsWith('Error') ? 'text-red-400' : 'text-emerald-400'}`}>{msg}</div>}

      <div className="flex gap-3">
        <button type="button" onClick={testConnection} disabled={testing || saving}
          className="flex items-center gap-2 bg-slate-600 hover:bg-slate-500 text-white px-5 py-2 rounded text-sm font-medium disabled:opacity-50">
          {testing
            ? <><RefreshCw size={14} className="animate-spin" />Testing…</>
            : <><Activity size={14} />Test Connection</>
          }
        </button>
        <button type="submit" disabled={saving || testing}
          className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded text-sm font-medium disabled:opacity-50">
          {saving ? 'Saving…' : 'Save Configuration'}
        </button>
      </div>
    </form>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ActiveDirectory() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [agents, setAgents] = useState([])
  const [configuredAgents, setConfiguredAgents] = useState(new Set())
  const [selectedAgent, setSelectedAgent] = useState(searchParams.get('agent') || '')
  const [tab, setTab] = useState('users')
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [syncStatus, setSyncStatus] = useState(null)
  const [configured, setConfigured] = useState(false)
  const syncPollRef = useRef(null)

  useEffect(() => {
    agentsApi.list({ os_type: 'windows' }).then(async r => {
      const list = r.data?.agents || r.data || []
      setAgents(list)
      // If no agent pre-selected from URL, pick the first one that has AD configured
      if (!selectedAgent && list.length > 0) {
        const configs = await Promise.allSettled(list.map(a => adApi.getConfig(a.id)))
        const cfgSet = new Set(list.filter((_, i) => configs[i].status === 'fulfilled' && configs[i].value?.data?.configured).map(a => a.id))
        setConfiguredAgents(cfgSet)
        const configuredIdx = configs.findIndex(c => c.status === 'fulfilled' && c.value?.data?.configured)
        setSelectedAgent(list[configuredIdx >= 0 ? configuredIdx : 0].id)
      }
    })
  }, [])

  useEffect(() => {
    if (!selectedAgent) return
    setSearchParams({ agent: selectedAgent })
    adApi.getConfig(selectedAgent).then(r => setConfigured(r.data.configured)).catch(() => {})
    adApi.syncStatus(selectedAgent).then(r => setSyncStatus(r.data)).catch(() => {})

    // Auto-refresh sync status every 30s — server auto-queues sync based on interval
    const autoRefresh = setInterval(() => {
      adApi.syncStatus(selectedAgent).then(r => setSyncStatus(r.data)).catch(() => {})
    }, 30000)

    return () => {
      clearInterval(autoRefresh)
      clearInterval(syncPollRef.current)
    }
  }, [selectedAgent])

  function triggerSync() {
    setSyncing(true)
    setSyncMsg('Sync queued — waiting for agent to respond…')
    clearInterval(syncPollRef.current)

    adApi.sync(selectedAgent).then(() => {
      // Poll sync-status every 5s until last_sync_at updates
      const before = syncStatus?.last_sync_at
      let attempts = 0
      syncPollRef.current = setInterval(() => {
        attempts++
        adApi.syncStatus(selectedAgent).then(r => {
          setSyncStatus(r.data)
          const changed = r.data.last_sync_at && r.data.last_sync_at !== before
          if (changed || attempts >= 24) {
            clearInterval(syncPollRef.current)
            setSyncing(false)
            if (changed) setSyncMsg('')
            else setSyncMsg('Sync may still be in progress — check back shortly.')
          }
        }).catch(() => {
          clearInterval(syncPollRef.current)
          setSyncing(false)
        })
      }, 5000)
    }).catch(e => {
      setSyncing(false)
      setSyncMsg('Error: ' + (e.response?.data?.detail || e.message))
    })
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Shield size={24} className="text-blue-400" />
            Active Directory
          </h1>
          <p className="text-slate-400 text-sm mt-0.5">AD plugin — users, groups, security events and compliance</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Agent picker */}
          <select value={selectedAgent} onChange={e => setSelectedAgent(e.target.value)}
            className="bg-slate-700 border border-slate-600 text-white text-sm rounded px-3 py-2 min-w-48">
            {agents.length === 0 && <option value="">No online agents</option>}
            {agents.map(a => (
              <option key={a.id} value={a.id}>
                {a.hostname} ({a.ip_address}){configuredAgents.has(a.id) ? ' ✓' : ''}
              </option>
            ))}
          </select>

          {selectedAgent && configured && (
            <button onClick={triggerSync} disabled={syncing}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded text-sm font-medium disabled:opacity-50">
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
              {syncing ? 'Syncing…' : 'Sync Now'}
            </button>
          )}
        </div>
      </div>

      {/* Sync status panel */}
      {(syncStatus || syncMsg) && (
        <div className={`flex items-start gap-4 px-4 py-3 rounded-lg text-sm border ${
          syncStatus?.last_sync_status === 'error'
            ? 'bg-red-900/20 border-red-700/40 text-red-300'
            : syncing
            ? 'bg-blue-900/20 border-blue-700/40 text-blue-300'
            : syncStatus?.last_sync_status === 'ok'
            ? 'bg-emerald-900/20 border-emerald-700/40 text-emerald-300'
            : 'bg-slate-800 border-slate-700 text-slate-400'
        }`}>
          {syncing && <RefreshCw size={15} className="animate-spin flex-shrink-0 mt-0.5" />}
          {!syncing && syncStatus?.last_sync_status === 'ok' && <CheckCircle size={15} className="text-emerald-400 flex-shrink-0 mt-0.5" />}
          {!syncing && syncStatus?.last_sync_status === 'error' && <XCircle size={15} className="text-red-400 flex-shrink-0 mt-0.5" />}
          <div className="space-y-0.5 min-w-0">
            {syncing && <div className="font-medium">Sync in progress — waiting for agent…</div>}
            {!syncing && syncStatus?.last_sync_at && (
              <div className="font-medium">
                Last sync: {new Date(syncStatus.last_sync_at).toLocaleString()}
                {syncStatus.last_sync_status && (
                  <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${syncStatus.last_sync_status === 'ok' ? 'bg-emerald-800/50 text-emerald-300' : 'bg-red-800/50 text-red-300'}`}>
                    {syncStatus.last_sync_status}
                  </span>
                )}
              </div>
            )}
            {syncStatus?.last_sync_error && (
              <div className="text-xs opacity-80 font-mono break-all">{syncStatus.last_sync_error}</div>
            )}
            {syncStatus?.snapshot && (
              <div className="text-xs opacity-70 flex gap-3 flex-wrap mt-1">
                <span>{syncStatus.snapshot.total_users} users</span>
                <span className="text-emerald-400">{syncStatus.snapshot.enabled_users} active</span>
                {syncStatus.snapshot.locked_users > 0 && <span className="text-red-400">{syncStatus.snapshot.locked_users} locked</span>}
                <span>{syncStatus.snapshot.total_groups} groups</span>
                {syncStatus.snapshot.compliance_score > 0 && <span>score: {syncStatus.snapshot.compliance_score}</span>}
              </div>
            )}
            {syncMsg && !syncing && <div className="text-xs opacity-80">{syncMsg}</div>}
          </div>
        </div>
      )}

      {!selectedAgent ? (
        <div className="py-20 text-center text-slate-500">Select an online agent above.</div>
      ) : !configured && tab !== 'settings' ? (
        <div className="py-16 text-center space-y-3">
          <Shield size={40} className="mx-auto text-slate-600" />
          <div className="text-slate-400">AD plugin not configured for this agent.</div>
          <button onClick={() => setTab('settings')}
            className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded text-sm font-medium">
            Configure Now
          </button>
        </div>
      ) : (
        <>
          {/* Tabs */}
          <div className="border-b border-slate-700 flex gap-1 overflow-x-auto">
            <Tab active={tab === 'users'} onClick={() => setTab('users')}>
              <span className="flex items-center gap-1.5"><Users size={14} />Users</span>
            </Tab>
            <Tab active={tab === 'groups'} onClick={() => setTab('groups')}>
              <span className="flex items-center gap-1.5"><Shield size={14} />Groups</span>
            </Tab>
            <Tab active={tab === 'events'} onClick={() => setTab('events')}>
              <span className="flex items-center gap-1.5"><Activity size={14} />Security Events</span>
            </Tab>
            <Tab active={tab === 'stale'} onClick={() => setTab('stale')}>
              <span className="flex items-center gap-1.5"><UserMinus size={14} />Inactive Users</span>
            </Tab>
            <Tab active={tab === 'deleted'} onClick={() => setTab('deleted')}>
              <span className="flex items-center gap-1.5"><Trash2 size={14} />Deleted Users</span>
            </Tab>
            <Tab active={tab === 'compliance'} onClick={() => setTab('compliance')}>
              <span className="flex items-center gap-1.5"><BarChart2 size={14} />Compliance</span>
            </Tab>
            <Tab active={tab === 'settings'} onClick={() => setTab('settings')}>
              <span className="flex items-center gap-1.5"><Settings2 size={14} />Settings</span>
            </Tab>
          </div>

          <div className="pt-2">
            {tab === 'users' && <UsersTab agentId={selectedAgent} />}
            {tab === 'stale' && <UsersTab agentId={selectedAgent} minDaysInactive={90} />}
            {tab === 'groups' && <GroupsTab agentId={selectedAgent} />}
            {tab === 'events' && <EventsTab agentId={selectedAgent} />}
            {tab === 'deleted' && <DeletedUsersTab agentId={selectedAgent} />}
            {tab === 'compliance' && <ComplianceTab agentId={selectedAgent} />}
            {tab === 'settings' && <SettingsTab agentId={selectedAgent} onConfigSaved={() => { setConfigured(true); setTab('users') }} />}
          </div>
        </>
      )}
    </div>
  )
}
