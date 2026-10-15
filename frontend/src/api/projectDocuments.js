import { message } from 'antd'
import request from './request'
import { createProjectDocumentCreator } from './projectDocumentCreation'

const creator = createProjectDocumentCreator({ getStorage: () => localStorage, crypto: globalThis.crypto,
  post: (path, body, config) => request.post(path, body, config) })
export function notifyProjectDocuments() {
  try { window.dispatchEvent(new Event('copage-project-documents-changed')) } catch { /* 原记录仍可刷新读取。 */ }
}
export function projectDocumentIdentity() {
  try { return { account: localStorage.getItem('collab-user'), token: localStorage.getItem('collab-token'), service: request.defaults.baseURL } }
  catch { return null }
}
export function sameProjectDocumentIdentity(before) {
  const next = projectDocumentIdentity()
  return Boolean(before?.account && before.token && next && before.account === next.account && before.token === next.token && before.service === next.service)
}
function options(config) {
  const identity = projectDocumentIdentity()
  if (!identity?.account || !identity.token) throw new Error('请恢复原账号登录信息后继续，原创建记录保留。')
  return { ...config, account: identity.account, service: identity.service,
    copageExpectedSessionToken: identity.token, isCurrent: () => sameProjectDocumentIdentity(identity) }
}
function accepted(result) {
  const notify = value => {
    notifyProjectDocuments()
    if (value.creationTrackingWarning) {
      try { message.warning(value.creationTrackingWarning, 10) } catch { /* 提示失败不改变已确认结果。 */ }
    }
    return value
  }
  return typeof result.confirmTracking === 'function'
    ? { ...result, confirmTracking: () => notify(result.confirmTracking()) } : notify(result)
}
export async function createProjectDocument(input, config = {}) {
  try { return accepted(await creator.create(input, options({ ...config, onPrepared: async record => {
    notifyProjectDocuments(); await config.onPrepared?.(record)
  } }))) } finally { notifyProjectDocuments() }
}
export async function confirmProjectDocument(record, config = {}) {
  try { return accepted(await creator.retry(record, options(config))) }
  finally { notifyProjectDocuments() }
}
export async function listPendingProjectDocuments(config = {}) { return creator.listPending(options(config)) }
