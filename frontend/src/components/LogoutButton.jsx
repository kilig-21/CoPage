import { useRef, useState } from 'react'
import { Button, Modal, Typography } from 'antd'
import { LogoutOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { captureLoginIdentity, revokeSessionAndClearLocal } from '../auth/session'
import request from '../api/request'

export default function LogoutButton({ compact = false }) {
  const navigate = useNavigate()
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const exiting = useRef(false)
  async function logout() {
    if (exiting.current) return
    exiting.current = true
    setBusy(true)
    let result
    try {
      const identity = captureLoginIdentity(window.localStorage)
      result = await revokeSessionAndClearLocal(window.localStorage, token => request.post('/auth/logout', null, {
        copageExpectedSessionToken: token, timeout: 3000,
      }), identity)
    } catch {
      setFailed(true)
      return
    } finally {
      exiting.current = false
      setBusy(false)
    }
    if (!result) return
    window.dispatchEvent(new Event('copage-auth-changed'))
    navigate('/login', { replace: true, state: {
      loggedOut: result.serverConfirmed,
      logoutUnconfirmed: !result.serverConfirmed,
      logoutCleanupFailed: !result.usernameCleared,
    } })
  }
  return <>
    <Button type="text" onClick={logout} loading={busy} aria-label="退出账号" icon={compact ? <LogoutOutlined /> : undefined}>
      {compact ? <span className="workspace-utility-label">退出账号</span> : '退出账号'}
    </Button>
    <Modal title="暂时无法退出" open={failed} onCancel={() => setFailed(false)} footer={[
      <Button key="continue" onClick={() => setFailed(false)}>继续使用</Button>,
      <Button key="retry" type="primary" loading={busy} onClick={logout}>重试退出</Button>,
    ]}>
      <Typography.Paragraph>浏览器未能清除登录信息，请允许本站保存数据后重试退出。原账号的本地草稿仍保留。</Typography.Paragraph>
    </Modal>
  </>
}
