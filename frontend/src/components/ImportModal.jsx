import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Alert, Button, Input, Modal, Typography } from 'antd'
import createDocument from '../api/createDocument'
import request from '../api/request'
import { createDocumentImporter } from '../api/documentImport'

export default function ImportModal({ onClose, onCreated, onReview, scopeKey }) {
  const [file, setFile] = useState(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState({ status: 'idle' })
  const importController = useRef(null)
  const alive = useRef(true)
  const originalScope = useRef(scopeKey)
  const scope = useRef(scopeKey)
  scope.current = scopeKey
  const importer = useRef(null)
  const noticeRef = useRef(null)
  if (!importer.current) {
    importer.current = createDocumentImporter({ create: createDocument,
      readIdentity: () => ({ account: localStorage.getItem('collab-user'), token: localStorage.getItem('collab-token'), service: request.defaults.baseURL }),
      isCurrent: () => alive.current && scope.current === originalScope.current })
  }
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; importController.current?.abort() }
  }, [])
  const uncertain = attempt.status === 'uncertain'
  const confirmed = attempt.status === 'confirmed'
  const frozen = busy || uncertain || confirmed
  useLayoutEffect(() => {
    if (uncertain) {
      const body = noticeRef.current?.closest('.ant-modal-body')
      if (body) body.scrollTop = 0
    }
  }, [uncertain])
  function choose(event) {
    if (frozen) return
    const next = event.target.files?.[0] ?? null
    setError(''); setFile(null)
    if (next && (!/\.(txt|json)$/i.test(next.name) || !next.size || next.size > 3 * 1024 * 1024)) {
      setError('请选择不超过 3 MiB 的非空 .txt 或 CoPage .json 文件'); return
    }
    setFile(next)
    setTitle(next?.name.replace(/(?:\.copage)?\.(?:txt|json)$/i, '').slice(0, 200) ?? '')
  }
  async function importFile() {
    if ((!file && !uncertain) || importController.current || confirmed) return
    const controller = new AbortController()
    importController.current = controller
    setBusy(true); setError('')
    let created = null
    try {
      const result = await importer.current.submit({ file, title }, { signal: controller.signal })
      if (alive.current && !controller.signal.aborted && scope.current === originalScope.current) created = result.data.id
    } catch (ex) {
      if (alive.current && !controller.signal.aborted && scope.current === originalScope.current) setError(importer.current.getSnapshot().status === 'uncertain'
        ? ''
        : ex.message || '导入未成功，请核对文件后重试。')
    } finally {
      if (importController.current === controller) importController.current = null
      if (alive.current && !controller.signal.aborted && scope.current === originalScope.current) { setBusy(false); setAttempt(importer.current.getSnapshot()) }
    }
    if (created && alive.current && !controller.signal.aborted && scope.current === originalScope.current) {
      try { onCreated(created) }
      catch { setError('文档已导入，暂时无法打开。请从我的文档查看，勿重复创建。') }
    }
  }
  function review() {
    if (scope.current !== originalScope.current) return
    try { onReview(attempt.title || '') }
    catch { setError(confirmed ? '文档已导入，暂时无法打开列表。请关闭后从我的文档查看。' : '暂时无法打开列表，原导入结果仍未确认。') }
  }
  return <Modal className="document-transfer-modal document-import-modal" title="导入为新文档" open onCancel={busy ? undefined : onClose} onOk={importFile}
    footer={[
      <Button key="close" disabled={busy} onClick={onClose}>{uncertain ? '稍后核对' : '关闭'}</Button>,
      (uncertain || confirmed) && <Button key="review" disabled={busy} onClick={review}>{confirmed ? '查看我的文档' : '核对我的文档'}</Button>,
      !confirmed && <Button key="import" type="primary" loading={busy} disabled={!file && !uncertain} onClick={importFile}>{uncertain ? '确认原导入' : '导入文档'}</Button>,
    ]}
    cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={!busy} keyboard={!busy}>
    {(uncertain || confirmed) && <div ref={noticeRef} style={{ marginBottom: 16 }}><Alert type={confirmed ? 'success' : 'warning'} showIcon
      message={confirmed ? '原导入已确认成功' : '原导入待确认'}
      description={<><div>原文件：{attempt.filename}</div><div>提交标题：{attempt.title || '留空，由文件决定'}</div>
        {error && uncertain && <p>{error}</p>}
        {uncertain && <p>确认始终使用这份原文件与提交标题。核对列表不会自动确认成功；关闭窗口或刷新后，需重新选择同名、同内容文件并填写相同标题，才能继续原请求。</p>}</>} /></div>}
    <Typography.Paragraph>支持 UTF-8 文本（.txt）和 CoPage 导出的富文本副本（.json）。文件最多 3 MiB，正文最多 2 MiB；格式和换行也占正文容量。导入创建独立文档，不覆盖已有内容或复制协作者权限。</Typography.Paragraph>
    <Typography.Paragraph type="secondary">图片保留原地址，地址可访问时才会显示；副本不包含图片文件、历史版本或本地草稿。</Typography.Paragraph>
    <label>选择文件<input type="file" accept=".txt,.json" disabled={frozen} onChange={choose} /></label>
    <Typography.Paragraph style={{ marginTop: 16 }}>文档标题</Typography.Paragraph>
    <Input aria-label="导入文档标题" maxLength={200} value={title} disabled={frozen} onChange={event => setTitle(event.target.value)} />
    {error && !uncertain && <Alert style={{ marginTop: 12 }} type="error" showIcon message={error} />}
  </Modal>
}
