import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

// 仅用于调用方创建的隔离生产栈；凭据/令牌只在内存中，不输出或写辅助文件。
function client(port) {
  const tokens = new Map()
  return async (credentials, path, method = 'GET', body, expectedStatus = 200) => {
    let token = tokens.get(credentials.username)
    if (!token) {
      const response = await fetch('http://127.0.0.1:' + port + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials), signal: AbortSignal.timeout(5000),
      })
      assert.equal(response.status, 200, '隔离组织验收账号登录失败')
      token = (await response.json()).data.token
      tokens.set(credentials.username, token)
    }
    const response = await fetch('http://127.0.0.1:' + port + '/api' + path, {
      method, signal: AbortSignal.timeout(5000),
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    assert.equal(response.status, expectedStatus, method + ' ' + path + ' HTTP 状态不符')
    const payload = await response.json()
    if (expectedStatus === 200) assert.equal(payload.code, 0, method + ' ' + path + '业务拒绝')
    return payload.data
  }
}
export const organizationSnapshotSql = [
  'SELECT id,HEX(name),HEX(description),owner_id,is_archived,create_time,update_time FROM copage_group ORDER BY id;',
  'SELECT group_id,user_id,role,joined_at FROM group_member ORDER BY group_id,user_id;',
  'SELECT group_id,user_id,inviter_id,status,invitation_version,create_time,update_time FROM group_invitation ORDER BY group_id,user_id;',
  'SELECT id,HEX(name),HEX(description),owner_id,group_id,is_archived,create_time,update_time FROM copage_project ORDER BY id;',
  'SELECT project_id,doc_id,association_id,added_by,create_time FROM project_document ORDER BY project_id,doc_id;',
  'SELECT user_id FROM personal_template_owner ORDER BY user_id;',
  'SELECT id,owner_id,HEX(name),HEX(description),category,HEX(content),content_bytes,source_revision,version,create_time,update_time FROM personal_template ORDER BY id;',
].join('\n')

