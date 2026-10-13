import { useEffect, useRef, useState } from 'react'
import { Button, Space } from 'antd'
import { QuestionCircleOutlined, UserOutlined } from '@ant-design/icons'
import { Link, NavLink, useLocation } from 'react-router-dom'
import LogoutButton from './LogoutButton'
import UserGuide from './UserGuide'

const destinations = [
  ['/home', '工作台'], ['/docs', '我的文档'], ['/groups', '我的小组'],
  ['/projects', '我的项目'], ['/templates', '模板中心'], ['/search', '搜索'], ['/trash', '回收站'],
]

export default function WorkspaceHeader({ title, onGuide, children }) {
  const location = useLocation()
  const navigation = useRef(null)
  const [showGuide, setShowGuide] = useState(false)
  useEffect(() => {
    const nav = navigation.current
    if (!nav) return
    let disposed = false, frame = null, observedWidth = nav.clientWidth
    const revealActive = () => {
      frame = null
      if (disposed || navigation.current !== nav) return
      const width = nav.clientWidth, max = nav.scrollWidth - width
      const active = nav.querySelector('[aria-current="page"]')
      if (!width || max <= 0 || !active) return
      const bounds = nav.getBoundingClientRect(), target = active.getBoundingClientRect()
      const left = bounds.left + nav.clientLeft, right = left + width
      let delta
      if (target.width > width) delta = target.left - left // 宽入口始终左对齐，避免两端来回调整。
      else {
        if (target.left >= left - 1 && target.right <= right + 1) return
        delta = target.left < left ? target.left - left : target.right - right
      }
      const next = Math.min(max, Math.max(0, nav.scrollLeft + delta))
      if (Math.abs(next - nav.scrollLeft) > 1) nav.scrollLeft = next
    }
    const schedule = () => {
      if (!disposed && frame === null) frame = requestAnimationFrame(revealActive)
    }
    const resized = () => {
      if (disposed || nav.clientWidth === observedWidth) return
      observedWidth = nav.clientWidth
      schedule()
    }
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resized) : null
    if (observer) observer.observe(nav)
    else window.addEventListener('resize', resized)
    schedule()
    return () => {
      disposed = true
      observer?.disconnect()
      if (!observer) window.removeEventListener('resize', resized)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [location.pathname])
  return <>
    <header className="topbar workspace-header">
      <div className="workspace-identity">
        <Link className="workspace-brand" to="/home" aria-label="CoPage 工作台">
          <img src="/favicon.svg" alt="" width="30" height="30" /><span>CoPage</span>
        </Link>
        <span className="workspace-context">{title}</span>
      </div>
      <nav className="workspace-navigation" aria-label="应用导航" ref={navigation}>
        {destinations.map(([path, label]) => <NavLink key={path} to={path}
          className={({ isActive }) => 'workspace-nav-link' + (isActive ? ' is-active' : '')}>{label}</NavLink>)}
      </nav>
      <Space className="workspace-utilities" size={4}>
        <Button type="text" icon={<QuestionCircleOutlined />} aria-label="使用指南" onClick={onGuide || (() => setShowGuide(true))}><span className="workspace-utility-label">指南</span></Button>
        <Link className={'workspace-account' + (location.pathname === '/account' ? ' is-active' : '')} to="/account" aria-label="账号设置"><UserOutlined /><span className="workspace-utility-label">账号</span></Link>
        <LogoutButton compact />
      </Space>
      {children && <div className="workspace-page-actions">{children}</div>}
    </header>
    {showGuide && <UserGuide onClose={() => setShowGuide(false)} />}
  </>
}
