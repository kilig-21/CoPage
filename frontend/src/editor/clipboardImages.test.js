import assert from 'node:assert/strict'
import test from 'node:test'
import Delta from 'quill-delta'
import { clipboardPasteError, configureClipboardImages, embeddedImageFile, normalizeClipboardContent, normalizeImageAttributes, normalizeImageUrl } from './clipboardImages.js'
import { finishImageInsertion, IMAGE_PLACEHOLDER } from './imageUpload.js'

test('粘贴图片只保留可共享地址，拒绝私有 blob、相对地址、用户信息及不合法域名', () => {
  assert.equal(normalizeImageUrl('//example.com/图.png'), 'https://example.com/%E5%9B%BE.png')
  assert.equal(normalizeImageUrl('http://localhost:9000/a.png'), 'http://localhost:9000/a.png')
  for (const value of ['data:image/png;base64,YQ==', 'blob:https://example.com/id', '/image.png', 'https://u:p@example.com/a', 'https://bad_host/a', 'https://example.com/a\n']) assert.throws(() => normalizeImageUrl(value))
})

test('粘贴图片移除不合法尺寸，限制替代文字，保留正常格式', () => {
  assert.deepEqual(normalizeImageAttributes({ width: '0', height: '99999', alt: '甲\n乙', bold: true }), { alt: '甲乙', bold: true })
  assert.deepEqual(normalizeImageAttributes({ width: '10000', height: '100%' }), { width: '10000', height: '100%' })
  assert.deepEqual(normalizeImageAttributes({ width: 100 }), {})
  assert.equal(normalizeImageAttributes({ alt: '甲'.repeat(800) }).alt.length, 512)
})

test('内嵌位图转换为认证上传文件，拒绝损坏编码、空内容和 SVG', () => {
  const file = embeddedImageFile('data:image/png;base64,iVBORw0KGgo=', 0)
  assert.equal(file.type, 'image/png')
  assert.equal(file.size, 8)
  assert.equal(file.name, 'pasted-0.png')
  for (const value of ['data:image/svg+xml;base64,YQ==', 'data:image/png;base64,===', 'data:image/png;base64,', 'blob:example']) assert.throws(() => embeddedImageFile(value, 0))
})

test('混合 HTML 上传后保留前后文字与格式，光标在全部粘贴内容之后，变换保留远端插入', () => {
  const initial = new Delta().insert('前甲乙后\n')
  const planned = new Delta().retain(1).insert('开头', { bold: true }).insert({ image: IMAGE_PLACEHOLDER + 0 }, { alt: '图' }).insert('末尾').delete(2)
  const remote = new Delta().retain(2).insert('协作')
  const result = finishImageInsertion(remote.transform(planned, true), ['https://example.com/a.png'], Delta)
  assert.deepEqual(initial.compose(remote).compose(result.delta).ops, [
    { insert: '前' }, { insert: '开头', attributes: { bold: true } },
    { insert: { image: 'https://example.com/a.png' }, attributes: { alt: '图' } }, { insert: '末尾协作后\n' },
  ])
  assert.equal(result.insertionEnd, 6)
})

test('广色域颜色不发送至后端，保留正文和其他格式，普通颜色不改变', () => {
  const source = new Delta()
    .insert('广色域', { color: 'color(display-p3 1 0 0)', background: 'lab(50% 0 0)', bold: true })
    .insert('正常', { color: '#ff0000', background: 'rgba(0, 0, 0, 0.5)', italic: true })
  const result = normalizeClipboardContent(source)
  assert.equal(result.changed, true)
  assert.deepEqual(result.delta.ops, [
    { insert: '广色域', attributes: { bold: true } },
    { insert: '正常', attributes: { color: '#ff0000', background: 'rgba(0, 0, 0, 0.5)', italic: true } },
  ])
  assert.equal(source.ops[0].attributes.color, 'color(display-p3 1 0 0)')
  assert.equal(normalizeClipboardContent(new Delta().insert('正文', { color: 'red' })).changed, false)
})

