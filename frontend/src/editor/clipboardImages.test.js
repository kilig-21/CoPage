import assert from 'node:assert/strict'
import test from 'node:test'
import Delta from 'quill-delta'
import { embeddedImageFile, normalizeImageAttributes, normalizeImageUrl } from './clipboardImages.js'
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
