export function createCompositionInbox({ isComposing, deliver, resync, maxMessages = 2000 }) {
  let queue = []
  let needsResync = false
  return {
    receive(message) {
      if (!isComposing()) { deliver(message); return }
      if ((message.type === 'permission' && message.permission < 2) ||
          (message.type === 'error' && [401, 403].includes(message.code))) {
        queue = []
        needsResync = true
        deliver(message)
      } else if (!needsResync) {
        if (queue.length < maxMessages) queue.push(message)
        else { queue = []; needsResync = true }
      }
    },
    drain() {
      const messages = queue
      queue = []
      if (needsResync) { needsResync = false; resync(); return }
      messages.forEach(deliver)
    },
    clear() { queue = []; needsResync = false },
  }
}
