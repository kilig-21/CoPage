import { Component, lazy, Suspense, useEffect } from 'react'

const UserGuide = lazy(() => import('./UserGuide'))

function GuideNotice({ failed = false, onClose }) {
  useEffect(() => {
    function dismiss(event) {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', dismiss)
    return () => document.removeEventListener('keydown', dismiss)
  }, [onClose])

  return <div className="user-guide-notice">
    <span role={failed ? 'alert' : 'status'}>{failed ? '使用指南暂时无法加载。' : '正在加载使用指南…'}</span>
    <button type="button" onClick={onClose}>{failed ? '关闭提示' : '取消打开指南'}</button>
  </div>
}

class GuideBoundary extends Component {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    return this.state.failed
      ? <GuideNotice failed onClose={this.props.onClose} />
      : this.props.children
  }
}

export default function LazyUserGuide({ initialSection, onClose, triggerRef }) {
  function closeGuide() {
    onClose()
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }

  return <GuideBoundary onClose={closeGuide}>
    <Suspense fallback={<GuideNotice onClose={closeGuide} />}>
      <UserGuide initialSection={initialSection} onClose={closeGuide} />
    </Suspense>
  </GuideBoundary>
}
