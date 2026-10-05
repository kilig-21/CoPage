import { clipboardPasteError } from './clipboardImages.js'

// Quill History 在 text-change 前记录用户操作；拒绝编辑时连同该次历史
// 记录一起退回，不能清空已有撤销栈，也不能把逆操作当成远端编辑变换。
export function createEditCapacityGuard(quill, notify, onRestored = () => {}) {
  const history = quill.getModule('history')
  const record = history.record
  const change = history.change
  let beforeRecord = null
  let restoring = false
  let rejectedCount = 0
  const snapshot = () => ({
    undo: [...history.stack.undo], redo: [...history.stack.redo],
    lastRecorded: history.lastRecorded,
    currentRange: history.currentRange && { ...history.currentRange },
  })
  const restore = state => {
    history.stack = { undo: state.undo, redo: state.redo }
    history.lastRecorded = state.lastRecorded
    history.currentRange = state.currentRange
  }
  history.record = function (...args) {
    beforeRecord = snapshot()
    return record.apply(this, args)
  }
  history.change = function (...args) {
    const before = snapshot()
    const selection = quill.getSelection()
    const count = rejectedCount
    const result = change.apply(this, args)
    if (count !== rejectedCount) {
      restore(before)
      if (selection) quill.setSelection(selection, 'silent')
      onRestored()
    }
    return result
  }
  return {
    accept(delta, old, source) {
      if (restoring) return false
      if (source !== 'user') return true
      const failure = clipboardPasteError(delta, old)
      if (!failure) { beforeRecord = null; return true }
      const before = beforeRecord
      beforeRecord = null
      const inverse = delta.invert(old)
      const selection = quill.getSelection()
      const ignoreChange = history.ignoreChange
      restoring = true
      history.ignoreChange = true
      try {
        quill.updateContents(inverse, 'api')
        if (before && !ignoreChange) restore(before)
        if (selection) {
          const index = inverse.transformPosition(selection.index, true)
          const end = inverse.transformPosition(selection.index + selection.length, true)
          quill.setSelection({ index, length: Math.max(0, end - index) }, 'silent')
        }
      } finally {
        history.ignoreChange = ignoreChange
        restoring = false
      }
      rejectedCount++
      notify(failure.replaceAll('粘贴', '修改').replace('；原选区已保留', '；当前正文保持不变'))
      return false
    },
    dispose() { history.record = record; history.change = change },
  }
}
