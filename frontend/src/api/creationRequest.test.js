import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { createDocumentCreator } from './creationRequest.js'
import { createDocumentImporter } from './documentImport.js'

test('关闭导入窗口后重选原文件，拒绝不丢原UUID；原窗口重建后仍确认唯一文档', async () => {
  const calls = []; let attempt = 0
  const f = fixture(async (_, body, config) => {
    calls.push({ id: config.headers['Idempotency-Key'], filename: body.get('file').name, text: await body.get('file').text(), title: body.get('title') })
    if (++attempt === 1) throw { code: 503 }
    if (attempt === 2) throw { code: 403 }
    return { data: { id: 528 } }
  })
  const make = create => createDocumentImporter({ readIdentity: () => ({ account: 'owner', token: 'local-test-token', service: '/api' }),
    create: (path, body, config) => create(path, body, { ...config, ...f.options }) })
  const input = () => ({ file: new File(['原文件字节😀'], '原备份.txt'), title: ' 原导入标题 ' })
  await assert.rejects(make(f.create).submit(input()))
  const reopened = make(f.reload())
  await assert.rejects(reopened.submit(input()))
  assert.equal(reopened.getSnapshot().status, 'uncertain')
  assert.equal(f.values.size, 2)
  const result = await reopened.submit({ file: new File(['不该发送'], '其它.txt'), title: '其它标题' })
  assert.equal(result.data.id, 528)
  assert.equal(new Set(calls.map(call => call.id)).size, 1)
  assert.ok(calls.every(call => call.filename === '原备份.txt' && call.text === '原文件字节😀' && call.title === '原导入标题'))
  assert.deepEqual([...f.values], [['collab-draft:owner:26', '原草稿']])
})

test('导入首次明确拒绝且没有旧tracking时仍清理，修正后的独立尝试不受影响', async () => {
  const f = fixture(async () => { throw { code: 400 } })
  const body = new FormData(); body.append('file', new Blob(['原正文']), '导入.txt')
  await assert.rejects(f.create('/doc/import', body, { ...f.options, preserveRejectedTracking: true }))
  assert.deepEqual([...f.values], [['collab-draft:owner:26', '原草稿']])
})

test('导入已未知后核对遇到拒绝仍保留原UUID，不泄漏保留选项到HTTP层', async () => {
  const calls = []; let attempt = 0
  const f = fixture(async (path, body, config) => {
    calls.push({ path, id: config.headers['Idempotency-Key'], preserveOptionSent: Object.hasOwn(config, 'preserveRejectedTracking') })
    if (++attempt === 1) throw { code: 503 }
    if (attempt === 2) throw { code: 403 }
    return { data: { id: 527 } }
  })
  const form = () => {
    const body = new FormData(); body.append('file', new Blob(['原文件正文']), '原文件.txt'); body.append('title', '原始标题'); return body
  }
  await assert.rejects(f.create('/doc/import', form(), f.options))
  await assert.rejects(f.create('/doc/import', form(), { ...f.options, preserveRejectedTracking: true }))
  assert.equal(f.values.size, 2)
  const result = await f.reload()('/doc/import', form(), { ...f.options, preserveRejectedTracking: true })
  assert.equal(result.data.id, 527)
  assert.equal(new Set(calls.map(call => call.id)).size, 1)
  assert.ok(calls.every(call => !call.preserveOptionSent))
  assert.deepEqual([...f.values], [['collab-draft:owner:26', '原草稿']])
})

function fixture(post) {
  const values = new Map([['collab-draft:owner:26', '原草稿']])
  let sequence = 0
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  const crypto = { subtle: webcrypto.subtle, randomUUID: () => '00000000-0000-4000-8000-' + String(++sequence).padStart(12, '0') }
  const dependencies = { getStorage: () => storage, crypto, post }
  return { values, storage, create: createDocumentCreator(dependencies), reload: () => createDocumentCreator(dependencies), options: { account: 'owner', service: '/api' } }
}

test('丢回复、重新准备和成功后再次创建分别使用原标识与新标识，不改草稿', async () => {
  const ids = []; let failed = true
  const f = fixture(async (_, __, config) => { ids.push(config.headers['Idempotency-Key']); if (failed) throw new Error('lost reply'); return { data: { id: 41 } } })
  await assert.rejects(f.create('/doc', { title: '中文😀' }, f.options))
  failed = false
  await f.create('/doc', { title: '中文😀' }, f.options)
  await f.create('/doc', { title: '中文😀' }, f.options)
  assert.equal(ids[0], ids[1]); assert.notEqual(ids[1], ids[2])
  assert.deepEqual([...f.values], [['collab-draft:owner:26', '原草稿']])
})

