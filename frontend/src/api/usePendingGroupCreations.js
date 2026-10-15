import { useEffect, useRef, useState } from 'react'
import request from './request'
import { listPendingGroupCreations } from './createGroup'

export function groupCreationIdentity() {
  try { return { account: localStorage.getItem('collab-user'), token: localStorage.getItem('collab-token'), service: request.defaults.baseURL } }
  catch { return null }
}
export function sameGroupCreationIdentity(before) {
  const next = groupCreationIdentity()
  return Boolean(before?.account && before.token && next && next.account === before.account && next.token === before.token && next.service === before.service)
}
export default function usePendingGroupCreations() {
  const [refresh, setRefresh] = useState(0)
  const [state, setState] = useState({ records: [], loading: true, error: '', identity: null })
  const generation = useRef(0)
  useEffect(() => {
    const reload = () => { generation.current++; setState({ records: [], loading: true, error: '', identity: null }); setRefresh(value => value + 1) }
    for (const event of ['storage', 'copage-auth-changed', 'copage-group-creations-changed']) window.addEventListener(event, reload)
    return () => {
      generation.current++
      for (const event of ['storage', 'copage-auth-changed', 'copage-group-creations-changed']) window.removeEventListener(event, reload)
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController(), ticket = ++generation.current, identity = groupCreationIdentity()
    setState({ records: [], loading: true, error: '', identity })
    const current = () => !controller.signal.aborted && ticket === generation.current
    listPendingGroupCreations({ signal: controller.signal }).then(records => {
      if (!current()) return
      setState(sameGroupCreationIdentity(identity) ? { records, loading: false, error: '', identity }
        : { records: [], loading: false, error: '当前账号暂时无法核对，请恢复登录信息后刷新记录；原记录保留。', identity: null })
    }).catch(error => {
      if (current()) setState({ records: [], loading: false, error: error?.message || '小组创建记录暂时无法读取，原记录保留。', identity: null })
    })
    return () => controller.abort()
  }, [refresh])
  const readable = sameGroupCreationIdentity(state.identity)
  return { ...state, records: readable ? state.records : [], identity: readable ? state.identity : null,
    refresh: () => setRefresh(value => value + 1) }
}
