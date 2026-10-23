import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccountSettings, isAccountSessionFailure } from './accountSettings.js'

const profile = { id: 64, username: 'synthetic-A', nickname: '原昵称', avatar: null }
const password = { currentPassword: 'fake-old', newPassword: 'fake-new' }
function fixture() {
  const values = new Map([['collab-token', 'token-A'], ['collab-user', 'synthetic-A'], ['draft:64', 'keep-draft']])
  const calls = [], storage = { getItem: key => values.get(key) ?? null }
  let reply = async (method, body) => ({ data: method === 'put' ? { ...profile, nickname: body.nickname } : profile })
  const send = method => (url, body, config) => {
    if (method === 'get') { config = body; body = undefined }
    calls.push({ method, url, body, config })
    return reply(method, body)
  }
  const settings = createAccountSettings({ storage, get: send('get'), put: send('put'), post: send('post') })
  return { values, calls, storage, settings, setReply: next => { reply = next } }
}
const changed = failure => isAccountSessionFailure(failure) && failure.reason === 'ACCOUNT_SESSION_CHANGED'

test('账号资料正常读取、昵称更新和改密请求均使用最初身份且不写浏览器存储', async () => {
  const f = fixture(), original = new Map(f.values), controller = new AbortController()
  assert.deepEqual(await f.settings.read(controller.signal), profile)
  assert.deepEqual(await f.settings.saveNickname(profile, '新昵称', controller.signal), { ...profile, nickname: '新昵称' })
  await f.settings.changePassword(password, controller.signal)
  assert.deepEqual(f.calls.map(x => [x.method, x.url]), [['get', '/account/me'], ['put', '/account/me'], ['post', '/account/password']])
  for (const call of f.calls) {
    assert.equal(call.config.copageExpectedSessionToken, 'token-A')
    assert.equal(call.config.signal, controller.signal)
  }
  assert.deepEqual(f.values, original)
})

for (const mutation of [
  values => values.set('collab-token', 'token-B'),
  values => values.set('collab-user', 'synthetic-B'),
  values => values.delete('collab-token'),
]) test('身份已变化但通知未处理时，读取/昵称/改密均不发送请求：' + mutation.toString(), async () => {
  const f = fixture(); mutation(f.values)
  const current = new Map(f.values)
  for (const attempt of [() => f.settings.read(), () => f.settings.saveNickname(profile, '新昵称'), () => f.settings.changePassword(password)]) {
    await assert.rejects(attempt, changed)
  }
  assert.equal(f.calls.length, 0)
  assert.deepEqual(f.values, current)
})

test('登录状态不可读时停止全部账号请求，保留现有会话和草稿', async () => {
  const f = fixture(), original = new Map(f.values)
  f.storage.getItem = () => { throw new Error('storage unavailable') }
  for (const attempt of [() => f.settings.read(), () => f.settings.saveNickname(profile, '新昵称'), () => f.settings.changePassword(password)]) {
    await assert.rejects(attempt, { reason: 'ACCOUNT_SESSION_UNAVAILABLE' })
  }
  assert.equal(f.calls.length, 0); assert.deepEqual(f.values, original)
})

for (const operation of ['read', 'saveNickname', 'changePassword']) test(operation + '的旧成功回复不能在身份变化后交付给页面', async () => {
  const f = fixture(); let finish
  f.setReply(() => new Promise(resolve => { finish = resolve }))
  const pending = operation === 'read' ? f.settings.read()
    : operation === 'saveNickname' ? f.settings.saveNickname(profile, '新昵称') : f.settings.changePassword(password)
  assert.equal(f.calls.length, 1)
  f.values.set('collab-token', 'token-B'); f.values.set('collab-user', 'synthetic-B')
  const current = new Map(f.values)
  finish({ data: { ...profile, nickname: '新昵称' } })
  await assert.rejects(pending, changed)
  assert.deepEqual(f.values, current)
  assert.equal(f.calls[0].config.copageExpectedSessionToken, 'token-A')
})

test('旧失败回复不冒充新账号的业务拒绝', async () => {
  const f = fixture(); let fail
  f.setReply(() => new Promise((resolve, reject) => { fail = reject }))
  const pending = f.settings.saveNickname(profile, '新昵称')
  f.values.set('collab-token', 'token-B')
  fail({ code: 400, message: '旧账号业务拒绝' })
  await assert.rejects(pending, changed)
})

test('同一身份的明确业务错误仍保留原对象', async () => {
  const f = fixture(), failure = { code: 400, message: '昵称不符合要求' }
  f.setReply(async () => { throw failure })
  await assert.rejects(f.settings.saveNickname(profile, '新昵称'), value => value === failure)
})

test('回复到达时存储不可读，不确认昵称成功', async () => {
  const f = fixture()
  f.setReply(async () => { f.storage.getItem = () => { throw Error('unavailable') }; return { data: { ...profile, nickname: '新昵称' } } })
  await assert.rejects(f.settings.saveNickname(profile, '新昵称'), { reason: 'ACCOUNT_SESSION_UNAVAILABLE' })
})

test('资料解析继续拒绝错账号及非提交昵称的回复', async () => {
  const f = fixture()
  f.setReply(async () => ({ data: { ...profile, id: 63, nickname: '新昵称' } }))
  await assert.rejects(f.settings.saveNickname(profile, '新昵称'), { reason: 'ACCOUNT_PROFILE_RESPONSE' })
  f.setReply(async () => ({ data: { ...profile, nickname: '不是提交值' } }))
  await assert.rejects(f.settings.saveNickname(profile, '新昵称'), { reason: 'ACCOUNT_PROFILE_RESPONSE' })
})

test('页面取消前不发请求，取消后不交付迟到回复', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort()
  await assert.rejects(f.settings.read(controller.signal), { name: 'AbortError' }); assert.equal(f.calls.length, 0)
  const next = new AbortController(); let finish
  f.setReply(() => new Promise(resolve => { finish = resolve }))
  const pending = f.settings.read(next.signal); next.abort(); finish({ data: profile })
  await assert.rejects(pending, { name: 'AbortError' })
})

test('无法取得完整初始身份时不建立账号操作会话', () => {
  for (const storage of [{ getItem: () => null }, { getItem: () => { throw Error('unavailable') } }]) {
    assert.throws(() => createAccountSettings({ storage }), isAccountSessionFailure)
  }
})
