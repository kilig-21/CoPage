import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CheckCircleFilled } from '@ant-design/icons'
import { Alert, Button, Form, Input, List, Modal, Select, Space, Typography } from 'antd'
import ListEmptyState from './ListEmptyState'
import { focusDialogControl, useDialogEscapeFallback } from './dialogFocus'
import { usePageRequest } from '../auth/PageSessionContext'
import { confirmCollaboratorUpdate, parseCollaboratorsReply } from '../api/collaborators'

const options = [{ value: 1, label: '只读' }, { value: 2, label: '可编辑' }]

export default function CollaboratorModal({ doc, onClose, returnToShare = false }) {
  const request = usePageRequest()
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [listReady, setListReady] = useState(false)
  const mutation = useRef(null)
  useEffect(() => () => mutation.current?.abort(), [])
  const [error, setError] = useState('')
  const [addition, setAddition] = useState(null)
  const [removal, setRemoval] = useState(null)
  const [refresh, setRefresh] = useState(0)
  const [form] = Form.useForm()
  const backButton = useRef(null)
  const addButton = useRef(null)
  const additionResult = useRef(null)
  const cancelRemovalButton = useRef(null)
  const base = '/doc/' + doc.id + '/collaborators'

  useDialogEscapeFallback(dismiss, () => !busy && !mutation.current)

  useLayoutEffect(() => {
    if (removal) cancelRemovalButton.current?.focus({ preventScroll: true })
  }, [removal])

  function dismiss() {
    if (busy || mutation.current) return
    if (!removal) {
      onClose()
      return
    }
    const { trigger, body, scrollTop } = removal
    setRemoval(null)
    requestAnimationFrame(() => {
      if (!trigger.isConnected) return
      if (body) body.scrollTop = scrollTop
      trigger.focus({ preventScroll: true })
    })
  }

  useEffect(() => {
    if (!addition) return
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement
      if (active === document.body || active === addButton.current) additionResult.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [addition])

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setLoading(true)
    setListReady(false)
    request.get(base, { signal: controller.signal })
      .then((response) => { if (active) { const verified = parseCollaboratorsReply(response); setMembers(verified); setListReady(true) } })
      .catch((failure) => { if (active) { setMembers([]); setError(failure?.message || '成员列表加载失败') } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false; controller.abort() }
  }, [base, refresh, request])

  async function mutate(action, onSuccess) {
    if (mutation.current || !listReady) return
    const controller = new AbortController()
    mutation.current = controller
    setBusy(true)
    setError('')
    setAddition(null)
    try {
      const reply = await action(controller.signal)
      if (controller.signal.aborted) return
      confirmCollaboratorUpdate(reply)
      setListReady(false)
      onSuccess?.()
      setRefresh((value) => value + 1)
    } catch (failure) {
      if (!controller.signal.aborted) {
        const rejected = [400, 401, 403, 404].includes(failure?.code)
        if (!rejected) setListReady(false)
        setError(rejected ? failure.message : '成员更新结果未确认，请刷新列表核对当前权限，再决定是否重试')
      }
    } finally {
      if (mutation.current === controller) mutation.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  function addCollaborator(values) {
    const grant = { username: values.username.trim(), permission: values.permission }
    mutate(signal => request.post(base, grant, { signal }), () => {
      form.resetFields(['username'])
      setAddition(grant)
    })
  }

  async function confirmRemoval() {
    if (!removal || busy || !listReady || mutation.current) return
    const { userId } = removal.member
    await mutate(signal => request.delete(base + '/' + userId, { signal }))
    setRemoval(null)
  }

  return <Modal className={removal ? 'document-collaborators-modal collaborator-removal-modal' : 'document-collaborators-modal'}
    title={removal ? '移除文档访问权限？' : '协作者管理 · ' + doc.title} open
    transitionName={returnToShare ? '' : undefined} maskTransitionName={returnToShare ? '' : undefined}
    afterOpenChange={open => { if (open && returnToShare && !removal) focusDialogControl(backButton.current) }}
    onCancel={dismiss} closable={!busy} maskClosable={!busy} keyboard={!busy}
    footer={removal ? [
      <Button key="cancel" ref={cancelRemovalButton} disabled={busy} onClick={dismiss}>取消</Button>,
      <Button key="remove" type="primary" danger loading={busy} disabled={!listReady} onClick={confirmRemoval}>移除权限</Button>,
    ] : <Button ref={backButton} disabled={busy} onClick={dismiss}>{returnToShare ? '返回分享' : '关闭'}</Button>}>
    {removal && <div className="collaborator-removal">
      <Typography.Text strong>{removal.member.username}</Typography.Text>
      <Typography.Text type="secondary">
        {removal.member.nickname && removal.member.nickname !== removal.member.username ? removal.member.nickname + ' · ' : ''}
        当前权限 {options.find(option => option.value === removal.member.permission)?.label}
      </Typography.Text>
      <Typography.Paragraph>确认后，该账号将无法访问这篇文档。</Typography.Paragraph>
    </div>}
    <div hidden={Boolean(removal)}>
      <Typography.Paragraph className="collaborator-intro" type="secondary">用对方的注册用户名添加协作者，再把文档链接发给对方。</Typography.Paragraph>
      <Form form={form} layout="vertical" initialValues={{ permission: 1 }} onFinish={addCollaborator}>
        <Form.Item label="已注册用户名" name="username" rules={[{ required: true, whitespace: true, message: '请输入用户名' }, { max: 50, message: '用户名最多 50 个字符' }]}>
          <Input maxLength={50} disabled={busy} autoComplete="off" />
        </Form.Item>
        <Space align="start" wrap>
          <Form.Item label="访问权限" name="permission"><Select options={options} disabled={busy} style={{ width: 130 }} /></Form.Item>
          <Form.Item label=" "><Button ref={addButton} type="primary" htmlType="submit" loading={busy} disabled={!listReady}>添加协作者</Button></Form.Item>
        </Space>
      </Form>
      {addition && <div ref={additionResult} className="collaborator-add-result" tabIndex={-1} role="status">
        <CheckCircleFilled aria-hidden="true" />
        <div><Typography.Text strong>已添加协作者</Typography.Text>
          <Typography.Text type="secondary">「{addition.username}」 · 本次授予{options.find(option => option.value === addition.permission)?.label}</Typography.Text>
        </div>
      </div>}
      {error && <Alert type="error" showIcon message={error} action={<Button size="small" disabled={busy || loading} onClick={() => { setError(''); setRefresh((value) => value + 1) }}>刷新列表</Button>} />}
      {loading && <Typography.Paragraph className="collaborator-list-status" role="status">正在读取协作者名单…</Typography.Paragraph>}
      {(listReady || members.length > 0) && <List rowKey="userId" loading={loading} dataSource={members}
        locale={{ emptyText: <ListEmptyState description="尚未添加协作者" /> }} renderItem={(member) => <List.Item actions={[
          <Select key="permission" aria-label={member.username + ' 的权限'} value={member.permission} options={options}
            disabled={busy || !listReady} style={{ width: 110 }} onChange={permission => mutate(signal => request.put(base + '/' + member.userId, { permission }, { signal }))} />,
          <Button key="remove" type="link" danger disabled={busy || !listReady} aria-label={'移除「' + member.username + '」的访问权限'}
            onClick={event => {
              const trigger = event.currentTarget
              const body = trigger.closest('.ant-modal-body')
              setRemoval({ member, trigger, body, scrollTop: body?.scrollTop || 0 })
            }}>移除</Button>,
        ]}><List.Item.Meta title={member.nickname || member.username} description={member.username} /></List.Item>} />}
    </div>
  </Modal>
}
