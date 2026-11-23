import { useCallback, useEffect, useState } from 'react'
import { ArrowRightOutlined, CloseCircleOutlined, DeleteOutlined, FileTextOutlined, MoreOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Dropdown, Input, Layout, List, Pagination, Popconfirm, Radio, Space, Tag, Tooltip } from 'antd'
import ListEmptyState from '../components/ListEmptyState'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { documentHref } from '../navigation/documents'
import useDocumentReturnFocus from '../navigation/useDocumentReturnFocus'
import { usePageRequest } from '../auth/PageSessionContext'
import useBlankDocumentCreation from '../api/useBlankDocumentCreation'
import { requestFailureMessage } from '../api/requestError'
import useDocumentLifecycle from '../api/useDocumentLifecycle'
import DocumentLifecycleFeedback from '../components/DocumentLifecycleFeedback'
import WorkspaceHeader from '../components/WorkspaceHeader'
import WorkspacePageHeading from '../components/WorkspacePageHeading'
import SavePersonalTemplateModal from '../components/SavePersonalTemplateModal'
import CollaboratorModal from '../components/CollaboratorModal'
import ImportModal from '../components/ImportModal'
import CopyModal from '../components/CopyModal'
import RenameModal from '../components/RenameModal'
import PendingCopies from '../components/PendingCopies'
import PendingDocumentCreations from '../components/PendingDocumentCreations'

const PAGE_SIZE = 20

