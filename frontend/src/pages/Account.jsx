import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Form, Input, Layout, Space, Spin, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'
import request from '../api/request'
import LogoutButton from '../components/LogoutButton'
import { expireSession } from '../auth/session'

export default function Account() {
  const navigate = useNavigate()
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [nicknameForm] = Form.useForm()
  const [passwordForm] = Form.useForm()
  const alive = useRef(true)
  const mutation = useRef(null)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; mutation.current?.abort() }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setLoadError('')
    request.get('/account/me', { signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return
        setProfile(data); nicknameForm.setFieldsValue({ nickname: data.nickname || data.username })
      })
      .catch(failure => { if (!controller.signal.aborted) setLoadError(failure.message || '账号信息加载失败') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh, nicknameForm])
  async function saveNickname(values) {
    if (mutation.current) return
    const controller = new AbortController(); mutation.current = controller
    setBusy(true); setError(''); setNotice('')
    try {
      const { data } = await request.put('/account/me', { nickname: values.nickname.trim() }, { signal: controller.signal })
      if (alive.current && !controller.signal.aborted) {
        setProfile(data); nicknameForm.setFieldsValue({ nickname: data.nickname }); setNotice('昵称已保存。重新打开文档后将使用新昵称。')
      }
    } catch (failure) { if (alive.current && !controller.signal.aborted) setError(failure.message || '昵称保存失败，请重试') }
    finally {
      if (mutation.current === controller) mutation.current = null
      if (alive.current && !controller.signal.aborted) setBusy(false)
    }
  }
  async function changePassword(values) {
    if (mutation.current) return
    const controller = new AbortController(); mutation.current = controller
    setBusy(true); setError(''); setNotice('')
    try {
      let token
      try { token = localStorage.getItem('collab-token') } catch {
        setError('浏览器无法读取登录信息，请允许本站保存数据后重试；已有本地草稿仍保留。')
        return
      }
      await request.post('/account/password', { currentPassword: values.currentPassword, newPassword: values.newPassword }, { signal: controller.signal })
      if (!alive.current || controller.signal.aborted) return
      passwordForm.resetFields()
      let storageFailed = false
      try { expireSession(localStorage, token, () => {}) } catch { storageFailed = true }
      navigate('/login', { replace: true, state: { passwordChanged: true, storageFailed, from: '/account' } })
    } catch (failure) {
      if (alive.current && !controller.signal.aborted) setError(failure.code === 400 ? failure.message
        : '密码更新结果未确认，请先用新密码尝试登录；若无效再用原密码。已有本地草稿仍保留。')
    } finally {
      if (mutation.current === controller) mutation.current = null
      if (alive.current && !controller.signal.aborted) setBusy(false)
    }
  }
  return <Layout className="app-shell">
    <header className="topbar"><Typography.Title level={4}>账号设置</Typography.Title><Space wrap><Button onClick={() => navigate('/home')}>工作台</Button><Button onClick={() => navigate('/docs')}>返回我的文档</Button><LogoutButton /></Space></header>
    <main className="content-wrap">
      <Typography.Title level={2}>我的账号</Typography.Title>
      {loadError && <Alert type="error" showIcon message={loadError} action={<Button onClick={() => setRefresh(value => value + 1)}>重试</Button>} />}
      {error && <Alert type="error" showIcon message={error} />}
      {notice && <Alert type="success" showIcon message={notice} />}
      <Spin spinning={loading}>
        {profile && <Space direction="vertical" style={{ width: '100%' }} size="large">
          <Card title="个人信息">
            <Typography.Paragraph>用户名：{profile.username}（用于登录和添加协作者，不能修改）</Typography.Paragraph>
            <Form form={nicknameForm} layout="vertical" disabled={busy} onFinish={saveNickname}>
              <Form.Item label="昵称" name="nickname" rules={[{ required: true, whitespace: true, message: '请输入昵称' }, { max: 50, message: '昵称最多50个字符' }]}>
                <Input maxLength={50} autoComplete="nickname" />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={busy}>保存昵称</Button>
            </Form>
          </Card>
          <Card title="修改密码">
            <Typography.Paragraph>修改后所有旧登录将失效，请用新密码重新登录。文档、成员权限和本地未确认草稿会保留。</Typography.Paragraph>
            <Form form={passwordForm} layout="vertical" disabled={busy} onFinish={changePassword}>
              <Form.Item label="原密码" name="currentPassword" rules={[{ required: true, message: '请输入原密码' }]}><Input.Password autoComplete="current-password" /></Form.Item>
              <Form.Item label="新密码" name="newPassword" rules={[{ required: true, whitespace: true, message: '请输入新密码' }, { min: 6, max: 64, message: '新密码需要6～64个字符' }, { validator: (_, value) =>
                !value || new TextEncoder().encode(value).length <= 72 ? Promise.resolve() : Promise.reject(new Error('新密码的UTF-8长度不能超过72字节')) }]}><Input.Password autoComplete="new-password" /></Form.Item>
              <Form.Item label="确认新密码" name="confirmPassword" dependencies={['newPassword']} rules={[{ required: true, message: '请再次输入新密码' }, ({ getFieldValue }) => ({ validator: (_, value) =>
                !value || value === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('两次新密码不一致')) })]}><Input.Password autoComplete="new-password" /></Form.Item>
              <Button type="primary" htmlType="submit" loading={busy}>更新密码并重新登录</Button>
            </Form>
          </Card>
        </Space>}
      </Spin>
    </main>
  </Layout>
}
