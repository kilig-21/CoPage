import { Navigate, Route, Routes } from 'react-router-dom'
import Login from './pages/Login'
import DocList from './pages/DocList'
import Editor from './pages/Editor'
import Search from './pages/Search'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/docs" element={<DocList />} />
      <Route path="/docs/:id" element={<Editor />} />
      <Route path="/search" element={<Search />} />
      <Route path="*" element={<Navigate to="/docs" replace />} />
    </Routes>
  )
}
