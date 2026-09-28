import assert from 'node:assert/strict'
import test from 'node:test'
import { imageValidationError, uploadEditorImage } from './imageUpload.js'

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
