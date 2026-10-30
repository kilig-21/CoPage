import { useEffect, useRef, useState } from 'react'
import { sameDocumentCreationIdentity, listPendingDocumentCreations } from './createDocument'
import { usePageSession } from '../auth/PageSessionContext'

export default function usePendingDocumentCreations(expectedIdentity) {
  const pageSession = usePageSession()
  const identity = useRef(expectedIdentity === undefined ? pageSession.identity : expectedIdentity)
  const [refresh, setRefresh] = useState(0), generation = useRef(0)
  const [state, setState] = useState({ records: [], unreadable: 0, loading: true, error: '' })
  useEffect(() => {
    const reload = () => { generation.current++; setRefresh(n => n + 1) }
    const prefix = identity.current && `copage-document-create:v1:${encodeURIComponent(identity.current.service)}:${encodeURIComponent(identity.current.account)}:`
    const storageChanged = event => {
      try { if (event.storageArea !== localStorage) return } catch { reload(); return }
      if (event.key === null || ['collab-token', 'collab-user'].includes(event.key) || (prefix && event.key?.startsWith(prefix))) reload()
    }
    window.addEventListener('storage', storageChanged)
    for (const event of ['copage-auth-changed', 'copage-document-creations-changed']) window.addEventListener(event, reload)
    return () => {
      generation.current++
      window.removeEventListener('storage', storageChanged)
      for (const event of ['copage-auth-changed', 'copage-document-creations-changed']) window.removeEventListener(event, reload)
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController(), ticket = ++generation.current
    setState(current => ({ ...current, loading: true, error: '' }))
    Promise.resolve().then(() => listPendingDocumentCreations(pageSession.options({ expectedIdentity: identity.current, signal: controller.signal })))
      .then(result => {
        if (!controller.signal.aborted && ticket === generation.current && sameDocumentCreationIdentity(identity.current))
          setState({ ...result, loading: false, error: '' })
      }).catch(error => {
        if (!controller.signal.aborted && ticket === generation.current)
          setState({ records: [], unreadable: 0, loading: false, error: error.message || '暂时无法读取原创建记录，记录保留。' })
      })
    return () => controller.abort()
  }, [refresh])
  const current = sameDocumentCreationIdentity(identity.current)
  return { ...state, records: current ? state.records : [], identity: identity.current,
    loading: current && state.loading, refresh: () => setRefresh(n => n + 1) }
}
