export function focusWorkspaceRegion(region) {
  if (!region) return
  const header = document.querySelector('.workspace-header')
  const top = window.scrollY + region.getBoundingClientRect().top - (header?.getBoundingClientRect().height ?? 0) - 16
  region.focus({ preventScroll: true })
  window.scrollTo({ top: Math.max(0, top), behavior: 'instant' })
}
