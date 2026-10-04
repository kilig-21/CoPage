import assert from 'node:assert/strict'
import test from 'node:test'
import Delta from 'quill-delta'
import { createImageInsertion, finishImageInsertion, imageValidationError, uploadEditorImage } from './imageUpload.js'

test('图片在前端先检查类型、空文件和 10 MiB 上限', () => {
  assert.match(imageValidationError({ type: 'image/png', size: 0 }), /非空/)
  assert.match(imageValidationError({ type: 'image/svg+xml', size: 20 }), /仅支持/)
  assert.match(imageValidationError({ type: 'image/png', size: 10 * 1024 * 1024 + 1 }), /10 MiB/)
  assert.equal(imageValidationError({ type: 'image/jpeg', size: 10 * 1024 * 1024 }), null)
})

test('上传使用认证请求客户端、multipart 字段 file 和可取消信号', async () => {
  const file = new File(['GIF89a'], 'sample.gif', { type: 'image/gif' })
  const signal = new AbortController().signal
  const request = {
    post: async (path, body, options) => {
      assert.equal(path, '/upload/image')
      assert.equal(body.get('file'), file)
      assert.equal(options.signal, signal)
      return { data: { url: 'http://localhost:9000/collab/images/example.gif' } }
    },
  }
  assert.equal(await uploadEditorImage(request, file, signal),
    'http://localhost:9000/collab/images/example.gif')
})

test('拒绝后端返回的非 HTTP 图片地址', async () => {
  const file = new File(['GIF89a'], 'sample.gif', { type: 'image/gif' })
  const request = { post: async () => ({ data: { url: 'javascript:alert(1)' } }) }
  await assert.rejects(uploadEditorImage(request, file), /安全的图片地址/)
})

test('图片上传完成前不删除选区，多图完成后一起替换且定位到最后一张图片', () => {
  const initial = new Delta().insert('甲乙丙\n')
  const planned = createImageInsertion({ index: 1, length: 1 }, 2, Delta)
  assert.equal(initial.ops[0].insert, '甲乙丙\n')
  const result = finishImageInsertion(planned, ['https://example.com/1.png', 'https://example.com/2.png'], Delta)
  assert.deepEqual(initial.compose(result.delta).ops, [
    { insert: '甲' }, { insert: { image: 'https://example.com/1.png' } },
    { insert: { image: 'https://example.com/2.png' } }, { insert: '丙\n' },
  ])
  assert.equal(result.insertionEnd, 3)
  assert.throws(() => finishImageInsertion(planned, ['https://example.com/1.png'], Delta), /不完整/)
})

test('图片上传期间远端在选区内部输入，替换只删除原选区文字而保留他人输入', () => {
  const initial = new Delta().insert('前甲乙后\n')
  const planned = createImageInsertion({ index: 1, length: 2 }, 1, Delta)
  const remote = new Delta().retain(2).insert('协作')
  const transformed = remote.transform(planned, true)
  const result = finishImageInsertion(transformed, ['https://example.com/1.png'], Delta)
  assert.deepEqual(initial.compose(remote).compose(result.delta).ops, [
    { insert: '前' }, { insert: { image: 'https://example.com/1.png' } }, { insert: '协作后\n' },
  ])
  assert.equal(result.insertionEnd, 2)
})

test('图片上传期间前插或删除原选区，最终图片随操作变换且不越过末尾换行', () => {
  const initial = new Delta().insert('甲乙\n')
  const planned = createImageInsertion({ index: 1, length: 1 }, 1, Delta)
  for (const remote of [new Delta().insert('前缀'), new Delta().delete(2)]) {
    const result = finishImageInsertion(remote.transform(planned, true), ['https://example.com/1.png'], Delta)
    const content = initial.compose(remote).compose(result.delta)
    assert.equal(content.ops.at(-1).insert.endsWith('\n'), true)
    assert.equal(content.ops.filter(op => op.insert?.image).length, 1)
    assert.equal(content.ops.some(op => op.insert?.image?.startsWith('copage-upload')), false)
  }
})
