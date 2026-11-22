import { isCollabServerMessage } from './protocol.js'

const connectionLabels = { ready: '已连接', syncing: '正在恢复编辑', offline: '正在重连' }

export function collabConnectionLabel(state, hasUnconfirmedChanges) {
  if (state === 'blocked') return hasUnconfirmedChanges ? '本地内容已保留' : '已暂停'
  return Object.hasOwn(connectionLabels, state) ? connectionLabels[state] : '协同状态待确认'
}

/**
 * 客户端 OT 状态机。
 * pending 是已发送未确认的操作；buffer 是 pending 期间继续输入积累的操作。
 */
export default class CollabClient {
  constructor({ docId, clientId, Delta, onSync, onRemote, onUsers, onCursor, onError, onState }) {
    this.docId = docId
    this.clientId = clientId
    this.Delta = Delta
    this.onSync = onSync
    this.onRemote = onRemote
    this.onUsers = onUsers
    this.onCursor = onCursor
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
    this.observedRevision = 0
    this.pagedRecovery = null
    this.historyRetryTimer = null
    this.historyAttempts = 0
    this.syncFailures = 0
  }

  attachSocket(socket) {
    this.socket = socket
  }

  join() {
    if (this.state === 'blocked') return
    this.clearBusyRetry()
    this.clearHistoryRetry()
    this.pagedRecovery = null
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
    if (!this.socket?.send(message)) { this.disconnect(); return }
    const syncId = this.syncId
    this.historyRetryTimer = globalThis.setTimeout(() => this.handleError({
      code: 500, syncId, message: '等待同步响应超时，正在重试',
    }), 15_000)
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
    if (!isCollabServerMessage(message)) return
    if (message.docId !== undefined && message.docId !== this.docId) return
    if (this.state === 'blocked' || this.state === 'offline') return
    if (this.state === 'syncing' && (message.type === 'op' || message.type === 'ack')) {
      this.observeRevision(message.revision)
      return
    }
    switch (message.type) {
      case 'permission':
        if (message.permission === 0) this.block('文档暂时不可访问，可能已被删除或调整权限。当前内容与未确认修改保留在此页；请返回核对，文档所有者可到回收站查看。')
        else if (message.permission === 1 && this.hasUnconfirmedChanges()) {
          this.block('已改为只读；未确认的本地修改已保留，请复制备份后重新打开文档')
        }
        break
      case 'sync':
        this.synchronize(message)
        break
      case 'history_page':
        this.receiveHistoryPage(message)
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
        if (this.state !== 'ready' || message.clientId === this.clientId ||
            typeof message.clientId !== 'string' || !message.clientId ||
            !Number.isSafeInteger(message.index) || message.index < 0 ||
            !Number.isSafeInteger(message.length) || message.length < 0 ||
            (message.visible !== undefined && typeof message.visible !== 'boolean') ||
            typeof message.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(message.color)) break
        this.onCursor?.({
          clientId: message.clientId,
          index: message.index,
          length: message.length,
          visible: message.visible !== false,
          color: message.color,
          nickname: typeof message.nickname === 'string' && message.nickname.trim()
            ? message.nickname.trim().slice(0, 50) : '协作者',
        })
        break
      case 'presence':
        this.onUsers?.(message.users ?? [])
        break
      case 'pong':
        if (this.state === 'syncing') this.observeRevision(message.revision)
        else if (message.revision > this.revision) this.startIncremental(message.revision)
        else this.sendPending()
        break
      case 'error':
        this.handleError(message)
        break
    }
  }

