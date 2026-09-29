import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { uploadEditorImage } from '../frontend/src/editor/imageUpload.js'

const origin = process.env.COPAGE_IMAGE_SMOKE_ORIGIN ?? 'http://127.0.0.1:8082'
const parsedOrigin = new URL(origin)
if (parsedOrigin.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(parsedOrigin.hostname) ||
    parsedOrigin.username || parsedOrigin.password || parsedOrigin.pathname !== '/' ||
    parsedOrigin.search || parsedOrigin.hash) {
  throw new Error('烟测只允许连接本机 HTTP 后端 origin')
}

const username = process.env.COPAGE_IMAGE_SMOKE_USER ?? 'testA'
const password = process.env.COPAGE_IMAGE_SMOKE_PASSWORD ?? '123456'
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==',
  'base64',
)

if (process.argv.includes('--write-fixture')) {
  const directory = mkdtempSync(join(tmpdir(), 'copage-image-smoke-'))
  const path = join(directory, 'test-pixel.png')
  writeFileSync(path, image)
  console.log(path)
  process.exit(0)
}

async function upload(file, token) {
  const form = new FormData()
  form.append('file', file)
  return fetch(new URL('/api/upload/image', parsedOrigin), {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  })
}

async function main() {
  const loginResponse = await fetch(new URL('/api/auth/login', parsedOrigin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  assert.equal(loginResponse.status, 200, `登录返回 HTTP ${loginResponse.status}`)
  const login = await loginResponse.json()
  assert.equal(login.code, 0)
  const token = login.data?.token
  assert.ok(token, '登录未返回 token')

  const file = new File([image], 'copage-smoke.png', { type: 'image/png' })
  assert.equal((await upload(file)).status, 401, '未授权上传必须返回 401')
  const invalid = new File(['not an image'], 'fake.png', { type: 'image/png' })
  assert.equal((await upload(invalid, token)).status, 400, '伪造图片必须返回 400')

  const request = {
    async post(path, body, { signal } = {}) {
      assert.equal(path, '/upload/image')
      const response = await fetch(new URL(`/api${path}`, parsedOrigin), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body,
        signal,
      })
      const payload = await response.json()
      assert.equal(response.status, 200, `上传返回 HTTP ${response.status}: ${payload.message}`)
      assert.equal(payload.code, 0)
      assert.equal(payload.data.contentType, 'image/png')
      assert.equal(payload.data.size, image.length)
      return payload
    },
  }
  const url = await uploadEditorImage(request, file)
  const imageUrl = new URL(url)
  assert.equal(imageUrl.protocol, 'http:')
  assert.ok(['localhost', '127.0.0.1'].includes(imageUrl.hostname), '图片 URL 不应指向容器内部地址')
  assert.match(imageUrl.pathname, /^\/collab\/images\/\d{4}\/\d{2}\/[\w-]+\.png$/)
  const imageResponse = await fetch(url)
  assert.equal(imageResponse.status, 200, `公开图片读取返回 HTTP ${imageResponse.status}`)
  assert.match(imageResponse.headers.get('content-type') ?? '', /^image\/png/)
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), image)
  console.log('PASS: JWT 上传限制、图片签名校验、前端上传函数、MinIO 公开 URL 与文件内容')
  console.log(`测试图片地址：${url}`)
  console.log('注意：此烟测会在本地 MinIO 留下一张极小测试图片；真实浏览器选图/协同插入仍需单独验收。')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
