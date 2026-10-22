import { useEffect, useRef, useState } from 'react'
import { listPendingProjectDocuments, projectDocumentIdentity, sameProjectDocumentIdentity } from './projectDocuments'
import { subscribeProjectDocumentEvents } from './projectDocumentEvents'

export default function usePendingProjectDocuments() {
  const [refresh, setRefresh] = useState(0)
  const [state, setState] = useState({ records: [], loading: true, error: '', identity: null })
  const generation = useRef(0)
  useEffect(() => {
    const reload = () => { generation.current++; setState({ records: [], loading: true, error: '', identity: null }); setRefresh(value => value + 1) }
    const unsubscribe = subscribeProjectDocumentEvents({ eventTarget: window, getStorage: () => localStorage,
      readIdentity: projectDocumentIdentity, onRecordsChanged: reload })
    return () => { generation.current++; unsubscribe() }
  }, [])
  useEffect(() => {
    const controller = new AbortController(), ticket = ++generation.current, identity = projectDocumentIdentity()
    setState({ records: [], loading: true, error: '', identity })
    const current = () => !controller.signal.aborted && generation.current === ticket
    listPendingProjectDocuments({ signal: controller.signal }).then(records => {
      if (current()) setState(sameProjectDocumentIdentity(identity) ? { records, loading: false, error: '', identity }
        : { records: [], loading: false, error: '当前账号暂时无法核对，原创建记录保留。', identity: null })
    }).catch(failure => { if (current()) setState({ records: [], loading: false, error: failure?.message || '本地创建记录暂不可读，原记录保留。', identity: null }) })
    return () => controller.abort()
  }, [refresh])
  const readable = sameProjectDocumentIdentity(state.identity)
  return { ...state, records: readable ? state.records : [], identity: readable ? state.identity : null,
    refresh: () => setRefresh(value => value + 1) }
}
