import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, List, Space, Typography } from 'antd'
import { confirmProjectDocument, projectDocumentIdentity, sameProjectDocumentIdentity } from '../api/projectDocuments'
import usePendingProjectDocuments from '../api/usePendingProjectDocuments'
import { subscribeProjectDocumentEvents } from '../api/projectDocumentEvents'

export default function PendingProjectDocuments({ contextKey, disabled, onBusyChange, onCreated }) {
  const pending = usePendingProjectDocuments()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const attempt = useRef(null), alive = useRef(false), scope = useRef(contextKey)
  scope.current = contextKey
  useEffect(() => {
    alive.current = true
    setBusy(false); setError('')
    const cancel = () => {
      const old = attempt.current; attempt.current = null; old?.controller.abort()
      if (alive.current) { setBusy(false); setError('') }
      if (old) onBusyChange(false)
    }
    const unsubscribe = subscribeProjectDocumentEvents({ eventTarget: window, getStorage: () => localStorage,
      readIdentity: projectDocumentIdentity, onIdentityInvalidated: cancel })
    return () => { alive.current = false; unsubscribe(); cancel() }
  }, [contextKey, onBusyChange])
  async function confirm(record) {
    if (attempt.current || disabled || !sameProjectDocumentIdentity(pending.identity)) return
    const next = { controller: new AbortController(), identity: projectDocumentIdentity(), contextKey, accepted: false }
    attempt.current = next; setBusy(true); onBusyChange(true); setError('')
    const current = () => alive.current && attempt.current === next && !next.controller.signal.aborted && scope.current === next.contextKey && sameProjectDocumentIdentity(next.identity)
    try {
      let response = await confirmProjectDocument(record, { signal: next.controller.signal, deferCleanup: true })
      if (!current()) return
      response = response.confirmTracking(); next.accepted = true; onCreated(response.data)
    } catch (failure) {
      if (current()) setError(next.accepted ? '原文档已确认，请从我的文档打开。'
        : ([400, 401, 403, 404].includes(failure?.code) && typeof failure.message === 'string' && failure.message
          ? failure.message : '暂时无法取得原创建结果。') + ' 原记录保留，可稍后继续确认。')
    } finally {
      if (attempt.current === next) { attempt.current = null; if (alive.current) { setBusy(false); onBusyChange(false) } }
    }
  }
  if (!pending.records.length && !pending.error && !error) return null
  return <Card className="project-document-pending project-section" role="region" aria-label="待确认的新文档" title="待确认的新文档"
    extra={<Button disabled={busy || pending.loading} onClick={pending.refresh}>刷新记录</Button>}>
    <Typography.Paragraph>找回原项目中的同一次创建，不重复建文档。原关联后来被移除时，确认不会重新加入项目。</Typography.Paragraph>
    <Typography.Paragraph type="secondary">原项目、标题和起始模板只在当前浏览器按账号保留；刷新或重登原账号后可继续。清除站点数据或换浏览器可能失去记录，请先核对已有文档。</Typography.Paragraph>
    {pending.error && <Alert className="project-read-alert" type="warning" showIcon message={pending.error} />}
    {error && <Alert className="project-read-alert" type="warning" showIcon message={error} />}
    <List rowKey="key" dataSource={pending.records} renderItem={record => <List.Item actions={[
      <Button key="confirm" disabled={busy || pending.loading || disabled} loading={busy} onClick={() => confirm(record)}>确认原创建</Button>,
    ]}><List.Item.Meta title={record.title} description={<Space direction="vertical" size={2}>
      <span>{record.projectName} · 项目 #{record.projectId}</span>
      <span>{record.templateId ? '使用内置模板' : '空白文档'} · 准备于 {new Date(record.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
    </Space>} /></List.Item>} />
  </Card>
}
