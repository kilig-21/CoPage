const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function localFailure(message) {
  const failure = new Error(message)
  failure.code = 400
  return failure
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
async function digest(crypto, bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
async function bodyFingerprint(crypto, body) {
  if (body instanceof FormData) {
    const entries = []
    for (const [name, value] of body.entries()) entries.push([name, typeof value === 'string' ? value : {
      filename: value.name || '', hash: await digest(crypto, await value.arrayBuffer()),
    }])
    return entries.sort((a, b) => a[0].localeCompare(b[0]))
  }
  return canonical(JSON.parse(JSON.stringify(body ?? null)))
}

/** 与既有文档创建槽完全相同的账号、服务、路径和内容指纹。 */
export async function documentCreationTrackingKey(crypto, { service, account, path, body }) {
  const fingerprint = await bodyFingerprint(crypto, body)
  return 'copage-create:' + await digest(crypto, new TextEncoder().encode(JSON.stringify([service, account, path, fingerprint])))
}

/** 只保存UUID、请求指纹及私人模板的原版本，不存文件、正文、密码或令牌。 */
export function createDocumentCreator({ getStorage, crypto, post }) {
  const acknowledged = new Set()
  return async function create(path, body, { account, service, isCurrent = () => true, preserveRejectedTracking = false, ...config }) {
    const current = () => { try { return isCurrent() } catch { return false } }
    if (!account) throw localFailure('请重新登录后创建文档；已有文档和草稿保留。')
    if (!crypto?.subtle || !crypto?.randomUUID) throw localFailure('浏览器暂不支持安全重试，请使用当前版本浏览器。')
    const freezeTemplateVersion = /^\/personal-templates\/[1-9]\d*\/documents$/.test(path) && Number.isSafeInteger(body?.expectedVersion)
    const trackedBody = freezeTemplateVersion ? { ...body } : body
    if (freezeTemplateVersion) delete trackedBody.expectedVersion
    let fingerprint
    try { fingerprint = await bodyFingerprint(crypto, trackedBody) }
    catch { throw localFailure('无法读取本次创建内容，请重新选择文件或重试；尚未发送创建请求。') }
    const key = 'copage-create:' + await digest(crypto, new TextEncoder().encode(JSON.stringify([service, account, path, fingerprint])))
    if (config.signal?.aborted || !current()) throw new DOMException('创建已取消', 'AbortError')
    let storage, id, storedValue, hadTrackedRequest = false, requestBody = body
    try {
      storage = getStorage()
      storedValue = storage.getItem(key)
      if (acknowledged.has(key)) {
        storage.removeItem(key); acknowledged.delete(key); storedValue = null
      }
      hadTrackedRequest = Boolean(storedValue)
      if (freezeTemplateVersion) {
        const record = storedValue ? JSON.parse(storedValue) : { requestId: crypto.randomUUID(), expectedVersion: body.expectedVersion }
        if (!record || Object.keys(record).length !== 2 || !UUID.test(record.requestId) || !Number.isSafeInteger(record.expectedVersion) || record.expectedVersion <= 0) throw new Error('invalid template creation record')
        id = record.requestId; requestBody = { ...body, expectedVersion: record.expectedVersion }
        if (!storedValue) { storedValue = JSON.stringify(record); storage.setItem(key, storedValue) }
      } else {
        id = storedValue
        if (id && !UUID.test(id)) throw new Error('invalid creation record')
        if (!id) { id = crypto.randomUUID(); storedValue = id; storage.setItem(key, storedValue) }
      }
    } catch {
      throw localFailure(acknowledged.has(key)
        ? '上一篇文档已创建，但浏览器仍无法结束本次重试记录。请允许本站保存数据后再创建。'
        : '浏览器无法保存创建重试标识，请允许本站保存数据后重试；已有文档和草稿保留。')
    }
    const clear = () => { if (storage.getItem(key) === storedValue) storage.removeItem(key) }
    let result
    try {
      result = await post(path, requestBody, { ...config, headers: { ...config.headers, 'Idempotency-Key': id } })
    } catch (failure) {
      // 401在认证层拒绝本次请求，无法证明此前丢回复的创建没有提交。
      // 保留原UUID（及私人模板版本），让重登原账号仍确认首次结果。
      const preserveOriginal = preserveRejectedTracking && hadTrackedRequest
      if (!preserveOriginal && [400, 403, 404].includes(failure?.code)) { try { clear() } catch { /* 保留原记录，不清其他数据。 */ } }
      // 原导入窗口已关闭时，由既有指纹槽识别此前未确认请求；拒绝当前重试不能否认先前提交。
      if (preserveOriginal) throw Object.assign(new Error(failure?.message || '原创建结果仍未确认，请继续核对原请求。'), failure, { uncertain: true })
      throw failure
    }
    if (config.signal?.aborted || !current()) throw new DOMException('创建页面或账号已变更', 'AbortError')
    if (!Number.isSafeInteger(result?.data?.id) || result.data.id <= 0) {
      throw Object.assign(new Error('创建结果无法确认，请重试原内容或核对我的文档；原创建标识保留。'),
        { code: 500, reason: 'DOCUMENT_CREATION_RESPONSE' })
    }
    try { clear() }
    catch {
      acknowledged.add(key)
      return { ...result, creationTrackingWarning: '文档已创建，但浏览器未能结束本次重试记录。请允许本站保存数据后再创建新文档；重复请求会打开已有文档。' }
    }
    return result
  }
}
