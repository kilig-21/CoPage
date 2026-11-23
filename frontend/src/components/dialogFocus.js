import { useLayoutEffect } from 'react'

export function focusDialogControl(control) {
  if (!control) return
  const active = document.activeElement
  if (control.closest('[role="dialog"]')?.contains(active) &&
      active.matches('a[href], button, input, select, textarea, [contenteditable]')) return
  control.focus({ preventScroll: true })
}

export function useDialogEscapeFallback(onClose, canClose) {
  useLayoutEffect(() => {
    function closeFromBody(event) {
      // On a dialog swap the previous control disappears before the new dialog receives focus.
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented ||
          event.target !== document.body || document.activeElement !== document.body || canClose?.() === false) return
      event.preventDefault()
      onClose()
    }

    window.addEventListener('keydown', closeFromBody)
    return () => window.removeEventListener('keydown', closeFromBody)
  }, [onClose, canClose])
}
