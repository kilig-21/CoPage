// 仅当前标签的内存保存请求元信息，不保存正文、账号令牌或浏览器持久数据。
const pendingRestores = new Map()
const revision = value => Number.isSafeInteger(value) && value >= 0
const uuid = value => typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
const unknown = '原恢复结果未确认。刷新列表、查看其他版本或关闭窗口不会结束等待。'

export function restoreReply(target, data) {
  if (!revision(data?.revision) || data.revision !== target.expectedRevision + 1 || typeof data.applied !== 'boolean')
    throw new Error('恢复确认响应无效，原请求仍需确认')
  return data.applied ? `已恢复，生成版本 ${data.revision}` : `已确认原恢复，结果为版本 ${data.revision}；本次没有生成新版本。`
}

export function createHistoryRestore({ service, docId, readIdentity, ready, perform, confirmed = () => {}, changed = () => {},
  pending = pendingRestores, newRequestId = () => globalThis.crypto.randomUUID() }) {
  let owner = null, attempt = null, active = true, generation = 0
  const scope = Symbol('history-restore-context')
  let state = { target: null, busy: false, reviewFailed: false, error: '', notice: null, identityEpoch: 0 }
  const emit = patch => { state = { ...state, ...patch }; changed(state) }
  const identity = () => {
    const value = readIdentity()
    if (!value?.token || typeof value.account !== 'string' || !value.account) throw Error('当前账号不可读')
    return value
  }
  const key = account => JSON.stringify([service, account, docId])
  function cancel() {
    const old = attempt
    if (!old) return
    attempt = null
    old.controller.abort()
    emit({ busy: false, target: owner ? pending.get(key(owner.account)) || null : null,
      error: old.accepted ? state.error : unknown })
  }
  function syncIdentity() {
    try {
      const next = identity()
      if (!owner || owner.account !== next.account || owner.token !== next.token) {
        cancel()
        owner = next
        const target = pending.get(key(next.account)) || null
        emit({ target, busy: false, reviewFailed: false, error: target ? unknown : '', notice: null, identityEpoch: state.identityEpoch + 1 })
      }
    } catch {
      cancel(); const hadOwner = Boolean(owner); owner = null
      emit({ target: null, busy: false, reviewFailed: false, notice: null, identityEpoch: state.identityEpoch + (hadOwner ? 1 : 0),
        error: '浏览器暂时无法读取当前账号，恢复后再确认原恢复。' })
    }
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
    if (attempt) return false
    try { if (ready()) return true } catch { /* 无法确认当前权限/连接时不发送。 */ }
    emit({ error: '请确认当前仍有恢复权限，并等待连接、当前编辑保存和图片上传完成后再确认恢复。' })
    return false
  }
  async function send(target, context) {
    const next = { target, context, controller: new AbortController(), accepted: false }
    attempt = next
    emit({ target, busy: true, reviewFailed: false, error: '', notice: null })
    const current = () => attempt === next && !next.controller.signal.aborted && isCurrent(context)
    try {
      const response = await perform(target, config(context, next.controller.signal))
      if (!current() || pending.get(key(context.account)) !== target) return
      const message = restoreReply(target, response.data)
      next.accepted = true
      pending.delete(key(context.account))
      emit({ target: null, reviewFailed: false, error: '', notice: { type: response.data.applied ? 'success' : 'info', message } })
      await confirmed(target, response.data)
    } catch (failure) {
      if (current()) emit(next.accepted ? { error: '恢复已确认，列表暂未更新；请刷新列表查看。' }
        : { reviewFailed: true, error: `${unknown}${typeof failure?.code === 'number' && failure.message ? ' ' + failure.message : ''}` })
    } finally {
      if (attempt === next) {
        const visible = current()
        attempt = null
        emit({ busy: false })
        if (!visible) { syncIdentity(); if (owner?.account === context.account && !next.accepted)
          emit({ target: pending.get(key(context.account)) || null, error: unknown }) }
      }
    }
  }
  async function start(targetRevision, expectedRevision) {
    const context = captureContext()
    if (!context || !Number.isSafeInteger(docId) || docId <= 0 || typeof service !== 'string' ||
      !revision(targetRevision) || !revision(expectedRevision) || expectedRevision === Number.MAX_SAFE_INTEGER ||
      pending.has(key(context.account)) || !available()) return
    let requestId
    try { requestId = newRequestId(); if (!uuid(requestId)) throw Error('无效请求编号') }
    catch { emit({ error: '无法生成恢复请求编号，请稍后重试。' }); return }
    const target = Object.freeze({ targetRevision, expectedRevision, requestId })
    pending.set(key(context.account), target)
    await send(target, context)
  }
  async function retryOriginal() {
    const context = captureContext()
    if (!context || !available()) return
    const target = pending.get(key(context.account))
    if (!target || target !== state.target) return
    await send(target, context)
  }
  function prepareEndWaiting() {
    const context = captureContext()
    if (!context || attempt || !state.target || pending.get(key(context.account)) !== state.target) return null
    return { context, target: state.target }
  }
  function endWaiting(confirmation) {
    if (!confirmation || attempt || !isCurrent(confirmation.context) || !owner ||
      owner.account !== confirmation.context.account || owner.token !== confirmation.context.token ||
      state.target !== confirmation.target || pending.get(key(owner.account)) !== confirmation.target) return false
    pending.delete(key(owner.account))
    emit({ target: null, reviewFailed: false, error: '', notice: { type: 'warning',
      message: `已结束等待。原恢复到版本 ${confirmation.target.targetRevision} 的请求可能已经生效；请查看当前正文后再决定是否恢复，没有自动重试或撤销。` } })
    return true
  }
  function deactivate() { active = false; generation++; cancel() }
  function activate() { active = true; syncIdentity() }
  syncIdentity()
  return { snapshot: () => state, start, retryOriginal, cancel, deactivate, activate, syncIdentity, prepareEndWaiting, endWaiting, captureContext, isCurrent, config }
}
