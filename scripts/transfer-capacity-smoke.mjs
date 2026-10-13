import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openRecoveryChannel } from './recovery-channel.mjs'

const origin = process.env.COPAGE_TRANSFER_ORIGIN || 'http://localhost:8080'
const marker = 'TransferCapacity-' + randomUUID(), records = []
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
let owner, reader, channel, verified
async function api(auth, path, method = 'GET', body, status = 200, key) {
  const form = body instanceof FormData
  const response = await fetch(origin + '/api' + path, { method, signal: AbortSignal.timeout(30000),
    headers: { ...(auth ? { Authorization: 'Bearer ' + auth.token } : {}),
      ...(body && !form ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    body: form ? body : body ? JSON.stringify(body) : undefined })
  const payload = await response.json()
  assert.equal(response.status, status, method + ' ' + path + '状态不符')
  if (status === 200) assert.equal(payload.code, 0)
  return payload.data
}
function file(name, content, title) {
  const form = new FormData(); form.append('file', new Blob([content]), name)
  if (title) form.append('title', title)
  return form
}
async function keep(auth, title) {
  const created = await api(auth, '/doc', 'POST', { title })
  assert.ok(Number.isSafeInteger(created.id) && created.id > 26)
  const record = { id: created.id, auth, title, revision: 0, hash: hash({ ops: [{ insert: '\n' }] }), shared: false }
  records.push(record); return record
}
async function edit(record, ops) {
  channel = await openRecoveryChannel({ url: origin.replace(/^http/, 'ws') + '/ws/collab?token=' + encodeURIComponent(record.auth.token),
    docId: record.id, clientId: randomUUID(), lastRevision: record.revision, phase: 'test' })
  const ack = await channel.submit(randomUUID(), record.revision, { ops })
  assert.equal(ack.revision, record.revision + 1)
  record.revision = ack.revision; channel.ws.close(); channel = null
}
try {
  owner = await api(null, '/auth/login', 'POST', { username: 'testA', password: '123456' })
  reader = await api(null, '/auth/login', 'POST', { username: 'testB', password: '123456' })
  const large = await keep(owner, marker + '-large')
  const prefix = '中文😀\\"\n'.repeat(1000)
  const first = { insert: prefix, attributes: { bold: true } }
  const content = { ops: [first, { insert: '\n' }] }
  const padding = 2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(content))
  first.insert += 'a'.repeat(padding)
  large.hash = hash(content) // 独立预期先于写入；未知/不一致时守卫保留资料。
  await edit(large, [first])
  const saved = await api(owner, '/doc/' + large.id)
  assert.deepEqual(saved.content, content)
  assert.equal(Buffer.byteLength(JSON.stringify(saved.content)), 2 * 1024 * 1024)
  await api(reader, '/doc/' + large.id + '/export?format=copage', 'GET', undefined, 403)
  await api(owner, '/doc/' + large.id + '/collaborators', 'POST', { username: 'testB', permission: 1 }); large.shared = true
  const exported = await api(reader, '/doc/' + large.id + '/export?format=copage')
  assert.equal(exported.revision, large.revision)
  assert.ok(Buffer.byteLength(exported.content) > 2 * 1024 * 1024)
  assert.deepEqual(Object.keys(JSON.parse(exported.content)).sort(), ['content', 'format', 'title', 'version'])
  assert.deepEqual(JSON.parse(exported.content).content, saved.content)
  assert.equal((await api(reader, '/doc/' + large.id + '/export?format=txt')).content, first.insert + '\n')
  const importedTitle = marker + '-imported', key = randomUUID()
  const imported = await api(reader, '/doc/import', 'POST', file(exported.filename, exported.content, importedTitle), 200, key)
  assert.ok(Number.isSafeInteger(imported.id) && imported.id > 26 && !records.some(record => record.id === imported.id))
  const copied = { id: imported.id, auth: reader, title: importedTitle, revision: 0, hash: large.hash, shared: false }
  records.push(copied)
  assert.equal((await api(reader, '/doc/import', 'POST', file(exported.filename, exported.content, importedTitle), 200, key)).id, copied.id)
  const restored = await api(reader, '/doc/' + copied.id)
  assert.equal(restored.ownerId, reader.user.id); assert.equal(restored.revision, 0)
  assert.deepEqual(restored.content, saved.content)
  assert.deepEqual((await api(reader, '/doc/' + copied.id + '/history/0')).content, saved.content)
  assert.equal((await api(reader, '/doc/' + copied.id + '/collaborators')).length, 0)
  await api(owner, '/doc/' + copied.id, 'GET', undefined, 403)
  // 文件3MiB以内仍不能突破正文2MiB，JSON转义也按实际正文容量计算。
  const tooLarge = { format: 'copage', version: 1, title: marker + '-rejected', content: structuredClone(content) }
  tooLarge.content.ops[0].insert += 'a'
  await api(owner, '/doc/import', 'POST', file('too-large.json', JSON.stringify(tooLarge)), 400, randomUUID())
  await api(owner, '/doc/import', 'POST', file('expanded.txt', '\\'.repeat(1024 * 1024)), 400, randomUUID())
  await api(owner, '/doc/import', 'POST', file('over-file.txt', 'a'.repeat(3 * 1024 * 1024 + 1)), 400, randomUUID())
  assert.equal((await api(owner, '/doc/list?keyword=' + encodeURIComponent(marker) + '&scope=owned')).total, 1)
  await api(owner, '/doc/' + large.id + '/collaborators/' + reader.user.id, 'DELETE'); large.shared = false
  await api(reader, '/doc/' + large.id + '/export?format=copage', 'GET', undefined, 403)
  const fragmented = await keep(owner, marker + '-fragments')
  let expectedFragments = { ops: [{ insert: '\n' }] }
  for (let batch = 0; batch < 2; batch++) {
    const ops = Array.from({ length: 5000 }, (_, index) => ({ insert: '段', attributes: { bold: (batch * 5000 + index) % 2 === 0 } }))
    expectedFragments = { ops: [...ops, ...expectedFragments.ops] }
    fragmented.hash = hash(expectedFragments)
    await edit(fragmented, ops)
  }
  const many = await api(owner, '/doc/' + fragmented.id)
  assert.deepEqual(many.content, expectedFragments)
  assert.ok(many.content.ops.length > 10000)
  const manyExport = await api(owner, '/doc/' + fragmented.id + '/export?format=copage')
  assert.deepEqual(JSON.parse(manyExport.content).content, many.content)
  await api(owner, '/doc/import', 'POST', file('many.json', manyExport.content, marker + '-too-many'), 400, randomUUID())
  assert.equal((await api(owner, '/doc/list?keyword=' + encodeURIComponent(marker) + '&scope=owned')).total, 2)
  let artifact
  if (process.argv.includes('--keep-export')) {
    artifact = join(tmpdir(), marker + '.copage.json')
    writeFileSync(artifact, exported.content)
  }
  verified = { origin, docIds: records.map(record => record.id), bytes: Buffer.byteLength(JSON.stringify(saved.content)),
    exportBytes: Buffer.byteLength(exported.content), fragments: many.content.ops.length, artifact,
    hashes: records.map(record => ({ id: record.id, revision: record.revision, hash: record.hash })),
    capacityRoundTrip: true, readOnlyExport: true, independentOwnershipAndSnapshot: true, originalRequest: true,
    byteLimitsAndFragmentsRejected: true, revokedExportRejected: true }
} finally {
  channel?.ws.close()
  for (const record of records) {
    const detail = await api(record.auth, '/doc/' + record.id)
    assert.equal(detail.ownerId, record.auth.user.id); assert.equal(detail.title, record.title); assert.equal(detail.revision, record.revision)
    assert.ok(record.hash); assert.equal(hash(detail.content), record.hash)
    const collaborators = await api(record.auth, '/doc/' + record.id + '/collaborators')
    assert.equal(collaborators.length, record.shared ? 1 : 0)
    if (record.shared) {
      assert.equal(collaborators[0].userId, reader.user.id)
      await api(record.auth, '/doc/' + record.id + '/collaborators/' + reader.user.id, 'DELETE')
    }
    await api(record.auth, '/doc/' + record.id, 'DELETE')
  }
  console.log('Capacity fixtures soft-deleted after original ownership/title/revision/body guards; history retained')
}
console.log(JSON.stringify(verified)) // 只有完整校验与全部收尾守卫通过后才报告成功。
