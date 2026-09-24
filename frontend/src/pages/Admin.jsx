import { useState, useEffect, useCallback } from 'react'
import {
  Users, Shield, Settings2, Plus, Pencil, Trash2, RefreshCw,
  KeyRound, CheckCircle2, XCircle, ChevronDown, ChevronUp, UserCog,
  Eye, EyeOff,
} from 'lucide-react'
import api from '../api/client'
import { Link } from 'react-router-dom'

const inputCls = "w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"

const ROLE_COLORS = {
  admin:    'bg-red-900/40 text-red-300 border border-red-800',
  operator: 'bg-blue-900/40 text-blue-300 border border-blue-800',
  viewer:   'bg-slate-700 text-slate-300 border border-slate-600',
}

function RoleBadge({ role }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${ROLE_COLORS[role] || ROLE_COLORS.viewer}`}>
      {role}
    </span>
  )
}

// ── User Form Modal ─────────────────────────────────────────────────────────
function UserModal({ user, onClose, onSaved }) {
  const isEdit = !!user
  const [form, setForm] = useState({
    username: user?.username || '',
    email: user?.email || '',
    full_name: user?.full_name || '',
    role: user?.role || 'viewer',
    is_active: user?.is_active !== false,
    password: '',
    confirm_password: '',
  })
  const [showPw, setShowPw] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function save() {
    if (!isEdit && form.password !== form.confirm_password) {
      setError('Passwords do not match')
      return
    }
    if (!isEdit && form.password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const payload = {
        username: form.username,
        email: form.email,
        full_name: form.full_name,
        role: form.role,
        is_active: form.is_active,
      }
      if (!isEdit) payload.password = form.password
      if (isEdit) {
        await api.put(`/admin/users/${user.id}`, payload)
      } else {
        await api.post('/admin/users', payload)
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
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-md">
        <div className="p-5 border-b border-slate-700 flex items-center justify-between">
          <h2 className="font-semibold text-white">{isEdit ? 'Edit User' : 'Create User'}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <XCircle size={18} />
          </button>
        </div>
        <div className="p-5 space-y-4">
          {error && <div className="bg-red-900/40 border border-red-700 text-red-300 text-sm rounded-lg px-4 py-2">{error}</div>}

          {!isEdit && (
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Username</label>
              <input value={form.username} onChange={e => set('username', e.target.value)} className={inputCls} autoComplete="off" />
            </div>
          )}
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Full Name</label>
            <input value={form.full_name} onChange={e => set('full_name', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Email</label>
            <input type="email" value={form.email} onChange={e => set('email', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Role</label>
            <select value={form.role} onChange={e => set('role', e.target.value)} className={inputCls}>
              <option value="viewer">Viewer — Read-only access</option>
              <option value="operator">Operator — Manage agents &amp; monitors</option>
              <option value="admin">Administrator — Full access</option>
            </select>
          </div>
          {!isEdit && (
            <>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Password</label>
                <div className="relative">
                  <input type={showPw ? 'text' : 'password'} value={form.password}
                    onChange={e => set('password', e.target.value)} className={inputCls} autoComplete="new-password" />
                  <button onClick={() => setShowPw(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white">
                    {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Confirm Password</label>
                <input type={showPw ? 'text' : 'password'} value={form.confirm_password}
                  onChange={e => set('confirm_password', e.target.value)} className={inputCls} autoComplete="new-password" />
              </div>
            </>
          )}
          <label className="flex items-center gap-3 cursor-pointer select-none pt-1">
            <input type="checkbox" checked={form.is_active} onChange={e => set('is_active', e.target.checked)}
              className="w-4 h-4 rounded accent-blue-500" />
            <span className="text-sm text-slate-300">Account active</span>
          </label>
        </div>
        <div className="p-5 border-t border-slate-700 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
          <button onClick={save} disabled={saving || (!isEdit && (!form.username || !form.email || !form.password))}
            className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded-lg">
            {saving && <RefreshCw size={13} className="animate-spin" />}
            {isEdit ? 'Save Changes' : 'Create User'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Reset Password Modal ────────────────────────────────────────────────────
function ResetPasswordModal({ user, onClose }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)

  async function save() {
    if (password !== confirm) { setError('Passwords do not match'); return }
    if (password.length < 8) { setError('Minimum 8 characters'); return }
    setSaving(true)
    setError(null)
    try {
      await api.post(`/admin/users/${user.id}/reset-password`, { password })
      setDone(true)
    } catch (e) {
      setError(e.response?.data?.detail || 'Failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-sm">
        <div className="p-5 border-b border-slate-700 flex items-center justify-between">
          <h2 className="font-semibold text-white">Reset Password — {user.username}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><XCircle size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          {done ? (
            <div className="flex items-center gap-2 text-green-400 text-sm">
              <CheckCircle2 size={16} /> Password reset successfully
            </div>
          ) : (
            <>
              {error && <div className="bg-red-900/40 border border-red-700 text-red-300 text-sm rounded-lg px-4 py-2">{error}</div>}
              <div>
                <label className="text-xs text-slate-400 mb-1 block">New Password</label>
                <div className="relative">
                  <input type={showPw ? 'text' : 'password'} value={password}
                    onChange={e => setPassword(e.target.value)} className={inputCls} autoComplete="new-password" />
                  <button onClick={() => setShowPw(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white">
                    {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Confirm Password</label>
                <input type={showPw ? 'text' : 'password'} value={confirm}
                  onChange={e => setConfirm(e.target.value)} className={inputCls} />
              </div>
            </>
          )}
        </div>
        <div className="p-5 border-t border-slate-700 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white">
            {done ? 'Close' : 'Cancel'}
          </button>
          {!done && (
            <button onClick={save} disabled={saving || !password}
              className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded-lg">
              {saving && <RefreshCw size={13} className="animate-spin" />}
              Reset Password
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Users Tab ─────────────────────────────────────────────────────────────────
function UsersTab() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [editUser, setEditUser] = useState(null)
  const [resetUser, setResetUser] = useState(null)

  const load = useCallback(async () => {
    try {
      const r = await api.get('/admin/users')
      setUsers(r.data)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function toggleActive(u) {
    try {
      await api.put(`/admin/users/${u.id}`, { is_active: !u.is_active })
      load()
    } catch (e) {
      alert(e.response?.data?.detail || 'Failed')
    }
  }

  async function deleteUser(u) {
    if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return
    try {
      await api.delete(`/admin/users/${u.id}`)
      load()
    } catch (e) {
      alert(e.response?.data?.detail || 'Cannot delete this user')
    }
  }

  const currentUser = JSON.parse(localStorage.getItem('kifaa_user') || '{}')

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400">{users.length} user{users.length !== 1 ? 's' : ''} registered</p>
        <button onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg">
          <Plus size={14} /> Add User
        </button>
      </div>

      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-700 text-xs text-slate-400 uppercase bg-slate-800/60">
              <th className="px-5 py-3 text-left">User</th>
              <th className="px-5 py-3 text-left">Email</th>
              <th className="px-5 py-3 text-left">Role</th>
              <th className="px-5 py-3 text-left">Status</th>
              <th className="px-5 py-3 text-left">Last Login</th>
              <th className="px-5 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {loading ? (
              <tr><td colSpan={6} className="py-10 text-center text-slate-500">Loading...</td></tr>
            ) : users.map(u => (
              <tr key={u.id} className="hover:bg-slate-700/30 group">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
                      {u.username[0].toUpperCase()}
                    </div>
                    <div>
                      <div className="font-medium text-white flex items-center gap-1.5">
                        {u.username}
                        {u.username === currentUser.username && (
                          <span className="text-xs text-blue-400 font-normal">(you)</span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500">{u.full_name || '—'}</div>
                    </div>
                  </div>
                </td>
                <td className="px-5 py-3 text-slate-400 text-xs">{u.email}</td>
                <td className="px-5 py-3"><RoleBadge role={u.role} /></td>
                <td className="px-5 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${u.is_active ? 'bg-green-900/40 text-green-400 border border-green-800' : 'bg-slate-700 text-slate-400 border border-slate-600'}`}>
                    {u.is_active ? 'Active' : 'Disabled'}
                  </span>
                </td>
                <td className="px-5 py-3 text-xs text-slate-500">
                  {u.last_login ? new Date(u.last_login).toLocaleString() : 'Never'}
                </td>
                <td className="px-5 py-3 text-right">
                  <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => setResetUser(u)} title="Reset password"
                      className="p-1.5 text-slate-400 hover:text-yellow-400 hover:bg-slate-700 rounded-lg">
                      <KeyRound size={14} />
                    </button>
                    <button onClick={() => setEditUser(u)} title="Edit user"
                      className="p-1.5 text-slate-400 hover:text-blue-400 hover:bg-slate-700 rounded-lg">
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => toggleActive(u)} title={u.is_active ? 'Disable' : 'Enable'}
                      className={`p-1.5 hover:bg-slate-700 rounded-lg ${u.is_active ? 'text-slate-400 hover:text-orange-400' : 'text-slate-600 hover:text-green-400'}`}>
                      {u.is_active ? <XCircle size={14} /> : <CheckCircle2 size={14} />}
                    </button>
                    <button onClick={() => deleteUser(u)} title="Delete user"
                      className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-slate-700 rounded-lg">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && users.length === 0 && (
              <tr><td colSpan={6} className="py-10 text-center text-slate-500">No users found</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {(showCreate || editUser) && (
        <UserModal
          user={editUser}
          onClose={() => { setShowCreate(false); setEditUser(null) }}
          onSaved={load}
        />
      )}
      {resetUser && <ResetPasswordModal user={resetUser} onClose={() => setResetUser(null)} />}
    </div>
  )
}