test('同一内容的字段顺序不改变标识；账号、后端、来源和标题分别隔离', async () => {
  const ids = []; const f = fixture(async (_, __, c) => { ids.push(c.headers['Idempotency-Key']); throw new Error('unknown') })
  for (const [path, body, options] of [
    ['/doc/1/copy', { title: '资料', extra: 1 }, f.options], ['/doc/1/copy', { extra: 1, title: '资料' }, f.options],
    ['/doc/2/copy', { title: '资料', extra: 1 }, f.options], ['/doc/1/copy', { title: '新资料', extra: 1 }, f.options],
    ['/doc/1/copy', { title: '资料', extra: 1 }, { ...f.options, account: 'peer' }],
    ['/doc/1/copy', { title: '资料', extra: 1 }, { ...f.options, service: 'https://other.example/api' }],
  ]) await assert.rejects(f.create(path, body, options))
  assert.equal(ids[0], ids[1]); assert.equal(new Set(ids).size, 5)
  assert.ok([...f.values.values()].every(v => v === '原草稿' || /^[\da-f-]{36}$/i.test(v)))
})

test('导入重新选择同名同字节文件沿用标识，不同字节或文件名使用新标识', async () => {
  const ids = []; const f = fixture(async (_, __, c) => { ids.push(c.headers['Idempotency-Key']); throw new Error('unknown') })
  for (const [name, text] of [['资料.txt', '中文😀'], ['资料.txt', '中文😀'], ['资料.txt', '不同'], ['另一份.txt', '中文😀']]) {
    const form = new FormData(); form.append('file', new Blob([text]), name); form.append('title', '导入资料')
    await assert.rejects(f.create('/doc/import', form, f.options))
  }
  assert.equal(ids[0], ids[1]); assert.equal(new Set(ids).size, 3)
})

test('无法读取或保存重试标识时不发送创建，也不删除已有记录', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return {} })
  for (const method of ['getItem', 'setItem']) {
    const original = f.storage[method]; f.storage[method] = () => { throw new Error('denied') }
    await assert.rejects(f.create('/doc', { title: '资料' }, f.options), e => e.code === 400)
    f.storage[method] = original
  }
  assert.equal(calls, 0); assert.equal(f.values.get('collab-draft:owner:26'), '原草稿')
})

test('成功后清理失败明确反馈，继续失败时阻止再次发送；恢复后可创建新文档', async () => {
  let calls = 0; const ids = []; const f = fixture(async (_, __, c) => { calls++; ids.push(c.headers['Idempotency-Key']); return { data: { id: 41 } } })
  const remove = f.storage.removeItem; f.storage.removeItem = () => { throw new Error('denied') }
  const result = await f.create('/doc', { title: '资料' }, f.options)
  assert.equal(result.data.id, 41); assert.match(result.creationTrackingWarning, /文档已创建/)
  await assert.rejects(f.create('/doc', { title: '资料' }, f.options), e => e.code === 400 && /上一篇文档已创建/.test(e.message))
  assert.equal(calls, 1)
  f.storage.removeItem = remove; await f.create('/doc', { title: '资料' }, f.options)
  assert.equal(calls, 2); assert.notEqual(ids[0], ids[1])
})

test('取消或账号切换后的迟到成功不释放原账号标识，下一次仍能确认原请求', async () => {
  const ids = []; let current = true
  const f = fixture(async (_, __, c) => { ids.push(c.headers['Idempotency-Key']); current = false; return { data: { id: 41 } } })
  await assert.rejects(f.create('/doc', { title: '资料' }, { ...f.options, isCurrent: () => current }), e => e.name === 'AbortError')
  current = true; await f.create('/doc', { title: '资料' }, f.options)
  assert.equal(ids[0], ids[1])
})

test('明确业务拒绝允许新尝试，未知故障保留同一标识；预先取消不发送', async () => {
  const ids = []; let code = 400; const f = fixture(async (_, __, c) => { ids.push(c.headers['Idempotency-Key']); throw { code } })
  await assert.rejects(f.create('/doc', { title: '资料' }, f.options)); code = 503
  await assert.rejects(f.create('/doc', { title: '资料' }, f.options))
  await assert.rejects(f.create('/doc', { title: '资料' }, f.options))
  assert.notEqual(ids[0], ids[1]); assert.equal(ids[1], ids[2])
  const controller = new AbortController(); controller.abort()
  await assert.rejects(f.create('/doc', { title: '其他' }, { ...f.options, signal: controller.signal }), e => e.name === 'AbortError')
  assert.equal(ids.length, 3)
})

