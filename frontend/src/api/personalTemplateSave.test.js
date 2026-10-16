import test from 'node:test'
import assert from 'node:assert/strict'
import { createPersonalTemplateSaver } from './personalTemplateSave.js'

const fields = { name: '原模板😀', description: '原说明', category: 'planning' }
const response = { data: { id: 141, sourceRevision: 7 } }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture(post = async () => response) {
  const session = { account: 'owner', token: 'original-token', service: '/api' }
  let identity = session, readable = true, ready = true, active = true
  const calls = []
  const saver = createPersonalTemplateSaver({ docId: 26, readIdentity: () => { if (!readable) throw Error('storage blocked'); return identity },
    canSave: () => ready, isCurrent: () => active, post: (...args) => { calls.push(args); return post(...args) } })
  return { saver, calls, session, identity: value => { identity = value }, readable: value => { readable = value },
    ready: value => { ready = value }, active: value => { active = value } }
}

test('实时同步门禁只阻止首次POST，恢复就绪后可保存，发送捕获令牌与原文档', async () => {
  const f = fixture(); f.ready(false)
  assert.equal(f.saver.ready(), false)
  await assert.rejects(f.saver.save(fields), e => e.reason === 'PERSONAL_TEMPLATE_NOT_READY' && !e.uncertain)
  assert.equal(f.calls.length, 0); assert.equal(f.saver.snapshot().status, 'idle')
  f.ready(true)
  const controller = new AbortController(), result = await f.saver.save(fields, { signal: controller.signal })
  assert.deepEqual(result.data, { id: 141, sourceRevision: 7, name: fields.name })
  assert.deepEqual(f.calls[0], ['/personal-templates', { docId: 26, ...fields }, { signal: controller.signal, copageExpectedSessionToken: 'original-token' }])
  await f.saver.save(fields)
  assert.equal(f.calls.length, 1)
})

test('打开窗口时绑定身份与来源，发送前账号/令牌/服务/来源/存储变化及取消均POST0', async () => {
  for (const mode of ['account', 'token', 'service', 'source', 'storage', 'abort']) {
    const f = fixture(), controller = new AbortController()
    if (['account', 'token', 'service'].includes(mode)) f.identity({ ...f.session, [mode]: 'changed' })
    if (mode === 'source') f.active(false)
    if (mode === 'storage') f.readable(false)
    if (mode === 'abort') controller.abort()
    await assert.rejects(f.saver.save(fields, { signal: controller.signal }), e => e.name === 'AbortError')
    assert.equal(f.calls.length, 0)
  }
  const saver = createPersonalTemplateSaver({ docId: 26, readIdentity: () => { throw Error('unreadable on opening') }, post: () => assert.fail('禁止请求') })
  assert.equal(saver.ready(), false)
  await assert.rejects(saver.save(fields), e => e.name === 'AbortError')
})

test('同步检查异常保守拒绝，输入缺字段或超限不发送', async () => {
  const saver = createPersonalTemplateSaver({ docId: 26, readIdentity: () => ({ account: 'a', token: 't', service: '/api' }),
    canSave: () => { throw Error('editor unavailable') }, post: () => assert.fail('禁止请求') })
  assert.equal(saver.ready(), false)
  await assert.rejects(saver.save(fields), e => e.reason === 'PERSONAL_TEMPLATE_NOT_READY')
  const f = fixture()
  for (const input of [null, [], {}, { ...fields, name: ' ' }, { ...fields, name: '名'.repeat(201) },
    { ...fields, description: '介'.repeat(301) }, { ...fields, category: 'unknown' }, { ...fields, content: '不传正文' }]) {
    await assert.rejects(f.saver.save(input), e => e.reason === 'PERSONAL_TEMPLATE_INPUT')
  }
  assert.equal(f.calls.length, 0)
})

test('快速重复操作只发一个POST，输入在请求前冻结；来源后来未就绪不倒推已保存结果', async () => {
  const wait = deferred(), started = deferred(), f = fixture(() => { started.resolve(); return wait.promise })
  const mutable = { ...fields }, attempt = f.saver.save(mutable)
  mutable.name = '修改'; mutable.description = '修改'
  await started.promise
  await assert.rejects(f.saver.save(fields), e => e.reason === 'PERSONAL_TEMPLATE_BUSY')
  f.ready(false); wait.resolve(response)
  assert.deepEqual((await attempt).data, { id: 141, sourceRevision: 7, name: fields.name })
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0][1], { docId: 26, ...fields })
  assert.equal(Object.isFrozen(f.calls[0][1]), true)
})

