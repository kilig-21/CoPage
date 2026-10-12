import assert from 'node:assert/strict'
import test from 'node:test'
import Delta from 'quill-delta'
import CollabClient from '../ws/CollabClient.js'
import { enumerateAccountDrafts, readAccountDraft } from './accountDrafts.js'
import { draftRecordsJson } from './draftRecords.js'
import { draftBackupJson, draftBackupText } from './draftBackup.js'

const now = 1_800_000_000_000
const username = 'testA'
const keyFor = (docId = 217, clientId = 'old-tab', account = username) =>
  `copage-draft:v1:${encodeURIComponent(account)}:${docId}:${clientId}`

function draftFor(docId = 217, clientId = 'old-tab', savedAt = now - 1000, content) {
  const client = new CollabClient({ docId, clientId, Delta })
  client.submit(new Delta().insert('未确认正文', { bold: true }))
  return { ...client.exportDraft(content || new Delta().insert('未确认正文', { bold: true }).insert('\n')), savedAt }
}

function source(entries = []) {
  const values = new Map(entries), reads = [], indexes = []
  const storage = {
    get length() { return values.size },
    key(index) { indexes.push(index); return [...values.keys()][index] ?? null },
    getItem(key) { reads.push(key); return values.get(key) ?? null },
    setItem() { assert.fail('辅助层不能写入草稿') },
    removeItem() { assert.fail('辅助层不能删除草稿') },
  }
  return { values, reads, indexes, storage }
}

const options = storage => ({ storage, username, Delta, now })

test('一次枚举当前账号全部槽位，只返回摘要，不读取近似账号或其他正文', () => {
  const a = draftFor(), b = draftFor(26, 'time-id:non-uuid')
  const f = source([[keyFor(), JSON.stringify(a)], [keyFor(26, b.clientId), JSON.stringify(b)],
    [keyFor(217, 'other', 'testAB'), '别的账号正文'], [keyFor(217, 'other', 'testB'), '别的账号正文'], ['draft-unrelated', '不读取']])
  const summaries = enumerateAccountDrafts(options(f.storage))
  assert.deepEqual(summaries, [{ key: keyFor(), docId: 217, savedAt: now - 1000, readable: true },
    { key: keyFor(26, b.clientId), docId: 26, savedAt: now - 1000, readable: true }])
  assert.deepEqual(f.reads, [keyFor(), keyFor(26, b.clientId)])
  assert.deepEqual(f.indexes, [0, 1, 2, 3, 4])
  assert.ok(!JSON.stringify(summaries).includes('未确认正文'))
})

test('账号中的冒号、中文与百分号按现有编码精确匹配', () => {
  const account = '用户:a%😀', key = keyFor(217, 'not-uuid', account)
  const f = source([[key, JSON.stringify(draftFor(217, 'not-uuid'))],
    ['copage-draft:v1:用户:a%😀:217:other', '不可误读']])
  assert.equal(enumerateAccountDrafts({ ...options(f.storage), username: account }).length, 1)
  assert.deepEqual(f.reads, [key])
})

test('有效空清单与length/key/getItem读取失败严格区分，不返回部分清单', () => {
  assert.deepEqual(enumerateAccountDrafts(options(source().storage)), [])
  for (const method of ['length', 'key', 'getItem']) {
    const f = source([[keyFor(), JSON.stringify(draftFor())]])
    if (method === 'length') Object.defineProperty(f.storage, 'length', { get() { throw new Error('denied') } })
    else f.storage[method] = () => { throw new Error('denied') }
    assert.throws(() => enumerateAccountDrafts(options(f.storage)), error => error.code === 'DRAFT_STORAGE_UNAVAILABLE')
  }
  const f = source([[keyFor(), JSON.stringify(draftFor())], [keyFor(26), JSON.stringify(draftFor(26))]])
  const getItem = f.storage.getItem
  f.storage.getItem = key => { if (key === keyFor(26)) throw new Error('denied'); return getItem(key) }
  assert.throws(() => enumerateAccountDrafts(options(f.storage)), error => error.code === 'DRAFT_STORAGE_UNAVAILABLE')
})

test('身份在扫描或单条读取之前/之后变化或不可读时拒绝，不返回旧账号内容', () => {
  for (const read of [enumerateAccountDrafts, readAccountDraft]) {
    const f = source([[keyFor(), JSON.stringify(draftFor())]])
    for (const isCurrent of [() => false, () => { throw new Error('identity denied') }, () => Promise.resolve(true)]) {
      assert.throws(() => read({ ...options(f.storage), key: keyFor(), isCurrent }), error => error.code === 'DRAFT_IDENTITY_CHANGED')
    }
    assert.deepEqual(f.reads, [])
    let current = true
    const getItem = f.storage.getItem
    f.storage.getItem = key => { const raw = getItem(key); current = false; return raw }
    assert.throws(() => read({ ...options(f.storage), key: keyFor(), isCurrent: () => current }), error => error.code === 'DRAFT_IDENTITY_CHANGED')
  }
})

test('下载拒绝其他账号槽位且不读取正文；空账号不能枚举', () => {
  const f = source([[keyFor(217, 'old-tab', 'testB'), '原文保留']])
  assert.throws(() => readAccountDraft({ ...options(f.storage), key: keyFor(217, 'old-tab', 'testB') }), error => error.code === 'DRAFT_KEY_INVALID')
  assert.deepEqual(f.reads, [])
  for (const account of ['', null, ' ']) {
    assert.throws(() => enumerateAccountDrafts({ ...options(f.storage), username: account }), error => error.code === 'DRAFT_IDENTITY_CHANGED')
  }
})

