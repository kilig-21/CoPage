import { parseAccountProfile } from './accountProfile.js'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = (reason, message) => Object.assign(new Error(message), { reason })

export function parseLoginReply(reply) {
  try {
    if (!record(reply) || reply.code !== 0 || !record(reply.data) ||
        typeof reply.data.token !== 'string' || !reply.data.token.trim()) throw Error()
    const user = parseAccountProfile(reply.data.user)
    return { token: reply.data.token, user }
  } catch { throw invalid('LOGIN_RESPONSE', '登录回复无法确认，请重试；当前登录状态和已有草稿未改动。') }
}

export function confirmRegistrationReply(reply) {
  try {
    if (!record(reply) || reply.code !== 0) throw Error()
    return parseAccountProfile(reply.data)
  } catch { throw invalid('REGISTRATION_RESPONSE', '注册回复无法确认，请先尝试登录核对；不会自动重新注册。') }
}

export function confirmPasswordChangeReply(reply) {
  if (!record(reply) || reply.code !== 0 || reply.data !== null) {
    throw invalid('ACCOUNT_PASSWORD_RESPONSE', '密码更新回复无法确认，请重新登录核对；已有本地草稿仍保留。')
  }
}
