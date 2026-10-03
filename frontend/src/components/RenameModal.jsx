import { useRef, useState } from 'react'
import { Alert, Input, Modal } from 'antd'
import request from '../api/request'

export default function RenameModal({ doc, onClose, onSaved }) {
  const [title, setTitle] = useState(doc.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  async function save() {
    if (submitting.current) return
    if (!title.trim()) { setError('请输入文档标题'); return }
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      await request.put('/doc/' + doc.id, { title: title.trim() })
      onSaved()
      onClose()
    } catch (failure) { setError(failure?.message || '标题保存失败，请重试') }
    finally { submitting.current = false; setBusy(false) }
  }
  return <Modal open title="重命名文档" onOk={save} onCancel={onClose} confirmLoading={busy}
    closable={!busy} maskClosable={!busy} keyboard={!busy} cancelButtonProps={{ disabled: busy }}>
    {error && <Alert type="error" showIcon message={error} />}
    <Input autoFocus aria-label="文档标题" maxLength={200} value={title} disabled={busy}
      onChange={event => setTitle(event.target.value)}
      onPressEnter={event => { if (!event.nativeEvent.isComposing) save() }} />
  </Modal>
}
