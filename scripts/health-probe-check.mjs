import assert from 'node:assert/strict'
import { setTimeout as pause } from 'node:timers/promises'

export async function runHealthProbeCheck({ docker, source, ports }) {
  const labels = source(['ps', '-q', 'backend']).stdout.trim().split(/\s+/)
  assert.equal(labels.length, 2)
  const statuses = () => labels.map(id =>
    docker(['inspect', '--format', '{{.State.Health.Status}}', id]).stdout.trim())

  async function probe(port, kind, status) {
    const result = await fetch(`http://127.0.0.1:${port}/actuator/health/${kind}`,
      { signal: AbortSignal.timeout(7500) })
    assert.equal(result.status, status)
    assert.deepEqual(await result.json(), { status: status === 200 ? 'UP' : 'DOWN' })
  }

  async function eventually(check, timeout = 55_000) {
    const deadline = Date.now() + timeout
    let failure
    do {
      try {
        await check()
        return
      } catch (error) {
        failure = error
        await pause(500)
      }
    } while (Date.now() < deadline)
    throw failure
  }

  const [port, peer] = ports
  assert.deepEqual(statuses(), ['healthy', 'healthy'])
  await probe(port, 'liveness', 200)
  for (const endpoint of ['env', 'beans', 'configprops', 'metrics']) {
    const response = await fetch(`http://127.0.0.1:${port}/actuator/${endpoint}`,
      { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 404)
  }
  for (const dependency of ['mysql', 'redis', 'rabbitmq', 'elasticsearch', 'minio']) {
    source(['stop', dependency])
    try {
      await eventually(() => probe(port, 'readiness', 503))
      await probe(peer, 'liveness', 200)
      if (dependency === 'mysql') {
        await eventually(() => assert.deepEqual(statuses(), ['unhealthy', 'unhealthy']))
      }
    } finally {
      source(['start', dependency])
    }
    await eventually(() => probe(port, 'readiness', 200))
    console.log(`PASS: ${dependency} 中断时 readiness=503、liveness=200，恢复后 readiness=200`)
  }
  await eventually(() => assert.deepEqual(statuses(), ['healthy', 'healthy']))
  console.log('PASS: Compose 健康状态可降级并恢复；探针仅含 status，其他管理端点不可访问')
}
