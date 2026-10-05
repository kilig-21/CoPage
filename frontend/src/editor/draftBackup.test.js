import test from 'node:test'
import assert from 'node:assert/strict'
import { createDraftBackup, draftBackupJson, draftBackupText } from './draftBackup.js'

test('临时备份固定当前完整正文和格式，不被后续编辑器对象变化影响', () => {
  const content = { ops: [{ insert: '未确认文字', attributes: { bold: true } },
    { insert: { image: 'http://localhost:9000/collab/example.png' }, attributes: { alt: '说明', width: '64' } },
    { insert: '\n' }] }
  const backup = createDraftBackup({ docId: 213, username: 'testA', title: '草稿备份', content })
  content.ops[0].insert = '后来变化'
  content.ops[0].attributes.bold = false
  const file = JSON.parse(draftBackupJson(backup))
  assert.equal(file.format, 'copage')
  assert.equal(file.version, 1)
  assert.equal(file.title, '草稿备份')
  assert.equal(file.content.ops[0].insert, '未确认文字')
  assert.equal(file.content.ops[0].attributes.bold, true)
  assert.equal(file.content.ops[1].attributes.alt, '说明')
  assert.equal(file.content.ops[1].attributes.width, '64')
  assert.deepEqual(Object.keys(file).sort(), ['content', 'format', 'title', 'version'])
  assert.equal(backup.username, 'testA')
})

test('纯文本保留全部文字和图片地址，可在剪贴板拒绝时手动复制', () => {
  const backup = createDraftBackup({ docId: 213, username: 'testA', content: {
    ops: [{ insert: '甲\n乙', attributes: { italic: true } }, { insert: { image: 'https://example.com/a.png' } }, { insert: '\n' }],
  } })
  assert.equal(backup.title, '文档 213')
  assert.equal(draftBackupText(backup), '甲\n乙[图片：https://example.com/a.png]\n')
})

test('超过导入上限的正文仍可完整备份，不截断未确认内容', () => {
  const text = '文'.repeat(400000) + '\n'
  const backup = createDraftBackup({ docId: 213, username: 'testA', content: { ops: [{ insert: text }] } })
  const json = draftBackupJson(backup)
  assert.ok(new TextEncoder().encode(json).length > 1024 * 1024)
  assert.equal(JSON.parse(json).content.ops[0].insert, text)
  assert.equal(draftBackupText(backup), text)
})
