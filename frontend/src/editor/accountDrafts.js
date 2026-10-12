import { validateDraftRecord } from './draftRecords.js'

function failure(code, message) {
  return Object.assign(new Error(message), { code })
}

function checkIdentity(isCurrent) {
  let current = false
  try { current = isCurrent() === true } catch { /* 身份读取失败也不能返回旧账号内容。 */ }
  if (!current) throw failure('DRAFT_IDENTITY_CHANGED', '当前账号无法确认，请重新读取本地草稿。')
}

function accountPrefix(username) {
  if (typeof username !== 'string' || !username.trim()) {
    throw failure('DRAFT_IDENTITY_CHANGED', '当前账号无法确认，请重新读取本地草稿。')
  }
  try { return `copage-draft:v1:${encodeURIComponent(username)}:` }
  catch { throw failure('DRAFT_IDENTITY_CHANGED', '当前账号无法确认，请重新读取本地草稿。') }
}

function readStorage(read, isCurrent) {
  checkIdentity(isCurrent)
  let result
  try { result = read() }
  catch {
    checkIdentity(isCurrent)
    throw failure('DRAFT_STORAGE_UNAVAILABLE', '浏览器暂时无法读取本地草稿，原记录保留。')
  }
  checkIdentity(isCurrent)
  return result
}

function slotFor(key, prefix) {
  if (typeof key !== 'string' || !key.startsWith(prefix)) {
    throw failure('DRAFT_KEY_INVALID', '这份记录不属于当前账号。')
  }
  const match = /^([1-9]\d*):(.+)$/s.exec(key.slice(prefix.length))
  const docId = match ? Number(match[1]) : NaN
  if (!Number.isSafeInteger(docId) || docId <= 0 || String(docId) !== match[1]) return null
  return { docId, prefix: prefix + match[1] + ':' }
}

function reliableTime(value, now) {
  return Number.isSafeInteger(value) && value > 0 && Number.isFinite(now) && value <= now
    && Number.isFinite(new Date(value).getTime()) ? value : null
}

function inspect({ key, raw, prefix, Delta, now }) {
  const slot = slotFor(key, prefix)
  if (!slot) return { key, docId: null, savedAt: null, readable: false }
  try {
    const draft = validateDraftRecord({ key, raw, prefix: slot.prefix, docId: slot.docId, Delta })
    return { key, docId: slot.docId, savedAt: reliableTime(draft.savedAt, now), readable: true, draft }
  } catch { return { key, docId: slot.docId, savedAt: null, readable: false } }
}

/** 一次枚举当前账号的槽位；列表只返回摘要，不返回正文或原始字符串。 */
export function enumerateAccountDrafts({ storage, username, Delta, isCurrent = () => true, now = Date.now() }) {
  checkIdentity(isCurrent)
  const prefix = accountPrefix(username)
  const length = readStorage(() => storage.length, isCurrent)
  if (!Number.isSafeInteger(length) || length < 0) {
    throw failure('DRAFT_STORAGE_UNAVAILABLE', '浏览器暂时无法读取本地草稿，原记录保留。')
  }
  const keys = new Set()
  for (let index = 0; index < length; index++) {
    const key = readStorage(() => storage.key(index), isCurrent)
    if (typeof key === 'string' && key.startsWith(prefix)) keys.add(key)
  }
  const summaries = []
  for (const key of keys) {
    const raw = readStorage(() => storage.getItem(key), isCurrent)
    if (raw === null) continue
    if (typeof raw !== 'string') throw failure('DRAFT_STORAGE_UNAVAILABLE', '浏览器暂时无法读取本地草稿，原记录保留。')
    const { draft, ...summary } = inspect({ key, raw, prefix, Delta, now })
    summaries.push(summary)
  }
  checkIdentity(isCurrent)
  return summaries
}

/** 点击下载时重新读取原槽位；消失不意味着已同步，损坏记录只能下载原始副本。 */
export function readAccountDraft({ storage, username, key, Delta, isCurrent = () => true, now = Date.now() }) {
  checkIdentity(isCurrent)
  const prefix = accountPrefix(username)
  slotFor(key, prefix) // 先校验账号前缀，不能读取其他账号正文。
  const raw = readStorage(() => storage.getItem(key), isCurrent)
  if (raw === null) throw failure('DRAFT_MISSING', '当前未找到这份本地记录，请刷新核对；这不表示已经同步。')
  if (typeof raw !== 'string') throw failure('DRAFT_STORAGE_UNAVAILABLE', '浏览器暂时无法读取本地草稿，原记录保留。')
  const { draft, ...summary } = inspect({ key, raw, prefix, Delta, now })
  const result = draft ? { ...summary, backup: {
    docId: summary.docId, username, title: `文档 #${summary.docId}`, savedAt: summary.savedAt,
    content: draft.content,
  } } : { ...summary, raw }
  checkIdentity(isCurrent)
  return result
}
