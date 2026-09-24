import { useEffect, useRef, useState, useCallback } from 'react'
import { X, Loader2, MonitorSmartphone, Maximize2, Minimize2 } from 'lucide-react'
import api from '../api/client'

/**
 * RemoteControl — agent-based remote desktop viewer.
 *
 * Opens as a full-screen modal. Connects to the server WebSocket which proxies
 * JPEG frames from the kifaa-remote.exe helper running on the Windows machine.
 * Mouse and keyboard events are sent back as JSON.
 */
export default function RemoteControl({ agentId, hostname, onClose }) {
  const canvasRef   = useRef(null)
  const wsRef       = useRef(null)
  const imgRef      = useRef(null)  // reused Image object for JPEG decode
  const [status, setStatus] = useState('connecting')  // connecting | waiting | active | error | disconnected
  const [statusMsg, setStatusMsg] = useState('Deploying remote helper on ' + hostname + '…')
  const [fullscreen, setFullscreen] = useState(false)
  const containerRef = useRef(null)
  const [canvasSize, setCanvasSize] = useState({ w: 1280, h: 800 })

  // ── Session creation + WebSocket connect ────────────────────────────────────
  useEffect(() => {
    let token = null
    let ws = null
    let cancelled = false

    async function start() {
      try {
        // 1. Create session — server deploys helper via SMB
        const res = await api.post('/remote/sessions', { agent_id: agentId })
        token = res.data.token
        if (cancelled) return

        setStatus('waiting')
        setStatusMsg('Waiting for helper to connect…')

        // 2. Open browser WebSocket
        const authToken = localStorage.getItem('kifaa_token')
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
        const wsUrl = `${proto}://${window.location.host}/api/v1/remote/sessions/${token}/browser?ws_token=${authToken}`
        ws = new WebSocket(wsUrl)
        wsRef.current = ws
        ws.binaryType = 'arraybuffer'

        ws.onmessage = (e) => {
          if (typeof e.data === 'string') {
            const msg = JSON.parse(e.data)
            if (msg.type === 'connected') {
              setStatus('active')
              setStatusMsg('')
            } else if (msg.type === 'error') {
              setStatus('error')
              setStatusMsg(msg.msg)
            } else if (msg.type === 'helper_disconnected') {
              setStatus('disconnected')
              setStatusMsg('Remote helper disconnected')
            }
            return
          }
          // Binary = JPEG frame
          renderFrame(e.data)
        }

        ws.onerror = () => {
          setStatus('error')
          setStatusMsg('WebSocket error')
        }
        ws.onclose = () => {
          if (!cancelled) {
            setStatus('disconnected')
            setStatusMsg('Session closed')
          }
        }
      } catch (err) {
        if (!cancelled) {
          setStatus('error')
          setStatusMsg(err?.response?.data?.detail || 'Failed to start session')
        }
      }
    }

    start()
    return () => {
      cancelled = true
      if (ws) ws.close()
      if (token) api.delete(`/remote/sessions/${token}`).catch(() => {})
    }
  }, [agentId])

  // ── Frame rendering ─────────────────────────────────────────────────────────
  const renderFrame = useCallback((arrayBuffer) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const blob = new Blob([arrayBuffer], { type: 'image/jpeg' })
    const url  = URL.createObjectURL(blob)
    if (!imgRef.current) imgRef.current = new Image()
    imgRef.current.onload = () => {
      // Auto-resize canvas to match incoming frame dimensions
      if (canvas.width !== imgRef.current.width || canvas.height !== imgRef.current.height) {
        setCanvasSize({ w: imgRef.current.width, h: imgRef.current.height })
        canvas.width  = imgRef.current.width
        canvas.height = imgRef.current.height
      }
      ctx.drawImage(imgRef.current, 0, 0)
      URL.revokeObjectURL(url)
    }
    imgRef.current.src = url
  }, [])

  // ── Input helpers ────────────────────────────────────────────────────────────
  function sendInput(evt) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(evt))
    }
  }

  function canvasCoords(e) {
    const rect = canvasRef.current.getBoundingClientRect()
    return {
      x: Math.round((e.clientX - rect.left) * (canvasSize.w / rect.width)),
      y: Math.round((e.clientY - rect.top)  * (canvasSize.h / rect.height)),
      w: canvasSize.w,
      h: canvasSize.h,
    }
  }

  function onMouseMove(e) {
    const c = canvasCoords(e)
    sendInput({ type: 'mouse_move', ...c })
  }

  function onMouseDown(e) {
    e.preventDefault()
    const c = canvasCoords(e)
    const btn = ['left', 'middle', 'right'][e.button] || 'left'
    sendInput({ type: 'mouse_down', button: btn, ...c })
  }

  function onMouseUp(e) {
    const c = canvasCoords(e)
    const btn = ['left', 'middle', 'right'][e.button] || 'left'
    sendInput({ type: 'mouse_up', button: btn, ...c })
  }

  function onContextMenu(e) { e.preventDefault() }

  function onWheel(e) {
    e.preventDefault()
    sendInput({ type: 'wheel', delta: Math.sign(e.deltaY) })
  }

  function onKeyDown(e) {
    e.preventDefault()
    sendInput({ type: 'key_down', key: e.key })
  }

  function onKeyUp(e) {
    e.preventDefault()
    sendInput({ type: 'key_up', key: e.key })
  }

  // ── Fullscreen ───────────────────────────────────────────────────────────────
  function toggleFullscreen() {
    if (!fullscreen) {
      containerRef.current?.requestFullscreen?.()
      setFullscreen(true)
    } else {
      document.exitFullscreen?.()
      setFullscreen(false)
    }
  }

  useEffect(() => {
    const handler = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" ref={containerRef}>
      <div className="bg-slate-900 border border-slate-700 rounded-xl flex flex-col w-full h-full max-w-7xl max-h-[95vh] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-700 bg-slate-800 shrink-0">
          <div className="flex items-center gap-2">
            <MonitorSmartphone size={16} className="text-blue-400" />
            <span className="text-sm font-semibold text-white">Remote Control</span>
            <span className="text-xs text-slate-400 font-mono">{hostname}</span>
            {status === 'active' && (
              <span className="text-xs bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full border border-emerald-500/30">Live</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={toggleFullscreen}
              className="p-1.5 rounded hover:bg-slate-700 text-slate-400 hover:text-white transition-colors">
              {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button onClick={onClose}
              className="p-1.5 rounded hover:bg-red-900/40 text-slate-400 hover:text-red-400 transition-colors">
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Viewport */}
        <div className="flex-1 overflow-auto bg-black flex items-center justify-center relative">
          {status !== 'active' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/90 z-10">
              {(status === 'connecting' || status === 'waiting') && (
                <Loader2 size={32} className="text-blue-400 animate-spin" />
              )}
              {status === 'error' && (
                <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
                  <X size={20} className="text-red-400" />
                </div>
              )}
              {status === 'disconnected' && (
                <MonitorSmartphone size={32} className="text-slate-500" />
              )}
              <p className="text-sm text-slate-300 max-w-md text-center">{statusMsg}</p>
              {(status === 'error' || status === 'disconnected') && (
                <button onClick={onClose}
                  className="mt-2 px-4 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm text-white">
                  Close
                </button>
              )}
            </div>
          )}

          {/* Canvas — receives frames, sends input */}
          <canvas
            ref={canvasRef}
            width={canvasSize.w}
            height={canvasSize.h}
            className="max-w-full max-h-full cursor-crosshair"
            style={{ display: status === 'active' ? 'block' : 'none', imageRendering: 'crisp-edges' }}
            tabIndex={0}
            onMouseMove={onMouseMove}
            onMouseDown={onMouseDown}
            onMouseUp={onMouseUp}
            onContextMenu={onContextMenu}
            onWheel={onWheel}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
          />
        </div>

        {/* Footer hint */}
        {status === 'active' && (
          <div className="px-4 py-1.5 border-t border-slate-800 bg-slate-900 text-xs text-slate-500 flex gap-4 shrink-0">
            <span>Click canvas to focus keyboard</span>
            <span>Right-click supported</span>
            <span>Scroll to zoom</span>
          </div>
        )}
      </div>
    </div>
  )
}
