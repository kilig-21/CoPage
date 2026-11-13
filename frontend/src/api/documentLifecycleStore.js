const prefix = 'copage-document-lifecycle:v1:'
const invalid = () => new Error('这条待核对记录无法读取。')

function parse(raw) {
  let value
  try { value = JSON.parse(raw) } catch { throw invalid() }
  if (!value || Object.keys(value).length !== 3 ||
      !['delete', 'restore'].includes(value.operation) ||
      typeof value.attemptId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.attemptId) ||
      !Number.isSafeInteger(value.id) || value.id <= 0) throw invalid()
  return value
}

export function documentLifecycleKey({ account, service }) {
  return prefix + JSON.stringify([service, account])
}

// All changes to this slot take the same browser lock across both pages and tabs.
export function createDocumentLifecycleStore({ storage, key, withLock, newId = () => crypto.randomUUID() }) {
  function read() {
    const raw = storage().getItem(key)
    if (raw === null) return null
    try { return { raw, target: parse(raw) } }
    catch { return { raw, target: null } }
  }

  return {
    read,
    exclusive: action => withLock(key, action),
    prepare(target) {
      if (read()) return null
      const raw = JSON.stringify({ id: target.id, operation: target.operation, attemptId: newId() })
      parse(raw)
      const area = storage()
      area.setItem(key, raw)
      if (area.getItem(key) !== raw) throw new Error('浏览器未能保存待核对记录。')
      return raw
    },
    clear(expected) {
      const area = storage()
      if (area.getItem(key) !== expected) return false
      area.removeItem(key)
      if (area.getItem(key) !== null) throw new Error('浏览器未能清除待核对记录。')
      return true
    },
  }
}

export function lockDocumentLifecycleRecord(key, action, locks = globalThis.navigator?.locks) {
  if (!locks?.request) throw new Error('当前浏览器无法安全协调多个标签页，请使用新版浏览器。')
  return locks.request(key, { ifAvailable: true }, lock => {
    if (!lock) throw new Error('另一个页面正在处理这项操作，请稍后再试。')
    return action()
  })
}
