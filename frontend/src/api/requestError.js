import { CanceledError, isCancel } from 'axios'

const httpMessages = {
  400: '请求内容有误，请核对后重试。',
  401: '登录未通过或已失效，请核对账号和密码后重新登录。',
  403: '当前账号没有权限执行此操作。',
  404: '资源不存在或已被删除。',
  409: '数据已发生变化或正在处理，请刷新后重试。',
  429: '操作过于频繁，请稍后重试。',
  500: '服务器处理失败，请稍后重试。',
  503: '服务暂不可用，请稍后重试。',
}

const unknownMessage = '请求失败，请稍后重试。'

function readableMessage(value) {
  const message = typeof value === 'string' ? value.trim() : ''
  return message.length <= 300 && /\p{Script=Han}/u.test(message) && !/[\r\n<>]/.test(message) ? message : null
}

export function requestFailureMessage(error, fallback = unknownMessage) {
  return readableMessage(error?.message) || fallback
}

export function normalizeRequestError(error) {
  if (isCancel(error)) return new CanceledError(readableMessage(error.message) || '请求已取消。')

  const status = error?.response?.status
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    const body = error.response.data
    const matchesStatus = body?.code === status ||
      (status === 409 && Number.isInteger(body?.code) && body.code >= 40900 && body.code < 41000)
    const code = matchesStatus ? body.code : status
    const message = (matchesStatus && readableMessage(body.message)) || httpMessages[status] || unknownMessage
    return Object.assign(new Error(message), { code, status })
  }

  if (error?.isAxiosError === true) {
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return Object.assign(new Error('请求超时，请稍后重试。'), { code: 'REQUEST_TIMEOUT' })
    }
    if (error.code === 'ERR_NETWORK') {
      return Object.assign(new Error('无法连接服务，请检查网络后重试。'), { code: 'NETWORK_ERROR' })
    }
  }
  return Object.assign(new Error(unknownMessage), { code: 'REQUEST_FAILED' })
}
