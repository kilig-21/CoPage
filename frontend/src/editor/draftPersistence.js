// Flush synchronously at editor lifecycle boundaries. During typing, keep both a
// quiet-period timer and a maximum delay so continuous input still makes a backup.
export function createDraftPersistence(write, { delay = 400, maxDelay = 2000 } = {}) {
  let trailingTimer = null
  let deadlineTimer = null
  let dirty = false

  function cancelTimers() {
    clearTimeout(trailingTimer)
    clearTimeout(deadlineTimer)
    trailingTimer = deadlineTimer = null
  }

  function flush() {
    cancelTimers()
    if (!dirty) return true
    if (!write()) return false
    dirty = false
    return true
  }

  return {
    schedule() {
      dirty = true
      clearTimeout(trailingTimer)
      trailingTimer = setTimeout(flush, delay)
      if (deadlineTimer === null) deadlineTimer = setTimeout(flush, maxDelay)
    },
    flush,
    dispose() {
      cancelTimers()
      dirty = false
    },
  }
}
