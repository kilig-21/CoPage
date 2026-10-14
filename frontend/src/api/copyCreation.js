import { documentCreationTrackingKey } from './creationRequest.js'

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const FIELDS = ['version', 'requestId', 'sourceId', 'body', 'createdAt']
const MAX_RECORD_BYTES = 4096
const warning = '副本已创建，但浏览器未能结束原重试记录。原标识保留；请核对我的文档或恢复存储后确认原副本。'
const changedWarning = '副本已创建，但原重试槽位发生变化。当前记录已保留且不会覆盖，请先核对我的文档。'
const failure = (reason, message, code = 400) => Object.assign(new Error(message), { reason, code })

function bodyOf(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'title') ||
      (Object.hasOwn(input, 'title') && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200))) {
    throw failure('COPY_CREATION_INPUT', '副本标题无法识别，尚未发送请求。')
  }
  // 默认标题必须保持为空对象，不能补算原标题或改写原请求的标题。
  return Object.freeze(Object.hasOwn(input, 'title') ? { title: input.title } : {})
}

function optionsOf({ account, service, isCurrent = () => true, onPrepared, deferCleanup = false, ...config } = {}) {
  if (typeof account !== 'string' || !account.trim() || typeof service !== 'string' || !service ||
      typeof isCurrent !== 'function' || typeof deferCleanup !== 'boolean' ||
      (onPrepared !== undefined && typeof onPrepared !== 'function')) {
    throw failure('COPY_CREATION_IDENTITY', '当前账号、服务或副本准备信息无法确认，尚未发送请求。')
  }
  let prefix
  try { prefix = `copage-copy-create:v1:${encodeURIComponent(service)}:${encodeURIComponent(account)}:` }
  catch { throw failure('COPY_CREATION_IDENTITY', '当前账号或服务无法确认，尚未发送请求。') }
  return { account, service, prefix, isCurrent, onPrepared, deferCleanup, config }
}

function checkCurrent(options) {
  let current = false
  try { current = options.isCurrent() === true } catch { /* 身份不可读时拒绝旧账号请求。 */ }
  if (options.config.signal?.aborted || !current) throw new DOMException('副本创建页面或账号已变更', 'AbortError')
}

function stored(read, options) {
  checkCurrent(options)
  let value
  try { value = read() }
  catch {
    checkCurrent(options)
    throw failure('COPY_CREATION_STORAGE', '浏览器无法读取或保存副本重试记录，请恢复存储后重试；原记录保留。')
  }
  checkCurrent(options)
  return value
}

