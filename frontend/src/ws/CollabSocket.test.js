import assert from 'node:assert/strict'
import test from 'node:test'
import CollabSocket from './CollabSocket.js'

function browser(t) {
  const original = Object.fromEntries(['window', 'navigator', 'WebSocket'].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const events = new EventTarget()
  const timers = new Map()
  let nextTimer = 0
  const network = { onLine: true }
  class Socket {
    static OPEN = 1
    static CONNECTING = 0
    static instances = []
    constructor() { this.readyState = 0; this.sent = []; Socket.instances.push(this) }
    open() { this.readyState = 1; this.onopen?.() }
    send(message) { this.sent.push(JSON.parse(message)) }
    close() { this.readyState = 3; this.onclose?.() }
  }
  const surface = {
    location: { protocol: 'http:', host: 'localhost:5173' },
    addEventListener: (...args) => events.addEventListener(...args),
    removeEventListener: (...args) => events.removeEventListener(...args),
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer },
    setInterval: fn => { timers.set(++nextTimer, fn); return nextTimer },
    clearTimeout: id => timers.delete(id),
    clearInterval: id => timers.delete(id),
  }
  for (const [key, value] of Object.entries({ window: surface, navigator: network, WebSocket: Socket })) {
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  t.after(() => {
    for (const key of Object.keys(original)) {
      if (original[key]) Object.defineProperty(globalThis, key, original[key])
      else delete globalThis[key]
    }
  })
  return { Socket, timers, network, emit: type => events.dispatchEvent(new Event(type)) }
}

test('浏览器离线立即关闭旧连接，停止发送；联网创建新连接且忽略旧消息', t => {
  const env = browser(t)
  const messages = []
  let closes = 0
  let opens = 0
  const socket = new CollabSocket({ token: 'test', onClose: () => closes++,
    onOpen: () => opens++, onMessage: message => messages.push(message) })
  socket.connect()
  const previous = env.Socket.instances[0]
  previous.open()
  assert.equal(opens, 1)
  env.network.onLine = false
  env.emit('offline')
  env.emit('offline')
  assert.equal(closes, 1)
  assert.equal(previous.readyState, 3)
  assert.equal(socket.send({ type: 'op' }), false)
  assert.equal(env.timers.size, 0)
  previous.onmessage({ data: JSON.stringify({ type: 'op', revision: 1 }) })
  socket.connect()
  assert.equal(env.Socket.instances.length, 1)
  env.network.onLine = true
  env.emit('online')
  const current = env.Socket.instances[1]
  current.open()
  current.onmessage({ data: JSON.stringify({ type: 'sync', revision: 1 }) })
  assert.equal(opens, 2)
  assert.deepEqual(messages, [{ type: 'sync', revision: 1 }])
  assert.equal(socket.send({ type: 'ping' }), true)
  assert.deepEqual(current.sent, [{ type: 'ping' }])
  socket.close()
  assert.equal(env.timers.size, 0)
})

test('主动关闭后移除网络监听，后续联网或 connect 不得复活旧编辑器', t => {
  const env = browser(t)
  let closes = 0
  const socket = new CollabSocket({ token: 'test', onClose: () => closes++ })
  socket.connect()
  env.Socket.instances[0].open()
  socket.close()
  env.network.onLine = false
  env.emit('offline')
  env.network.onLine = true
  env.emit('online')
  socket.connect()
  assert.equal(closes, 0)
  assert.equal(env.Socket.instances.length, 1)
  assert.equal(env.timers.size, 0)
})

test('正常断线仍安排重连；离线期间取消定时器，联网只创建一条连接', t => {
  const env = browser(t)
  const socket = new CollabSocket({ token: 'test' })
  socket.connect()
  env.Socket.instances[0].open()
  env.Socket.instances[0].close()
  assert.equal(env.timers.size, 1)
  env.network.onLine = false
  env.emit('offline')
  assert.equal(env.timers.size, 0)
  env.network.onLine = true
  env.emit('online')
  env.emit('online')
  assert.equal(env.Socket.instances.length, 2)
  socket.close()
})
