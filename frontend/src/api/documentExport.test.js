import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDocumentExport } from './documentExport.js'

const copy = content => ({ filename: '资料 🧭.copage.json', mediaType: 'application/json;charset=utf-8',
  content: JSON.stringify({ format: 'copage', version: 1, title: '资料 🧭', content }), revision: 0 })
const valid = copy({ ops: [{ insert: '资料\n' }] })
const invalid = (value, format = 'copage') => assert.throws(() => parseDocumentExport(value, format),
  error => /未生成副本/.test(error.message) && /请重试/.test(error.message))

test('残缺或原始值回复不能成为undefined下载或假成功', () => {
  for (const value of [undefined, null, false, true, 0, '', 'reply', [], {}, { data: valid }]) invalid(value)
  for (const field of ['content', 'filename', 'mediaType', 'revision']) {
    const partial = { ...valid }; delete partial[field]; invalid(partial)
  }
})

test('正文与文件名必须是实际字符串，不能隐式转换对象或空白文件名', () => {
  for (const content of [undefined, null, false, 0, {}, []]) invalid({ ...valid, content })
  for (const filename of [undefined, null, false, 0, {}, [], '', ' \t\n ']) invalid({ ...valid, filename })
})

test('所选格式和媒体类型一致，拒绝错误类型或未知格式', () => {
  for (const mediaType of [undefined, null, false, 'text/html', 'text/plain;charset=utf-8']) invalid({ ...valid, mediaType })
  invalid(valid, 'txt'); invalid(valid, 'unknown')
  const text = { filename: '资料.txt', mediaType: 'text/plain;charset=utf-8', content: '资料\n', revision: 0 }
  assert.deepEqual(parseDocumentExport(text, 'txt'), text)
})

test('版本0有效，缺失、负数、小数及不安全版本不能被显示成成功', () => {
  assert.equal(parseDocumentExport(valid, 'copage').revision, 0)
  for (const revision of [undefined, null, false, '0', -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) invalid({ ...valid, revision })
})

test('富文本封装可解析且为CoPage版本1，保留原始JSON字节不重新序列化', () => {
  for (const content of ['', 'undefined', '{', 'null', '[]', '{}', '{"format":"copage","version":"1"}',
    '{"format":"other","version":1}', '{"format":"copage","version":2}']) invalid({ ...valid, content })
  const content = '{\n  "version": 1, "format": "copage", "title": "原稿🧭", "content": {"ops": [{"insert":"保留  空格\\n"}]}, "extra": true\n}\n'
  assert.equal(parseDocumentExport({ ...valid, content }, 'copage').content, content)
})

test('完整存量正文超过10000片段或2MiB仍按原字节下载，不复制导入限制', () => {
  const fragments = copy({ ops: Array.from({ length: 10001 }, (_, i) => ({ insert: i % 2 ? '乙' : '甲', attributes: { bold: i % 2 === 0 } })) })
  assert.equal(parseDocumentExport(fragments, 'copage').content, fragments.content)
  const large = copy({ ops: [{ insert: '长'.repeat(750000) + '\n' }] })
  assert.ok(new TextEncoder().encode(large.content).length > 2 * 1024 * 1024)
  assert.equal(parseDocumentExport(large, 'copage').content, large.content)
})

test('纯文本空白、换行、Unicode及旧格式副本不被归一化或篡改', () => {
  for (const content of ['', '\n', '  \r\n\t\n', '中文 🧭\n第二行  \n']) {
    const text = Object.freeze({ filename: '原名 🧭.txt', mediaType: 'text/plain;charset=utf-8', content, revision: 7, extra: 'not-public' })
    const result = parseDocumentExport(text, 'txt')
    assert.equal(result.content, content); assert.equal(result.filename, text.filename); assert.notEqual(result, text)
    assert.equal(Object.hasOwn(result, 'extra'), false)
  }
  const legacy = copy({ ops: [{ insert: '旧格式\n', attributes: { legacy: true } }] })
  assert.equal(parseDocumentExport(legacy, 'copage').content, legacy.content)
})
