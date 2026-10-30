import { message } from 'antd'
import request from './request'
import { createPersistentDocumentCreator } from './persistentDocumentCreation'
import { createCopy } from './copyDocuments'

const creator = createPersistentDocumentCreator({ getStorage: () => localStorage, getSessionStorage: () => sessionStorage,
  crypto: globalThis.crypto,
  withLock: (name, action, signal) => {
    if (!globalThis.navigator?.locks?.request) throw Error('浏览器暂不支持安全保存创建记录，请使用当前版本浏览器。')
    return navigator.locks.request(name, { mode: 'exclusive', ...(signal ? { signal } : {}) }, action)
  },
  post: (path, body, config) => request.post(path, body, config), get: (path, config) => request.get(path, config) })

export function documentCreationIdentity() {
  try { return Object.freeze({ account: localStorage.getItem('collab-user'), token: localStorage.getItem('collab-token'), service: request.defaults.baseURL }) }
  catch { return null }
}
export function sameDocumentCreationIdentity(identity) {
  const current = documentCreationIdentity()
  return Boolean(identity?.account && identity.token && current && ['account', 'token', 'service'].every(k => current[k] === identity[k]))
}
function options(config = {}) {
  const { expectedIdentity, ...rest } = config, current = documentCreationIdentity()
  if (!current?.account || !current.token) throw Object.assign(new Error('请重新登录原账号后核对创建；原记录保留。'), { code: 400 })
  if ((Object.hasOwn(config, 'expectedIdentity') && !sameDocumentCreationIdentity(expectedIdentity)) ||
      (Object.hasOwn(rest, 'copageExpectedSessionToken') && rest.copageExpectedSessionToken !== current.token))
    throw Object.assign(new Error('登录状态已更改，尚未发送本次创建，请重新登录原账号；原记录保留。'), { code: 400 })
  const identity = expectedIdentity || current
  return { ...rest, account: identity.account, service: identity.service, copageExpectedSessionToken: identity.token,
    isCurrent: () => sameDocumentCreationIdentity(identity) }
}
export function notifyDocumentCreations() {
  try { window.dispatchEvent(new Event('copage-document-creations-changed')) } catch { /* 刷新仍可读取原记录。 */ }
}
function accepted(result) {
  const warn = response => {
    notifyDocumentCreations()
    if (response.creationTrackingWarning) { try { message.warning(response.creationTrackingWarning, 10) } catch { /* 不改变已确认结果。 */ } }
    return response
  }
  return typeof result.confirmTracking === 'function'
    ? { ...result, confirmTracking: async () => warn(await result.confirmTracking()) } : warn(result)
}
export function listPendingDocumentCreations(config) { return creator.listPending(options(config)) }
export async function confirmDocumentCreation(record, config) {
  return accepted(await creator.confirm(record, options(config)))
}
export async function endDocumentCreationWaiting(record, config) {
  try { return await creator.endWaiting(record, options(config)) } finally { notifyDocumentCreations() }
}

export default async function createDocument(path, body, config = {}) {
  const copy = /^\/doc\/([1-9]\d*)\/copy$/.exec(path)
  if (copy) return createCopy(Number(copy[1]), body, config)
  try {
    return accepted(await creator.create(path, body, options({ ...config, onPrepared: async record => {
      notifyDocumentCreations(); await config.onPrepared?.(record)
    } })))
  } finally { notifyDocumentCreations() }
}
