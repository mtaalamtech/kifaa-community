import { useState, useEffect, useRef, useCallback } from 'react'
import { Bot, Plus, Trash2, RefreshCw, Key, Users, ClipboardList, Settings, CheckCircle, XCircle, AlertCircle, Copy, Eye, EyeOff, MessageSquare, Smartphone, Monitor } from 'lucide-react'
import api from '../api/client'

const PLATFORM_LABELS = { telegram: 'Telegram', whatsapp: 'WhatsApp', teams: 'Teams' }
const PLATFORM_ICONS = {
  telegram: <svg className="w-4 h-4 fill-sky-400" viewBox="0 0 24 24"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12l-6.869 4.326-2.96-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.83.941z"/></svg>,
  whatsapp: <svg className="w-4 h-4 fill-emerald-400" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>,
  teams: <svg className="w-4 h-4 fill-violet-400" viewBox="0 0 24 24"><path d="M20.625 5.4H13.5V3.225A2.225 2.225 0 0011.278 1H7.222A2.225 2.225 0 005 3.225V5.4H3.375A3.375 3.375 0 000 8.775v8.85A3.375 3.375 0 003.375 21h17.25A3.375 3.375 0 0024 17.625V8.775A3.375 3.375 0 0020.625 5.4zM7.222 3.225h4.056V5.4H7.222V3.225zm9.528 6.75h-1.5v-1.5h1.5v1.5zm-3 3h-1.5v-1.5h1.5v1.5zm-3 0h-1.5v-1.5h1.5v1.5zm-3 0h-1.5v-1.5h1.5v1.5z"/></svg>,
}

function StatusDot({ ok }) {
  return ok
    ? <span className="inline-flex items-center gap-1 text-xs text-emerald-400"><CheckCircle size={12}/> Connected</span>
    : <span className="inline-flex items-center gap-1 text-xs text-slate-500"><XCircle size={12}/> Not configured</span>
}

function Tab({ id, active, onClick, children }) {
  return (
    <button
      onClick={() => onClick(id)}
      className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${active ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}
    >{children}</button>
  )
}

