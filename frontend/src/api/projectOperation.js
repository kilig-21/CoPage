const pendingByAccount = new Map()
const positive = value => Number.isSafeInteger(value) && value > 0
const uuid = value => typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
const labels = { create: '项目已创建', rename: '项目资料已保存', archive: '项目已归档', restore: '项目已恢复', add: '文档已加入项目', remove: '已移出项目' }
const unknownMessage = '操作结果未确认，请核对原项目或原文档关联；刷新、筛选和关闭弹窗不代替核对。'

export function projectStateMessage(target, data) {
  if (['add', 'remove'].includes(target.kind)) {
    if (data?.projectId !== target.projectId || data.docId !== target.docId || typeof data.docTitle !== 'string' ||
        typeof data.projectArchived !== 'boolean' || !(data.associationId === null || uuid(data.associationId))) throw new Error('关联核对响应无效')
    const relation = data.associationId === null ? '当前未关联此项目' : target.kind === 'remove' && data.associationId !== target.associationId
      ? '当前存在新关联，原移出请求不会自动移除新关联' : '当前仍关联此项目'
    return `已核对：“${data.docTitle}”${relation}。${data.projectArchived ? '项目当前已归档。' : ''}这是当前状态，请按需重新操作。`
  }
  if (data?.id !== target.projectId || !Number.isSafeInteger(data.groupId) || data.groupId < 0 ||
      typeof data.name !== 'string' || typeof data.description !== 'string' || typeof data.archived !== 'boolean' ||
      typeof data.canManage !== 'boolean') throw new Error('项目核对响应无效')
  const details = target.kind === 'rename'
    ? data.name === target.name && data.description === target.description ? '当前名称和简介与原提交内容一致。' : '当前名称或简介与原提交内容不同，请查看当前资料。'
    : ''
  return `已核对：“${data.name}”当前${data.archived ? '已归档' : '进行中'}。${details}${!data.canManage ? '你目前没有管理权限。' : ''}核对不追认原请求成功，也不会自动重试。`
}

