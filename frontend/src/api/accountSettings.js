import { captureLoginIdentity } from '../auth/session.js'
import { parseAccountProfile } from '../auth/accountProfile.js'

const changed = () => Object.assign(new Error('登录状态已更改，请重新登录后核对账号资料；本地草稿仍保留。'),
  { reason: 'ACCOUNT_SESSION_CHANGED' })
const unavailable = () => Object.assign(new Error('暂时无法核对浏览器中的登录状态，请恢复本站存储后重新登录；本地草稿仍保留。'),
  { reason: 'ACCOUNT_SESSION_UNAVAILABLE' })

export function isAccountSessionFailure(failure) {
  return ['ACCOUNT_SESSION_CHANGED', 'ACCOUNT_SESSION_UNAVAILABLE'].includes(failure?.reason)
}

// 绑定资料页最初读取时的身份；会话通知尚未到达，也不能借用新账号提交旧表单。
export function createAccountSettings({ storage, get, put, post }) {
  function readIdentity() {
    try { return captureLoginIdentity(storage) } catch { throw unavailable() }
  }
  const identity = readIdentity()
  if (!identity.token || !identity.username) throw changed()
  function assertCurrent(signal) {
    if (signal?.aborted) throw new DOMException('账号资料请求已取消', 'AbortError')
    const current = readIdentity()
    if (current.token !== identity.token || current.username !== identity.username) throw changed()
  }
  async function run(signal, send, verify = value => value) {
    assertCurrent(signal)
    let response
    try {
      response = await send({ signal, copageExpectedSessionToken: identity.token })
    } catch (failure) {
      assertCurrent(signal)
      throw failure
    }
    assertCurrent(signal)
    return verify(response)
  }
  return {
    token: identity.token,
    read: signal => run(signal, config => get('/account/me', config), response => parseAccountProfile(response?.data)),
    saveNickname: (profile, nickname, signal) => run(signal,
      config => put('/account/me', { nickname }, config),
      response => parseAccountProfile(response?.data, { expectedProfile: profile, expectedNickname: nickname })),
    changePassword: (values, signal) => run(signal, config => post('/account/password', values, config)),
  }
}
