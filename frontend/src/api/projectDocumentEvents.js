// 身份变化取消原确认；同账号的原槽变化只重读列表，不能取消正在等待的原请求。
export function subscribeProjectDocumentEvents({ eventTarget, getStorage, readIdentity,
  onIdentityInvalidated = () => {}, onRecordsChanged = () => {} }) {
  let disposed = false
  const identity = () => {
    try {
      const value = readIdentity()
      return value?.account && value.token && typeof value.service === 'string' && value.service
        ? { account: value.account, token: value.token, service: value.service } : null
    } catch { return null }
  }
  let captured = identity()
  const prefix = () => {
    try { return captured ? `copage-project-document:v1:${encodeURIComponent(captured.service)}:${encodeURIComponent(captured.account)}:` : null }
    catch { return null }
  }
  const checkIdentity = force => {
    const next = identity()
    const changed = !next || !captured || next.account !== captured.account || next.token !== captured.token || next.service !== captured.service
    captured = next
    if (!disposed && (force || changed)) onIdentityInvalidated()
    return force || changed
  }
  const reload = () => { if (!disposed) onRecordsChanged() }
  const storageChanged = event => {
    if (disposed) return
    const identityKey = event.key === null || event.key === 'collab-user' || event.key === 'collab-token'
    const currentPrefix = prefix()
    if (!identityKey && !(currentPrefix && typeof event.key === 'string' && event.key.startsWith(currentPrefix))) return
    let storage
    try { storage = getStorage() }
    catch { if (identityKey) { checkIdentity(true); reload() }; return }
    if (event.storageArea !== storage) return
    if (identityKey) {
      // 排队事件的 newValue 可能过旧；只用当前存储核对身份。
      if (checkIdentity(false) || event.key === null) reload()
    } else reload()
  }
  const authChanged = () => { if (!disposed) { checkIdentity(true); reload() } }
  eventTarget.addEventListener('storage', storageChanged)
  eventTarget.addEventListener('copage-auth-changed', authChanged)
  eventTarget.addEventListener('copage-project-documents-changed', reload)
  return () => {
    if (disposed) return
    disposed = true
    eventTarget.removeEventListener('storage', storageChanged)
    eventTarget.removeEventListener('copage-auth-changed', authChanged)
    eventTarget.removeEventListener('copage-project-documents-changed', reload)
  }
}
