import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { openRecoveryChannel } from './recovery-channel.mjs'

export async function runRedisRetentionCheck({ ports, username, password, source, sql }) {
  const project = JSON.parse(source(['config', '--format', 'json']).stdout).name
  assert.match(project, /^copage-prod-qa-[0-9a-f]{12}$/, '只允许操作本轮随机隔离项目')
  for (const [index, port] of ports.entries()) {
    assert.equal(source(['port', '--index', String(index + 1), 'backend', '8080']).stdout.trim(), `127.0.0.1:${port}`)
  }

  const redis = (...args) => source(['exec', '-T', 'redis', 'sh', '-ec',
    'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw "$@"', 'redis-cli', ...args]).stdout.trim()
  const index = 'collab:presence:active-docs'
  const cacheKeys = id => ['content', 'revision', 'ops'].map(segment => `collab:doc:${segment}:${id}`)
  const presenceKeys = id => [`collab:presence:sessions:${id}`, `collab:presence:users:${id}`]
  const exists = (...keys) => Number(redis('EXISTS', ...keys))
  const ttl = key => Number(redis('PTTL', key))
  const scanCalls = () => Number(/cmdstat_scan:calls=(\d+)/.exec(redis('INFO', 'commandstats'))?.[1] ?? 0)
  const scansBefore = scanCalls()
  const revision = id => Number(sql(`SELECT revision FROM document WHERE id = ${id};`).stdout.trim())
  const eventually = async (condition, ms, message) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (condition()) return
      await pause(200)
    }
    assert.fail(message)
  }

  let token
  const api = async (port, path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method, signal: AbortSignal.timeout(15000),
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    assert.equal(response.status, 200, path)
    const result = await response.json()
    assert.equal(result.code, 0, path)
    return result.data
  }
  const create = async () => {
    const { id } = await api(ports[0], '/doc', 'POST', { title: 'RedisRetentionFixture' })
    assert.ok(Number.isSafeInteger(id) && id > 0)
    return id
  }
  const channels = []
  const connect = async (port, docId, lastRevision = 0) => {
    const channel = await openRecoveryChannel({
      url: `ws://127.0.0.1:${port}/ws/collab`, token, docId, lastRevision, clientId: randomUUID(),
    })
    channels.push(channel)
    return channel
  }
  try {
    token = (await api(ports[0], '/auth/login', 'POST', { username, password })).token
    const id = await create()
    const [sessions, users] = presenceKeys(id)
    const primary = await connect(ports[0], id)
    const primaryMember = redis('ZRANGE', sessions, '0', '0')
    assert.ok(primaryMember)
    await connect(ports[1], id)
    const members = redis('ZRANGE', sessions, '0', '-1').split(/\r?\n/)
    assert.equal(members.length, 2)
    const peerMember = members.find(member => member !== primaryMember)
    assert.ok(peerMember)
    assert.notEqual(peerMember.split(':')[0], primaryMember.split(':')[0])
    assert.ok(ttl(sessions) > 75000 && ttl(users) > 75000, '两个在线状态键须有原生 TTL')

    // 仅推进一个隔离租约和索引的截止时间，保留另一实例的真实在线会话。
    redis('EVAL', "redis.call('zadd', KEYS[1], 0, ARGV[1]); redis.call('zadd', KEYS[2], 0, ARGV[2]); return 1",
      '2', sessions, index, primaryMember, String(id))
    await eventually(() => redis('HEXISTS', users, primaryMember) === '0', 13000, '巡检未清理过期会话')
    assert.equal(redis('ZRANGE', sessions, '0', '-1'), peerMember)
    assert.equal(redis('HEXISTS', users, peerMember), '1')
    assert.equal(redis('ZSCORE', index, String(id)), redis('ZSCORE', sessions, peerMember))

    // 仍在线且有权限的连接可以在心跳时重新登记，不能影响另一个实例。
    primary.ws.send(JSON.stringify({ type: 'ping' }))
    await eventually(() => redis('ZCARD', sessions) === '2', 6000, '有效心跳未重新登记在线租约')
    assert.equal((await primary.submit(randomUUID(), 0, { ops: [{ insert: 'Redis' }] })).revision, 1)
    for (const key of cacheKeys(id)) assert.ok(ttl(key) > 0 && ttl(key) <= 12000, `缓存 TTL 缺失: ${key}`)
    await eventually(() => exists(...cacheKeys(id)) === 0, 18000, 'Redis 热状态未按配置过期')
    assert.equal(exists(sessions, users), 2)
    assert.equal(revision(id), 1)
    const afterExpiry = await connect(ports[1], id)
    assert.equal(afterExpiry.sync.revision, 1)
    assert.equal(afterExpiry.sync.history[0].revision, 1)
    assert.deepEqual(afterExpiry.sync.content.ops, [{ insert: 'Redis\n' }])

    assert.equal((await afterExpiry.submit(randomUUID(), 1, { ops: [{ retain: 5 }, { insert: ' OK' }] })).revision, 2)
    assert.equal(exists(...cacheKeys(id), sessions, users), 5)
    await api(ports[0], `/doc/${id}`, 'DELETE')
    assert.equal(exists(...cacheKeys(id), sessions, users), 0)
    assert.equal(redis('ZSCORE', index, String(id)), '')
    assert.equal(revision(id), 2)
    await api(ports[1], `/doc/${id}/restore`, 'POST')
    const restored = await connect(ports[1], id, 2)
    assert.equal(restored.sync.revision, 2)
    assert.deepEqual(restored.sync.content.ops, [{ insert: 'Redis OK\n' }])

    const legacy = await create()
    const [content, version, operations] = cacheKeys(legacy)
    const operation = { ops: [{ insert: 'Legacy' }] }
    redis('SET', content, JSON.stringify({ ops: [{ insert: 'Legacy\n' }] }))
    redis('SET', version, '1')
    redis('ZADD', operations, '1', JSON.stringify({ revision: 1, operation }))
    await api(ports[0], `/doc/${legacy}`, 'DELETE')
    assert.equal(exists(content, version, operations), 3)
    assert.equal(ttl(version), -1)
    assert.equal(revision(legacy), 0)
    await api(ports[1], `/doc/${legacy}/restore`, 'POST')
    const reconciled = await connect(ports[1], legacy)
    assert.equal(reconciled.sync.revision, 1)
    assert.equal(revision(legacy), 1)
    assert.ok(ttl(content) > 0 && ttl(version) > 0 && ttl(operations) > 0)
    assert.equal(scanCalls(), scansBefore, '在线巡检不得在 Redis 执行 SCAN')
    console.log('PASS: 双实例在线租约、心跳重新登记、Redis 热缓存原生过期、删除/恢复、旧版本补写与零 SCAN')

    const idleId = await create()
    const idleKeys = presenceKeys(idleId)
    await connect(ports[1], idleId)
    assert.equal(exists(...idleKeys), 2)
    source(['pause', 'backend'])
    try {
      await eventually(() => exists(...idleKeys) === 0, 115000, '两台后端暂停时在线键未由 Redis 回收')
    } finally {
      source(['unpause', 'backend'])
    }
    await eventually(() => redis('ZSCORE', index, String(idleId)) === '', 13000, '恢复巡检后未清理索引成员')
    assert.equal(scanCalls(), scansBefore)
    console.log('PASS: 两台后端暂停时 Redis 回收无心跳的在线键；恢复巡检后索引成员清除')
  } finally {
    for (const { ws } of channels) ws.close()
  }
}
