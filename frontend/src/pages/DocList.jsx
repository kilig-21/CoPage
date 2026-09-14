import { FileTextOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons'
import { Avatar, Button, Card, Layout, List, Space, Typography } from 'antd'
import { Link, useNavigate } from 'react-router-dom'

const demoDocs = [
  { id: 1, title: '项目需求说明书', updateTime: '刚刚更新', ownerName: '测试用户 A' },
  { id: 2, title: '答辩分工与时间表', updateTime: '今天 14:30', ownerName: '测试用户 B' },
]

/** A 负责：使用 GET /api/doc/list 和 POST /api/doc 替换 demoDocs。 */
export default function DocList() {
  const navigate = useNavigate()
  return (
    <Layout className="app-shell">
      <header className="topbar">
        <Typography.Title level={4}>协同文档</Typography.Title>
        <Space>
          <Button icon={<SearchOutlined />} onClick={() => navigate('/search')}>搜索</Button>
          <Avatar>{(localStorage.getItem('collab-user') || 'A').slice(0, 1).toUpperCase()}</Avatar>
        </Space>
      </header>
      <main className="content-wrap">
        <div className="page-heading">
          <div><Typography.Title level={2}>我的文档</Typography.Title><Typography.Text type="secondary">所有修改都会自动保存</Typography.Text></div>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/docs/1')}>新建文档</Button>
        </div>
        <Card className="doc-list-card">
          <List dataSource={demoDocs} renderItem={(doc) => (
            <List.Item actions={[<Link key="open" to={`/docs/${doc.id}`}>打开</Link>]}>
              <List.Item.Meta avatar={<FileTextOutlined className="doc-icon" />} title={doc.title} description={`${doc.ownerName} · ${doc.updateTime}`} />
            </List.Item>
          )} />
        </Card>
      </main>
    </Layout>
  )
}
