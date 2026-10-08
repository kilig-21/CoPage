import assert from 'node:assert/strict'
import test from 'node:test'
import { openRecoveryChannel } from './recovery-channel.mjs'

class Socket extends EventTarget {
  readyState = 0
  sent = []
  constructor(reply = () => {}) { super(); this.reply = reply; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) }) }
  emit(type, properties) { this.dispatchEvent(Object.assign(new Event(type), properties)) }
  message(value) { this.emit('message', { data: JSON.stringify(value) }) }
  send(value) { const message = JSON.parse(value); this.sent.push(message); this.reply(message, this) }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', { code: 1000 }) }
}
const options = socket => ({ url: 'ws://fixture.invalid/?token=PRIVATE_TOKEN', docId: 9, clientId: 'client', phase: 'test', createSocket: () => socket, timeoutMs: 100 })
const sync = (message, socket) => { if (message.type === 'join') socket.message({ type: 'sync', syncId: message.syncId, revision: 20 }) }

test('同步和确认在send中立即到达时不丢响应；旧ack不能确认下一条操作', async () => {
  const socket = new Socket((message, socket) => {
    sync(message, socket)
    if (message.type === 'op') { socket.message({ type: 'ack', opId: 'old', revision: 1 }); socket.message({ type: 'ack', opId: message.opId, revision: 21 }) }
  })
  const channel = await openRecoveryChannel(options(socket))
  assert.equal(channel.sync.revision, 20)
  assert.equal((await channel.submit('new', 20, { ops: [{ insert: 'text' }] })).revision, 21)
  socket.close()
})

test('等待join时关闭立即报告阶段和关闭码，隐藏关闭原因与URL', async () => {
  const socket = new Socket((message, socket) => { if (message.type === 'join') socket.emit('close', { code: 1008, reason: 'PRIVATE_PASSWORD' }) })
  await assert.rejects(openRecoveryChannel(options(socket)), error => {
    assert.match(error.message, /test\/join doc=9.*code=1008/)
    assert.doesNotMatch(error.message, /PRIVATE|fixture.invalid/)
    return true
  })
})

test('握手错误有界拒绝，不泄漏原始错误消息', async () => {
  const socket = new EventTarget()
  socket.close = () => {}
  const result = openRecoveryChannel(options(socket))
  socket.dispatchEvent(Object.assign(new Event('error'), { message: 'PRIVATE_TOKEN' }))
  await assert.rejects(result, error => {
    assert.match(error.message, /test\/handshake.*连接出错/); assert.doesNotMatch(error.message, /PRIVATE/); return true
  })
})

test('握手不完成会有界超时', async () => {
  const socket = new EventTarget(); socket.close = () => {}
  await assert.rejects(openRecoveryChannel({ ...options(socket), timeoutMs: 5 }), /handshake.*握手超时/)
})

test('join明确错误立即报告code，不把服务器自由文本放入诊断', async () => {
  const socket = new Socket((message, socket) => { if (message.type === 'join') socket.message({ type: 'error', code: 401, message: 'PRIVATE_PASSWORD' }) })
  await assert.rejects(openRecoveryChannel(options(socket)), error => {
    assert.match(error.message, /join.*code=401/); assert.doesNotMatch(error.message, /PRIVATE/); return true
  })
})

test('操作等待期间连接关闭立即失败；关闭后不再发送操作', async () => {
  const socket = new Socket(sync), channel = await openRecoveryChannel(options(socket))
  const pending = channel.submit('one', 20, { ops: [{ insert: 'PRIVATE_DOCUMENT' }] })
  socket.emit('close', { code: 1006 })
  await assert.rejects(pending, /operation.*code=1006/)
  const sent = socket.sent.length
  await assert.rejects(channel.submit('two', 20, {}), /operation.*code=1006/)
  assert.equal(socket.sent.length, sent)
  socket.close()
})

test('未收到ack时诊断仅含近期协议元数据，不含正文', async () => {
  const socket = new Socket((message, socket) => { sync(message, socket); if (message.type === 'op') socket.message({ type: 'pong', revision: 20, content: 'PRIVATE_DOCUMENT' }) })
  const channel = await openRecoveryChannel({ ...options(socket), timeoutMs: 5 })
  await assert.rejects(channel.submit('one', 20, {}), error => {
    assert.match(error.message, /operation.*等待消息超时.*pong.*20/); assert.doesNotMatch(error.message, /PRIVATE/); return true
  })
  socket.close()
})
