import { useEffect, useRef, useState } from 'react'
import request from './request'

// 列表刷新不能证明某篇文档的写结果；显式核对只读取原目标的当前状态。
export default function useDocumentLifecycle({ operation, ready, onConfirmed }) {
  const lock = useRef(null), unknown = useRef(null), confirmed = useRef(onConfirmed), available = useRef(ready)
  confirmed.current = onConfirmed
  available.current = ready
  const [pendingId, setPendingId] = useState(null)
  const [checking, setChecking] = useState(false)
  const [uncertain, setUncertain] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState(null)
  const verb = operation === 'delete' ? '删除' : '恢复'
  useEffect(() => () => { lock.current?.controller.abort(); lock.current = null }, [])
  function begin(target) {
    let token, account
    try { token = localStorage.getItem('collab-token'); account = localStorage.getItem('collab-user') }
    catch { setError('浏览器无法读取当前账号，请允许本站保存数据后重试。'); return null }
    const attempt = { target, controller: new AbortController(), token, account }
    lock.current = attempt
    return attempt
  }
  function current(attempt) {
    if (lock.current !== attempt || attempt.controller.signal.aborted) return false
    try { return localStorage.getItem('collab-token') === attempt.token && localStorage.getItem('collab-user') === attempt.account }
    catch { attempt.identityUnavailable = true; return null }
  }
  function config(attempt) { return { signal: attempt.controller.signal, copageExpectedSessionToken: attempt.token } }
  function finish(attempt) {
    if (lock.current !== attempt) return
    const visible = current(attempt)
    lock.current = null
    setPendingId(null); setChecking(false)
    if (visible !== false && attempt.identityUnavailable) {
      unknown.current = attempt.target; setUncertain(attempt.target); setNotice(null)
      setError('浏览器暂时无法核对当前账号，操作结果仍未确认；允许本站保存数据后，再核对这篇文档。')
    }
  }
  async function run(doc) {
    if (lock.current || unknown.current || !available.current) return
    const attempt = begin({ id: doc.id, title: doc.title })
    if (!attempt) return
    setPendingId(doc.id); setError(''); setNotice(null)
    try {
      const result = operation === 'delete'
        ? await request.delete('/doc/' + doc.id, config(attempt))
        : await request.post('/doc/' + doc.id + '/restore', undefined, config(attempt))
      if (!current(attempt)) return
      if (operation === 'restore' && (result.data?.id !== doc.id || typeof result.data.title !== 'string')) throw new Error('恢复响应无效')
      const title = result.data?.title ?? attempt.target.title
      setNotice({ type: 'success', message: `“${title}”已${operation === 'delete' ? '移入回收站' : '恢复'}`, openId: operation === 'restore' ? result.data.id : null })
      confirmed.current()
    } catch (failure) {
      if (!current(attempt)) return
      if ([400, 401, 403, 404].includes(failure?.code)) setError(failure.message || `${verb}请求未获准，请刷新后核对当前资料。`)
      else {
        unknown.current = attempt.target; setUncertain(attempt.target)
        setError(`${verb}结果未确认，请核对这篇文档的当前状态，再决定是否重新操作。`)
      }
    } finally { finish(attempt) }
  }
  async function review() {
    const target = unknown.current
    if (lock.current || !target) return
    const attempt = begin(target)
    if (!attempt) return
    setChecking(true); setError('')
    try {
      const { data } = await request.get('/doc/' + target.id + '/state', config(attempt))
      if (!current(attempt) || unknown.current !== target) return
      if (data?.id !== target.id || typeof data.deleted !== 'boolean' || typeof data.title !== 'string') throw new Error('核对响应无效')
      unknown.current = null; setUncertain(null)
      const matches = data.deleted === (operation === 'delete')
      setNotice({ type: 'info', message: `已核对：“${data.title}”当前${data.deleted ? '在回收站' : '可正常打开'}。${matches ? '' : '请按当前状态决定是否重新操作。'}`,
        openId: !data.deleted && operation === 'restore' ? data.id : null })
      confirmed.current()
    } catch {
      if (current(attempt)) setError('暂时无法核对这篇文档，原操作结果仍未确认；请稍后重试核对。')
    } finally { finish(attempt) }
  }
  return { pendingId, checking, uncertain, error, notice, run, review, busy: pendingId !== null || checking,
    blocked: !ready || pendingId !== null || checking || Boolean(uncertain) }
}
