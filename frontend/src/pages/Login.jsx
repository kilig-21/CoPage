import { useState } from 'react'
import { Alert, Button, Card, Form, Input, Typography } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'
import request from '../api/request'
import { safeReturnPath } from '../auth/session'

export default function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const [form] = Form.useForm()
  const [registering, setRegistering] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function onFinish(values) {
    setSubmitting(true)
    setError(''); setNotice('')
    const payload = { username: values.username.trim(), password: values.password,
      ...(registering ? { nickname: values.nickname?.trim() } : {}) }
    try {
      if (registering) {
        await request.post('/auth/register', payload)
        setNotice('注册成功，请用新账号登录')
        setRegistering(false)
        form.setFieldsValue({ password: '', confirmPassword: '' })
        return
      }
      const response = await request.post('/auth/login', payload)
      localStorage.setItem('collab-token', response.data.token)
      localStorage.setItem('collab-user', response.data.user.username)
      navigate(safeReturnPath(location.state?.from), { replace: true })
    } catch (error) {
      setError(error?.message || '请求失败，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="auth-page">
      <Card className="auth-card" bordered={false}>
        <Typography.Title level={2}>协同文档</Typography.Title>
        <Typography.Paragraph type="secondary">多人实时协作，从一篇文档开始。</Typography.Paragraph>
        {location.state?.expired && <Alert type="warning" showIcon message="登录已失效，请重新登录；未确认的本地草稿仍保留在此浏览器中" />}
        {error && <Alert type="error" showIcon message={error} />}
        {notice && <Alert type="success" showIcon message={notice} />}
        <Form form={form} layout="vertical" onFinish={onFinish} disabled={submitting}>
          <Form.Item label="用户名" name="username" normalize={value => value.trim()} rules={[
            { required: true, message: '请输入用户名' }, { min: 3, max: 50, message: '用户名需要 3～50 个字符' }]}>
            <Input autoComplete="username" maxLength={50} />
          </Form.Item>
          {registering && (
            <Form.Item label="昵称" name="nickname" rules={[{ max: 50, message: '昵称最多 50 字' }]}>
              <Input autoComplete="nickname" />
            </Form.Item>
          )}
          <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' },
            ...(registering ? [{ min: 6, max: 64, message: '密码需要 6～64 个字符' }, { validator: (_, value) =>
              !value || new TextEncoder().encode(value).length <= 72 ? Promise.resolve() : Promise.reject(new Error('密码的 UTF-8 长度不能超过 72 字节')) }] : [])]}>
            <Input.Password autoComplete={registering ? 'new-password' : 'current-password'} />
          </Form.Item>
          {registering && <Form.Item label="确认密码" name="confirmPassword" dependencies={['password']} rules={[
            { required: true, message: '请再次输入密码' }, ({ getFieldValue }) => ({ validator: (_, value) =>
              !value || value === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error('两次密码不一致')) }),
          ]}><Input.Password autoComplete="new-password" /></Form.Item>}
          <Button type="primary" htmlType="submit" loading={submitting} block>
            {registering ? '注册账号' : '登录'}
          </Button>
        </Form>
        {import.meta.env.DEV && !registering && <Typography.Paragraph className="auth-tip" type="secondary">
          本地演示账号：testA / testB，密码均为 123456。<Button type="link" disabled={submitting}
            onClick={() => form.setFieldsValue({ username: 'testA', password: '123456' })}>填入演示账号</Button>
        </Typography.Paragraph>}
        <Button type="link" disabled={submitting} onClick={() => {
          const username = form.getFieldValue('username'); form.resetFields(); form.setFieldsValue({ username });
          setError(''); setNotice(''); setRegistering(value => !value)
        }}>
          {registering ? '已有账号？返回登录' : '没有账号？注册'}
        </Button>
      </Card>
    </main>
  )
}
