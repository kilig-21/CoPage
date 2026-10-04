import { Component, lazy, Suspense, useEffect } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { safeReturnPath } from './auth/session'

const Login = lazy(() => import('./pages/Login'))
const DocList = lazy(() => import('./pages/DocList'))
const Editor = lazy(() => import('./pages/Editor'))
const Search = lazy(() => import('./pages/Search'))
const Templates = lazy(() => import('./pages/Templates'))
const Trash = lazy(() => import('./pages/Trash'))

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

export default function App() {
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    const expired = () => navigate('/login', { replace: true, state: {
      expired: true, from: safeReturnPath(location.pathname + location.search + location.hash),
    } })
    window.addEventListener('copage-auth-expired', expired)
    return () => window.removeEventListener('copage-auth-expired', expired)
  }, [location, navigate])
  return (
    <PageBoundary key={location.pathname}>
    <Suspense fallback={<main className="page-load-message" role="status">正在加载页面，请稍候…</main>}>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/docs" element={<RequireAuth><DocList /></RequireAuth>} />
      <Route path="/docs/:id" element={<RequireAuth><Editor /></RequireAuth>} />
      <Route path="/search" element={<RequireAuth><Search /></RequireAuth>} />
      <Route path="/templates" element={<RequireAuth><Templates /></RequireAuth>} />
      <Route path="/trash" element={<RequireAuth><Trash /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/docs" replace />} />
    </Routes>
    </Suspense>
    </PageBoundary>
  )
}
