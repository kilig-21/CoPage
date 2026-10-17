import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Empty, Input, Layout, List, Modal, Pagination, Popconfirm, Radio, Space, Tag, Typography } from 'antd'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { documentHref } from '../navigation/documents'
import request from '../api/request'
import WorkspaceHeader from '../components/WorkspaceHeader'
import UserGuide from '../components/UserGuide'
import ProjectDocumentsModal from '../components/ProjectDocumentsModal'
import useProjectOperation from '../api/useProjectOperation'
import useProjectCreations from '../api/useProjectCreations'
import CreateProjectDocumentModal from '../components/CreateProjectDocumentModal'
import PendingProjectDocuments from '../components/PendingProjectDocuments'
import WorkspaceDetailCard from '../components/WorkspaceDetailCard'
import '../styles/project-workspace.css'

const idValue = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0
const SIZE = 20
function Fields({ value, context, ready, busy, uncertain, error, notice, onSave, onClose, onReview, onRetry }) {
  const [name, setName] = useState(value.name || '')
  const [description, setDescription] = useState(value.description || '')
  const [groupId, setGroupId] = useState(value.groupId || 0)
  return <Modal open title={value.id ? '修改项目资料' : '创建项目'} closable={!busy} maskClosable={!busy} keyboard={!busy}
    onCancel={busy ? undefined : onClose} footer={[
      <Button key="close" disabled={busy} onClick={onClose}>取消</Button>,
      uncertain && <Button key="review" disabled={busy} onClick={onReview}>{value.id ? '核对操作结果' : '确认原创建'}</Button>,
      <Button key="save" type="primary" disabled={!ready || uncertain || !name.trim() || (!value.id && groupId > 0 &&
        !(context?.id === groupId && ['owner', 'admin'].includes(context.role)))} loading={busy}
        onClick={() => onSave({ name: name.trim(), description: description.trim(), groupId })}>{value.id ? '保存项目' : '创建项目'}</Button>,
    ]}>
    {error && <Alert className="project-read-alert" type="error" showIcon message={error}
      action={!ready && !busy && !uncertain && <Button onClick={onRetry}>重试所需资料</Button>} />}
    {notice?.type === 'info' && <Alert className="project-read-alert" type="info" showIcon message={notice.message} />}
    {!ready && !busy && !uncertain && <Typography.Paragraph role="status">所需资料尚未就绪，输入已保留；恢复读取后再保存。</Typography.Paragraph>}
    <Typography.Paragraph>项目用于分类和整理，文档仍单独授权。</Typography.Paragraph>
    {!value.id ? <Radio.Group aria-label="项目归属" value={groupId} disabled={busy || !ready} onChange={e => setGroupId(e.target.value)}>
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
  const goTo = useNavigate()
  const [showGuide, setShowGuide] = useState(false)
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const sourcePath = location.pathname + location.search + location.hash
  const selected = idValue(params.get('project'))
  const [detailArrival, setDetailArrival] = useState(0)
  const groupId = idValue(params.get('groupId'))
  const page = Math.min(idValue(params.get('page')) || 1, 1000000)
  const scope = ['personal', 'group'].includes(params.get('scope')) ? params.get('scope') : 'all'
  const archived = params.get('archived') === 'true'
  const keyword = (params.get('keyword') || '').slice(0, 200).trim()
  const [input, setInput] = useState(keyword)
  const [data, setData] = useState(null)
  const [dataFrom, setDataFrom] = useState('')
  const [context, setContext] = useState(null)
  const [contextFrom, setContextFrom] = useState('')
  const [contextLoading, setContextLoading] = useState(false)
  const [contextError, setContextError] = useState('')
  const [contextRefresh, setContextRefresh] = useState(0)
  const [detail, setDetail] = useState(null)
  const [detailFrom, setDetailFrom] = useState('')
  const [detailSettledFrom, setDetailSettledFrom] = useState('')
  const docPage = Math.min(idValue(params.get('docPage')) || 1, 1000000)
  const docKeyword = (params.get('docKeyword') || '').slice(0, 200).trim()
  const [docInput, setDocInput] = useState(docKeyword)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [detailErrorCode, setDetailErrorCode] = useState(null)
  const [refresh, setRefresh] = useState(0)
  const [listRefresh, setListRefresh] = useState(0)
  const [detailRefresh, setDetailRefresh] = useState(0)
  const [fields, setFields] = useState(null)
  const [adding, setAdding] = useState(false)
  const [newDocument, setNewDocument] = useState(null)
  const [documentBusy, setDocumentBusy] = useState(false)
  const operation = useProjectOperation(target => {
    setRefresh(value => value + 1)
    if (target.kind === 'add') setAdding(false)
  })
  const busy = operation.busy || documentBusy
  const uncertain = Boolean(operation.uncertain)
  const operationError = operation.error
  const creations = useProjectCreations(busy)
  const automaticPageChange = useRef(null)
  const waitingConfirmation = useRef(null)
  const listKey = JSON.stringify([scope, groupId, archived, keyword, page, refresh, listRefresh])
  const contextKey = JSON.stringify([groupId, contextRefresh])
  const detailKey = JSON.stringify([selected, archived, docPage, docKeyword, refresh, detailRefresh])
  const routeTargetKey = JSON.stringify([scope, groupId, archived, keyword, selected, docKeyword])
  useEffect(() => {
    const keepWork = automaticPageChange.current?.path === sourcePath && automaticPageChange.current?.target === routeTargetKey
    automaticPageChange.current = null
    // 自动纠正分页不改变所选项目，保留其表单、原目标和写等待。
    if (keepWork) return () => { if (!automaticPageChange.current) operation.cancel() }
    operation.cancel()
    setFields(null); setAdding(false); setNewDocument(null); setDocumentBusy(false)
    return () => { if (!automaticPageChange.current) operation.cancel() }
  }, [location.key])
  useEffect(() => setInput(keyword), [keyword])
  useEffect(() => setDocInput(docKeyword), [docKeyword])
  const navigate = changes => {
    automaticPageChange.current = null
    const next = { ...(scope === 'all' ? {} : { scope }), ...(groupId ? { groupId: String(groupId) } : {}),
      ...(archived ? { archived: 'true' } : {}), ...(keyword ? { keyword } : {}), page: String(page), ...(selected ? { project: String(selected) } : {}),
      ...(docPage > 1 ? { docPage: String(docPage) } : {}), ...(docKeyword ? { docKeyword } : {}), ...changes }
    if (Object.hasOwn(changes, 'project') && idValue(changes.project) !== selected) {
      delete next.docPage; delete next.docKeyword
    }
    for (const key of Object.keys(next)) if (next[key] === null || next[key] === '') delete next[key]
    setParams(next)
  }
  const correctPage = (current, name, value) => {
    const next = new URLSearchParams(current)
    next.set(name, String(value))
    // setSearchParams 的实际跳转只含查询参数，会清除原 hash。
    automaticPageChange.current = { path: location.pathname + '?' + next.toString(), target: routeTargetKey }
    return next
  }
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setData(null); setError('')
    request.get('/projects', { params: { scope, groupId, archived, keyword, page, size: SIZE }, signal: controller.signal }).then(response => {
      if (controller.signal.aborted) return
      const last = Math.max(1, Math.ceil(response.data.total / SIZE))
      if (page > last) { setParams(current => correctPage(current, 'page', last), { replace: true }); return }
      setData(response.data); setDataFrom(listKey)
    }).catch(failure => { if (!controller.signal.aborted) setError([400, 403, 404].includes(failure?.code)
      ? failure.message : '项目列表未能加载，请刷新重试。') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [scope, groupId, archived, keyword, page, refresh, listRefresh])
  useEffect(() => {
    const controller = new AbortController()
    setContext(null); setContextError(''); setContextLoading(Boolean(groupId))
    if (groupId) request.get('/groups/' + groupId, { signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return
        if (data?.id !== groupId) throw new Error('小组资料响应不匹配')
        setContext(data); setContextFrom(contextKey)
      })
      .catch(failure => { if (!controller.signal.aborted) setContextError([400, 401, 403, 404].includes(failure?.code)
        ? failure.message : '小组资料暂时无法加载，已读取的项目仍可继续查看；创建需先核对小组资料。') })
      .finally(() => { if (!controller.signal.aborted) setContextLoading(false) })
    return () => controller.abort()
  }, [groupId, contextRefresh])
  useEffect(() => {
    const controller = new AbortController()
    setDetail(null); setDetailError(''); setDetailErrorCode(null); setDetailLoading(Boolean(selected && !archived))
    if (selected && !archived) request.get('/projects/' + selected,
      { params: { page: docPage, size: SIZE, keyword: docKeyword }, signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return
        const last = Math.max(1, Math.ceil(data.total / SIZE))
        if (docPage > last) {
          setParams(current => correctPage(current, 'docPage', last), { replace: true })
          return
        }
        if (data?.id !== selected) throw new Error('项目资料响应不匹配')
        setDetail(data); setDetailFrom(detailKey)
      }).catch(failure => { if (!controller.signal.aborted) {
        setDetailErrorCode(failure?.code)
        setDetailError([400, 401, 403, 404].includes(failure?.code) ? failure.message : '项目文档未能加载，请刷新重试。')
      } })
      .finally(() => { if (!controller.signal.aborted) { setDetailLoading(false); setDetailSettledFrom(detailKey) } })
    return () => controller.abort()
  }, [selected, archived, docPage, docKeyword, refresh, detailRefresh])
  const listed = dataFrom === listKey ? data : null
  const ready = Boolean(listed && !loading && !busy && !uncertain)
  const current = detailFrom === detailKey && detail?.id === selected ? detail : null
  const manage = current?.canManage
  const hasGroupContext = Boolean(groupId && contextFrom === contextKey && context?.id === groupId)
  const canCreateGroup = hasGroupContext && ['owner', 'admin'].includes(context.role)
  const createReady = ready && (!groupId || (hasGroupContext && !contextLoading))
  const detailReady = Boolean(current && !detailLoading && !busy && !uncertain)
  const chooseGroup = scope === 'group' && !groupId
  const emptyDescription = keyword ? '没有匹配的项目' : archived ? '暂无归档项目'
    : chooseGroup ? '还没有小组项目，先选择小组再创建'
      : hasGroupContext ? canCreateGroup ? '还没有小组项目，可以创建一个整理本组资料' : '暂无小组项目，可请创建者或管理员创建'
        : scope === 'personal' ? '还没有个人项目，可以先创建一个' : '创建个人项目，或从小组入口创建小组项目'
  useEffect(() => {
    if (fields?.id && ((current && !manage) || (!detailLoading && [401, 403, 404].includes(detailErrorCode)))) setFields(null)
  }, [current, manage, detailLoading, detailErrorCode, fields?.id])
  const mutate = (target, action, onSuccess, available = detailReady) => {
    if (available) return operation.run(target, action, onSuccess)
  }
  const openCreated = result => {
    setDetailArrival(n => n + 1)
    setFields(null)
    setParams({ project: String(result.id), ...(result.groupId ? { groupId: String(result.groupId), scope: 'group' } : { scope: 'personal' }) })
  }
  const openProjectDocument = result => {
    const origin = selected === result.projectId && !archived ? sourcePath : '/projects?project=' + result.projectId
    goTo(documentHref(result.id, origin))
    setNewDocument(null)
  }
  const confirmCreation = record => operation.run({ kind: 'create', name: record.name, groupId: record.groupId, requestId: record.requestId },
    (config, prepared) => creations.retry(record, config, prepared), openCreated, { retryCreation: true, trackedCreation: true })
  const review = async () => {
    if (operation.uncertain?.kind === 'create') {
      const original = operation.uncertain
      const record = creations.records?.find(value => value.requestId === original.requestId)
      if (record) await confirmCreation(record)
      else creations.reportMissing()
    } else await operation.review()
  }
  return <Layout className="app-shell">
    <WorkspaceHeader title="我的项目" onGuide={() => setShowGuide(true)}><Space wrap>
      <Button disabled={loading || busy} onClick={() => { setRefresh(n => n + 1); setContextRefresh(n => n + 1) }}>刷新</Button>
      {chooseGroup ? <Button type="primary" onClick={() => goTo('/groups')}>选择小组创建项目</Button>
        : <Button type="primary" disabled={!createReady} onClick={() => setFields({ groupId: canCreateGroup ? context.id : 0 })}>
          {groupId && !hasGroupContext ? '创建项目' : canCreateGroup ? '创建小组项目' : '创建个人项目'}</Button>}
    </Space></WorkspaceHeader>
    <main id="workspace-main" tabIndex={-1} className="content-wrap project-page">
      <Typography.Title level={2}>{context ? context.name + '的项目' : '把资料整理成项目'}</Typography.Title>
      <Typography.Paragraph type="secondary">整理个人或小组工作，关联保留同一份原文档。项目内只显示你有权限访问的资料。</Typography.Paragraph>
      <PendingProjectDocuments contextKey={location.key} onBusyChange={setDocumentBusy} onCreated={openProjectDocument}
        disabled={operation.busy || uncertain || Boolean(fields) || adding || Boolean(newDocument)} />
      {chooseGroup && <Typography.Paragraph>先选择需要整理资料的小组，再由创建者或管理员创建小组项目。</Typography.Paragraph>}
      {groupId > 0 && <Button onClick={() => setParams({})}>查看全部项目</Button>}
      {contextLoading && <Typography.Paragraph role="status">正在读取小组资料；项目列表和已打开资料可分别查看。</Typography.Paragraph>}
      {contextError && <Alert className="project-read-alert" type="warning" showIcon message={contextError}
        action={<Button disabled={contextLoading || busy} onClick={() => setContextRefresh(n => n + 1)}>重试小组资料</Button>} />}
      {error && <Alert className="project-read-alert" type="error" showIcon message={error}
        action={<Button disabled={loading || busy} onClick={() => setListRefresh(n => n + 1)}>重试项目列表</Button>} />}
      {(operationError || uncertain) && <Alert className="project-read-alert" type="error" showIcon
        message={operationError || '原操作仍待核对，请读取原目标的当前状态。'}
        description={uncertain && (operation.uncertain.kind === 'create'
          ? '原创建：' + operation.uncertain.name + ' · ' + (operation.uncertain.groupId ? '小组 #' + operation.uncertain.groupId : '个人项目')
          : '原项目 #' + operation.uncertain.projectId + (operation.uncertain.docId ? ' · 文档 #' + operation.uncertain.docId + '：' + operation.uncertain.title : '：' + operation.uncertain.name))}
        action={uncertain && <Space wrap><Button loading={operation.checking} disabled={busy || (operation.uncertain.kind === 'create' && creations.loading)} onClick={review}>
          {operation.uncertain.kind === 'create' ? '确认原创建' : '核对操作结果'}</Button>
          {operation.reviewFailed && operation.uncertain.kind !== 'create' && <Popconfirm overlayClassName="document-action-confirm"
            title="结束这次操作的等待？" description={'原项目 #' + operation.uncertain.projectId + (operation.uncertain.docId ? '、文档 #' + operation.uncertain.docId : '') +
              ' 的结果仍未知。这只解除当前标签的等待，请自行查看原资料后再决定是否重新操作。'}
            okText="结束等待" cancelText="继续保留" disabled={busy}
            onOpenChange={open => { if (open) waitingConfirmation.current = operation.uncertain }}
            onConfirm={() => { const original = waitingConfirmation.current; waitingConfirmation.current = null; operation.endWaiting(original) }}>
            <Button disabled={busy}>结束本次等待</Button></Popconfirm>}
          {operation.uncertain.kind === 'create' && operation.uncertain.requestId && <Button disabled={busy}
            onClick={() => { operation.pauseCreation(operation.uncertain); setFields(null) }}>稍后确认</Button>}</Space>} />}
      {operation.notice && <Alert className="project-read-alert" type={operation.notice.type} showIcon message={operation.notice.message}
        action={operation.notice.target && <Button disabled={busy} onClick={() => {
          setDetailArrival(n => n + 1)
          const target = operation.notice.target, result = operation.notice.data
          const wasArchived = result.archived ?? result.projectArchived
          const originalGroup = result.groupId ?? target.groupId
          setParams(wasArchived ? { archived: 'true', ...(originalGroup ? { scope: 'group', groupId: String(originalGroup) } :
            originalGroup === 0 ? { scope: 'personal' } : {}), ...(result.name ? { keyword: result.name } : {}) } : { project: String(target.projectId) })
        }}>{(operation.notice.data.archived ?? operation.notice.data.projectArchived) ? '查看归档列表' : '查看核对项目'}</Button>} />}
      {(creations.loading || creations.error || creations.records?.length > 0) && <Card title="待确认的创建" className="project-section"
        extra={<Button disabled={busy || creations.loading} onClick={creations.reload}>重新读取</Button>}>
        <Typography.Paragraph type="secondary">原名称、简介和归属保存在当前浏览器。确认原请求会找回或完成同一次创建，仍按当前权限访问项目。</Typography.Paragraph>
        {creations.error && <Alert className="project-read-alert" type="warning" showIcon message={creations.error} />}
        <List rowKey="key" loading={creations.loading} dataSource={creations.records || []}
          locale={{ emptyText: creations.loading ? '正在读取…' : creations.error ? '创建记录暂不可用' : '没有待确认创建' }}
          pagination={creations.records?.length > 10 ? { pageSize: 10, size: 'small', showSizeChanger: false, responsive: true } : false}
          renderItem={record => <List.Item actions={[<Button key="confirm" disabled={busy || (uncertain &&
            (operation.uncertain.kind !== 'create' || operation.uncertain.requestId !== record.requestId))} onClick={() => confirmCreation(record)}>确认原创建</Button>]}>
            <List.Item.Meta title={record.name} description={<Space wrap><Tag>{record.groupId ? '小组 #' + record.groupId : '个人项目'}</Tag>
              <span>{new Date(record.createdAt).toLocaleString()}</span></Space>} />
          </List.Item>} />
      </Card>}
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
        <List rowKey="id" loading={loading} dataSource={listed?.list || []}
          locale={{ emptyText: loading ? '正在加载…' : !listed ? '列表暂不可用' : <Empty description={emptyDescription} /> }}
          renderItem={project => <List.Item actions={archived ? project.canManage ? [
            <Popconfirm key="restore" overlayClassName="document-action-confirm" title={'恢复“' + project.name + '”？'}
              description="恢复项目与原关联，文档继续按当前权限访问。" disabled={!ready} onConfirm={() => mutate({ kind: 'restore', projectId: project.id, name: project.name }, config =>
                request.post('/projects/' + project.id + '/restore', {}, config), undefined, ready)}>
              <Button disabled={!ready}>恢复项目</Button></Popconfirm>,
          ] : [] : [<Button key="open" disabled={!ready} aria-expanded={selected === project.id}
            aria-controls={selected === project.id ? 'project-detail' : undefined}
            onClick={() => { setDetailArrival(n => n + 1); navigate({ project: String(project.id) }) }}>查看项目</Button>]}>
            <List.Item.Meta title={project.name} description={<Space wrap><Tag>{project.groupId ? '小组：' + project.groupName : '个人项目'}</Tag>
              <span>{project.visibleDocumentCount} 篇可访问文档</span><span>{project.description || '尚未填写简介'}</span></Space>} />
          </List.Item>} />
        {listed?.total > SIZE && <Pagination current={page} total={listed.total} pageSize={SIZE} showSizeChanger={false}
          disabled={!ready} onChange={next => navigate({ page: String(next) })} />}
      </Card>
      {selected > 0 && !archived && <WorkspaceDetailCard key={selected} id="project-detail" arrival={detailArrival}
        waiting={loading || detailLoading || detailSettledFrom !== detailKey} title={current?.name || '项目资料'} loading={detailLoading} className="project-section"
        extra={<Button disabled={detailLoading || busy} onClick={() => setDetailRefresh(n => n + 1)}>刷新项目资料</Button>}>
        {detailError && <Alert className="project-read-alert" type="error" showIcon message={detailError}
          action={<Button disabled={detailLoading || busy} onClick={() => setDetailRefresh(n => n + 1)}>重试项目资料</Button>} />}
        {current && <>
          <Typography.Paragraph>{current.description || '尚未填写简介'}</Typography.Paragraph>
          <Typography.Paragraph>{current.total} 篇你可访问的文档 · {current.groupId ? '小组：' + current.groupName : '个人项目'}</Typography.Paragraph>
          <Space wrap className="project-section">
            <Button type="primary" disabled={!detailReady} onClick={() => setNewDocument({ id: current.id, name: current.name, groupId: current.groupId })}>新建文档</Button>
            <Button disabled={!detailReady} onClick={() => setAdding(true)}>加入已有文档</Button>
            {manage && <Button disabled={!detailReady} onClick={() => setFields(current)}>修改项目资料</Button>}
            {manage && <Popconfirm overlayClassName="document-action-confirm" title={'归档“' + current.name + '”？'}
              description="保留原文档、单独权限及项目关联，可在已归档列表恢复。" disabled={!detailReady}
              onConfirm={() => mutate({ kind: 'archive', projectId: current.id, name: current.name }, config => request.post('/projects/' + current.id + '/archive', {}, config), () => navigate({ project: null }))}>
              <Button disabled={!detailReady} danger>归档项目</Button></Popconfirm>}
          </Space>
          <Input.Search aria-label="筛选项目内文档" value={docInput} maxLength={200} disabled={busy} placeholder="按文档标题筛选"
            onChange={e => setDocInput(e.target.value)} onSearch={value => navigate({ docKeyword: value.trim() || null, docPage: null })} enterButton="筛选" />
          <List rowKey="id" dataSource={current.list} locale={{ emptyText: <Empty description={docKeyword ? '没有符合条件且可访问的文档' : '还没有你可访问的文档，可以新建一篇或加入已有文档'} /> }}
            renderItem={doc => <List.Item actions={[
              <Link key="open" to={documentHref(doc.id, sourcePath)}>打开</Link>,
              doc.canRemove && <Popconfirm key="remove" overlayClassName="document-action-confirm" title={'将“' + doc.title + '”移出项目？'}
                description="只移除当前关联，保留原文档和成员权限。" disabled={!detailReady} onConfirm={() => mutate({ kind: 'remove', projectId: current.id, groupId: current.groupId, docId: doc.id, title: doc.title, associationId: doc.associationId }, config =>
                  request.delete('/projects/' + current.id + '/documents/' + doc.id, { ...config, params: { associationId: doc.associationId } }))}>
                <Button disabled={!detailReady} danger>移出项目</Button></Popconfirm>,
            ].filter(Boolean)}><List.Item.Meta title={<Link to={documentHref(doc.id, sourcePath)}>{doc.title}</Link>}
              description={<Space wrap><Tag>{doc.permission === 2 ? '可编辑' : '只读'}</Tag><span>{doc.ownerName + ' · ' + doc.updateTime}</span></Space>} />
            </List.Item>} />
          {current.total > SIZE && <Pagination current={docPage} total={current.total} pageSize={SIZE} showSizeChanger={false}
            disabled={!detailReady} onChange={next => navigate({ docPage: String(next) })} />}
        </>}
      </WorkspaceDetailCard>}
    </main>
    {newDocument && <CreateProjectDocumentModal project={newDocument} contextKey={location.key}
      onClose={() => setNewDocument(null)} onCreated={openProjectDocument} onBusyChange={setDocumentBusy} />}
    {fields && <Fields key={fields.id || 'create'} value={fields} context={hasGroupContext ? context : null}
      ready={fields.id ? detailReady && manage : createReady} busy={busy} uncertain={uncertain}
      error={operationError || (fields.id ? detailError : contextError || error)} notice={operation.notice?.target?.projectId === fields.id ? operation.notice : null}
      onRetry={() => { if (fields.id) setDetailRefresh(n => n + 1); else { setListRefresh(n => n + 1); setContextRefresh(n => n + 1) } }}
      onClose={() => { if (!busy) setFields(null) }} onReview={review}
      onSave={values => {
        const target = { kind: fields.id ? 'rename' : 'create', projectId: fields.id, name: values.name, description: values.description, groupId: values.groupId }
        if (fields.id) mutate(target, config => request.put('/projects/' + fields.id, { name: values.name, description: values.description }, config), () => setFields(null), detailReady && manage)
        else if (createReady && (values.groupId === 0 || (values.groupId === context?.id && canCreateGroup))) operation.run(target,
          (config, prepared) => creations.create(values, config, prepared), openCreated, { trackedCreation: true })
      }} />}
    {adding && current && <ProjectDocumentsModal key={current.id} project={current} from={sourcePath} busy={busy} uncertain={uncertain}
      error={operationError} onClose={() => setAdding(false)} onReview={review}
      onAdd={doc => mutate({ kind: 'add', projectId: current.id, groupId: current.groupId, docId: doc.id, title: doc.title }, config =>
        request.post('/projects/' + current.id + '/documents', { docId: doc.id }, config), () => setAdding(false))} />}
    {showGuide && <UserGuide initialSection="projects" onClose={() => setShowGuide(false)} />}
  </Layout>
}
