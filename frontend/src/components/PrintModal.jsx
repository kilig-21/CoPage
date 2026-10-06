import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Modal, Space, Spin, Typography } from 'antd'
import request from '../api/request'
import DocumentPreview from './DocumentPreview'

export default function PrintModal({ docId, canPrint, onClose }) {
  const [portal] = useState(() => {
    const node = document.createElement('div')
    node.className = 'document-print-portal'
    return node
  })
  const [snapshot, setSnapshot] = useState(null)
  const [loading, setLoading] = useState(false)
  const [printing, setPrinting] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(() => canPrint())
  const [attempt, setAttempt] = useState(0)
  const [assetsReady, setAssetsReady] = useState(false)
  const [missingImages, setMissingImages] = useState(0)
  const [acceptMissing, setAcceptMissing] = useState(false)
  const sheet = useRef(null)
  const permissionCheck = useRef(null)
  const canPrintRef = useRef(canPrint)
  canPrintRef.current = canPrint

  useLayoutEffect(() => {
    document.body.append(portal)
    return () => portal.remove()
  }, [portal])
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
      .then(({ data }) => {
        if (controller.signal.aborted) return
        if (!canPrintRef.current()) throw new Error('连接或编辑状态已变化，请等待同步后刷新预览')
        setSnapshot(data)
      })
      .catch(ex => { if (!controller.signal.aborted) setError(ex.message || '打印预览读取失败，请重试') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [docId, attempt])
  useEffect(() => {
    if (!snapshot || !sheet.current) return undefined
    const images = [...sheet.current.querySelectorAll('img')]
    const pending = new Set(images.filter(image => !image.complete))
    let timer
    const finish = () => {
      if (pending.size) return
      clearTimeout(timer)
      setMissingImages(images.filter(image => !image.complete || !image.naturalWidth).length)
      setAssetsReady(true)
    }
    const settled = event => { pending.delete(event.currentTarget); finish() }
    images.forEach(image => {
      image.addEventListener('load', settled)
      image.addEventListener('error', settled)
    })
    timer = setTimeout(() => { pending.clear(); finish() }, 10_000)
    finish()
    return () => {
      clearTimeout(timer)
      images.forEach(image => {
        image.removeEventListener('load', settled)
        image.removeEventListener('error', settled)
      })
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
      await request.get('/doc/' + docId + '/metadata', { signal: controller.signal })
      if (controller.signal.aborted) return
      if (!canPrintRef.current()) throw new Error('连接或编辑状态已变化，请等待同步后重试')
      const oldTitle = document.title
      try { document.title = snapshot.title + ' · CoPage'; window.print() }
      finally { document.title = oldTitle }
    } catch (ex) {
      if (!controller.signal.aborted) setError(ex.message || '无法打开打印，请重试')
    } finally {
      if (!controller.signal.aborted) setPrinting(false)
      if (permissionCheck.current === controller) permissionCheck.current = null
    }
  }
  useEffect(() => {
    const shortcut = event => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey ||
          event.isComposing || event.key.toLowerCase() !== 'p') return
      event.preventDefault()
      void print()
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  })
  const disabled = !ready || loading || printing || !snapshot || !assetsReady || (missingImages > 0 && !acceptMissing)
  return <Modal title="打印 / 另存为 PDF" open width={880} getContainer={portal} onCancel={onClose}
    footer={<Space wrap>
      <Button disabled={loading || printing || !ready} onClick={() => setAttempt(value => value + 1)}>刷新预览</Button>
      <Button onClick={onClose}>关闭</Button>
      <Button type="primary" disabled={disabled} loading={printing} onClick={print}>打开打印窗口</Button>
    </Space>}>
    <div className="document-print-controls">
      <Typography.Paragraph>预览为已保存的固定版本，不随其他人的后续编辑变化。需要最新内容时请刷新预览；打印窗口中可选择“另存为 PDF”。纸张、页边距和页眉页脚由浏览器设置。</Typography.Paragraph>
      <Typography.Paragraph type="secondary">不包含本地未确认草稿、成员权限或历史记录。图片不打包源文件；无法加载时请重试。关闭或取消打印不会修改文档。</Typography.Paragraph>
      {!ready && <Alert type="warning" showIcon message="请先等待连接、同步和保存完成" />}
      {error && <Alert type="error" showIcon message={error} />}
      {(loading || (snapshot && !assetsReady)) && <div role="status"><Spin size="small" /> {loading ? '正在读取已保存版本…' : '正在加载打印图片…'}</div>}
      {missingImages > 0 && <Alert type="warning" showIcon message={missingImages + ' 张图片未能加载'}
        description={<Checkbox checked={acceptMissing} onChange={event => setAcceptMissing(event.target.checked)}>我接受缺图，仅打印当前可见内容</Checkbox>} />}
    </div>
    <article ref={sheet} className="document-print-sheet" aria-label="打印文档预览">
      {snapshot ? <>
        <h1>{snapshot.title}</h1>
        <p className="document-print-meta">CoPage · 已保存版本 {snapshot.revision}</p>
        {missingImages > 0 && <p className="document-print-meta">部分图片未能加载，本副本可能缺图。</p>}
        <DocumentPreview content={snapshot.content} label="打印正文" />
      </> : <p>打印预览尚未就绪，请关闭打印窗口后重试。</p>}
    </article>
  </Modal>
}