test('页面重建沿用未确认标识；回复后账号存储拒绝不释放原记录', async () => {
  const ids = []; let failed = true
  const f = fixture(async (_, __, config) => {
    ids.push(config.headers['Idempotency-Key'])
    if (failed) throw new Error('lost reply')
    return { data: { id: 41 } }
  })
  await assert.rejects(f.create('/doc', { title: '资料' }, f.options))
  failed = false
  let checks = 0
  await assert.rejects(f.reload()('/doc', { title: '资料' }, { ...f.options, isCurrent: () => {
    if (++checks > 1) throw new Error('storage denied')
    return true
  } }), e => e.name === 'AbortError')
  await f.reload()('/doc', { title: '资料' }, f.options)
  assert.equal(new Set(ids).size, 1)
  assert.deepEqual([...f.values], [['collab-draft:owner:26', '原草稿']])
})

test('私人实例跨刷新及模板版本改变仍确认原请求；成功后的新建采用当前版本', async () => {
  const requests = []; let failed = true
  const f = fixture(async (_, body, config) => {
    requests.push({ id: config.headers['Idempotency-Key'], body: structuredClone(body) })
    if (failed) throw new Error('lost reply')
    return { data: { id: 41 } }
  })
  await assert.rejects(f.create('/personal-templates/12/documents', { title: '实例😀', expectedVersion: 1 }, f.options))
  const record = JSON.parse([...f.values].find(([key]) => key.startsWith('copage-create:'))[1])
  assert.deepEqual(Object.keys(record).sort(), ['expectedVersion', 'requestId'])
  failed = false
  const reloaded = f.reload()
  await reloaded('/personal-templates/12/documents', { title: '实例😀', expectedVersion: 2 }, f.options)
  await reloaded('/personal-templates/12/documents', { title: '实例😀', expectedVersion: 2 }, f.options)
  assert.equal(requests[0].id, requests[1].id); assert.notEqual(requests[1].id, requests[2].id)
  assert.deepEqual(requests.map(value => value.body.expectedVersion), [1, 1, 2])
  assert.deepEqual([...f.values], [['collab-draft:owner:26', '原草稿']])
})

test('损坏的私人创建版本原样保留，不发送替代请求或清除草稿', async () => {
  let calls = 0
  const f = fixture(async () => { calls++; throw new Error('lost reply') })
  await assert.rejects(f.create('/personal-templates/12/documents', { title: '实例', expectedVersion: 1 }, f.options))
  const key = [...f.values.keys()].find(value => value.startsWith('copage-create:'))
  for (const raw of ['broken-json', JSON.stringify({ requestId: '00000000-0000-4000-8000-000000000001', expectedVersion: 0 })]) {
    f.values.set(key, raw)
    await assert.rejects(f.reload()('/personal-templates/12/documents', { title: '实例', expectedVersion: 2 }, f.options), e => e.code === 400)
    assert.equal(f.values.get(key), raw)
  }
  assert.equal(calls, 1); assert.equal(f.values.get('collab-draft:owner:26'), '原草稿')
})

for (const path of ['/doc', '/personal-templates/12/documents']) {
  test(`已提交丢回复后401与重登仍确认原文档：${path}`, async () => {
    const receipts = new Map(), requests = []; let step = 0
    const f = fixture(async (_, body, config) => {
      const id = config.headers['Idempotency-Key']; requests.push({ id, body })
      if (step++ === 1) throw { code: 401 }
      if (!receipts.has(id)) receipts.set(id, { data: { id: 41 + receipts.size } })
      if (step === 1) throw new Error('committed but reply lost')
      return receipts.get(id)
    })
    const original = { title: '资料', ...(path.includes('personal-templates') ? { expectedVersion: 1 } : {}) }
    await assert.rejects(f.create(path, original, f.options))
    await assert.rejects(f.reload()(path, original, f.options), error => error.code === 401)
    const afterLogin = { ...original, ...(path.includes('personal-templates') ? { expectedVersion: 2 } : {}) }
    const result = await f.reload()(path, afterLogin, f.options)
    assert.equal(result.data.id, 41)
    assert.equal(receipts.size, 1)
    assert.equal(new Set(requests.map(r => r.id)).size, 1)
    if (path.includes('personal-templates')) assert.deepEqual(requests.map(r => r.body.expectedVersion), [1, 1, 1])
    assert.deepEqual([...f.values], [['collab-draft:owner:26', '原草稿']])
  })
}

