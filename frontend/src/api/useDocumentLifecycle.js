import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePageSession } from '../auth/PageSessionContext'
import { confirmDocumentDeletion, parseDocumentRestoration, parseDocumentState } from './documentLifecycle.js'
import { createDocumentLifecycleStore, documentLifecycleKey, lockDocumentLifecycleRecord } from './documentLifecycleStore.js'

const storageError = '浏览器暂时无法读取待核对记录。请恢复本站存储后重试。'

export default function useDocumentLifecycle({ operation, ready = false, onConfirmed }) {
  const session = usePageSession()
  const key = session.identity && documentLifecycleKey(session.identity)
  const store = useMemo(() => createDocumentLifecycleStore({ storage: () => localStorage, key, withLock: lockDocumentLifecycleRecord }), [key])
  const attempt = useRef(null)
  const callbacks = useRef({ ready, onConfirmed })
  callbacks.current = { ready, onConfirmed }

  const [record, setRecord] = useState(null)
  const [storageFailed, setStorageFailed] = useState(false)
  const [pendingId, setPendingId] = useState(null)
  const [checking, setChecking] = useState(false)
  const [failedRecord, setFailedRecord] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState(null)

  const sync = useCallback(() => {
    if (!session.current()) {
      setRecord(null)
      return
    }
    try {
      setRecord(store.read())
      setStorageFailed(false)
    } catch {
      setStorageFailed(true)
    }
  }, [session, store])

  useEffect(() => {
    const changed = event => {
      if (event.type === 'storage' && event.key !== null && ![key, 'collab-user', 'collab-token'].includes(event.key)) return
      if (!session.current()) attempt.current?.abort()
      sync()
    }
    sync()
    window.addEventListener('storage', changed)
    window.addEventListener('copage-auth-changed', changed)
    window.addEventListener('copage-auth-expired', changed)
    return () => {
      attempt.current?.abort()
      attempt.current = null
      window.removeEventListener('storage', changed)
      window.removeEventListener('copage-auth-changed', changed)
      window.removeEventListener('copage-auth-expired', changed)
    }
  }, [key, session, sync])

  async function execute(work, { id = null, checking = false } = {}) {
    if (attempt.current || !session.current()) return
    const controller = new AbortController()
    attempt.current = controller
    const current = () => attempt.current === controller && !controller.signal.aborted && session.current()
    const config = { signal: controller.signal }
    setPendingId(id)
    setChecking(checking)
    setError('')
    setNotice(null)
    try {
      await store.exclusive(async () => {
        if (current()) await work({ current, config })
      })
    } catch (failure) {
      if (current()) setError(failure.message || storageError)
    } finally {
      if (attempt.current === controller) {
        attempt.current = null
        setPendingId(null)
        setChecking(false)
        sync()
      }
    }
  }

  function run(doc) {
    if (!operation || !callbacks.current.ready) return
    return execute(async ({ current, config }) => {
      if (!callbacks.current.ready) return
      const raw = store.prepare({ id: doc.id, operation })
      if (raw === null || !current()) return

      let data
      try {
        const reply = operation === 'delete'
          ? await session.request.delete('/doc/' + doc.id, config)
          : await session.request.post('/doc/' + doc.id + '/restore', undefined, config)
        if (!current()) return
        if (operation === 'delete') confirmDocumentDeletion(reply)
        else data = parseDocumentRestoration(reply, doc.id)
      } catch (failure) {
        if (!current()) return
        if ([400, 401, 403, 404].includes(failure?.code)) {
          store.clear(raw)
          setError(failure.message || '请求未获准，请刷新后核对当前资料。')
        }
        return
      }

      store.clear(raw)
      const title = data?.title ?? doc.title
      const message = operation === 'delete' ? `“${title}”已移入回收站` : `“${title}”已恢复`
      setNotice({ type: 'success', message, id: doc.id, deleted: operation === 'delete' })
      callbacks.current.onConfirmed()
    }, { id: doc.id })
  }

  function review() {
    if (!record?.target) return
    return execute(async ({ current, config }) => {
      if (store.read()?.raw !== record.raw) return
      const target = record.target
      let data
      try {
        const reply = await session.request.get('/doc/' + target.id + '/state', config)
        if (!current()) return
        data = parseDocumentState(reply, target.id)
      } catch {
        if (current()) {
          setFailedRecord(record.raw)
          setError('暂时无法核对这篇文档。请稍后重试。')
        }
        return
      }

      store.clear(record.raw)
      setFailedRecord(null)
      const status = data.deleted ? '在回收站' : '可正常打开'
      setNotice({ type: 'info', message: `已核对：“${data.title}”当前${status}。`, id: data.id, deleted: data.deleted })
      callbacks.current.onConfirmed()
    }, { checking: true })
  }

  const reviewFailed = Boolean(record && failedRecord === record.raw)

  function endWaiting(expected) {
    if (!record || expected !== record.raw || (record.target && !reviewFailed)) return
    return execute(async () => {
      if (!store.clear(record.raw)) return
      setFailedRecord(null)
      setNotice({ type: 'warning', message: record.target
        ? `已结束等待。文档 #${record.target.id} 的操作结果仍未知，请先查看原资料。`
        : '已移除无法读取的待核对记录。请先查看原资料。' })
      callbacks.current.onConfirmed()
    }, { checking: true })
  }

  const busy = pendingId !== null || checking
  const visible = session.current()
  return {
    pendingId, checking, busy, run, review, endWaiting,
    record: visible ? record : null,
    storageFailed, retryStorage: sync,
    reviewFailed,
    error: visible ? error || (storageFailed ? storageError : '') : '',
    notice: visible ? notice : null,
    blocked: !visible || !ready || busy || storageFailed || Boolean(record),
  }
}
