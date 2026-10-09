import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Empty, Input, Layout, List, Modal, Pagination, Popconfirm, Radio, Space, Tag, Typography } from 'antd'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import request from '../api/request'
import UserGuide from '../components/UserGuide'
import ProjectDocumentsModal from '../components/ProjectDocumentsModal'

const idValue = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0
const SIZE = 20
function Fields({ value, context, busy, uncertain, error, onSave, onClose, onReview }) {
  const [name, setName] = useState(value.name || '')
  const [description, setDescription] = useState(value.description || '')
  const [groupId, setGroupId] = useState(value.groupId || 0)
  return <Modal open title={value.id ? '修改项目资料' : '创建项目'} closable={!busy} maskClosable={!busy} keyboard={!busy}
    onCancel={busy ? undefined : onClose} footer={[
      <Button key="close" disabled={busy} onClick={onClose}>取消</Button>,
      uncertain && <Button key="review" disabled={busy} onClick={() => onReview({ groupId, name: name.trim() })}>核对项目列表</Button>,
      <Button key="save" type="primary" disabled={uncertain || !name.trim()} loading={busy}
        onClick={() => onSave({ name: name.trim(), description: description.trim(), groupId })}>{value.id ? '保存项目' : '创建项目'}</Button>,
    ]}>
    {error && <Alert type="error" showIcon message={error} />}
    <Typography.Paragraph>项目用于分类和整理，文档仍单独授权。</Typography.Paragraph>
    {!value.id ? <Radio.Group aria-label="项目归属" value={groupId} disabled={busy} onChange={e => setGroupId(e.target.value)}>
      <Radio value={0}>个人项目</Radio>{context && ['owner', 'admin'].includes(context.role) &&
        <Radio value={context.id}>小组：{context.name}</Radio>}
    </Radio.Group> : <Typography.Paragraph>{value.groupId ? '小组：' + value.groupName : '个人项目'}</Typography.Paragraph>}
    {!value.id && !context && <Typography.Paragraph type="secondary">需要小组项目时，请从“我的小组”打开该小组的项目入口。</Typography.Paragraph>}
    <Typography.Paragraph>项目名称</Typography.Paragraph>
    <Input aria-label="项目名称" maxLength={80} autoFocus disabled={busy} value={name} onChange={e => setName(e.target.value)} />
    <Typography.Paragraph style={{ marginTop: 12 }}>项目简介</Typography.Paragraph>
    <Input.TextArea aria-label="项目简介" maxLength={300} showCount rows={3} disabled={busy}
      value={description} onChange={e => setDescription(e.target.value)} />
  </Modal>
}