  synchronize(message) {
    if (this.state !== 'syncing' || message.syncId !== this.syncId) return
    if (!Number.isSafeInteger(message.revision) || message.revision < this.revision) {
      this.block('服务端版本已回退或无法确认，已保留当前内容，请先复制备份')
      return
    }
    const hasLocalChanges = this.hasUnconfirmedChanges()
    if (hasLocalChanges && message.historyPaged === true && message.historyComplete !== true) {
      if (message.fromRevision !== this.revision || message.revision <= this.revision) {
        this.block('分批恢复的版本边界无效，已保留本地内容'); return
      }
      const own = message.pendingCommittedRevision
      if (own != null && (!this.pending || !Number.isSafeInteger(own) || own <= this.revision || own > message.revision)) {
        this.block('分批恢复的操作收据无效，已保留本地内容'); return
      }
      this.beginPagedRecovery(message, false)
      return
    }
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
    this.onUsers?.(message.users ?? [])
    this.finishSync()
  }

  startIncremental(revision) {
    if (!Number.isSafeInteger(revision) || revision <= this.revision) return
    this.clearBusyRetry()
    this.setState('syncing')
    this.syncId = this.newId()
    this.beginPagedRecovery({ docId: this.docId, fromRevision: this.revision, revision }, true)
  }

  beginPagedRecovery(message, live) {
    this.historyAttempts = 0
    this.pagedRecovery = {
      message, live, revision: this.revision,
      receiptKnown: !live || !this.pending,
      pending: this.pending ? { ...this.pending, delta: this.copy(this.pending.delta) } : null,
      buffer: this.buffer ? this.copy(this.buffer) : null,
      editorChange: new this.Delta(),
    }
    this.requestHistoryPage()
  }

  observeRevision(revision) {
    if (Number.isSafeInteger(revision)) this.observedRevision = Math.max(this.observedRevision, revision)
  }

  finishSync() {
    this.clearBusyRetry()
    this.clearHistoryRetry()
    this.busyRetryDelay = 100
    this.syncFailures = 0
    this.pagedRecovery = null
    this.syncId = null
    const observed = this.observedRevision
    this.observedRevision = 0
    if (observed > this.revision) {
      this.startIncremental(observed)
      return
    }
    this.setState('ready')
    this.promoteBuffer()
    this.sendPending()
  }

  requestHistoryPage() {
    const work = this.pagedRecovery
    if (!work || this.state !== 'syncing') return
    this.clearHistoryRetry()
    if (this.historyAttempts >= 4) {
      this.historyUnavailable('追赶历史暂时不可用，已保留本地内容')
      return
    }
    this.historyAttempts++
    const request = { type: 'history_request', docId: this.docId, syncId: this.syncId,
      afterRevision: work.revision, throughRevision: work.message.revision }
    if (!work.receiptKnown) {
      request.pendingOpId = work.pending.opId
      request.pendingBaseRevision = work.pending.baseRevision
      request.pendingOp = work.pending.original
    }
    if (!this.socket?.send(request)) { this.disconnect(); return }
    // 保留已验证的工作副本，只重试同一页；重复页不会重复应用。
    this.historyRetryTimer = globalThis.setTimeout(() => this.requestHistoryPage(), 5000)
  }

  receiveHistoryPage(message) {
    const work = this.pagedRecovery
    if (!work || this.state !== 'syncing' || message.syncId !== this.syncId) return
    if (message.fromRevision < work.revision) return
    const history = message.history
    if (message.fromRevision !== work.revision || message.revision !== work.message.revision
      || !Number.isSafeInteger(message.toRevision) || message.toRevision <= work.revision
      || message.toRevision > message.revision || !Array.isArray(history) || history.length > 256
      || history.length !== message.toRevision - work.revision
      || !history.every((entry, index) => entry.revision === work.revision + index + 1 && Array.isArray(entry.op?.ops))) {
      this.historyUnavailable('分批恢复历史有缺口，已保留本地内容'); return
    }
    if (!work.receiptKnown) {
      const own = message.pendingCommittedRevision
      if (!Object.hasOwn(message, 'pendingCommittedRevision') || (own !== null &&
          (!Number.isSafeInteger(own) || own <= work.revision || own > message.revision))) {
        this.historyUnavailable('追赶时无法确认原操作，已保留本地内容'); return
      }
      work.message.pendingCommittedRevision = own
      work.receiptKnown = true
    }
    try {
      for (const entry of history) {
        if (entry.revision === work.message.pendingCommittedRevision) work.pending = null
        else {
          const result = this.transformRemote(new this.Delta(entry.op), work.pending, work.buffer)
          work.pending = result.pending; work.buffer = result.buffer
          work.editorChange = work.editorChange.compose(result.operation)
        }
      }
    } catch { this.historyUnavailable('分批恢复操作异常，已保留本地内容'); return }
    this.clearBusyRetry()
    this.busyRetryDelay = 100
    this.historyAttempts = 0
    work.revision = message.toRevision
    if (work.revision < message.revision) { this.requestHistoryPage(); return }
    this.clearHistoryRetry()
    this.pending = work.pending; this.buffer = work.buffer; this.revision = work.revision
    if (work.editorChange.ops.length) this.onRemote?.(work.editorChange)
    if (!work.live) {
      this.onSync?.(null, work.message)
      this.onUsers?.(work.message.users ?? [])
    }
    this.finishSync()
  }

