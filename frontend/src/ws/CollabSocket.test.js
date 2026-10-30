import assert from 'node:assert/strict'
import test from 'node:test'
import CollabSocket from './CollabSocket.js'
import CollabClient from './CollabClient.js'
import Delta from 'quill-delta'

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
  return { Socket, timers, network, emit: type => events.dispatchEvent(new Event(type)),
    fireTimeout(id) { const fn = timers.get(id); timers.delete(id); fn() } }
}

test('原页面身份失效后不能首次连接，也不靠联网事件重新绑定新账号', t => {
  const env=browser(t);let current=false,invalidated=0
  const socket=new CollabSocket({token:'A',isCurrent:()=>current,onIdentityChanged:()=>invalidated++})
  socket.connect();assert.equal(env.Socket.instances.length,0);assert.equal(invalidated,1)
  current=true;env.emit('online');socket.connect()
  assert.equal(env.Socket.instances.length,0);assert.equal(env.timers.size,0)
})

test('换号在发送和接收时关闭原通道，丢弃迟到消息且不自动重连', t => {
  const env=browser(t),messages=[];let current=true,invalidated=0
  const socket=new CollabSocket({token:'A',isCurrent:()=>current,onIdentityChanged:()=>invalidated++,onMessage:m=>messages.push(m)})
  socket.connect();const transport=env.Socket.instances[0];transport.open()
  assert.equal(socket.send({type:'cursor'}),true)
  current=false
  assert.equal(socket.send({type:'operation'}),false)
  transport.onmessage({data:JSON.stringify({type:'ack'})})
  env.emit('online');socket.connect()
  assert.equal(transport.sent.length,1);assert.deepEqual(messages,[])
  assert.equal(invalidated,1);assert.equal(env.Socket.instances.length,1);assert.equal(env.timers.size,0)
})

test('身份切换拦截正文发送时仍可完整导出原pending草稿，不消费迟到ACK', t => {
  const env=browser(t);let current=true
  const client=new CollabClient({docId:1,clientId:'original-A',Delta})
  const socket=new CollabSocket({token:'A',isCurrent:()=>current,onMessage:m=>client.receive(m)})
  client.attachSocket(socket);socket.connect();const transport=env.Socket.instances[0];transport.open();client.join()
  client.receive({type:'sync',docId:1,syncId:client.syncId,fromRevision:0,revision:0,historyComplete:true,history:[],pendingCommittedRevision:null,content:{ops:[{insert:'\n'}]}})
  const before=transport.sent.length;current=false
  client.submit(new Delta().insert('必须保留的文字🙂'))
  const originalId=client.pending.opId
  transport.onmessage({data:JSON.stringify({type:'ack',docId:1,clientId:'original-A',opId:originalId,revision:1})})
  assert.equal(transport.sent.length,before)
  const draft=client.exportDraft(new Delta().insert('必须保留的文字🙂\n'))
  assert.equal(draft.pending.opId,originalId)
  assert.deepEqual(draft.content.ops,[{insert:'必须保留的文字🙂\n'}])
  client.close()
})

test('未确认草稿或正文尚未加载时，联网事件不能自行开启协作连接', t => {
  const env = browser(t)
  const socket = new CollabSocket({ token: 'test' })
  env.network.onLine = false
  env.emit('offline')
  env.network.onLine = true
  env.emit('online')
  env.emit('online')
  assert.equal(env.Socket.instances.length, 0)
  assert.equal(env.timers.size, 0)
  socket.connect()
  assert.equal(env.Socket.instances.length, 1)
  socket.close()
})

test('离线时确认开始协作，联网后建立首次连接且不重复连接', t => {
  const env = browser(t)
  env.network.onLine = false
  const socket = new CollabSocket({ token: 'test' })
  socket.connect()
  assert.equal(env.Socket.instances.length, 0)
  env.network.onLine = true
  env.emit('online')
  env.emit('online')
  assert.equal(env.Socket.instances.length, 1)
  socket.close()
})

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
  env.timers.get(socket.heartbeatTimer)()
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
  env.timers.get(socket.heartbeatTimer)()
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

test('心跳回复在转交编辑器前清除超时；保留版本和权限字段', t => {
  const env = browser(t)
  const messages = []
  const socket = new CollabSocket({ token: 'test', onMessage: message => messages.push(message) })
  socket.connect()
  const current = env.Socket.instances[0]
  current.open()
  env.timers.get(socket.heartbeatTimer)()
  assert.deepEqual(current.sent, [{ type: 'ping' }])
  assert.notEqual(socket.pongTimer, null)
  const pong = { type: 'pong', docId: 1, revision: 8, permission: 1 }
  current.onmessage({ data: JSON.stringify(pong) })
  assert.equal(socket.pongTimer, null)
  assert.equal(env.timers.size, 1)
  assert.deepEqual(messages, [pong])
  socket.close()
  assert.equal(env.timers.size, 0)
})

test('OPEN连接缺失心跳时暂停并重连；旧连接迟到回复不能清除新连接超时', t => {
  const env = browser(t)
  let closes = 0
  const errors = []
  const socket = new CollabSocket({ token: 'test', onClose: () => closes++, onError: error => errors.push(error) })
  socket.connect()
  const previous = env.Socket.instances[0]
  previous.open()
  env.timers.get(socket.heartbeatTimer)()
  const expired = env.timers.get(socket.pongTimer)
  env.fireTimeout(socket.pongTimer)
  assert.equal(closes, 1)
  assert.equal(previous.readyState, 3)
  assert.equal(socket.send({ type: 'op' }), false)
  assert.equal(env.timers.size, 1)
  assert.match(errors[0], /响应超时/)
  env.fireTimeout(socket.reconnectTimer)
  const current = env.Socket.instances[1]
  current.open()
  env.timers.get(socket.heartbeatTimer)()
  const deadline = socket.pongTimer
  previous.onmessage({ data: JSON.stringify({ type: 'pong' }) })
  expired()
  assert.equal(socket.pongTimer, deadline)
  assert.equal(closes, 1)
  current.onmessage({ data: JSON.stringify({ type: 'pong' }) })
  assert.equal(socket.pongTimer, null)
  socket.close()
  assert.equal(env.timers.size, 0)
})
