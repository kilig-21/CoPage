const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalidList = () => new Error('成员列表回复不完整，请重新读取；当前输入仍保留。')

export function parseCollaboratorsReply(reply) {
  if (!record(reply) || reply.code !== 0 || !Array.isArray(reply.data)) throw invalidList()
  const ids = new Set(), usernames = new Set()
  for (const member of reply.data) {
    if (!record(member) || !Number.isSafeInteger(member.userId) || member.userId <= 0 ||
        typeof member.username !== 'string' || !member.username.trim() || member.username.length > 50 ||
        (member.nickname !== null && typeof member.nickname !== 'string') ||
        ![1, 2].includes(member.permission) || ids.has(member.userId) || usernames.has(member.username.toLowerCase())) throw invalidList()
    ids.add(member.userId); usernames.add(member.username.toLowerCase())
  }
  return reply.data
}

export function confirmCollaboratorUpdate(reply) {
  if (!record(reply) || reply.code !== 0 || reply.data !== null) {
    throw new Error('成员更新回复无法确认，请刷新列表核对当前权限；输入仍保留。')
  }
}