// ── Roles Tab ─────────────────────────────────────────────────────────────────
function RolesTab() {
  const [roles, setRoles] = useState([])
  const [expanded, setExpanded] = useState(null)

  useEffect(() => {
    api.get('/admin/roles').then(r => setRoles(r.data))
  }, [])

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">System roles define what users can access and manage within the platform.</p>
      <div className="space-y-3">
        {roles.map(r => (
          <div key={r.role} className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
            <button
              onClick={() => setExpanded(expanded === r.role ? null : r.role)}
              className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-slate-700/30 transition-colors"
            >
              <div className="flex items-center gap-3">
                <RoleBadge role={r.role} />
                <div>
                  <div className="font-medium text-white text-sm">{r.name}</div>
                  <div className="text-xs text-slate-400 mt-0.5">{r.description}</div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-500">{r.permissions.length} permissions</span>
                {expanded === r.role ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
              </div>
            </button>
            {expanded === r.role && (
              <div className="px-5 pb-4 border-t border-slate-700">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-3">
                  {r.permissions.map(p => (
                    <div key={p} className="flex items-center gap-2 text-xs text-slate-300">
                      <CheckCircle2 size={12} className="text-green-400 flex-shrink-0" />
                      <code className="text-slate-300">{p}</code>
                    </div>
                  ))}
                </div>
                {!r.editable && (
                  <p className="text-xs text-slate-600 mt-3 italic">System role — cannot be modified</p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main Admin Page ────────────────────────────────────────────────────────────
export default function Admin() {
  const [tab, setTab] = useState('users')
  const [stats, setStats] = useState(null)

  useEffect(() => {
    api.get('/admin/stats').then(r => setStats(r.data)).catch(() => {})
  }, [])

  const tabs = [
    { key: 'users', label: 'Users', icon: Users },
    { key: 'roles', label: 'Roles', icon: Shield },
  ]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <UserCog size={20} className="text-blue-400" /> Administration
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">Manage users, roles, and access control</p>
        </div>
        <Link to="/settings"
          className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-300 hover:text-white text-sm rounded-lg transition-colors">
          <Settings2 size={14} /> System Settings
        </Link>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <div className="text-2xl font-bold text-white">{stats.total_users}</div>
            <div className="text-xs text-slate-400 mt-1">Total Users</div>
          </div>
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <div className="text-2xl font-bold text-green-400">{stats.active_users}</div>
            <div className="text-xs text-slate-400 mt-1">Active</div>
          </div>
          {Object.entries(stats.by_role).map(([role, count]) => (
            <div key={role} className="bg-slate-800 border border-slate-700 rounded-xl p-4">
              <div className="text-2xl font-bold text-white">{count}</div>
              <div className="text-xs text-slate-400 mt-1 capitalize">{role}s</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-700">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t.key ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-400 hover:text-white'
            }`}>
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'users' && <UsersTab />}
      {tab === 'roles' && <RolesTab />}
    </div>
  )
}
