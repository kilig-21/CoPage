import { useEffect, useRef } from 'react'
import Quill from 'quill'
import 'quill/dist/quill.snow.css'
import { DOCUMENT_FORMATS } from '../editor/formats'
import { usePageRequest } from '../auth/PageSessionContext'
import { loadPrivateImages, registerPrivateImageBlot } from '../editor/privateImages'

export default function DocumentPreview({ content, label = '文档预览' }) {
  const host = useRef(null)
  const request = usePageRequest()
  useEffect(() => {
    if (!host.current || !content) return undefined
    const node = host.current
    registerPrivateImageBlot(Quill)
    const preview = new Quill(node, { readOnly: true, formats: DOCUMENT_FORMATS, theme: 'snow', modules: { toolbar: false } })
    preview.setContents(content, 'api')
    const disposeImages = loadPrivateImages(node, request)
    return () => { disposeImages(); node.replaceChildren(); node.className = 'document-preview' }
  }, [content, request])
  return <div ref={host} className="document-preview" aria-label={label} />
}
