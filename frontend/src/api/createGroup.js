import request from './request'
import { createGroupCreator } from './groupCreation'

const creator = createGroupCreator({ getStorage: () => localStorage, crypto: globalThis.crypto,
  post: (path, body, config) => request.post(path, body, config) })

export function notifyGroupCreations() {
  try { window.dispatchEvent(new Event('copage-group-creations-changed')) } catch { /* 刷新仍可读取原记录。 */ }
}
function options(config) {
  const { expectedIdentity, ...rest } = config
  let account, token
  try { account = localStorage.getItem('collab-user'); token = localStorage.getItem('collab-token') }
  catch { throw new Error('浏览器暂时无法读取当前账号，原小组创建记录保留。') }
  if (!account || !token) throw new Error('请重新登录原账号后确认小组，原记录保留。')
  const service = request.defaults.baseURL
  if (expectedIdentity && (expectedIdentity.account !== account || expectedIdentity.token !== token || expectedIdentity.service !== service)) {
    throw Object.assign(new Error('登录状态已更改，请重新登录原账号后核对小组；原创建记录保留。'), { reason: 'GROUP_SESSION_CHANGED' })
  }
  return { ...rest, account, service, copageExpectedSessionToken: token,
    isCurrent: () => localStorage.getItem('collab-user') === account && localStorage.getItem('collab-token') === token && request.defaults.baseURL === service }
}
function accepted(result) {
  const notify = value => {
    notifyGroupCreations()
    return value
  }
  return typeof result.confirmTracking === 'function'
    ? { ...result, confirmTracking: () => notify(result.confirmTracking()) } : notify(result)
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