export async function createOrganizationFixture({ port, owner, viewer, outsider, document }) {
  const api = client(port), marker = randomBytes(6).toString('hex')
  const identities = {
    owner: await api(owner, '/account/me'),
    viewer: await api(viewer, '/account/me'),
    outsider: await api(outsider, '/account/me'),
  }
  const pending = { username: 'invite' + marker, password: randomBytes(24).toString('hex') }
  await api(owner, '/auth/register', 'POST', pending)
  const pendingIdentity = await api(pending, '/account/me')
  const group = await api(owner, '/groups', 'POST', { name: '恢复小组-' + marker, description: '文档逐篇授权' })
  const invite = async credentials => {
    await api(owner, '/groups/' + group.id + '/invitations', 'POST', { username: credentials.username })
    return (await api(credentials, '/groups/invitations')).list.find(row => row.groupId === group.id)
  }
  for (const credentials of [viewer, outsider]) {
    const invitation = await invite(credentials)
    assert.ok(invitation)
    await api(credentials, '/groups/' + group.id + '/invitation', 'POST', { accept: true, invitationVersion: invitation.invitationVersion })
  }
  await api(owner, '/groups/' + group.id + '/members/' + identities.viewer.id, 'PUT', { role: 'admin' })
  const oldInvitation = await invite(pending)
  await api(owner, '/groups/' + group.id + '/invitations/' + pendingIdentity.id + '?invitationVersion=' + oldInvitation.invitationVersion, 'DELETE')
  const currentInvitation = await invite(pending)
  assert.equal(currentInvitation.invitationVersion, oldInvitation.invitationVersion + 1)
  const hidden = await api(outsider, '/doc', 'POST', { title: '隐藏组织资料-' + marker, templateId: 'meeting' })
  const groupProject = await api(owner, '/projects', 'POST', { name: '恢复组项目-' + marker, description: '共享分类，不共享授权', groupId: group.id })
  await api(owner, '/projects/' + groupProject.id + '/documents', 'POST', { docId: document.id })
  await api(outsider, '/projects/' + groupProject.id + '/documents', 'POST', { docId: hidden.id })
  const personalProject = await api(owner, '/projects', 'POST', { name: '恢复个人项目-' + marker, groupId: 0 })
  await api(owner, '/projects/' + personalProject.id + '/documents', 'POST', { docId: document.id })
  const viewerProject = await api(viewer, '/projects', 'POST', { name: '恢复只读资料分类-' + marker, groupId: 0 })
  await api(viewer, '/projects/' + viewerProject.id + '/documents', 'POST', { docId: document.id })
  const viewerGroupProject = await api(viewer, '/projects', 'POST', { name: '管理员创建项目-' + marker, groupId: group.id })
  const archivedProject = await api(owner, '/projects', 'POST', { name: '已归档项目-' + marker, groupId: group.id })
  await api(owner, '/projects/' + archivedProject.id + '/documents', 'POST', { docId: document.id })
  await api(owner, '/projects/' + archivedProject.id + '/archive', 'POST')
  const archivedGroup = await api(owner, '/groups', 'POST', { name: '已归档小组-' + marker, description: '保留项目和成员' })
  await api(owner, '/groups/' + archivedGroup.id + '/invitations', 'POST', { username: viewer.username })
  const archivedGroupProject = await api(owner, '/projects', 'POST', { name: '归档小组内的项目-' + marker, groupId: archivedGroup.id })
  await api(owner, '/projects/' + archivedGroupProject.id + '/documents', 'POST', { docId: document.id })
  await api(owner, '/groups/' + archivedGroup.id + '/archive', 'POST')
  const ownerTemplate = await api(owner, '/personal-templates', 'POST', {
    docId: document.id, name: '恢复私人模板-' + marker, category: 'planning', description: '冻结含图正文',
  })
  const initialTemplate = await api(owner, '/personal-templates/' + ownerTemplate.id)
  await api(owner, '/personal-templates/' + ownerTemplate.id, 'PUT', {
    name: '改名后的私人模板-' + marker, category: 'learning', description: '元数据版本也须恢复', expectedVersion: initialTemplate.version,
  })
  const viewerTemplate = await api(viewer, '/personal-templates', 'POST', {
    docId: document.id, name: '恢复只读副本模板-' + marker, category: 'collaboration', description: '只供本人',
  })
  const outsiderTemplate = await api(outsider, '/personal-templates', 'POST', {
    docId: hidden.id, name: '无来源授权账号自己的模板-' + marker, category: 'planning',
  })
  const templates = await Promise.all([
    api(owner, '/personal-templates/' + ownerTemplate.id),
    api(viewer, '/personal-templates/' + viewerTemplate.id),
    api(outsider, '/personal-templates/' + outsiderTemplate.id),
  ])
  assert.deepEqual(templates[0].content, document.content)
  assert.equal(templates[0].sourceRevision, document.revision)
  assert.equal(templates[0].version, 2)
  assert.deepEqual(templates[1].content, document.content)
  const groupViews = await Promise.all([owner, viewer, outsider].map(credentials => api(credentials, '/projects/' + groupProject.id)))
  assert.deepEqual(groupViews.map(value => value.total), [1, 1, 1])
  assert.deepEqual(groupViews.map(value => value.list.map(row => row.id)), [[document.id], [document.id], [hidden.id]])
  console.log('PASS: 隔离源库实际建立小组角色/邀请代次、个人/组项目、隐藏文档过滤、归档状态及含图私人模板')
  return { marker, owner, viewer, outsider, pending, identities, pendingIdentity,
    document, hidden, group, archivedGroup, groupProject, personalProject, viewerProject,
    viewerGroupProject, archivedProject, archivedGroupProject, oldInvitation, currentInvitation,
    templates, groupViews }
}
export async function verifyOrganizationRecovery({ port, fixture, readOnly = true }) {
  const api = client(port), f = fixture
  if (readOnly) {
    const group = await api(f.owner, '/groups/' + f.group.id)
    assert.equal(group.ownerId, f.identities.owner.id)
    assert.deepEqual(group.members.map(member => [member.userId, member.role]).sort((a, b) => a[0] - b[0]),
      [[f.identities.owner.id, 'owner'], [f.identities.viewer.id, 'admin'], [f.identities.outsider.id, 'member']].sort((a, b) => a[0] - b[0]))
    assert.equal(group.invitations.length, 1)
    assert.equal(group.invitations[0].userId, f.pendingIdentity.id)
    assert.equal(group.invitations[0].invitationVersion, f.currentInvitation.invitationVersion)
    const inbox = await api(f.pending, '/groups/invitations')
    assert.equal(inbox.total, 1)
    assert.equal(inbox.list[0].groupId, f.group.id)
    assert.equal(inbox.list[0].invitationVersion, f.currentInvitation.invitationVersion)
    await api(f.viewer, '/groups/' + f.archivedGroup.id, 'GET', undefined, 404)
    const archived = await api(f.owner, '/groups?archived=true')
    assert.deepEqual(archived.list.map(value => value.id), [f.archivedGroup.id])
    for (const [index, credentials] of [f.owner, f.viewer, f.outsider].entries()) {
      const project = await api(credentials, '/projects/' + f.groupProject.id)
      assert.equal(project.total, 1)
      assert.deepEqual(project.list.map(row => [row.id, row.associationId, row.permission]),
        f.groupViews[index].list.map(row => [row.id, row.associationId, row.permission]))
      const summary = await api(credentials, '/projects?groupId=' + f.group.id)
      assert.equal(summary.list.find(row => row.id === f.groupProject.id).visibleDocumentCount, 1)
      assert.ok(!project.list.some(row => Object.hasOwn(row, 'content')))
      const template = await api(credentials, '/personal-templates/' + f.templates[index].id)
      assert.deepEqual(template, f.templates[index], '私人正文、来源版本和元数据版本须恢复')
      const list = await api(credentials, '/personal-templates')
      assert.equal(list.total, 1)
      assert.equal(list.usage.count, 1)
      assert.ok(list.usage.bytes > 0 && list.usage.bytes <= list.byteLimit)
      assert.ok(!Object.hasOwn(list.list[0], 'content'))
    }
    await api(f.viewer, '/projects/' + f.personalProject.id, 'GET', undefined, 403)
    await api(f.owner, '/projects/' + f.viewerProject.id, 'GET', undefined, 403)
    await api(f.owner, '/doc/' + f.hidden.id, 'GET', undefined, 403)
    await api(f.viewer, '/doc/' + f.hidden.id, 'GET', undefined, 403)
    await api(f.outsider, '/doc/' + f.document.id, 'GET', undefined, 403)
    await api(f.viewer, '/personal-templates/' + f.templates[0].id, 'GET', undefined, 403)
    await api(f.owner, '/personal-templates/' + f.templates[1].id, 'GET', undefined, 403)
    await api(f.owner, '/projects/' + f.archivedProject.id, 'GET', undefined, 404)
    await api(f.owner, '/projects/' + f.archivedGroupProject.id, 'GET', undefined, 404)
    console.log('PASS: 恢复后的组角色/邀请版本、归档、关联UUID、可见计数及私人模板权限/配额/全文版本保持')
    return
  }
  // 在原搜索/冷Redis验收之后写入，避免新建副本改变原唯一搜索命中断言。
  await api(f.pending, '/groups/' + f.group.id + '/invitation', 'POST', {
    accept: true, invitationVersion: f.oldInvitation.invitationVersion,
  }, 400)
  const inbox = await api(f.pending, '/groups/invitations')
  assert.equal(inbox.list[0].invitationVersion, f.currentInvitation.invitationVersion)
  await api(f.pending, '/groups/' + f.group.id + '/invitation', 'POST', {
    accept: true, invitationVersion: f.currentInvitation.invitationVersion,
  })
  assert.equal((await api(f.pending, '/projects/' + f.groupProject.id)).total, 0)
  await api(f.pending, '/doc/' + f.document.id, 'GET', undefined, 403)
  await api(f.owner, '/groups/' + f.group.id + '/members/' + f.identities.viewer.id, 'PUT', { role: 'member' })
  assert.equal((await api(f.viewer, '/projects/' + f.viewerGroupProject.id)).canManage, false)
  await api(f.viewer, '/projects/' + f.viewerGroupProject.id, 'PUT', { name: '不应保存', description: '' }, 403)
  assert.equal((await api(f.viewer, '/doc/' + f.document.id)).permission, 1)
  await api(f.owner, '/personal-templates/' + f.templates[0].id, 'PUT', {
    name: '不应覆盖', category: 'planning', expectedVersion: 1,
  }, 400)
  for (const [index, credentials] of [f.owner, f.viewer].entries()) {
    const template = f.templates[index]
    const created = await api(credentials, '/personal-templates/' + template.id + '/documents', 'POST', {
      title: '恢复后独立实例-' + f.marker + '-' + index, expectedVersion: template.version,
    })
    const detail = await api(credentials, '/doc/' + created.id)
    assert.deepEqual(detail.content, f.document.content)
    assert.equal(detail.revision, 0)
    assert.equal(detail.ownerId, index === 0 ? f.identities.owner.id : f.identities.viewer.id)
    assert.deepEqual((await api(credentials, '/doc/' + created.id + '/history/0')).content, f.document.content)
    assert.equal((await api(credentials, '/doc/' + created.id + '/collaborators')).length, 0)
    await api(index === 0 ? f.viewer : f.owner, '/doc/' + created.id, 'GET', undefined, 403)
  }
  await api(f.owner, '/projects/' + f.archivedProject.id + '/restore', 'POST')
  assert.equal((await api(f.owner, '/projects/' + f.archivedProject.id)).total, 1)
  await api(f.owner, '/groups/' + f.archivedGroup.id + '/restore', 'POST')
  assert.equal((await api(f.owner, '/groups/' + f.archivedGroup.id)).invitations.length, 0)
  assert.equal((await api(f.owner, '/projects/' + f.archivedGroupProject.id)).total, 1)
  console.log('PASS: 恢复后旧邀请/旧模板版本拒绝、当前邀请可接受且无文档授权、管理员降权生效、私人模板复用及项目/小组恢复可继续')
}
