import { useEffect, useState } from 'react'
import { Alert, Button, Card, Col, Empty, Layout, List, Row, Space, Statistic, Tag, Typography } from 'antd'
import { Link, useLocation } from 'react-router-dom'
import { documentHref } from '../navigation/documents'
import request from '../api/request'
import LogoutButton from '../components/LogoutButton'
import UserGuide from '../components/UserGuide'
import WorkspaceOverview from '../components/WorkspaceOverview'

export default function Home() {
  const location = useLocation()
  const sourcePath = location.pathname + location.search + location.hash
  const [data, setData] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [showGuide, setShowGuide] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setData(null); setProfile(null)
    Promise.all([
      request.get('/doc/workbench', { signal: controller.signal }),
      request.get('/account/me', { signal: controller.signal }),
    ]).then(([documents, account]) => {
      if (controller.signal.aborted) return
      setData(documents.data); setProfile(account.data)
    }).catch(failure => {
      if (!controller.signal.aborted) setError([400, 401, 403, 404].includes(failure?.code)
        ? failure.message : '工作台暂时无法加载，请检查网络后重试。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh])
  return <Layout className="app-shell">
    <header className="topbar">
      <Typography.Title level={4}>CoPage 工作台</Typography.Title>
      <nav aria-label="应用导航"><Space wrap>
        <Link to="/docs">我的文档</Link><Link to="/groups">我的小组</Link><Link to="/projects">我的项目</Link><Link to="/templates">模板中心</Link>
        <Link to="/search">搜索</Link><Link to="/trash">回收站</Link><Link to="/account">账号设置</Link>
        <Button onClick={() => setShowGuide(true)}>使用指南</Button>
        <LogoutButton />
      </Space></nav>
    </header>
    <main className="content-wrap workbench">
      <div className="page-heading"><div>
        <Typography.Title level={2}>{profile ? profile.nickname + '，欢迎回来' : '你的协作工作台'}</Typography.Title>
        <Typography.Paragraph type="secondary">继续整理资料，或从一份模板开始新的工作。</Typography.Paragraph>
      </div><Space wrap><Link className="ant-btn ant-btn-default" to="/docs">管理文档</Link>
        <Link className="ant-btn ant-btn-primary" to="/templates">从模板开始</Link></Space></div>
      {error && <Alert type="error" showIcon message={error}
        action={<Button disabled={loading} onClick={() => setRefresh(value => value + 1)}>重试</Button>} />}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12}><Card loading={loading}>
          {data && <><Statistic title="我创建的文档" value={data.ownedCount} />
            <Link to="/docs?scope=owned">查看我创建的文档</Link></>}
        </Card></Col>
        <Col xs={24} sm={12}><Card loading={loading}>
          {data && <><Statistic title="与我协作的文档" value={data.sharedCount} />
            <Link to="/docs?scope=shared">查看同伴共享的文档</Link></>}
        </Card></Col>
      </Row>
      <WorkspaceOverview />
      <Card title="近期更新" className="workbench-recent" loading={loading}
        extra={<Link to="/docs">查看全部</Link>}>
        {data && <List rowKey="id" dataSource={data.recent}
          locale={{ emptyText: <Empty description="还没有文档，先从模板创建一篇或请同伴添加你为协作者" /> }}
          renderItem={doc => <List.Item>
            <List.Item.Meta title={<Link to={documentHref(doc.id, sourcePath)}>{doc.title}</Link>}
              description={<Space wrap><Tag>{doc.isOwner ? '所有者' : doc.permission === 2 ? '可编辑' : '只读'}</Tag>
                <span>{doc.ownerName + ' · 更新于 ' + doc.updateTime}</span></Space>} />
            <Link to={documentHref(doc.id, sourcePath)}>打开</Link>
          </List.Item>} />}
        {!loading && !data && <Typography.Paragraph>恢复连接后重试，即可查看当前可访问的资料。</Typography.Paragraph>}
      </Card>
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12}><Card title="模板中心">
          <Typography.Paragraph>按用途选择六种内置框架，或复用自己的私人模板，预览后创建独立文档。</Typography.Paragraph>
          <Space wrap><Link to="/templates">挑选内置模板</Link><Link to="/templates?source=personal">我的模板</Link></Space>
        </Card></Col>
        <Col xs={24} sm={12}><Card title="找到需要的资料">
          <Typography.Paragraph>按标题和正文检索你有权限访问的文档。</Typography.Paragraph>
          <Link to="/search">搜索文档</Link>
        </Card></Col>
      </Row>
    </main>
    {showGuide && <UserGuide onClose={() => setShowGuide(false)} />}
  </Layout>
}
