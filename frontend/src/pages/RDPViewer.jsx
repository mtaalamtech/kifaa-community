import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Monitor, Wifi, WifiOff, Maximize2, Save } from 'lucide-react'
import api, { agentsApi } from '../api/client'

export default function RDPViewer() {
  const { agentId } = useParams()
  const outerRef = useRef(null)   // outer div — used for sizing only, no guacamole DOM
  const guacRef = useRef(null)    // inner div — guacamole appends its canvas here (no React children)
  const clientRef = useRef(null)
  const tunnelRef = useRef(null)
  const hadErrorRef = useRef(false)

  const [agent, setAgent] = useState(null)
  const [creds, setCreds] = useState(null)
  const [status, setStatus] = useState('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [credForm, setCredForm] = useState({ username: '', password: '', domain: '' })
  const [credSaving, setCredSaving] = useState(false)
  const [credEditing, setCredEditing] = useState(false)

  useEffect(() => {
    Promise.all([
      agentsApi.get(agentId),
      api.get(`/terminal/credentials/${agentId}`),
    ]).then(([ar, cr]) => {
      setAgent(ar.data)
      if (cr.data.configured) {
        setCreds(cr.data)
        setCredForm(f => ({ ...f, username: cr.data.username || '', domain: cr.data.domain || '' }))
      } else {
        setCreds(false)
      }
    }).catch(() => setCreds(false))
  }, [agentId])

  const disconnect = useCallback(() => {
    if (clientRef.current) {
      try { clientRef.current.disconnect() } catch (e) {}
      clientRef.current = null
    }
    if (guacRef.current) guacRef.current.innerHTML = ''
    setStatus('idle')
  }, [])

  const connect = useCallback(async () => {
    if (!outerRef.current) return
    disconnect()
    hadErrorRef.current = false
    setStatus('connecting')
    setErrorMsg('')

    const token = localStorage.getItem('kifaa_token') || ''
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const w = outerRef.current.offsetWidth || 1280
    const h = outerRef.current.offsetHeight || 800
    // Base URL with NO query params — guacamole-common-js always appends '?' + connectData
    const wsUrl = `${proto}://${window.location.host}/api/v1/terminal/rdp-ws/${agentId}`
    const connectData = `token=${encodeURIComponent(token)}&width=${w}&height=${h}`

    try {
      const Guacamole = (await import('guacamole-common-js')).default

      const tunnel = new Guacamole.WebSocketTunnel(wsUrl)
      tunnelRef.current = tunnel
      const client = new Guacamole.Client(tunnel)
      clientRef.current = client

      // Mount guacamole canvas into the dedicated (React-child-free) div
      const display = client.getDisplay().getElement()
      guacRef.current.innerHTML = ''
      guacRef.current.appendChild(display)

      // Keyboard
      const keyboard = new Guacamole.Keyboard(document)
      keyboard.onkeydown = (keysym) => client.sendKeyEvent(1, keysym)
      keyboard.onkeyup = (keysym) => client.sendKeyEvent(0, keysym)

      // Mouse
      const mouse = new Guacamole.Mouse(display)
      mouse.onEach(['mousedown', 'mouseup', 'mousemove'], (e) => {
        client.sendMouseState(e.state)
      })

      client.onerror = (err) => {
        hadErrorRef.current = true
        setStatus('error')
        const msg = err?.message || err?.toString() || 'RDP connection error'
        setErrorMsg(`RDP error: ${msg}`)
        setCredEditing(true)
      }

      tunnel.onerror = (err) => {
        hadErrorRef.current = true
        setStatus('error')
        const msg = err?.message || err?.toString() || ''
        setErrorMsg(msg
          ? `Tunnel error: ${msg}`
          : 'Connection failed — verify credentials and that RDP (port 3389) is enabled on the target')
        setCredEditing(true)
      }

      tunnel.onstatechange = (s) => {
        if (s === Guacamole.Tunnel.State.OPEN) setStatus('connected')
        if (s === Guacamole.Tunnel.State.CLOSED) {
          if (!hadErrorRef.current) setStatus('idle')
        }
      }

      client.connect(connectData)
    } catch (e) {
      setStatus('error')
      setErrorMsg('Failed to load Guacamole client: ' + e.message)
    }
  }, [agentId, disconnect])

  const saveCredentials = async (e) => {
    e.preventDefault()
    setCredSaving(true)
    try {
      await api.post(`/terminal/credentials/${agentId}`, {
        ...credForm,
        connect_type: 'windows',
        winrm_port: 5985,
        port: 22,
      })
      const cr = await api.get(`/terminal/credentials/${agentId}`)
      setCreds(cr.data)
      setCredEditing(false)
      setTimeout(connect, 100)
    } catch (err) {
      setErrorMsg('Failed to save: ' + (err.response?.data?.detail || err.message))
    } finally {
      setCredSaving(false)
    }
  }

  const toggleFullscreen = () => {
    if (outerRef.current) {
      if (document.fullscreenElement) {
        document.exitFullscreen()
      } else {
        outerRef.current.requestFullscreen()
      }
    }
  }

  const statusColor = {
    idle: 'text-slate-400', connecting: 'text-yellow-400',
    connected: 'text-emerald-400', error: 'text-red-400',
  }
  const StatusIcon = status === 'connected' ? Wifi : WifiOff

  return (
    <div className="flex flex-col h-full" style={{ height: 'calc(100vh - 112px)' }}>
      {/* Header */}
      <div className="flex items-center gap-4 mb-4 flex-shrink-0">
        <Link to={`/agents/${agentId}`} className="text-slate-400 hover:text-white">
          <ArrowLeft size={20} />
        </Link>
        <div className="flex items-center gap-2">
          <Monitor size={20} className="text-blue-400" />
          <h1 className="text-lg font-bold text-white">
            RDP — {agent?.hostname || agentId}
          </h1>
          <span className={`flex items-center gap-1 text-xs ${statusColor[status]}`}>
            <StatusIcon size={12} /> {status}
          </span>
        </div>
        <div className="ml-auto flex gap-2">
          {creds && !credEditing && (
            <button onClick={() => setCredEditing(true)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-400">
              <Save size={12} /> Credentials
            </button>
          )}
          <button onClick={toggleFullscreen}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300">
            <Maximize2 size={12} /> Fullscreen
          </button>
          {status === 'connected' ? (
            <button onClick={disconnect}
              className="flex items-center gap-1.5 text-xs px-4 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 text-white font-medium">
              Disconnect
            </button>
          ) : (
            <button onClick={connect} disabled={status === 'connecting' || (!creds && !credEditing)}
              className="flex items-center gap-1.5 text-xs px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium disabled:opacity-50">
              {status === 'connecting' ? 'Connecting…' : 'Connect'}
            </button>
          )}
        </div>
      </div>

      {/* Error */}
      {errorMsg && (
        <div className="mb-3 flex-shrink-0 bg-red-900/30 border border-red-700/40 rounded-lg p-3 text-sm text-red-400">
          {errorMsg}
        </div>
      )}

      {/* Credentials form */}
      {agent && (creds === false || credEditing) && (
        <form onSubmit={saveCredentials} className="mb-4 flex-shrink-0 bg-slate-800/60 border border-slate-700 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-slate-400">Enter Windows credentials for the RDP session.</p>
            {credEditing && (
              <button type="button" onClick={() => setCredEditing(false)} className="text-xs text-slate-500 hover:text-white">Cancel</button>
            )}
          </div>
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="text-xs text-slate-500 block mb-1">Domain</label>
              <input value={credForm.domain} onChange={e => setCredForm(f => ({ ...f, domain: e.target.value }))}
                placeholder="optional"
                className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white w-32" />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Username</label>
              <input required value={credForm.username} onChange={e => setCredForm(f => ({ ...f, username: e.target.value }))}
                className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white w-36" />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Password</label>
              <input type="password" value={credForm.password}
                required={creds === false}
                placeholder={credEditing ? 'leave blank to keep' : ''}
                onChange={e => setCredForm(f => ({ ...f, password: e.target.value }))}
                className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white w-36" />
            </div>
            <button type="submit" disabled={credSaving}
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50">
              <Save size={13} /> {credSaving ? 'Saving…' : credEditing ? 'Save' : 'Save & Connect'}
            </button>
          </div>
        </form>
      )}

      {/* RDP Display — outer for sizing/fullscreen, inner (guacRef) owned by guacamole */}
      <div
        ref={outerRef}
        className="relative flex-1 rounded-xl overflow-hidden border border-slate-700 bg-black"
        style={{ minHeight: 0, cursor: status === 'connected' ? 'none' : 'default' }}
      >
        {/* Guacamole mounts its canvas here — no React children */}
        <div ref={guacRef} className="absolute inset-0" />

        {/* Status overlay — sibling to guacRef, React owns this */}
        {status !== 'connected' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-600 text-sm gap-2">
            <Monitor size={48} className="text-slate-700" />
            <span>{status === 'connecting' ? 'Connecting to RDP…' : 'Configure credentials and click Connect'}</span>
          </div>
        )}
      </div>
    </div>
  )
}
