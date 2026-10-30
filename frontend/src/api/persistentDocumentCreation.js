import { documentCreationFingerprint, documentCreationFingerprintKey } from './creationRequest.js'

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const MAX_BYTES = 16384
const fail = (reason, message, code = 400) => Object.assign(new Error(message), { reason, code })
const warning = '原创建已确认，但浏览器未能结束待确认记录。原标识仍保留，请恢复存储后确认，勿按同名资料重复创建。'
const changed = '原创建已确认，但本地记录已变化；当前记录保留，请重新核对。'
const keysOnly = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k))
function kindOf(path) {
  if (path === '/doc') return 'document'
  if (path === '/doc/import') return 'import'
  const match = /^\/personal-templates\/([1-9]\d*)\/documents$/.exec(path)
  if (match && Number.isSafeInteger(Number(match[1]))) return 'personal-template:' + match[1]
  throw fail('DOCUMENT_CREATION_INPUT', '创建来源无法识别，尚未发送请求。')
}
function validateFingerprint(path, value) {
  const kind = kindOf(path), title = v => v === null || (typeof v === 'string' && v.length <= 200)
  if (kind === 'import') {
    if (!Array.isArray(value) || ![1, 2].includes(value.length)) throw Error('import fingerprint')
    const names = value.map(entry => Array.isArray(entry) && entry.length === 2 ? entry[0] : null)
    if (new Set(names).size !== names.length || !names.includes('file') || names.some(n => !['file', 'title'].includes(n))) throw Error('import fields')
    for (const [name, v] of value) {
      if (name === 'title' ? !title(v) : !keysOnly(v, ['filename', 'hash']) || typeof v.filename !== 'string' ||
          typeof v.hash !== 'string' || !/^[\da-f]{64}$/.test(v.hash)) throw Error('import metadata')
    }
  } else if (!(kind === 'document' && value === null)) {
    if (!keysOnly(value, kind === 'document' ? ['title', 'parentId', 'templateId'] : ['title']) ||
        (Object.hasOwn(value, 'title') && !title(value.title)) ||
        (Object.hasOwn(value, 'parentId') && value.parentId !== null && (!Number.isSafeInteger(value.parentId) || value.parentId < 0)) ||
        (Object.hasOwn(value, 'templateId') && value.templateId !== null && (typeof value.templateId !== 'string' || value.templateId.length > 200))) throw Error('creation metadata')
  }
}
function identityOptions(input = {}) {
  const { account, service, isCurrent = () => true, onPrepared, deferCleanup = false, preserveRejectedTracking, ...config } = input
  if (![account, service].every(v => typeof v === 'string' && v) || typeof isCurrent !== 'function' || typeof deferCleanup !== 'boolean')
    throw fail('DOCUMENT_CREATION_IDENTITY', '请重新登录原账号后核对创建；原记录保留。')
  return { account, service, isCurrent, onPrepared, deferCleanup, config, preserveRejectedTracking: preserveRejectedTracking === true,
    prefix: `copage-document-create:v1:${encodeURIComponent(service)}:${encodeURIComponent(account)}:` }
}
function check(options) {
  if (options.config.signal?.aborted) throw new DOMException('创建页面已关闭', 'AbortError')
  let current
  try { current = options.isCurrent() } catch { throw fail('DOCUMENT_CREATION_STORAGE', '暂时无法核对当前账号，原创建记录保留。') }
  if (current !== true) throw new DOMException('创建账号已变化', 'AbortError')
}
function describe(record) {
  const fp = record.fingerprint, imported = Array.isArray(fp)
  return { title: imported ? fp.find(([k]) => k === 'title')?.[1] || '' : fp?.title || '未命名文档',
    filename: imported ? fp.find(([k]) => k === 'file')?.[1].filename : undefined,
    templateId: imported ? undefined : fp?.templateId }
}

