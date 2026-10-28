const PREFIX = 'copage-history-restore:v1:'
const uuid = value => typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
const revision = value => Number.isSafeInteger(value) && value >= 0
const fields = ['version', 'targetRevision', 'expectedRevision', 'requestId']
const invalid = () => Error('历史恢复确认记录无法校验，已原样保留；请先核对当前正文。')

// Only request metadata lives here. No content, title, token or password is stored.
// Mutations are serialized across cooperating tabs; the HTTP request holds no lock.
export function createHistoryRestoreStore({ getStorage, withLock }) {
  const cache = new Map()
  function storageKey(key) {
    let values
    try { values = JSON.parse(key) } catch { throw invalid() }
    if (!Array.isArray(values) || values.length !== 3 ||
        typeof values[0] !== 'string' || values[0].length > 2048 ||
        typeof values[1] !== 'string' || !values[1].trim() || values[1].length > 128 ||
        !Number.isSafeInteger(values[2]) || values[2] <= 0) throw invalid()
    return PREFIX + encodeURIComponent(JSON.stringify(values))
  }
  function parse(raw) {
    if (typeof raw !== 'string' || raw.length > 1024) throw invalid()
    let record
    try { record = JSON.parse(raw) } catch { throw invalid() }
    if (!record || Array.isArray(record) || Object.keys(record).length !== fields.length ||
        fields.some(field => !Object.hasOwn(record, field)) || record.version !== 1 ||
        !revision(record.targetRevision) || !revision(record.expectedRevision) ||
        record.expectedRevision === Number.MAX_SAFE_INTEGER || !uuid(record.requestId)) throw invalid()
    return Object.freeze({ targetRevision: record.targetRevision, expectedRevision: record.expectedRevision, requestId: record.requestId })
  }
  function get(key) {
    const slot = storageKey(key), raw = getStorage().getItem(slot)
    if (raw === null) { cache.delete(slot); return undefined }
    const previous = cache.get(slot)
    if (previous?.raw === raw) return previous.target
    const target = parse(raw)
    cache.set(slot, { raw, target })
    return target
  }
  return {
    get, has: key => get(key) !== undefined,
    set(key, target) {
      const slot = storageKey(key), storage = getStorage()
      if (storage.getItem(slot) !== null) throw Error('已有历史恢复等待确认，请先确认原请求。')
      const raw = JSON.stringify({ version: 1, ...target })
      parse(raw)
      storage.setItem(slot, raw)
      if (storage.getItem(slot) !== raw) throw Error('历史恢复记录未能可靠保存，尚未发送请求。')
      cache.set(slot, { raw, target })
    },
    delete(key, expected) {
      if (get(key) !== expected) return false
      const slot = storageKey(key), storage = getStorage()
      storage.removeItem(slot)
      if (storage.getItem(slot) !== null) return false
      cache.delete(slot)
      return true
    },
    exclusive(key, action, signal) {
      const slot = storageKey(key)
      if (typeof withLock !== 'function') throw Error('浏览器暂不支持安全保存恢复确认，请使用当前版本浏览器。')
      return withLock(slot, action, signal)
    },
  }
}
