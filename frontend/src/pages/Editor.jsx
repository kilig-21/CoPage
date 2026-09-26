import { ArrowLeftOutlined, CloudOutlined } from '@ant-design/icons'
import { Alert, Avatar, Button, Layout, Space, Tag, Tooltip, Typography } from 'antd'
import { Link, useParams } from 'react-router-dom'
import useQuillCollab from '../editor/useQuillCollab'

export default function Editor() {
  const { id } = useParams()
  const docId = Number(id)
  const { editorHostRef, connection, users, error, title, permission } = useQuillCollab(docId)
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
    </Layout>
  )
}
