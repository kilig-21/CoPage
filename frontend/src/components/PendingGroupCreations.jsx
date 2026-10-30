import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, List, Space, Typography } from 'antd'
import { confirmGroupCreation } from '../api/createGroup'
import usePendingGroupCreations, { groupCreationIdentity, sameGroupCreationIdentity } from '../api/usePendingGroupCreations'

export default function PendingGroupCreations({ onCreated, onBusyChange, contextKey, disabled, expectedIdentity, assertSession }) {
  const pending = usePendingGroupCreations({ expectedIdentity, assertSession })
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const alive = useRef(false), attempt = useRef(null)
  useEffect(() => {
    alive.current = true
    const cancel = () => {
      const old = attempt.current; attempt.current = null; old?.controller.abort()
      if (alive.current) { setBusy(false); setError('') }
      if (old) onBusyChange(false)
    }
    window.addEventListener('storage', cancel); window.addEventListener('copage-auth-changed', cancel)
    return () => { alive.current = false; cancel(); window.removeEventListener('storage', cancel); window.removeEventListener('copage-auth-changed', cancel) }
  }, [contextKey, onBusyChange])
  async function confirm(record) {
    if (attempt.current || disabled || !sameGroupCreationIdentity(pending.identity)) return
    try { assertSession?.() } catch (failure) { setError(failure.message); return }
    const next = { controller: new AbortController(), identity: expectedIdentity || groupCreationIdentity(), accepted: false }
    attempt.current = next; setBusy(true); onBusyChange(true); setError('')
    const current = () => alive.current && attempt.current === next && !next.controller.signal.aborted && sameGroupCreationIdentity(next.identity)
    try {
      let response = await confirmGroupCreation(record, { signal: next.controller.signal, expectedIdentity: next.identity, deferCleanup: true })
      if (!current()) return
      assertSession?.(next.controller.signal)
      response = response.confirmTracking(); next.accepted = true
      onCreated(response.data)
    } catch (failure) {
      if (current()) setError(next.accepted ? '小组已确认，请从我的小组查看原小组。'
        : (failure?.message || '暂时无法确认原小组。') + ' 原记录保留，可稍后继续。')
    } finally {
      if (attempt.current === next) { attempt.current = null; if (alive.current) { setBusy(false); onBusyChange(false) } }
    }
  }
  if (!pending.records.length && !pending.error && !error) return null
  return <Card className="group-creation-review group-section" role="region" aria-label="待确认的小组" title="待确认的小组"
    extra={<Button disabled={busy || pending.loading} onClick={pending.refresh}>刷新记录</Button>}>
    <Typography.Paragraph>按原请求确认已创建的小组，不按同名资料猜测，也不会覆盖改名或恢复归档。普通列表刷新不确认这些创建。</Typography.Paragraph>
    <Typography.Paragraph type="secondary">原名称、简介和创建标识仅保存在当前浏览器，按账号和服务隔离；刷新或重登原账号后可继续。清除站点数据或换浏览器可能失去记录。</Typography.Paragraph>
    {pending.error && <Alert type="warning" showIcon message={pending.error} />}
    {error && <Alert type="warning" showIcon message={error} />}
    <List rowKey="key" dataSource={pending.records} renderItem={record => <List.Item actions={[
      <Button key="confirm" loading={busy} disabled={busy || pending.loading || disabled} onClick={() => confirm(record)}>确认原小组</Button>,
    ]}>
      <List.Item.Meta title={record.name} description={<Space direction="vertical" size={2}>
        <span>{record.description || '未填写简介'}</span><span>准备于 {new Date(record.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
      </Space>} />
    </List.Item>} />
  </Card>
}
