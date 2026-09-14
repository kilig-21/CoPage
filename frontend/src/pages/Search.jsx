import { ArrowLeftOutlined, FileTextOutlined } from '@ant-design/icons'
import { Button, Card, Input, List, Space, Typography } from 'antd'
import { Link } from 'react-router-dom'

const demoResults = [{ id: 1, title: '项目需求说明书', snippet: '支持多人实时协同编辑的在线文档系统。' }]

/** A 负责：使用 GET /api/search?q= 替换此处演示结果。 */
export default function Search() {
  return (
    <main className="content-wrap">
      <Space className="search-title"><Link to="/docs"><Button type="text" icon={<ArrowLeftOutlined />} /></Link><Typography.Title level={2}>搜索文档</Typography.Title></Space>
      <Input.Search placeholder="搜索标题和正文" size="large" enterButton="搜索" className="search-box" />
      <Card><List dataSource={demoResults} renderItem={(item) => <List.Item><List.Item.Meta avatar={<FileTextOutlined className="doc-icon" />} title={<Link to={`/docs/${item.id}`}>{item.title}</Link>} description={item.snippet} /></List.Item>} /></Card>
    </main>
  )
}
