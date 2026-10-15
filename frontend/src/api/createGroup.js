import { message } from 'antd'
import request from './request'
import { createGroupCreator } from './groupCreation'

const creator = createGroupCreator({ getStorage: () => localStorage, crypto: globalThis.crypto,
  post: (path, body, config) => request.post(path, body, config) })

export function notifyGroupCreations() {
  try { window.dispatchEvent(new Event('copage-group-creations-changed')) } catch { /* 刷新仍可读取原记录。 */ }
}
function options(config) {
  let account, token
  try { account = localStorage.getItem('collab-user'); token = localStorage.getItem('collab-token') }
  catch { throw new Error('浏览器暂时无法读取当前账号，原小组创建记录保留。') }
  if (!account || !token) throw new Error('请重新登录原账号后确认小组，原记录保留。')
  const service = request.defaults.baseURL
  return { ...config, account, service, copageExpectedSessionToken: token,
    isCurrent: () => localStorage.getItem('collab-user') === account && localStorage.getItem('collab-token') === token && request.defaults.baseURL === service }
}
function accepted(result) {
  const warn = value => {
    notifyGroupCreations()
    if (value.creationTrackingWarning) {
      try { message.warning(value.creationTrackingWarning, 10) } catch { /* 提示失败不能改变已确认结果。 */ }
    }
    return value
  }
  return typeof result.confirmTracking === 'function'
    ? { ...result, confirmTracking: () => warn(result.confirmTracking()) } : warn(result)
}
export async function createGroup(body, config = {}) {
  try {
    return accepted(await creator.create(body, options({ ...config, onPrepared: async record => {
      notifyGroupCreations(); await config.onPrepared?.(record)
    } })))
  } finally { notifyGroupCreations() }
}
export async function confirmGroupCreation(record, config = {}) {
  try { return accepted(await creator.retry(record, options(config))) }
  finally { notifyGroupCreations() }
}
export async function listPendingGroupCreations(config = {}) { return creator.listPending(options(config)) }
