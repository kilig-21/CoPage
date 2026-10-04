import { useEffect, useRef } from 'react'
import Quill from 'quill'
import 'quill/dist/quill.snow.css'

export default function DocumentPreview({ content, label = '文档预览' }) {
  const host = useRef(null)
  useEffect(() => {
    if (!host.current || !content) return undefined
    const node = host.current
    const preview = new Quill(node, { readOnly: true, theme: 'snow', modules: { toolbar: false } })
    preview.setContents(content, 'api')
    return () => { node.replaceChildren(); node.className = 'document-preview' }
  }, [content])
  return <div ref={host} className="document-preview" aria-label={label} />
}