/** 只保存副本原来源、标题请求、UUID与准备时间；不读取或保存正文和凭据。 */
export function createCopyCreator({ getStorage, crypto, post }) {
  const snapshots = new WeakMap()

  async function keysFor(sourceId, body, options) {
    checkCurrent(options)
    if (!crypto?.subtle) throw failure('COPY_CREATION_CRYPTO', '浏览器暂不支持安全副本重试，请使用当前版本浏览器。')
    let legacyKey
    try { legacyKey = await documentCreationTrackingKey(crypto, { account: options.account, service: options.service,
      path: `/doc/${sourceId}/copy`, body }) }
    catch {
      checkCurrent(options)
      throw failure('COPY_CREATION_CRYPTO', '副本重试标识暂时无法准备，尚未发送请求。')
    }
    checkCurrent(options)
    return { key: options.prefix + legacyKey.slice('copage-create:'.length), legacyKey }
  }

  function parseRecord(raw) {
    try {
      if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_RECORD_BYTES) throw Error('size')
      const record = JSON.parse(raw)
      if (!record || typeof record !== 'object' || Array.isArray(record) ||
          Object.keys(record).some(key => ![...FIELDS, 'legacyRaw'].includes(key)) ||
          FIELDS.some(key => !Object.hasOwn(record, key)) || record.version !== 1 ||
          typeof record.requestId !== 'string' || !UUID.test(record.requestId) ||
          !Number.isSafeInteger(record.sourceId) || record.sourceId <= 0 ||
          !Number.isSafeInteger(record.createdAt) || record.createdAt <= 0 || record.createdAt > Date.now() ||
          !Number.isFinite(new Date(record.createdAt).getTime()) ||
          (Object.hasOwn(record, 'legacyRaw') && (typeof record.legacyRaw !== 'string' ||
            record.legacyRaw !== record.requestId || !UUID.test(record.legacyRaw)))) throw Error('fields')
      return { record, body: bodyOf(record.body) }
    } catch {
      throw failure('COPY_CREATION_RECORD', '原副本创建记录无法校验，已原样保留；请先核对我的文档。')
    }
  }

  async function decode(key, raw, options) {
    checkCurrent(options)
    if (typeof key !== 'string' || !key.startsWith(options.prefix) || !/^[\da-f]{64}$/.test(key.slice(options.prefix.length))) {
      throw failure('COPY_CREATION_RECORD', '原副本记录不属于当前账号或服务，请重新读取待确认创建。')
    }
    const decoded = parseRecord(raw)
    const keys = await keysFor(decoded.record.sourceId, decoded.body, options)
    if (key !== keys.key) throw failure('COPY_CREATION_RECORD', '原副本内容与存储槽位不匹配，记录保留且不会发送替代请求。')
    return { ...decoded, ...keys }
  }

  function summaryFor(key, raw, decoded, options) {
    const summary = Object.freeze({ key, requestId: decoded.record.requestId, sourceId: decoded.record.sourceId,
      body: decoded.body, createdAt: decoded.record.createdAt })
    snapshots.set(summary, { key, raw, prefix: options.prefix })
    return summary
  }

  function unchanged(storage, key, raw, options) {
    if (stored(() => storage.getItem(key), options) !== raw) {
      throw failure('COPY_CREATION_CHANGED', '原副本记录已消失或变化，请重新读取；尚未发送替代请求。')
    }
  }

  async function send(storage, key, raw, decoded, summary, options) {
    if (options.onPrepared) await options.onPrepared(summary)
    checkCurrent(options)
    unchanged(storage, key, raw, options)
    // 原请求确认不依赖来源读取；无已提交收据时，服务端仍执行当前来源权限校验。
    const result = await post(`/doc/${decoded.record.sourceId}/copy`, decoded.body, { ...options.config,
      headers: { ...options.config.headers, 'Idempotency-Key': decoded.record.requestId } })
    checkCurrent(options)
    if (!Number.isSafeInteger(result?.data?.id) || result.data.id <= 0 || typeof result.data.title !== 'string' ||
        !Number.isSafeInteger(result.data.sourceRevision) || result.data.sourceRevision < 0) {
      throw failure('COPY_CREATION_RESPONSE', '副本创建结果无法确认，请确认原请求或核对我的文档；原标识保留。', 500)
    }
    let cleaned = false
    const confirmTracking = () => {
      checkCurrent(options)
      if (cleaned) return result
      try {
        if (stored(() => storage.getItem(key), options) !== raw) return { ...result, creationTrackingWarning: changedWarning }
        if (Object.hasOwn(decoded.record, 'legacyRaw')) {
          const legacy = stored(() => storage.getItem(decoded.legacyKey), options)
          if (legacy !== null && legacy !== decoded.record.legacyRaw) return { ...result, creationTrackingWarning: changedWarning }
          if (legacy !== null) { checkCurrent(options); storage.removeItem(decoded.legacyKey) }
        }
        // 先结束旧UUID槽，再结束主记录；部分清理失败仍可用主记录确认同一UUID。
        if (stored(() => storage.getItem(key), options) !== raw) return { ...result, creationTrackingWarning: changedWarning }
        checkCurrent(options)
        storage.removeItem(key)
        cleaned = true // 同步清理成功后，不再用额外身份读取倒推已确认回复为未知。
        return result
      } catch (error) {
        if (error.name === 'AbortError') throw error
        return { ...result, creationTrackingWarning: warning }
      }
    }
    return options.deferCleanup ? { ...result, confirmTracking } : confirmTracking()
  }

  async function create(sourceId, input, config) {
    if (!Number.isSafeInteger(sourceId) || sourceId <= 0) throw failure('COPY_CREATION_INPUT', '原文档编号无效，尚未发送请求。')
    const body = bodyOf(input), options = optionsOf(config)
    const { key, legacyKey } = await keysFor(sourceId, body, options)
    const storage = stored(getStorage, options)
    let raw = stored(() => storage.getItem(key), options)
    if (raw === null) {
      const legacyRaw = stored(() => storage.getItem(legacyKey), options)
      if (legacyRaw !== null && (typeof legacyRaw !== 'string' || !UUID.test(legacyRaw))) {
        throw failure('COPY_CREATION_RECORD', '原副本UUID记录无法校验，已原样保留；尚未发送替代请求。')
      }
      if (legacyRaw === null && !crypto?.randomUUID) throw failure('COPY_CREATION_CRYPTO', '浏览器暂不支持安全副本重试，请使用当前版本浏览器。')
      const record = { version: 1, requestId: legacyRaw ?? crypto.randomUUID(), sourceId, body, createdAt: Date.now(),
        ...(legacyRaw !== null ? { legacyRaw } : {}) }
      raw = JSON.stringify(record)
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
      throw failure('COPY_CREATION_RECORD', '请重新读取当前账号与服务的待确认副本，再确认原记录。')
    }
    const storage = stored(getStorage, options)
    const raw = stored(() => storage.getItem(original.key), options)
    if (raw !== original.raw) throw failure('COPY_CREATION_CHANGED', '原副本记录已消失或变化，请重新读取；尚未发送替代请求。')
    const decoded = await decode(original.key, raw, options)
    unchanged(storage, original.key, raw, options)
    return send(storage, original.key, raw, decoded, summary, options)
  }

  async function listPending(config) {
    const options = optionsOf(config), storage = stored(getStorage, options)
    const length = stored(() => storage.length, options)
    if (!Number.isSafeInteger(length) || length < 0) throw failure('COPY_CREATION_STORAGE', '副本重试记录暂时无法读取，原记录保留。')
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
