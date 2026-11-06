import { useLayoutEffect } from 'react'
import { useLocation } from 'react-router-dom'

export default function WorkspaceRouteFocus({ previousSurface }) {
  const location = useLocation()
  const surface = location.pathname === '/templates'
    ? `${location.pathname}:${new URLSearchParams(location.search).get('source') === 'personal' ? 'personal' : 'builtin'}`
    : location.pathname

  useLayoutEffect(() => {
    const previous = previousSurface.current
    previousSurface.current = surface
    if (previous === null || previous === surface) return
    const main = document.getElementById('workspace-main')
    const heading = main?.querySelector('h1')
    // Keep focus already placed inside the new page by its own controls.
    if (!heading || main.contains(document.activeElement)) return
    heading.tabIndex = -1
    heading.focus({ preventScroll: true })
  }, [previousSurface, surface])

  return null
}
