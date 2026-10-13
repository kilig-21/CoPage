const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const RECORD_FIELDS = ['version', 'requestId', 'name', 'description', 'groupId', 'createdAt']
const MAX_RECORD_BYTES = 4096
const trackingWarning = '项目已创建，但浏览器未能结束原重试记录。原标识继续保留；请核对项目或恢复存储后重试，重复请求会确认原项目。'

function failure(reason, message, code = 400) {
  return Object.assign(new Error(message), { code, reason })
}

function bodyOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['name', 'description', 'groupId'].includes(key))) {
    throw failure('PROJECT_CREATION_INPUT', '项目创建内容无法识别，尚未发送请求。')
  }
  if (typeof value.name !== 'string' || (value.description != null && typeof value.description !== 'string')) {
    throw failure('PROJECT_CREATION_INPUT', '请核对项目名称和简介，尚未发送请求。')
  }
  const name = value.name.trim(), description = (value.description ?? '').trim(), groupId = value.groupId ?? 0
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(name) || description.length > 300 ||
      /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(description) ||
      !Number.isSafeInteger(groupId) || groupId < 0) {
    throw failure('PROJECT_CREATION_INPUT', '项目名称、简介或归属无效，尚未发送请求。')
  }
  return Object.freeze({ name, description, groupId })
}

function optionsOf({ account, service, isCurrent = () => true, onPrepared, deferCleanup = false, ...config } = {}) {
  if (typeof account !== 'string' || !account.trim() || typeof service !== 'string' || !service ||
      typeof isCurrent !== 'function' || typeof deferCleanup !== 'boolean' ||
      (onPrepared !== undefined && typeof onPrepared !== 'function')) {
    throw failure('PROJECT_CREATION_IDENTITY', '当前账号、服务或创建准备信息无法确认，尚未发送请求。')
  }
  let prefix
  try { prefix = `copage-project-create:v1:${encodeURIComponent(service)}:${encodeURIComponent(account)}:` }
  catch { throw failure('PROJECT_CREATION_IDENTITY', '当前账号或服务无法确认，尚未发送请求。') }
  return { prefix, isCurrent, onPrepared, deferCleanup, config }
}

function checkCurrent(options) {
  let current = false
  try { current = options.isCurrent() === true } catch { /* 身份不可读不能使用旧请求继续创建。 */ }
  if (options.config.signal?.aborted || !current) throw new DOMException('项目创建页面或账号已变更', 'AbortError')
}

function stored(read, options) {
  checkCurrent(options)
  let value
  try { value = read() }
  catch {
    checkCurrent(options)
    throw failure('PROJECT_CREATION_STORAGE', '浏览器无法读取或保存项目重试记录，请恢复存储后重试；原记录保留。')
  }
  checkCurrent(options)
  return value
}

