import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { openRecoveryChannel } from './recovery-channel.mjs'
import { privateImagePath } from '../frontend/src/editor/privateImages.js'

export async function runPrivateImageCheck({ ports, username, password }) {
  const [ownerPort, readerPort] = ports
  const request = (port, path, { method = 'GET', token, json, body } = {}) =>
    fetch('http://127.0.0.1:' + port + '/api' + path, {
      method, signal: AbortSignal.timeout(8000),
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(json ? { 'Content-Type': 'application/json' } : {}),
      },
      body: json ? JSON.stringify(json) : body,
    })
  const value = async response => {
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.code, 0)
    return payload.data
  }
  const login = async (port, account) =>
    (await value(await request(port, '/auth/login', { method: 'POST', json: account }))).token
  const reader = { username: 'imageqa' + randomBytes(4).toString('hex'), password: randomBytes(24).toString('hex') }
  const readerAccount = await value(await request(readerPort, '/auth/register', { method: 'POST', json: reader }))
  const ownerToken = await login(ownerPort, { username, password })
  const readerToken = await login(readerPort, reader)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4s0AAAAASUVORK5CYII=', 'base64')
  function upload() {
    const body = new FormData()
    body.append('file', new File([png], 'private-image.png', { type: 'image/png' }))
    return request(ownerPort, '/upload/image', { method: 'POST', token: ownerToken, body })
  }
  const asset = await value(await upload())
  const path = privateImagePath(asset.url)
  assert.ok(path)
  async function canReadAs(token) {
    const response = await request(readerPort, path, { token })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^image\/png/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png)
  }
  await canReadAs(ownerToken)
  assert.equal((await request(readerPort, path)).status, 401)
  assert.equal((await request(readerPort, path, { token: readerToken })).status, 404)

  const doc = await value(await request(ownerPort, '/doc', {
    method: 'POST', token: ownerToken, json: { title: '私有图片合成文档 ' + randomUUID() },
  }))
  const source = await openRecoveryChannel({
    url: 'ws://127.0.0.1:' + ownerPort + '/ws/collab',
    token: ownerToken, docId: doc.id, clientId: randomUUID(),
  })
  try {
    await source.submit(randomUUID(), 0, { ops: [{ insert: { image: asset.url } }] })
  } finally { source.ws.close() }

  const backup = await value(await request(ownerPort, '/doc/' + doc.id + '/export', { token: ownerToken }))
  assert.ok(backup.content.includes(asset.url))
  const importImage = (port, token) => {
    const body = new FormData()
    body.append('file', new File([backup.content], backup.filename, { type: 'application/json' }))
    return request(port, '/doc/import', { method: 'POST', token, body })
  }
  assert.equal((await importImage(readerPort, readerToken)).status, 404)
  const imported = await value(await importImage(ownerPort, ownerToken))
  assert.ok(JSON.stringify(await value(await request(ownerPort, '/doc/' + imported.id, { token: ownerToken }))).includes(asset.url))

  const membership = '/doc/' + doc.id + '/collaborators'
  await value(await request(ownerPort, membership, {
    method: 'POST', token: ownerToken, json: { username: reader.username, permission: 1 },
  }))
  await canReadAs(readerToken)
  await value(await request(ownerPort, membership + '/' + readerAccount.id, { method: 'DELETE', token: ownerToken }))
  assert.equal((await request(readerPort, path, { token: readerToken })).status, 404)

  await value(await upload())
  const denied = await upload()
  assert.equal(denied.status, 400)
  assert.match((await denied.json()).message, /上限/)
  console.log('PASS: 私有图片权限、无缓存读取、协作者撤权、导出重导和上传配额')
}
