const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const FIELDS = ['version', 'requestId', 'projectId', 'projectName', 'title', 'templateId', 'createdAt']
const MAX_RECORD_BYTES = 4096
const warning = '项目文档已创建，但浏览器未能结束原确认记录。原标识保留；请核对原文档或恢复存储后确认原请求。'
const changedWarning = '项目文档已创建，但原确认槽位发生变化。当前记录已保留且不会覆盖，请先核对原文档。'
const failure = (reason, message, code = 400) => Object.assign(new Error(message), { reason, code })

function inputOf(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 4 ||
      ['projectId', 'projectName', 'title', 'templateId'].some(key => !Object.hasOwn(input, key)) ||
      !Number.isSafeInteger(input.projectId) || input.projectId <= 0 ||
      typeof input.projectName !== 'string' || !input.projectName.trim() || input.projectName.length > 80 ||
      typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 ||
      (input.templateId !== null && (typeof input.templateId !== 'string' || !input.templateId.trim() || input.templateId.length > 80))) {
    throw failure('PROJECT_DOCUMENT_CREATION_INPUT', '请核对项目、文档标题和模板，尚未发送请求。')
  }
  // 项目名称只用于浏览器标签；原标题和模板标识必须原样重发，不能改变服务端原指纹。
  return Object.freeze({ projectId: input.projectId, projectName: input.projectName,
    body: Object.freeze({ title: input.title, templateId: input.templateId }) })
}

function optionsOf({ account, service, isCurrent = () => true, onPrepared, deferCleanup = false, ...config } = {}) {
  if (typeof account !== 'string' || !account.trim() || typeof service !== 'string' || !service ||
      typeof isCurrent !== 'function' || typeof deferCleanup !== 'boolean' ||
      (onPrepared !== undefined && typeof onPrepared !== 'function')) {
    throw failure('PROJECT_DOCUMENT_CREATION_IDENTITY', '当前账号、服务或项目文档准备信息无法确认，尚未发送请求。')
  }
  let prefix
  try { prefix = `copage-project-document:v1:${encodeURIComponent(service)}:${encodeURIComponent(account)}:` }
  catch { throw failure('PROJECT_DOCUMENT_CREATION_IDENTITY', '当前账号或服务无法确认，尚未发送请求。') }
  return { prefix, isCurrent, onPrepared, deferCleanup, config }
}

function checkCurrent(options) {
  let current = false
  try { current = options.isCurrent() === true } catch { /* 身份不可读时保留原记录，不使用旧身份。 */ }
  if (options.config.signal?.aborted || !current) throw new DOMException('项目文档创建页面或账号已变更', 'AbortError')
}

function stored(read, options) {
  checkCurrent(options)
  let value
  try { value = read() }
  catch {
    checkCurrent(options)
    throw failure('PROJECT_DOCUMENT_CREATION_STORAGE', '浏览器无法读取或保存项目文档确认记录，请恢复存储后重试；原记录保留。')
  }
  checkCurrent(options)
  return value
}