export default function Projects() {
  const [showGuide, setShowGuide] = useState(false)
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const selected = idValue(params.get('project'))
  const groupId = idValue(params.get('groupId'))
  const page = Math.min(idValue(params.get('page')) || 1, 1000000)
  const scope = ['personal', 'group'].includes(params.get('scope')) ? params.get('scope') : 'all'
  const archived = params.get('archived') === 'true'
  const keyword = (params.get('keyword') || '').slice(0, 200).trim()
  const [input, setInput] = useState(keyword)
  const [data, setData] = useState(null)
  const [context, setContext] = useState(null)
  const [detail, setDetail] = useState(null)
  const [docPage, setDocPage] = useState(1)
  const [docKeyword, setDocKeyword] = useState('')
  const [docInput, setDocInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [fields, setFields] = useState(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const mutation = useRef(null)
  const preserveNotice = useRef(false)
  useEffect(() => {
    mutation.current?.abort(); mutation.current = null; setBusy(false)
    setFields(null); setAdding(false); setUncertain(false)
    if (!preserveNotice.current) setNotice('')
    preserveNotice.current = false
    return () => mutation.current?.abort()
  }, [location.key])
  useEffect(() => setInput(keyword), [keyword])
  useEffect(() => { setDocPage(1); setDocKeyword(''); setDocInput('') }, [selected])
  const navigate = (changes, keepNotice = false) => {
    preserveNotice.current = keepNotice
    const next = { ...(scope === 'all' ? {} : { scope }), ...(groupId ? { groupId: String(groupId) } : {}),
      ...(archived ? { archived: 'true' } : {}), ...(keyword ? { keyword } : {}), page: String(page), ...(selected ? { project: String(selected) } : {}), ...changes }
    for (const key of Object.keys(next)) if (next[key] === null || next[key] === '') delete next[key]
    setParams(next)
  }
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setData(null); setContext(null); setError('')
    Promise.all([
      request.get('/projects', { params: { scope, groupId, archived, keyword, page, size: SIZE }, signal: controller.signal }),
      groupId ? request.get('/groups/' + groupId, { signal: controller.signal }) : Promise.resolve({ data: null }),
    ]).then(([response, group]) => {
      if (controller.signal.aborted) return
      const last = Math.max(1, Math.ceil(response.data.total / SIZE))
      if (page > last) { setParams(current => { const next = new URLSearchParams(current); next.set('page', String(last)); return next }, { replace: true }); return }
      setData(response.data); setContext(group.data); setUncertain(false)
    }).catch(failure => { if (!controller.signal.aborted) setError([400, 403, 404].includes(failure?.code)
      ? failure.message : '项目列表未能加载，请刷新重试。') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [scope, groupId, archived, keyword, page, refresh])
  useEffect(() => {
    const controller = new AbortController()
    setDetail(null); setDetailError(''); setDetailLoading(Boolean(selected && !archived))
    if (selected && !archived) request.get('/projects/' + selected,
      { params: { page: docPage, size: SIZE, keyword: docKeyword }, signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return
        const last = Math.max(1, Math.ceil(data.total / SIZE))
        if (docPage > last) { setDocPage(last); return }
        setDetail(data)
      }).catch(failure => { if (!controller.signal.aborted) setDetailError([400, 403, 404].includes(failure?.code)
        ? failure.message : '项目文档未能加载，请刷新重试。') })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false) })
    return () => controller.abort()
  }, [selected, archived, docPage, docKeyword, refresh])
  const ready = Boolean(data && !loading && !busy && !uncertain)
  const current = detail?.id === selected ? detail : null
  const manage = current?.canManage
  const hasGroupContext = Boolean(groupId && context?.id === groupId)
  const canCreateGroup = hasGroupContext && ['owner', 'admin'].includes(context.role)
  const chooseGroup = scope === 'group' && !groupId
  const emptyDescription = keyword ? '没有匹配的项目' : archived ? '暂无归档项目'
    : chooseGroup ? '还没有小组项目，先选择小组再创建'
      : hasGroupContext ? canCreateGroup ? '还没有小组项目，可以创建一个整理本组资料' : '暂无小组项目，可请创建者或管理员创建'
        : scope === 'personal' ? '还没有个人项目，可以先创建一个' : '创建个人项目，或从小组入口创建小组项目'
  useEffect(() => { if (fields?.id && !manage) setFields(null) }, [manage, fields?.id])
  async function mutate(action, label, onSuccess) {
    if (mutation.current || !ready) return
    const controller = new AbortController(); mutation.current = controller
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await action(controller.signal)
      if (controller.signal.aborted) return
      setNotice(label); onSuccess?.(response.data); setRefresh(n => n + 1)
    } catch (failure) {
      if (!controller.signal.aborted) {
        const rejected = [400, 401, 403, 404].includes(failure?.code)
        setUncertain(!rejected)
        setError(rejected ? failure.message : '操作结果未确认，请刷新核对项目或文档关联，再决定是否重试。')
      }
    } finally {
      if (mutation.current === controller) mutation.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const review = values => {
    const creating = fields && !fields.id
    setFields(null); setAdding(false)
    if (creating) setParams({ scope: values.groupId ? 'group' : 'personal', ...(values.groupId ? { groupId: String(values.groupId) } : {}), keyword: values.name, page: '1' })
    else navigate({ page: '1' })
    setRefresh(n => n + 1)
  }
  return <Layout className="app-shell">
    <header className="topbar"><Typography.Title level={4}>我的项目</Typography.Title><Space wrap>
      <Link to="/home">工作台</Link><Link to="/docs">我的文档</Link><Link to="/groups">我的小组</Link>
      <Button onClick={() => setShowGuide(true)}>使用指南</Button>
      <Button disabled={loading || busy} onClick={() => setRefresh(n => n + 1)}>刷新</Button>
      {chooseGroup ? <Link className="ant-btn ant-btn-primary" to="/groups">选择小组创建项目</Link>
        : <Button type="primary" disabled={!ready} onClick={() => { setError(''); setFields({ groupId: canCreateGroup ? context.id : 0 }) }}>
          {canCreateGroup ? '创建小组项目' : '创建个人项目'}</Button>}
    </Space></header>
    <main className="content-wrap project-page">
      <Typography.Title level={2}>{context ? context.name + '的项目' : '把资料整理成项目'}</Typography.Title>
      <Typography.Paragraph type="secondary">整理个人或小组工作，关联保留同一份原文档。项目内只显示你有权限访问的资料。</Typography.Paragraph>
      {chooseGroup && <Typography.Paragraph>先选择需要整理资料的小组，再由创建者或管理员创建小组项目。</Typography.Paragraph>}
      {groupId > 0 && <Button onClick={() => setParams({})}>查看全部项目</Button>}
      {error && <Alert type="error" showIcon message={error} />}
      {notice && <Alert type="success" showIcon message={notice} />}
      <Space wrap className="project-section">
        <Radio.Group aria-label="项目分类" value={scope} disabled={busy} options={[
          { label: '全部', value: 'all' }, { label: '个人', value: 'personal' }, { label: '小组', value: 'group' },
        ]} onChange={e => navigate({ scope: e.target.value === 'all' ? null : e.target.value, groupId: null, project: null, page: '1' })} />
        <Radio.Group aria-label="项目状态" value={archived} disabled={busy} options={[
          { label: '进行中', value: false }, { label: '已归档', value: true },
        ]} onChange={e => navigate({ archived: e.target.value ? 'true' : null, project: null, page: '1' })} />
      </Space>
      <Input.Search aria-label="筛选项目名称" maxLength={200} value={input} disabled={busy} placeholder="按项目名称筛选"
        onChange={e => setInput(e.target.value)} onSearch={value => navigate({ keyword: value.trim() || null, project: null, page: '1' })} enterButton="筛选" />
      <Card title="项目列表" className="project-section">
        <List rowKey="id" loading={loading} dataSource={data?.list || []}
          locale={{ emptyText: loading ? '正在加载…' : !data ? '列表暂不可用' : <Empty description={emptyDescription} /> }}
          renderItem={project => <List.Item actions={archived ? project.canManage ? [
            <Popconfirm key="restore" overlayClassName="document-action-confirm" title={'恢复“' + project.name + '”？'}
              description="恢复项目与原关联，文档继续按当前权限访问。" disabled={!ready} onConfirm={() => mutate(signal =>
                request.post('/projects/' + project.id + '/restore', {}, { signal }), '项目已恢复')}>
              <Button disabled={!ready}>恢复项目</Button></Popconfirm>,
          ] : [] : [<Button key="open" disabled={!ready} onClick={() => navigate({ project: String(project.id) })}>查看项目</Button>]}>
            <List.Item.Meta title={project.name} description={<Space wrap><Tag>{project.groupId ? '小组：' + project.groupName : '个人项目'}</Tag>
              <span>{project.visibleDocumentCount} 篇可访问文档</span><span>{project.description || '尚未填写简介'}</span></Space>} />
          </List.Item>} />
        {data?.total > SIZE && <Pagination current={page} total={data.total} pageSize={SIZE} showSizeChanger={false}
          disabled={!ready} onChange={next => navigate({ page: String(next) })} />}
      </Card>
      {selected > 0 && !archived && <Card key={selected} title={current?.name || '项目资料'} loading={detailLoading} className="project-section">
        {detailError && <Alert type="error" showIcon message={detailError} />}
        {current && <>
          <Typography.Paragraph>{current.description || '尚未填写简介'}</Typography.Paragraph>
          <Typography.Paragraph>{current.total} 篇你可访问的文档 · {current.groupId ? '小组：' + current.groupName : '个人项目'}</Typography.Paragraph>
          <Space wrap className="project-section"><Button disabled={!ready} onClick={() => setAdding(true)}>加入已有文档</Button>
            {manage && <Button disabled={!ready} onClick={() => { setError(''); setFields(current) }}>修改项目资料</Button>}
            {manage && <Popconfirm overlayClassName="document-action-confirm" title={'归档“' + current.name + '”？'}
              description="保留原文档、单独权限及项目关联，可在已归档列表恢复。" disabled={!ready}
              onConfirm={() => mutate(signal => request.post('/projects/' + current.id + '/archive', {}, { signal }), '项目已归档', () => navigate({ project: null }, true))}>
              <Button disabled={!ready} danger>归档项目</Button></Popconfirm>}
          </Space>
          <Input.Search aria-label="筛选项目内文档" value={docInput} maxLength={200} disabled={busy} placeholder="按文档标题筛选"
            onChange={e => setDocInput(e.target.value)} onSearch={value => { setDocKeyword(value.trim()); setDocPage(1) }} enterButton="筛选" />
          <List rowKey="id" dataSource={current.list} locale={{ emptyText: <Empty description="没有符合条件且可访问的文档" /> }}
            renderItem={doc => <List.Item actions={[
              <Link key="open" to={'/docs/' + doc.id}>打开</Link>,
              doc.canRemove && <Popconfirm key="remove" overlayClassName="document-action-confirm" title={'将“' + doc.title + '”移出项目？'}
                description="只移除当前关联，保留原文档和成员权限。" disabled={!ready} onConfirm={() => mutate(signal =>
                  request.delete('/projects/' + current.id + '/documents/' + doc.id, { signal, params: { associationId: doc.associationId } }), '已移出项目')}>
                <Button disabled={!ready} danger>移出项目</Button></Popconfirm>,
            ].filter(Boolean)}><List.Item.Meta title={<Link to={'/docs/' + doc.id}>{doc.title}</Link>}
              description={<Space wrap><Tag>{doc.permission === 2 ? '可编辑' : '只读'}</Tag><span>{doc.ownerName + ' · ' + doc.updateTime}</span></Space>} />
            </List.Item>} />
          {current.total > SIZE && <Pagination current={docPage} total={current.total} pageSize={SIZE} showSizeChanger={false}
            disabled={!ready} onChange={setDocPage} />}
        </>}
      </Card>}
    </main>
    {fields && <Fields key={fields.id || 'create'} value={fields} context={hasGroupContext ? context : null} busy={busy} uncertain={uncertain} error={error}
      onClose={() => { if (!busy) setFields(null) }} onReview={review}
      onSave={values => mutate(signal => fields.id ? request.put('/projects/' + fields.id, { name: values.name, description: values.description }, { signal }) :
        request.post('/projects', values, { signal }), fields.id ? '项目资料已保存' : '项目已创建', result => {
          setFields(null); if (!fields.id) { preserveNotice.current = true; setParams({ project: String(result.id), ...(result.groupId ? { groupId: String(result.groupId), scope: 'group' } : { scope: 'personal' }) }) }
        })} />}
    {adding && current && <ProjectDocumentsModal key={current.id} project={current} onClose={() => setAdding(false)}
      onReview={() => { setAdding(false); setRefresh(n => n + 1) }}
      onAdded={changed => { setAdding(false); setNotice(changed ? '文档已加入项目' : '文档已在项目中'); setRefresh(n => n + 1) }} />}
    {showGuide && <UserGuide initialSection="projects" onClose={() => setShowGuide(false)} />}
  </Layout>
}
