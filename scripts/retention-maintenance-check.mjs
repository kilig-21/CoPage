import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'

export async function runRetentionMaintenanceCheck({ sql, origin, username, password }) {
  let token
  async function api(path, method = 'GET', body) {
    const response = await fetch(origin + '/api' + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
    const result = await response.json()
    assert.equal(response.status, 200, path)
    assert.equal(result.code, 0, path)
    return result.data
  }

  const account = await api('/auth/login', 'POST', { username, password })
  token = account.token
  const title = 'RetentionSchedule-' + randomUUID()
  const { id } = await api('/doc', 'POST', { title })
  assert.ok(Number.isSafeInteger(id) && id > 0 && ![26, 536, 548].includes(id))
  assert.equal(sql(`SELECT COUNT(*) FROM document WHERE id=${id} AND title='${title}' AND revision=0;`).stdout.trim(), '1')
  const base = `/doc/${id}/history`
  const defaults = await api(base + '/retention')
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.maxSnapshots, 100)
  sql(`
    INSERT INTO doc_operation (doc_id, revision, op, create_time)
    WITH RECURSIVE n AS (SELECT 1 i UNION ALL SELECT i+1 FROM n WHERE i<110)
    SELECT ${id}, i, JSON_OBJECT('ops', JSON_ARRAY(JSON_OBJECT('insert', 'A'))),
      CASE WHEN i<=6 THEN DATE_SUB(NOW(), INTERVAL 40 DAY) ELSE NOW() END FROM n;
    INSERT INTO doc_snapshot (doc_id, revision, content)
    SELECT ${id}, revision, JSON_OBJECT('ops', JSON_ARRAY(JSON_OBJECT('insert', CONCAT(REPEAT('A', revision), CHAR(10 USING utf8mb4)))))
    FROM doc_operation WHERE doc_id=${id};
    UPDATE document SET revision=110, content=JSON_OBJECT('ops', JSON_ARRAY(JSON_OBJECT('insert', CONCAT(REPEAT('A', 110), CHAR(10 USING utf8mb4)))))
    WHERE id=${id};`)
  await api(base + '/1/name', 'PUT', { name: '合成重要版本' })
  assert.equal((await api(base + '/1')).content.ops[0].insert, 'A\n')

  const deadline = Date.now() + 90_000
  let state
  do {
    state = sql(`
      SELECT
          (SELECT COUNT(*) FROM doc_snapshot WHERE doc_id=${id}),
          (SELECT COALESCE(MAX(revision),0) FROM doc_history_boundary WHERE doc_id=${id}),
          (SELECT COUNT(*) FROM doc_operation WHERE doc_id=${id});`).stdout.trim()
    if (state === '100\t6\t104') break
    await pause(1000)
  } while (Date.now() < deadline)
  assert.equal(state, '100\t6\t104', '自动任务应在首次巡检裁剪旧普通历史')
  assert.equal((await api(base + '/1')).content.ops[0].insert, 'A\n')
  assert.equal((await api(base + '/6')).content.ops[0].insert, 'AAAAAA\n')
  assert.equal((await api(base + '/11')).content.ops[0].insert, 'A'.repeat(11) + '\n')
  assert.equal((await api(`/doc/${id}`)).revision, 110)
  console.log('PASS: 默认自动保留生效，快照收敛到 100 条，版本 6 起点、重要版本与当前正文可读')
}
