const invalidProfile = () => Object.assign(new Error('账号资料回复无法确认，请重试读取。'),
  { reason: 'ACCOUNT_PROFILE_RESPONSE' })

// 读取已有账号资料，不套用新注册的名称规则，也不带出非公开字段。
export function parseAccountProfile(value, { expectedProfile, expectedNickname } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Number.isSafeInteger(value.id) || value.id <= 0 ||
      typeof value.username !== 'string' || !value.username.trim() ||
      (value.nickname != null && typeof value.nickname !== 'string') ||
      (value.avatar != null && typeof value.avatar !== 'string')) throw invalidProfile()
  if (expectedProfile !== undefined && (!expectedProfile ||
      value.id !== expectedProfile.id || value.username !== expectedProfile.username)) throw invalidProfile()
  // 调用方传入实际提交的trim后昵称；不再归一化回复，避免把不同结果误认成保存成功。
  if (expectedNickname !== undefined && (typeof expectedNickname !== 'string' || value.nickname !== expectedNickname)) throw invalidProfile()
  return { id: value.id, username: value.username, nickname: value.nickname ?? null, avatar: value.avatar ?? null }
}
