import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AxiosError, CanceledError, isCancel } from 'axios'
import { normalizeRequestError, requestFailureMessage } from './requestError.js'

test('HTTP fallbacks are distinct when an upstream returns no CoPage error message', () => {
  const cases = [
    [400, '请求内容有误'], [401, '登录未通过'], [403, '没有权限'], [404, '资源不存在'],
    [409, '数据已发生变化'], [429, '操作过于频繁'], [500, '服务器处理失败'], [503, '服务暂不可用'],
  ]
  for (const [status, description] of cases) {
    const normalized = normalizeRequestError({ response: { status, data: '<html>Bad upstream</html>' } })
    assert.equal(normalized.code, status)
    assert.equal(normalized.status, status)
    assert.ok(normalized.message.includes(description))
  }
})

test('CoPage messages and conflict codes survive without response bodies or request credentials', () => {
  const response = { status: 409, data: { code: 40903, message: '版本过旧，请重新同步文档', data: null } }
  const error = normalizeRequestError(new AxiosError('Request failed', 'ERR_BAD_REQUEST', {
    headers: { Authorization: 'Bearer example-only' },
  }, undefined, response))
  assert.equal(error.code, 40903)
  assert.equal(error.status, 409)
  assert.equal(error.message, response.data.message)
  for (const key of ['config', 'request', 'response', 'data']) assert.equal(error[key], undefined)
  assert.equal(normalizeRequestError({ response: { status: 429,
    data: { code: 429, message: '尝试次数过多，请在 30 秒后重试' } } }).message, '尝试次数过多，请在 30 秒后重试')
})

test('missing, mismatched, or technical messages fall back to Chinese', () => {
  for (const data of [null, { code: 401, message: '错误类型不匹配' }, { code: 503, message: 'Bad gateway' },
    { code: 503, message: '故障\n at internal.method' }, { code: 503, message: '<pre>服务故障</pre>' }]) {
    const error = normalizeRequestError({ response: { status: 503, data } })
    assert.equal(error.code, 503)
    assert.equal(error.message, '服务暂不可用，请稍后重试。')
  }
  assert.equal(normalizeRequestError({ response: { status: 502 } }).code, 502)
  assert.equal(requestFailureMessage(new Error('QuotaExceededError'), '操作未完成'), '操作未完成')
  assert.equal(requestFailureMessage(new Error('当前窗口身份已变化')), '当前窗口身份已变化')
})

test('timeout, network, cancellation and unknown failures have stable codes', () => {
  for (const code of ['ECONNABORTED', 'ETIMEDOUT']) {
    const timeout = normalizeRequestError(new AxiosError('timeout of 10000ms exceeded', code))
    assert.equal(timeout.code, 'REQUEST_TIMEOUT')
    assert.equal(timeout.message, '请求超时，请稍后重试。')
  }
  const network = normalizeRequestError(new AxiosError('Network Error', 'ERR_NETWORK'))
  assert.equal(network.code, 'NETWORK_ERROR')
  assert.equal(network.message, '无法连接服务，请检查网络后重试。')
  const cancelled = normalizeRequestError(new CanceledError())
  assert.ok(isCancel(cancelled))
  assert.equal(cancelled.code, 'ERR_CANCELED')
  assert.equal(cancelled.message, '请求已取消。')
  assert.equal(normalizeRequestError(new CanceledError('账号已变更，创建已取消')).message, '账号已变更，创建已取消')
  for (const failure of [undefined, new Error('Unexpected error'), new AxiosError('Request failed', 'ERR_BAD_OPTION')]) {
    const error = normalizeRequestError(failure)
    assert.equal(error.code, 'REQUEST_FAILED')
    assert.equal(error.message, '请求失败，请稍后重试。')
  }
})
