import test from 'node:test'
import assert from 'node:assert/strict'
import { createDraftBackup, draftBackupExceedsImportLimits, draftBackupJson, draftBackupText } from './draftBackup.js'

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

test('超过1MiB正文仍完整备份，符合新容量时不误提示需拆分', () => {
  const text = '文'.repeat(400000) + '\n'
  const backup = createDraftBackup({ docId: 213, username: 'testA', content: { ops: [{ insert: text }] } })
  const json = draftBackupJson(backup)
  assert.ok(new TextEncoder().encode(json).length > 1024 * 1024)
  assert.equal(JSON.parse(json).content.ops[0].insert, text)
  assert.equal(draftBackupText(backup), text)
  assert.equal(draftBackupExceedsImportLimits(backup,json),false)
})

test('备份导入提示分别按正文UTF-8 JSON、文件封装和原片段数量判断，不截断正文', () => {
  const content={ops:[{insert:'😀\\"\n'}]}
  const overhead=new TextEncoder().encode(JSON.stringify(content)).length
  content.ops[0].insert+='a'.repeat(2*1024*1024-overhead)
  const backup=createDraftBackup({docId:213,title:'容量边界',content})
  assert.equal(draftBackupExceedsImportLimits(backup),false)
  assert.ok(new TextEncoder().encode(draftBackupJson(backup)).length>2*1024*1024)
  backup.content.ops[0].insert+='a'
  assert.equal(draftBackupExceedsImportLimits(backup),true)
  assert.equal(JSON.parse(draftBackupJson(backup)).content.ops[0].insert,backup.content.ops[0].insert)
  const small=createDraftBackup({docId:213,title:'x'.repeat(3*1024*1024),content:{ops:[{insert:'\n'}]}})
  assert.equal(draftBackupExceedsImportLimits(small),true)
  small.title='片段';small.content.ops=Array.from({length:10001},()=>({insert:'x'}))
  assert.equal(draftBackupExceedsImportLimits(small),true)
})
