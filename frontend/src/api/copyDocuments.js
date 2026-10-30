import { message } from 'antd'
import request from './request'
import { createCopyCreator } from './copyCreation'
import { bindRequestIdentity, readPageIdentity, samePageIdentity } from '../auth/pageSession.js'

const creator = createCopyCreator({ getStorage: () => localStorage, getLegacyStorage: () => sessionStorage, crypto: globalThis.crypto,
  withLock: (name, action, signal) => {
    const locks = globalThis.navigator?.locks
    if (!locks?.request) throw Error('浏览器暂不支持安全保存副本确认，请使用当前版本浏览器。')
    return locks.request(name, { mode: 'exclusive', ...(signal ? { signal } : {}) }, action)
  },
  post: (path, body, config) => request.post(path, body, config) })

function options(config) {
  const read = () => readPageIdentity(localStorage, request.defaults.baseURL)
  const bound = bindRequestIdentity(config, read), identity = bound.identity
  return { ...bound.config, account: identity.account, service: identity.service,
    isCurrent: () => samePageIdentity(identity, read()) }
}
export function notifyCopyChanges() {
  try { window.dispatchEvent(new Event('copage-copy-creations-changed')) }
  catch { /* 通知失败不改变已确认的创建结果；刷新仍可重新读取。 */ }
}
function warnTracking(result) {
  if (!result.creationTrackingWarning) return
  try { message.warning(result.creationTrackingWarning, 10) }
  catch { /* 提示属于辅助展示，不能覆盖已确认结果。 */ }
}
function prepared(config) {
  return options({ ...config, onPrepared: async summary => {
    notifyCopyChanges()
    await config?.onPrepared?.(summary)
  } })
}
function accepted(result) {
  if (typeof result.confirmTracking === 'function') {
    const confirm = result.confirmTracking
    return { ...result, confirmTracking: async () => {
      const response = await confirm()
      notifyCopyChanges()
      warnTracking(response)
      return response
    } }
  }
  notifyCopyChanges()
  warnTracking(result)
  return result
}
export async function createCopy(sourceId, body, config = {}) {
  try { return accepted(await creator.create(sourceId, body, prepared(config))) }
  finally { notifyCopyChanges() }
}
export async function listPendingCopies(config = {}) { return creator.listPending(options(config)) }
export async function confirmCopy(summary, config = {}) {
  try { return accepted(await creator.retry(summary, options(config))) }
  finally { notifyCopyChanges() }
}
