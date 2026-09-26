import { Navigate, Route, Routes } from 'react-router-dom'
import Login from './pages/Login'
import DocList from './pages/DocList'
import Editor from './pages/Editor'
import Search from './pages/Search'

function RequireAuth({ children }) {
  return localStorage.getItem('collab-token')
    ? children
    : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/docs" element={<RequireAuth><DocList /></RequireAuth>} />
      <Route path="/docs/:id" element={<RequireAuth><Editor /></RequireAuth>} />
      <Route path="/search" element={<RequireAuth><Search /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/docs" replace />} />
    </Routes>
  )
}
