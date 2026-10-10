import { useEffect, useState } from 'react'
import { Alert, Button, Card, Empty, Layout, List, Space, Tag, Typography } from 'antd'
import { ArrowRightOutlined, FileTextOutlined } from '@ant-design/icons'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { documentHref } from '../navigation/documents'
import request from '../api/request'
import UserGuide from '../components/UserGuide'
import WorkspaceOverview from '../components/WorkspaceOverview'
import WorkspaceHeader from '../components/WorkspaceHeader'
import '../styles/workbench.css'

export default function Home() {
  const location = useLocation()
  const navigate = useNavigate()
  const sourcePath = location.pathname + location.search + location.hash
  const [data, setData] = useState(null)
  const [profile, setProfile] = useState(null)
  const [profileLoading, setProfileLoading] = useState(true)
  const [profileError, setProfileError] = useState('')
  const [profileRefresh, setProfileRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [showGuide, setShowGuide] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setData(null)
    request.get('/doc/workbench', { signal: controller.signal }).then(({ data }) => {
      if (controller.signal.aborted) return
      setData(data)
    }).catch(failure => {
      if (!controller.signal.aborted) setError([400, 401, 403, 404].includes(failure?.code)
        ? failure.message : '文档概览暂时无法加载，请检查网络后重试。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh])
  useEffect(() => {
    const controller = new AbortController()
    setProfileLoading(true); setProfileError(''); setProfile(null)
    request.get('/account/me', { signal: controller.signal }).then(({ data }) => {
      if (!controller.signal.aborted) setProfile(data)
    }).catch(failure => {
      if (!controller.signal.aborted) setProfileError([400, 401, 403, 404].includes(failure?.code)
        ? failure.message : '账号资料暂时无法加载，可单独重试。')
    }).finally(() => { if (!controller.signal.aborted) setProfileLoading(false) })
    return () => controller.abort()
  }, [profileRefresh])
  return <Layout className="app-shell">
    <WorkspaceHeader title="工作台" onGuide={() => setShowGuide(true)} />
    <main className="content-wrap workbench">
      <div className="page-heading cp-workbench-heading"><div>
        <Typography.Text className="cp-workbench-kicker">你的资料与协作</Typography.Text>
        <Typography.Title level={1}>{profile ? profile.nickname + '，欢迎回来' : '你的协作工作台'}</Typography.Title>
        <Typography.Paragraph type="secondary">接着写下想法，或从一份模板开始新的工作。</Typography.Paragraph>
      </div><Space wrap className="cp-workbench-actions">
        <Button size="large" onClick={() => navigate('/docs')}>管理文档</Button>
        <Button size="large" type="primary" icon={<ArrowRightOutlined aria-hidden="true" />} iconPosition="end" onClick={() => navigate('/templates')}>从模板开始</Button>
      </Space></div>
      {profileError && <Alert type="warning" showIcon message={profileError}
        action={<Button disabled={profileLoading} onClick={() => setProfileRefresh(value => value + 1)}>重试账号资料</Button>} />}
      {error && <Alert type="error" showIcon message={error}
        action={<Button disabled={loading} onClick={() => setRefresh(value => value + 1)}>重试文档概览</Button>} />}
      <Card title={<div className="cp-workbench-section-title"><Typography.Title level={2}>继续工作</Typography.Title>
        <Typography.Text type="secondary">最近更新的资料，继续查看或编辑。</Typography.Text></div>}
        className="workbench-recent workbench-documents cp-recent-documents" loading={loading}
        extra={<Space wrap><Button type="text" disabled={loading} onClick={() => setRefresh(value => value + 1)}>刷新文档概览</Button>
          <Link to="/docs">查看全部</Link></Space>}>
        {data && <><div className="cp-document-counts" aria-label="文档概览">
          <Link to="/docs?scope=owned"><span>我创建的文档</span><strong>{data.ownedCount}</strong></Link>
          <Link to="/docs?scope=shared"><span>与我协作的文档</span><strong>{data.sharedCount}</strong></Link>
        </div><List rowKey="id" dataSource={data.recent}
          locale={{ emptyText: <Empty description="还没有文档，先从模板创建一篇或请同伴添加你为协作者" /> }}
          renderItem={doc => <List.Item>
            <List.Item.Meta avatar={<FileTextOutlined className="cp-recent-document-icon" />}
              title={<Link to={documentHref(doc.id, sourcePath)}>{doc.title}</Link>}
              description={<Space wrap className="cp-recent-document-meta"><Tag>{doc.isOwner ? '所有者' : doc.permission === 2 ? '可编辑' : '只读'}</Tag>
                <span>{doc.ownerName + ' · 更新于 ' + doc.updateTime}</span></Space>} />
            <Link className="cp-document-open" to={documentHref(doc.id, sourcePath)}>打开 <ArrowRightOutlined /></Link>
          </List.Item>} /></>}
        {!loading && !data && <Typography.Paragraph>恢复连接后重试，即可查看当前可访问的资料。</Typography.Paragraph>}
      </Card>
      <div className="cp-workbench-secondary">
        <WorkspaceOverview />
        <aside className="cp-workbench-tools" aria-label="资料工具">
          <section className="cp-workbench-tool"><Typography.Title level={3}>从一份框架开始</Typography.Title>
            <Typography.Paragraph type="secondary">挑选六种内置模板，或复用自己的私人模板，预览后创建独立文档。</Typography.Paragraph>
            <Space wrap><Link to="/templates">挑选内置模板 <ArrowRightOutlined /></Link><Link to="/templates?source=personal">我的模板</Link></Space>
          </section>
          <section className="cp-workbench-tool"><Typography.Title level={3}>找到需要的资料</Typography.Title>
            <Typography.Paragraph type="secondary">按标题和正文，检索你有权限访问的文档。</Typography.Paragraph>
            <Link to="/search">搜索文档 <ArrowRightOutlined /></Link>
          </section>
        </aside>
      </div>
    </main>
    {showGuide && <UserGuide onClose={() => setShowGuide(false)} />}
  </Layout>
}
