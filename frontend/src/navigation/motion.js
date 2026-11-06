// 每次定位都读取当前偏好，窗口打开期间切换设置也立即生效。
export function previewScrollBehavior(environment = globalThis) {
  try {
    return environment.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === false ? 'smooth' : 'instant'
  } catch { return 'instant' }
}
