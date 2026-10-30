import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Empty, Input, Layout, List, Modal, Pagination, Popconfirm, Radio, Space, Tag, Typography } from 'antd'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { documentHref } from '../navigation/documents'
import request from '../api/request'
import createDocument, { documentCreationIdentity } from '../api/createDocument'
import WorkspaceHeader from '../components/WorkspaceHeader'
import UserGuide from '../components/UserGuide'
import DocumentPreview from '../components/DocumentPreview'
import { templateCategories as categories } from '../templates/categories'

const SIZE = 20
export default function PersonalTemplates() {
  const [showGuide, setShowGuide] = useState(false)
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const sourcePath = location.pathname + location.search + location.hash
  const creationIdentity = useRef(documentCreationIdentity())
  const navigate = useNavigate()
  const category = Object.hasOwn(categories, params.get('category')) ? params.get('category') : 'all'
  const keyword = (params.get('keyword') || '').slice(0, 200).trim()
  const rawPage = Number(params.get('page'))
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage <= 1000000 ? rawPage : 1
  const [input, setInput] = useState(keyword)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [detailRefresh, setDetailRefresh] = useState(0)
  const [editing, setEditing] = useState(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(null)
  const mutation = useRef(null)
  const instance = useRef(null)
  const selection = useRef(null)
  const detailRequest = useRef(null)
  const feedbackRef = useRef(null)
  function closeTemplate() {
    selection.current = null
    detailRequest.current?.abort(); detailRequest.current = null
    setSelected(null); setEditing(null); setDetail(null); setDetailError(''); setDetailLoading(false); setTitle('')
  }
  useEffect(() => {
    if (instance.current) {
      setUncertain({ kind: 'instance', ...instance.current })
      setError('创建结果未确认，可安全重试本次创建，或先核对我的文档。')
    }
    mutation.current?.abort(); mutation.current = null; setBusy(false); closeTemplate()
    return () => mutation.current?.abort()
  }, [location.key])
  useEffect(() => setInput(keyword), [keyword])
  const filter = (nextCategory, nextKeyword, nextPage = 1) => setParams({ source: 'personal',
    ...(nextCategory !== 'all' ? { category: nextCategory } : {}), ...(nextKeyword ? { keyword: nextKeyword } : {}),
    ...(nextPage > 1 ? { page: String(nextPage) } : {}) })
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setData(null); setLoadError('')
    request.get('/personal-templates', { params: { category, keyword, page, size: SIZE }, signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return
        const last = Math.max(1, Math.ceil(data.total / SIZE))
        if (page > last) { setParams(current => { const next = new URLSearchParams(current); next.set('page', String(last)); return next }, { replace: true }); return }
        setData(data); setUncertain(current => current?.kind === 'instance' ? current : null)
        if (!instance.current) setError('')
      }).catch(failure => { if (!controller.signal.aborted) setLoadError([400, 403, 404].includes(failure?.code) ? failure.message : '个人模板未能加载，请重试。') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [category, keyword, page, refresh])
  useEffect(() => {
    const controller = new AbortController()
    const session = selected?.session
    detailRequest.current = controller
    const current = () => !controller.signal.aborted && detailRequest.current === controller &&
      session && selection.current === session
    setDetail(null); setDetailError(''); setDetailLoading(Boolean(session && selection.current === session))
    if (session && selection.current === session) request.get('/personal-templates/' + session.templateId, { signal: controller.signal })
      .then(({ data }) => {
        if (!current()) return
        if (data?.id !== session.templateId || !Number.isSafeInteger(data.version) || data.version <= 0 ||
            typeof data.name !== 'string' || typeof data.description !== 'string' || !Object.hasOwn(categories, data.category))
          throw new Error('模板响应与当前选择不一致，请重新读取。')
        setDetail(data)
        // 仅本次打开的首次成功读取初始化标题；重读不替换用户输入或原创建目标。
        if (!session.titleInitialized) {
          session.titleInitialized = true
          if (!instance.current) setTitle(data.name)
        }
      })
      .catch(failure => { if (current()) setDetailError([400, 403, 404].includes(failure?.code) ? failure.message :
        failure.message === '模板响应与当前选择不一致，请重新读取。' ? failure.message : '模板内容未能加载，请重新读取。') })
      .finally(() => { if (current()) setDetailLoading(false) })
    return () => { controller.abort(); if (detailRequest.current === controller) detailRequest.current = null }
  }, [selected?.session, detailRefresh])
  const currentDetail = selected?.session === selection.current && detail?.id === selected?.id ? detail : null
  const detailReady = Boolean(currentDetail && !detailLoading && !detailError)
  const currentEditing = editing?.session === selected?.session && editing?.templateId === selected?.id ? editing : null
  const changedVersion = Boolean(currentEditing && currentDetail && currentEditing.version !== currentDetail.version)
  const ready = Boolean(data && !loading && !busy && !uncertain)
  useLayoutEffect(() => {
    if (error || detailError || changedVersion) {
      const body = feedbackRef.current?.closest('.ant-modal-body')
      if (body) body.scrollTop = 0
    }
  }, [error, detailError, changedVersion, selected?.session])
  async function mutate(kind, action, onSuccess, reviewTarget) {
    const confirming = kind === 'instance' && uncertain?.kind === 'instance' && instance.current
    if (mutation.current || !(kind === 'instance' ? !busy && (!uncertain || confirming) && (confirming || (data && !loading)) : ready)) return
    const controller = new AbortController(); mutation.current = controller
    if (kind === 'instance') instance.current = reviewTarget
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await action(controller.signal)
      if (!controller.signal.aborted) { instance.current = null; onSuccess(result.data) }
    } catch (failure) {
      if (!controller.signal.aborted) {
        const rejected = [400, 401, 403, 404].includes(failure?.code)
        if (rejected) instance.current = null
        setUncertain(rejected ? null : { kind, ...(typeof reviewTarget === 'string' ? { title: reviewTarget } : reviewTarget) })
        setError(rejected ? failure.message : kind === 'instance' ? '创建结果未确认，可安全重试本次创建，或先核对我的文档。' : '操作结果未确认，请核对当前模板列表，再决定是否重试。')
      }
    } finally {
      if (mutation.current === controller) mutation.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const review = () => {
    if (uncertain?.kind === 'instance') navigate('/docs?' + new URLSearchParams({ scope: 'owned', keyword: uncertain.title }).toString())
    else { closeTemplate(); filter(uncertain?.category || 'all', uncertain?.name || ''); setRefresh(n => n + 1) }
  }
  const retryInstance = () => {
    const target = instance.current
    if (!target) return
    mutate('instance', signal => createDocument('/personal-templates/' + target.templateId + '/documents',
      { title: target.title, expectedVersion: target.expectedVersion }, { signal, expectedIdentity: creationIdentity.current }),
      result => navigate(documentHref(result.id, sourcePath)), target)
  }
  const open = template => {
    detailRequest.current?.abort(); detailRequest.current = null
    const session = { templateId: template.id, titleInitialized: false }
    selection.current = session
    setSelected({ ...template, session }); setEditing(null); setDetail(null); setDetailError(''); setDetailLoading(true); setTitle(''); setError('')
  }
  const reread = () => {
    if (busy || detailLoading || selection.current !== selected?.session) return
    detailRequest.current?.abort(); detailRequest.current = null
    setDetail(null); setDetailError(''); setDetailLoading(true); setDetailRefresh(n => n + 1)
  }
  return <Layout className="app-shell">
    <WorkspaceHeader title="我的模板" onGuide={() => setShowGuide(true)}><Space wrap>
      <Button onClick={() => navigate('/templates')}>内置模板</Button>
      <Button disabled={busy || loading} onClick={() => setRefresh(n => n + 1)}>刷新</Button>
    </Space></WorkspaceHeader>
    <main id="workspace-main" tabIndex={-1} className="content-wrap template-center personal-template-page">
      <Typography.Title level={2}>复用自己的工作框架</Typography.Title>
      <Typography.Paragraph>在编辑器“更多”选择“保存为个人模板”，也可从“我的文档”保存。模板只供本人使用，使用时新建独立文档；修改资料不替换模板正文。</Typography.Paragraph>
      {loadError && <Alert type="error" showIcon message={loadError} action={<Button disabled={busy || loading} onClick={() => setRefresh(n => n + 1)}>重试读取</Button>} />}
      {error && <Alert className="creation-review-alert" type={uncertain ? 'warning' : 'error'} showIcon message={error}
        description={uncertain?.kind === 'instance' ? '待确认文档：' + uncertain.title : undefined}
        action={<Space wrap>
          {uncertain?.kind === 'instance' && !selected && <Button disabled={busy} loading={busy} onClick={retryInstance}>重试本次创建</Button>}
          <Button disabled={busy || loading} onClick={uncertain ? review : () => setRefresh(n => n + 1)}>{uncertain?.kind === 'instance' ? '核对我的文档' : uncertain ? '核对模板列表' : '重试读取'}</Button>
        </Space>} />}
      {notice && <Alert type="success" showIcon message={notice} />}
      {data && <Typography.Paragraph type="secondary">已保存 {data.usage.count} / {data.countLimit} 份 · 模板正文 {(data.usage.bytes / 1024 / 1024).toFixed(2)} / {(data.byteLimit / 1024 / 1024).toFixed(0)} MiB</Typography.Paragraph>}
      <Radio.Group className="template-filters" aria-label="个人模板分类" value={category} disabled={busy}
        options={[{ value: 'all', label: '全部' }, ...Object.entries(categories).map(([value, label]) => ({ value, label }))]} onChange={e => filter(e.target.value, keyword)} />
      <Input.Search aria-label="筛选个人模板" value={input} maxLength={200} disabled={busy} placeholder="搜索模板名称或说明"
        onChange={e => setInput(e.target.value)} onSearch={value => filter(category, value.trim())} enterButton="筛选" />
      {(category !== 'all' || keyword) && <Button className="template-filters" disabled={busy} onClick={() => filter('all', '')}>清除筛选</Button>}
      <Card title="个人模板" className="template-filters"><List rowKey="id" loading={loading} dataSource={data?.list || []}
        locale={{ emptyText: loading ? '正在加载…' : !data ? '列表暂不可用' : <Empty description={keyword || category !== 'all' ? '没有匹配的个人模板' : '还没有个人模板，先从一篇已保存的文档开始'} /> }}
        renderItem={template => <List.Item actions={[
          <Button key="open" disabled={!ready} onClick={() => open(template)}>预览并使用</Button>,
          <Popconfirm key="delete" overlayClassName="document-action-confirm" title={'删除模板“' + template.name + '”？'}
            description="删除后无法恢复此模板，并释放模板容量；来源及已创建的文档保留。" disabled={!ready}
            onConfirm={() => mutate('delete', signal => request.delete('/personal-templates/' + template.id, { signal, params: { expectedVersion: template.version } }), () => { closeTemplate(); setNotice('模板已删除，原文档保留'); setRefresh(n => n + 1) }, { name: template.name, category: template.category })}>
            <Button disabled={!ready} danger>删除模板</Button></Popconfirm>,
        ]}><List.Item.Meta title={template.name} description={<Space wrap><Tag>{categories[template.category]}</Tag><span>{template.description || '未填写说明'}</span><span>{template.updateTime}</span></Space>} /></List.Item>} />
        {data?.total > SIZE && <Pagination current={page} total={data.total} pageSize={SIZE} showSizeChanger={false} disabled={!ready} onChange={next => filter(category, keyword, next)} />}
      </Card>
    </main>
    {selected && <Modal open title={(currentEditing ? '修改模板资料：' : '使用模板：') + (currentDetail?.name || selected.name)} className="personal-template-modal" width={720}
      closable={!busy} maskClosable={!busy} keyboard={!busy} onCancel={busy ? undefined : closeTemplate}
      footer={[
        <Button key="close" disabled={busy} onClick={closeTemplate}>关闭</Button>,
        uncertain && <Button key="review" disabled={busy} onClick={review}>{uncertain.kind === 'instance' ? '核对我的文档' : '核对模板列表'}</Button>,
        currentDetail && !currentEditing && <Button key="edit" disabled={!ready || !detailReady} onClick={() => {
          if (!detailReady || !ready || selection.current !== selected.session) return
          setEditing({ templateId: currentDetail.id, session: selected.session, name: currentDetail.name,
            description: currentDetail.description, category: currentDetail.category, version: currentDetail.version })
        }}>修改资料</Button>,
        currentDetail && !currentEditing && <Button key="create" type="primary" loading={busy} disabled={!detailReady || !data || loading || busy || (uncertain && uncertain.kind !== 'instance') || !title.trim()}
          onClick={() => {
            if (!detailReady || selection.current !== selected.session) return
            const target = instance.current || { templateId: currentDetail.id, title: title.trim(), expectedVersion: currentDetail.version }
            mutate('instance', signal => createDocument('/personal-templates/' + target.templateId + '/documents',
              { title: target.title, expectedVersion: target.expectedVersion }, { signal, expectedIdentity: creationIdentity.current }), data => navigate(documentHref(data.id, sourcePath)), target)
          }}>{uncertain?.kind === 'instance' ? '重试本次创建' : '创建文档'}</Button>,
        currentEditing && <Button key="save" type="primary" loading={busy} disabled={!ready || !detailReady || changedVersion || !currentEditing.name.trim()}
          onClick={() => {
            if (!ready || !detailReady || changedVersion || selection.current !== currentEditing.session) return
            const draft = currentEditing
            mutate('update', signal => request.put('/personal-templates/' + draft.templateId, { name: draft.name.trim(), description: draft.description.trim(), category: draft.category, expectedVersion: draft.version }, { signal }), () => { closeTemplate(); setNotice('模板资料已保存'); filter(draft.category, draft.name.trim()); setRefresh(n => n + 1) }, { name: draft.name.trim(), category: draft.category })
          }}>保存资料</Button>,
      ]}>
      <div ref={feedbackRef} />
      {error && <Alert type={uncertain ? 'warning' : 'error'} showIcon message={error} />}
      {detailError && <Alert className="template-detail-notice" type="error" showIcon message={detailError} />}
      <Button disabled={busy || detailLoading} onClick={reread}>重新读取模板</Button>
      {changedVersion && <Alert className="template-detail-notice" type="warning" showIcon message="模板资料已变化，当前修改仍保留。请先复制要保留的输入，再关闭并重新打开模板，按最新资料修改。" />}
      {detailLoading && <Typography.Paragraph>正在读取模板内容…</Typography.Paragraph>}
      {!currentEditing && selected.session.titleInitialized && <>
        <Typography.Paragraph>模板保留保存时的正文，不会随来源文档变化；每次使用都创建独立文档，初始内容作为版本0保留。</Typography.Paragraph>
        <Input aria-label="个人模板新文档标题" maxLength={200} value={title} disabled={busy || Boolean(uncertain)} onChange={e => setTitle(e.target.value)} />
        {currentDetail && <DocumentPreview content={currentDetail.content} label="个人模板预览" />}
      </>}
      {currentEditing && <>
        <Typography.Paragraph>修改名称、用途和说明；模板正文保持不变。</Typography.Paragraph>
        <Input aria-label="修改个人模板名称" maxLength={200} value={editing.name} disabled={busy || Boolean(uncertain)} onChange={e => setEditing(current => ({ ...current, name: e.target.value }))} />
        <Radio.Group className="template-filters" aria-label="修改个人模板用途" value={editing.category} disabled={busy || Boolean(uncertain)}
          options={Object.entries(categories).map(([value, label]) => ({ value, label }))} onChange={e => setEditing(current => ({ ...current, category: e.target.value }))} />
        <Input.TextArea aria-label="修改个人模板说明" maxLength={300} rows={3} showCount value={editing.description} disabled={busy || Boolean(uncertain)} onChange={e => setEditing(current => ({ ...current, description: e.target.value }))} />
      </>}
    </Modal>}
    {showGuide && <UserGuide initialSection="templates" onClose={() => setShowGuide(false)} />}
  </Layout>
}
