import { useEffect, useRef, useState } from 'react'
import { CloseCircleOutlined, FileTextOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons'
import { Alert, Avatar, Button, Card, Empty, Input, Layout, List, Pagination, Popconfirm, Radio, Space, Tag, Typography, message } from 'antd'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import request from '../api/request'
import CollaboratorModal from '../components/CollaboratorModal'
import ImportModal from '../components/ImportModal'
import CopyModal from '../components/CopyModal'
import RenameModal from '../components/RenameModal'
import UserGuide from '../components/UserGuide'

const PAGE_SIZE = 20

export default function DocList() {
  const [managing, setManaging] = useState(null)
  const [copying, setCopying] = useState(null)
  const [showGuide, setShowGuide] = useState(false)
  const navigate = useNavigate()
  const [docs, setDocs] = useState([])
  const [total, setTotal] = useState(0)
  const [searchParams, setSearchParams] = useSearchParams()
  const keyword = (searchParams.get('keyword') || '').slice(0, 200).trim()
  const rawScope = searchParams.get('scope')
  const scope = ['owned', 'shared'].includes(rawScope) ? rawScope : 'all'
  const rawPage = Number(searchParams.get('page') || 1)
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage <= 1_000_000 ? rawPage : 1
  const [filter, setFilter] = useState(keyword)
  const scopeParams = scope === 'all' ? {} : { scope }
  const setPage = next => setSearchParams({ ...scopeParams, ...(keyword ? { keyword } : {}), page: String(next) })
  useEffect(() => setFilter(keyword), [keyword])
  const applyFilter = value => setSearchParams({ ...scopeParams, ...(value.trim() ? { keyword: value.trim() } : {}) })
  const applyScope = next => setSearchParams({ ...(next === 'all' ? {} : { scope: next }), ...(keyword ? { keyword } : {}) })
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [creating, setCreating] = useState(false)
  const createController = useRef(null)
  useEffect(() => () => createController.current?.abort(), [])
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError('')
    request.get('/doc/list', { params: { page, size: PAGE_SIZE, keyword, scope }, signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return
        const lastPage = Math.max(1, Math.ceil(response.data.total / PAGE_SIZE))
        if (page > lastPage) { setPage(lastPage); return }
        setDocs(response.data.list)
        setTotal(response.data.total)
      })
      .catch((error) => {
        if (!controller.signal.aborted) { setDocs([]); setTotal(0); setLoadError(error?.message || '文档列表加载失败') }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [page, keyword, scope, refresh])

  async function createDocument() {
    if (createController.current) return
    const controller = new AbortController()
    createController.current = controller
    setCreating(true)
    try {
      const response = await request.post('/doc', { title: '未命名文档' }, { signal: controller.signal })
      if (controller.signal.aborted) return
      navigate('/docs/' + response.data.id)
    } catch (error) {
      if (!controller.signal.aborted) message.error(error?.code === 400 ? error.message : '创建结果未确认，请先刷新列表检查是否已创建，再决定是否重试')
    } finally {
      if (createController.current === controller) createController.current = null
      if (!controller.signal.aborted) setCreating(false)
    }
  }

  async function deleteDocument(id) {
    try {
      await request.delete('/doc/' + id)
      setRefresh((value) => value + 1)
    } catch (error) {
      message.error(error?.message || '删除失败')
    }
  }

  function logout() {
    localStorage.removeItem('collab-token')
    localStorage.removeItem('collab-user')
    navigate('/login', { replace: true })
  }

  return (
    <Layout className="app-shell">
      <header className="topbar">
        <Typography.Title level={4}>协同文档</Typography.Title>
        <Space wrap>
          <Button icon={<SearchOutlined />} onClick={() => navigate('/search')}>搜索</Button>
          <Button onClick={() => navigate('/trash')}>回收站</Button>
          <Button onClick={() => setShowGuide(true)}>使用指南</Button>
          <Avatar>{(localStorage.getItem('collab-user') || 'A').slice(0, 1).toUpperCase()}</Avatar>
          <Button onClick={() => navigate('/account')}>账号设置</Button>
          <Button type="text" onClick={logout}>退出</Button>
        </Space>
      </header>
      <main className="content-wrap">
        <div className="page-heading">
          <div><Typography.Title level={2}>我的文档</Typography.Title><Typography.Text type="secondary">编辑时可查看连接与保存状态，删除的文档可从回收站找回</Typography.Text></div>
          <Space wrap>
            <Button onClick={() => setImporting(true)}>导入文档</Button>
            <Button onClick={() => navigate('/templates')}>从模板新建</Button>
            <Button type="primary" icon={<PlusOutlined />} loading={creating} onClick={createDocument}>新建文档</Button>
          </Space>
        </div>
        <Space wrap style={{ marginBottom: 16 }}>
          <Radio.Group aria-label="文档分类" value={scope} onChange={event => applyScope(event.target.value)}
            options={[{ label: '全部', value: 'all' }, { label: '我创建', value: 'owned' }, { label: '与我协作', value: 'shared' }]} />
        </Space>
        <Input.Search className="search-box" aria-label="按文档标题筛选" placeholder="按标题筛选当前分类"
          maxLength={200} value={filter} allowClear={{ clearIcon: <CloseCircleOutlined aria-label="清除标题输入" /> }} enterButton="筛选"
          onChange={event => setFilter(event.target.value)} onSearch={applyFilter} />
        {keyword && <div className="filter-summary"><span>标题包含“{keyword}”</span>
          <Button type="link" onClick={() => applyFilter('')}>清除筛选</Button></div>}
        <Card className="doc-list-card">
          {loadError && <Alert type="error" showIcon message={loadError}
            action={<Button disabled={loading} onClick={() => setRefresh(value => value + 1)}>重试</Button>} />}
          <List
            rowKey="id"
            loading={loading}
            dataSource={docs}
            locale={{ emptyText: loading ? '正在加载…' : loadError ? '列表暂不可用' : <Empty description={keyword ? '没有匹配的标题，试试其他关键词' : scope === 'shared' ? '还没有共享给你的文档，请文档所有者添加你为协作者' : '还没有文档，先新建一篇吧'} /> }}
            renderItem={(doc) => (
              <List.Item actions={[
                <Link key="open" to={'/docs/' + doc.id}>打开</Link>,
                <Button key="copy" type="link" onClick={() => setCopying(doc)}>创建副本</Button>,
                doc.permission === 2 && <Button key="rename" type="link" onClick={() => setEditing(doc)}>重命名</Button>,
                doc.isOwner && <Button key="members" type="link" onClick={() => setManaging(doc)}>协作者管理</Button>,
                doc.isOwner && <Popconfirm key="delete" overlayClassName="document-action-confirm" title={`将“${doc.title}”移入回收站？`} description="协作者将停止访问，你可以在回收站恢复。" onConfirm={() => deleteDocument(doc.id)}>
                  <Button type="link" danger>删除</Button>
                </Popconfirm>,
              ].filter(Boolean)}>
                <List.Item.Meta avatar={<FileTextOutlined className="doc-icon" />} title={<Link to={'/docs/' + doc.id}>{doc.title}</Link>}
                  description={<Space wrap><Tag>{doc.isOwner ? '所有者' : doc.permission === 2 ? '可编辑' : '只读'}</Tag><span>{doc.ownerName + ' · ' + doc.updateTime}</span></Space>} />
              </List.Item>
            )}
          />
          {total > PAGE_SIZE && <Pagination current={page} pageSize={PAGE_SIZE} total={total} showSizeChanger={false}
            disabled={loading} onChange={setPage} />}
        </Card>
      </main>
      {showGuide && <UserGuide onClose={() => setShowGuide(false)} />}
      {copying && <CopyModal doc={copying} onClose={() => setCopying(null)}
        onCreated={data => { message.success('已创建服务端版本 ' + data.sourceRevision + ' 的副本'); navigate('/docs/' + data.id) }} />}
      {managing && <CollaboratorModal doc={managing} onClose={() => setManaging(null)} />}
      {importing && <ImportModal onClose={() => setImporting(false)} onCreated={id => navigate('/docs/' + id)} />}
      {editing && <RenameModal doc={editing} onClose={() => setEditing(null)}
        onSaved={() => setRefresh(value => value + 1)} />}
    </Layout>
  )
}
