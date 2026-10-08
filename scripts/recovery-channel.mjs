import { randomUUID } from 'node:crypto'

const types = new Set(['sync', 'op', 'ack', 'error', 'permission', 'presence', 'cursor', 'pong'])
const phases = new Set(['source', 'restored-readonly', 'restored-owner', 'test'])

// 验证器专用；诊断只含阶段/文档/协议元数据，不输出URL、令牌或正文。
export async function openRecoveryChannel({ url, docId, clientId, lastRevision = 0, phase = 'source',
  timeoutMs = 20_000, createSocket = value => new WebSocket(value) }) {
  if (!Number.isSafeInteger(docId) || docId <= 0 || !phases.has(phase)) throw new Error('恢复验证上下文无效')
  const messages = [], waiters = new Set()
  let terminal, opened = false, openDone, openFail
  const failure = (stage, reason) => {
    const recent = messages.slice(-4).map(message => ({
      type: types.has(message.type) ? message.type : 'unknown',
      ...(Number.isSafeInteger(message.code) ? { code: message.code } : {}),
      ...(Number.isSafeInteger(message.revision) ? { revision: message.revision } : {}),
    }))
    return new Error(`恢复验证 ${phase}/${stage} doc=${docId}: ${reason}; recent=${JSON.stringify(recent)}`)
  }
  let ws
  try { ws = createSocket(url) } catch { throw failure('handshake', '连接创建失败') }
  const abort = reason => {
    terminal ??= reason
    if (!opened) openFail(terminal)
    for (const waiter of [...waiters]) waiter.reject(failure(waiter.stage, terminal))
  }
  const handshake = new Promise((resolve, reject) => {
    const timer = setTimeout(() => abort('握手超时'), timeoutMs)
    openDone = () => { clearTimeout(timer); opened = true; resolve() }
    openFail = reason => { clearTimeout(timer); reject(failure('handshake', reason)) }
  })
  ws.addEventListener('open', openDone, { once: true })
  ws.addEventListener('error', () => abort('连接出错'))
  ws.addEventListener('close', event => abort(`连接关闭(code=${Number.isSafeInteger(event.code) ? event.code : 'unknown'})`))
  ws.addEventListener('message', event => {
    let message
    try {
      message = JSON.parse(event.data)
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error()
    } catch { abort('协议消息无效'); return }
    messages.push(message)
    for (const waiter of [...waiters]) if (waiter.predicate(message)) waiter.resolve(message)
  })
  const wait = (predicate, after, stage) => {
    const existing = messages.slice(after).find(predicate)
    if (existing) return Promise.resolve(existing)
    if (terminal) return Promise.reject(failure(stage, terminal))
    return new Promise((resolve, reject) => {
      const finish = (callback, value) => { clearTimeout(timer); waiters.delete(waiter); callback(value) }
      const waiter = { predicate, stage, resolve: value => finish(resolve, value), reject: error => finish(reject, error) }
      const timer = setTimeout(() => waiter.reject(failure(stage, '等待消息超时')), timeoutMs)
      waiters.add(waiter)
    })
  }
  const send = (payload, stage) => {
    if (terminal) throw failure(stage, terminal)
    try { ws.send(JSON.stringify(payload)) } catch { throw failure(stage, '发送失败') }
  }
  try {
    if (ws.readyState === 1) openDone()
    await handshake
    const syncId = randomUUID()
    send({ type: 'join', docId, clientId, lastRevision, syncId }, 'join')
    const sync = await wait(message => (message.type === 'sync' && message.syncId === syncId) || message.type === 'error', 0, 'join')
    if (sync.type !== 'sync') throw failure('join', `服务器拒绝(code=${Number.isSafeInteger(sync.code) ? sync.code : 'unknown'})`)
    return { ws, sync, async submit(opId, baseRevision, op, expectedType = 'ack') {
      const after = messages.length
      send({ type: 'op', docId, clientId, opId, baseRevision, op }, 'operation')
      const reply = await wait(message => (message.type === 'ack' && message.opId === opId) || message.type === 'error', after, 'operation')
      if (reply.type !== expectedType) throw failure('operation', `响应类型不符(code=${Number.isSafeInteger(reply.code) ? reply.code : 'unknown'})`)
      return reply
    } }
  } catch (error) {
    try { ws.close() } catch { }
    throw error
  }
}
