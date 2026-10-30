import { useEffect, useRef, useState } from 'react'
import { usePageSession } from '../auth/PageSessionContext'
import { createHistoryRestore } from './historyRestore'
import { createHistoryRestoreStore } from './historyRestoreStore'

const pending = createHistoryRestoreStore({ getStorage: () => localStorage,
  withLock: (name, action, signal) => {
    const locks = globalThis.navigator?.locks
    if (!locks?.request) throw Error('浏览器暂不支持安全保存恢复确认，请使用当前版本浏览器。')
    return locks.request(name, { mode: 'exclusive', ...(signal ? { signal } : {}) }, action)
  },
})

export default function useHistoryRestore(docId, isOwner, canRestore, onConfirmed) {
  const pageSession = usePageSession()
  const request = pageSession.request
  const mounted = useRef(false), callbacks = useRef(null)
  callbacks.current = { isOwner, canRestore, onConfirmed }
  const [, render] = useState(0)
  const scope = useRef(null)
  const service = request.defaults.baseURL || ''
  if (!scope.current || scope.current.docId !== docId || scope.current.service !== service) {
    const previous = scope.current
    scope.current = null
    previous?.controller.deactivate()
    const entry = { docId, service, controller: null }
    scope.current = entry
    entry.controller = createHistoryRestore({ service, docId, pending,
      readIdentity: () => pageSession.current() ? pageSession.identity : null,
      ready: () => callbacks.current.isOwner && callbacks.current.canRestore(),
      perform: (target, config) => request.post(`/doc/${docId}/history/${target.targetRevision}/restore`,
        { expectedRevision: target.expectedRevision, requestId: target.requestId }, config),
      confirmed: (...args) => callbacks.current.onConfirmed(...args),
      changed: () => { if (mounted.current && scope.current === entry && entry.controller) render(value => value + 1) },
    })
  }
  const controller = scope.current.controller
  useEffect(() => {
    mounted.current = true
    controller.activate()
    const sync = () => controller.syncIdentity()
    sync()
    window.addEventListener('storage', sync)
    window.addEventListener('copage-auth-changed', sync)
    window.addEventListener('copage-auth-expired', sync)
    return () => {
      mounted.current = false
      window.removeEventListener('storage', sync)
      window.removeEventListener('copage-auth-changed', sync)
      window.removeEventListener('copage-auth-expired', sync)
      controller.deactivate()
    }
  }, [controller])
  return { ...controller.snapshot(), ...controller }
}