// 主记录只保存UUID、来源及创建指纹元数据；文件只保留名称/摘要，不保存文件字节、正文或令牌。
export function createPersistentDocumentCreator({ getStorage, getSessionStorage, crypto, withLock, post, get }) {
  const snapshots = new WeakMap()
  function stored(action, options) {
    check(options)
    try { return action() } catch (error) {
      if (error.name === 'AbortError') throw error
      throw fail('DOCUMENT_CREATION_STORAGE', '浏览器无法保存或读取原创建记录，请恢复本站存储后重试；原资料保留。')
    }
  }
  async function lock(key, action, options) {
    if (typeof withLock !== 'function') throw fail('DOCUMENT_CREATION_LOCK', '浏览器暂不支持安全保存创建记录，请使用当前版本浏览器。')
    return withLock(key, () => { check(options); return action() }, options.config.signal)
  }
  async function recordKey(record, options) {
    const legacyKey = await documentCreationFingerprintKey(crypto, { ...options, path: record.path, fingerprint: record.fingerprint })
    return { legacyKey, key: options.prefix + record.requestId.toLowerCase() }
  }
  function legacyValue(raw, privateTemplate) {
    if (privateTemplate) {
      const value = JSON.parse(raw)
      if (!keysOnly(value, ['requestId', 'expectedVersion']) || Object.keys(value).length !== 2 || !UUID.test(value.requestId) ||
          !Number.isSafeInteger(value.expectedVersion) || value.expectedVersion <= 0) throw Error('legacy template')
      return value
    }
    if (typeof raw !== 'string' || !UUID.test(raw)) throw Error('legacy uuid')
    return { requestId: raw }
  }
  async function decode(key, raw, options) {
    try {
      if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_BYTES) throw Error('size')
      const record = JSON.parse(raw), privateTemplate = kindOf(record?.path).startsWith('personal-template:')
      if (!keysOnly(record, ['version', 'requestId', 'path', 'fingerprint', 'createdAt', 'expectedVersion', 'slotValue']) || record.version !== 1 ||
          !UUID.test(record.requestId) || !Number.isSafeInteger(record.createdAt) || record.createdAt <= 0 || !Object.hasOwn(record, 'fingerprint')) throw Error('shape')
      validateFingerprint(record.path, record.fingerprint)
      if (privateTemplate ? !Number.isSafeInteger(record.expectedVersion) || record.expectedVersion <= 0 : Object.hasOwn(record, 'expectedVersion')) throw Error('version')
      {
        const old = legacyValue(record.slotValue, privateTemplate)
        if (old.requestId !== record.requestId || old.expectedVersion !== record.expectedVersion) throw Error('legacy mismatch')
      }
      const names = await recordKey(record, options)
      if (names.key !== key) throw Error('scope')
      check(options)
      return { record, ...names }
    } catch (error) {
      if (error.name === 'AbortError' || error.reason === 'DOCUMENT_CREATION_STORAGE') throw error
      throw fail('DOCUMENT_CREATION_RECORD', '原创建记录无法校验，已原样保留；不会发送替代请求。')
    }
  }
  function summary(key, raw, decoded, options) {
    const value = Object.freeze({ key, requestId: decoded.record.requestId, kind: kindOf(decoded.record.path),
      createdAt: decoded.record.createdAt, ...describe(decoded.record) })
    snapshots.set(value, { key, raw, decoded, prefix: options.prefix })
    return value
  }
  function unchanged(storage, original, options) {
    if (stored(() => storage.getItem(original.key), options) !== original.raw)
      throw fail('DOCUMENT_CREATION_CHANGED', '原创建记录已变化，请重新读取；不会替换当前记录。')
  }
  function accepted(result, original, options) {
    let cleaned = false
    const confirmTracking = async () => {
      check(options)
      if (cleaned) return result
      try {
        return await lock(original.key, () => {
          const storage = stored(getStorage, options)
          if (stored(() => storage.getItem(original.key), options) !== original.raw) return { ...result, creationTrackingWarning: changed }
          const { record, legacyKey } = original.decoded
          const session = stored(getSessionStorage, options)
          // 当前标签可能正准备另一项同名创建；只清除本请求的旧槽，不触碰另一个UUID。
          if (stored(() => session.getItem(legacyKey), options) === record.slotValue)
            stored(() => session.removeItem(legacyKey), options)
          unchanged(storage, original, options)
          storage.removeItem(original.key); cleaned = true
          return result
        }, options)
      } catch (error) {
        if (error.name === 'AbortError') throw error
        check(options)
        return { ...result, creationTrackingWarning: warning }
      }
    }
    return options.deferCleanup ? { ...result, confirmTracking } : confirmTracking()
  }
  async function create(path, body, input) {
    const options = identityOptions(input), privateTemplate = kindOf(path).startsWith('personal-template:')
    check(options)
    const trackedBody = privateTemplate ? { ...body } : body
    if (privateTemplate) delete trackedBody.expectedVersion
    let fingerprint
    try { fingerprint = await documentCreationFingerprint(crypto, trackedBody); validateFingerprint(path, fingerprint) }
    catch { throw fail('DOCUMENT_CREATION_INPUT', '无法保存本次创建的元数据，尚未发送请求。') }
    const legacyKey = await documentCreationFingerprintKey(crypto, { ...options, path, fingerprint })
    const storage = stored(getStorage, options)
    let hadTracked = false
    const preparedValue = await lock(options.prefix + legacyKey, async () => {
      const session = stored(getSessionStorage, options)
      let slotValue = stored(() => session.getItem(legacyKey), options)
      hadTracked = slotValue !== null
      let original
      try {
        if (slotValue !== null) original = legacyValue(slotValue, privateTemplate)
        else {
          original = { requestId: crypto.randomUUID(), ...(privateTemplate ? { expectedVersion: body?.expectedVersion } : {}) }
          slotValue = privateTemplate ? JSON.stringify(original) : original.requestId
          legacyValue(slotValue, privateTemplate)
          stored(() => session.setItem(legacyKey, slotValue), options)
        }
      } catch (error) {
        if (error.name === 'AbortError' || error.reason === 'DOCUMENT_CREATION_STORAGE') throw error
        throw fail('DOCUMENT_CREATION_RECORD', '当前标签的原创建标识无法校验，已保留，尚未发送请求。')
      }
      const key = options.prefix + original.requestId.toLowerCase()
      let raw = stored(() => storage.getItem(key), options)
      if (raw === null) {
        const record = { version: 1, requestId: original.requestId, path, fingerprint, createdAt: Date.now(), slotValue,
          ...(privateTemplate ? { expectedVersion: original.expectedVersion } : {}) }
        raw = JSON.stringify(record)
        await decode(key, raw, options)
        stored(() => storage.setItem(key, raw), options)
      }
      const decoded = await decode(key, raw, options)
      if (decoded.legacyKey !== legacyKey || decoded.record.slotValue !== slotValue)
        throw fail('DOCUMENT_CREATION_CONFLICT', '原创建记录与当前标签不一致，两份都保留，尚未发送请求。')
      return { key, raw, decoded }
    }, options)
    const { key, raw, decoded } = preparedValue, prepared = summary(key, raw, decoded, options), original = snapshots.get(prepared)
    if (options.onPrepared) await options.onPrepared(prepared)
    unchanged(storage, original, options)
    let result
    try {
      result = await post(path, privateTemplate ? { ...body, expectedVersion: decoded.record.expectedVersion } : body,
        { ...options.config, headers: { ...options.config.headers, 'Idempotency-Key': decoded.record.requestId } })
    } catch (error) {
      check(options)
      if (!hadTracked && [400, 403, 404].includes(error?.code)) await accepted({ data: null }, original, { ...options, deferCleanup: false })
      if (hadTracked && options.preserveRejectedTracking)
        throw Object.assign(new Error(error?.message || '原创建结果仍未确认，请继续核对原请求。'), error, { uncertain: true })
      throw error
    }
    check(options)
    if (result?.code !== 0 || !Number.isSafeInteger(result?.data?.id) || result.data.id <= 0)
      throw fail('DOCUMENT_CREATION_RESPONSE', '创建结果无法确认，原标识保留；请确认原请求。', 500)
    return accepted(result, original, options)
  }
  async function listPending(input) {
    const options = identityOptions(input), storage = stored(getStorage, options), records = []
    let unreadable = 0
    const keys = []
    for (let n = 0, size = stored(() => storage.length, options); n < size; n++) {
      const key = stored(() => storage.key(n), options)
      if (typeof key === 'string' && key.startsWith(options.prefix)) keys.push(key)
    }
    for (const key of keys) {
      const raw = stored(() => storage.getItem(key), options)
      if (raw === null) continue
      try { const decoded = await decode(key, raw, options); records.push(summary(key, raw, decoded, options)) }
      catch (error) { if (error.name === 'AbortError' || error.reason === 'DOCUMENT_CREATION_STORAGE') throw error; unreadable++ }
    }
    check(options)
    return { records: records.sort((a, b) => a.createdAt - b.createdAt), unreadable }
  }
  async function confirm(prepared, input) {
    const options = identityOptions(input), original = prepared && snapshots.get(prepared)
    check(options)
    if (!original || original.prefix !== options.prefix) throw fail('DOCUMENT_CREATION_RECORD', '请重新读取原账号的待确认创建。')
    const storage = stored(getStorage, options)
    unchanged(storage, original, options)
    let result
    try { result = await get('/doc/creation-requests/' + prepared.requestId, options.config) }
    catch (error) { check(options); throw error }
    check(options)
    const data = result?.data
    if (result?.code !== 0 || typeof data?.requestId !== 'string' || data.requestId.toLowerCase() !== prepared.requestId.toLowerCase() ||
        data.kind !== prepared.kind || !Number.isSafeInteger(data.id) || data.id <= 0 || typeof data.available !== 'boolean' ||
        typeof data.deleted !== 'boolean' || (data.available ? typeof data.title !== 'string' : data.title !== null || data.deleted))
      throw fail('DOCUMENT_CREATION_RESPONSE', '原请求回复无法校验，记录保留；没有重新创建文档。', 500)
    return accepted(result, original, options)
  }
  async function endWaiting(prepared, input) {
    const options = identityOptions(input), original = prepared && snapshots.get(prepared)
    check(options)
    if (!original || original.prefix !== options.prefix) throw fail('DOCUMENT_CREATION_RECORD', '请重新读取原账号的待确认创建。')
    return lock(original.key, () => {
      const storage = stored(getStorage, options), session = stored(getSessionStorage, options)
      unchanged(storage, original, options)
      const { record, legacyKey } = original.decoded
      if (stored(() => session.getItem(legacyKey), options) === record.slotValue)
        stored(() => session.removeItem(legacyKey), options)
      unchanged(storage, original, options)
      stored(() => storage.removeItem(original.key), options)
      return { ended: true }
    }, options)
  }
  return { create, listPending, confirm, endWaiting }
}
