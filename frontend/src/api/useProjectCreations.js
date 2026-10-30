import { useEffect, useState } from 'react'
import request from './request'
import { createProjectCreator } from './projectCreation'
import { usePageSession } from '../auth/PageSessionContext'

const creator = createProjectCreator({ getStorage: () => localStorage, crypto: globalThis.crypto,
  post: (path, body, config) => request.post(path, body, config) })
const service = request.defaults.baseURL
function identity() {
  const token = localStorage.getItem('collab-token'), account = localStorage.getItem('collab-user')
  if (!token || !account) throw new Error('请重新登录后读取本账号的待确认创建。')
  return { token, account }
}
function options(captured, config = {}) {
  return { ...config, account: captured.account, service, copageExpectedSessionToken: captured.token,
    isCurrent: () => localStorage.getItem('collab-token') === captured.token && localStorage.getItem('collab-user') === captured.account }
}
const identityError = '浏览器暂时无法核对当前账号，原创建记录保留；请重新读取待确认创建。'
function isCurrent(captured) {
  if (!captured) return false
  try {
    const current = identity()
    return current.token === captured.token && current.account === captured.account
  } catch { return false }
}
export default function useProjectCreations(busy) {
  const pageSession = usePageSession()
  const [records, setRecords] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const [loadedFor, setLoadedFor] = useState(null)
  const [revision, setRevision] = useState(0)
  const reload = () => setRevision(value => value + 1)
  useEffect(() => {
    const changed = event => {
      if (!event.key || ['collab-token', 'collab-user'].includes(event.key) || event.key.startsWith('copage-project-create:v1:')) reload()
    }
    window.addEventListener('storage', changed)
    window.addEventListener('copage-auth-changed', reload)
    return () => { window.removeEventListener('storage', changed); window.removeEventListener('copage-auth-changed', reload) }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setRecords(null); setLoadedFor(null); setError(''); setLoading(true)
    let captured
    try { captured = pageSession.assertCurrent() }
    catch { setError('浏览器暂时无法读取当前账号，原创建记录保留；请恢复存储后重试。'); setLoading(false); return }
    setLoadedFor(captured)
    creator.listPending(options(captured, { signal: controller.signal })).then(value => {
      if (controller.signal.aborted) return
      if (!isCurrent(captured)) { setRecords(null); setError(identityError); return }
      setRecords(value)
    }).catch(failure => {
      if (!controller.signal.aborted) setError(isCurrent(captured)
        ? failure.message || '待确认创建暂时无法读取，原记录保留。' : identityError)
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision, busy])
  function capturedOptions(config, onPrepared) {
    const captured = pageSession.assertCurrent()
    pageSession.options(config)
    if (captured.token !== config.copageExpectedSessionToken) throw new DOMException('账号已变更', 'AbortError')
    return options(captured, { ...config, onPrepared, deferCleanup: true })
  }
  // 身份事件到达后effect清理前，以及扫描Promise完成后到提交之间，都不能显示旧账号摘要。
  const stale = loadedFor !== null && !isCurrent(loadedFor)
  return { records: stale ? null : records, error: stale ? identityError : error, loading: stale ? false : loading,
    reload, reportMissing: () => setError('原创建记录暂不可用，请重新读取，或先自行查看原项目资料。'),
    create: (body, config, onPrepared) => creator.create(body, capturedOptions(config, onPrepared)),
    retry: (record, config, onPrepared) => creator.retry(record, capturedOptions(config, onPrepared)) }
}