test('身份在键枚举期间改变时停止读取；下载存储拒绝不冒充槽位消失', () => {
  const f = source([[keyFor(), JSON.stringify(draftFor())]])
  let current = true
  const getKey = f.storage.key
  f.storage.key = index => { const key = getKey(index); current = false; return key }
  assert.throws(() => enumerateAccountDrafts({ ...options(f.storage), isCurrent: () => current }),
    error => error.code === 'DRAFT_IDENTITY_CHANGED')
  assert.deepEqual(f.reads, [])
  f.storage.getItem = () => { throw new Error('denied') }
  assert.throws(() => readAccountDraft({ ...options(f.storage), key: keyFor() }),
    error => error.code === 'DRAFT_STORAGE_UNAVAILABLE')
})

test('消失槽位表示找不到，不冒充已保存或已同步；点击重读最新完整槽位', () => {
  const f = source([[keyFor(), JSON.stringify(draftFor())]])
  enumerateAccountDrafts(options(f.storage))
  f.values.delete(keyFor())
  assert.throws(() => readAccountDraft({ ...options(f.storage), key: keyFor() }), error => error.code === 'DRAFT_MISSING')
  const newer = draftFor(217, 'old-tab', now, new Delta().insert('最新完整正文\n'))
  f.values.set(keyFor(), JSON.stringify(newer))
  const result = readAccountDraft({ ...options(f.storage), key: keyFor() })
  assert.equal(result.savedAt, now)
  assert.deepEqual(result.backup.content, JSON.parse(JSON.stringify(newer.content)))
})

test('缺失、字符串、无效及未来保存时间均为未知，不阻断完整副本或替换成当前时间', () => {
  for (const savedAt of [undefined, null, '', '1800000000000', -1, 0, 1.5, now + 1, 9_000_000_000_000_000]) {
    const draft = draftFor(); draft.savedAt = savedAt
    const f = source([[keyFor(), JSON.stringify(draft)]])
    assert.deepEqual(enumerateAccountDrafts(options(f.storage))[0], { key: keyFor(), docId: 217, savedAt: null, readable: true })
    const result = readAccountDraft({ ...options(f.storage), key: keyFor() })
    assert.equal(result.backup.savedAt, null)
    assert.equal(result.readable, true)
  }
})

test('时间必须能表示合法日期，时钟异常也不以超日期范围数字充当保存时间', () => {
  const savedAt = 8_640_000_000_000_001, f = source([[keyFor(), JSON.stringify(draftFor(217, 'old-tab', savedAt))]])
  const result = readAccountDraft({ ...options(f.storage), now: savedAt + 1, key: keyFor() })
  assert.equal(result.readable, true)
  assert.equal(result.savedAt, null)
  assert.equal(result.backup.savedAt, null)
})

test('损坏结构、docId/clientId错配与未来格式保留逐字raw，不生成可恢复备份', () => {
  const valid = draftFor()
  const broken = ['{未完成：中文\n"<script>"\\',
    JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, docId: 26 }),
    JSON.stringify({ ...valid, clientId: 'someone-else' }),
    JSON.stringify({ ...valid, content: { ops: [{ retain: 1 }] } }),
    JSON.stringify({ ...valid, pending: { ...valid.pending, opId: '' } })]
  for (const raw of broken) {
    const f = source([[keyFor(), raw]])
    assert.deepEqual(enumerateAccountDrafts(options(f.storage))[0], { key: keyFor(), docId: 217, savedAt: null, readable: false })
    const result = readAccountDraft({ ...options(f.storage), key: keyFor() })
    assert.equal(result.raw, raw); assert.equal(result.readable, false); assert.equal(result.backup, undefined)
    assert.deepEqual(JSON.parse(draftRecordsJson(result.docId, [result])).records, [{ key: keyFor(), raw }])
    assert.equal(f.values.get(keyFor()), raw)
  }
})

test('非法文档编号或空clientId槽位保留原始副本，不构造可继续处理的编号', () => {
  for (const suffix of ['0:tab', '-1:tab', '026:tab', '1.5:tab', '9007199254740992:tab', '1e3:tab', '217:', 'unknown']) {
    const key = 'copage-draft:v1:testA:' + suffix, raw = JSON.stringify(draftFor())
    const f = source([[key, raw]])
    assert.deepEqual(enumerateAccountDrafts(options(f.storage))[0], { key, docId: null, savedAt: null, readable: false })
    assert.equal(readAccountDraft({ ...options(f.storage), key }).raw, raw)
  }
})

test('超过导入上限的大正文与图片地址完整下载，不截断、不上传、不写删记录', () => {
  const image = 'https://images.example/图片.png?source=local', text = '大正文😀'.repeat(150000)
  const content = new Delta().insert(text, { bold: true }).insert({ image }).insert('\n')
  const raw = JSON.stringify(draftFor(217, 'old-tab', now, content)), f = source([[keyFor(), raw]])
  const result = readAccountDraft({ ...options(f.storage), key: keyFor() })
  const backupJson = draftBackupJson(result.backup)
  assert.ok(new TextEncoder().encode(backupJson).length > 1024 * 1024)
  assert.deepEqual(JSON.parse(backupJson).content, JSON.parse(JSON.stringify(content)))
  assert.equal(draftBackupText(result.backup), text + `[图片：${image}]\n`)
  assert.equal(f.values.get(keyFor()), raw)
  assert.equal(result.backup.title, '文档 #217')
})
