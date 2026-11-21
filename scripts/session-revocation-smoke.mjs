import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { collabProtocols } from '../frontend/src/ws/protocol.js'

const timeout = 8000

function expectConnectionEvent(socket, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket event timed out: ' + type)), timeout)
    socket.addEventListener(type, event => { clearTimeout(timer); resolve(event) }, { once: true })
    if (type === 'open') socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('WebSocket handshake failed'))
    }, { once: true })
  })
}

function upgradeStatus(port, token, path = '/ws/collab') {
  return new Promise((resolve, reject) => {
    const incoming = request({ host: '127.0.0.1', port, path, headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      'Sec-WebSocket-Protocol': collabProtocols(token).join(', '),
    } })
    incoming.setTimeout(timeout, () => incoming.destroy(new Error('WebSocket handshake timed out')))
    incoming.once('error', reject)
    incoming.once('response', response => { response.resume(); resolve(response.statusCode) })
    incoming.once('upgrade', (response, socket) => { socket.destroy(); resolve(response.statusCode) })
    incoming.end()
  })
}

export async function runSessionRevocationCheck({ ports, username, password, source }) {
  const api = (port, route, method, token, body) => fetch('http://127.0.0.1:' + port + '/api' + route, {
    method, signal: AbortSignal.timeout(timeout), headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}),
  })
  async function login(port, credential = password) {
    const response = await api(port, '/auth/login', 'POST', null, { username, password: credential })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.code, 0)
    return result.data.token
  }
  async function connect(port, bearer) {
    const socket = new WebSocket('ws://127.0.0.1:' + port + '/ws/collab', collabProtocols(bearer))
    sockets.push(socket)
    await expectConnectionEvent(socket, 'open')
    assert.equal(socket.protocol, 'copage.v1')
    assert.equal(new URL(socket.url).search, '')
    return socket
  }

  const sockets = []
  try {
    const revoked = await login(ports[0])
    const independentlySigned = await login(ports[1])
    assert.ok(revoked !== independentlySigned, 'same-account logins must have different IDs')
    const idleRevoked = await connect(ports[1], revoked)
    const otherDevice = await connect(ports[1], independentlySigned)
    const closedByLogout = expectConnectionEvent(idleRevoked, 'close')
    const logout = await api(ports[0], '/auth/logout', 'POST', revoked)
    assert.equal(logout.status, 200)
    assert.equal((await logout.json()).code, 0)

    const keys = source(['exec', '-T', 'redis', 'sh', '-ec',
      'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw --scan --pattern "collab:auth:revoked:*"']).stdout.trim().split(/\r?\n/)
    assert.equal(keys.length, 1)
    const ttl = Number(source(['exec', '-T', 'redis', 'sh', '-ec',
      'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw PTTL "$1"', 'sh', keys[0]]).stdout.trim())
    assert.ok(ttl > 0 && ttl <= 24 * 60 * 60 * 1000)

    assert.equal((await api(ports[1], '/account/me', 'GET', revoked)).status, 401)
    assert.equal(await upgradeStatus(ports[1], revoked), 401)
    assert.equal((await closedByLogout).code, 1008)
    assert.equal(otherDevice.readyState, WebSocket.OPEN)
    assert.equal((await api(ports[1], '/account/me', 'GET', independentlySigned)).status, 200)
    assert.equal(await upgradeStatus(ports[1], independentlySigned, '/ws/collab?token=legacy'), 401)

    const passwordReplacement = randomBytes(24).toString('hex')
    const closedByPasswordChange = expectConnectionEvent(otherDevice, 'close')
    const change = await api(ports[0], '/account/password', 'POST', independentlySigned, {
      currentPassword: password, newPassword: passwordReplacement,
    })
    assert.equal(change.status, 200)
    assert.equal((await closedByPasswordChange).code, 1008)
    assert.equal((await api(ports[1], '/account/me', 'GET', independentlySigned)).status, 401)
    assert.equal(await upgradeStatus(ports[1], independentlySigned), 401)
    const replacement = await login(ports[0], passwordReplacement)
    await connect(ports[1], replacement)
    console.log('PASS: 跨实例登出只撤销当前令牌，TTL 有界，关闭未 join 连接并拒绝 REST/握手；改密关闭其余旧连接，URL 无令牌')
  } finally {
    for (const socket of sockets) if (socket.readyState < WebSocket.CLOSING) socket.close()
  }
}
