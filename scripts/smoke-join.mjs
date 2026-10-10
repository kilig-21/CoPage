export async function joinForSmoke(client, request, { attempts = 12,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const after = client.messages.length
    client.send(request)
    const response = await client.waitFor(message =>
      (message.type === 'sync' && message.syncId === request.syncId) || message.type === 'error', after)
    if (response.type === 'sync') return response
    if (response.code !== 40901) throw new Error(`加入文档被拒绝，code=${response.code}`)
    if (attempt + 1 < attempts) await delay(50 + attempt * 50)
  }
  throw new Error('加入文档多次遇到40901，验收终止')
}
