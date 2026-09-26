/**
 * 客户端 OT 状态机。
 * pending 是已发送未确认的操作；buffer 是 pending 期间继续输入积累的操作。
 */
export default class CollabClient {
  constructor({ docId, clientId, Delta, onSync, onRemote, onUsers, onError }) {
    this.docId = docId
    this.clientId = clientId
    this.Delta = Delta
    this.onSync = onSync
    this.onRemote = onRemote
    this.onUsers = onUsers
    this.onError = onError
    this.revision = 0
    this.pending = null
    this.buffer = null
    this.socket = null
    this.busyRetryTimer = null
    this.busyRetryDelay = 100
  }

  attachSocket(socket) {
    this.socket = socket
  }

  join() {
    this.socket?.send({ type: 'join', docId: this.docId, clientId: this.clientId, lastRevision: this.revision })
  }

  submit(delta) {
    const operation = new this.Delta(delta)
    if (!operation.ops?.length) return

    if (!this.pending) {
      this.pending = operation
      this.sendPending()
      return
    }
    this.buffer = this.buffer ? this.buffer.compose(operation) : operation
  }

  receive(message) {
    switch (message.type) {
      case 'sync':
        this.clearBusyRetry()
        this.revision = message.revision
        this.pending = null
        this.buffer = null
        this.onSync?.(new this.Delta(message.content), message)
        this.onUsers?.(message.users ?? [])
        break
      case 'ack':
        if (message.clientId === this.clientId) this.acknowledge(message.revision)
        break
      case 'op':
        if (message.originClientId !== this.clientId) this.receiveRemote(new this.Delta(message.op), message.revision)
        break
      case 'cursor':
        // 远端光标渲染层会在 Day 3 消费该消息；此处不改变 OT 状态。
        break
      case 'error':
        this.onError?.(message.message)
        if (message.code === 40901) this.scheduleBusyRetry()
        if (message.code === 40903) this.join()
        break
      default:
        this.onError?.(`未知协同消息：${message.type}`)
    }
  }

  acknowledge(revision) {
    this.clearBusyRetry()
    this.busyRetryDelay = 100
    this.revision = Math.max(this.revision, revision)
    this.pending = null
    if (this.buffer) {
      this.pending = this.buffer
      this.buffer = null
      this.sendPending()
    }
  }

  receiveRemote(remote, revision) {
    let operationForEditor = remote

    if (this.pending) {
      // 服务端远端操作已先提交，因此远端在冲突点有优先级。
      const pendingAfterRemote = remote.transform(this.pending, true)
      operationForEditor = this.pending.transform(remote, false)
      this.pending = pendingAfterRemote
    }
    if (this.buffer) {
      const bufferAfterRemote = operationForEditor.transform(this.buffer, true)
      operationForEditor = this.buffer.transform(operationForEditor, false)
      this.buffer = bufferAfterRemote
    }

    this.revision = Math.max(this.revision, revision)
    this.onRemote?.(operationForEditor)
  }

  sendPending() {
    if (!this.pending) return
    this.socket?.send({
      type: 'op',
      docId: this.docId,
      clientId: this.clientId,
      baseRevision: this.revision,
      op: this.pending,
    })
  }

  scheduleBusyRetry() {
    if (!this.pending || this.busyRetryTimer !== null) return
    this.busyRetryTimer = globalThis.setTimeout(() => {
      this.busyRetryTimer = null
      this.sendPending()
    }, this.busyRetryDelay)
    this.busyRetryDelay = Math.min(this.busyRetryDelay * 2, 2_000)
  }

  clearBusyRetry() {
    if (this.busyRetryTimer !== null) {
      globalThis.clearTimeout(this.busyRetryTimer)
      this.busyRetryTimer = null
    }
  }

  close() {
    this.clearBusyRetry()
  }
}
