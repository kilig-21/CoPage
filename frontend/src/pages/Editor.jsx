import { ArrowLeftOutlined, CloudOutlined } from '@ant-design/icons'
import { Alert, Avatar, Button, Layout, Modal, Space, Tag, Tooltip, Typography } from 'antd'
import { Link, useParams } from 'react-router-dom'
import useQuillCollab from '../editor/useQuillCollab'

export default function Editor() {
  const { id } = useParams()
  const docId = Number(id)
  const { editorHostRef, connection, users, error, title, permission,
    recoveryDraft, recoverDraft, discardDraft } = useQuillCollab(docId)
  const isConnected = connection === '已连接'

  return (
    <Layout className="app-shell">
      <header className="topbar">
        <Space>
          <Link to="/docs"><Button type="text" icon={<ArrowLeftOutlined />} /></Link>
          <Typography.Text strong>{title || '协同文档 #' + id}</Typography.Text>
        </Space>
        <Space>
          <Tag color={isConnected ? 'green' : 'gold'} icon={<CloudOutlined />}>{connection}</Tag>
          <Avatar.Group max={{ count: 4 }}>
            {users.map((user) => (
              <Tooltip key={user.userId} title={user.nickname}>
                <Avatar style={{ backgroundColor: user.color }}>{user.nickname?.slice(0, 1).toUpperCase()}</Avatar>
              </Tooltip>
            ))}
          </Avatar.Group>
        </Space>
      </header>
      <main className="editor-wrap">
        <Typography.Text type="secondary">原生 Quill · WebSocket 协同 · 当前文档 ID：{id}</Typography.Text>
        {permission === 1 && <Alert className="editor-alert" type="info" showIcon message="你拥有只读权限，不能修改此文档" />}
        {error && <Alert className="editor-alert" type="warning" showIcon message={error} closable onClose={() => undefined} />}
        <section className="editor-canvas">
          <div ref={editorHostRef} className="editor-host" aria-label="协同编辑器" />
        </section>
      </main>
      <Modal title="发现未确认的本地编辑" open={Boolean(recoveryDraft)} closable={false}
        maskClosable={false} keyboard={false} onCancel={() => undefined}
        footer={[
          <Button key="discard" danger onClick={discardDraft}>丢弃本地草稿</Button>,
          <Button key="recover" type="primary" onClick={recoverDraft}>恢复草稿并同步</Button>,
        ]}>
        <Typography.Paragraph>这份草稿可能包含服务端尚未确认的修改。恢复前不会自动重发，也不会覆盖本地草稿。</Typography.Paragraph>
        {Number.isFinite(recoveryDraft?.savedAt) &&
          <Typography.Text type="secondary">保存时间：{new Date(recoveryDraft.savedAt).toLocaleString()}</Typography.Text>}
      </Modal>
    </Layout>
  )
}
