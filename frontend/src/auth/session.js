export function safeReturnPath(path) {
  return typeof path === 'string' && /^\/(?:docs(?:\/\d+)?|templates|trash|search)(?:[?#].*)?$/.test(path) ? path : '/docs'
}

export function saveSession(storage, { token, username }) {
  if (typeof token !== 'string' || !token.trim() || typeof username !== 'string' || !username.trim()) {
    throw new Error('登录信息不完整，请重试')
  }
  try {
    // 先停止旧身份，再保存账号名；只有完整写入账号名后才能提交新令牌。
    // Web Storage 单次写入失败不会改变该键，因此任一步失败都不会留下身份错配。
    storage.removeItem('collab-token')
    storage.setItem('collab-user', username)
    storage.setItem('collab-token', token)
  } catch {
    throw new Error('浏览器无法保存登录信息，请允许本站保存数据后重试；已有本地草稿仍保留。')
  }
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
