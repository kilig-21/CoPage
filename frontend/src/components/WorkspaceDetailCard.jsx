import { useEffect, useRef } from 'react'
import { Card } from 'antd'

// 只消费“打开详情”的意图；同一资料的刷新、筛选和分页不重新移动焦点。
export default function WorkspaceDetailCard({ id, title, arrival, waiting, children, className, ...props }) {
  const heading = useRef(null)
  const previousArrival = useRef(arrival)
  const pending = useRef(true)
  useEffect(() => {
    const cancel = () => { pending.current = false }
    document.addEventListener('pointerdown', cancel, true)
    document.addEventListener('keydown', cancel, true)
    document.addEventListener('input', cancel, true)
    document.addEventListener('wheel', cancel, { capture: true, passive: true })
    return () => {
      document.removeEventListener('pointerdown', cancel, true)
      document.removeEventListener('keydown', cancel, true)
      document.removeEventListener('input', cancel, true)
      document.removeEventListener('wheel', cancel, true)
    }
  }, [])
  useEffect(() => {
    if (previousArrival.current !== arrival) {
      previousArrival.current = arrival
      pending.current = true
    }
    if (waiting || !pending.current) return
    const frame = requestAnimationFrame(() => {
      if (!pending.current) return
      const target = heading.current
      if (!target?.isConnected) return
      // 加载期间若用户已打开其他任务，不把焦点从弹窗或抽屉抢回页面。
      const overlay = [...document.querySelectorAll('[role="dialog"][aria-modal="true"], .ant-drawer-open')]
        .some(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
      if (overlay) { pending.current = false; return }
      const header = document.querySelector('.workspace-header')
      const top = Math.max(0, window.scrollY + target.getBoundingClientRect().top
        - (header?.getBoundingClientRect().height || 0) - 16)
      target.focus({ preventScroll: true })
      window.scrollTo({ top, behavior: 'instant' })
      pending.current = false
    })
    return () => cancelAnimationFrame(frame)
  }, [arrival, waiting])
  return <Card {...props} className={'workspace-detail-card' + (className ? ' ' + className : '')} id={id} role="region" aria-labelledby={id + '-title'}
    title={<h3 id={id + '-title'} ref={heading} tabIndex={-1} className="workspace-detail-title">{title}</h3>}>
    {children}
  </Card>
}
