import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import Login from './pages/Login'
import DocList from './pages/DocList'
import Editor from './pages/Editor'
import Search from './pages/Search'
import Templates from './pages/Templates'
import Trash from './pages/Trash'
import { safeReturnPath } from './auth/session'

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
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/docs" element={<RequireAuth><DocList /></RequireAuth>} />
      <Route path="/docs/:id" element={<RequireAuth><Editor /></RequireAuth>} />
      <Route path="/search" element={<RequireAuth><Search /></RequireAuth>} />
      <Route path="/templates" element={<RequireAuth><Templates /></RequireAuth>} />
      <Route path="/trash" element={<RequireAuth><Trash /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/docs" replace />} />
    </Routes>
  )
}
