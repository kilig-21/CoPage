import test from 'node:test'
import assert from 'node:assert/strict'
import Delta from 'quill-delta'
import { findDocumentMatches, documentReplacement, createDocumentFind } from './documentFind.js'

test('文字查找跨格式但不跨图片，索引包含图片和emoji的UTF-16长度', () => {
  const content = new Delta().insert('😀甲', { bold: true }).insert('乙甲乙').insert({ image: 'https://example.com/a.png' })
    .insert('甲乙\n')
  assert.deepEqual([...findDocumentMatches(content, '甲乙')], [2, 2, 4, 2, 7, 2])
  assert.deepEqual([...findDocumentMatches(content, '乙甲乙')], [3, 3])
  assert.deepEqual([...findDocumentMatches(content, '乙甲')], [3, 2])
  assert.deepEqual([...findDocumentMatches(content, '乙甲乙甲')], [])
})

test('特殊符号按原文查找，大小写可选，不选择文档结构末尾换行', () => {
  const content = new Delta().insert('Word word .* [x] Word\n')
  assert.deepEqual([...findDocumentMatches(content, 'word')], [0, 4, 5, 4, 17, 4])
  assert.deepEqual([...findDocumentMatches(content, 'Word', true)], [0, 4, 17, 4])
  assert.deepEqual([...findDocumentMatches(content, '.* [x]')], [10, 6])
  assert.deepEqual([...findDocumentMatches(content, '\n')], [])
  assert.deepEqual([...findDocumentMatches(new Delta().insert('甲\n乙\n'), '甲\n乙')], [0, 3])
  assert.deepEqual([...findDocumentMatches(content, '')], [])
})

test('全部替换只处理原匹配，保留首字符格式、图片和未选中文字', () => {
  const content = new Delta().insert('甲', { bold: true, color: '#ff0000' }).insert('乙')
    .insert({ image: 'https://example.com/a.png' }, { alt: '测试' }).insert('甲乙', { italic: true }).insert('\n')
  const ranges = findDocumentMatches(content, '甲乙')
  const result = documentReplacement(content, ranges, '甲乙新', Delta)
  assert.equal(result.changed, 2)
  assert.deepEqual(content.compose(result.operation).ops, [
    { insert: '甲乙新', attributes: { bold: true, color: '#ff0000' } },
    { insert: { image: 'https://example.com/a.png' }, attributes: { alt: '测试' } },
    { insert: '甲乙新', attributes: { italic: true } }, { insert: '\n' },
  ])
})

test('空替换删除文字，完全相同的替换不改格式或产生操作', () => {
  const content = new Delta().insert('甲', { bold: true }).insert('乙甲乙\n')
  const ranges = findDocumentMatches(content, '甲乙')
  const unchanged = documentReplacement(content, ranges, '甲乙', Delta)
  assert.equal(unchanged.changed, 0)
  assert.deepEqual(unchanged.operation.ops, [])
  const deleted = documentReplacement(content, ranges, '', Delta)
  assert.deepEqual(content.compose(deleted.operation).ops, [{ insert: '\n' }])
})

test('非法范围不能覆盖图片或末尾换行，空字符拒绝且原文不变', () => {
  const content = new Delta().insert('甲').insert({ image: 'https://example.com/a.png' }).insert('乙\n')
  const before = JSON.stringify(content)
  for (const ranges of [[0, 2], [3, 1], [0, 0], [2, 1, 0, 1]]) {
    assert.throws(() => documentReplacement(content, ranges, '新', Delta), /匹配范围已经变化/)
  }
  assert.throws(() => documentReplacement(content, [0, 1], '\0', Delta), /空字符/)
  assert.equal(JSON.stringify(content), before)
})

test('大量相邻匹配合并为单次操作，不丢失文字或递归替换新文本', () => {
  const content = new Delta().insert('a'.repeat(100000) + '\n')
  const matches = findDocumentMatches(content, 'a')
  assert.equal(matches.length / 2, 100000)
  const { operation, changed } = documentReplacement(content, matches, 'aa', Delta)
  assert.equal(changed, 100000)
  assert.equal(operation.ops.length, 2)
  assert.equal(content.compose(operation).ops[0].insert, 'a'.repeat(200000) + '\n')
})

