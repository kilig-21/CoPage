import { useRef, useState } from 'react'
import { Button, Modal, Typography } from 'antd'
import { LogoutOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { logoutSession } from '../auth/session'

export default function LogoutButton({ compact = false }) {
  const navigate = useNavigate()
  const [failed, setFailed] = useState(false)
  const exiting = useRef(false)
  function logout() {
    if (exiting.current) return
    exiting.current = true
    let result
    try { result = logoutSession(window.localStorage) }
    catch { exiting.current = false; setFailed(true); return }
    window.dispatchEvent(new Event('copage-auth-changed'))
    navigate('/login', { replace: true, state: {
      loggedOut: true, logoutCleanupFailed: !result.usernameCleared,
    } })
  }
  return <>
    <Button type="text" onClick={logout} aria-label="退出账号" icon={compact ? <LogoutOutlined /> : undefined}>
      {compact ? <span className="workspace-utility-label">退出账号</span> : '退出账号'}
    </Button>
    <Modal title="暂时无法退出" open={failed} onCancel={() => setFailed(false)} footer={[
      <Button key="continue" onClick={() => setFailed(false)}>继续使用</Button>,
      <Button key="retry" type="primary" onClick={logout}>重试退出</Button>,
    ]}>
      <Typography.Paragraph>浏览器未能清除登录信息，请允许本站保存数据后重试退出。原账号的本地草稿仍保留。</Typography.Paragraph>
    </Modal>
  </>
}
