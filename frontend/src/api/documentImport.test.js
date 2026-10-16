import test from 'node:test'
import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { createDocumentImporter } from './documentImport.js'

const originalFile = () => new File(['原正文中文😀\n'], '原备份.txt', { type: 'text/plain' })
const input = () => ({ file: originalFile(), title: '  原导入标题😀  ' })
const response = { data: { id: 527, title: '原导入标题😀' } }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture(create = async () => response) {
  const session = { account: 'owner', token: 'original-token', service: '/api' }
  let identity = session, readable = true, active = true
  const calls = []
  const importer = createDocumentImporter({ create: (...args) => { calls.push(args); return create(...args) },
    readIdentity: () => { if (!readable) throw Error('storage blocked'); return identity }, isCurrent: () => active })
  return { importer, calls, session, identity: value => { identity = value }, readable: value => { readable = value }, active: value => { active = value } }
}

test('丢回复后换文件或标题仍确认原文件字节/名称/实际标题，确认成功后不再POST', async () => {
  let lose = true
  const f = fixture(async () => { if (lose) { lose = false; throw Error('committed but reply lost') } return response })
  await assert.rejects(f.importer.submit(input()), e => e.uncertain)
  assert.deepEqual(f.importer.getSnapshot(), { status: 'uncertain', filename: '原备份.txt', title: '原导入标题😀' })
  const changed = { file: new File(['新正文'], '另一个.txt'), title: '另一个标题' }
  const result = await f.importer.submit(changed)
  for (const [path, body, config] of f.calls) {
    assert.equal(path, '/doc/import'); assert.equal(body.get('title'), '原导入标题😀')
    assert.equal(body.get('file').name, '原备份.txt'); assert.equal(await body.get('file').text(), '原正文中文😀\n')
    assert.equal(config.copageExpectedSessionToken, f.session.token)
  }
  assert.equal(f.calls.length, 2); assert.equal(result.data.id, 527)
  assert.equal(f.calls[0][2].preserveRejectedTracking, true)
  assert.equal(f.calls[1][2].preserveRejectedTracking, true)
  // 调用方处理导航失败后再次取得结果，仍只能读取已确认缓存。
  await assert.rejects((async () => { await f.importer.submit(changed); throw Error('navigation failed') })(), /navigation failed/)
  assert.equal(await f.importer.submit(changed), result)
  assert.equal(f.calls.length, 2); assert.equal(f.importer.getSnapshot().status, 'confirmed')
  assert.throws(() => { result.data.id = 1 }, TypeError)
})

test('未知后的无效UI输入也不替换原目标，空白标题保持实际省略', async () => {
  let calls = 0; const f = fixture(async () => { if (++calls === 1) throw { code: 503 }; return response })
  await assert.rejects(f.importer.submit({ file: originalFile(), title: '   ' }))
  await f.importer.submit(null)
  assert.equal(f.calls[0][1].has('title'), false); assert.equal(f.calls[1][1].has('title'), false)
  assert.equal(f.importer.getSnapshot().title, '')
})

test('首次明确400/403/404拒绝释放原目标，允许用户修正文件和标题', async () => {
  for (const code of [400, 403, 404]) {
    let reject = true; const f = fixture(async () => { if (reject) throw Object.freeze({ code, message: '明确拒绝' }); return response })
    await assert.rejects(f.importer.submit(input()), e => e.code === code && !e.uncertain)
    assert.deepEqual(f.importer.getSnapshot(), { status: 'idle', filename: '', title: '' })
    reject = false
    await f.importer.submit({ file: new File(['修正内容'], '修正.txt'), title: '修正' })
    assert.equal(f.calls[1][1].get('file').name, '修正.txt'); assert.equal(f.calls[1][1].get('title'), '修正')
  }
})

test('未知后明确拒绝或身份读取失败仍保留原未知事实和原目标', async () => {
  for (const code of [400, 401, 403, 404]) {
    let phase = 0; const f = fixture(async () => { if (++phase === 1) throw Error('lost'); throw { code, message: '当前拒绝' } })
    await assert.rejects(f.importer.submit(input()), e => e.uncertain)
    await assert.rejects(f.importer.submit({}), e => e.code === code && e.uncertain)
    assert.equal(f.calls[1][2].preserveRejectedTracking, true)
    f.readable(false)
    await assert.rejects(f.importer.submit(null), e => e.name === 'AbortError' && e.uncertain)
    assert.equal(f.calls.length, 2)
    assert.deepEqual(f.importer.getSnapshot(), { status: 'uncertain', filename: '原备份.txt', title: '原导入标题😀' })
  }
})

test('重建窗口首次确认遇403但委托层发现原槽，仍冻结原文件供后续确认', async () => {
  let first = true
  const f = fixture(async () => {
    if (first) { first = false; throw Object.freeze({ code: 403, uncertain: true, message: '原导入仍未确认' }) }
    return response
  })
  await assert.rejects(f.importer.submit(input()), e => e.code === 403 && e.uncertain)
  assert.deepEqual(f.importer.getSnapshot(), { status: 'uncertain', filename: '原备份.txt', title: '原导入标题😀' })
  await f.importer.submit({ file: new File(['不得替换'], '其他.txt'), title: '其他' })
  assert.ok(f.calls.every(([, , config]) => config.preserveRejectedTracking === true))
  assert.equal(f.calls[1][1].get('title'), '原导入标题😀')
  assert.equal(f.calls[1][1].get('file').name, '原备份.txt')
  assert.equal(await f.calls[1][1].get('file').text(), '原正文中文😀\n')
  assert.equal(f.importer.getSnapshot().status, 'confirmed')
})