test('连字符、路径、反斜杠和占位符按字面查找', () => {
  const query = 'foo-bar /path/ \\ $1? [x]'
  const content = new Delta().insert(query + '\n')
  assert.deepEqual([...findDocumentMatches(content, query)], [0, query.length])
})

test('合法正文的全部替换超出单次片段上限时原文保持不变', () => {
  const content = new Delta()
  for (let i = 0; i < 4000; i++) content.insert('a', { bold: true }).insert('b', { italic: true })
  content.insert('\n')
  assert.ok(content.ops.length <= 10000)
  const before = JSON.stringify(content)
  assert.throws(() => documentReplacement(content, findDocumentMatches(content, 'a'), '新', Delta), /过于复杂.*正文未修改/)
  assert.equal(JSON.stringify(content), before)
})

function findFixture(canReplace = () => true) {
  const body = {}, document = { body, activeElement: body, querySelector: () => null, getSelection: () => null }
  let content = new Delta().insert('目标 目标\n'), selection = null, state = null
  const applied = []
  const quill = {
    root: { ownerDocument: document },
    getContents: () => content,
    getSelection: () => selection,
    getText: (index, length) => content.ops.map(op => op.insert).join('').slice(index, index + length),
    setSelection: (index, length) => { selection = { index, length } },
    scrollSelectionIntoView() {},
    getModule: () => ({ cutoff() {} }),
    updateContents: (operation, source) => { content = content.compose(operation); applied.push({ operation, source }) },
  }
  const finder = createDocumentFind(quill, { Delta, canReplace, onState: value => { state = value } })
  return { quill, finder, applied, state: () => state }
}

test('关闭后重新查找时，计数对应实际正文选区', () => {
  const { quill, finder, state } = findFixture()
  finder.start(); finder.setQuery('目标'); finder.next()
  assert.equal(quill.getSelection().index, 3)
  finder.pause(); finder.start()
  assert.equal(state().current, 1)
  assert.deepEqual(quill.getSelection(), { index: 0, length: 2 })
})

test('替换再次核对就绪条件，阻止过期按钮提交；放行后使用用户编辑来源', () => {
  let ready = false
  const { quill, finder, state, applied } = findFixture(() => ready)
  finder.start(); finder.setQuery('目标'); finder.replace('新', true)
  assert.equal(applied.length, 0)
  assert.equal(quill.getContents().ops[0].insert, '目标 目标\n')
  assert.equal(state().canReplace, false)
  ready = true
  finder.refreshStatus(); finder.replace('新', true)
  assert.equal(applied.length, 1)
  assert.equal(applied[0].source, 'user')
  assert.equal(quill.getContents().ops[0].insert, '新 新\n')
})

test('大量匹配扩张超正文上限时，在构造巨型结果前拒绝且不修改原文', () => {
  const content = new Delta().insert('a'.repeat(100000) + '\n')
  const before = JSON.stringify(content)
  assert.throws(() => documentReplacement(content, findDocumentMatches(content, 'a'), '文'.repeat(10000), Delta), /正文会超过 2 MiB/)
  assert.equal(JSON.stringify(content), before)
})

test('查找框输入期间更新匹配但不移动正文选区或提交替换，结束后才定位', () => {
  const { quill, finder, state, applied } = findFixture()
  finder.start()
  finder.setQuery('目标', false, false)
  assert.equal(state().count, 2)
  assert.equal(quill.getSelection(), null)
  assert.equal(state().canReplace, false)
  finder.replace('新', true)
  assert.equal(applied.length, 0)
  finder.refreshSelection()
  assert.equal(quill.getSelection(), null)
  finder.setQuery('目标', false, true)
  assert.deepEqual(quill.getSelection(), { index: 0, length: 2 })
  assert.equal(state().canReplace, true)
})