test('明确400/401/403/404拒绝允许修正，不把拒绝伪装成未知', async () => {
  for (const code of [400, 401, 403, 404]) {
    let reject = true; const f = fixture(async () => { if (reject) throw { code, message: '拒绝' }; return response })
    await assert.rejects(f.saver.save(fields), e => e.code === code && e.uncertain === false)
    assert.equal(f.saver.snapshot().status, 'idle')
    reject = false
    assert.equal((await f.saver.save(fields)).data.id, 141)
  }
})

test('网络错误与5xx是未知终态，恢复ready、改资料或再次点击都不自动POST', async () => {
  for (const error of [Error('lost after commit'), { code: 503 }, Object.freeze({ code: 503, message: '冻结错误' }), null]) {
    const f = fixture(async () => { throw error })
    await assert.rejects(f.saver.save(fields), e => e.uncertain === true)
    f.ready(false); f.ready(true)
    await assert.rejects(f.saver.save({ ...fields, name: '另一个名字' }), e => e.reason === 'PERSONAL_TEMPLATE_UNCERTAIN')
    assert.equal(f.calls.length, 1); assert.equal(f.saver.snapshot().status, 'uncertain')
  }
})

test('坏200严格检查id/sourceRevision，不交给成功回调且不会再保存', async () => {
  for (const data of [undefined, {}, { id: 0, sourceRevision: 7 }, { id: '141', sourceRevision: 7 },
    { id: Number.MAX_SAFE_INTEGER + 1, sourceRevision: 7 }, { id: 141, sourceRevision: -1 },
    { id: 141, sourceRevision: '7' }, { id: 141, sourceRevision: 1.5 }, { id: 141, sourceRevision: null }]) {
    const f = fixture(async () => ({ data })); let callbacks = 0
    await assert.rejects(f.saver.save(fields, { onSaved: () => { callbacks++ } }), e => e.reason === 'PERSONAL_TEMPLATE_RESPONSE' && e.uncertain)
    await assert.rejects(f.saver.save(fields), e => e.reason === 'PERSONAL_TEMPLATE_UNCERTAIN')
    assert.equal(callbacks, 0); assert.equal(f.calls.length, 1)
  }
  const f = fixture(async () => ({ data: { id: 141, sourceRevision: 0 } }))
  assert.equal((await f.saver.save(fields)).data.sourceRevision, 0)
})

test('迟到200在账号/令牌/服务/来源/身份存储/取消后不触发父成功回调', async () => {
  for (const mode of ['account', 'token', 'service', 'source', 'storage', 'abort']) {
    const wait = deferred(), started = deferred(), f = fixture(() => { started.resolve(); return wait.promise })
    let callbacks = 0; const controller = new AbortController()
    const attempt = f.saver.save(fields, { signal: controller.signal, onSaved: () => { callbacks++ } })
    await started.promise
    if (['account', 'token', 'service'].includes(mode)) f.identity({ ...f.session, [mode]: 'changed' })
    if (mode === 'source') f.active(false)
    if (mode === 'storage') f.readable(false)
    if (mode === 'abort') controller.abort()
    wait.resolve(response)
    await assert.rejects(attempt, e => e.name === 'AbortError')
    assert.equal(callbacks, 0); assert.equal(f.calls.length, 1); assert.equal(f.saver.snapshot().status, 'uncertain')
  }
})

test('成功先接受；同步/异步父回调失败或成功提示破坏身份读取都不变成未知或再POST', async () => {
  for (const mode of ['throw', 'reject', 'storage']) {
    const f = fixture(), callbackError = Error('navigation failed')
    const result = await f.saver.save(fields, { onSaved: data => {
      assert.equal(data.id, 141); assert.equal(f.saver.snapshot().status, 'confirmed')
      if (mode === 'storage') f.readable(false)
      if (mode === 'reject') return Promise.reject(callbackError)
      throw callbackError
    } })
    assert.equal(result.data.id, 141); assert.equal(result.callbackError, callbackError)
    assert.equal(f.saver.snapshot().status, 'confirmed')
    f.readable(true)
    assert.equal((await f.saver.save(fields)).data.id, 141)
    assert.equal(f.calls.length, 1)
    f.identity({ ...f.session, account: 'other' })
    await assert.rejects(f.saver.save(fields), e => e.name === 'AbortError')
    assert.equal(f.saver.snapshot().status, 'confirmed')
  }
})
