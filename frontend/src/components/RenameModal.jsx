import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Input, Modal } from 'antd'
import request from '../api/request'

export default function RenameModal({ doc, onClose, onSaved }) {
  const [title, setTitle] = useState(doc.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [unconfirmed, setUnconfirmed] = useState(false)
  const [notice, setNotice] = useState('')
  const mutation = useRef(null)
  useEffect(() => () => mutation.current?.abort(), [])

  async function save() {
    if (mutation.current || unconfirmed) return
    if (!title.trim()) { setError('请输入文档标题'); return }
    const controller = new AbortController()
    mutation.current = controller
    setBusy(true); setError(''); setNotice('')
    try {
      await request.put('/doc/' + doc.id, { title: title.trim() }, { signal: controller.signal })
      if (controller.signal.aborted) return
      onSaved()
      onClose()
    } catch (failure) {
      if (!controller.signal.aborted) {
        const rejected = [400, 401, 403, 404].includes(failure?.code)
        setUnconfirmed(!rejected)
        setError(rejected ? failure.message : '标题更新结果未确认，请核对服务器当前标题，再决定是否保存。')
      }
    } finally {
      if (mutation.current === controller) mutation.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  async function checkTitle() {
    if (mutation.current) return
    const controller = new AbortController()
    mutation.current = controller
    setBusy(true); setNotice('')
    try {
      const { data } = await request.get('/doc/' + doc.id + '/metadata', { signal: controller.signal })
      if (controller.signal.aborted) return
      setUnconfirmed(false); setError('')
      setNotice('服务器当前标题：“' + data.title + '”。你的输入仍保留；核对后可关闭，或明确保存输入的标题。')
    } catch (failure) {
      if (!controller.signal.aborted) setError([400, 401, 403, 404].includes(failure?.code)
        ? failure.message : '当前标题未能核对，请检查网络后再试；输入仍保留。')
    } finally {
      if (mutation.current === controller) mutation.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return <Modal open title="重命名文档" onOk={save} onCancel={onClose} confirmLoading={busy}
    okButtonProps={{ disabled: unconfirmed }} closable={!busy} maskClosable={!busy} keyboard={!busy}
    cancelButtonProps={{ disabled: busy }}>
    {error && <Alert type="error" showIcon message={error}
      action={unconfirmed && <Button disabled={busy} onClick={checkTitle}>核对当前标题</Button>} />}
    {notice && <Alert type="info" showIcon message={notice} />}
    <Input autoFocus aria-label="文档标题" maxLength={200} value={title} disabled={busy}
      onChange={event => { setTitle(event.target.value); setNotice('') }}
      onPressEnter={event => { if (!event.nativeEvent.isComposing) save() }} />
  </Modal>
}
