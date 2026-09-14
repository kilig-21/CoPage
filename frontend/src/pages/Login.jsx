import { Button, Card, Form, Input, Typography } from 'antd'
import { Link, useNavigate } from 'react-router-dom'

/** A 负责：将 mock 登录替换为 POST /api/auth/login。 */
export default function Login() {
  const navigate = useNavigate()

  function onFinish(values) {
    localStorage.setItem('collab-user', values.username)
    navigate('/docs')
  }

  return (
    <main className="auth-page">
      <Card className="auth-card" bordered={false}>
        <Typography.Title level={2}>协同文档</Typography.Title>
        <Typography.Paragraph type="secondary">多人实时协作，从一篇文档开始。</Typography.Paragraph>
        <Form layout="vertical" onFinish={onFinish} initialValues={{ username: 'testA', password: '123456' }}>
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>使用演示账号进入</Button>
        </Form>
        <Typography.Paragraph className="auth-tip" type="secondary">演示账号：testA / testB，密码均为 123456</Typography.Paragraph>
        <Link to="/docs">暂时跳过登录</Link>
      </Card>
    </main>
  )
}
