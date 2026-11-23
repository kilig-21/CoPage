import { useLayoutEffect } from 'react'

export function focusDialogControl(control) {
  if (!control) return
  const active = document.activeElement
  if (control.closest('[role="dialog"]')?.contains(active) &&
      active.matches('a[href], button, input, select, textarea, [contenteditable]')) return
  control.focus({ preventScroll: true })
}

export function useDialogEscapeFallback(onClose, canClose, triggerRef) {
  useLayoutEffect(() => {
    function closeDuringFocusHandoff(event) {
      // A dialog may still be opening while focus remains on its trigger or the body.
      const active = document.activeElement
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented ||
          event.target !== active || (active !== document.body && active !== triggerRef?.current) || canClose?.() === false) return
      event.preventDefault()
      onClose()
    }

    window.addEventListener('keydown', closeDuringFocusHandoff)
    return () => window.removeEventListener('keydown', closeDuringFocusHandoff)
  }, [onClose, canClose, triggerRef])
}
