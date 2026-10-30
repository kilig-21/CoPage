const changed = () => Object.assign(new Error('登录状态已更改，请重新登录后核对小组资料；原资料和本地草稿仍保留。'),
  { reason: 'GROUP_SESSION_CHANGED' })
const unavailable = () => Object.assign(new Error('暂时无法核对浏览器中的登录状态，请恢复本站存储后重新登录；原资料和本地草稿仍保留。'),
  { reason: 'GROUP_SESSION_UNAVAILABLE' })

export function isGroupSessionFailure(failure) {
  return ['GROUP_SESSION_CHANGED', 'GROUP_SESSION_UNAVAILABLE'].includes(failure?.reason)
}

// 一次页面读取会话只认最初身份；刷新列表、切换小组或重试不能改绑另一账号。
export function createGroupSession({ readIdentity }) {
  function read() {
    let value
    try {
      const current = readIdentity()
      value = { account: current?.account, token: current?.token, service: current?.service }
    } catch { throw unavailable() }
    if (!Object.values(value).every(item => typeof item === 'string' && item)) throw changed()
    return value
  }
  const identity = Object.freeze(read())
  function assertCurrent(signal) {
    if (signal?.aborted) throw new DOMException('小组页面请求已取消', 'AbortError')
    const current = read()
    if (['account', 'token', 'service'].some(key => current[key] !== identity[key])) throw changed()
  }
  async function run(signal, send) {
    assertCurrent(signal)
    let response
    try {
      response = await send({ signal, copageExpectedSessionToken: identity.token })
    } catch (failure) {
      assertCurrent(signal)
      throw failure
    }
    assertCurrent(signal)
    return response
  }
  return {
    identity,
    assertCurrent,
    isCurrent: () => { try { assertCurrent(); return true } catch { return false } },
    run,
  }
}