export default function DocList() {
  const { message } = App.useApp()
  const request = usePageRequest()
  const { creating, createBlankDocument, openCreatedDocument, creationIdentity } = useBlankDocumentCreation()
  const [managing, setManaging] = useState(null)
  const [copying, setCopying] = useState(null)
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
  const setPage = useCallback(next => setSearchParams({ ...(scope === 'all' ? {} : { scope }),
    ...(keyword ? { keyword } : {}), page: String(next) }), [scope, keyword, setSearchParams])
  useEffect(() => setFilter(keyword), [keyword])
  const applyFilter = value => setSearchParams({ ...scopeParams, ...(value.trim() ? { keyword: value.trim() } : {}) })
  const applyScope = next => setSearchParams({ ...(next === 'all' ? {} : { scope: next }), ...(keyword ? { keyword } : {}) })
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [importing, setImporting] = useState(false)
  const [savingTemplate, setSavingTemplate] = useState(null)
  const [templatePendingName, setTemplatePendingName] = useState(null)
  const [loadedFrom, setLoadedFrom] = useState(null)
  const listKey = JSON.stringify([page, keyword, scope, refresh])
  const listReady = loadedFrom === listKey && !loading && !loadError
  useDocumentReturnFocus(listReady)
  const deletion = useDocumentLifecycle({ operation: 'delete', ready: listReady,
    onConfirmed: () => setRefresh(value => value + 1) })

  useEffect(() => {
    setCopying(null); setImporting(false); setSavingTemplate(null)
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
        if (!controller.signal.aborted) { setDocs([]); setTotal(0); setLoadError(requestFailureMessage(error, '文档列表加载失败')) }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [page, keyword, scope, listKey, request, setPage])

  return (
    <Layout className="app-shell">
      <WorkspaceHeader title="我的文档" />
      <main id="workspace-main" tabIndex={-1} className="content-wrap document-library">
        <WorkspacePageHeading title="我的文档">
          <Button type="primary" icon={<PlusOutlined aria-hidden="true" />} loading={creating} onClick={createBlankDocument}>新建文档</Button>
        </WorkspacePageHeading>
        <PendingCopies onCreated={data => navigate(documentHref(data.id, sourcePath))} />
        <PendingDocumentCreations expectedIdentity={creationIdentity} disabled={creating} onCreated={openCreatedDocument} />
        <div className="document-library-toolbar">
          <Radio.Group aria-label="文档分类" value={scope} disabled={deletion.busy} onChange={event => applyScope(event.target.value)}
            options={[{ label: '全部', value: 'all' }, { label: '我创建', value: 'owned' }, { label: '与我协作', value: 'shared' }]} />
          <div className="document-library-tools">
            <Button type="text" onClick={() => setImporting(true)}>导入文档</Button>
            <Button type="text" onClick={() => navigate('/templates')}>从模板新建</Button>
            <Tooltip title="刷新文档列表"><Button type="text" icon={<ReloadOutlined aria-hidden="true" />}
              aria-label="刷新文档列表" disabled={loading || deletion.busy} onClick={() => setRefresh(value => value + 1)} /></Tooltip>
          </div>
        </div>
        <Input.Search className="search-box" aria-label="按文档标题筛选" placeholder="按标题筛选当前分类"
          maxLength={200} value={filter} disabled={deletion.busy} allowClear={{ clearIcon: <CloseCircleOutlined aria-label="清除标题输入" /> }} enterButton="筛选"
          onChange={event => setFilter(event.target.value)} onSearch={applyFilter} />
        {keyword && <div className="filter-summary"><span>标题包含“{keyword}”</span>
          <Button type="link" onClick={() => applyFilter('')}>清除筛选</Button></div>}
        {templatePendingName && <Alert type="warning" showIcon message="模板保存结果未确认，请先核对我的模板，再决定是否重试。"
          action={<Button onClick={() => navigate('/templates?' + new URLSearchParams({ source: 'personal', keyword: templatePendingName }).toString())}>核对我的模板</Button>} />}
        <DocumentLifecycleFeedback lifecycle={deletion} returnTo={sourcePath} />
        <Card className="doc-list-card" role="region" aria-label="文档列表" aria-busy={loading}>
          {loadError && <Alert type="error" showIcon message={loadError}
            action={<Button disabled={loading} onClick={() => setRefresh(value => value + 1)}>重试</Button>} />}
          <List
            rowKey="id"
            loading={{ spinning: loading, tip: '正在加载…' }}
            dataSource={docs}
            locale={{ emptyText: loadError ? '列表暂不可用' : <ListEmptyState description={keyword ? '没有匹配的标题，试试其他关键词' : scope === 'shared' ? '还没有共享给你的文档，请文档所有者添加你为协作者' : '还没有文档，先新建一篇吧'} /> }}
            renderItem={(doc) => (
              <List.Item actions={[
                <Dropdown key="more" trigger={['click']} autoFocus menu={{ items: [
                  { key: 'copy', label: '创建副本', onClick: () => setCopying(doc) },
                  { key: 'template', label: '保存为模板', disabled: Boolean(templatePendingName), onClick: () => setSavingTemplate(doc) },
                  ...(doc.permission === 2 ? [{ key: 'rename', label: '重命名', onClick: () => setEditing(doc) }] : []),
                  ...(doc.isOwner ? [{ key: 'members', label: '协作者管理', onClick: () => setManaging(doc) }] : []),
                ] }}>
                  <Button type="text" icon={<MoreOutlined aria-hidden="true" />} disabled={loading || deletion.busy}
                    aria-label={'更多操作：' + doc.title}><span className="doc-list-action-label">更多</span></Button>
                </Dropdown>,
                doc.isOwner && <Popconfirm key="delete" overlayClassName="document-action-confirm" title={`将“${doc.title}”移入回收站？`} description="协作者将停止访问，你可以在回收站恢复。"
                  disabled={deletion.blocked} onConfirm={() => deletion.run(doc)}>
                  <Button type="text" danger aria-label="删除" icon={<DeleteOutlined aria-hidden="true" />}
                    disabled={deletion.blocked} loading={deletion.pendingId === doc.id}><span className="doc-list-action-label">删除</span></Button>
                </Popconfirm>,
              ].filter(Boolean)}>
                <List.Item.Meta avatar={<FileTextOutlined className="doc-icon" aria-hidden="true" />}
                  title={<Link to={documentHref(doc.id, sourcePath)} data-document-id={doc.id}><span>{doc.title}</span><ArrowRightOutlined aria-hidden="true" /></Link>}
                  description={<div className="doc-list-metadata"><Tag>{doc.isOwner ? '所有者' : doc.permission === 2 ? '可编辑' : '只读'}</Tag>
                    <span>{typeof doc.ownerName === 'string' && doc.ownerName.trim() ? doc.ownerName
                      : Number.isSafeInteger(doc.ownerId) && doc.ownerId > 0 ? '用户 #' + doc.ownerId : '所有者暂不可用'}</span>
                    <span>{doc.updateTime}</span></div>} />
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
      {copying && <CopyModal doc={copying} onClose={() => setCopying(null)}
        onCreated={data => { message.success('已创建服务端版本 ' + data.sourceRevision + ' 的副本'); navigate(documentHref(data.id, sourcePath)) }} />}
      {managing && <CollaboratorModal doc={managing} onClose={() => setManaging(null)} />}
      {importing && <ImportModal scopeKey={location.key} expectedIdentity={creationIdentity} onClose={() => setImporting(false)} onCreated={id => navigate(documentHref(id, sourcePath))}
        onReview={title => { setImporting(false); setSearchParams({ scope: 'owned', ...(title ? { keyword: title } : {}) }); setRefresh(value => value + 1) }} />}
      {editing && <RenameModal doc={editing} onClose={() => setEditing(null)}
        onSaved={() => setRefresh(value => value + 1)} />}
    </Layout>
  )
}
