import { useEffect, useState } from 'react'
import { Alert, Button, Card, List, Space, Typography } from 'antd'
import { Link } from 'react-router-dom'
import request from '../api/request'

const counters = [
  ['activeGroupCount', '我加入的小组', '/groups'],
  ['personalProjectCount', '个人项目', '/projects?scope=personal'],
  ['groupProjectCount', '小组项目', '/projects?scope=group'],
  ['personalTemplateCount', '我的模板', '/templates?source=personal'],
]

export default function WorkspaceOverview() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setData(null)
    request.get('/workspace/overview', { signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) setData(data) })
      .catch(failure => { if (!controller.signal.aborted) setError([400, 403, 404].includes(failure?.code)
        ? failure.message : '小组与项目概览暂时无法加载，请重试。') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh])
  return <Card title={<Typography.Title level={3}>小组与项目</Typography.Title>} className="workbench-recent cp-workspace-overview"
    extra={<Button type="text" disabled={loading} onClick={() => setRefresh(value => value + 1)}>刷新概览</Button>}
    loading={loading}>
    {error && <Alert type="error" showIcon message={error}
      action={<Button onClick={() => setRefresh(value => value + 1)}>重试组织概览</Button>} />}
    {data && <>
      <div className="cp-workspace-counts" aria-label="小组与项目概览">
        {counters.map(([key, label, path]) => <Link key={key} to={path} aria-label={'查看' + label + '，共' + data[key] + '个'}>
          <span>{label}</span><strong>{data[key]}</strong>
        </Link>)}
      </div>
      <Typography.Paragraph className="cp-workspace-permission" type="secondary">显示未归档的小组和项目；加入小组仍需逐篇文档授权。</Typography.Paragraph>
      {data.pendingInvitationCount > 0 ? <>
        <Typography.Title level={5}>{'待处理的小组邀请（' + data.pendingInvitationCount + '）'}</Typography.Title>
        <List rowKey="groupId" dataSource={data.invitations} renderItem={invitation => <List.Item>
          <List.Item.Meta title={invitation.name}
            description={invitation.inviterNickname + '（' + invitation.inviterUsername + '）邀请你加入 · ' + invitation.createdAt} />
        </List.Item>} />
        <Space wrap><Link to="/groups">查看并处理邀请</Link>
          {data.pendingInvitationCount > data.invitations.length && <Typography.Text type="secondary">更多邀请可在我的小组查看</Typography.Text>}</Space>
      </> : <Typography.Paragraph className="cp-workspace-empty-invitations">暂无待处理的小组邀请。可以创建小组，或请同伴按用户名邀请你。</Typography.Paragraph>}
    </>}
    {!loading && !data && !error && <Typography.Paragraph>重试后可查看当前组织资料。</Typography.Paragraph>}
  </Card>
}
