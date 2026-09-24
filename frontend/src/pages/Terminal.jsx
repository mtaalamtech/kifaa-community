import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Terminal as TerminalIcon, ArrowLeft, Wifi, WifiOff, Download, Save } from 'lucide-react'
import api, { agentsApi } from '../api/client'

export default function Terminal() {
  const { agentId: id } = useParams()
  const termRef = useRef(null)
  const xtermRef = useRef(null)
  const fitAddonRef = useRef(null)
  const wsRef = useRef(null)
  const onDataRef = useRef(null)  // disposable for term.onData — must be released on each reconnect

  const [agent, setAgent] = useState(null)
  const [creds, setCreds] = useState(null)   // null = not loaded yet, false = none configured
  const [status, setStatus] = useState('idle')
  const [errorMsg, setErrorMsg] = useState('')

  // Inline credential form
  const [credForm, setCredForm] = useState({ username: '', password: '', domain: '', port: 22, winrm_port: 5985 })
  const [credSaving, setCredSaving] = useState(false)
  const [credEditing, setCredEditing] = useState(false)

  useEffect(() => {
    Promise.all([
      agentsApi.get(id),
      api.get(`/terminal/credentials/${id}`),
    ]).then(([ar, cr]) => {
      setAgent(ar.data)
      if (cr.data.configured) {
        setCreds(cr.data)
        setCredForm(f => ({ ...f, ...cr.data }))
      } else {
        setCreds(false)
      }
    }).catch(() => setCreds(false))
  }, [id])

  // Init xterm.js — always mounted so this runs once reliably
  useEffect(() => {
    if (!termRef.current) return
    let term, fitAddon
    import('@xterm/xterm').then(({ Terminal }) => {
      import('@xterm/addon-fit').then(({ FitAddon }) => {
        term = new Terminal({
          theme: {
            background: '#0f172a',
            foreground: '#e2e8f0',
            cursor: '#60a5fa',
            cursorAccent: '#0f172a',
            selectionBackground: '#3b82f680',
          },
          fontFamily: 'JetBrains Mono, Consolas, "Courier New", monospace',
          fontSize: 14,
          lineHeight: 1.2,
          cursorBlink: true,
          cursorStyle: 'block',
          scrollback: 5000,
          convertEol: true,
        })
        fitAddon = new FitAddon()
        term.loadAddon(fitAddon)
        term.open(termRef.current)
        xtermRef.current = term
        fitAddonRef.current = fitAddon
        // Defer fit until after the browser has painted the container at its real size
        requestAnimationFrame(() => {
          fitAddon.fit()
        })
      })
    })
    const onResize = () => {
      if (fitAddonRef.current) {
        requestAnimationFrame(() => fitAddonRef.current.fit())
      }
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (wsRef.current) wsRef.current.close()
      if (term) term.dispose()
    }
  }, [])

  const isWindows = !!(agent?.os_type === 'windows' || agent?.os_name?.toLowerCase().includes('windows'))

  const connect = useCallback(() => {
    if (wsRef.current) wsRef.current.close()
    setStatus('connecting')
    setErrorMsg('')

    const term = xtermRef.current
    if (term) { term.clear(); term.writeln('\x1b[33mConnecting…\x1b[0m') }

    const token = localStorage.getItem('kifaa_token')
    if (!token) {
      setStatus('error')
      setErrorMsg('Not authenticated — please log in again')
      return
    }

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsUrl = isWindows
      ? `${proto}://${window.location.host}/api/v1/terminal/winrm/${id}?token=${token}`
      : `${proto}://${window.location.host}/api/v1/terminal/ssh/${id}?token=${token}`

    let ws
    try {
      ws = new WebSocket(wsUrl)
    } catch (e) {
      setStatus('error')
      setErrorMsg('Failed to open WebSocket: ' + e.message)
      return
    }
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('connected')
      if (term) {
        term.clear()
        // Dispose previous listener before registering a new one — otherwise every reconnect
        // accumulates another handler and each keystroke gets sent N times.
        if (onDataRef.current) { onDataRef.current.dispose(); onDataRef.current = null }
        onDataRef.current = term.onData(data => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'data', data }))
        })
        if (!isWindows) {
          // Fit then send real terminal dimensions to SSH server
          requestAnimationFrame(() => {
            if (fitAddonRef.current) fitAddonRef.current.fit()
            const { cols, rows } = term
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'resize', cols, rows }))
            }
          })
        }
      }
    }

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'data' && term) term.write(msg.data)
        else if (msg.type === 'error') {
          setStatus('error')
          setErrorMsg(msg.data)
          if (term) term.writeln(`\r\n\x1b[31mError: ${msg.data}\x1b[0m`)
        }
      } catch {}
    }

    ws.onerror = () => {
      setStatus('error')
      setErrorMsg('WebSocket connection failed — check network or server logs')
    }

    ws.onclose = (e) => {
      if (e.code !== 1000) {
        setStatus('disconnected')
        if (term) term.writeln(`\r\n\x1b[33mConnection closed (code ${e.code})\x1b[0m`)
      } else {
        setStatus('idle')
      }
    }
  }, [id, isWindows])

  // Forward resize to SSH
  useEffect(() => {
    const onResize = () => {
      if (fitAddonRef.current) fitAddonRef.current.fit()
      if (wsRef.current?.readyState === WebSocket.OPEN && xtermRef.current) {
        const { cols, rows } = xtermRef.current
        wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }))
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const disconnect = () => {
    if (wsRef.current) wsRef.current.close(1000)
    setStatus('idle')
  }

  const saveCredentials = async (e) => {
    e.preventDefault()
    setCredSaving(true)
    try {
      const payload = {
        ...credForm,
        connect_type: isWindows ? 'windows' : 'linux',
      }
      await api.post(`/terminal/credentials/${id}`, payload)
      const cr = await api.get(`/terminal/credentials/${id}`)
      setCreds(cr.data)
      setCredEditing(false)
      // Auto-connect after saving (only for new creds, not edits)
      if (!credEditing) setTimeout(connect, 100)
    } catch (err) {
      setErrorMsg('Failed to save credentials: ' + (err.response?.data?.detail || err.message))
    } finally {
      setCredSaving(false)
    }
  }

  const rdpUrl = `/api/v1/terminal/rdp/${id}?token=${localStorage.getItem('kifaa_token') || ''}`

  const statusColor = {
    idle: 'text-slate-400', connecting: 'text-yellow-400',
    connected: 'text-emerald-400', disconnected: 'text-orange-400', error: 'text-red-400',
  }
  const StatusIcon = status === 'connected' ? Wifi : WifiOff

  return (
    <div className="flex flex-col h-full" style={{ height: 'calc(100vh - 112px)', userSelect: 'none' }}>
      {/* Header */}
      <div className="flex items-center gap-4 mb-4 flex-shrink-0">
        <Link to={`/agents/${id}`} className="text-slate-400 hover:text-white"><ArrowLeft size={20} /></Link>
        <div className="flex items-center gap-2">
          <TerminalIcon size={20} className="text-blue-400" />
          <h1 className="text-lg font-bold text-white">
            {!agent ? 'Terminal' : isWindows ? 'PowerShell Terminal' : 'SSH Terminal'} — {agent?.hostname || id}
          </h1>
          <span className={`flex items-center gap-1 text-xs ${statusColor[status]}`}>
            <StatusIcon size={12} /> {status}
          </span>
        </div>
        <div className="ml-auto flex gap-2">
          {isWindows && (
            <a href={rdpUrl}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300">
              <Download size={12} /> RDP File
            </a>
          )}
          {creds && !credEditing && (
            <button onClick={() => setCredEditing(true)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-400">
              <Save size={12} /> Credentials
            </button>
          )}
          {status === 'connected' ? (
            <button onClick={disconnect} className="flex items-center gap-1.5 text-xs px-4 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 text-white font-medium">
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

      {/* Error banner */}
      {errorMsg && (
        <div className="mb-3 flex-shrink-0 bg-red-900/30 border border-red-700/40 rounded-lg p-3 text-sm text-red-400">
          {errorMsg}
        </div>
      )}

      {/* Credentials form — shown when no creds saved, or when editing */}
      {agent && (creds === false || credEditing) && (
        <form onSubmit={saveCredentials} className="mb-4 flex-shrink-0 bg-slate-800/60 border border-slate-700 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-slate-400">
              {isWindows
                ? 'Enter credentials for WinRM (terminal) and RDP access.'
                : 'Enter SSH credentials to connect.'}
            </p>
            {credEditing && (
              <button type="button" onClick={() => setCredEditing(false)}
                className="text-xs text-slate-500 hover:text-white">Cancel</button>
            )}
          </div>
          <div className="flex flex-wrap gap-3 items-end">
            {isWindows && (
              <div>
                <label className="text-xs text-slate-500 block mb-1">Domain</label>
                <input value={credForm.domain} onChange={e => setCredForm(f => ({ ...f, domain: e.target.value }))}
                  placeholder="optional"
                  className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white w-32" />
              </div>
            )}
            <div>
              <label className="text-xs text-slate-500 block mb-1">Username</label>
              <input required value={credForm.username} onChange={e => setCredForm(f => ({ ...f, username: e.target.value }))}
                className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white w-36" />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Password</label>
              <input required={creds === false} type="password" value={credForm.password}
                placeholder={credEditing ? 'leave blank to keep' : ''}
                onChange={e => setCredForm(f => ({ ...f, password: e.target.value }))}
                className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white w-36" />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">{isWindows ? 'WinRM Port' : 'SSH Port'}</label>
              <input type="number" value={isWindows ? credForm.winrm_port : credForm.port}
                onChange={e => isWindows
                  ? setCredForm(f => ({ ...f, winrm_port: parseInt(e.target.value) || 5985 }))
                  : setCredForm(f => ({ ...f, port: parseInt(e.target.value) || 22 }))}
                className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white w-24" />
            </div>
            <button type="submit" disabled={credSaving}
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50">
              <Save size={13} /> {credSaving ? 'Saving…' : credEditing ? 'Save' : 'Save & Connect'}
            </button>
          </div>
        </form>
      )}

      {/* Terminal */}
      <div ref={termRef}
        className="flex-1 rounded-xl overflow-hidden border border-slate-700 bg-slate-950"
        style={{ minHeight: 0, height: '100%' }}
      />
    </div>
  )
}