test('捕获账号/令牌/服务，发送前身份/来源/取消变化不发送', async () => {
  for (const mode of ['account', 'token', 'service', 'source', 'storage', 'abort']) {
    const f = fixture(), controller = new AbortController()
    if (['account', 'token', 'service'].includes(mode)) f.identity({ ...f.session, [mode]: 'changed' })
    if (mode === 'source') f.active(false)
    if (mode === 'storage') f.readable(false)
    if (mode === 'abort') controller.abort()
    await assert.rejects(f.importer.submit(input(), { signal: controller.signal }), e => e.name === 'AbortError' && !e.uncertain)
    assert.equal(f.calls.length, 0); assert.equal(f.importer.getSnapshot().status, 'idle')
  }
  const importer = createDocumentImporter({ readIdentity: () => { throw Error('unavailable on opening') }, create: () => assert.fail('禁止请求') })
  await assert.rejects(importer.submit(input()), e => e.name === 'AbortError')
})

test('单飞保护且首次输入对象后来变化不改已冻结请求', async () => {
  const wait = deferred(), f = fixture(() => wait.promise), mutable = input()
  const attempt = f.importer.submit(mutable)
  mutable.file = new File(['后来内容'], '后来.txt'); mutable.title = '后来'
  await assert.rejects(f.importer.submit(mutable), e => e.reason === 'DOCUMENT_IMPORT_BUSY')
  assert.equal(f.calls.length, 1); assert.equal(f.importer.getSnapshot().status, 'importing')
  assert.equal(await f.calls[0][1].get('file').text(), '原正文中文😀\n')
  wait.resolve(response); await attempt
})

test('迟到成功在取消/卸载来源/账号/令牌/服务/存储改变后保留未知且不接受成功', async () => {
  for (const mode of ['account', 'token', 'service', 'source', 'storage', 'abort']) {
    const wait = deferred(), f = fixture(() => wait.promise), controller = new AbortController()
    const attempt = f.importer.submit(input(), { signal: controller.signal })
    if (['account', 'token', 'service'].includes(mode)) f.identity({ ...f.session, [mode]: 'changed' })
    if (mode === 'source') f.active(false)
    if (mode === 'storage') f.readable(false)
    if (mode === 'abort') controller.abort()
    wait.resolve(response)
    await assert.rejects(attempt, e => e.name === 'AbortError' && e.uncertain)
    assert.equal(f.importer.getSnapshot().status, 'uncertain')
    assert.equal(f.importer.getSnapshot().filename, '原备份.txt')
    assert.equal(f.calls.length, 1)
  }
})

test('首次401与坏200不能确认成功，保留原文件用于明确重试', async () => {
  for (const value of [null, { data: {} }, ...[0, -1, 1.5, '527', true, Number.MAX_SAFE_INTEGER + 1].map(id => ({ data: { id } }))]) {
    let first = true; const f = fixture(async () => { if (first) { first = false; return value } return response })
    await assert.rejects(f.importer.submit(input()), e => e.reason === 'DOCUMENT_IMPORT_RESPONSE' && e.uncertain)
    assert.equal(f.importer.getSnapshot().status, 'uncertain')
    await f.importer.submit(null)
    assert.equal(f.calls.length, 2)
  }
  const f = fixture(async () => { throw { code: 401 } })
  await assert.rejects(f.importer.submit(input()), e => e.code === 401 && e.uncertain)
  assert.equal(f.importer.getSnapshot().filename, '原备份.txt')
})

test('确认后再变身份或预取消不泄露原结果，恢复原身份只返回缓存', async () => {
  const f = fixture(), result = await f.importer.submit(input())
  f.identity({ ...f.session, account: 'other' })
  await assert.rejects(f.importer.submit(null), e => e.name === 'AbortError')
  f.identity(f.session)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(f.importer.submit(null, { signal: controller.signal }), e => e.name === 'AbortError')
  assert.equal(f.importer.getSnapshot().status, 'confirmed')
  assert.equal(await f.importer.submit(null), result); assert.equal(f.calls.length, 1)
})

test('无效首次输入不发送且不留文件快照，快照仅返回状态/文件名/标题', async () => {
  const f = fixture()
  for (const value of [null, {}, { ...input(), extra: true }, { ...input(), title: null }, { ...input(), title: '题'.repeat(201) },
    { file: new File([], '空.txt'), title: '' }, { file: new File(['bad'], '程序.exe'), title: '' },
    { file: new File([new Uint8Array(3 * 1024 * 1024 + 1)], '大.txt'), title: '' }]) {
    await assert.rejects(f.importer.submit(value), e => e.reason === 'DOCUMENT_IMPORT_INPUT' && !e.uncertain)
    assert.deepEqual(f.importer.getSnapshot(), { status: 'idle', filename: '', title: '' })
  }
  assert.equal(f.calls.length, 0)
  await f.importer.submit(input())
  const snapshot = f.importer.getSnapshot(); snapshot.title = '外部修改'
  assert.deepEqual(Object.keys(snapshot).sort(), ['filename', 'status', 'title'])
  assert.equal(f.importer.getSnapshot().title, '原导入标题😀')
})
