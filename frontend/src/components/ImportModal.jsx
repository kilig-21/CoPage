import { useState } from 'react'
import { Alert, Input, Modal, Typography } from 'antd'
import request from '../api/request'

export default function ImportModal({ onClose, onCreated }) {
  const [file, setFile] = useState(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  function choose(event) {
    const next = event.target.files?.[0] ?? null
    setError(''); setFile(null)
    if (next && (!/\.(txt|json)$/i.test(next.name) || !next.size || next.size > 1024 * 1024)) {
      setError('请选择不超过 1 MiB 的非空 .txt 或 CoPage .json 文件'); return
    }
    setFile(next)
    setTitle(next?.name.replace(/(?:\.copage)?\.(?:txt|json)$/i, '').slice(0, 200) ?? '')
  }
  async function importFile() {
    if (!file || busy) return
    setBusy(true); setError('')
    const form = new FormData(); form.append('file', file)
    if (title.trim()) form.append('title', title.trim())
    try { const result = await request.post('/doc/import', form); onCreated(result.data.id) }
    catch (ex) { setError(ex.message || '导入失败，请检查文件后重试') }
    finally { setBusy(false) }
  }
  return <Modal title="导入为新文档" open onCancel={busy ? undefined : onClose} onOk={importFile}
    okText="导入文档" cancelText="取消" confirmLoading={busy} okButtonProps={{ disabled: !file }}
    cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={!busy} keyboard={!busy}>
    <Typography.Paragraph>支持 UTF-8 文本（.txt）和 CoPage 导出的富文本副本（.json），最多 1 MiB。导入创建独立文档，不覆盖已有内容或复制协作者权限。</Typography.Paragraph>
    <Typography.Paragraph type="secondary">图片保留原地址，地址可访问时才会显示；副本不包含图片文件、历史版本或本地草稿。</Typography.Paragraph>
    <label>选择文件<input type="file" accept=".txt,.json" disabled={busy} onChange={choose} /></label>
    <Typography.Paragraph style={{ marginTop: 16 }}>文档标题</Typography.Paragraph>
    <Input aria-label="导入文档标题" maxLength={200} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} />
    {error && <Alert style={{ marginTop: 12 }} type="error" showIcon message={error} />}
  </Modal>
}
