import { Component, lazy, Suspense, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { safeReturnPath, subscribeSessionChanges } from './auth/session'
import LocalDraftBackup from './components/LocalDraftBackup'
import StorageUnavailable from './components/StorageUnavailable'
import { canReadBrowserStorage } from './auth/browserStorage'

const Home = lazy(() => import('./pages/Home'))
const Account = lazy(() => import('./pages/Account'))
const Login = lazy(() => import('./pages/Login'))
const DocList = lazy(() => import('./pages/DocList'))
const Editor = lazy(() => import('./pages/Editor'))
const Search = lazy(() => import('./pages/Search'))
const Templates = lazy(() => import('./pages/Templates'))
const Trash = lazy(() => import('./pages/Trash'))

const PAGE_TITLES = {
  '/home': '工作台', '/account': '账号设置', '/login': '登录或注册', '/docs': '我的文档', '/search': '搜索文档',
  '/templates': '文档模板', '/trash': '回收站',
}

class PageBoundary extends Component {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) return <main className="page-load-message" role="alert">
      <h1>页面暂时无法打开</h1>
      <p>请检查网络后重新加载。已保存在浏览器中的编辑草稿会保留。</p>
      <button onClick={() => window.location.reload()}>重新加载页面</button>
    </main>
    return this.props.children
  }
}

function RequireAuth({ children }) {
  const location = useLocation()
  return localStorage.getItem('collab-token')
    ? children
    : <Navigate to="/login" replace state={{ from: location.pathname + location.search + location.hash }} />
}

function SessionApp() {
  const location = useLocation()
  const navigate = useNavigate()
  const [sessionEpoch, setSessionEpoch] = useState(0)
  const [localBackup, setLocalBackup] = useState(null)
  useEffect(() => {
    const preserve = event => setLocalBackup(current => current || event.detail)
    window.addEventListener('copage-draft-backup', preserve)
    return () => window.removeEventListener('copage-draft-backup', preserve)
  }, [])
  useEffect(() => {
    document.title = localBackup ? '未确认内容备份 · CoPage'
      : `${PAGE_TITLES[location.pathname] || '文档'} · CoPage`
  }, [location.pathname, localBackup])
  useEffect(() => {
    const expired = () => navigate('/login', { replace: true, state: {
      expired: true, from: safeReturnPath(location.pathname + location.search + location.hash),
    } })
    window.addEventListener('copage-auth-expired', expired)
    return () => window.removeEventListener('copage-auth-expired', expired)
  }, [location, navigate])
  useEffect(() => subscribeSessionChanges(localStorage, window, () => {
    // 先同步暂停旧编辑器，再切换路由，防止组合输入在卸载时用旧身份提交。
    window.dispatchEvent(new Event('copage-auth-changed'))
    if (location.pathname === '/login') setSessionEpoch(value => value + 1)
    navigate('/login', { replace: true, state: {
      sessionChanged: true, from: safeReturnPath(location.pathname === '/login'
        ? location.state?.from : location.pathname + location.search + location.hash),
    } })
  }), [location, navigate])
  if (localBackup) return <LocalDraftBackup backup={localBackup} onContinue={() => {
    setLocalBackup(null)
    navigate('/login', { replace: true, state: {
      backupHandled: true, from: safeReturnPath(`/docs/${localBackup.docId}`),
    } })
  }} />
  return (
    <PageBoundary key={`${location.pathname}:${sessionEpoch}`}>
    <Suspense fallback={<main className="page-load-message" role="status">正在加载页面，请稍候…</main>}>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/home" element={<RequireAuth><Home /></RequireAuth>} />
      <Route path="/account" element={<RequireAuth><Account /></RequireAuth>} />
      <Route path="/docs" element={<RequireAuth><DocList /></RequireAuth>} />
      <Route path="/docs/:id" element={<RequireAuth><Editor /></RequireAuth>} />
      <Route path="/search" element={<RequireAuth><Search /></RequireAuth>} />
      <Route path="/templates" element={<RequireAuth><Templates /></RequireAuth>} />
      <Route path="/trash" element={<RequireAuth><Trash /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/home" replace />} />
    </Routes>
    </Suspense>
    </PageBoundary>
  )
}

export default function App() {
  const [storageReady, setStorageReady] = useState(() => canReadBrowserStorage(window))
  useEffect(() => {
    if (!storageReady) document.title = '浏览器存储不可用 · CoPage'
  }, [storageReady])
  if (!storageReady) return <StorageUnavailable onRetry={() => {
    const ready = canReadBrowserStorage(window)
    setStorageReady(ready)
    return ready
  }} />
  return <SessionApp />
}
