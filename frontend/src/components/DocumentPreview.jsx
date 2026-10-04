import { useEffect, useRef } from 'react'
import Quill from 'quill'
import 'quill/dist/quill.snow.css'
import { DOCUMENT_FORMATS } from '../editor/formats'

export default function DocumentPreview({ content, label = '文档预览' }) {
  const host = useRef(null)
  useEffect(() => {
    if (!host.current || !content) return undefined
    const node = host.current
    const preview = new Quill(node, { readOnly: true, formats: DOCUMENT_FORMATS, theme: 'snow', modules: { toolbar: false } })
    preview.setContents(content, 'api')
    return () => { node.replaceChildren(); node.className = 'document-preview' }
  }, [content])
  return <div ref={host} className="document-preview" aria-label={label} />
}
