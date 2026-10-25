import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import Delta from '../frontend/node_modules/quill-delta/dist/Delta.js'
import CollabClient from '../frontend/src/ws/CollabClient.js'
import { openRecoveryChannel } from './recovery-channel.mjs'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const safeId = value => { assert.ok(Number.isSafeInteger(value) && value > 0); return value }

// Only the production acceptance entry may supply the new random stack. Never
// accept developer ports or identify test data by a title in an existing stack.
export async function runHistoryRestoreCollaborationCheck({ docker, source, sql, ports, username, password }) {
  const config = JSON.parse(source(['config', '--format', 'json']).stdout)
  assert.match(config.name, /^copage-prod-qa-[0-9a-f]{12}$/)
  assert.equal(ports.length, 2); assert.notEqual(ports[0], ports[1])
  for (let i = 0; i < ports.length; i++) {
    safeId(ports[i]); assert.ok(ports[i] <= 65535)
    assert.equal(source(['port', '--index', String(i + 1), 'backend', '8080']).stdout.trim(), `127.0.0.1:${ports[i]}`)
  }
  const containers = source(['ps', '-q', 'mysql', 'backend']).stdout.trim().split(/\s+/)
  assert.equal(containers.length, 3)
  for (const id of containers) {
    assert.match(id, /^[0-9a-f]{12,64}$/)
    assert.equal(docker(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', id]).stdout.trim(), config.name)
  }
  const api = async (port, auth, path, method = 'GET', body, expected = 200) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method, signal: AbortSignal.timeout(20_000),
      headers: { ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const result = await response.json()
    assert.equal(response.status, expected, '隔离历史恢复接口状态不符')
    if (expected === 200) assert.equal(result.code, 0)
    return result
  }
  const owner = (await api(ports[0], null, '/auth/login', 'POST', { username, password })).data
  const credentials = { username: 'hist' + randomBytes(10).toString('hex'), password: randomBytes(32).toString('hex') }
  await api(ports[1], null, '/auth/register', 'POST', credentials)
  const peer = (await api(ports[1], null, '/auth/login', 'POST', credentials)).data
  const peerId = safeId(peer.user.id)
  assert.notEqual(safeId(owner.user.id), peerId)
  const snapshot = id => {
    safeId(id)
    // mysql's batch output escapes JSON backslashes without --raw. HEX keeps
    // the shared SQL helper unchanged and preserves exact newlines/embeds.
    const result = sql(`SELECT HEX(JSON_OBJECT('id',id,'owner',owner_id,'deleted',is_deleted,'revision',revision,'content',JSON_EXTRACT(content,'$'),
      'operations',(SELECT COUNT(*) FROM doc_operation WHERE doc_id=d.id),'receipts',(SELECT COUNT(*) FROM doc_operation_receipt WHERE doc_id=d.id),
      'named',(SELECT COUNT(*) FROM doc_named_version WHERE doc_id=d.id),
      'members',(SELECT GROUP_CONCAT(CONCAT(user_id,':',permission) ORDER BY user_id) FROM doc_collaborator WHERE doc_id=d.id))) FROM document d WHERE id=${id};`, true)
    assert.equal(result.status, 0)
    const encoded = result.stdout.trim()
    assert.match(encoded, /^(?:[0-9A-Fa-f]{2})+$/)
    const row = JSON.parse(Buffer.from(encoded, 'hex').toString('utf8'))
    assert.equal(row.id, id); assert.equal(row.owner, owner.user.id); assert.equal(row.deleted, 0)
    assert.equal(row.revision, row.operations); assert.equal(row.revision, row.receipts)
    assert.equal(row.members, `${peerId}:2`); assert.equal(row.named, 1)
    return row
  }
  const until = async (predicate, label) => {
    const end = Date.now() + 20_000
    while (!predicate()) { assert.ok(Date.now() < end, label); await pause(10) }
  }
  for (const scenario of ['insert', 'format']) {
    const sockets = []
    let client
    try {
      const id = safeId((await api(ports[0], owner.token, '/doc', 'POST', { title: 'history-concurrency-' + randomUUID() })).data.id)
      const base = `/doc/${id}/history`
      await api(ports[0], owner.token, `/doc/${id}/collaborators`, 'POST', { username: credentials.username, permission: 2 })
      const ownerClient = randomUUID()
      const channel = await openRecoveryChannel({ url: `ws://127.0.0.1:${ports[0]}/ws/collab?token=${encodeURIComponent(owner.token)}`,
        docId: id, clientId: ownerClient, phase: 'test' })
      sockets.push(channel.ws)
      const image = { image: 'https://images.example.invalid/history-fixture.png' }
      const saved = new Delta().insert('shared ', { italic: true }).insert('NEW ').insert(image).insert('\n')
      const seed = new Delta().insert('shared ', { italic: true }).insert('NEW ').insert(image)
      assert.equal((await channel.submit(randomUUID(), 0, seed)).revision, 1)
      const edit = new Delta().retain(7).delete(3).insert('OLD')
      assert.equal((await channel.submit(randomUUID(), 1, edit)).revision, 2)
      await api(ports[0], owner.token, base + '/1/name', 'PUT', { name: '保存的文字和图片' })
      assert.deepEqual((await api(ports[1], peer.token, base + '/1')).data.content.ops, saved.ops)
      const before = snapshot(id)
      assert.equal(before.revision, 2)
      assert.equal((await api(ports[1], peer.token, base + '/1/restore', 'POST', { expectedRevision: 2, requestId: randomUUID() }, 403)).code, 403)
      assert.equal((await api(ports[0], owner.token, base + '/1/restore', 'POST', { expectedRevision: 1, requestId: randomUUID() }, 409)).code, 40902)
      assert.deepEqual(snapshot(id), before, '拒绝请求不得改变正文、版本、日志或收据')

      let local = new Delta(), held = true, outgoing = [], failures = [], incoming = [], socketFailure
      const waitPeer = (predicate, label) => until(() => {
        if (socketFailure) throw Error(socketFailure)
        return predicate()
      }, label)
      const peerClient = randomUUID()
      client = new CollabClient({ docId: id, clientId: peerClient, Delta,
        onSync: content => { if (content) local = new Delta(content) },
        onRemote: operation => { local = local.compose(operation) }, onError: message => failures.push(message) })
      const ws = new WebSocket(`ws://127.0.0.1:${ports[1]}/ws/collab?token=${encodeURIComponent(peer.token)}`)
      sockets.push(ws)
      ws.addEventListener('message', event => {
        try {
          const message = JSON.parse(event.data)
          incoming.push(message); client.receive(message)
        } catch { socketFailure = '隔离历史恢复收到无效协作消息' }
      })
      ws.addEventListener('error', () => { socketFailure = '隔离历史恢复协作连接出错' })
      ws.addEventListener('close', () => { socketFailure = '隔离历史恢复协作连接已关闭' })
      await new Promise((resolve, reject) => {
        const finish = failure => {
          clearTimeout(timer)
          ws.removeEventListener('open', opened); ws.removeEventListener('error', failed); ws.removeEventListener('close', failed)
          if (failure) reject(Error('隔离历史恢复协作握手失败或超时'))
          else resolve()
        }
        const opened = () => finish(false), failed = () => finish(true)
        const timer = setTimeout(failed, 20_000)
        ws.addEventListener('open', opened, { once: true }); ws.addEventListener('error', failed, { once: true }); ws.addEventListener('close', failed, { once: true })
      })
      client.attachSocket({ send: message => {
        const bytes = JSON.stringify(message)
        if (held && message.type === 'op') outgoing.push(bytes)
        else ws.send(bytes)
        return true
      } })
      client.join()
      await waitPeer(() => client.state === 'ready' && client.revision === 2, '协作者初始同步超时')
      const pending = scenario === 'insert' ? new Delta().retain(local.length() - 1).insert('晚到😀')
        : new Delta().retain(6, { bold: true })
      local = local.compose(pending); client.submit(pending)
      assert.equal(outgoing.length, 1); assert.ok(client.hasUnconfirmedChanges())
      const wire = outgoing[0]
      const restoreBody = { expectedRevision: 2, requestId: randomUUID() }
      assert.deepEqual((await api(ports[0], owner.token, base + '/1/restore', 'POST', restoreBody)).data, { revision: 3, applied: true })
      await waitPeer(() => client.revision === 3, '跨实例恢复广播未到达待确认客户端')
      assert.equal(snapshot(id).revision, 3, '放行前只允许恢复一个新版本')
      held = false
      for (const bytes of outgoing.splice(0)) ws.send(bytes)
      await waitPeer(() => client.state === 'blocked' || (!client.hasUnconfirmedChanges() && client.revision === 4), '晚到操作确认超时')
      assert.equal(client.state, 'ready', '恢复后协作者不得因合法晚到编辑而阻断')
      assert.deepEqual(failures, [])
      const expected = scenario === 'insert'
        ? new Delta().insert('shared ', { italic: true }).insert('NEW ').insert(image).insert('晚到😀\n')
        : new Delta().insert('shared', { italic: true, bold: true }).insert(' ', { italic: true }).insert('NEW ').insert(image).insert('\n')
      assert.deepEqual(local.ops, expected.ops)
      const after = snapshot(id)
      assert.equal(after.revision, 4); assert.deepEqual(after.content.ops, expected.ops)
      assert.deepEqual((await api(ports[0], owner.token, base + '/1/restore', 'POST', restoreBody)).data, { revision: 3, applied: false })
      const replayStart = incoming.length
      ws.send(wire)
      await waitPeer(() => incoming.slice(replayStart).some(message => message.type === 'ack' && message.opId === JSON.parse(wire).opId), '原ACK重放未返回')
      assert.deepEqual(snapshot(id), after, '恢复/晚到操作原请求重放不得新增或改写')
      assert.deepEqual((await api(ports[1], peer.token, base + '/1')).data.content.ops, saved.ops, '恢复不得改写原版本')
      const continued = new Delta().insert('继续 ')
      local = local.compose(continued); client.submit(continued)
      await waitPeer(() => !client.hasUnconfirmedChanges() && client.revision === 5, '恢复后协作者不能继续编辑')
      assert.deepEqual(snapshot(id).content.ops, expected.compose(continued).ops)
      const current = local
      const same = { expectedRevision: 5, requestId: randomUUID() }
      assert.deepEqual((await api(ports[0], owner.token, base + '/5/restore', 'POST', same)).data, { revision: 6, applied: true })
      await waitPeer(() => client.revision === 6, '相同内容恢复的空操作未推进在线版本')
      assert.deepEqual(local.ops, current.ops); assert.equal(client.state, 'ready')
      const sameRow = snapshot(id)
      assert.equal(sameRow.revision, 6); assert.deepEqual(sameRow.content.ops, current.ops)
      assert.deepEqual(incoming.find(message => message.type === 'op' && message.revision === 6)?.op?.ops, [])
      const emptyOperation = sql(`SELECT HEX(op) FROM doc_operation WHERE doc_id=${id} AND revision=6;`, true)
      assert.equal(emptyOperation.status, 0)
      assert.deepEqual(JSON.parse(Buffer.from(emptyOperation.stdout.trim(), 'hex').toString('utf8')).ops, [])
      console.log(JSON.stringify({ scenario, docId: id, revision: 6, sqlCountsEqual: true,
        concurrentInputPreserved: true, richTextAndEmbed: true, continuedEditing: true, originalAckAndRestoreDeduplicated: true,
        staleAndMemberRestoreRejected: true, originalHistoryPreserved: true, sameContentRestore: true }))
    } finally {
      client?.disconnect()
      for (const ws of sockets) ws.close()
    }
  }
  console.log('PASS: 随机双prod历史恢复、排队插入/格式、完整SQL、继续协作及原收据去重')
}