/** 本地保存原项目名称、简介、归属、UUID和准备时间；不保存正文、令牌或密码。 */
export function createProjectCreator({ getStorage, crypto, post }) {
  const snapshots = new WeakMap()

  async function fingerprint(body, options) {
    checkCurrent(options)
    if (!crypto?.subtle) throw failure('PROJECT_CREATION_CRYPTO', '浏览器暂不支持安全创建重试，请使用当前版本浏览器。')
    let hash
    try { hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([body.name, body.description, body.groupId]))) }
    catch { throw failure('PROJECT_CREATION_CRYPTO', '项目重试标识暂时无法准备，尚未发送请求。') }
    checkCurrent(options)
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
  }

  function parseRecord(raw) {
    let record, body
    try {
      if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_RECORD_BYTES) throw Error('record size')
      record = JSON.parse(raw)
      if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== RECORD_FIELDS.length ||
          RECORD_FIELDS.some(field => !Object.hasOwn(record, field)) || record.version !== 1 ||
          typeof record.requestId !== 'string' || !UUID.test(record.requestId) || typeof record.description !== 'string' ||
          !Number.isSafeInteger(record.createdAt) || record.createdAt <= 0 || record.createdAt > Date.now() ||
          !Number.isFinite(new Date(record.createdAt).getTime())) throw Error('record fields')
      body = bodyOf({ name: record.name, description: record.description, groupId: record.groupId })
      if (record.name !== body.name || record.description !== body.description || record.groupId !== body.groupId) throw Error('record normalization')
    } catch {
      throw failure('PROJECT_CREATION_RECORD', '原项目创建记录无法校验，已原样保留；请先核对已有项目。')
    }
    return { record, body }
  }

  async function decode(key, raw, options) {
    checkCurrent(options)
    if (typeof key !== 'string' || !key.startsWith(options.prefix) ||
        !/^[\da-f]{64}$/.test(key.slice(options.prefix.length))) {
      throw failure('PROJECT_CREATION_RECORD', '原创建记录不属于当前账号或服务，请重新读取待确认创建。')
    }
    const { record, body } = parseRecord(raw)
    if (key !== options.prefix + await fingerprint(body, options)) {
      throw failure('PROJECT_CREATION_RECORD', '原创建内容与存储槽位不匹配，记录保留且不会发送替代请求。')
    }
    return { record, body }
  }

  function summaryFor(key, raw, record, options) {
    const summary = Object.freeze({ key, requestId: record.requestId, name: record.name,
      groupId: record.groupId, createdAt: record.createdAt })
    snapshots.set(summary, { key, raw, prefix: options.prefix })
    return summary
  }

  function unchanged(storage, key, raw, options) {
    if (stored(() => storage.getItem(key), options) !== raw) {
      throw failure('PROJECT_CREATION_CHANGED', '原创建记录已消失或变化，请重新读取；尚未发送替代请求。')
    }
  }

  async function send(storage, key, raw, decoded, summary, options) {
    if (options.onPrepared) await options.onPrepared(summary)
    checkCurrent(options)
    unchanged(storage, key, raw, options)
    const result = await post('/projects', decoded.body, { ...options.config,
      headers: { ...options.config.headers, 'Idempotency-Key': decoded.record.requestId } })
    checkCurrent(options)
    if (!Number.isSafeInteger(result?.data?.id) || result.data.id <= 0 || result.data.groupId !== decoded.body.groupId) {
      throw failure('PROJECT_CREATION_RESPONSE', '项目创建结果无法确认，请重试原创建或核对项目；原记录保留。', 500)
    }
    // 上层可在最后接受回复后，同一调用栈内明确确认清理；等待期间保留原UUID。
    const confirmTracking = () => {
      checkCurrent(options)
      try {
        const currentRaw = stored(() => storage.getItem(key), options)
        if (currentRaw === null) return result // 另一条相同请求已确认并清理原记录。
        if (currentRaw !== raw) return { ...result, creationTrackingWarning:
          '项目已创建，但原重试槽位在等待期间发生变化。当前记录已保留且不会覆盖，请核对已创建项目后再决定下一步。' }
        // removeItem原子成功后不因一次额外身份读取失败误报未确认。
        // Web Storage失败会抛错且不修改原槽位。
        checkCurrent(options)
        storage.removeItem(key)
      } catch (error) {
        if (error.name === 'AbortError') throw error
        return { ...result, creationTrackingWarning: trackingWarning }
      }
      return result
    }
    return options.deferCleanup ? { ...result, confirmTracking } : confirmTracking()
  }

  async function create(input, config) {
    const body = bodyOf(input) // 第一处await之前冻结原表单内容。
    const options = optionsOf(config)
    const key = options.prefix + await fingerprint(body, options)
    const storage = stored(getStorage, options)
    let raw = stored(() => storage.getItem(key), options)
    if (raw === null) {
      if (!crypto?.randomUUID) throw failure('PROJECT_CREATION_CRYPTO', '浏览器暂不支持安全创建重试，请使用当前版本浏览器。')
      const record = { version: 1, requestId: crypto.randomUUID(), ...body, createdAt: Date.now() }
      raw = JSON.stringify(record)
      // 已从冻结body计算过key；同步校验再写入，中间不yield覆盖同标签先准备的UUID。
      parseRecord(raw)
      stored(() => storage.setItem(key, raw), options)
    }
    const decoded = await decode(key, raw, options)
    unchanged(storage, key, raw, options)
    return send(storage, key, raw, decoded, summaryFor(key, raw, decoded.record, options), options)
  }

  async function retry(summary, config) {
    const options = optionsOf(config)
    checkCurrent(options)
    const original = summary && typeof summary === 'object' ? snapshots.get(summary) : null
    if (!original || original.prefix !== options.prefix || summary.key !== original.key) {
      throw failure('PROJECT_CREATION_RECORD', '请重新读取当前账号与服务的待确认创建，再重试原记录。')
    }
    const storage = stored(getStorage, options)
    const raw = stored(() => storage.getItem(original.key), options)
    if (raw !== original.raw) throw failure('PROJECT_CREATION_CHANGED', '原创建记录已消失或变化，请重新读取；尚未发送替代请求。')
    const decoded = await decode(original.key, raw, options)
    unchanged(storage, original.key, raw, options)
    return send(storage, original.key, raw, decoded, summary, options)
  }

  async function listPending(config) {
    const options = optionsOf(config)
    const storage = stored(getStorage, options)
    const length = stored(() => storage.length, options)
    if (!Number.isSafeInteger(length) || length < 0) throw failure('PROJECT_CREATION_STORAGE', '项目重试记录暂时无法读取，原记录保留。')
    const keys = new Set()
    for (let index = 0; index < length; index++) {
      const key = stored(() => storage.key(index), options)
      if (typeof key === 'string' && key.startsWith(options.prefix)) keys.add(key)
    }
    const records = []
    for (const key of keys) {
      const raw = stored(() => storage.getItem(key), options)
      if (raw === null) continue
      const decoded = await decode(key, raw, options)
      unchanged(storage, key, raw, options)
      records.push(summaryFor(key, raw, decoded.record, options))
    }
    checkCurrent(options)
    return records.sort((a, b) => b.createdAt - a.createdAt || a.key.localeCompare(b.key))
  }

  return { create, retry, listPending }
}
