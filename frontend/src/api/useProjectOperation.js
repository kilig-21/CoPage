import { useEffect, useRef, useState } from 'react'
import request from './request'
import { createProjectOperation } from './projectOperation'

export default function useProjectOperation(onConfirmed) {
  const mounted = useRef(false), callback = useRef(onConfirmed), controller = useRef(null)
  callback.current = onConfirmed
  const [, render] = useState(0)
  if (!controller.current) controller.current = createProjectOperation({
    readIdentity: () => ({ token: localStorage.getItem('collab-token'), account: localStorage.getItem('collab-user') }),
    readState: (target, config) => request.get('/projects/' + target.projectId +
      (['add', 'remove'].includes(target.kind) ? '/documents/' + target.docId : '') + '/state', config),
    changed: () => { if (mounted.current) render(value => value + 1) },
    confirmed: target => callback.current(target),
  })
  useEffect(() => {
    mounted.current = true
    const sync = () => controller.current.syncIdentity()
    window.addEventListener('storage', sync)
    window.addEventListener('copage-auth-changed', sync)
    return () => {
      mounted.current = false
      window.removeEventListener('storage', sync)
      window.removeEventListener('copage-auth-changed', sync)
      controller.current.cancel()
    }
  }, [])
  return { ...controller.current.snapshot(), ...controller.current,
    busy: Boolean(controller.current.snapshot().pending || controller.current.snapshot().checking) }
}
