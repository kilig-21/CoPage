import { useState } from 'react'
import { Button, Card, Form, Input, Typography, message } from 'antd'
import { useNavigate } from 'react-router-dom'
import request from '../api/request'

export default function Login() {
  const navigate = useNavigate()
  const [form] = Form.useForm()
  const [registering, setRegistering] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function onFinish(values) {
    setSubmitting(true)
    try {
      if (registering) {
        await request.post('/auth/register', values)
        message.success('注册成功，请登录')
        setRegistering(false)
        form.setFieldsValue({ password: '' })
        return
      }
      const response = await request.post('/auth/login', values)
      localStorage.setItem('collab-token', response.data.token)
      localStorage.setItem('collab-user', response.data.user.username)
      navigate('/docs', { replace: true })
    } catch (error) {
      message.error(error?.message || '请求失败，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="auth-page">
      <Card className="auth-card" bordered={false}>
        <Typography.Title level={2}>协同文档</Typography.Title>
        <Typography.Paragraph type="secondary">多人实时协作，从一篇文档开始。</Typography.Paragraph>
        <Form form={form} layout="vertical" onFinish={onFinish} initialValues={{ username: 'testA', password: '123456' }}>
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input autoComplete="username" />
          </Form.Item>
          {registering && (
            <Form.Item label="昵称" name="nickname" rules={[{ max: 50, message: '昵称最多 50 字' }]}>
              <Input autoComplete="nickname" />
            </Form.Item>
          )}
          <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password autoComplete={registering ? 'new-password' : 'current-password'} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={submitting} block>
            {registering ? '注册账号' : '登录'}
          </Button>
        </Form>
        <Typography.Paragraph className="auth-tip" type="secondary">演示账号：testA / testB，密码均为 123456</Typography.Paragraph>
        <Button type="link" onClick={() => setRegistering((value) => !value)}>
          {registering ? '已有账号？返回登录' : '没有账号？注册'}
        </Button>
      </Card>
    </main>
  )
}
