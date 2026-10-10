import { message } from 'antd'
import request from './request'
import { createDocumentCreator } from './creationRequest'

const create = createDocumentCreator({ getStorage: () => sessionStorage, crypto: globalThis.crypto,
  post: (path, body, config) => request.post(path, body, config) })

export default async function createDocument(path, body, config = {}) {
  let account, token
  try { account = localStorage.getItem('collab-user'); token = localStorage.getItem('collab-token') }
  catch { throw Object.assign(new Error('浏览器无法读取当前账号，请允许本站保存数据后重试。'), { code: 400 }) }
  const result = await create(path, body, { ...config, copageExpectedSessionToken: token, account, service: request.defaults.baseURL,
    isCurrent: () => localStorage.getItem('collab-user') === account && localStorage.getItem('collab-token') === token })
  if (result.creationTrackingWarning) message.warning(result.creationTrackingWarning, 10)
  return result
}
