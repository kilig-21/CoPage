import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Empty, Form, Input, List, Modal, Popconfirm, Select, Space, Typography } from 'antd'
import request from '../api/request'

const options = [{ value: 1, label: '只读' }, { value: 2, label: '可编辑' }]

export default function CollaboratorModal({ doc, onClose }) {
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [listReady, setListReady] = useState(false)
  const mutation = useRef(null)
  useEffect(() => () => mutation.current?.abort(), [])
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [form] = Form.useForm()
  const base = '/doc/' + doc.id + '/collaborators'

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setLoading(true)
    setListReady(false)
    request.get(base, { signal: controller.signal })
      .then((response) => { if (active) { setMembers(response.data); setListReady(true) } })
      .catch((failure) => { if (active) { setMembers([]); setError(failure?.message || '成员列表加载失败') } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false; controller.abort() }
  }, [base, refresh])

  async function mutate(action, onSuccess) {
    if (mutation.current || !listReady) return
    const controller = new AbortController()
    mutation.current = controller
    setBusy(true)
    setError('')
    try {
      await action(controller.signal)
      if (controller.signal.aborted) return
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

  return <Modal title={'协作者管理 · ' + doc.title} open onCancel={() => { if (!busy) onClose() }} closable={!busy} maskClosable={!busy} keyboard={!busy} footer={<Button disabled={busy} onClick={onClose}>关闭</Button>}>
    <Typography.Paragraph type="secondary">只有文档所有者可以管理成员。输入对方已注册的用户名；添加后把文档链接发给对方即可。</Typography.Paragraph>
    {error && <Alert type="error" showIcon message={error} action={<Button size="small" disabled={busy || loading} onClick={() => { setError(''); setRefresh((value) => value + 1) }}>刷新列表</Button>} />}
    <Form form={form} layout="vertical" initialValues={{ permission: 1 }} onFinish={(values) => mutate(signal => request.post(base, { ...values, username: values.username.trim() }, { signal }), () => form.resetFields(['username']))}>
      <Form.Item label="已注册用户名" name="username" rules={[{ required: true, whitespace: true, message: '请输入用户名' }, { max: 50, message: '用户名最多 50 个字符' }]}><Input maxLength={50} disabled={busy} autoComplete="off" /></Form.Item>
      <Space align="start">
        <Form.Item label="访问权限" name="permission"><Select options={options} disabled={busy} style={{ width: 130 }} /></Form.Item>
        <Form.Item label=" "><Button type="primary" htmlType="submit" loading={busy} disabled={!listReady}>添加协作者</Button></Form.Item>
      </Space>
    </Form>
    <List rowKey="userId" loading={loading} dataSource={members} locale={{ emptyText: listReady ? <Empty description="尚未添加协作者" /> : loading ? '正在加载…' : '成员列表暂不可用' }} renderItem={(member) => <List.Item actions={[
      <Select key="permission" aria-label={member.username + ' 的权限'} value={member.permission} options={options} disabled={busy || !listReady} style={{ width: 110 }} onChange={(permission) => mutate(signal => request.put(base + '/' + member.userId, { permission }, { signal }))} />,
      <Popconfirm key="remove" title={'移除 ' + member.username + ' 的访问权限？'} disabled={busy || !listReady} onConfirm={() => mutate(signal => request.delete(base + '/' + member.userId, { signal }))}><Button type="link" danger disabled={busy || !listReady}>移除</Button></Popconfirm>,
    ]}><List.Item.Meta title={member.nickname || member.username} description={member.username} /></List.Item>} />
  </Modal>
}