// 仅当前标签的内存保存待核对目标，不保存正文/令牌，不写入浏览器存储。
export function createProjectOperation({ readIdentity, readState, changed = () => {}, confirmed = () => {}, pending = pendingByAccount }) {
  let attempt = null, owner = null
  let state = { pending: null, checking: false, uncertain: null, reviewFailed: false, error: '', notice: null }
  const emit = patch => { state = { ...state, ...patch }; changed(state) }
  const identity = () => {
    const value = readIdentity()
    if (!value?.token || typeof value.account !== 'string' || !value.account) throw new Error('当前账号不可读')
    return value
  }
  function remember(target, account) {
    pending.set(account, target)
    if (owner === account) emit({ uncertain: target, reviewFailed: false, error: unknownMessage, notice: null })
  }
  function syncIdentity() {
    try {
      const next = identity()
      if (owner !== next.account || (attempt && attempt.identity.token !== next.token)) {
        cancel()
        owner = next.account
        emit({ pending: null, checking: false, uncertain: pending.get(owner) || null, reviewFailed: false,
          error: pending.has(owner) ? unknownMessage : '', notice: null })
      }
    } catch { cancel(); emit({ pending: null, checking: false, error: '浏览器暂时无法读取当前账号，请恢复存储后核对原操作。' }) }
  }
  syncIdentity()
  function begin(target, checking, retryCreation = false) {
    let account
    try { account = identity() } catch { emit({ error: '浏览器无法读取当前账号，请允许本站保存数据后重试。' }); return null }
    if (owner !== account.account) { syncIdentity(); return null }
    const previous = pending.get(owner)
    if (attempt || (!checking && previous && !(retryCreation && target.kind === 'create' && previous.kind === 'create' &&
      uuid(target.requestId) && target.requestId === previous.requestId))) return null
    const next = { target, identity: account, controller: new AbortController(), checking }
    attempt = next
    emit({ pending: checking ? null : target, checking, error: '', notice: null })
    return next
  }
  function current(next) {
    if (attempt !== next || next.controller.signal.aborted) return false
    try { const value = identity(); return value.account === next.identity.account && value.token === next.identity.token }
    catch { next.identityUnavailable = true; return null }
  }
  const config = next => ({ signal: next.controller.signal, copageExpectedSessionToken: next.identity.token })
  function finish(next) {
    if (attempt !== next) return
    const visible = current(next)
    if (!next.accepted && (visible !== true || next.identityUnavailable) && !(next.trackedCreation && !next.target.requestId)) remember(next.target, next.identity.account)
    attempt = null
    emit({ pending: null, checking: false })
    if (visible === null || next.identityUnavailable) emit({ error: next.accepted ? '原操作已收到确认，但浏览器暂时无法读取当前账号；恢复存储后再继续。'
      : '浏览器暂时无法核对当前账号，原操作仍未确认；恢复存储后再核对。' })
    if (visible === false) syncIdentity()
  }
  async function run(input, perform, onSuccess, { retryCreation = false, trackedCreation = false } = {}) {
    if (!labels[input.kind] || (input.kind !== 'create' && !positive(input.projectId)) ||
        (['add', 'remove'].includes(input.kind) && !positive(input.docId))) return
    const target = Object.freeze({ ...input })
    const next = begin(target, false, retryCreation)
    if (!next) return
    next.trackedCreation = trackedCreation && target.kind === 'create'
    try {
      const prepared = record => {
        if (next.target.kind !== 'create' || !uuid(record?.requestId) || record.name !== next.target.name || record.groupId !== next.target.groupId)
          throw new Error('创建记录与原目标不一致')
        next.target = Object.freeze({ ...next.target, requestId: record.requestId })
        if (current(next) !== true) throw new DOMException('创建页面或账号已变更', 'AbortError')
        emit({ pending: next.target })
      }
      let response = await perform(config(next), prepared)
      if (current(next) !== true) return
      if (target.kind === 'create' && (!positive(response.data?.id) || response.data.groupId !== target.groupId)) throw new Error('创建响应无效')
      if (['add', 'remove'].includes(target.kind) && typeof response.data?.changed !== 'boolean') throw new Error('关联响应无效')
      if (next.trackedCreation && typeof response.confirmTracking === 'function') response = response.confirmTracking()
      next.accepted = true
      if (target.kind === 'create') pending.delete(owner)
      emit({ uncertain: null, reviewFailed: false, notice: { type: response.creationTrackingWarning ? 'warning' : 'success',
        message: response.creationTrackingWarning || (target.kind === 'create' && retryCreation ? '已确认原项目创建，编号 #' + response.data.id :
          target.kind === 'add' && !response.data.changed ? '文档已在项目中' : labels[target.kind]) } })
      onSuccess?.(response.data)
      confirmed(target)
    } catch (failure) {
      if (current(next) !== true) return
      if (next.accepted) emit({ error: '操作已确认，页面未能更新；请刷新查看资料。' })
      else if (next.trackedCreation && !next.target.requestId) emit({ error: failure.message || '创建尚未发送，请恢复浏览器存储后重试。' })
      else if ([400, 401, 403, 404].includes(failure?.code)) emit({ error: failure.message || '请求未获准，请核对当前资料与权限。' })
      else remember(next.target, next.identity.account)
    } finally { finish(next) }
  }
  async function review() {
    const target = state.uncertain
    if (!target || target.kind === 'create') return
    const next = begin(target, true)
    if (!next) return
    try {
      const response = await readState(target, config(next))
      if (current(next) !== true || pending.get(owner) !== target) return
      const message = projectStateMessage(target, response.data)
      next.accepted = true
      pending.delete(owner)
      emit({ uncertain: null, reviewFailed: false, error: '', notice: { type: 'info', message, target, data: response.data } })
      confirmed(target)
    } catch {
      if (current(next) === true) emit(next.accepted ? { error: '已核对当前状态，页面未能更新；请刷新查看资料。' }
        : { reviewFailed: true, error: '暂时无法核对原目标，操作结果仍未确认；请稍后重试。' })
    } finally { finish(next) }
  }
  function cancel() {
    const old = attempt
    if (!old) return
    if (!old.accepted && !(old.trackedCreation && !old.target.requestId)) remember(old.target, old.identity.account)
    attempt = null
    old.controller.abort()
    emit({ pending: null, checking: false })
  }
  function endWaiting(target) {
    if (attempt || !state.reviewFailed || state.uncertain !== target || target?.kind === 'create') return
    try { if (identity().account !== owner) { syncIdentity(); return } } catch { syncIdentity(); return }
    pending.delete(owner)
    emit({ uncertain: null, reviewFailed: false, error: '', notice: { type: 'warning',
      message: `已结束本次等待，原项目 #${target.projectId}${target.docId ? '、文档 #' + target.docId : ''} 的操作结果仍未知。请自行查看原资料后，再决定是否重新操作；没有自动重试或撤销。` } })
  }
  function pauseCreation(target) {
    if (attempt || state.uncertain !== target || target?.kind !== 'create' || !uuid(target.requestId)) return
    try { if (identity().account !== owner) { syncIdentity(); return } } catch { syncIdentity(); return }
    pending.delete(owner)
    emit({ uncertain: null, reviewFailed: false, error: '', notice: { type: 'warning',
      message: '已暂缓本次创建确认，可从“待确认的创建”重新读取并继续确认。原结果尚未确认，没有自动重试、删除或撤销项目。' } })
  }
  return { snapshot: () => state, run, review, cancel, syncIdentity, endWaiting, pauseCreation }
}
