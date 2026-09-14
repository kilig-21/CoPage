import { ArrowLeftOutlined, CloudOutlined } from '@ant-design/icons'
import { Avatar, Button, Layout, Space, Tag, Typography } from 'antd'
import { Link, useParams } from 'react-router-dom'

/** 负责人负责：原生 Quill、CollabClient、远端光标和 WebSocket 在此页面接入。 */
export default function Editor() {
  const { id } = useParams()
  return (
    <Layout className="app-shell">
      <header className="topbar">
        <Space><Link to="/docs"><Button type="text" icon={<ArrowLeftOutlined />} /></Link><Typography.Text strong>项目需求说明书</Typography.Text></Space>
        <Space><Tag color="green" icon={<CloudOutlined />}>已保存</Tag><Avatar.Group><Avatar style={{ backgroundColor: '#2563eb' }}>A</Avatar><Avatar style={{ backgroundColor: '#db2777' }}>B</Avatar></Avatar.Group></Space>
      </header>
      <main className="editor-wrap">
        <Typography.Text type="secondary">文档 #{id} · 编辑器和协同引擎待接入</Typography.Text>
        <section className="editor-canvas">
          <Typography.Title>项目需求说明书</Typography.Title>
          <Typography.Paragraph>这里是原生 Quill 的挂载位置。远程 Delta 必须通过 <code>updateContents(op, 'api')</code> 应用，避免产生回声。</Typography.Paragraph>
          <div id="quill-editor" aria-label="协同编辑器挂载点" />
        </section>
      </main>
    </Layout>
  )
}