  historyUnavailable(message) {
    if (this.pagedRecovery?.live) {
      this.observedRevision = 0
      this.join()
    } else this.block(message)
  }

  handleError(message) {
    if (message.syncId != null && message.syncId !== this.syncId) return
    if (message.code === 40901 || message.code === 500) {
      if (this.pagedRecovery) this.clearHistoryRetry()
      else if (message.code === 500) {
        if (++this.syncFailures >= 4) {
          this.block('协同服务暂时不可用，当前内容已保留，请稍后重新打开'); return
        }
      }
      this.onError?.(message.message)
      this.scheduleBusyRetry()
      return
    }
    if (this.pagedRecovery && [400, 40902, 40903].includes(message.code)) {
      this.historyUnavailable(message.message)
    } else if (message.code === 40902 && this.state === 'ready') this.join()
    else if (message.code === 40903 && this.state === 'ready' && !this.hasUnconfirmedChanges()) this.join()
    else this.block(message.message)
  }

  clearHistoryRetry() {
    if (this.historyRetryTimer !== null) globalThis.clearTimeout(this.historyRetryTimer)
    this.historyRetryTimer = null
  }

  acknowledge(message) {
    if (!this.pending || message.opId !== this.pending.opId || !this.nextRevision(message.revision)) return
    this.clearBusyRetry()
    this.busyRetryDelay = 100
    this.syncFailures = 0
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
      if (this.pagedRecovery) this.requestHistoryPage()
      else if (this.state === 'syncing') this.join()
      else this.sendPending()
    }, this.busyRetryDelay + Math.random() * Math.min(100, this.busyRetryDelay / 4))
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
    this.clearHistoryRetry()
    this.pagedRecovery = null
    this.syncId = null
    this.observedRevision = 0
    this.syncFailures = 0
    if (this.state !== 'blocked') this.setState('offline')
  }

  nextRevision(revision) {
    if (!Number.isSafeInteger(revision)) {
      this.block('收到无效版本，已保留当前内容')
      return false
    }
    if (revision <= this.revision) return false
    if (revision !== this.revision + 1) {
      this.startIncremental(revision)
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

  exportDraft(content, { copy = true } = {}) {
    if (!this.hasUnconfirmedChanges()) return null
    // Synchronous serialization can borrow the current Deltas without deep cloning.
    const snapshot = delta => copy ? this.copy(delta) : delta
    return {
      version: 1,
      docId: this.docId,
      clientId: this.clientId,
      revision: this.revision,
      pending: this.pending ? {
        opId: this.pending.opId,
        baseRevision: this.pending.baseRevision,
        original: snapshot(this.pending.original),
        delta: snapshot(this.pending.delta),
      } : null,
      buffer: this.buffer ? snapshot(this.buffer) : null,
      content: snapshot(content),
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
    this.clearHistoryRetry()
    this.pagedRecovery = null
    this.setState('blocked')
    this.onError?.(message)
  }
}
