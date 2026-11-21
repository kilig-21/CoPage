const managedPath = /^(?:\/[^/?#]+)+\/(images\/\d{4}\/(?:0[1-9]|1[0-2])\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:jpg|png|gif|webp))$/
export const IMAGE_REFERENCE = 'data-copage-image'
export const IMAGE_PENDING = 'data-copage-image-pending'
const registered = new WeakSet()

export function privateImagePath(reference) {
  if (typeof reference !== 'string' || !reference.includes('/images/')) return null
  try {
    const url = new URL(reference)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    const match = managedPath.exec(url.pathname)
    return match ? '/' + match[1] : null
  } catch { return null }
}

export function registerPrivateImageBlot(Quill) {
  if (registered.has(Quill)) return
  const Image = Quill.import('formats/image')
  class PrivateImage extends Image {
    static create(value) {
      if (!privateImagePath(value)) return super.create(value)
      const node = super.create()
      node.setAttribute(IMAGE_REFERENCE, value)
      node.setAttribute(IMAGE_PENDING, '')
      return node
    }
    static value(node) {
      return node.getAttribute(IMAGE_REFERENCE) ?? super.value(node)
    }
  }
  Quill.register('formats/image', PrivateImage, true)
  registered.add(Quill)
}

export function loadPrivateImages(container, request) {
  const byPath = new Map()
  let active = 0
  let stopped = false

  function refresh() {
    if (stopped) return
    const nodes = new Map()
    for (const node of container.querySelectorAll('img[' + IMAGE_REFERENCE + ']')) {
      const path = privateImagePath(node.getAttribute(IMAGE_REFERENCE))
      if (!path) continue
      if (!nodes.has(path)) nodes.set(path, new Set())
      nodes.get(path).add(node)
    }
    for (const [path, entry] of byPath) {
      if (!nodes.has(path)) {
        entry.controller.abort()
        if (entry.url) URL.revokeObjectURL(entry.url)
        byPath.delete(path)
      }
    }
    for (const [path, images] of nodes) {
      let entry = byPath.get(path)
      if (!entry) {
        entry = { controller: new AbortController(), state: 'queued' }
        byPath.set(path, entry)
      }
      entry.nodes = images
      render(entry)
    }
    start()
  }

  function render(entry) {
    for (const node of entry.nodes) {
      if (!node.hasAttribute(IMAGE_PENDING)) continue
      if (entry.state === 'loaded') {
        node.removeAttribute(IMAGE_PENDING)
        node.src = entry.url
      } else if (entry.state === 'failed') {
        node.removeAttribute(IMAGE_PENDING)
        node.dispatchEvent(new Event('error'))
      }
    }
  }

  function start() {
    if (stopped) return
    for (const [path, entry] of byPath) {
      if (active >= 4) break
      if (entry.state !== 'queued') continue
      entry.state = 'loading'
      active++
      Promise.resolve().then(() => request.get(path, { responseType: 'blob', signal: entry.controller.signal }))
        .then(blob => {
          if (entry.controller.signal.aborted) return
          if (!(blob instanceof Blob) || !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(blob.type)) {
            throw new Error('图片响应格式无效')
          }
          entry.url = URL.createObjectURL(blob)
          entry.state = 'loaded'
          render(entry)
        }).catch(() => {
          if (entry.controller.signal.aborted) return
          entry.state = 'failed'
          render(entry)
        }).finally(() => { active--; start() })
    }
  }

  const observer = new MutationObserver(refresh)
  observer.observe(container, { childList: true, subtree: true })
  refresh()
  return () => {
    stopped = true
    observer.disconnect()
    for (const entry of byPath.values()) {
      entry.controller.abort()
      if (entry.url) URL.revokeObjectURL(entry.url)
    }
    byPath.clear()
  }
}
