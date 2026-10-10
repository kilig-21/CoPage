import { useEffect, useRef, useState } from 'react'
import { CloseCircleOutlined, FileTextOutlined, PlusOutlined, MoreOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Dropdown, Empty, Input, Layout, List, Pagination, Popconfirm, Radio, Space, Tag, Typography, message } from 'antd'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { documentHref } from '../navigation/documents'
import request from '../api/request'
import createDocumentRequest from '../api/createDocument'
import useDocumentLifecycle from '../api/useDocumentLifecycle'
import WorkspaceHeader from '../components/WorkspaceHeader'
import SavePersonalTemplateModal from '../components/SavePersonalTemplateModal'
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
  const location = useLocation()
  const sourcePath = location.pathname + location.search + location.hash
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
  const [importing, setImporting] = useState(false)
  const [savingTemplate, setSavingTemplate] = useState(null)
  const [templatePendingName, setTemplatePendingName] = useState(null)
  const [loadedFrom, setLoadedFrom] = useState(null)
  const listKey = JSON.stringify([page, keyword, scope, refresh])
  const deletion = useDocumentLifecycle({ operation: 'delete', ready: loadedFrom === listKey && !loading && !loadError,
    onConfirmed: () => setRefresh(value => value + 1) })

  useEffect(() => {
    setCopying(null); setImporting(false)
    createController.current?.abort(); createController.current = null; setCreating(false)
    return () => createController.current?.abort()
  }, [location.key])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError('')
    setDocs([]); setTotal(0)
    request.get('/doc/list', { params: { page, size: PAGE_SIZE, keyword, scope }, signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return
        const lastPage = Math.max(1, Math.ceil(response.data.total / PAGE_SIZE))
        if (page > lastPage) { setPage(lastPage); return }
        setDocs(response.data.list)
        setTotal(response.data.total)
        setLoadedFrom(listKey)
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
      const response = await createDocumentRequest('/doc', { title: '未命名文档' }, { signal: controller.signal })
      if (controller.signal.aborted) return
      navigate(documentHref(response.data.id, sourcePath))
    } catch (error) {
      if (!controller.signal.aborted) message.error(error?.code === 400 ? error.message : '创建结果未确认，可以重试本次创建，也可先刷新列表核对；相同请求不会重复创建文档。')
    } finally {
      if (createController.current === controller) createController.current = null
      if (!controller.signal.aborted) setCreating(false)
    }
  }

  return (
    <Layout className="app-shell">
      <WorkspaceHeader title="我的文档" onGuide={() => setShowGuide(true)} />
      <main className="content-wrap">
        <div className="page-heading">
          <div><Typography.Title level={2}>我的文档</Typography.Title><Typography.Text type="secondary">编辑时可查看连接与保存状态，删除的文档可从回收站找回</Typography.Text></div>
          <Space wrap>
            <Button disabled={loading || deletion.busy} onClick={() => setRefresh(value => value + 1)}>刷新文档列表</Button>
            <Button onClick={() => setImporting(true)}>导入文档</Button>
            <Button onClick={() => navigate('/templates')}>从模板新建</Button>
            <Button type="primary" icon={<PlusOutlined />} loading={creating} onClick={createDocument}>新建文档</Button>
          </Space>
        </div>
        <Space wrap style={{ marginBottom: 16 }}>
          <Radio.Group aria-label="文档分类" value={scope} disabled={deletion.busy} onChange={event => applyScope(event.target.value)}
            options={[{ label: '全部', value: 'all' }, { label: '我创建', value: 'owned' }, { label: '与我协作', value: 'shared' }]} />
        </Space>
        <Input.Search className="search-box" aria-label="按文档标题筛选" placeholder="按标题筛选当前分类"
          maxLength={200} value={filter} disabled={deletion.busy} allowClear={{ clearIcon: <CloseCircleOutlined aria-label="清除标题输入" /> }} enterButton="筛选"
          onChange={event => setFilter(event.target.value)} onSearch={applyFilter} />
        {keyword && <div className="filter-summary"><span>标题包含“{keyword}”</span>
          <Button type="link" onClick={() => applyFilter('')}>清除筛选</Button></div>}
        {templatePendingName && <Alert type="warning" showIcon message="模板保存结果未确认，请先核对我的模板，再决定是否重试。"
          action={<Button onClick={() => navigate('/templates?' + new URLSearchParams({ source: 'personal', keyword: templatePendingName }).toString())}>核对我的模板</Button>} />}
        {deletion.uncertain && <Alert className="lifecycle-review-alert" type="warning" showIcon
          message={deletion.error || '删除结果未确认，请先核对当前状态。'} description={'待核对文档：' + deletion.uncertain.title}
          action={<Button loading={deletion.checking} disabled={deletion.busy} onClick={deletion.review}>核对删除结果</Button>} />}
        {deletion.error && !deletion.uncertain && <Alert type="error" showIcon message={deletion.error} />}
        {deletion.notice && <Alert className="lifecycle-review-alert" type={deletion.notice.type} showIcon message={deletion.notice.message}
          action={<Button onClick={() => navigate('/trash')}>查看回收站</Button>} />}
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
                <Link key="open" className="document-open-link" to={documentHref(doc.id, sourcePath)}>打开</Link>,
                <Dropdown key="more" trigger={['click']} autoFocus menu={{ items: [
                  { key: 'copy', label: '创建副本', onClick: () => setCopying(doc) },
                  { key: 'template', label: '保存为模板', disabled: Boolean(templatePendingName), onClick: () => setSavingTemplate(doc) },
                  ...(doc.permission === 2 ? [{ key: 'rename', label: '重命名', onClick: () => setEditing(doc) }] : []),
                  ...(doc.isOwner ? [{ key: 'members', label: '协作者管理', onClick: () => setManaging(doc) }] : []),
                ] }}>
                  <Button type="text" icon={<MoreOutlined />} disabled={loading || deletion.busy} aria-label={'更多操作：' + doc.title}>更多</Button>
                </Dropdown>,
                doc.isOwner && <Popconfirm key="delete" overlayClassName="document-action-confirm" title={`将“${doc.title}”移入回收站？`} description="协作者将停止访问，你可以在回收站恢复。"
                  disabled={deletion.blocked} onConfirm={() => deletion.run(doc)}>
                  <Button type="text" danger disabled={deletion.blocked} loading={deletion.pendingId === doc.id}>删除</Button>
                </Popconfirm>,
              ].filter(Boolean)}>
                <List.Item.Meta avatar={<FileTextOutlined className="doc-icon" />} title={<Link to={documentHref(doc.id, sourcePath)}>{doc.title}</Link>}
                  description={<Space wrap><Tag>{doc.isOwner ? '所有者' : doc.permission === 2 ? '可编辑' : '只读'}</Tag><span>{doc.ownerName + ' · ' + doc.updateTime}</span></Space>} />
              </List.Item>
            )}
          />
          {total > PAGE_SIZE && <Pagination current={page} pageSize={PAGE_SIZE} total={total} showSizeChanger={false}
            disabled={loading || deletion.busy} onChange={setPage} />}
        </Card>
      </main>
      {savingTemplate && <SavePersonalTemplateModal key={savingTemplate.id} doc={savingTemplate} onClose={() => setSavingTemplate(null)} onUncertain={setTemplatePendingName}
        onSaved={data => { message.success('已保存服务端版本 ' + data.sourceRevision + ' 的个人模板'); navigate('/templates?' + new URLSearchParams({ source: 'personal', keyword: data.name }).toString()) }}
        onReview={name => navigate('/templates?' + new URLSearchParams({ source: 'personal', keyword: name }).toString())} />}
      {showGuide && <UserGuide onClose={() => setShowGuide(false)} />}
      {copying && <CopyModal doc={copying} onClose={() => setCopying(null)}
        onCreated={data => { message.success('已创建服务端版本 ' + data.sourceRevision + ' 的副本'); navigate(documentHref(data.id, sourcePath)) }} />}
      {managing && <CollaboratorModal doc={managing} onClose={() => setManaging(null)} />}
      {importing && <ImportModal onClose={() => setImporting(false)} onCreated={id => navigate(documentHref(id, sourcePath))} />}
      {editing && <RenameModal doc={editing} onClose={() => setEditing(null)}
        onSaved={() => setRefresh(value => value + 1)} />}
    </Layout>
  )
}
