import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const origin = process.env.COPAGE_SEARCH_ORIGIN || 'http://localhost:8080'
const peer = process.env.COPAGE_SEARCH_PEER_ORIGIN || 'http://localhost:8082'
const marker = 'uc' + randomUUID().replaceAll('-', '')
const records = []
let owner, reader
async function api(base, token, path, method = 'GET', body) {
  const form = body instanceof FormData
  const response = await fetch(base + '/api' + path, {
    method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(!form && body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: form ? body : body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  })
  const result = await response.json()
  assert.equal(response.status, 200, method + ' ' + path + ': ' + result.message)
  assert.equal(result.code, 0)
  return result.data
}
async function create(title, content) {
  let body, path
  if (content === undefined) { path = '/doc'; body = { title } }
  else {
    path = '/doc/import'; body = new FormData()
    body.append('file', new Blob([JSON.stringify({ format: 'copage', version: 1, title,
      content: { ops: [{ insert: content }] } })]), 'unicode.json')
  }
  const doc = await api(origin, owner.token, path, 'POST', body)
  const record = { id: doc.id, title }; records.push(record)
  return record
}
const search = (base, token, query) => api(base, token, '/search?' + new URLSearchParams({ q: query, size: 100 }))
try {
  owner = await api(origin, null, '/auth/login', 'POST', { username: 'testA', password: '123456' })
  reader = await api(origin, null, '/auth/login', 'POST', { username: 'testB', password: '123456' })
  const titleQuery = marker + 'title', bodyQuery = marker + 'body', windowQuery = marker + 'window'
  const title = await create('İ ' + titleQuery)
  const body = await create(marker + '-body-fixture', '中文 İ ' + bodyQuery + ' <script>文字</script>\n')
  const window = await create(marker + '-window-fixture', 'a😀' + 'b'.repeat(58) + ' ' + windowQuery + ' ' + 'a'.repeat(78) + '😀末\n')
  const cases = [
    [title, titleQuery, 'İ <strong>' + titleQuery + '</strong>'],
    [body, bodyQuery, '中文 İ <strong>' + bodyQuery + '</strong> &lt;script&gt;文字&lt;/script&gt;\n'],
    [window, windowQuery, '…😀' + 'b'.repeat(58) + ' <strong>' + windowQuery + '</strong> ' + 'a'.repeat(78) + '😀…'],
  ]
  for (const [record, query] of cases) {
    const hidden = await search(peer, reader.token, query)
    assert.equal(hidden.total, 0); assert.deepEqual(hidden.list, [])
    await api(origin, owner.token, '/doc/' + record.id + '/collaborators', 'POST', { username: 'testB', permission: 1 })
  }
  for (const base of new Set([origin, peer])) {
    for (const [record, query, expected] of cases) {
      for (const token of [owner.token, reader.token]) {
        const result = await search(base, token, query.toUpperCase())
        assert.equal(result.total, 1); assert.equal(result.list[0].id, record.id)
        assert.equal(result.list[0].snippet, expected)
        assert.equal(result.list[0].snippet.isWellFormed(), true)
      }
    }
  }
  await api(origin, owner.token, '/doc/' + title.id + '/collaborators/' + reader.user.id, 'DELETE')
  assert.equal((await search(peer, reader.token, titleQuery)).total, 0)
  console.log(JSON.stringify({ origin, peer, docIds: records.map(record => record.id),
    unicodeTitleAndBody: true, intactSurrogatePairs: true, escapedHtml: true, currentPermissions: true }))
} finally {
  for (const record of records) {
    const detail = await api(origin, owner.token, '/doc/' + record.id)
    assert.equal(detail.title, record.title); assert.equal(detail.ownerId, owner.user.id); assert.equal(detail.revision, 0)
    const members = await api(origin, owner.token, '/doc/' + record.id + '/collaborators')
    assert.ok(members.every(member => member.userId === reader.user.id), '合成文档出现未预期成员，停止清理')
    for (const member of members) await api(origin, owner.token, '/doc/' + record.id + '/collaborators/' + member.userId, 'DELETE')
    await api(origin, owner.token, '/doc/' + record.id, 'DELETE')
  }
}