test('纯文本空字符过滤后全部为空时，不删除当前选区或产生编辑', () => {
  const notices = []
  const quill = {
    constructor: { import: () => Delta },
    clipboard: { addMatcher() {}, convert: () => new Delta().insert('\u0000\u0000') },
    getFormat: () => ({}),
    updateContents() { assert.fail('空内容不得替换选区') },
    setSelection() { assert.fail('空内容不得移动光标') },
  }
  configureClipboardImages(quill, () => assert.fail('不应上传'), notice => notices.push(notice))
  quill.clipboard.onPaste({ index: 3, length: 5 }, { text: '\u0000\u0000' })
  assert.equal(notices.length, 1)
  assert.match(notices[0], /空字符/)
  const result = normalizeClipboardContent(new Delta().insert('甲\u0000乙\n', { bold: true }))
  assert.deepEqual(result.delta.ops, [{ insert: '甲乙\n', attributes: { bold: true } }])
})

test('单次格式片段上限包含选区替换，常规内容仍可粘贴', () => {
  const ops = Array.from({ length: 10000 }, (_, index) => ({ insert: '甲', attributes: index % 2 ? { italic: true } : { bold: true } }))
  assert.equal(clipboardPasteError(new Delta(ops)), null)
  assert.match(clipboardPasteError(new Delta([{ retain: 5 }, ...ops])), /分段粘贴/)
  assert.equal(clipboardPasteError(new Delta().retain(5).delete(3).insert('替换文字')), null)
})

test('按UTF-8序列化大小限制单次修改4 MiB，比WS上限更严格', () => {
  assert.match(clipboardPasteError(new Delta().insert('中'.repeat(3 * 1024 * 1024))), /内容过大/)
  assert.equal(clipboardPasteError(new Delta().insert('中'.repeat(1024))), null)
})

test('正文容量按替换后的完整Delta计算，包含已有正文和格式开销', () => {
  const limit = 2 * 1024 * 1024
  const overhead = new TextEncoder().encode(JSON.stringify(new Delta().insert('\n'))).length
  const exact = new Delta().insert('x'.repeat(limit - overhead) + '\n')
  assert.equal(clipboardPasteError(new Delta().delete(1).insert('y'), exact), null)
  assert.match(clipboardPasteError(new Delta().insert('中'), exact), /正文会超过 2 MiB/)
  assert.equal(clipboardPasteError(new Delta().delete(100).insert('中'), exact), null)
  assert.match(clipboardPasteError(new Delta().retain(1, { bold: true }), exact), /正文会超过 2 MiB/)
  const existing = new Delta().insert('中'.repeat(400000) + '\n')
  const pasted = new Delta().insert('中'.repeat(400000))
  assert.match(clipboardPasteError(pasted, existing), /正文会超过 2 MiB/)
  assert.equal(clipboardPasteError(pasted.delete(400000), existing), null)
})

test('整篇容量超限时不插入、不改变选区，也不启动图片上传', () => {
  const notices = []
  const quill = {
    constructor: { import: () => Delta },
    clipboard: { addMatcher() {}, convert: () => new Delta().insert('中'.repeat(800000)) },
    getFormat: () => ({}),
    getContents: () => new Delta().insert('原正文\n'),
    updateContents() { assert.fail('超限正文不得进入编辑器') },
    setSelection() { assert.fail('拒绝时保留选区') },
  }
  configureClipboardImages(quill, () => assert.fail('超限粘贴不得上传图片'), notice => notices.push(notice))
  quill.clipboard.onPaste({ index: 1, length: 2 }, { text: 'large' })
  assert.match(notices[0], /正文会超过 2 MiB/)
})

test('格式过于复杂时不修改正文或选区，不启动图片上传', () => {
  const notices = []
  const quill = {
    constructor: { import: () => Delta },
    clipboard: {
      addMatcher() {},
      convert: () => new Delta(Array.from({ length: 10001 }, (_, index) => ({ insert: '甲', attributes: index % 2 ? { italic: true } : { bold: true } }))),
    },
    getFormat: () => ({}),
    getContents: () => new Delta().insert('\n'),
    updateContents() { assert.fail('拒绝的粘贴不产生编辑') },
    setSelection() { assert.fail('拒绝的粘贴不改变选区') },
  }
  configureClipboardImages(quill, () => assert.fail('拒绝的粘贴不应上传'), notice => notices.push(notice))
  quill.clipboard.onPaste({ index: 3, length: 2 }, { text: '复杂格式' })
  assert.match(notices[0], /原选区已保留/)
})
