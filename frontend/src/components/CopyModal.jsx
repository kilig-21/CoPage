import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Input, Modal, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'
import createDocument from '../api/createDocument'

export default function CopyModal({ doc, onClose, onCreated, canCopy = () => true }) {
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const [ready, setReady] = useState(() => canCopy())
  const alive = useRef(true)
  const inFlight = useRef(null)
  const canCopyRef = useRef(canCopy)
  canCopyRef.current = canCopy
  useEffect(() => {
    alive.current = true
    const timer = setInterval(() => setReady(canCopyRef.current()), 200)
    return () => { alive.current = false; clearInterval(timer); inFlight.current?.abort() }
  }, [])
  async function createCopy() {
    if (inFlight.current) return
    if (!canCopyRef.current()) { setError('请先等待连接、同步和保存完成'); return }
    const controller = new AbortController()
    inFlight.current = controller; setBusy(true); setError('')
    try {
      const { data } = await createDocument('/doc/' + doc.id + '/copy', title.trim() ? { title: title.trim() } : {}, { signal: controller.signal })
      if (alive.current && !controller.signal.aborted) onCreated(data)
    } catch (ex) {
      if (alive.current && !controller.signal.aborted) {
        const rejected = [400, 401, 403, 404].includes(ex?.code)
        setUncertain(!rejected)
        setError(rejected ? ex.message : '副本创建结果未确认，可安全重试本次创建，或先核对我的文档。')
      }
    } finally {
      if (inFlight.current === controller) inFlight.current = null
      if (alive.current) setBusy(false)
    }
  }
  return <Modal className="document-copy-modal" title="创建独立副本" open onCancel={busy ? undefined : onClose} onOk={createCopy}
    okText={uncertain ? '重试本次创建' : '创建副本'} cancelText="取消" confirmLoading={busy} okButtonProps={{ disabled: !ready }}
    closable={!busy} maskClosable={!busy} keyboard={!busy} cancelButtonProps={{ disabled: busy }}>
    <Typography.Paragraph>来源：{doc.title}</Typography.Paragraph>
    <Typography.Paragraph>复制操作时服务端已保存的完整版本，保留正文、格式和图片地址。新文档归你所有，不复制协作者权限、历史或本地未确认草稿，也不会修改原文档。</Typography.Paragraph>
    <Typography.Paragraph type="secondary">图片继续使用原地址，不复制图片文件。结果未确认时，相同标题的本次创建可安全重试。</Typography.Paragraph>
    <Input aria-label="副本文档标题" maxLength={200} disabled={busy || uncertain} value={title}
      placeholder="可选：留空使用原标题加“的副本”" onChange={event => setTitle(event.target.value)} />
    {!ready && <Alert style={{ marginTop: 12 }} type="warning" showIcon message="请先等待连接、同步和保存完成" />}
    {error && <Alert style={{ marginTop: 12 }} type={uncertain ? 'warning' : 'error'} showIcon message={error}
      action={uncertain && <Button disabled={busy} onClick={() => {
        onClose(); navigate('/docs?' + new URLSearchParams({ scope: 'owned', ...(title.trim() ? { keyword: title.trim() } : {}) }).toString())
      }}>核对我的文档</Button>} />}
  </Modal>
}
