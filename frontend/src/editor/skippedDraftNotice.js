// 只观察本次已探测并跳过的精确槽位，不探测归属、不接管或修改草稿。
export function createSkippedDraftNotice({ storage, eventTarget, onChange }) {
  const keys = new Set()
  let visible = false, dismissed = false, disposed = false
  const publish = next => {
    if (disposed || next === visible) return
    visible = next
    onChange(next)
  }
  const refresh = () => {
    if (disposed || dismissed) return
    let remains = false
    for (const key of keys) {
      try { if (storage.getItem(key) !== null) { remains = true; break } }
      catch { remains = true; break } // 不可读不代表原记录已处理或消失。
    }
    publish(!dismissed && remains)
  }
  const changed = event => {
    if (disposed || dismissed || event.storageArea !== storage || (event.key !== null && !keys.has(event.key))) return
    refresh() // 排队事件的newValue可能过旧，必须读取当前真实槽位。
  }
  eventTarget.addEventListener('storage', changed)
  return {
    track(key) {
      if (disposed || dismissed) return
      if (typeof key !== 'string' || !key) throw new TypeError('需要精确的草稿槽位')
      keys.add(key)
      refresh()
    },
    dismiss() {
      if (disposed) return
      dismissed = true
      publish(false) // 只隐藏本scope提示，绝不删除草稿。
    },
    dispose() {
      if (disposed) return
      disposed = true
      eventTarget.removeEventListener('storage', changed)
      keys.clear()
    },
  }
}
