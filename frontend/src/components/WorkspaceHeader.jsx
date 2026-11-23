import { useEffect, useId, useRef, useState } from 'react'
import { Button, Space } from 'antd'
import { DownOutlined, QuestionCircleOutlined, UserOutlined } from '@ant-design/icons'
import { Link, NavLink, useLocation } from 'react-router-dom'
import LogoutButton from './LogoutButton'
import LazyUserGuide from './LazyUserGuide'

const destinations = [
  ['/home', '工作台'], ['/docs', '我的文档'], ['/groups', '我的小组', true],
  ['/projects', '我的项目', true], ['/templates', '模板中心', true], ['/search', '搜索'], ['/trash', '回收站', true],
]
const secondaryDestinations = destinations.filter(([, , secondary]) => secondary)

export default function WorkspaceHeader({ title, guideSection }) {
  const location = useLocation()
  const header = useRef(null)
  const more = useRef(null)
  const moreTrigger = useRef(null)
  const moreId = useId()
  const guideTrigger = useRef(null)
  const [showGuide, setShowGuide] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const currentSecondary = secondaryDestinations.find(([path]) => location.pathname === path)?.[1]

  function skipNavigation(event) {
    const main = document.getElementById('workspace-main')
    if (!main) return
    event.preventDefault()
    const top = Math.max(0, window.scrollY + main.getBoundingClientRect().top
      - (header.current?.getBoundingClientRect().height || 0) - 16)
    main.focus({ preventScroll: true })
    window.scrollTo({ top, behavior: 'instant' })
  }
  useEffect(() => setMoreOpen(false), [location.key])
  useEffect(() => {
    if (!moreOpen) return
    const closeOutside = event => {
      if (!more.current?.contains(event.target)) setMoreOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [moreOpen])

  function closeMoreOnEscape(event) {
    if (!moreOpen || event.key !== 'Escape' || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    setMoreOpen(false)
    moreTrigger.current?.focus()
  }
  return <>
    <a className="workspace-skip-link" href="#workspace-main" onClick={skipNavigation}>跳到主要内容</a>
    <header className="topbar workspace-header" ref={header}>
      <div className="workspace-identity">
        <Link className="workspace-brand" to="/home" aria-label="CoPage 工作台">
          <img src="/favicon.svg" alt="" width="30" height="30" /><span>CoPage</span>
        </Link>
        <span className="workspace-context">{title}</span>
      </div>
      <nav className="workspace-navigation" aria-label="应用导航">
        {destinations.map(([path, label, secondary]) => <NavLink key={path} to={path}
          className={({ isActive }) => 'workspace-nav-link' + (secondary ? ' workspace-nav-secondary' : '') + (isActive ? ' is-active' : '')}>{label}</NavLink>)}
        <div ref={more} className="workspace-navigation-more" onKeyDown={closeMoreOnEscape}
          onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setMoreOpen(false) }}>
          <button ref={moreTrigger} type="button" className={'workspace-nav-link workspace-nav-more-button' + (currentSecondary ? ' is-active' : '')}
            aria-label={currentSecondary ? '更多页面，当前是' + currentSecondary : '更多页面'}
            aria-controls={moreId} aria-expanded={moreOpen} onClick={() => setMoreOpen(open => !open)}>
            更多<DownOutlined aria-hidden="true" />
          </button>
          <div id={moreId} className="workspace-nav-more-panel" hidden={!moreOpen}>
            {secondaryDestinations.map(([path, label]) => <NavLink key={path} to={path} onClick={() => setMoreOpen(false)}
              className={({ isActive }) => 'workspace-nav-link' + (isActive ? ' is-active' : '')}>{label}</NavLink>)}
          </div>
        </div>
      </nav>
      <Space className="workspace-utilities" size={4}>
        <Button ref={guideTrigger} type="text" icon={<QuestionCircleOutlined />} aria-label="使用指南" aria-haspopup="dialog" onClick={() => setShowGuide(true)}><span className="workspace-utility-label">指南</span></Button>
        <Link className={'workspace-account' + (location.pathname === '/account' ? ' is-active' : '')} to="/account" aria-label="账号设置"><UserOutlined /><span className="workspace-utility-label">账号</span></Link>
        <LogoutButton compact />
      </Space>
    </header>
    {showGuide && <LazyUserGuide initialSection={guideSection} triggerRef={guideTrigger} onClose={() => setShowGuide(false)} />}
  </>
}
