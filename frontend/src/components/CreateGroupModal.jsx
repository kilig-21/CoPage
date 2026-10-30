import { useEffect, useRef, useState } from 'react'
import { Alert, Input, Modal, Typography } from 'antd'
import { createGroup, confirmGroupCreation } from '../api/createGroup'
import { groupCreationIdentity, sameGroupCreationIdentity } from '../api/usePendingGroupCreations'

export default function CreateGroupModal({ onClose, onCreated, onBusyChange, expectedIdentity, assertSession }) {
  const [name, setName] = useState(''), [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [pending, setPending] = useState(null), [confirmed, setConfirmed] = useState(null)
  const prepared = useRef(null), attempt = useRef(null), alive = useRef(false)
  const identity = useRef(expectedIdentity || groupCreationIdentity())
  const [blocked, setBlocked] = useState(false)
  function checkSession(signal) {
    assertSession?.(signal)
    if (!sameGroupCreationIdentity(identity.current)) throw new Error('登录状态已更改，请重新登录原账号后核对小组；当前输入和原创建记录仍保留。')
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; const old = attempt.current; attempt.current = null; old?.abort(); if (old) onBusyChange(false) } }, [onBusyChange])
  async function save() {
    if (attempt.current || blocked) return
    try { checkSession() } catch (failure) { setBlocked(true); setError(failure.message); return }
    if (confirmed) {
      try { onCreated(confirmed) } catch { setError('小组已确认，请从我的小组查看原小组。') }
      return
    }
    const controller = new AbortController()
    attempt.current = controller; setBusy(true); onBusyChange(true); setError('')
    const current = () => alive.current && attempt.current === controller && !controller.signal.aborted
    let accepted = false
    try {
      const config = { signal: controller.signal, expectedIdentity: identity.current, deferCleanup: true, onPrepared: record => {
        if (!current()) throw new DOMException('小组创建页面或账号已变更', 'AbortError')
        checkSession(controller.signal)
        prepared.current = record; setPending(record)
      } }
      let response = prepared.current ? await confirmGroupCreation(prepared.current, config)
        : await createGroup({ name: name.trim(), description: description.trim() }, config)
      if (!current()) return
      checkSession(controller.signal)
      response = response.confirmTracking(); accepted = true
      prepared.current = null; setPending(null); setConfirmed(response.data)
      onCreated(response.data)
    } catch (failure) {
      if (current()) {
        try { checkSession(controller.signal) }
        catch (changed) { setBlocked(true); setError(changed.message); return }
        setError(accepted ? '小组已确认，请从我的小组查看原小组。'
          : prepared.current ? '创建结果未确认，原名称和简介已保留。请确认原小组，或稍后从待确认记录继续。'
            : failure?.message || '小组创建尚未发送，请稍后重试。')
      }
    } finally {
      if (attempt.current === controller) {
        attempt.current = null
        if (alive.current) { setBusy(false); onBusyChange(false) }
      }
    }
  }
  return <Modal className="group-create-modal group-fields-modal" open title="创建小组" onCancel={busy ? undefined : onClose}
    closable={!busy} maskClosable={!busy} keyboard={!busy} confirmLoading={busy} onOk={save}
    okText={confirmed ? '查看已确认小组' : pending ? '确认原小组' : '创建小组'} cancelText={pending ? '稍后确认' : '关闭'}
    okButtonProps={{ disabled: blocked || (!confirmed && !pending && !name.trim()) }} cancelButtonProps={{ disabled: busy }}>
    <Typography.Paragraph>小组负责组织成员与资料分类，文档仍需所有者逐篇授权。</Typography.Paragraph>
    <Typography.Paragraph type="secondary">结果未确认时保留原名称、简介和创建标识；关闭窗口、刷新或重登原账号后，可从“待确认的小组”继续。记录只在当前浏览器保留，不保存正文或登录凭据。</Typography.Paragraph>
    {error && <Alert type="warning" showIcon message={error} />}
    <Typography.Paragraph>小组名称</Typography.Paragraph>
    <Input aria-label="小组名称" value={name} maxLength={80} autoFocus disabled={busy || Boolean(pending) || Boolean(confirmed)} onChange={event => setName(event.target.value)} />
    <Typography.Paragraph style={{ marginTop: 12 }}>小组简介</Typography.Paragraph>
    <Input.TextArea aria-label="小组简介" value={description} maxLength={300} rows={3} showCount disabled={busy || Boolean(pending) || Boolean(confirmed)} onChange={event => setDescription(event.target.value)} />
  </Modal>
}