// ── QR Scanner widget ─────────────────────────────────────────────────────────
function WhatsAppQR({ status }) {
  const [qrData, setQrData] = useState(null)
  const [waStatus, setWaStatus] = useState(status || 'unknown')
  const [polling, setPolling] = useState(false)
  const intervalRef = useRef(null)

  const fetchQR = useCallback(async () => {
    try {
      const { data } = await api.get('/bot/whatsapp/qr')
      setWaStatus(data.status)
      setQrData(data.qr_data_url || null)
      if (data.status === 'ready') {
        clearInterval(intervalRef.current)
        setPolling(false)
      }
    } catch {
      setWaStatus('disconnected')
    }
  }, [])

  const startPolling = () => {
    setPolling(true)
    fetchQR()
    intervalRef.current = setInterval(fetchQR, 3000)
  }

  useEffect(() => () => clearInterval(intervalRef.current), [])

  const handleLogout = async () => {
    await api.post('/bot/whatsapp/logout')
    setWaStatus('disconnected')
    setQrData(null)
  }

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          {PLATFORM_ICONS.whatsapp}
          <span className="font-medium text-white">WhatsApp (whatsapp-web.js)</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-0.5 rounded-full border ${
            waStatus === 'ready' ? 'bg-emerald-900/30 text-emerald-400 border-emerald-700'
            : waStatus === 'qr_pending' ? 'bg-yellow-900/30 text-yellow-400 border-yellow-700'
            : 'bg-slate-700 text-slate-400 border-slate-600'
          }`}>{waStatus}</span>
          {waStatus === 'ready' && (
            <button onClick={handleLogout} className="text-xs text-red-400 hover:text-red-300 border border-red-800 px-2 py-0.5 rounded">
              Logout
            </button>
          )}
        </div>
      </div>

      {waStatus !== 'ready' && (
        <div className="space-y-3">
          <p className="text-sm text-slate-400">
            Scan the QR code with the dedicated WhatsApp account for the bot.
            This account will act as the bot number. Use a separate phone/number — not your personal WhatsApp.
          </p>
          {!polling ? (
            <button onClick={startPolling} className="flex items-center gap-2 text-sm bg-emerald-700 hover:bg-emerald-600 text-white px-3 py-1.5 rounded-lg">
              <RefreshCw size={13}/> Show QR Code
            </button>
          ) : (
            <div className="flex flex-col items-center gap-3 py-4">
              {qrData ? (
                <img src={qrData} alt="WhatsApp QR" className="w-48 h-48 rounded-lg border border-slate-600"/>
              ) : (
                <div className="w-48 h-48 rounded-lg border border-slate-600 flex items-center justify-center">
                  <RefreshCw size={20} className="animate-spin text-slate-500"/>
                </div>
              )}
              <p className="text-xs text-slate-500">Waiting for scan... (auto-refreshes every 3s)</p>
            </div>
          )}
        </div>
      )}

      {waStatus === 'ready' && (
        <p className="text-sm text-emerald-400">WhatsApp connected and ready to receive messages.</p>
      )}

      <div className="mt-4 pt-4 border-t border-slate-700">
        <p className="text-xs text-amber-400/80">
          Note: whatsapp-web.js is an unofficial library. WhatsApp may periodically require re-scanning the QR code.
        </p>
      </div>
    </div>
  )
}

// ── Add User modal ────────────────────────────────────────────────────────────
function AddUserModal({ onClose, onAdded }) {
  const [form, setForm] = useState({ platform: 'telegram', platform_id: '', display_name: '', pin: '' })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [showPin, setShowPin] = useState(false)

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSaving(true)
    setErr('')
    try {
      await api.post('/bot/users', form)
      onAdded()
      onClose()
    } catch (e) {
      setErr(e?.response?.data?.detail || 'Error creating user')
    } finally {
      setSaving(false)
    }
  }

  const platformIdLabel = form.platform === 'telegram' ? 'Telegram User ID (numeric)'
    : form.platform === 'whatsapp' ? 'Phone number (international, e.g. 254712345678)'
    : 'Teams User ID (aadObjectId or email)'

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700">
          <span className="font-medium text-white">Add Bot User</span>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">&times;</button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Platform</label>
            <select value={form.platform} onChange={e => set('platform', e.target.value)}
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white">
              <option value="telegram">Telegram</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="teams">Microsoft Teams</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">{platformIdLabel}</label>
            <input value={form.platform_id} onChange={e => set('platform_id', e.target.value)} required
              placeholder={form.platform === 'telegram' ? '123456789' : form.platform === 'whatsapp' ? '254712345678' : 'user@company.com'}
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"/>
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Display Name</label>
            <input value={form.display_name} onChange={e => set('display_name', e.target.value)}
              placeholder="John Doe"
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"/>
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">PIN (min 4 digits)</label>
            <div className="relative">
              <input type={showPin ? 'text' : 'password'} value={form.pin} onChange={e => set('pin', e.target.value)} required minLength={4}
                placeholder="••••"
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white pr-10"/>
              <button type="button" onClick={() => setShowPin(s => !s)} className="absolute right-2 top-2 text-slate-400 hover:text-white">
                {showPin ? <EyeOff size={15}/> : <Eye size={15}/>}
              </button>
            </div>
            <p className="text-xs text-slate-500 mt-1">The user sends this PIN to the bot to authenticate. Share it securely.</p>
          </div>
          {err && <p className="text-xs text-red-400">{err}</p>}
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="flex-1 border border-slate-600 rounded-lg py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
            <button type="submit" disabled={saving} className="flex-1 bg-blue-700 hover:bg-blue-600 text-white rounded-lg py-2 text-sm disabled:opacity-50">
              {saving ? 'Adding…' : 'Add User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Send Message modal ────────────────────────────────────────────────────────
function SendMessageModal({ user, onClose }) {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState('')
  const [sent, setSent] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSending(true)
    setErr('')
    try {
      await api.post(`/bot/users/${user.id}/send-message`, { message })
      setSent(true)
      setTimeout(onClose, 1500)
    } catch (e) {
      const detail = e?.response?.data?.detail || 'Failed to send message'
      setErr(detail)
    } finally {
      setSending(false)
    }
  }

  const platformNote = user.platform === 'teams'
    ? 'Teams Outgoing Webhooks cannot receive proactive messages. The bot can only reply in-channel.'
    : null

  const platformWarning = user.platform === 'telegram'
    ? 'The user must have sent at least one message to the Telegram bot before you can message them. Ask them to open the bot and send /start first.'
    : null

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700">
          <div className="flex items-center gap-2">
            <MessageSquare size={15} className="text-violet-400"/>
            <span className="font-medium text-white">
              Send Message to {user.display_name || user.platform_id}
            </span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">&times;</button>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex items-center gap-2 text-sm text-slate-400">
            {PLATFORM_ICONS[user.platform]}
            <span>{PLATFORM_LABELS[user.platform]} — {user.platform_id}</span>
          </div>

          {platformNote ? (
            <div className="bg-amber-900/20 border border-amber-700 rounded-lg px-3 py-2 text-sm text-amber-400">
              {platformNote}
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              {platformWarning && (
                <div className="bg-slate-700/50 border border-slate-600 rounded-lg px-3 py-2 text-xs text-slate-300">
                  <span className="text-yellow-400 font-medium">Note: </span>{platformWarning}
                </div>
              )}
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Message</label>
                <textarea
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  required
                  rows={4}
                  placeholder="Type your message here…"
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white resize-none"
                />
                <p className="text-xs text-slate-500 mt-1">
                  The message will be delivered to the user's {PLATFORM_LABELS[user.platform]} immediately.
                  It will appear as if from the Kifaa bot.
                </p>
              </div>
              {err && <p className="text-xs text-red-400">{err}</p>}
              {sent && <p className="text-xs text-emerald-400">Message sent successfully!</p>}
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={onClose}
                  className="flex-1 border border-slate-600 rounded-lg py-2 text-sm text-slate-400 hover:text-white">
                  Cancel
                </button>
                <button type="submit" disabled={sending || !message.trim()}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-violet-700 hover:bg-violet-600 text-white rounded-lg py-2 text-sm disabled:opacity-50">
                  <MessageSquare size={13}/>
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Reset PIN modal ───────────────────────────────────────────────────────────
function ResetPinModal({ user, onClose, onReset }) {
  const [pin, setPin] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [showPin, setShowPin] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSaving(true)
    setErr('')
    try {
      await api.post(`/bot/users/${user.id}/reset-pin`, { new_pin: pin })
      onReset()
      onClose()
    } catch (e) {
      setErr(e?.response?.data?.detail || 'Error resetting PIN')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700">
          <span className="font-medium text-white">Reset PIN — {user.display_name || user.platform_id}</span>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl">&times;</button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="text-xs text-slate-400 mb-1 block">New PIN (min 4 digits)</label>
            <div className="relative">
              <input type={showPin ? 'text' : 'password'} value={pin} onChange={e => setPin(e.target.value)} required minLength={4}
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white pr-10"/>
              <button type="button" onClick={() => setShowPin(s => !s)} className="absolute right-2 top-2 text-slate-400 hover:text-white">
                {showPin ? <EyeOff size={15}/> : <Eye size={15}/>}
              </button>
            </div>
          </div>
          <p className="text-xs text-amber-400">This will end the user's current session. They must re-authenticate.</p>
          {err && <p className="text-xs text-red-400">{err}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="flex-1 border border-slate-600 rounded-lg py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
            <button type="submit" disabled={saving} className="flex-1 bg-amber-700 hover:bg-amber-600 text-white rounded-lg py-2 text-sm disabled:opacity-50">
              {saving ? 'Resetting…' : 'Reset PIN'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function BotConfig() {
  const [tab, setTab] = useState('status')
  const [botStatus, setBotStatus] = useState(null)
  const [users, setUsers] = useState([])
  const [auditLog, setAuditLog] = useState([])
  const [showAddUser, setShowAddUser] = useState(false)
  const [resetPinUser, setResetPinUser] = useState(null)
  const [sendMsgUser, setSendMsgUser] = useState(null)
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [loadingAudit, setLoadingAudit] = useState(false)
  const [copied, setCopied] = useState(false)
  const [platformFilter, setPlatformFilter] = useState('')

  const loadStatus = async () => {
    try {
      const { data } = await api.get('/bot/status')
      setBotStatus(data)
    } catch {}
  }

  const loadUsers = async () => {
    setLoadingUsers(true)
    try {
      const { data } = await api.get('/bot/users', { params: platformFilter ? { platform: platformFilter } : {} })
      setUsers(data)
    } catch {} finally { setLoadingUsers(false) }
  }

  const loadAudit = async () => {
    setLoadingAudit(true)
    try {
      const { data } = await api.get('/bot/audit-log', { params: { limit: 100 } })
      setAuditLog(data)
    } catch {} finally { setLoadingAudit(false) }
  }

  useEffect(() => { loadStatus() }, [])
  useEffect(() => { if (tab === 'users') loadUsers() }, [tab, platformFilter])
  useEffect(() => { if (tab === 'audit') loadAudit() }, [tab])

  const deleteUser = async (id) => {
    if (!confirm('Remove this bot user?')) return
    await api.delete(`/bot/users/${id}`)
    loadUsers()
  }

  const toggleActive = async (user) => {
    await api.put(`/bot/users/${user.id}`, { is_active: !user.is_active })
    loadUsers()
  }

  const copyWebhookUrl = () => {
    navigator.clipboard.writeText(botStatus?.teams_webhook_url || '')
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-violet-600/20 flex items-center justify-center">
          <Bot size={18} className="text-violet-400"/>
        </div>
        <div>
          <h1 className="text-xl font-semibold text-white">Bot & Messaging</h1>
          <p className="text-sm text-slate-400">Manage Telegram, WhatsApp, and Teams bot access</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        <Tab id="status" active={tab === 'status'} onClick={setTab}>Status</Tab>
        <Tab id="users" active={tab === 'users'} onClick={setTab}><span className="flex items-center gap-1.5"><Users size={13}/>Users</span></Tab>
        <Tab id="audit" active={tab === 'audit'} onClick={setTab}><span className="flex items-center gap-1.5"><ClipboardList size={13}/>Audit Log</span></Tab>
        <Tab id="setup" active={tab === 'setup'} onClick={setTab}>Setup Guide</Tab>
      </div>

      {/* ── Status tab ─────────────────────────────────────────────────── */}
      {tab === 'status' && (
        <div className="space-y-4">
          {/* Platform status cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Telegram */}
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                {PLATFORM_ICONS.telegram}
                <span className="font-medium text-white">Telegram</span>
              </div>
              <StatusDot ok={botStatus?.telegram_enabled}/>
              {botStatus?.telegram_enabled && (
                <p className="text-xs text-slate-500 mt-2">Polling active — bot is listening for messages.</p>
              )}
              {!botStatus?.telegram_enabled && (
                <p className="text-xs text-slate-500 mt-2">Set TELEGRAM_TOKEN in .env and rebuild to enable.</p>
              )}
            </div>

            {/* Teams */}
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                {PLATFORM_ICONS.teams}
                <span className="font-medium text-white">Microsoft Teams</span>
              </div>
              <StatusDot ok={botStatus?.teams_webhook_url}/>
              {botStatus?.teams_webhook_url && (
                <div className="mt-3">
                  <p className="text-xs text-slate-400 mb-1">Outgoing Webhook URL:</p>
                  <div className="flex items-center gap-2 bg-slate-900 border border-slate-600 rounded px-2 py-1.5">
                    <code className="text-xs text-slate-300 flex-1 truncate">{botStatus.teams_webhook_url}</code>
                    <button onClick={copyWebhookUrl} className="text-slate-400 hover:text-white flex-shrink-0">
                      {copied ? <CheckCircle size={13} className="text-emerald-400"/> : <Copy size={13}/>}
                    </button>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">Paste this into Teams → Channel → Apps → Outgoing Webhooks</p>
                </div>
              )}
            </div>

            {/* WhatsApp status summary */}
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                {PLATFORM_ICONS.whatsapp}
                <span className="font-medium text-white">WhatsApp</span>
              </div>
              <StatusDot ok={botStatus?.whatsapp_status === 'ready'}/>
              <p className="text-xs text-slate-500 mt-2">
                Status: <span className={botStatus?.whatsapp_status === 'ready' ? 'text-emerald-400' : 'text-slate-400'}>
                  {botStatus?.whatsapp_status || 'unknown'}
                </span>
              </p>
            </div>
          </div>

          {/* WhatsApp QR widget */}
          <WhatsAppQR status={botStatus?.whatsapp_status}/>
        </div>
      )}

      {/* ── Users tab ──────────────────────────────────────────────────── */}
      {tab === 'users' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex gap-2">
              {['', 'telegram', 'whatsapp', 'teams'].map(p => (
                <button key={p} onClick={() => setPlatformFilter(p)}
                  className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${platformFilter === p ? 'bg-slate-700 border-slate-500 text-white' : 'border-slate-700 text-slate-400 hover:text-white'}`}>
                  {p ? PLATFORM_LABELS[p] : 'All'}
                </button>
              ))}
            </div>
            <button onClick={() => setShowAddUser(true)} className="flex items-center gap-1.5 text-sm bg-blue-700 hover:bg-blue-600 text-white px-3 py-1.5 rounded-lg">
              <Plus size={13}/> Add User
            </button>
          </div>

          <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 text-xs">
                  <th className="text-left px-4 py-3">Platform</th>
                  <th className="text-left px-4 py-3">ID / Number</th>
                  <th className="text-left px-4 py-3">Name</th>
                  <th className="text-left px-4 py-3">Status</th>
                  <th className="text-left px-4 py-3">Added</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {loadingUsers ? (
                  <tr><td colSpan={6} className="text-center py-8 text-slate-500">Loading…</td></tr>
                ) : users.length === 0 ? (
                  <tr><td colSpan={6} className="text-center py-8 text-slate-500">
                    No bot users configured. Add one to allow access.
                  </td></tr>
                ) : users.map(u => (
                  <tr key={u.id} className="hover:bg-slate-700/30">
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1.5">
                        {PLATFORM_ICONS[u.platform]}
                        <span className="text-slate-300">{PLATFORM_LABELS[u.platform]}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-400">{u.platform_id}</td>
                    <td className="px-4 py-3 text-white">{u.display_name || '—'}</td>
                    <td className="px-4 py-3">
                      <button onClick={() => toggleActive(u)} className={`text-xs px-2 py-0.5 rounded-full border ${u.is_active ? 'bg-emerald-900/30 text-emerald-400 border-emerald-700' : 'bg-slate-700 text-slate-400 border-slate-600'}`}>
                        {u.is_active ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">{new Date(u.created_at).toLocaleDateString()}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 justify-end">
                        <button onClick={() => setSendMsgUser(u)} className="text-violet-400 hover:text-violet-300" title="Send Message">
                          <MessageSquare size={14}/>
                        </button>
                        <button onClick={() => setResetPinUser(u)} className="text-amber-400 hover:text-amber-300" title="Reset PIN">
                          <Key size={14}/>
                        </button>
                        <button onClick={() => deleteUser(u.id)} className="text-red-400 hover:text-red-300" title="Remove">
                          <Trash2 size={14}/>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Audit Log tab ───────────────────────────────────────────────── */}
      {tab === 'audit' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <p className="text-sm text-slate-400">Last 100 commands across all platforms</p>
            <button onClick={loadAudit} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white border border-slate-700 px-3 py-1.5 rounded-lg">
              <RefreshCw size={12}/> Refresh
            </button>
          </div>
          <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400">
                  <th className="text-left px-4 py-3">Time</th>
                  <th className="text-left px-4 py-3">Platform</th>
                  <th className="text-left px-4 py-3">User</th>
                  <th className="text-left px-4 py-3">Command</th>
                  <th className="text-left px-4 py-3">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {loadingAudit ? (
                  <tr><td colSpan={5} className="text-center py-8 text-slate-500">Loading…</td></tr>
                ) : auditLog.length === 0 ? (
                  <tr><td colSpan={5} className="text-center py-8 text-slate-500">No audit entries yet.</td></tr>
                ) : auditLog.map(e => (
                  <tr key={e.id} className="hover:bg-slate-700/30">
                    <td className="px-4 py-2.5 text-slate-500">{new Date(e.ts).toLocaleString()}</td>
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-1">{PLATFORM_ICONS[e.platform]}<span className="text-slate-400">{e.platform}</span></span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-300">{e.display_name || e.platform_id}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-300 max-w-xs truncate">{e.command}</td>
                    <td className="px-4 py-2.5">
                      <span className={`px-1.5 py-0.5 rounded text-xs ${
                        e.result === 'success' ? 'bg-emerald-900/40 text-emerald-400'
                        : e.result === 'denied' ? 'bg-red-900/40 text-red-400'
                        : e.result === 'confirmed' ? 'bg-blue-900/40 text-blue-400'
                        : e.result === 'pending_confirm' ? 'bg-yellow-900/40 text-yellow-400'
                        : 'bg-slate-700 text-slate-400'
                      }`}>{e.result}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Setup Guide tab ─────────────────────────────────────────────── */}
      {tab === 'setup' && (
        <div className="space-y-6 text-sm">
          <SetupSection icon={PLATFORM_ICONS.telegram} title="Telegram Setup">
            <ol className="list-decimal list-inside space-y-2 text-slate-300">
              <li>Open Telegram and message <code className="bg-slate-700 px-1 rounded">@BotFather</code></li>
              <li>Send <code className="bg-slate-700 px-1 rounded">/newbot</code> and follow the prompts to create a bot</li>
              <li>Copy the API token (looks like <code className="bg-slate-700 px-1 rounded">1234567890:ABC...</code>)</li>
              <li>Add it to your <code className="bg-slate-700 px-1 rounded">.env</code> file: <code className="bg-slate-700 px-1 rounded">TELEGRAM_TOKEN=your_token_here</code></li>
              <li>Rebuild the bot container: <code className="bg-slate-700 px-1 rounded">sg docker -c "docker compose up -d --build kifaa-bot"</code></li>
              <li>Add yourself as a bot user in the Users tab (use your numeric Telegram User ID)</li>
              <li>To find your Telegram ID, message <code className="bg-slate-700 px-1 rounded">@userinfobot</code></li>
            </ol>
          </SetupSection>

          <SetupSection icon={PLATFORM_ICONS.whatsapp} title="WhatsApp Setup (Free — whatsapp-web.js)">
            <ol className="list-decimal list-inside space-y-2 text-slate-300">
              <li>Get a dedicated phone number for the bot (SIM card or virtual number)</li>
              <li>Install WhatsApp on that phone and register</li>
              <li>Go to the <strong>Status</strong> tab above and click "Show QR Code"</li>
              <li>On the dedicated phone: WhatsApp → Linked Devices → Link a Device</li>
              <li>Scan the QR code shown in Kifaa</li>
              <li>Status will change to "ready" — the bot is now live</li>
              <li>Add allowed users in the Users tab using their phone numbers (e.g. <code className="bg-slate-700 px-1 rounded">254712345678</code>)</li>
              <li>Session persists across restarts — re-scan only needed if WhatsApp invalidates it</li>
            </ol>
            <p className="mt-3 text-amber-400/80 text-xs">Note: whatsapp-web.js is unofficial and against WhatsApp ToS. Use on a dedicated number, not a business-critical account.</p>
          </SetupSection>

          <SetupSection icon={PLATFORM_ICONS.teams} title="Microsoft Teams Setup">
            <ol className="list-decimal list-inside space-y-2 text-slate-300">
              <li>In Teams, go to the channel where you want the bot</li>
              <li>Click the <strong>⋯</strong> next to the channel → <strong>Connectors</strong></li>
              <li>Search for <strong>Outgoing Webhook</strong> and click Configure</li>
              <li>Enter a name (e.g. "Kifaa Bot") and paste the webhook URL from the Status tab</li>
              <li>Copy the <strong>Security Token</strong> Teams provides</li>
              <li>Add to <code className="bg-slate-700 px-1 rounded">.env</code>: <code className="bg-slate-700 px-1 rounded">TEAMS_HMAC_SECRET=the_security_token</code></li>
              <li>Rebuild: <code className="bg-slate-700 px-1 rounded">sg docker -c "docker compose up -d --build kifaa-bot"</code></li>
              <li>Add users in the Users tab using their Teams Object ID (aadObjectId)</li>
              <li>In Teams, use the bot by typing <code className="bg-slate-700 px-1 rounded">@KifaaBot help</code> in the channel</li>
            </ol>
            <p className="mt-3 text-amber-400/80 text-xs">Note: Teams Outgoing Webhooks require HTTPS. Enable SSL in Kifaa first.</p>
          </SetupSection>

          <SetupSection icon={<Settings size={16} className="text-slate-400"/>} title="Security Notes">
            <ul className="list-disc list-inside space-y-2 text-slate-300">
              <li>Only users in the Users tab can interact with the bot</li>
              <li>Each user must authenticate with their PIN before using commands</li>
              <li>Sessions expire after 4 hours of inactivity</li>
              <li>Destructive commands (restart, unlock, service stop) require typing CONFIRM within 60s</li>
              <li>5 failed PIN attempts locks the user for 10 minutes</li>
              <li>All commands are logged in the Audit Log tab</li>
              <li>Generate strong secrets: <code className="bg-slate-700 px-1 rounded">openssl rand -hex 32</code></li>
            </ul>
          </SetupSection>
        </div>
      )}

      {showAddUser && <AddUserModal onClose={() => setShowAddUser(false)} onAdded={loadUsers}/>}
      {sendMsgUser && <SendMessageModal user={sendMsgUser} onClose={() => setSendMsgUser(null)}/>}
      {resetPinUser && <ResetPinModal user={resetPinUser} onClose={() => setResetPinUser(null)} onReset={loadUsers}/>}
    </div>
  )
}

function SetupSection({ icon, title, children }) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        {icon}
        <h3 className="font-medium text-white">{title}</h3>
      </div>
      {children}
    </div>
  )
}
