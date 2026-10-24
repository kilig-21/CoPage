import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Empty, Input, Layout, List, Modal, Pagination, Popconfirm, Radio, Select, Space, Tag, Typography } from 'antd'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import request from '../api/request'
import WorkspaceHeader from '../components/WorkspaceHeader'
import UserGuide from '../components/UserGuide'
import CreateGroupModal from '../components/CreateGroupModal'
import PendingGroupCreations from '../components/PendingGroupCreations'
import WorkspaceDetailCard from '../components/WorkspaceDetailCard'
import { createGroupWaiting } from '../api/groupWaiting'

const roles = { owner: '创建者', admin: '管理员', member: '成员' }
const options = [{ value: 'member', label: '成员' }, { value: 'admin', label: '管理员' }]
const SIZE = 20
const validId = raw => Number.isSafeInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : 0

function GroupFields({ fields, busy, uncertain, error, onClose, onReview, onSave }) {
  const [name, setName] = useState(fields.name || '')
  const [description, setDescription] = useState(fields.description || '')
  return <Modal className="group-fields-modal" open title="修改小组资料" closable={!busy}
    maskClosable={!busy} keyboard={!busy} onCancel={onClose} footer={[
      <Button key="cancel" disabled={busy} onClick={onClose}>取消</Button>,
      uncertain && <Button key="review" disabled={busy} onClick={onReview}>核对当前列表</Button>,
      <Button key="save" type="primary" loading={busy} disabled={uncertain || !name.trim()}
        onClick={() => onSave({ name: name.trim(), description: description.trim() })}>保存资料</Button>,
    ]}>
    <Typography.Paragraph>小组负责组织成员与资料分类；文档仍需所有者逐篇授权。</Typography.Paragraph>
    {error && <Alert type="error" showIcon message={error} />}
    <Typography.Paragraph>小组名称</Typography.Paragraph>
    <Input aria-label="小组名称" maxLength={80} autoFocus disabled={busy} value={name} onChange={e => setName(e.target.value)} />
    <Typography.Paragraph style={{ marginTop: 12 }}>小组简介</Typography.Paragraph>
    <Input.TextArea aria-label="小组简介" maxLength={300} showCount rows={3} disabled={busy}
      value={description} onChange={e => setDescription(e.target.value)} />
  </Modal>
}

