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
    const active = navigation.current?.querySelector('[aria-current="page"]')
    if (active && navigation.current.scrollWidth > navigation.current.clientWidth) {
      navigation.current.scrollLeft = Math.max(0, active.offsetLeft - navigation.current.clientWidth / 2 + active.offsetWidth / 2)
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
