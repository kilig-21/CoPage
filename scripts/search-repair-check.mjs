import assert from 'node:assert/strict'
import { setTimeout as pause } from 'node:timers/promises'

export async function runSearchRepairCheck({ source, sql, username }) {
  assert.match(username, /^qa[0-9a-f]+$/)
  const corpus = 20_000
  const firstId = 10001
  const lastId = firstId + corpus - 1
  assert.equal(sql(`SELECT COUNT(*) FROM document WHERE id BETWEEN ${firstId} AND ${lastId};`).stdout.trim(), '0')
  sql(`
    INSERT INTO document (id, title, owner_id)
    WITH RECURSIVE ids(i) AS (SELECT ${firstId} UNION ALL SELECT i+1 FROM ids WHERE i<${lastId})
    SELECT /*+ SET_VAR(cte_max_recursion_depth=20001) */ i, 'SearchRepairFixture',
        (SELECT id FROM user WHERE username='${username}') FROM ids;`)

  const redis = (...args) => source(['exec', '-T', 'redis', 'sh', '-ec',
    'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli "$@"', 'redis-cli', ...args]).stdout.trim()
  const key = `collab:presence:sessions:${firstId}`
  source(['pause', 'elasticsearch'])
  let elapsed
  try {
    await pause(2500)
    assert.equal(redis('ZADD', key, '0', 'fixture:expired'), '1')
    const start = performance.now()
    do {
      if (redis('ZCARD', key) === '0') {
        elapsed = Math.round(performance.now() - start)
        break
      }
      await pause(300)
    } while (performance.now() - start < 7500)
    assert.notEqual(elapsed, undefined, 'ES 暂停期间在线状态巡检应继续')
  } finally {
    source(['unpause', 'elasticsearch'])
  }

  const readPending = () => Number(sql(`
    SELECT COUNT(*) FROM document WHERE id BETWEEN ${firstId} AND ${lastId} AND search_pending=TRUE;`).stdout.trim())
  const start = Date.now()
  let pending
  do {
    pending = readPending()
    if (pending < corpus) break
    await pause(500)
  } while (Date.now() - start < 30000)
  assert.ok(pending > 0 && pending < corpus, `应只修复部分待处理记录，剩余 ${pending}`)
  let rounds
  const logsDeadline = Date.now() + 15000
  do {
    const logs = source(['logs', '--no-color', 'backend']).stdout
    rounds = [...logs.matchAll(/rebuilt=(\d+), repaired=(\d+), elapsedMs=(\d+)/g)]
      .map(match => match.slice(1).map(Number))
    if (rounds.some(([rebuilt, repaired]) => rebuilt === 32 || repaired === 32)) break
    await pause(500)
  } while (Date.now() < logsDeadline)
  assert.ok(rounds.some(([rebuilt, repaired]) => rebuilt === 32 || repaired === 32), '日志须包含完成的满批次')
  assert.ok(rounds.every(([rebuilt, repaired]) => rebuilt <= 32 && repaired <= 32))
  console.log(`PASS: ${corpus} 篇索引分批修复，首轮观察时剩余 ${pending} 篇；ES 暂停期间在线状态在 ${elapsed}ms 内清理`)
}
