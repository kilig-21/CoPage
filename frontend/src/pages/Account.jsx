import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Form, Input, Layout, Space, Spin, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'
import { usePageRequest } from '../auth/PageSessionContext'
import WorkspaceHeader from '../components/WorkspaceHeader'
import { expireSession } from '../auth/session'
import { createAccountSettings, isAccountSessionFailure } from '../api/accountSettings'
import '../styles/account.css'

export default function Account() {
  const request = usePageRequest()
  const navigate = useNavigate()
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [feedbackFor, setFeedbackFor] = useState('')
  const [sessionBlocked, setSessionBlocked] = useState(false)
  const [nicknameForm] = Form.useForm()
  const [passwordForm] = Form.useForm()
  const alive = useRef(true)
  const mutation = useRef(null)
  const settings = useRef(null)
  const feedback = useRef(null)
  const nicknameAction = useRef(null)
  const passwordAction = useRef(null)
  function accountSettings() {
    if (!settings.current) settings.current = createAccountSettings({ storage: localStorage,
      get: (...args) => request.get(...args), put: (...args) => request.put(...args), post: (...args) => request.post(...args) })
    return settings.current
  }
  const relogin = () => navigate('/login', { replace: true, state: { sessionChanged: true, from: '/account' } })
  useEffect(() => {
    if (!error && !notice) return
    const action = (feedbackFor === 'nickname' ? nicknameAction : passwordAction).current
    if (!action || !feedback.current) return
    const bounds = action.getBoundingClientRect()
    const headerBottom = document.querySelector('.workspace-header')?.getBoundingClientRect().bottom || 0
    // 仍在查看本次操作时显示附近的结果；已经滚动离开则不拉回，也不移动键盘焦点。
    if (bounds.bottom > Math.max(0, headerBottom) && bounds.top < window.innerHeight) {
      feedback.current.style.scrollMarginTop = `${Math.max(0, headerBottom) + 12}px`
      feedback.current.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    }
  }, [error, notice, feedbackFor])
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; mutation.current?.abort() }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setLoadError('')
    Promise.resolve().then(() => accountSettings().read(controller.signal))
      .then(verified => {
        if (controller.signal.aborted) return
        setProfile(verified); nicknameForm.setFieldsValue({ nickname: verified.nickname || verified.username })
      })
      .catch(failure => {
        if (!controller.signal.aborted) {
          if (isAccountSessionFailure(failure)) setSessionBlocked(true)
          setLoadError(isAccountSessionFailure(failure) || failure?.reason === 'ACCOUNT_PROFILE_RESPONSE'
            ? failure.message : '账号信息暂时无法读取，请检查连接后重试。')
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh, nicknameForm])
  async function saveNickname(values) {
    if (mutation.current || sessionBlocked) return
    const controller = new AbortController(); mutation.current = controller
    setBusy(true); setError(''); setNotice(''); setFeedbackFor('nickname')
    try {
      const submittedNickname = values.nickname.trim()
      const verified = await accountSettings().saveNickname(profile, submittedNickname, controller.signal)
      if (alive.current && !controller.signal.aborted) {
        setProfile(verified); nicknameForm.setFieldsValue({ nickname: verified.nickname }); setNotice('昵称已保存。重新打开文档后将使用新昵称。')
      }
    } catch (failure) {
      if (alive.current && !controller.signal.aborted) {
        if (isAccountSessionFailure(failure)) setSessionBlocked(true)
        setError(isAccountSessionFailure(failure) ? failure.message
          : failure?.code === 400 && failure?.reason !== 'ACCOUNT_PROFILE_RESPONSE'
            ? failure.message || '昵称不符合要求，请修改后重试。'
            : '昵称保存结果未确认，当前输入已保留。可以重新保存相同昵称，或重新打开账号页核对当前资料。')
      }
    }
    finally {
      if (mutation.current === controller) mutation.current = null
      if (alive.current && !controller.signal.aborted) setBusy(false)
    }
  }
  async function changePassword(values) {
    if (mutation.current || sessionBlocked) return
    const controller = new AbortController(); mutation.current = controller
    setBusy(true); setError(''); setNotice(''); setFeedbackFor('password')
    try {
      const currentSettings = accountSettings()
      await currentSettings.changePassword({ currentPassword: values.currentPassword, newPassword: values.newPassword }, controller.signal)
      if (!alive.current || controller.signal.aborted) return
      passwordForm.resetFields()
      let storageFailed = false
      try {
        if (!expireSession(localStorage, currentSettings.token, result => { storageFailed = result.cleanupFailed })) return
      } catch { storageFailed = true }
      navigate('/login', { replace: true, state: { passwordChanged: true, storageFailed, from: '/account' } })
    } catch (failure) {
      if (alive.current && !controller.signal.aborted) {
        if (isAccountSessionFailure(failure)) setSessionBlocked(true)
        setError(isAccountSessionFailure(failure) ? failure.message : failure.code === 400 ? failure.message
          : '密码更新结果未确认，请先用新密码尝试登录；若无效再用原密码。已有本地草稿仍保留。')
      }
    } finally {
      if (mutation.current === controller) mutation.current = null
      if (alive.current && !controller.signal.aborted) setBusy(false)
    }
  }
  return <Layout className="app-shell">
    <WorkspaceHeader title="账号设置" />
    <main id="workspace-main" tabIndex={-1} className="content-wrap">
      <Typography.Title level={2}>我的账号</Typography.Title>
      {loadError && <Alert type="error" showIcon message={loadError} action={sessionBlocked
        ? <Button onClick={relogin}>重新登录</Button> : <Button onClick={() => setRefresh(value => value + 1)}>重试</Button>} />}
      <Spin spinning={loading}>
        {profile && <Space direction="vertical" style={{ width: '100%' }} size="large">
          <Card title="个人信息">
            <Typography.Paragraph>用户名：{profile.username}（用于登录和添加协作者，不能修改）</Typography.Paragraph>
            <Form form={nicknameForm} layout="vertical" disabled={busy || sessionBlocked} onFinish={saveNickname}>
              <Form.Item label="昵称" name="nickname" rules={[{ required: true, whitespace: true, message: '请输入昵称' }, { max: 50, message: '昵称最多50个字符' }]}>
                <Input maxLength={50} autoComplete="nickname" />
              </Form.Item>
              <div ref={nicknameAction}><Button type="primary" htmlType="submit" loading={busy}>保存昵称</Button></div>
            </Form>
            {feedbackFor === 'nickname' && (error || notice) && <div ref={feedback} className="account-feedback">
              {error ? <Alert type="error" showIcon message={error} action={sessionBlocked && <Button onClick={relogin}>重新登录</Button>} />
                : <Alert type="success" showIcon role="status" message={notice} />}
            </div>}
          </Card>
          <Card title="修改密码">
            <Typography.Paragraph>修改后所有旧登录将失效，请用新密码重新登录。文档、成员权限和本地未确认草稿会保留。</Typography.Paragraph>
            <Form form={passwordForm} layout="vertical" disabled={busy || sessionBlocked} onFinish={changePassword}>
              <Form.Item label="原密码" name="currentPassword" rules={[{ required: true, message: '请输入原密码' }]}><Input.Password autoComplete="current-password" /></Form.Item>
              <Form.Item label="新密码" name="newPassword" rules={[{ required: true, whitespace: true, message: '请输入新密码' }, { min: 6, max: 64, message: '新密码需要6～64个字符' }, { validator: (_, value) =>
                !value || new TextEncoder().encode(value).length <= 72 ? Promise.resolve() : Promise.reject(new Error('新密码的UTF-8长度不能超过72字节')) }]}><Input.Password autoComplete="new-password" /></Form.Item>
              <Form.Item label="确认新密码" name="confirmPassword" dependencies={['newPassword']} rules={[{ required: true, message: '请再次输入新密码' }, ({ getFieldValue }) => ({ validator: (_, value) =>
                !value || value === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('两次新密码不一致')) })]}><Input.Password autoComplete="new-password" /></Form.Item>
              <div ref={passwordAction}><Button type="primary" htmlType="submit" loading={busy}>更新密码并重新登录</Button></div>
            </Form>
            {feedbackFor === 'password' && error && <div ref={feedback} className="account-feedback">
              <Alert type="error" showIcon message={error} action={sessionBlocked && <Button onClick={relogin}>重新登录</Button>} />
            </div>}
          </Card>
        </Space>}
      </Spin>
    </main>
  </Layout>
}
