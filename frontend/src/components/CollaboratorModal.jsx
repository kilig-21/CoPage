import { useEffect, useState } from 'react'
import { Alert, Button, Empty, Form, Input, List, Modal, Popconfirm, Select, Space, Typography } from 'antd'
import request from '../api/request'

const options = [{ value: 1, label: '只读' }, { value: 2, label: '可编辑' }]

export default function CollaboratorModal({ doc, onClose }) {
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [form] = Form.useForm()
  const base = '/doc/' + doc.id + '/collaborators'

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setLoading(true)
    request.get(base, { signal: controller.signal })
      .then((response) => { if (active) setMembers(response.data) })
      .catch((failure) => { if (active) setError(failure?.message || '成员列表加载失败') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false; controller.abort() }
  }, [base, refresh])

  async function mutate(action, onSuccess) {
    setBusy(true)
    setError('')
    try {
      await action()
      onSuccess?.()
      setRefresh((value) => value + 1)
    } catch (failure) {
      setError(failure?.message || '成员管理失败，请重试')
    } finally { setBusy(false) }
  }

  return <Modal title={'协作者管理 · ' + doc.title} open onCancel={() => { if (!busy) onClose() }} footer={<Button disabled={busy} onClick={onClose}>关闭</Button>}>
    <Typography.Paragraph type="secondary">只有文档所有者可以管理成员。输入对方已注册的用户名；添加后把文档链接发给对方即可。</Typography.Paragraph>
    {error && <Alert type="error" showIcon message={error} action={<Button size="small" disabled={busy || loading} onClick={() => { setError(''); setRefresh((value) => value + 1) }}>刷新列表</Button>} />}
    <Form form={form} layout="vertical" initialValues={{ permission: 1 }} onFinish={(values) => mutate(() => request.post(base, { ...values, username: values.username.trim() }), () => form.resetFields(['username']))}>
      <Form.Item label="已注册用户名" name="username" rules={[{ required: true, whitespace: true, message: '请输入用户名' }, { max: 50, message: '用户名最多 50 个字符' }]}><Input maxLength={50} disabled={busy} autoComplete="off" /></Form.Item>
      <Space align="start">
        <Form.Item label="访问权限" name="permission"><Select options={options} disabled={busy} style={{ width: 130 }} /></Form.Item>
        <Form.Item label=" "><Button type="primary" htmlType="submit" loading={busy} disabled={loading}>添加协作者</Button></Form.Item>
      </Space>
    </Form>
    <List loading={loading} dataSource={members} locale={{ emptyText: <Empty description="尚未添加协作者" /> }} renderItem={(member) => <List.Item actions={[
      <Select key="permission" aria-label={member.username + ' 的权限'} value={member.permission} options={options} disabled={busy || loading} style={{ width: 110 }} onChange={(permission) => mutate(() => request.put(base + '/' + member.userId, { permission }))} />,
      <Popconfirm key="remove" title={'移除 ' + member.username + ' 的访问权限？'} disabled={busy || loading} onConfirm={() => mutate(() => request.delete(base + '/' + member.userId))}><Button type="link" danger disabled={busy || loading}>移除</Button></Popconfirm>,
    ]}><List.Item.Meta title={member.nickname || member.username} description={member.username} /></List.Item>} />
  </Modal>
}
