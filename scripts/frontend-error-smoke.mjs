import assert from 'node:assert/strict'

export async function runFrontendErrorCheck({ ports, source, env }) {
  const project = JSON.parse(source(['config', '--format', 'json']).stdout).name
  assert.match(project, /^copage-prod-qa-[0-9a-f]{12}$/, 'Only a temporary isolated stack may be recreated')
  const origin = env.PROD_FRONTEND_ORIGIN
  const release = '123456789a'.repeat(4)
  const fixture = { environment: 'staging', release, source: 'render', route: '/login', kind: 'TypeError' }
  const hidden = 'TEST_TELEMETRY_PRIVATE_MARKER'
  const path = '/api/telemetry/frontend-errors'
  const send = (port, event = fixture, requestOrigin = origin) => fetch('http://127.0.0.1:' + port + path, {
    signal: AbortSignal.timeout(8000), credentials: 'omit', method: 'POST',
    headers: { Origin: requestOrigin, 'Content-Type': 'application/json' },
    body: typeof event === 'string' ? event : JSON.stringify(event),
  })
  const redis = (...args) => source(['exec', '-T', 'redis', 'sh', '-ec',
    'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw "$@"', 'redis-cli', ...args]).stdout.trim()
  const quota = 'collab:telemetry:frontend-errors'

  assert.equal((await send(ports[0], fixture, 'https://disallowed.example.invalid')).status, 403)
  assert.equal((await send(ports[0], { ...fixture, stack: hidden })).status, 400)
  assert.equal((await send(ports[0], { ...fixture, route: '/docs/' + hidden })).status, 400)
  assert.equal((await send(ports[0], hidden.repeat(30))).status, 413)
  assert.equal(redis('EXISTS', quota), '0')

  const accepted = await send(ports[0])
  assert.equal(accepted.status, 204)
  assert.equal(accepted.headers.get('access-control-allow-origin'), origin)
  assert.equal((await send(ports[1], { ...fixture, source: 'rejection' })).status, 204)
  assert.equal((await send(ports[1])).status, 429)
  assert.equal(redis('GET', quota), '2')
  const lease = Number(redis('TTL', quota))
  assert.ok(lease > 0 && lease <= 60)
  const logs = source(['logs', '--no-color', 'backend']).stdout
  const matches = logs.split(/\r?\n/).filter(line => line.includes('frontend_error environment='))
  assert.equal(matches.length, 2)
  assert.ok(matches.every(line => new RegExp('frontend_error environment=staging release=' + release +
    ' route=/login source=(render|rejection) kind=TypeError$').test(line)))
  assert.ok(!logs.includes(hidden))

  const disabledEnv = { ...env, FRONTEND_ERROR_REPORTING_ENABLED: 'false' }
  source(['up', '-d', '--no-build', '--force-recreate', '--no-deps', '--wait', '--wait-timeout', '120',
    '--scale', 'backend=2', 'backend'], { customEnv: disabledEnv })
  const disabledPort = source(['port', '--index', '1', 'backend', '8080'], { customEnv: disabledEnv }).stdout.trim()
  assert.match(disabledPort, /^127\.0\.0\.1:\d+$/)
  assert.equal((await send(Number(disabledPort.split(':')[1]))).status, 404)
  console.log('PASS: anonymous allowed-origin frontend reports, strict redaction, bounded body, shared expiring quota, disabled endpoint')
}
