const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const FIELDS = ['version', 'requestId', 'name', 'description', 'createdAt']
const MAX_RECORD_BYTES = 4096
const warning = '小组已创建，但浏览器未能结束原确认记录。原标识保留；请核对我的小组或恢复存储后确认原小组。'
const changedWarning = '小组已创建，但原确认槽位发生变化。当前记录已保留且不会覆盖，请先核对我的小组。'
const failure = (reason, message, code = 400) => Object.assign(new Error(message), { reason, code })

function bodyOf(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 ||
      !Object.hasOwn(input, 'name') || !Object.hasOwn(input, 'description') ||
      typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(input.name) || typeof input.description !== 'string' ||
      input.description.length > 300 || /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(input.description)) {
    throw failure('GROUP_CREATION_INPUT', '请核对小组名称和简介，尚未发送请求。')
  }
  // 服务端以原请求计算指纹；合法空白不能在确认原请求时被重新规范化。
  return Object.freeze({ name: input.name, description: input.description })
}

function optionsOf({ account, service, isCurrent = () => true, onPrepared, deferCleanup = false, ...config } = {}) {
  if (typeof account !== 'string' || !account.trim() || typeof service !== 'string' || !service ||
      typeof isCurrent !== 'function' || typeof deferCleanup !== 'boolean' ||
      (onPrepared !== undefined && typeof onPrepared !== 'function')) {
    throw failure('GROUP_CREATION_IDENTITY', '当前账号、服务或小组准备信息无法确认，尚未发送请求。')
  }
  let prefix
  try { prefix = `copage-group-create:v1:${encodeURIComponent(service)}:${encodeURIComponent(account)}:` }
  catch { throw failure('GROUP_CREATION_IDENTITY', '当前账号或服务无法确认，尚未发送请求。') }
  return { prefix, isCurrent, onPrepared, deferCleanup, config }
}

function checkCurrent(options) {
  let current = false
  try { current = options.isCurrent() === true } catch { /* 身份不可读时不使用旧账号请求。 */ }
  if (options.config.signal?.aborted || !current) throw new DOMException('小组创建页面或账号已变更', 'AbortError')
}

function stored(read, options) {
  checkCurrent(options)
  let value
  try { value = read() }
  catch {
    checkCurrent(options)
    throw failure('GROUP_CREATION_STORAGE', '浏览器无法读取或保存小组确认记录，请恢复存储后重试；原记录保留。')
  }
  checkCurrent(options)
  return value
}

/** 仅保存原小组名称、简介、UUID和准备时间；由调用者注入当前浏览器本地存储。 */
export function createGroupCreator({ getStorage, crypto, post }) {
  const snapshots = new WeakMap()

  async function fingerprint(body, options) {
    checkCurrent(options)
    if (!crypto?.subtle) throw failure('GROUP_CREATION_CRYPTO', '浏览器暂不支持安全小组确认，请使用当前版本浏览器。')
    let hash
    try { hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([body.name, body.description]))) }
    catch {
      checkCurrent(options)
      throw failure('GROUP_CREATION_CRYPTO', '小组确认标识暂时无法准备，尚未发送请求。')
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
      return { record, body: bodyOf({ name: record.name, description: record.description }) }
    } catch {
      throw failure('GROUP_CREATION_RECORD', '原小组创建记录无法校验，已原样保留；请先核对我的小组。')
    }
  }

  async function decode(key, raw, options) {
    checkCurrent(options)
    if (typeof key !== 'string' || !key.startsWith(options.prefix) || !/^[\da-f]{64}$/.test(key.slice(options.prefix.length))) {
      throw failure('GROUP_CREATION_RECORD', '原小组记录不属于当前账号或服务，请重新读取待确认创建。')
    }
    const decoded = parseRecord(raw)
    if (key !== options.prefix + await fingerprint(decoded.body, options)) {
      throw failure('GROUP_CREATION_RECORD', '原小组内容与存储槽位不匹配，记录保留且不会发送替代请求。')
    }
    return decoded
  }

  function summaryFor(key, raw, decoded, options) {
    const summary = Object.freeze({ key, requestId: decoded.record.requestId, ...decoded.body,
      body: decoded.body, createdAt: decoded.record.createdAt })
    snapshots.set(summary, { key, raw, prefix: options.prefix })
    return summary
  }

  function unchanged(storage, key, raw, options) {
    if (stored(() => storage.getItem(key), options) !== raw) {
      throw failure('GROUP_CREATION_CHANGED', '原小组记录已消失或变化，请重新读取；尚未发送替代请求。')
    }
  }

  async function send(storage, key, raw, decoded, summary, options) {
    if (options.onPrepared) await options.onPrepared(summary)
    checkCurrent(options)
    unchanged(storage, key, raw, options)
    const result = await post('/groups', decoded.body, { ...options.config,
      headers: { ...options.config.headers, 'Idempotency-Key': decoded.record.requestId } })
    checkCurrent(options)
    if (!Number.isSafeInteger(result?.data?.id) || result.data.id <= 0 || typeof result.data.archived !== 'boolean') {
      throw failure('GROUP_CREATION_RESPONSE', '小组创建结果无法确认，请确认原请求或核对我的小组；原标识保留。', 500)
    }
    let cleaned = false
    const confirmTracking = () => {
      // 已接受并清理后重复调用直接返回；身份检查不能把已确认结果重新变成未知。
      if (cleaned) return result
      checkCurrent(options)
      try {
        if (stored(() => storage.getItem(key), options) !== raw) return { ...result, creationTrackingWarning: changedWarning }
        checkCurrent(options)
        storage.removeItem(key)
        cleaned = true
        return result
      } catch (error) {
        if (error.name === 'AbortError') throw error
        return { ...result, creationTrackingWarning: warning }
      }
    }
    return options.deferCleanup ? { ...result, confirmTracking } : confirmTracking()
  }

  async function create(input, config) {
    const body = bodyOf(input), options = optionsOf(config)
    const key = options.prefix + await fingerprint(body, options)
    const storage = stored(getStorage, options)
    let raw = stored(() => storage.getItem(key), options)
    if (raw === null) {
      if (!crypto?.randomUUID) throw failure('GROUP_CREATION_CRYPTO', '浏览器暂不支持安全小组确认，请使用当前版本浏览器。')
      let requestId
      try { requestId = crypto.randomUUID() }
      catch { checkCurrent(options); throw failure('GROUP_CREATION_CRYPTO', '小组确认标识暂时无法准备，尚未发送请求。') }
      raw = JSON.stringify({ version: 1, requestId, ...body, createdAt: Date.now() })
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
      throw failure('GROUP_CREATION_RECORD', '请重新读取当前账号与服务的待确认小组，再确认原记录。')
    }
    const storage = stored(getStorage, options)
    const raw = stored(() => storage.getItem(original.key), options)
    if (raw !== original.raw) throw failure('GROUP_CREATION_CHANGED', '原小组记录已消失或变化，请重新读取；尚未发送替代请求。')
    const decoded = await decode(original.key, raw, options)
    unchanged(storage, original.key, raw, options)
    return send(storage, original.key, raw, decoded, summary, options)
  }

  async function listPending(config) {
    const options = optionsOf(config), storage = stored(getStorage, options)
    const length = stored(() => storage.length, options)
    if (!Number.isSafeInteger(length) || length < 0) throw failure('GROUP_CREATION_STORAGE', '小组确认记录暂时无法读取，原记录保留。')
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
