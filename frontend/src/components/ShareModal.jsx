import { useState } from 'react'
import { Alert, Button, Input, Modal, Space, Typography } from 'antd'

export default function ShareModal({ docId, isOwner, onManage, onClose }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const link = new URL('/docs/' + docId, window.location.origin).href
  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); setFailed(false) }
    catch { setCopied(false); setFailed(true) }
  }
  return <Modal open title="分享文档链接" onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
    <Typography.Paragraph>接收者需要登录，并已拥有这篇文档的访问权限。分享链接不会自动开放文档。</Typography.Paragraph>
    <Input aria-label="文档分享链接" readOnly value={link} onFocus={event => event.target.select()} />
    <Space wrap style={{ marginTop: 16 }}>
      <Button type="primary" onClick={copy}>{copied ? '已复制链接' : '复制链接'}</Button>
      {isOwner && <Button onClick={onManage}>设置协作者权限</Button>}
    </Space>
    {failed && <Alert type="info" showIcon message="浏览器未允许自动复制，请选中上方链接后手动复制。" />}
  </Modal>
}
