/**
 * 客户端 OT 状态机。
 * pending 是已发送未确认的操作；buffer 是 pending 期间继续输入积累的操作。
 */
export default class CollabClient {
  constructor({ docId, clientId, Delta, onSync, onRemote, onUsers, onError, onState }) {
    this.docId = docId
    this.clientId = clientId
    this.Delta = Delta
    this.onSync = onSync
    this.onRemote = onRemote
    this.onUsers = onUsers
    this.onError = onError
    this.onState = onState
    this.revision = 0
    this.pending = null
    this.buffer = null
    this.socket = null
    this.busyRetryTimer = null
    this.busyRetryDelay = 100
    this.state = 'offline'
    this.syncId = null
    this.deferred = []
    this.deferredOverflow = false
  }

  attachSocket(socket) {
    this.socket = socket
  }

  join() {
    if (this.state === 'blocked') return
    this.clearBusyRetry()
    this.setState('syncing')
    this.syncId = this.newId()
    const message = {
      type: 'join', docId: this.docId, clientId: this.clientId,
      lastRevision: this.revision, syncId: this.syncId,
    }
    if (this.pending) {
      message.pendingOpId = this.pending.opId
      message.pendingBaseRevision = this.pending.baseRevision
      message.pendingOp = this.pending.original
    }
    if (!this.socket?.send(message)) this.disconnect()
  }

  submit(delta) {
    const operation = new this.Delta(delta)
    if (!operation.ops?.length) return

    if (!this.pending) {
      this.pending = this.createPending(operation)
      this.sendPending()
      return
    }
    this.buffer = this.buffer ? this.buffer.compose(operation) : operation
  }

  receive(message) {
    if (message.docId !== undefined && message.docId !== this.docId) return
    if (this.state === 'blocked' || this.state === 'offline') return
    if (this.state === 'syncing' && (message.type === 'op' || message.type === 'ack')) {
      if (this.deferred.length < 2000) this.deferred.push(message)
      else this.deferredOverflow = true
      return
    }
    switch (message.type) {
      case 'sync':
        this.synchronize(message)
        break
      case 'ack':
        if (message.clientId === this.clientId) this.acknowledge(message)
        break
      case 'op':
        if (!this.nextRevision(message.revision)) break
        if (message.originClientId === this.clientId && message.opId === this.pending?.opId) {
          this.acknowledge(message)
        } else {
          this.receiveRemote(new this.Delta(message.op), message.revision)
        }
        break
      case 'cursor':
        // 远端光标渲染层会在 Day 3 消费该消息；此处不改变 OT 状态。
        break
      case 'presence':
        this.onUsers?.(message.users ?? [])
        break
      case 'pong':
        if (this.state === 'syncing' || message.revision > this.revision) this.join()
        else this.sendPending()
        break
      case 'error':
        this.onError?.(message.message)
        if (message.code === 40901) this.scheduleBusyRetry()
        else if (message.code === 40902) this.join()
        else if (message.code === 40903 && !this.hasUnconfirmedChanges()) this.join()
        else if (message.code === 500) {
          if (this.state === 'syncing') this.scheduleBusyRetry()
          else this.join()
        } else this.block(message.message)
        break
      default:
        this.onError?.(`未知协同消息：${message.type}`)
    }
  }

  synchronize(message) {
    if (this.state !== 'syncing' || message.syncId !== this.syncId) return
    if (!Number.isSafeInteger(message.revision) || message.revision < 0) {
      this.block('同步版本无效，已保留当前内容')
      return
    }
    const hasLocalChanges = this.hasUnconfirmedChanges()
    if (hasLocalChanges) {
      const history = message.history
      const ownRevision = message.pendingCommittedRevision
      const validOwnRevision = ownRevision == null || (this.pending
        && Number.isSafeInteger(ownRevision) && ownRevision > this.revision && ownRevision <= message.revision)
      const complete = message.historyComplete === true && message.fromRevision === this.revision
        && Array.isArray(history) && history.length === message.revision - this.revision
        && history.every((entry, index) => entry.revision === this.revision + index + 1 && entry.op?.ops)
      if (!complete || !validOwnRevision) {
        this.block('无法完整恢复编辑历史，已保留本地内容；请先复制备份')
        return
      }
      // 先在副本上计算全部追赶操作，验证失败时不触碰编辑器及原队列。
      let pending = this.pending ? { ...this.pending, delta: this.copy(this.pending.delta) } : null
      let buffer = this.buffer ? this.copy(this.buffer) : null
      let editorChange = new this.Delta()
      try {
        for (const entry of history) {
          if (entry.revision === ownRevision) {
            pending = null
          } else {
            const result = this.transformRemote(new this.Delta(entry.op), pending, buffer)
            pending = result.pending
            buffer = result.buffer
            editorChange = editorChange.compose(result.operation)
          }
        }
      } catch {
        this.block('恢复编辑时发现操作异常，已保留本地内容；请先复制备份')
        return
      }
      this.pending = pending
      this.buffer = buffer
      this.revision = message.revision
      if (editorChange.ops.length) this.onRemote?.(editorChange)
      this.onSync?.(null, message)
    } else {
      this.revision = message.revision
      this.onSync?.(new this.Delta(message.content), message)
    }
    this.clearBusyRetry()
    this.busyRetryDelay = 100
    this.syncId = null
    this.onUsers?.(message.users ?? [])
    this.setState('ready')
    const deferred = this.deferred
    const overflow = this.deferredOverflow
    this.deferred = []
    this.deferredOverflow = false
    if (overflow) {
      this.join()
      return
    }
    for (const entry of deferred) this.receive(entry)
    if (this.state === 'ready') {
      this.promoteBuffer()
      this.sendPending()
    }
  }

