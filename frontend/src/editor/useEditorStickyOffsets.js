import { useLayoutEffect, useRef } from 'react'

// 页头和状态都可能随宽度、缩放、文字换行改变高度；尺寸变量不参与它们自身的高度计算。
export default function useEditorStickyOffsets(topbarRef, statusRef) {
  const fallbackMeasure = useRef(null)
  useLayoutEffect(() => {
    const topbar = topbarRef.current, status = statusRef.current
    const workspace = topbar?.closest('.editor-workspace')
    if (!workspace || !status) return undefined
    let disposed = false, frame = null
    const previous = new Map()
    const measure = () => {
      if (disposed) return
      for (const [node, property] of [[topbar, '--editor-topbar-offset'], [status, '--editor-status-height']]) {
        const height = Math.ceil(node.getBoundingClientRect().height * 100) / 100
        if (previous.get(property) === height) continue
        previous.set(property, height)
        workspace.style.setProperty(property, height + 'px')
      }
    }
    const schedule = () => {
      if (!disposed && frame === null) frame = requestAnimationFrame(() => { frame = null; measure() })
    }
    measure()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    if (observer) { observer.observe(topbar); observer.observe(status) }
    else { window.addEventListener('resize', schedule); fallbackMeasure.current = measure }
    return () => {
      disposed = true
      fallbackMeasure.current = null
      observer?.disconnect()
      if (!observer) window.removeEventListener('resize', schedule)
      if (frame !== null) cancelAnimationFrame(frame)
      for (const property of previous.keys()) workspace.style.removeProperty(property)
    }
  }, [topbarRef, statusRef])
  // 无ResizeObserver时，同宽度下的保存提示/头像变化也会触发React渲染。
  useLayoutEffect(() => { fallbackMeasure.current?.() })
}
