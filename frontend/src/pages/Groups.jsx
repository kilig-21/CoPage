import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Empty, Input, Layout, List, Modal, Pagination, Popconfirm, Radio, Select, Space, Tag, Typography } from 'antd'
import { Link, useSearchParams } from 'react-router-dom'
import request from '../api/request'
import UserGuide from '../components/UserGuide'

const roles = { owner: '创建者', admin: '管理员', member: '成员' }
const options = [{ value: 'member', label: '成员' }, { value: 'admin', label: '管理员' }]
const SIZE = 20
const validId = raw => Number.isSafeInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : 0

function GroupFields({ fields, busy, uncertain, error, onClose, onReview, onSave }) {
  const [name, setName] = useState(fields.name || '')
  const [description, setDescription] = useState(fields.description || '')
  return <Modal open title={fields.id ? '修改小组资料' : '创建小组'} closable={!busy}
    maskClosable={!busy} keyboard={!busy} onCancel={onClose} footer={[
      <Button key="cancel" disabled={busy} onClick={onClose}>取消</Button>,
      uncertain && <Button key="review" disabled={busy} onClick={onReview}>核对当前列表</Button>,
      <Button key="save" type="primary" loading={busy} disabled={uncertain || !name.trim()}
        onClick={() => onSave({ name: name.trim(), description: description.trim() })}>{fields.id ? '保存资料' : '创建小组'}</Button>,
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
  const archived = params.get('archived') === 'true'
  const page = Math.min(validId(params.get('page')) || 1, 1000000)
  const selected = validId(params.get('group'))
  const [inboxPage, setInboxPage] = useState(1)
  const [groups, setGroups] = useState(null)
  const [inbox, setInbox] = useState(null)
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [fields, setFields] = useState(null)
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const mutation = useRef(null)
  useEffect(() => () => mutation.current?.abort(), [])
  const choose = (id, nextPage = page, nextArchived = archived) =>
    setParams({ ...(nextArchived ? { archived: 'true' } : {}), page: String(nextPage), ...(id ? { group: String(id) } : {}) })
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setGroups(null); setInbox(null); setError('')
    Promise.all([
      request.get('/groups', { params: { page, size: SIZE, archived }, signal: controller.signal }),
      request.get('/groups/invitations', { params: { page: inboxPage, size: SIZE }, signal: controller.signal }),
    ]).then(([list, invitations]) => {
      if (controller.signal.aborted) return
      const last = Math.max(1, Math.ceil(list.data.total / SIZE))
      const inboxLast = Math.max(1, Math.ceil(invitations.data.total / SIZE))
      if (page > last) { choose(selected, last); return }
      if (inboxPage > inboxLast) { setInboxPage(inboxLast); return }
      setGroups(list.data); setInbox(invitations.data); setUncertain(false)
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure?.code === 403 ? failure.message : '小组列表未能加载，请刷新重试。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [page, archived, inboxPage, refresh])
  useEffect(() => {
    const controller = new AbortController()
    setDetail(null); setDetailError(''); setUsername('')
    setDetailLoading(Boolean(selected && !archived))
    if (selected && !archived) request.get('/groups/' + selected, { signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) setDetail(data) })
      .catch(failure => { if (!controller.signal.aborted) setDetailError([400, 403, 404].includes(failure?.code)
        ? failure.message : '小组资料未能加载，请刷新重试。') })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false) })
    return () => controller.abort()
  }, [selected, archived, refresh])
  const ready = Boolean(groups && inbox && !loading && !busy && !uncertain)
  const manager = detail && detail.id === selected && ['owner', 'admin'].includes(detail.role)
  useEffect(() => { if (fields?.id && !manager) setFields(null) }, [manager, fields?.id])

  async function mutate(action, label, onSuccess) {
    if (mutation.current || !ready) return
    const controller = new AbortController()
    mutation.current = controller; setBusy(true); setError(''); setNotice('')
    try {
      const result = await action(controller.signal)
      if (controller.signal.aborted) return
      setNotice(label); onSuccess?.(result.data); setRefresh(n => n + 1)
    } catch (failure) {
      if (!controller.signal.aborted) {
        const rejected = [400, 401, 403, 404].includes(failure?.code)
        setUncertain(!rejected)
        setError(rejected ? failure.message : '操作结果未确认，请刷新核对当前列表或成员关系，再决定是否重试。')
      }
    } finally {
      if (mutation.current === controller) mutation.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const review = () => { const target = fields?.id || 0; setFields(null); choose(target, 1, false); setRefresh(n => n + 1) }
  return <Layout className="app-shell">
    <header className="topbar"><Typography.Title level={4}>我的小组</Typography.Title>
      <Space wrap><Link to="/home">工作台</Link><Link to="/docs">我的文档</Link><Link to="/projects">我的项目</Link>
        <Button onClick={() => setShowGuide(true)}>使用指南</Button>
        <Button disabled={loading || busy} onClick={() => setRefresh(n => n + 1)}>刷新</Button>
        <Button type="primary" disabled={!ready} onClick={() => { setError(''); setFields({}) }}>创建小组</Button></Space>
    </header>
    <main className="content-wrap group-page">
      <Typography.Title level={2}>和同伴组织工作</Typography.Title>
      <Typography.Paragraph type="secondary">在小组管理成员与角色。加入小组不会自动获得文档权限，资料仍逐篇共享。</Typography.Paragraph>
      {error && <Alert type="error" showIcon message={error} />}
      {notice && <Alert type="success" showIcon message={notice} />}
      <Card title="收到的邀请" className="group-section">
        <List rowKey="groupId" loading={loading} dataSource={inbox?.list || []}
          locale={{ emptyText: loading ? '正在加载…' : !inbox ? '邀请暂不可用' : <Empty description="暂无待处理邀请" /> }}
          renderItem={invitation => <List.Item actions={[
            <Button key="accept" type="primary" disabled={!ready} onClick={() => mutate(signal =>
              request.post('/groups/' + invitation.groupId + '/invitation', { accept: true, invitationVersion: invitation.invitationVersion }, { signal }), '已加入小组',
              () => choose(invitation.groupId, 1, false))}>接受邀请</Button>,
            <Button key="decline" disabled={!ready} onClick={() => mutate(signal =>
              request.post('/groups/' + invitation.groupId + '/invitation', { accept: false, invitationVersion: invitation.invitationVersion }, { signal }), '已拒绝邀请')}>拒绝</Button>,
          ]}><List.Item.Meta title={invitation.name} description={invitation.inviterNickname + '（' + invitation.inviterUsername + '）邀请你加入 · ' + invitation.createdAt} /></List.Item>} />
        {inbox?.total > SIZE && <Pagination current={inboxPage} total={inbox.total} pageSize={SIZE}
          showSizeChanger={false} disabled={!ready} onChange={setInboxPage} />}
      </Card>
      <Space className="group-section"><Radio.Group aria-label="小组状态" value={archived} disabled={busy}
        options={[{ label: '进行中', value: false }, { label: '已归档', value: true }]}
        onChange={e => choose(0, 1, e.target.value)} /></Space>
      <Card title={archived ? '已归档小组' : '我加入的小组'} className="group-section">
        <List rowKey="id" loading={loading} dataSource={groups?.list || []}
          locale={{ emptyText: loading ? '正在加载…' : !groups ? '小组暂不可用' : <Empty description={archived ? '暂无归档小组' : '创建小组，或接受同伴的邀请'} /> }}
          renderItem={group => <List.Item actions={archived ? group.role === 'owner' ? [
            <Popconfirm overlayClassName="document-action-confirm" key="restore" title={'恢复“' + group.name + '”？'} description="原成员将重新获得小组访问权限；文档仍逐篇授权。"
              disabled={!ready} onConfirm={() => mutate(signal => request.post('/groups/' + group.id + '/restore', {}, { signal }), '小组已恢复')}>
              <Button disabled={!ready}>恢复小组</Button></Popconfirm>,
          ] : [] : [<Button key="open" disabled={!ready} onClick={() => choose(group.id)}>查看成员</Button>]}>
            <List.Item.Meta title={group.name} description={<Space wrap><Tag>{roles[group.role]}</Tag>
              <span>{group.memberCount} 位成员</span><span>{group.description || '尚未填写简介'}</span></Space>} />
          </List.Item>} />
        {groups?.total > SIZE && <Pagination current={page} total={groups.total} pageSize={SIZE}
          showSizeChanger={false} disabled={!ready} onChange={next => choose(selected, next)} />}
      </Card>
      {selected > 0 && !archived && <Card key={selected} title={detail?.id === selected ? detail.name : '小组资料'} loading={detailLoading} className="group-section">
        {detailError && <Alert type="error" showIcon message={detailError} />}
        {detail && detail.id === selected && <>
          <Typography.Paragraph>{detail.description || '尚未填写简介'}</Typography.Paragraph>
          <Space wrap className="group-section"><Tag>我的角色：{roles[detail.role]}</Tag>
            <Link to={'/projects?scope=group&groupId=' + detail.id}>查看小组项目</Link>
            {manager && <Button disabled={!ready} onClick={() => { setError(''); setFields(detail) }}>修改小组资料</Button>}
            {detail.role === 'owner' ? <Popconfirm overlayClassName="document-action-confirm" title={'归档“' + detail.name + '”？'}
              description="取消未接受邀请，保留成员关系；原文档与单独授权继续保留。" disabled={!ready}
              onConfirm={() => mutate(signal => request.post('/groups/' + detail.id + '/archive', {}, { signal }), '小组已归档，可在已归档列表恢复', () => choose(0))}>
              <Button disabled={!ready} danger>归档小组</Button></Popconfirm> :
              <Popconfirm overlayClassName="document-action-confirm" title={'退出“' + detail.name + '”？'} description="将停止小组访问；原有文档授权仍由文档所有者管理。"
                disabled={!ready} onConfirm={() => mutate(signal => request.post('/groups/' + detail.id + '/leave', {}, { signal }), '已退出小组', () => choose(0))}>
                <Button disabled={!ready} danger>退出小组</Button></Popconfirm>}
          </Space>
          {manager && <div className="group-section">
            <Typography.Paragraph>按已注册用户名邀请；对方接受后才成为成员。成员与待接受邀请合计最多200人。</Typography.Paragraph>
            <Space wrap><Input aria-label="邀请用户名" value={username} maxLength={50} disabled={!ready}
              onChange={e => setUsername(e.target.value)} autoComplete="off" />
              <Button disabled={!ready || !username.trim()} onClick={() => mutate(signal =>
                request.post('/groups/' + detail.id + '/invitations', { username: username.trim() }, { signal }), '邀请已发送',
                () => setUsername(''))}>发送邀请</Button></Space>
          </div>}
          <List rowKey="userId" dataSource={detail.members} renderItem={member => <List.Item actions={[
            detail.role === 'owner' && member.userId !== detail.ownerId && <Select key="role" aria-label={member.username + ' 的小组角色'}
              options={options} value={member.role} disabled={!ready} onChange={role => mutate(signal =>
                request.put('/groups/' + detail.id + '/members/' + member.userId, { role }, { signal }), '成员角色已更新')} />,
            manager && member.userId !== detail.currentUserId && member.userId !== detail.ownerId &&
              (detail.role === 'owner' || member.role === 'member') && <Popconfirm overlayClassName="document-action-confirm" key="remove" title={'移除 ' + member.username + '？'}
                description="停止小组访问；不会自动修改文档单独授权。" disabled={!ready} onConfirm={() => mutate(signal =>
                  request.delete('/groups/' + detail.id + '/members/' + member.userId, { signal }), '成员已移出小组')}>
                <Button disabled={!ready} danger>移除成员</Button></Popconfirm>,
          ].filter(Boolean)}><List.Item.Meta title={member.nickname || member.username}
            description={member.username} /><Tag>{roles[member.role]}</Tag></List.Item>} />
          {manager && <><Typography.Title level={5}>待接受邀请</Typography.Title>
            <List rowKey="userId" dataSource={detail.invitations} locale={{ emptyText: '没有待接受邀请' }}
              renderItem={invitation => <List.Item actions={[<Button key="cancel" disabled={!ready} onClick={() => mutate(signal =>
                request.delete('/groups/' + detail.id + '/invitations/' + invitation.userId, { signal, params: { invitationVersion: invitation.invitationVersion } }), '邀请已取消')}>取消邀请</Button>]}>
                <List.Item.Meta title={invitation.nickname || invitation.username} description={invitation.username + ' · ' + invitation.createdAt} />
              </List.Item>} /></>}
        </>}
      </Card>}
    </main>
    {fields && <GroupFields key={fields.id || 'create'} fields={fields} busy={busy} uncertain={uncertain} error={error}
      onClose={() => { if (!busy) setFields(null) }} onReview={review}
      onSave={values => mutate(signal => fields.id ? request.put('/groups/' + fields.id, values, { signal }) :
        request.post('/groups', values, { signal }), fields.id ? '小组资料已保存' : '小组已创建',
        data => { setFields(null); if (!fields.id) choose(data.id, 1, false) })} />}
    {showGuide && <UserGuide initialSection="groups" onClose={() => setShowGuide(false)} />}
  </Layout>
}
