import { useLayoutEffect, useRef, useState } from 'react'
import { Alert, Button, Modal, Typography } from 'antd'
import DraftBackupDownloads from './DraftBackupDownloads'
import { useDialogEscapeFallback } from './dialogFocus'

export default function DraftRecoveryModal({ draft, editable, onRecover, onLater, onDiscard }) {
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const discardButton = useRef(null)
  const keepButton = useRef(null)
  const returnFocus = useRef(false)

  function keepDraft() {
    returnFocus.current = true
    setError('')
    setConfirming(false)
  }

  function confirmDiscard() {
    try { onDiscard() }
    catch (failure) { setError(failure.message) }
  }

  useDialogEscapeFallback(keepDraft, () => confirming, discardButton)
  useLayoutEffect(() => {
    if (confirming) keepButton.current?.focus({ preventScroll: true })
    else if (returnFocus.current) {
      discardButton.current?.focus({ preventScroll: true })
      returnFocus.current = false
    }
  }, [confirming])

  return <Modal className="editor-draft-recovery-modal" open closable={false} maskClosable={false}
    title={confirming ? '丢弃这份本地草稿？' : '发现未确认的本地编辑'}
    keyboard={confirming} onCancel={confirming ? keepDraft : undefined}
    footer={confirming ? [
      <Button key="keep" ref={keepButton} onClick={keepDraft}>保留草稿</Button>,
      <Button key="confirm-discard" type="primary" danger onClick={confirmDiscard}>确认丢弃</Button>,
    ] : [
      <Button key="discard" ref={discardButton} danger onClick={() => setConfirming(true)}>丢弃本地草稿</Button>,
      <Button key="later" onClick={onLater}>稍后处理</Button>,
      <Button key="recover" type="primary" disabled={!editable} onClick={onRecover}>恢复草稿并同步</Button>,
    ]}>
    {confirming && <>
      <Typography.Paragraph>这份草稿可能包含尚未同步的修改。丢弃后无法从此浏览器恢复。</Typography.Paragraph>
      <Typography.Paragraph type="secondary">需要副本时，可先保留草稿并返回下载。</Typography.Paragraph>
      {error && <Alert type="error" showIcon message={error} />}
    </>}
    <div hidden={confirming}>
      <Typography.Paragraph>这份草稿可能包含服务端尚未确认的修改。恢复前不会自动重发，也不会覆盖本地草稿。</Typography.Paragraph>
      {!editable && <Typography.Paragraph>当前没有编辑权限，暂时不能同步这份草稿。可以先下载副本或稍后处理，草稿会继续保留。</Typography.Paragraph>}
      <DraftBackupDownloads backup={draft} />
    </div>
  </Modal>
}
