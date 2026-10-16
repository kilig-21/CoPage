const failure = (reason, message, uncertain = false) => Object.assign(new Error(message), { reason, uncertain })
const abort = uncertain => Object.assign(new DOMException('模板来源页面或账号已变化', 'AbortError'), { uncertain })
const validIdentity = value => value && ['account', 'token', 'service'].every(key => typeof value[key] === 'string' && value[key])

// 只负责一个打开窗口中的普通POST；未知或已确认后均不再发送，不提供自动重试。
export function createPersonalTemplateSaver({ docId, readIdentity, post, canSave = () => true, isCurrent = () => true }) {
  let identity = null
  try { const value = readIdentity(); if (validIdentity(value)) identity = Object.freeze({ ...value }) } catch { /* 无法绑定原身份时不发送。 */ }
  let status = 'idle', confirmed = null, inFlight = false
  function current(signal) {
    try {
      if (!identity || signal?.aborted || isCurrent() !== true) return false
      const value = readIdentity()
      return validIdentity(value) && ['account', 'token', 'service'].every(key => value[key] === identity[key])
    } catch { return false }
  }
  function ready() {
    try { return current() && canSave() === true } catch { return false }
  }
  async function save(input, { signal, onSaved } = {}) {
    if (status === 'confirmed') {
      if (!current(signal)) throw abort(false)
      return { data: confirmed, callbackError: null }
    }
    if (status === 'uncertain') throw failure('PERSONAL_TEMPLATE_UNCERTAIN', '保存结果未确认，请先核对我的模板；不会自动重试。', true)
    if (inFlight) throw failure('PERSONAL_TEMPLATE_BUSY', '正在保存模板，请等待原请求。')
    if (!Number.isSafeInteger(docId) || docId <= 0 || !input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).length !== 3 || ['name', 'description', 'category'].some(key => !Object.hasOwn(input, key)) ||
        typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200 ||
        typeof input.description !== 'string' || input.description.length > 300 ||
        !['collaboration', 'planning', 'learning'].includes(input.category)) {
      throw failure('PERSONAL_TEMPLATE_INPUT', '请核对原文档、模板名称和说明，尚未发送请求。')
    }
    const body = Object.freeze({ docId, name: input.name, description: input.description, category: input.category })
    if (!current(signal)) throw abort(false)
    if (!ready()) throw failure('PERSONAL_TEMPLATE_NOT_READY', '请先等待连接、同步和保存完成；尚未发送请求。')
    // 最后一次同步核对紧邻POST；请求拦截器另核对捕获令牌，避免微任务中套用新身份。
    if (!current(signal)) throw abort(false)
    inFlight = true; status = 'saving'
    try {
      const result = await post('/personal-templates', body, { signal, copageExpectedSessionToken: identity.token })
      if (!current(signal)) throw abort(true)
      if (!Number.isSafeInteger(result?.data?.id) || result.data.id <= 0 ||
          !Number.isSafeInteger(result.data.sourceRevision) || result.data.sourceRevision < 0) {
        throw failure('PERSONAL_TEMPLATE_RESPONSE', '模板保存结果无法确认，请先核对我的模板，再决定是否操作。', true)
      }
      confirmed = Object.freeze({ id: result.data.id, sourceRevision: result.data.sourceRevision, name: body.name })
      status = 'confirmed' // 先接受结果；提示或导航失败不能重新发送这个非幂等POST。
    } catch (error) {
      const uncertain = error?.uncertain === true || ![400, 401, 403, 404].includes(error?.code)
      status = uncertain ? 'uncertain' : 'idle'
      if (!current(signal)) throw abort(true)
      // 不修改请求库给出的错误对象；只读/冻结错误也必须准确报告原未知状态。
      throw Object.assign(failure(error?.reason || 'PERSONAL_TEMPLATE_REQUEST',
        error?.message || '模板保存结果未确认，请先核对我的模板。', uncertain), { code: error?.code })
    } finally { inFlight = false }
    let callbackError = null
    try { await onSaved?.(confirmed) } catch (error) { callbackError = error }
    return { data: confirmed, callbackError }
  }
  return { save, ready, current: () => current(), snapshot: () => ({ status, data: confirmed }) }
}
