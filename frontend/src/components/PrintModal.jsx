import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Modal, Space, Spin, Typography } from 'antd'
import { usePageRequest } from '../auth/PageSessionContext'
import { confirmPrintAccess, parsePrintSnapshot } from '../api/printSnapshot'
import { requestFailureMessage } from '../api/requestError'
import DocumentPreview from './DocumentPreview'
import { IMAGE_PENDING } from '../editor/privateImages'

export default function PrintModal({ docId, canPrint, onClose }) {
  const request = usePageRequest()
  const [portal] = useState(() => {
    const node = document.createElement('div')
    node.className = 'document-print-portal'
    return node
  })
  const [snapshot, setSnapshot] = useState(null)
  const [loading, setLoading] = useState(true)
  const [printing, setPrinting] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(() => canPrint())
  const [attempt, setAttempt] = useState(0)
  const [assetsReady, setAssetsReady] = useState(false)
  const [missingImages, setMissingImages] = useState(0)
  const [acceptMissing, setAcceptMissing] = useState(false)
  const sheet = useRef(null)
  const notices = useRef(null)
  const permissionCheck = useRef(null)
  const canPrintRef = useRef(canPrint)
  canPrintRef.current = canPrint

  useLayoutEffect(() => {
    document.body.append(portal)
    return () => portal.remove()
  }, [portal])
  useLayoutEffect(() => {
    if (error || missingImages) notices.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  }, [error, missingImages])
  useEffect(() => {
    const timer = setInterval(() => setReady(canPrintRef.current()), 200)
    return () => { clearInterval(timer); permissionCheck.current?.abort() }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setSnapshot(null); setAssetsReady(false); setAcceptMissing(false); setMissingImages(0)
    setError(''); setLoading(true)
    if (!canPrintRef.current()) {
      setError('请先等待连接、同步和保存完成，再刷新预览')
      setLoading(false)
      return () => controller.abort()
    }
    request.get('/doc/' + docId, { signal: controller.signal })
      .then(response => {
        if (controller.signal.aborted) return
        if (!canPrintRef.current()) throw new Error('连接或编辑状态已变化，请等待同步后刷新预览')
        setSnapshot(parsePrintSnapshot(response, docId))
      })
      .catch(ex => { if (!controller.signal.aborted) setError(requestFailureMessage(ex, '打印预览读取失败，请重试')) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [docId, attempt, request])
  useEffect(() => {
    const preview = sheet.current
    if (!snapshot || !preview) return undefined
    let expired = false
    const refreshAssets = () => {
      const content = preview.querySelector('.ql-editor')
      if (!content) return
      let pending = false
      let missing = 0
      for (const image of content.querySelectorAll('img')) {
        const loading = !image.complete || image.hasAttribute(IMAGE_PENDING)
        pending ||= loading
        if (loading || !image.naturalWidth) missing++
      }
      const settled = !pending || expired
      setMissingImages(settled ? missing : 0)
      setAssetsReady(settled)
    }

    // The preview can replace its image nodes while initializing. Read the live DOM on each notification.
    const observer = new MutationObserver(refreshAssets)
    observer.observe(preview, { childList: true, subtree: true, attributes: true, attributeFilter: [IMAGE_PENDING, 'src'] })
    preview.addEventListener('load', refreshAssets, true)
    preview.addEventListener('error', refreshAssets, true)
    const timer = setTimeout(() => { expired = true; refreshAssets() }, 10_000)
    refreshAssets()
    return () => {
      clearTimeout(timer)
      observer.disconnect()
      preview.removeEventListener('load', refreshAssets, true)
      preview.removeEventListener('error', refreshAssets, true)
    }
  }, [snapshot])

  async function print() {
    if (printing || loading || !snapshot || !assetsReady) return
    if (!canPrintRef.current()) { setError('请先等待连接、同步和保存完成'); return }
    if (missingImages && !acceptMissing) { setError('部分图片无法显示，请刷新预览或确认接受缺图'); return }
    const controller = new AbortController()
    permissionCheck.current = controller
    setPrinting(true); setError('')
    try {
      // 重新校验仍可访问，打印的是明确标注版本的固定副本。
      const response = await request.get('/doc/' + docId + '/metadata', { signal: controller.signal })
      if (controller.signal.aborted) return
      confirmPrintAccess(response, docId)
      if (!canPrintRef.current()) throw new Error('连接或编辑状态已变化，请等待同步后重试')
      const oldTitle = document.title
      try { document.title = snapshot.title + ' · CoPage'; window.print() }
      finally { document.title = oldTitle }
    } catch (ex) {
      if (!controller.signal.aborted) setError(requestFailureMessage(ex, '无法打开打印，请重试'))
    } finally {
      if (!controller.signal.aborted) setPrinting(false)
      if (permissionCheck.current === controller) permissionCheck.current = null
    }
  }
  useEffect(() => {
    const shortcut = event => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault()
        onClose()
        return
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey ||
          event.isComposing || event.key.toLowerCase() !== 'p') return
      event.preventDefault()
      void print()
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  })
  const disabled = !ready || loading || printing || !snapshot || !assetsReady || (missingImages > 0 && !acceptMissing)
  const empty = snapshot?.content.ops.every(({ insert }) => typeof insert === 'string' && !insert.trim())
  return <Modal className="document-print-modal" title="打印 / 另存为 PDF" open width={880} getContainer={portal} onCancel={onClose}
    footer={<Space wrap>
      <Button disabled={loading || printing || !ready} onClick={() => setAttempt(value => value + 1)}>刷新预览</Button>
      <Button onClick={onClose}>关闭</Button>
      <Button type="primary" disabled={disabled} loading={printing} onClick={print}>打开打印窗口</Button>
    </Space>}>
    <div className="document-print-controls">
      <details className="document-print-help">
        <summary>打印说明</summary>
        <Typography.Paragraph>预览使用打开时已保存的版本。要纳入之后保存的编辑，请刷新预览。</Typography.Paragraph>
        <Typography.Paragraph type="secondary">可在浏览器打印窗口选择「另存为 PDF」，并设置纸张、页边距和页眉页脚。图片随预览加载，失败时可刷新重试。</Typography.Paragraph>
      </details>
      {!ready && !error && <Alert type="warning" showIcon message="请先等待连接、同步和保存完成" />}
      <div ref={notices}>
        {error && <Alert type="error" showIcon message={error} />}
        {(loading || (snapshot && !assetsReady)) && <div role="status"><Spin size="small" /> {loading ? '正在读取已保存版本…' : '正在加载打印图片…'}</div>}
        {missingImages > 0 && <Alert type="warning" showIcon message={missingImages + ' 张图片未能加载'}
          description={<Checkbox checked={acceptMissing} onChange={event => setAcceptMissing(event.target.checked)}>我接受缺图，仅打印当前可见内容</Checkbox>} />}
      </div>
    </div>
    <article ref={sheet} className="document-print-sheet" aria-label="打印文档预览" hidden={!snapshot}>
      {snapshot && <>
        <h1>{snapshot.title}</h1>
        <p className="document-print-meta">CoPage · 已保存版本 {snapshot.revision}</p>
        {missingImages > 0 && <p className="document-print-meta">部分图片未能加载，本副本可能缺图。</p>}
        {empty && <p className="document-print-empty">此版本没有正文。</p>}
        <DocumentPreview content={snapshot.content} label="打印正文" />
      </>}
    </article>
  </Modal>
}
