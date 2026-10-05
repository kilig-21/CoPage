export function safeReturnPath(path) {
  return typeof path === 'string' && /^\/(?:docs(?:\/\d+)?|templates|trash|search)(?:[?#].*)?$/.test(path) ? path : '/docs'
}

// 只处理当前请求所属的会话，避免迟到的 401 退出刚登录的新账号；草稿键保持原样。
export function expireSession(storage, requestToken, notify) {
  if (!requestToken || storage.getItem('collab-token') !== requestToken) return false
  storage.removeItem('collab-token')
  storage.removeItem('collab-user')
  notify()
  return true
}

// storage 事件仅发送到其它页面；按实际存储判断，忽略排队中的旧事件。
export function subscribeSessionChanges(storage, eventTarget, onChanged) {
  let token = storage.getItem('collab-token')
  const changed = event => {
    if (event.storageArea !== storage || (event.key !== null && event.key !== 'collab-token')) return
    const next = storage.getItem('collab-token')
    if (next === token) return
    token = next
    onChanged()
  }
  eventTarget.addEventListener('storage', changed)
  return () => eventTarget.removeEventListener('storage', changed)
}

// WS 握手错误不提供 HTTP 状态；使用独立的轻量请求确认，网络/5xx 不视为登录失效。
export function createReconnectSessionCheck({ getStatus, isCurrent, onExpired }) {
  let pending = null
  return () => {
    if (!isCurrent()) return Promise.resolve()
    if (pending) return pending
    pending = Promise.resolve().then(getStatus)
      .then(status => { if (status === 401 && isCurrent()) onExpired() })
      .catch(() => {}) // 临时断网继续由协同连接自动重试。
      .finally(() => { pending = null })
    return pending
  }
}