/** 仅保存原项目标签、标题、内置模板标识、UUID和时间；不保存正文或凭据。 */
export function createProjectDocumentCreator({ getStorage, crypto, post }) {
  const snapshots = new WeakMap()

  async function fingerprint(input, options) {
    checkCurrent(options)
    if (!crypto?.subtle) throw failure('PROJECT_DOCUMENT_CREATION_CRYPTO', '浏览器暂不支持安全项目文档确认，请使用当前版本浏览器。')
    let hash
    try { hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
      input.projectId, input.body.title, input.body.templateId,
    ]))) }
    catch {
      checkCurrent(options)
      throw failure('PROJECT_DOCUMENT_CREATION_CRYPTO', '项目文档确认标识暂时无法准备，尚未发送请求。')
    }
    checkCurrent(options)
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
  }

  function parseRecord(raw) {
    try {
      if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_RECORD_BYTES) throw Error('size')
      const record = JSON.parse(raw)
      if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== FIELDS.length ||
          FIELDS.some(key => !Object.hasOwn(record, key)) || record.version !== 1 ||
          typeof record.requestId !== 'string' || !UUID.test(record.requestId) ||
          !Number.isSafeInteger(record.createdAt) || record.createdAt <= 0 || record.createdAt > Date.now() ||
          !Number.isFinite(new Date(record.createdAt).getTime())) throw Error('fields')
      const input = inputOf({ projectId: record.projectId, projectName: record.projectName,
        title: record.title, templateId: record.templateId })
      return { record, input }
    } catch {
      throw failure('PROJECT_DOCUMENT_CREATION_RECORD', '原项目文档创建记录无法校验，已原样保留；请先核对原文档。')
    }
  }

  async function decode(key, raw, options) {
    checkCurrent(options)
    if (typeof key !== 'string' || !key.startsWith(options.prefix) || !/^[\da-f]{64}$/.test(key.slice(options.prefix.length))) {
      throw failure('PROJECT_DOCUMENT_CREATION_RECORD', '原项目文档记录不属于当前账号或服务，请重新读取待确认创建。')
    }
    const decoded = parseRecord(raw)
    if (key !== options.prefix + await fingerprint(decoded.input, options)) {
      throw failure('PROJECT_DOCUMENT_CREATION_RECORD', '原项目文档内容与存储槽位不匹配，记录保留且不会发送替代请求。')
    }
    return decoded
  }

  function summaryFor(key, raw, decoded, options) {
    const summary = Object.freeze({ key, requestId: decoded.record.requestId,
      projectId: decoded.input.projectId, projectName: decoded.input.projectName, ...decoded.input.body,
      body: decoded.input.body, createdAt: decoded.record.createdAt })
    snapshots.set(summary, { key, raw, prefix: options.prefix })
    return summary
  }

  function unchanged(storage, key, raw, options) {
    if (stored(() => storage.getItem(key), options) !== raw) {
      throw failure('PROJECT_DOCUMENT_CREATION_CHANGED', '原项目文档记录已消失或变化，请重新读取；尚未发送替代请求。')
    }
  }

  async function send(storage, key, raw, decoded, summary, options) {
    if (options.onPrepared) await options.onPrepared(summary)
    checkCurrent(options)
    unchanged(storage, key, raw, options)
    // 不通过项目列表、归档状态或文档读取推断完成；服务端收据负责确认原事务。
    const result = await post(`/projects/${decoded.input.projectId}/documents/new`, decoded.input.body, { ...options.config,
      headers: { ...options.config.headers, 'Idempotency-Key': decoded.record.requestId } })
    checkCurrent(options)
    if (!Number.isSafeInteger(result?.data?.id) || result.data.id <= 0 ||
        result.data.projectId !== decoded.input.projectId || typeof result.data.title !== 'string') {
      throw failure('PROJECT_DOCUMENT_CREATION_RESPONSE', '项目文档创建结果无法确认，请确认原请求或核对原文档；原标识保留。', 500)
    }
    let cleaned = false
    const confirmTracking = () => {
      if (cleaned) return result
      checkCurrent(options)
      try {
        if (stored(() => storage.getItem(key), options) !== raw) return { ...result, creationTrackingWarning: changedWarning }
        checkCurrent(options)
        storage.removeItem(key)
        cleaned = true // 接受并清理后，不再额外读取身份而把已确认结果倒推为未知。
        return result
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        return { ...result, creationTrackingWarning: warning }
      }
    }
    return options.deferCleanup ? { ...result, confirmTracking } : confirmTracking()
  }

  async function create(value, config) {
    const input = inputOf(value), options = optionsOf(config)
    const key = options.prefix + await fingerprint(input, options)
    const storage = stored(getStorage, options)
    let raw = stored(() => storage.getItem(key), options)
    if (raw === null) {
      if (!crypto?.randomUUID) throw failure('PROJECT_DOCUMENT_CREATION_CRYPTO', '浏览器暂不支持安全项目文档确认，请使用当前版本浏览器。')
      let requestId
      try { requestId = crypto.randomUUID() }
      catch { checkCurrent(options); throw failure('PROJECT_DOCUMENT_CREATION_CRYPTO', '项目文档确认标识暂时无法准备，尚未发送请求。') }
      raw = JSON.stringify({ version: 1, requestId, projectId: input.projectId, projectName: input.projectName,
        ...input.body, createdAt: Date.now() })
      parseRecord(raw)
      stored(() => storage.setItem(key, raw), options)
    }
    const decoded = await decode(key, raw, options)
    unchanged(storage, key, raw, options)
    return send(storage, key, raw, decoded, summaryFor(key, raw, decoded, options), options)
  }

  async function retry(summary, config) {
    const options = optionsOf(config)
    checkCurrent(options)
    const original = summary && typeof summary === 'object' ? snapshots.get(summary) : null
    if (!original || original.prefix !== options.prefix || summary.key !== original.key) {
      throw failure('PROJECT_DOCUMENT_CREATION_RECORD', '请重新读取当前账号与服务的待确认项目文档，再确认原记录。')
    }
    const storage = stored(getStorage, options)
    const raw = stored(() => storage.getItem(original.key), options)
    if (raw !== original.raw) throw failure('PROJECT_DOCUMENT_CREATION_CHANGED', '原项目文档记录已消失或变化，请重新读取；尚未发送替代请求。')
    const decoded = await decode(original.key, raw, options)
    unchanged(storage, original.key, raw, options)
    return send(storage, original.key, raw, decoded, summary, options)
  }

  async function listPending(config) {
    const options = optionsOf(config), storage = stored(getStorage, options)
    const length = stored(() => storage.length, options)
    if (!Number.isSafeInteger(length) || length < 0) throw failure('PROJECT_DOCUMENT_CREATION_STORAGE', '项目文档确认记录暂时无法读取，原记录保留。')
    const keys = new Set()
    for (let index = 0; index < length; index++) {
      const key = stored(() => storage.key(index), options)
      if (typeof key === 'string' && key.startsWith(options.prefix)) keys.add(key)
    }
    const summaries = []
    for (const key of keys) {
      const raw = stored(() => storage.getItem(key), options)
      if (raw === null) continue
      const decoded = await decode(key, raw, options)
      unchanged(storage, key, raw, options)
      summaries.push(summaryFor(key, raw, decoded, options))
    }
    checkCurrent(options)
    return summaries.sort((a, b) => b.createdAt - a.createdAt || a.key.localeCompare(b.key))
  }

  return { create, listPending, retry }
}
