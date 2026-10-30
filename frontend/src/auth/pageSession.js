const valid = value => value && ['account', 'token', 'service'].every(key => typeof value[key] === 'string' && value[key])
const copy = value => valid(value) ? Object.freeze({ account: value.account, token: value.token, service: value.service }) : null
const failure = sent => Object.assign(new Error(sent
  ? '登录状态已变化，原账号操作的结果未在本页确认；请重新登录原账号核对，原记录保留。'
  : '登录状态已变化，本页旧操作尚未发送；请重新登录原账号继续，原输入和记录保留。'),
{ code: sent ? 500 : 400, reason: 'PAGE_SESSION_CHANGED', uncertain: Boolean(sent) })

export function readPageIdentity(storage, service) {
  try { return copy({ account: storage.getItem('collab-user'), token: storage.getItem('collab-token'), service }) }
  catch { return null }
}
export function samePageIdentity(before, after) {
  return Boolean(valid(before) && valid(after) && ['account', 'token', 'service'].every(key => before[key] === after[key]))
}

// API adapters must validate the caller's original identity before preparing local records.
export function bindRequestIdentity(config = {}, readIdentity) {
  let current
  try { current = readIdentity() } catch { throw failure(false) }
  const identity = Object.hasOwn(config, 'expectedIdentity') ? config.expectedIdentity : current
  if (!samePageIdentity(identity, current) || (Object.hasOwn(config, 'copageExpectedSessionToken') && config.copageExpectedSessionToken !== identity.token))
    throw failure(false)
  const { expectedIdentity, ...rest } = config
  return { identity: copy(identity), config: { ...rest, copageExpectedSessionToken: identity.token } }
}

export function createPageSession(readIdentity) {
  let identity
  try { identity = copy(readIdentity()) } catch { identity = null }
  const current = () => { try { return samePageIdentity(identity, readIdentity()) } catch { return false } }
  const assertCurrent = (sent = false) => { if (!current()) throw failure(sent); return identity }
  const options = (config = {}) => {
    assertCurrent()
    if (Object.hasOwn(config, 'expectedIdentity') && !samePageIdentity(config.expectedIdentity, identity)) throw failure(false)
    const bound = bindRequestIdentity({ ...config, expectedIdentity: identity }, readIdentity)
    return { ...bound.config, expectedIdentity: identity }
  }
  return Object.freeze({ identity, current, assertCurrent, options })
}

// Promise rejection is intentional: a lost session must not throw out of a React effect.
export function createPageRequest(client, session) {
  const invoke = async (method, args, configIndex) => {
    const input = args[configIndex] || {}
    if (input.signal?.aborted) throw new DOMException('页面请求已取消', 'AbortError')
    const { expectedIdentity, ...config } = session.options(input)
    const forwarded = [...args]; forwarded[configIndex] = config
    let response
    try { response = await client[method](...forwarded) }
    catch (error) { session.assertCurrent(true); throw error }
    session.assertCurrent(true)
    return response
  }
  const scoped = { defaults: client.defaults }
  for (const method of ['get', 'delete', 'head', 'options']) scoped[method] = (...args) => invoke(method, args, 1)
  for (const method of ['post', 'put', 'patch']) scoped[method] = (...args) => invoke(method, args, 2)
  scoped.request = config => invoke('request', [config], 0)
  return Object.freeze(scoped)
}
