export function safeReturnPath(path) {
  return typeof path === 'string' && /^\/(?:docs(?:\/\d+)?|templates|search)(?:[?#].*)?$/.test(path) ? path : '/docs'
}

// 只处理当前请求所属的会话，避免迟到的 401 退出刚登录的新账号；草稿键保持原样。
export function expireSession(storage, requestToken, notify) {
  if (!requestToken || storage.getItem('collab-token') !== requestToken) return false
  storage.removeItem('collab-token')
  storage.removeItem('collab-user')
  notify()
  return true
}
