import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, List, Space, Typography } from 'antd'
import { confirmCopy } from '../api/copyDocuments'
import usePendingCopies, { sameCopyIdentity } from '../api/usePendingCopies'
import { usePageSession } from '../auth/PageSessionContext'

export default function PendingCopies({ onCreated }) {
  const pageSession = usePageSession()
  const pending = usePendingCopies()
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const alive = useRef(false), attempt = useRef(null)
  useEffect(() => {
    alive.current = true
    const cancel = () => { const old = attempt.current; attempt.current = null; old?.controller.abort(); if (alive.current) { setBusy(false); setError('') } }
    const storageChanged = () => { if (attempt.current && !sameCopyIdentity(attempt.current.identity)) cancel() }
    window.addEventListener('storage', storageChanged)
    window.addEventListener('copage-auth-changed', cancel)
    return () => { alive.current = false; cancel(); window.removeEventListener('storage', storageChanged); window.removeEventListener('copage-auth-changed', cancel) }
  }, [])
  async function confirm(summary) {
    if (attempt.current || !pageSession.current() || !sameCopyIdentity(pending.identity)) return
    const next = { controller: new AbortController(), identity: pageSession.identity, accepted: false }
    attempt.current = next; setBusy(true); setError('')
    const current = () => alive.current && attempt.current === next && !next.controller.signal.aborted && sameCopyIdentity(next.identity)
    try {
      let response = await confirmCopy(summary, pageSession.options({ signal: next.controller.signal, deferCleanup: true }))
      if (!current()) return
      response = await response.confirmTracking()
      if (!current()) return
      next.accepted = true
      onCreated(response.data)
    } catch (failure) {
      if (current()) setError(next.accepted ? '副本已确认，页面未能打开；请从我的文档查看已创建副本。'
        : failure?.message || '暂时无法确认原副本，原记录保留；可稍后继续。')
    } finally {
      if (attempt.current === next) { attempt.current = null; if (alive.current) setBusy(false) }
    }
  }
  if (!pending.records.length && !pending.error && !error) return null
  return <Card className="copy-creation-review" role="region" aria-label="待确认的副本"
    title="待确认的副本" extra={<Button disabled={busy || pending.loading} onClick={pending.refresh}>刷新记录</Button>}>
    <Typography.Paragraph>这些创建尚未取得确认。即使来源已删除或撤权，仍可确认已经创建的私人副本；未创建的请求仍须通过现时来源权限检查。</Typography.Paragraph>
    <Typography.Paragraph type="secondary">原来源、标题与创建标识按当前账号和服务保存在本浏览器，不保存正文。关闭标签或重登原账号后仍可主动确认，不会自动重发；清除站点数据或换浏览器可能失去记录。</Typography.Paragraph>
    {pending.error && <Alert type="warning" showIcon message={pending.error} />}
    {error && <Alert type="warning" showIcon message={error} />}
    <List rowKey="key" dataSource={pending.records} renderItem={record => <List.Item actions={[
      <Button key="confirm" loading={busy} disabled={busy || pending.loading} onClick={() => confirm(record)}>确认原副本</Button>,
    ]}>
      <List.Item.Meta title={record.body.title || '使用来源默认标题的副本'} description={<Space direction="vertical" size={2}>
        <span>来源文档 #{record.sourceId}</span><span>准备于 {new Date(record.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
      </Space>} />
    </List.Item>} />
  </Card>
}
