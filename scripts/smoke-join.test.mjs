import test from 'node:test'
import assert from 'node:assert/strict'
import { joinForSmoke } from './smoke-join.mjs'

function fixture(responses) {
  const sent = [], cursors = [], messages = []
  return { sent, cursors, client: { messages,
    send: value => sent.push(structuredClone(value)),
    waitFor: async (predicate, after) => {
      cursors.push(after)
      const response = responses.shift(); messages.push(response)
      assert.ok(predicate(response)); return response
    } } }
}
const request = { type: 'join', docId: 41, clientId: 'client', syncId: 'sync', lastRevision: 7,
  pendingOpId: 'original-op', pendingBaseRevision: 6, pendingOp: { ops: [{ insert: '保留😀' }] } }
test('首次同步不重发请求', async () => {
  const f = fixture([{ type: 'sync', syncId: 'sync', revision: 7 }])
  assert.equal((await joinForSmoke(f.client, request)).revision, 7)
  assert.deepEqual(f.sent, [request])
})
test('仅40901有界重试，始终保留原同步标识与pending原请求并推进读取游标', async () => {
  const f = fixture([{ type: 'error', code: 40901 }, { type: 'error', code: 40901 }, { type: 'sync', syncId: 'sync', revision: 8 }])
  const delays = []
  assert.equal((await joinForSmoke(f.client, request, { delay: async ms => delays.push(ms) })).revision, 8)
  assert.deepEqual(f.sent, [request, request, request]); assert.deepEqual(f.cursors, [0, 1, 2])
  assert.deepEqual(delays, [50, 100])
})
test('权限或版本拒绝立即失败，不重发或忽略错误', async () => {
  for (const code of [400, 401, 403, 40903, 500]) {
    const f = fixture([{ type: 'error', code }])
    await assert.rejects(joinForSmoke(f.client, request), new RegExp('code=' + code))
    assert.equal(f.sent.length, 1)
  }
})
test('持续繁忙达到次数后失败，不宣称同步成功', async () => {
  const f = fixture(Array.from({ length: 3 }, () => ({ type: 'error', code: 40901 })))
  await assert.rejects(joinForSmoke(f.client, request, { attempts: 3, delay: async () => {} }), /验收终止/)
  assert.equal(f.sent.length, 3)
})