for (const path of ['/doc', '/doc/import', '/personal-templates/12/documents']) {
  test(`已提交但回复编号损坏，刷新助手后仍按原UUID确认唯一文档：${path}`, async () => {
    const receipts = new Map(), requests = []
    const fileText = JSON.stringify({ format: 'copage', version: 1, title: '备份😀',
      content: { ops: [{ insert: '原内容中文😀\\\"\n', attributes: { bold: true } }, { insert: '\n' }] } })
    const input = version => {
      if (path === '/doc/import') {
        const form = new FormData()
        form.append('file', new Blob([fileText]), '原备份.copage.json'); form.append('title', '原导入标题😀')
        return form
      }
      return { title: '原文档😀', ...(path.includes('personal-templates') ? { expectedVersion: version } : {}) }
    }
    const f = fixture(async (requestPath, body, config) => {
      const uuid = config.headers['Idempotency-Key']
      const payload = body instanceof FormData ? { title: body.get('title'), filename: body.get('file').name,
        text: await body.get('file').text() } : structuredClone(body)
      requests.push({ path: requestPath, uuid, payload })
      // 模拟已提交的服务端收据；坏下游回复不能让客户端生成第二个UUID。
      if (!receipts.has(uuid)) receipts.set(uuid, { data: { id: 41 + receipts.size } })
      if (requests.length === 1) return { code: 0, data: {} }
      return receipts.get(uuid)
    })
    await assert.rejects(f.create(path, input(1), f.options), error => error.code === 500 &&
      error.reason === 'DOCUMENT_CREATION_RESPONSE' && /原创建标识保留/.test(error.message))
    const pending = [...f.values].filter(([key]) => key.startsWith('copage-create:'))
    assert.equal(pending.length, 1)
    assert.equal(f.values.get('collab-draft:owner:26'), '原草稿')
    if (path.includes('personal-templates')) {
      assert.deepEqual(JSON.parse(pending[0][1]), { requestId: requests[0].uuid, expectedVersion: 1 })
    } else assert.equal(pending[0][1], requests[0].uuid)
    const confirmed = await f.reload()(path, input(2), f.options)
    assert.equal(confirmed.data.id, 41); assert.equal(receipts.size, 1)
    assert.deepEqual(requests[1], requests[0])
    if (path === '/doc/import') assert.deepEqual(requests[1].payload,
      { title: '原导入标题😀', filename: '原备份.copage.json', text: fileText })
    assert.deepEqual([...f.values], [['collab-draft:owner:26', '原草稿']])
  })
}

test('只有正安全整数编号可确认；缺失、非数字、非整数、溢出编号均保留原记录', async () => {
  const invalid = [undefined, null, {}, { data: null }, { data: {} }, ...[0, -1, 1.5, '41', true,
    Number.MAX_SAFE_INTEGER + 1, Infinity, NaN].map(id => ({ data: { id } }))]
  for (const result of invalid) {
    let removes = 0
    const f = fixture(async () => result)
    f.storage.removeItem = () => { removes++ }
    await assert.rejects(f.create('/doc', { title: '原内容' }, f.options), error => error.code === 500 &&
      error.reason === 'DOCUMENT_CREATION_RESPONSE')
    assert.equal(removes, 0)
    assert.equal([...f.values.keys()].filter(key => key.startsWith('copage-create:')).length, 1)
    assert.equal(f.values.get('collab-draft:owner:26'), '原草稿')
  }
})

test('坏回复仍先遵守取消与身份失效门禁，不清原请求或用错误编号确认', async () => {
  for (const mode of ['abort', 'identity']) {
    const controller = new AbortController(); let current = true
    const f = fixture(async () => {
      if (mode === 'abort') controller.abort(); else current = false
      return { data: { id: 0 } }
    })
    await assert.rejects(f.create('/doc', { title: '原内容' }, { ...f.options, signal: controller.signal,
      isCurrent: () => current }), error => error.name === 'AbortError')
    assert.equal([...f.values.keys()].filter(key => key.startsWith('copage-create:')).length, 1)
    assert.equal(f.values.get('collab-draft:owner:26'), '原草稿')
  }
})
