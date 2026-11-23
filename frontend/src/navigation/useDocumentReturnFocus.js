import { useLayoutEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'

export default function useDocumentReturnFocus(ready) {
  const location = useLocation()
  const documentId = location.state?.returnDocumentId
  const handled = useRef(null)

  useLayoutEffect(() => {
    if (!ready || !Number.isSafeInteger(documentId) || documentId <= 0 || handled.current === location.key) return
    handled.current = location.key
    const main = document.getElementById('workspace-main')
    const link = main?.querySelector(`a[data-document-id="${documentId}"]`)
    if (!link) return

    const active = document.activeElement
    // The page heading is the default focus after navigation. Leave deliberate focus elsewhere alone.
    if (active !== document.body && active !== main && active !== main.querySelector('h1')) return

    const { top, bottom } = link.getBoundingClientRect()
    const headerBottom = document.querySelector('.workspace-header')?.getBoundingClientRect().bottom ?? 0
    if (top < headerBottom + 4 || bottom > window.innerHeight - 4) {
      link.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
    }
    link.focus({ preventScroll: true })
  }, [documentId, location.key, ready])
}