  acknowledge(message) {
    if (!this.pending || message.opId !== this.pending.opId || !this.nextRevision(message.revision)) return
    this.clearBusyRetry()
    this.busyRetryDelay = 100
    this.revision = message.revision
    this.pending = null
    this.promoteBuffer()
    this.sendPending()
  }

  promoteBuffer() {
    if (this.pending) return
    if (this.buffer) {
      this.pending = this.createPending(this.buffer)
      this.buffer = null
    }
  }

  receiveRemote(remote, revision) {
    const result = this.transformRemote(remote, this.pending, this.buffer)
    this.pending = result.pending
    this.buffer = result.buffer
    this.revision = revision
    this.onRemote?.(result.operation)
  }

  transformRemote(remote, pending, buffer) {
    let operationForEditor = remote
    if (pending) {
      // 服务端远端操作已先提交，因此远端在冲突点有优先级。
      const pendingAfterRemote = remote.transform(pending.delta, true)
      operationForEditor = pending.delta.transform(remote, false)
      pending = { ...pending, delta: pendingAfterRemote }
    }
    if (buffer) {
      const bufferAfterRemote = operationForEditor.transform(buffer, true)
      operationForEditor = buffer.transform(operationForEditor, false)
      buffer = bufferAfterRemote
    }
    return { pending, buffer, operation: operationForEditor }
  }

  sendPending() {
    if (!this.pending || this.state !== 'ready') return
    this.socket?.send({
      type: 'op',
      docId: this.docId,
      clientId: this.clientId,
      opId: this.pending.opId,
      baseRevision: this.pending.baseRevision,
      op: this.pending.original,
    })
  }

  scheduleBusyRetry() {
    if (this.busyRetryTimer !== null) return
    this.busyRetryTimer = globalThis.setTimeout(() => {
      this.busyRetryTimer = null
      if (this.state === 'syncing') this.join()
      else this.sendPending()
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
    this.disconnect()
  }

  disconnect() {
    this.clearBusyRetry()
    this.syncId = null
    this.deferred = []
    this.deferredOverflow = false
    if (this.state !== 'blocked') this.setState('offline')
  }

  nextRevision(revision) {
    if (!Number.isSafeInteger(revision)) {
      this.block('收到无效版本，已保留当前内容')
      return false
    }
    if (revision <= this.revision) return false
    if (revision !== this.revision + 1) {
      this.join()
      return false
    }
    return true
  }

  createPending(delta) {
    return { opId: this.newId(), baseRevision: this.revision, original: this.copy(delta), delta: this.copy(delta) }
  }

  copy(delta) {
    return new this.Delta(JSON.parse(JSON.stringify(delta)))
  }

  newId() {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  hasUnconfirmedChanges() {
    return this.pending !== null || this.buffer !== null
  }

  exportDraft(content) {
    if (!this.hasUnconfirmedChanges()) return null
    return {
      version: 1,
      docId: this.docId,
      clientId: this.clientId,
      revision: this.revision,
      pending: this.pending ? {
        opId: this.pending.opId,
        baseRevision: this.pending.baseRevision,
        original: this.copy(this.pending.original),
        delta: this.copy(this.pending.delta),
      } : null,
      buffer: this.buffer ? this.copy(this.buffer) : null,
      content: this.copy(content),
      savedAt: Date.now(),
    }
  }

  restoreDraft(draft) {
    if (draft?.version !== 1 || draft.docId !== this.docId ||
        typeof draft.clientId !== 'string' || !draft.clientId ||
        !Number.isSafeInteger(draft.revision) || draft.revision < 0 ||
        !Array.isArray(draft.content?.ops) ||
        (!draft.pending && !draft.buffer)) throw new Error('本地草稿格式无效')
    const pending = draft.pending
    if (pending && (typeof pending.opId !== 'string' || !pending.opId ||
        !Number.isSafeInteger(pending.baseRevision) || pending.baseRevision < 0 ||
        pending.baseRevision > draft.revision ||
        !Array.isArray(pending.original?.ops) || !Array.isArray(pending.delta?.ops))) {
      throw new Error('本地草稿中的未确认操作无效')
    }
    if (draft.buffer && !Array.isArray(draft.buffer.ops)) throw new Error('本地草稿中的缓冲操作无效')
    this.clientId = draft.clientId
    this.revision = draft.revision
    this.pending = pending ? {
      opId: pending.opId,
      baseRevision: pending.baseRevision,
      original: this.copy(pending.original),
      delta: this.copy(pending.delta),
    } : null
    this.buffer = draft.buffer ? this.copy(draft.buffer) : null
    return this.copy(draft.content)
  }

  setState(state) {
    this.state = state
    this.onState?.(state)
  }

  block(message) {
    this.clearBusyRetry()
    this.setState('blocked')
    this.onError?.(message)
  }
}
