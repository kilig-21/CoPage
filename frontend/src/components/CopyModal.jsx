import { useEffect, useRef, useState } from 'react'
import { Alert, Input, Modal, Typography } from 'antd'
import request from '../api/request'

export default function CopyModal({ doc, onClose, onCreated, canCopy = () => true }) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(() => canCopy())
  const alive = useRef(true)
  const inFlight = useRef(false)
  const canCopyRef = useRef(canCopy)
  canCopyRef.current = canCopy
  useEffect(() => {
    alive.current = true
    const timer = setInterval(() => setReady(canCopyRef.current()), 200)
    return () => { alive.current = false; clearInterval(timer) }
  }, [])
  async function createCopy() {
    if (inFlight.current) return
    if (!canCopyRef.current()) { setError('请先等待连接、同步和保存完成'); return }
    inFlight.current = true; setBusy(true); setError('')
    try {
      const { data } = await request.post('/doc/' + doc.id + '/copy', title.trim() ? { title: title.trim() } : {})
      if (alive.current) onCreated(data)
    } catch (ex) {
      if (alive.current) setError(ex.message || '创建副本失败，请检查后重试')
    } finally {
      inFlight.current = false
      if (alive.current) setBusy(false)
    }
  }
  return <Modal title="创建独立副本" open onCancel={busy ? undefined : onClose} onOk={createCopy}
    okText="创建副本" cancelText="取消" confirmLoading={busy} okButtonProps={{ disabled: !ready }}
    closable={!busy} maskClosable={!busy} keyboard={!busy} cancelButtonProps={{ disabled: busy }}>
    <Typography.Paragraph>来源：{doc.title}</Typography.Paragraph>
    <Typography.Paragraph>复制操作时服务端已保存的完整版本，保留正文、格式和图片地址。新文档归你所有，不复制协作者权限、历史或本地未确认草稿，也不会修改原文档。</Typography.Paragraph>
    <Typography.Paragraph type="secondary">图片继续使用原地址，不复制图片文件。请求超时时请先返回列表确认是否已经创建，再决定是否重试。</Typography.Paragraph>
    <Input aria-label="副本文档标题" maxLength={200} disabled={busy} value={title}
      placeholder="可选：留空使用原标题加“的副本”" onChange={event => setTitle(event.target.value)} />
    {!ready && <Alert style={{ marginTop: 12 }} type="warning" showIcon message="请先等待连接、同步和保存完成" />}
    {error && <Alert style={{ marginTop: 12 }} type="error" showIcon message={error} />}
  </Modal>
}
