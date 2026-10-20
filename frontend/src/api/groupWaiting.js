const resources = new Set(['detail', 'groups', 'inbox'])
const validIdentity = value => value && ['account', 'token', 'service'].every(key => typeof value[key] === 'string' && value[key])

// 只协调当前标签的非创建未知操作；不发送请求、不保存收据，也不以失败推断原写入结果。
export function createGroupWaiting({ readIdentity, getEpoch, isBlocked = () => false, onChange = () => {} }) {
  let pending = null, owner = null, requested = null, reviewFailed = false
  const reads = new Set()
  let state = { checking: false, reviewFailed: false }
  function captureIdentity() {
    try {
      const value = readIdentity()
      return validIdentity(value) ? Object.freeze({ account: value.account, token: value.token, service: value.service }) : null
    } catch { return null }
  }
  function current() {
    const value = captureIdentity()
    return Boolean(pending && owner && value && pending.epoch === getEpoch() &&
      ['account', 'token', 'service'].every(key => value[key] === owner[key]))
  }
  function blocked() { try { return isBlocked() !== false } catch { return true } }
  function publish() {
    const next = { checking: Boolean(requested || reads.size), reviewFailed }
    if (next.checking !== state.checking || next.reviewFailed !== state.reviewFailed) {
      state = next; onChange({ ...next })
    }
  }
  function reset() {
    pending = null; owner = null; requested = null; reviewFailed = false; reads.clear(); publish()
  }
  function remember(target, identity = captureIdentity()) {
    if (!target || target.kind === 'create' || !resources.has(target.resource)) return false
    pending = target; owner = identity; requested = null; reviewFailed = false; reads.clear(); publish()
    return true
  }
  function requestReview(target) {
    if (pending !== target || !current() || blocked() || requested || reads.size) return false
    reviewFailed = false; requested = target; publish()
    return true
  }
  function cancelReview(target) {
    if (!target || pending !== target || requested !== target) return false
    requested = null; publish(); return true
  }
  function startRead(context) {
    if (!pending || context.resource !== pending.resource || context.epoch !== pending.epoch ||
        (context.resource === 'detail' && context.target !== pending.target) ||
        (context.resource === 'groups' && pending.keyword && context.keyword !== pending.keyword)) return null
    // 只有这次意图对应的读取才可撤销它；无关读不能吞掉原目标的核对资格。
    if (!current()) { cancelReview(pending); return null }
    const ticket = Object.freeze({ pending, explicit: requested === pending })
    if (ticket.explicit) requested = null
    reads.add(ticket); publish()
    return ticket
  }
  function finishRead(ticket, failed = false) {
    if (!reads.delete(ticket)) return
    if (failed && ticket.explicit && ticket.pending === pending && current()) reviewFailed = true
    publish()
  }
  function cancelRead(ticket) {
    if (reads.delete(ticket)) publish()
  }
  function clear(target) {
    if (pending !== target || !current()) return false
    reset(); return true
  }
  function canEnd(target) {
    return pending === target && current() && reviewFailed && !requested && reads.size === 0 && !blocked()
  }
  function endWaiting(target) {
    if (!canEnd(target)) return false
    reset(); return true
  }
  return { captureIdentity, remember, requestReview, cancelReview, startRead, finishRead, cancelRead, clear, canEnd, endWaiting,
    snapshot: () => ({ ...state }) }
}