export default function Groups() {
  const [showGuide, setShowGuide] = useState(false)
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const keyword = (params.get('keyword') || '').slice(0, 200).trim()
  const [input, setInput] = useState(keyword)
  const archived = params.get('archived') === 'true'
  const page = Math.min(validId(params.get('page')) || 1, 1000000)
  const selected = validId(params.get('group'))
  const [detailArrival, setDetailArrival] = useState(0)
  const [inboxPage, setInboxPage] = useState(1)
  const [groups, setGroups] = useState(null)
  const [inbox, setInbox] = useState(null)
  const [inboxFrom, setInboxFrom] = useState(null)
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [inboxLoading, setInboxLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailTarget, setDetailTarget] = useState(0)
  const [error, setError] = useState('')
  const [groupError, setGroupError] = useState('')
  const [inboxError, setInboxError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [notice, setNotice] = useState('')
  const [noticeType, setNoticeType] = useState('success')
  const [refresh, setRefresh] = useState(0)
  const [groupRefresh, setGroupRefresh] = useState(0)
  const [inboxRefresh, setInboxRefresh] = useState(0)
  const [detailRefresh, setDetailRefresh] = useState(0)
  const inboxKey = JSON.stringify([inboxPage, refresh, inboxRefresh])
  const currentInboxKey = useRef(inboxKey)
  currentInboxKey.current = inboxKey
  const [fields, setFields] = useState(null)
  const [creating, setCreating] = useState(false)
  const [creationBusy, setCreationBusy] = useState(false)
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const mutation = useRef(null)
  const mutationEpoch = useRef(0)
  const unconfirmed = useRef(null)
  const alive = useRef(true), creationLock = useRef(false), waitingConfirmation = useRef(null)
  const [waitingState, setWaitingState] = useState({ checking: false, reviewFailed: false })
  const [endedWaiting, setEndedWaiting] = useState(null)
  const waiting = useRef(null)
  if (!waiting.current) waiting.current = createGroupWaiting({
    readIdentity: () => ({ account: localStorage.getItem('collab-user'), token: localStorage.getItem('collab-token'), service: request.defaults.baseURL }),
    getEpoch: () => mutationEpoch.current,
    isBlocked: () => Boolean(mutation.current || creationLock.current),
    onChange: state => { if (alive.current) setWaitingState(state) },
  })
  const updateCreationBusy = useCallback(value => { creationLock.current = value; setCreationBusy(value) }, [])
  useEffect(() => { alive.current = true; return () => { alive.current = false; waiting.current.cancelReview(unconfirmed.current) } }, [])
  useEffect(() => {
    mutation.current?.abort(); mutation.current = null; setBusy(false); setFields(null); setCreating(false); updateCreationBusy(false)
    return () => mutation.current?.abort()
  }, [location.key])
  useEffect(() => setInput(keyword), [keyword])
  const choose = (id, nextPage = page, nextArchived = archived, nextKeyword = keyword) =>
    setParams({ ...(nextArchived ? { archived: 'true' } : {}), ...(nextKeyword ? { keyword: nextKeyword } : {}),
      page: String(nextPage), ...(id ? { group: String(id) } : {}) })
  function created(data) {
    setDetailArrival(n => n + 1)
    setCreating(false); setError(''); setNoticeType('info')
    setNotice(data.archived ? `已确认原小组 #${data.id}，目前已归档，可在下方按当前名称查看。`
      : `已确认小组 #${data.id}，可在下方查看成员与资料。`)
    setRefresh(value => value + 1)
    choose(data.archived ? 0 : data.id, 1, data.archived,
      data.archived && typeof data.name === 'string' ? data.name : '')
  }
  function confirmRead(resource, epoch, target = 0) {
    const pending = unconfirmed.current
    if (!pending || pending.resource !== resource || pending.epoch !== epoch || epoch !== mutationEpoch.current ||
        (resource === 'detail' && pending.target !== target) ||
        (resource === 'groups' && pending.keyword && pending.keyword !== keyword)) return
    if (!waiting.current.clear(pending)) return
    unconfirmed.current = null; setUncertain(false); setError('')
    if (resource === 'groups' && pending.target === selected && selected && !pending.keyword) {
      setDetail(null)
      setParams(current => { const next = new URLSearchParams(current); next.delete('group'); return next }, { replace: true })
    }
    setNoticeType('info'); setNotice('已重新读取相关资料，请核对上次操作的实际结果。')
  }
  function reviewOperation() {
    const pending = unconfirmed.current
    if (!pending || busy || !waiting.current.requestReview(pending)) return
    setFields(null)
    try {
      if (pending.resource === 'inbox') setInboxRefresh(n => n + 1)
      else if (pending.resource === 'detail') { choose(pending.target, 1, false); setDetailRefresh(n => n + 1) }
      else { choose(0, 1, pending.keyword ? false : archived, pending.keyword || keyword); setGroupRefresh(n => n + 1) }
    } catch {
      waiting.current.cancelReview(pending)
      setError('暂时无法发起核对，原操作结果仍未确认；请稍后重试。')
    }
  }
  function endWaiting(original) {
    if (!original || unconfirmed.current !== original || !waiting.current.endWaiting(original)) return
    unconfirmed.current = null; setUncertain(false); setError(''); setFields(null)
    setEndedWaiting(original)
  }
  useEffect(() => {
    const controller = new AbortController()
    const epoch = mutationEpoch.current
    const read = waiting.current.startRead({ resource: 'groups', epoch, keyword })
    setLoading(true); setGroups(null); setGroupError('')
    request.get('/groups', { params: { page, size: SIZE, archived, keyword }, signal: controller.signal }).then(({ data }) => {
      if (controller.signal.aborted) return
      const last = Math.max(1, Math.ceil(data.total / SIZE))
      if (page > last) {
        setParams(current => { const next = new URLSearchParams(current); next.set('page', String(last)); return next }, { replace: true })
        return
      }
      setGroups(data); confirmRead('groups', epoch)
    }).catch(failure => {
      if (!controller.signal.aborted) {
        waiting.current.finishRead(read, true)
        setGroupError([400, 403, 404].includes(failure?.code) ? failure.message : '小组列表未能加载，请重试。')
      }
    }).finally(() => { waiting.current.finishRead(read); if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); waiting.current.cancelRead(read) }
  }, [page, archived, keyword, selected, refresh, groupRefresh])
  useEffect(() => {
    const controller = new AbortController()
    const epoch = mutationEpoch.current
    const current = () => !controller.signal.aborted && currentInboxKey.current === inboxKey
    const read = waiting.current.startRead({ resource: 'inbox', epoch })
    setInboxLoading(true); setInbox(null); setInboxFrom(null); setInboxError('')
    request.get('/groups/invitations', { params: { page: inboxPage, size: SIZE }, signal: controller.signal })
      .then(({ data }) => {
        if (!current()) return
        if (!Number.isSafeInteger(data?.total) || data.total < 0 || !Array.isArray(data.list)) throw new Error('邀请响应无效')
        const last = Math.max(1, Math.ceil(data.total / SIZE))
        if (inboxPage > last) { setInboxPage(last); return }
        setInbox(data); setInboxFrom(inboxKey); confirmRead('inbox', epoch)
      }).catch(failure => {
        if (current()) {
          waiting.current.finishRead(read, true)
          setInboxFrom(inboxKey)
          setInboxError([400, 403, 404].includes(failure?.code) ? failure.message || '收到的邀请未能加载，请重试。' : '收到的邀请未能加载，请重试。')
        }
      }).finally(() => { waiting.current.finishRead(read); if (current()) setInboxLoading(false) })
    return () => { controller.abort(); waiting.current.cancelRead(read) }
  }, [inboxPage, refresh, inboxRefresh])
  useEffect(() => {
    const controller = new AbortController()
    const epoch = mutationEpoch.current
    const read = selected && !archived ? waiting.current.startRead({ resource: 'detail', epoch, target: selected }) : null
    setDetail(null); setDetailTarget(0); setDetailError(''); setUsername('')
    setDetailLoading(Boolean(selected && !archived))
    if (selected && !archived) request.get('/groups/' + selected, { signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) { setDetail(data); confirmRead('detail', epoch, selected) } })
      .catch(failure => {
        if (!controller.signal.aborted) {
          waiting.current.finishRead(read, true)
          setDetailError([400, 403, 404].includes(failure?.code) ? failure.message : '小组资料未能加载，请刷新重试。')
        }
      })
      .finally(() => { waiting.current.finishRead(read); if (!controller.signal.aborted) { setDetailLoading(false); setDetailTarget(selected) } })
    return () => { controller.abort(); waiting.current.cancelRead(read) }
  }, [selected, archived, refresh, detailRefresh])
  useEffect(() => {
    const pending = unconfirmed.current
    // 用户已离开原核对目标时，只取消尚未开始的意图；无关读取本身不能记作核对失败。
    if (pending && ((pending.resource === 'detail' && (selected !== pending.target || archived)) ||
        (pending.resource === 'groups' && pending.keyword && pending.keyword !== keyword))) waiting.current.cancelReview(pending)
  }, [location.key, selected, archived, keyword])
  const groupsAvailable = Boolean(groups && !loading)
  const groupsReady = groupsAvailable && !busy && !uncertain && !creationBusy
  const currentInbox = inboxFrom === inboxKey ? inbox : null
  const currentInboxError = inboxFrom === inboxKey ? inboxError : ''
  const inboxReading = inboxLoading || inboxFrom !== inboxKey
  const inboxReady = Boolean(currentInbox && !inboxReading && !currentInboxError && !busy && !uncertain && !creationBusy)
  const compactInbox = Boolean(currentInbox && !inboxReading && !currentInboxError && currentInbox.total === 0 &&
    Array.isArray(currentInbox.list) && currentInbox.list.length === 0)
  const detailReady = Boolean(detail?.id === selected && !detailLoading && !busy && !uncertain && !creationBusy)
  const manager = detail && detail.id === selected && ['owner', 'admin'].includes(detail.role)
  useEffect(() => { if (fields?.id && !manager) setFields(null) }, [manager, fields?.id])

  async function mutate(action, label, onSuccess, { resource = 'detail', keyword: submittedKeyword, required = resource, target = selected, operation = '修改小组资料' } = {}) {
    if (mutation.current || !(required === 'groups' ? groupsReady : required === 'inbox' ? inboxReady : detailReady)) return
    const owner = waiting.current.captureIdentity()
    if (!owner) { setError('浏览器无法读取当前账号，请恢复存储后再操作；原资料保留。'); return }
    const controller = new AbortController()
    ++mutationEpoch.current
    mutation.current = controller; setBusy(true); setError(''); setNotice(''); setNoticeType('success')
    try {
      const result = await action(controller.signal)
      if (controller.signal.aborted) return
      setNotice(label); onSuccess?.(result.data); setRefresh(n => n + 1)
    } catch (failure) {
      if (!controller.signal.aborted) {
        const rejected = [400, 401, 403, 404].includes(failure?.code)
        // 只有结果未确认之后发起的新读取，才能用于核对；写入期间开始的读取也可能过旧。
        unconfirmed.current = rejected ? null : Object.freeze({ resource, epoch: ++mutationEpoch.current, target, keyword: submittedKeyword, operation })
        if (unconfirmed.current) waiting.current.remember(unconfirmed.current, owner)
        setUncertain(!rejected)
        setError(rejected ? failure.message : '操作结果未确认，请刷新核对当前列表或成员关系，再决定是否重试。')
      }
    } finally {
      if (mutation.current === controller) mutation.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return <Layout className="app-shell">
    <WorkspaceHeader title="我的小组" onGuide={() => setShowGuide(true)}>
      <Space wrap>
        <Button disabled={busy} onClick={() => setRefresh(n => n + 1)}>刷新</Button>
        <Button type="primary" disabled={!groupsReady} onClick={() => { setError(''); setCreating(true) }}>创建小组</Button></Space>
    </WorkspaceHeader>
    <main id="workspace-main" tabIndex={-1} className="content-wrap group-page">
      <Typography.Title level={2}>和同伴组织工作</Typography.Title>
      <Typography.Paragraph type="secondary">在小组管理成员与角色。加入小组不会自动获得文档权限，资料仍逐篇共享。</Typography.Paragraph>
      {error && <Alert type={uncertain ? 'warning' : 'error'} showIcon message={error}
        description={uncertain && unconfirmed.current && ('原小组 #' + unconfirmed.current.target + ' · ' + unconfirmed.current.operation)}
        action={uncertain && <Space wrap>
          <Button disabled={busy || creationBusy || waitingState.checking} loading={waitingState.checking} onClick={reviewOperation}>核对操作结果</Button>
          {waitingState.reviewFailed && <Popconfirm overlayClassName="document-action-confirm group-wait-confirm"
            title="结束这次操作的等待？"
            description={'原小组 #' + unconfirmed.current?.target + ' 的“' + unconfirmed.current?.operation + '”结果仍未知。这只解除当前标签的等待，不会重试、撤销或认定成功。'}
            okText="结束等待" cancelText="继续保留" disabled={busy || creationBusy || waitingState.checking}
            onOpenChange={open => { if (open) waitingConfirmation.current = unconfirmed.current }}
            onConfirm={() => { const original = waitingConfirmation.current; waitingConfirmation.current = null; endWaiting(original) }}>
            <Button disabled={busy || creationBusy || waitingState.checking}>结束本次等待</Button>
          </Popconfirm>}
        </Space>} />}
      {endedWaiting && <Alert type="warning" showIcon message={'已结束本次等待，原小组 #' + endedWaiting.target + ' 的“' + endedWaiting.operation +
        '”结果仍未知。请自行查看原资料后，再决定是否重新操作；没有自动重试、撤销或认定成功。'} />}
      {notice && <Alert type={noticeType} showIcon message={notice} />}
      <PendingGroupCreations onCreated={created} onBusyChange={updateCreationBusy} contextKey={location.key}
        disabled={busy || uncertain || creating || Boolean(fields)} />
      <Card role="region" aria-label="收到的邀请" className={'group-section group-inbox-card' + (compactInbox ? ' group-inbox-empty' : '')}
        title={<div className="group-inbox-heading"><span>收到的邀请</span>{compactInbox && <span className="group-inbox-status">暂无待处理邀请</span>}</div>}
        extra={<Button disabled={busy} loading={inboxReading} aria-disabled={inboxReading || busy}
          onClick={() => { if (!inboxReading && !busy) setInboxRefresh(n => n + 1) }}>刷新邀请</Button>}>
        {!compactInbox && <>
        {currentInboxError && <Alert type="error" showIcon message={currentInboxError}
          action={<Button disabled={inboxReading || busy} onClick={() => setInboxRefresh(n => n + 1)}>重试邀请</Button>} />}
        <List rowKey="groupId" loading={inboxReading} dataSource={currentInbox?.list || []}
          locale={{ emptyText: inboxReading ? '正在加载…' : !currentInbox ? '邀请暂不可用' : <Empty description="暂无待处理邀请" /> }}
          renderItem={invitation => <List.Item actions={[
            <Button key="accept" type="primary" disabled={!inboxReady} onClick={() => mutate(signal =>
              request.post('/groups/' + invitation.groupId + '/invitation', { accept: true, invitationVersion: invitation.invitationVersion }, { signal }), '已加入小组',
              () => { setDetailArrival(n => n + 1); choose(invitation.groupId, 1, false) }, { resource: 'inbox', target: invitation.groupId, operation: '接受邀请' })}>接受邀请</Button>,
            <Button key="decline" disabled={!inboxReady} onClick={() => mutate(signal =>
              request.post('/groups/' + invitation.groupId + '/invitation', { accept: false, invitationVersion: invitation.invitationVersion }, { signal }), '已拒绝邀请', undefined, { resource: 'inbox', target: invitation.groupId, operation: '拒绝邀请' })}>拒绝</Button>,
          ]}><List.Item.Meta title={invitation.name} description={invitation.inviterNickname + '（' + invitation.inviterUsername + '）邀请你加入 · ' + invitation.createdAt} /></List.Item>} />
        {currentInbox?.total > SIZE && <Pagination current={inboxPage} total={currentInbox.total} pageSize={SIZE}
          showSizeChanger={false} disabled={inboxReading || busy} onChange={setInboxPage} />}
        </>}
      </Card>
      <Space className="group-section"><Radio.Group aria-label="小组状态" value={archived} disabled={busy}
        options={[{ label: '进行中', value: false }, { label: '已归档', value: true }]}
        onChange={e => choose(0, 1, e.target.value)} /></Space>
      <div className="group-section">
        <Input.Search aria-label="筛选小组名称或简介" maxLength={200} value={input} disabled={busy}
          placeholder="按小组名称或简介筛选" enterButton="查找小组" style={{ width: '100%', maxWidth: 420 }}
          onChange={e => setInput(e.target.value)} onSearch={value => choose(0, 1, archived, value.trim())} />
        <Space wrap style={{ marginTop: 8, display: 'flex' }}>
          {groups && <Typography.Text role="status">{keyword ? '匹配的小组：' : '小组合计：'}{groups.total}</Typography.Text>}
          {keyword && <Button disabled={busy} onClick={() => choose(0, 1, archived, '')}>清除小组筛选</Button>}
        </Space>
        <Typography.Paragraph type="secondary">筛选当前账号加入的小组，不影响上方收到的邀请。</Typography.Paragraph>
      </div>
      <Card title={archived ? '已归档小组' : '我加入的小组'} className="group-section"
        extra={<Button disabled={loading || busy} onClick={() => setGroupRefresh(n => n + 1)}>刷新小组</Button>}>
        {groupError && <Alert type="error" showIcon message={groupError}
          action={<Button disabled={loading || busy} onClick={() => setGroupRefresh(n => n + 1)}>重试小组列表</Button>} />}
        <List rowKey="id" loading={loading} dataSource={groups?.list || []}
          locale={{ emptyText: loading ? '正在加载…' : !groups ? '小组暂不可用' : <Empty description={keyword ? '没有匹配的小组，请调整关键词或清除筛选' : archived ? '暂无归档小组' : '创建小组，或接受同伴的邀请'} /> }}
          renderItem={group => <List.Item actions={archived ? group.role === 'owner' ? [
            <Popconfirm overlayClassName="document-action-confirm" key="restore" title={'恢复“' + group.name + '”？'} description="原成员将重新获得小组访问权限；文档仍逐篇授权。"
              disabled={!groupsReady} onConfirm={() => mutate(signal => request.post('/groups/' + group.id + '/restore', {}, { signal }), '小组已恢复', undefined, { resource: 'groups', target: group.id, operation: '恢复小组' })}>
              <Button disabled={!groupsReady}>恢复小组</Button></Popconfirm>,
          ] : [] : [<Button key="open" disabled={!groupsAvailable || busy} aria-expanded={selected === group.id}
            aria-controls={selected === group.id ? 'group-detail' : undefined}
            onClick={() => { setDetailArrival(n => n + 1); choose(group.id) }}>查看成员</Button>]}>
            <List.Item.Meta title={group.name} description={<Space wrap className="organization-list-summary"><Tag>{roles[group.role]}</Tag><span>小组 #{group.id}</span>
              <span>{group.memberCount} 位成员</span><span>{group.description || '尚未填写简介'}</span></Space>} />
          </List.Item>} />
        {groups?.total > SIZE && <Pagination current={page} total={groups.total} pageSize={SIZE}
          showSizeChanger={false} disabled={loading || busy} onChange={next => choose(selected, next)} />}
      </Card>
      {selected > 0 && !archived && <WorkspaceDetailCard key={selected} id="group-detail" arrival={detailArrival}
        waiting={loading || detailLoading || inboxReading || detailTarget !== selected}
        title={detail?.id === selected ? detail.name : '小组资料'} loading={detailLoading} className="group-section">
        {detailError && <Alert type="error" showIcon message={detailError}
          action={<Button disabled={detailLoading || busy} onClick={() => setDetailRefresh(n => n + 1)}>重试小组资料</Button>} />}
        {detail && detail.id === selected && <>
          <Typography.Paragraph>{detail.description || '尚未填写简介'}</Typography.Paragraph>
          <Space wrap className="group-section"><Tag>我的角色：{roles[detail.role]}</Tag>
            <Link to={'/projects?scope=group&groupId=' + detail.id}>查看小组项目</Link>
            {manager && <Button disabled={!detailReady} onClick={() => { setError(''); setFields(detail) }}>修改小组资料</Button>}
            {detail.role === 'owner' ? <Popconfirm overlayClassName="document-action-confirm" title={'归档“' + detail.name + '”？'}
              description="取消未接受邀请，保留成员关系；原文档与单独授权继续保留。" disabled={!detailReady}
              onConfirm={() => mutate(signal => request.post('/groups/' + detail.id + '/archive', {}, { signal }), '小组已归档，可在已归档列表恢复', () => choose(0), { resource: 'groups', required: 'detail', operation: '归档小组' })}>
              <Button disabled={!detailReady} danger>归档小组</Button></Popconfirm> :
              <Popconfirm overlayClassName="document-action-confirm" title={'退出“' + detail.name + '”？'} description="将停止小组访问；原有文档授权仍由文档所有者管理。"
                disabled={!detailReady} onConfirm={() => mutate(signal => request.post('/groups/' + detail.id + '/leave', {}, { signal }), '已退出小组', () => choose(0), { resource: 'groups', required: 'detail', operation: '退出小组' })}>
                <Button disabled={!detailReady} danger>退出小组</Button></Popconfirm>}
          </Space>
          {manager && <div className="group-section">
            <Typography.Paragraph>按已注册用户名邀请；对方接受后才成为成员。成员与待接受邀请合计最多200人。</Typography.Paragraph>
            <Space wrap><Input aria-label="邀请用户名" value={username} maxLength={50} disabled={!detailReady}
              onChange={e => setUsername(e.target.value)} autoComplete="off" />
              <Button disabled={!detailReady || !username.trim()} onClick={() => mutate(signal =>
                request.post('/groups/' + detail.id + '/invitations', { username: username.trim() }, { signal }), '邀请已发送',
                () => setUsername(''), { operation: '发送邀请' })}>发送邀请</Button></Space>
          </div>}
          <List rowKey="userId" dataSource={detail.members} renderItem={member => <List.Item actions={[
            detail.role === 'owner' && member.userId !== detail.ownerId && <Select key="role" aria-label={member.username + ' 的小组角色'}
              options={options} value={member.role} disabled={!detailReady} onChange={role => mutate(signal =>
                request.put('/groups/' + detail.id + '/members/' + member.userId, { role }, { signal }), '成员角色已更新', undefined, { operation: '更新成员角色' })} />,
            manager && member.userId !== detail.currentUserId && member.userId !== detail.ownerId &&
              (detail.role === 'owner' || member.role === 'member') && <Popconfirm overlayClassName="document-action-confirm" key="remove" title={'移除 ' + member.username + '？'}
                description="停止小组访问；不会自动修改文档单独授权。" disabled={!detailReady} onConfirm={() => mutate(signal =>
                  request.delete('/groups/' + detail.id + '/members/' + member.userId, { signal }), '成员已移出小组', undefined, { operation: '移除成员' })}>
                <Button disabled={!detailReady} danger>移除成员</Button></Popconfirm>,
          ].filter(Boolean)}><List.Item.Meta title={member.nickname || member.username}
            description={member.username} /><Tag>{roles[member.role]}</Tag></List.Item>} />
          {manager && <><Typography.Title level={5}>待接受邀请</Typography.Title>
            <List rowKey="userId" dataSource={detail.invitations} locale={{ emptyText: '没有待接受邀请' }}
              renderItem={invitation => <List.Item actions={[<Button key="cancel" disabled={!detailReady} onClick={() => mutate(signal =>
                request.delete('/groups/' + detail.id + '/invitations/' + invitation.userId, { signal, params: { invitationVersion: invitation.invitationVersion } }), '邀请已取消', undefined, { operation: '取消邀请' })}>取消邀请</Button>]}>
                <List.Item.Meta title={invitation.nickname || invitation.username} description={invitation.username + ' · ' + invitation.createdAt} />
              </List.Item>} /></>}
        </>}
      </WorkspaceDetailCard>}
    </main>
    {creating && <CreateGroupModal onClose={() => setCreating(false)} onCreated={created} onBusyChange={updateCreationBusy} />}
    {fields && <GroupFields key={fields.id} fields={fields} busy={busy} uncertain={uncertain} error={error}
      onClose={() => { if (!busy) setFields(null) }} onReview={reviewOperation}
      onSave={values => mutate(signal => request.put('/groups/' + fields.id, values, { signal }),
        '小组资料已保存', () => setFields(null))} />}
    {showGuide && <UserGuide initialSection="groups" onClose={() => setShowGuide(false)} />}
  </Layout>
}
