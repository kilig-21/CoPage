import { createContext, useContext, useState } from 'react'
import request from '../api/request'
import { createPageRequest, createPageSession, readPageIdentity } from './pageSession.js'

const PageSessionContext = createContext(null)
export function PageSessionProvider({ children }) {
  const [session] = useState(() => {
    const scope = createPageSession(() => readPageIdentity(localStorage, request.defaults.baseURL))
    return Object.freeze({ ...scope, request: createPageRequest(request, scope) })
  })
  return <PageSessionContext.Provider value={session}>{children}</PageSessionContext.Provider>
}
export function usePageSession() {
  const session = useContext(PageSessionContext)
  if (!session) throw new Error('页面请求缺少原身份上下文')
  return session
}
export function usePageRequest() { return usePageSession().request }
