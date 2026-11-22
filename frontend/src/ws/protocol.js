const messageTypes = new Set(['sync', 'history_page', 'ack', 'op', 'cursor', 'presence',
  'metadata', 'permission', 'pong', 'error'])

export function isCollabServerMessage(message) {
  return message !== null && typeof message === 'object' && messageTypes.has(message.type) &&
    (message.docId === undefined || (Number.isSafeInteger(message.docId) && message.docId > 0))
}

export function collabProtocols(token) {
  return ['copage.v1', `bearer.${token}`]
}
