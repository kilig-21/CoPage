import assert from 'node:assert/strict'
import test from 'node:test'
import Delta from 'quill-delta'
import CollabClient from '../ws/CollabClient.js'
import { readDraftRecords, draftRecordsJson } from './draftRecords.js'

const prefix = 'copage-draft:v1:testA:217:'
function storage(entries) {
  const keys = Object.keys(entries)
  return { length: keys.length, key: index => keys[index], getItem: key => entries[key] ?? null,
    setItem: () => assert.fail('读取不能写入草稿'), removeItem: () => assert.fail('读取不能删除草稿') }
}
function actualDraft() {
  const client = new CollabClient({ docId: 217, clientId: 'old-tab', Delta })
  client.submit(new Delta().insert('未确认正文', { bold: true }))
  return client.exportDraft(new Delta().insert('未确认正文', { bold: true }).insert('\n'))
}

test('实际客户端导出的草稿保持可恢复，读取只限当前账号文档且不写入', () => {
  const draft = actualDraft()
  const entries = { [prefix + 'old-tab']: JSON.stringify(draft),
    'copage-draft:v1:testB:217:other': '不读取其他账号', 'copage-draft:v1:testA:26:protected': '不读取其他文档' }
  const source = storage(entries)
  const reads = []
  source.getItem = key => { reads.push(key); return entries[key] }
  const result = readDraftRecords({ storage: source, prefix, docId: 217, Delta })
  assert.deepEqual(result.drafts, [{ key: prefix + 'old-tab', draft: JSON.parse(JSON.stringify(draft)) }])
  assert.deepEqual(result.unreadable, [])
  assert.deepEqual(reads, [prefix + 'old-tab'])
})

test('损坏、未来版本、文档/槽位不匹配与缺失操作标识保留原字符串，不阻塞正常草稿', () => {
  const draft = actualDraft()
  const entries = {
    [prefix + 'truncated']: JSON.stringify(draft).slice(0, -1),
    [prefix + 'future']: JSON.stringify({ ...draft, version: 2 }),
    [prefix + 'wrong-doc']: JSON.stringify({ ...draft, docId: 26 }),
    [prefix + 'bad-op']: JSON.stringify({ ...draft, pending: { ...draft.pending, opId: '' } }),
    [prefix + 'alias']: JSON.stringify(draft),
    [prefix + 'null-op']: JSON.stringify({ ...draft, clientId: 'null-op', content: { ops: [null] } }),
    [prefix + 'not-document']: JSON.stringify({ ...draft, clientId: 'not-document', content: { ops: [{ retain: 1 }] } }),
    [prefix + 'old-tab']: JSON.stringify(draft),
  }
  const result = readDraftRecords({ storage: storage(entries), prefix, docId: 217, Delta })
  assert.equal(result.drafts.length, 1)
  assert.equal(result.unreadable.length, 7)
  for (const record of result.unreadable) assert.equal(record.raw, entries[record.key])
})

test('原始记录副本逐字保留无法解析的中文、换行和特殊字符，格式区别于文档副本', () => {
  const records = [{ key: prefix + 'old-tab', raw: '{未完成：中文\n"<script>"\\' }]
  const file = JSON.parse(draftRecordsJson(217, records))
  assert.equal(file.format, 'copage-draft-records')
  assert.equal(file.docId, 217)
  assert.deepEqual(file.records, records)
})
