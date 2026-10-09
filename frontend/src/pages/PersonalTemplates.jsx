import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Empty, Input, Layout, List, Modal, Pagination, Popconfirm, Radio, Space, Tag, Typography } from 'antd'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import request from '../api/request'
import UserGuide from '../components/UserGuide'
import DocumentPreview from '../components/DocumentPreview'
import { templateCategories as categories } from '../templates/categories'

const SIZE = 20
export default function PersonalTemplates() {
  const [showGuide, setShowGuide] = useState(false)
  const [params, setParams] = useSearchParams()
  const location = useLocation()
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
  useEffect(() => {
    mutation.current?.abort(); mutation.current = null; setBusy(false); setSelected(null); setEditing(null)
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
        if (uncertain?.kind !== 'instance') setError('')
      }).catch(failure => { if (!controller.signal.aborted) setLoadError([400, 403, 404].includes(failure?.code) ? failure.message : '个人模板未能加载，请重试。') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [category, keyword, page, refresh])
  useEffect(() => {
    const controller = new AbortController()
    setDetail(null); setDetailError(''); setDetailLoading(Boolean(selected))
    if (selected) request.get('/personal-templates/' + selected.id, { signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) { setDetail(data); setTitle(data.name) } })
      .catch(failure => { if (!controller.signal.aborted) setDetailError([400, 403, 404].includes(failure?.code) ? failure.message : '模板内容未能加载，请重新读取。') })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false) })
    return () => controller.abort()
  }, [selected?.id, detailRefresh])
  const ready = Boolean(data && !loading && !busy && !uncertain)
  async function mutate(kind, action, onSuccess, reviewTarget) {
    if (mutation.current || !ready) return
    const controller = new AbortController(); mutation.current = controller
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await action(controller.signal)
      if (!controller.signal.aborted) onSuccess(result.data)
    } catch (failure) {
      if (!controller.signal.aborted) {
        const rejected = [400, 401, 403, 404].includes(failure?.code)
        setUncertain(rejected ? null : { kind, ...(typeof reviewTarget === 'string' ? { title: reviewTarget } : reviewTarget) })
        setError(rejected ? failure.message : kind === 'instance' ? '创建结果未确认，请核对我的文档，再决定是否重试。' : '操作结果未确认，请核对当前模板列表，再决定是否重试。')
      }
    } finally {
      if (mutation.current === controller) mutation.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const review = () => {
    if (uncertain?.kind === 'instance') navigate('/docs?' + new URLSearchParams({ scope: 'owned', keyword: uncertain.title }).toString())
    else { setSelected(null); setEditing(null); filter(uncertain?.category || 'all', uncertain?.name || ''); setRefresh(n => n + 1) }
  }
  const open = template => { setSelected(template); setEditing(null); setError('') }
  return <Layout className="app-shell">
    <header className="topbar"><Typography.Title level={4}>我的模板</Typography.Title><Space wrap>
      <Link to="/home">工作台</Link><Link to="/docs">我的文档</Link><Link to="/templates">内置模板</Link>
      <Button onClick={() => setShowGuide(true)}>使用指南</Button>
      <Button disabled={busy || loading} onClick={() => setRefresh(n => n + 1)}>刷新</Button>
    </Space></header>
    <main className="content-wrap template-center personal-template-page">
      <Typography.Title level={2}>复用自己的工作框架</Typography.Title>
      <Typography.Paragraph>在“我的文档”里选择“保存为模板”，保留已保存的内容。模板只供本人使用，使用时新建独立文档；修改资料不替换模板正文。</Typography.Paragraph>
      {loadError && <Alert type="error" showIcon message={loadError} action={<Button disabled={busy || loading} onClick={() => setRefresh(n => n + 1)}>重试读取</Button>} />}
      {error && <Alert type={uncertain ? 'warning' : 'error'} showIcon message={error}
        action={<Button disabled={busy || loading} onClick={uncertain ? review : () => setRefresh(n => n + 1)}>{uncertain?.kind === 'instance' ? '核对我的文档' : uncertain ? '核对模板列表' : '重试读取'}</Button>} />}
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
            onConfirm={() => mutate('delete', signal => request.delete('/personal-templates/' + template.id, { signal, params: { expectedVersion: template.version } }), () => { setSelected(null); setEditing(null); setNotice('模板已删除，原文档保留'); setRefresh(n => n + 1) }, { name: template.name, category: template.category })}>
            <Button disabled={!ready} danger>删除模板</Button></Popconfirm>,
        ]}><List.Item.Meta title={template.name} description={<Space wrap><Tag>{categories[template.category]}</Tag><span>{template.description || '未填写说明'}</span><span>{template.updateTime}</span></Space>} /></List.Item>} />
        {data?.total > SIZE && <Pagination current={page} total={data.total} pageSize={SIZE} showSizeChanger={false} disabled={!ready} onChange={next => filter(category, keyword, next)} />}
      </Card>
    </main>
    {selected && <Modal open title={(editing ? '修改模板资料：' : '使用模板：') + (detail?.name || selected.name)} className="personal-template-modal" width={720}
      closable={!busy} maskClosable={!busy} keyboard={!busy} onCancel={busy ? undefined : () => { setSelected(null); setEditing(null) }}
      footer={[
        <Button key="close" disabled={busy} onClick={() => { setSelected(null); setEditing(null) }}>关闭</Button>,
        uncertain && <Button key="review" disabled={busy} onClick={review}>{uncertain.kind === 'instance' ? '核对我的文档' : '核对模板列表'}</Button>,
        detail && !editing && <Button key="edit" disabled={!ready} onClick={() => setEditing({ name: detail.name, description: detail.description, category: detail.category, version: detail.version })}>修改资料</Button>,
        detail && !editing && <Button key="create" type="primary" loading={busy} disabled={!ready || !title.trim()}
          onClick={() => mutate('instance', signal => request.post('/personal-templates/' + detail.id + '/documents', { title: title.trim(), expectedVersion: detail.version }, { signal }), data => navigate('/docs/' + data.id), title.trim())}>创建文档</Button>,
        detail && editing && <Button key="save" type="primary" loading={busy} disabled={!ready || !editing.name.trim()}
          onClick={() => mutate('update', signal => request.put('/personal-templates/' + detail.id, { name: editing.name.trim(), description: editing.description.trim(), category: editing.category, expectedVersion: editing.version }, { signal }), () => { setSelected(null); setEditing(null); setNotice('模板资料已保存'); filter(editing.category, editing.name.trim()); setRefresh(n => n + 1) }, { name: editing.name.trim(), category: editing.category })}>保存资料</Button>,
      ]}>
      {error && <Alert type={uncertain ? 'warning' : 'error'} showIcon message={error} />}
      {detailError && <Alert type="error" showIcon message={detailError} />}
      <Button disabled={busy || detailLoading} onClick={() => { setEditing(null); setDetailRefresh(n => n + 1) }}>重新读取模板</Button>
      {detailLoading && <Typography.Paragraph>正在读取模板内容…</Typography.Paragraph>}
      {detail && !editing && <>
        <Typography.Paragraph>模板保留保存时的正文，不会随来源文档变化；每次使用都创建独立文档，初始内容作为版本0保留。</Typography.Paragraph>
        <Input aria-label="个人模板新文档标题" maxLength={200} value={title} disabled={busy || Boolean(uncertain)} onChange={e => setTitle(e.target.value)} />
        <DocumentPreview content={detail.content} label="个人模板预览" />
      </>}
      {detail && editing && <>
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
