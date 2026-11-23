import { useRef, useState } from 'react'
import { Alert, Button, Input, Modal, Space, Typography } from 'antd'
import { focusDialogControl, useDialogEscapeFallback } from './dialogFocus'

export default function ShareModal({ docId, isOwner, onManage, onClose, managementError = '' }) {
  const [copyState, setCopyState] = useState('idle')
  const linkInput = useRef(null)
  const copyButton = useRef(null)
  const link = new URL('/docs/' + docId, window.location.origin).href
  useDialogEscapeFallback(onClose)

  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
      linkInput.current?.focus({ cursor: 'all' })
    }
  }
  return <Modal className="document-share-modal" open title="分享文档链接" transitionName="" maskTransitionName=""
    afterOpenChange={open => { if (open) focusDialogControl(copyButton.current) }}
    onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
    <Typography.Paragraph>接收者需登录，并获得这篇文档的查看或编辑权限。</Typography.Paragraph>
    <Input ref={linkInput} aria-label="文档分享链接" readOnly value={link} onFocus={event => event.target.select()} />
    <Space wrap style={{ marginTop: 16 }}>
      <Button ref={copyButton} type="primary" onClick={copy}>复制链接</Button>
      {isOwner && <Button onClick={onManage}>设置协作者权限</Button>}
    </Space>
    <div role="status">{copyState === 'copied' && <Alert role="presentation" type="success" showIcon message="已复制链接" />}</div>
    {copyState === 'failed' && <Alert type="info" showIcon message="无法自动复制。链接已选中，可手动复制。" />}
    {managementError && <Alert type="warning" showIcon message={managementError} />}
  </Modal>
}
