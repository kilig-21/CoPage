/** 原生 WebSocket 包装：统一处理重连、消息 JSON 解析与显式关闭。 */
export default class CollabSocket {
  constructor({ token, onOpen, onMessage, onClose, onError }) {
    this.token = token
    this.onOpen = onOpen
    this.onMessage = onMessage
    this.onClose = onClose
    this.onError = onError
    this.socket = null
    this.reconnectTimer = null
    this.heartbeatTimer = null
    this.shouldReconnect = true
    this.reconnectDelay = 500
    this.handleOffline = () => {
      if (!this.shouldReconnect) return
      window.clearTimeout(this.reconnectTimer)
      window.clearInterval(this.heartbeatTimer)
      this.reconnectTimer = null
      this.heartbeatTimer = null
      const previous = this.socket
      this.socket = null
      if (previous) {
        this.onClose?.()
        previous.close()
      }
    }
    this.handleOnline = () => {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
      if (this.shouldReconnect) this.connect()
    }
    window.addEventListener('offline', this.handleOffline)
    window.addEventListener('online', this.handleOnline)
  }

  connect() {
    if (!this.shouldReconnect || navigator.onLine === false || !this.token ||
        this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
      return
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const origin = (import.meta.env?.VITE_BACKEND_WS_ORIGIN || `${protocol}//${window.location.host}`).replace(/\/$/, '')
    const url = `${origin}/ws/collab?token=${encodeURIComponent(this.token)}`
    const socket = new WebSocket(url)
    this.socket = socket

    socket.onopen = () => {
      if (this.socket !== socket || !this.shouldReconnect) return
      this.reconnectDelay = 500
      this.heartbeatTimer = window.setInterval(() => this.send({ type: 'ping' }), 20_000)
      this.onOpen?.()
    }
    socket.onmessage = (event) => {
      if (this.socket !== socket || !this.shouldReconnect) return
      try {
        this.onMessage?.(JSON.parse(event.data))
      } catch {
        this.onError?.('服务端返回了无法解析的协同消息')
      }
    }
    socket.onerror = () => {
      if (this.socket === socket && this.shouldReconnect) this.onError?.('协同连接发生错误')
    }
    socket.onclose = () => {
      if (this.socket !== socket || !this.shouldReconnect) return
      this.socket = null
      window.clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
      this.onClose?.()
      if (this.shouldReconnect) this.scheduleReconnect()
    }
  }

  send(payload) {
    if (navigator.onLine === false || this.socket?.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(payload))
    return true
  }

  close() {
    this.shouldReconnect = false
    window.removeEventListener('offline', this.handleOffline)
    window.removeEventListener('online', this.handleOnline)
    window.clearTimeout(this.reconnectTimer)
    window.clearInterval(this.heartbeatTimer)
    const previous = this.socket
    this.socket = null
    previous?.close()
  }

  scheduleReconnect() {
    window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = window.setTimeout(() => {
      this.connect()
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5_000)
    }, this.reconnectDelay)
  }
}
