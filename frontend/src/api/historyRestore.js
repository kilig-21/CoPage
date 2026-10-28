// The browser hook injects a persistent metadata store; tests may use a Map.
const pendingRestores = new Map()
const revision = value => Number.isSafeInteger(value) && value >= 0
const uuid = value => typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
const unknown = '原恢复结果未确认。刷新列表、查看其他版本或关闭窗口不会结束等待。'
const trackingFailure = '浏览器暂时无法可靠读取或保存历史恢复确认记录。原记录保留，请恢复本站存储后重新打开历史；尚未发送替代请求。'

export function restoreReply(target, data) {
  if (!revision(data?.revision) || data.revision !== target.expectedRevision + 1 || typeof data.applied !== 'boolean')
    throw new Error('恢复确认响应无效，原请求仍需确认')
  return data.applied ? `已恢复，生成版本 ${data.revision}` : `已确认原恢复，结果为版本 ${data.revision}；本次没有生成新版本。`
}

export function createHistoryRestore({ service, docId, readIdentity, ready, perform, confirmed = () => {}, changed = () => {},
  pending = pendingRestores, newRequestId = () => globalThis.crypto.randomUUID() }) {
  let owner = null, attempt = null, preparation = null, active = true, generation = 0
  const scope = Symbol('history-restore-context')
  let state = { target: null, busy: false, reviewFailed: false, trackingFailed: false, error: '', notice: null, identityEpoch: 0 }
  const emit = patch => { state = { ...state, ...patch }; changed(state) }
  const identity = () => {
    const value = readIdentity()
    if (!value?.token || typeof value.account !== 'string' || !value.account) throw Error('当前账号不可读')
    return value
  }
  const key = account => JSON.stringify([service, account, docId])
  const exclusive = (account, action, signal) => pending.exclusive
    ? pending.exclusive(key(account), action, signal) : action()
  const trackingError = () => emit({ target: null, trackingFailed: true, notice: null, error: trackingFailure })
  function readTarget(account) {
    try { return pending.get(key(account)) || null }
    catch (error) { trackingError(); throw error }
  }
  function cancel() {
    const preparing = preparation
    preparation = null
    preparing?.controller.abort()
    const old = attempt
    if (!old && !preparing) return
    attempt = null
    old?.controller.abort()
    let target = null
    try { target = owner ? readTarget(owner.account) : null } catch { /* Fail closed. */ }
    emit({ busy: false, target, error: state.trackingFailed ? trackingFailure : old?.accepted ? state.error : unknown })
  }
  function syncIdentity() {
    let next
    try {
      next = identity()
    } catch {
      cancel(); const hadOwner = Boolean(owner); owner = null
      emit({ target: null, busy: false, reviewFailed: false, notice: null, identityEpoch: state.identityEpoch + (hadOwner ? 1 : 0),
        error: '浏览器暂时无法读取当前账号，恢复后再确认原恢复。' })
      return
    }
    const changedOwner = !owner || owner.account !== next.account || owner.token !== next.token
    if (changedOwner) {
      cancel(); owner = next
      emit({ target: null, busy: false, reviewFailed: false, trackingFailed: false, error: '', notice: null,
        identityEpoch: state.identityEpoch + 1 })
    }
    let target
    try { target = readTarget(next.account) } catch { return }
    if (!changedOwner && !state.trackingFailed && target === state.target) return
    if (attempt && target !== attempt.target) cancel()
    emit({ target, busy: Boolean(attempt || preparation), reviewFailed: false, trackingFailed: false,
      error: target ? unknown : '', notice: null })
  }
  function captureContext() {
    if (!active) return null
    try {
      const value = identity()
      if (!owner || owner.account !== value.account || owner.token !== value.token) { syncIdentity(); return null }
      return { ...value, scope, epoch: state.identityEpoch, generation, invalid: false }
    } catch { syncIdentity(); return null }
  }
  function isCurrent(context) {
    if (!active || !context || context.scope !== scope || context.invalid || context.generation !== generation || context.epoch !== state.identityEpoch) return false
    try {
      const value = identity()
      const matches = value.account === context.account && value.token === context.token
      if (!matches) context.invalid = true
      return matches
    } catch { context.invalid = true; return false }
  }
  const config = (context, signal) => ({ signal, copageExpectedSessionToken: context.token })
  function available() {
    if (attempt || preparation) return false
    try { if (ready()) return true } catch { /* 无法确认当前权限/连接时不发送。 */ }
    emit({ error: '请确认当前仍有恢复权限，并等待连接、当前编辑保存和图片上传完成后再确认恢复。' })
    return false
  }
  async function send(target, context) {
    try {
      if (!isCurrent(context) || readTarget(context.account) !== target) { syncIdentity(); return }
    } catch { return }
    const next = { target, context, controller: new AbortController(), accepted: false }
    attempt = next
    emit({ target, busy: true, reviewFailed: false, error: '', notice: null })
    const current = () => attempt === next && !next.controller.signal.aborted && isCurrent(context)
    try {
      const response = await perform(target, config(context, next.controller.signal))
      if (!current()) return
      if (readTarget(context.account) !== target) { syncIdentity(); return }
      const message = restoreReply(target, response.data)
      next.accepted = true
      let cleaned = false
      try {
        const remove = () => current() && readTarget(context.account) === target && pending.delete(key(context.account), target)
        const result = exclusive(context.account, remove, next.controller.signal)
        cleaned = result?.then ? await result : result
      } catch { /* A verified server result remains verified even if local cleanup fails. */ }
      if (!current()) return
      let remaining = target
      try { remaining = readTarget(context.account) } catch { /* Preserve the warning. */ }
      emit({ target: remaining, reviewFailed: false, trackingFailed: state.trackingFailed,
        error: cleaned ? '' : '恢复已确认，但本地确认记录未能结束；请恢复本站存储后确认原请求，不会自动重复恢复。',
        notice: { type: response.data.applied ? 'success' : 'info', message } })
      await confirmed(target, response.data)
    } catch (failure) {
      if (current()) emit(next.accepted ? { error: '恢复已确认，列表暂未更新；请刷新列表查看。' }
        : { reviewFailed: true, error: `${unknown}${typeof failure?.code === 'number' && failure.message ? ' ' + failure.message : ''}` })
    } finally {
      if (attempt === next) {
        const visible = current()
        attempt = null
        emit({ busy: false })
        if (!visible) { syncIdentity(); if (owner?.account === context.account && !next.accepted) {
          try { emit({ target: readTarget(context.account), error: unknown }) } catch { /* Fail closed. */ }
        } }
      }
    }
  }
  async function start(targetRevision, expectedRevision) {
    const context = captureContext()
    if (!context || !Number.isSafeInteger(docId) || docId <= 0 || typeof service !== 'string' ||
      !revision(targetRevision) || !revision(expectedRevision) || expectedRevision === Number.MAX_SAFE_INTEGER ||
      !available()) return
    const preparing = { controller: new AbortController() }
    preparation = preparing
    emit({ busy: true, error: '', notice: null })
    try {
      const prepare = () => {
        if (preparation !== preparing || !isCurrent(context)) return null
        const existing = readTarget(context.account)
        if (existing) { emit({ target: existing, trackingFailed: false, error: unknown }); return null }
        let requestId
        try { requestId = newRequestId(); if (!uuid(requestId)) throw Error('无效请求编号') }
        catch { emit({ error: '无法生成恢复请求编号，请稍后重试。' }); return null }
        const target = Object.freeze({ targetRevision, expectedRevision, requestId })
        pending.set(key(context.account), target)
        emit({ target, trackingFailed: false })
        return target
      }
      const result = exclusive(context.account, prepare, preparing.controller.signal)
      const target = result?.then ? await result : result
      if (preparation !== preparing) return
      preparation = null
      emit({ busy: false })
      if (target && isCurrent(context) && available()) await send(target, context)
    } catch {
      if (preparation === preparing && isCurrent(context)) trackingError()
    } finally {
      if (preparation === preparing) { preparation = null; emit({ busy: false }) }
    }
  }
  async function retryOriginal() {
    const context = captureContext()
    if (!context || !available()) return
    let target
    try { target = readTarget(context.account) } catch { return }
    if (!target || target !== state.target) { syncIdentity(); return }
    await send(target, context)
  }
  function prepareEndWaiting() {
    const context = captureContext()
    if (!context || attempt || preparation || !state.target) return null
    try { if (readTarget(context.account) !== state.target) { syncIdentity(); return null } } catch { return null }
    return { context, target: state.target }
  }
  function endWaiting(confirmation) {
    if (!confirmation || attempt || preparation || !isCurrent(confirmation.context) || !owner ||
      owner.account !== confirmation.context.account || owner.token !== confirmation.context.token ||
      state.target !== confirmation.target) return false
    const remove = () => {
      if (attempt || preparation || !isCurrent(confirmation.context) || state.target !== confirmation.target) return false
      if (readTarget(confirmation.context.account) !== confirmation.target) { syncIdentity(); return false }
      if (!pending.delete(key(confirmation.context.account), confirmation.target)) return false
      emit({ target: null, reviewFailed: false, trackingFailed: false, error: '', notice: { type: 'warning',
        message: `已结束等待。原恢复到版本 ${confirmation.target.targetRevision} 的请求可能已经生效；请查看当前正文后再决定是否恢复，没有自动重试或撤销。` } })
      return true
    }
    try {
      const result = exclusive(confirmation.context.account, remove)
      return result?.then ? result.catch(() => { if (isCurrent(confirmation.context)) trackingError(); return false }) : result
    } catch { trackingError(); return false }
  }
  function deactivate() { active = false; generation++; cancel() }
  function activate() { active = true; syncIdentity() }
  syncIdentity()
  return { snapshot: () => state, start, retryOriginal, cancel, deactivate, activate, syncIdentity, prepareEndWaiting, endWaiting, captureContext, isCurrent, config }
}
