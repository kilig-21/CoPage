import { useEffect, useRef, useState } from 'react'
import request from './request'
import { listPendingCopies } from './copyDocuments'
import { usePageSession } from '../auth/PageSessionContext'

export function copyIdentity() {
  try { return { account: localStorage.getItem('collab-user'), token: localStorage.getItem('collab-token'), service: request.defaults.baseURL } }
  catch { return null }
}
export function sameCopyIdentity(before) {
  const next = copyIdentity()
  return Boolean(before?.account && before.token && next && next.account === before.account && next.token === before.token && next.service === before.service)
}
export default function usePendingCopies() {
  const pageSession = usePageSession()
  const [refresh, setRefresh] = useState(0)
  const [state, setState] = useState({ records: [], loading: true, error: '', identity: null })
  const generation = useRef(0)
  useEffect(() => {
    const reload = () => { generation.current++; setState({ records: [], loading: true, error: '', identity: null }); setRefresh(value => value + 1) }
    window.addEventListener('storage', reload)
    window.addEventListener('copage-auth-changed', reload)
    window.addEventListener('copage-copy-creations-changed', reload)
    return () => {
      generation.current++
      window.removeEventListener('storage', reload)
      window.removeEventListener('copage-auth-changed', reload)
      window.removeEventListener('copage-copy-creations-changed', reload)
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController(), ticket = ++generation.current, identity = pageSession.identity
    setState({ records: [], loading: true, error: '', identity })
    const current = () => !controller.signal.aborted && ticket === generation.current && sameCopyIdentity(identity)
    Promise.resolve().then(() => listPendingCopies(pageSession.options({ signal: controller.signal }))).then(records => {
      if (current()) setState({ records, loading: false, error: '', identity })
      else if (!controller.signal.aborted && ticket === generation.current) setState({ records: [], loading: false,
        error: '当前账号暂时无法核对，请恢复登录信息读取后刷新记录；原记录保留。', identity: null })
    }).catch(error => {
      if (!controller.signal.aborted && ticket === generation.current) setState({ records: [], loading: false,
        error: sameCopyIdentity(identity) ? error?.message || '待确认副本暂时无法读取，原记录保留。' : '当前账号暂时无法核对，请恢复登录后再读取。', identity: null })
    })
    return () => controller.abort()
  }, [refresh])
  const readable = sameCopyIdentity(state.identity)
  return { records: readable ? state.records : [], loading: state.loading,
    error: state.error, identity: readable ? state.identity : null,
    refresh: () => setRefresh(value => value + 1) }
}
