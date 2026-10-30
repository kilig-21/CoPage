import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Drawer, Input, List, Modal, Space, Spin, Tag, Typography } from 'antd'
import { usePageRequest } from '../auth/PageSessionContext'
import DocumentPreview from './DocumentPreview'
import useHistoryRestore from '../api/useHistoryRestore'

const rejectedCodes = new Set([400, 401, 403, 404, 40901, 40902, 40903, 40904])
const mutationError = (error, uncertain) => rejectedCodes.has(error?.code)
  ? error.message || '请求被拒绝，请核对后重试' : uncertain

export default function HistoryDrawer({ docId, isOwner, canRestore, onClose }) {
  const request = usePageRequest()
  const [modal, contextHolder] = Modal.useModal()
  const [storedHistory, setHistory] = useState(null)
  const historyContext = useRef(null)
  const [versions, setVersions] = useState([])
  const [selected, setSelected] = useState(null)
  const [storedPreview, setPreview] = useState(null)
  const previewContext = useRef(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const previewRegion = useRef(null)
  const previewActions = useRef(null)
  const restoreFeedbackRegion = useRef(null)
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [storedRetention, setRetention] = useState(null)
  const alive = useRef(true)
  const selectionRequest = useRef(0)
  const requests = useRef(new Set())
  const listRequest = useRef(null)
  const previewRequest = useRef(null)
  const mutation = useRef(null)
  const ownerRef = useRef(isOwner)
  ownerRef.current = isOwner
  const restoreOperation = useHistoryRestore(docId, isOwner, canRestore, () => load())
  const history = restoreOperation.isCurrent(historyContext.current) ? storedHistory : null
  const preview = restoreOperation.isCurrent(previewContext.current) ? storedPreview : null
  const retention = history ? storedRetention : null
  const writing = busy || restoreOperation.busy
  const restoreError = restoreOperation.error
  const restoreNotice = restoreOperation.notice?.message
  const restoreRequestId = restoreOperation.target?.requestId
  useEffect(() => {
    if (!restoreError && !restoreNotice && !restoreRequestId) return
    const frame = requestAnimationFrame(() => {
      const action = previewActions.current
      const feedback = restoreFeedbackRegion.current
      const body = feedback?.closest('.ant-drawer-body')
      if (!action || !feedback || !body) return
      const bounds = action.getBoundingClientRect()
      const bodyBounds = body.getBoundingClientRect()
      // Only reveal a new result while the user is still beside its controls.
      // Keep keyboard focus and leave readers who have scrolled away in place.
      if (bounds.bottom > Math.max(0, bodyBounds.top) &&
          bounds.top < Math.min(window.innerHeight, bodyBounds.bottom)) {
        feedback.scrollIntoView({ block: 'nearest', behavior: 'instant' })
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [restoreError, restoreNotice, restoreRequestId])
  const base = `/doc/${docId}/history`
  const beginRequest = () => {
    const context = restoreOperation.captureContext()
    if (!context) return null
    const controller = new AbortController()
    controller.context = context
    requests.current.add(controller)
    return controller
  }
  const isLive = controller => alive.current && !controller.signal.aborted && restoreOperation.isCurrent(controller.context)
  const beginMutation = () => {
    if (!alive.current || mutation.current || restoreOperation.snapshot().busy || !ownerRef.current) return null
    const controller = beginRequest()
    if (!controller) return null
    mutation.current = controller
    setBusy(true); setError(''); setNotice('')
    return controller
  }
  const finishMutation = controller => {
    requests.current.delete(controller)
    if (mutation.current === controller) {
      mutation.current = null
      if (alive.current) setBusy(false)
    }
  }
  const load = async (before) => {
    listRequest.current?.abort()
    const controller = beginRequest()
    if (!controller) return
    listRequest.current = controller
    setLoading(true)
    try {
      const response = await request.get(base, { params: before == null ? {} : { beforeRevision: before }, ...restoreOperation.config(controller.context, controller.signal) })
      if (!isLive(controller)) return
      historyContext.current = controller.context
      setHistory(response.data)
      setVersions(old => before == null ? response.data.list : [...old, ...response.data.list])
      if (isOwner) {
        const policy = await request.get(base + '/retention', restoreOperation.config(controller.context, controller.signal))
        if (isLive(controller)) setRetention(policy.data)
      }
      if (isLive(controller)) setError('')
    } catch (ex) { if (isLive(controller)) setError(ex.message || '历史加载失败') }
    finally {
      requests.current.delete(controller)
      if (listRequest.current === controller) {
        listRequest.current = null
        if (alive.current) {
          setLoading(false)
          if (!isLive(controller)) setError('当前账号暂时无法核对，请恢复账号读取后刷新历史列表。')
        }
      }
    }
  }
  useEffect(() => {
    alive.current = true
    historyContext.current = null; previewContext.current = null
    setHistory(null); setVersions([]); setSelected(null); setPreview(null); setPreviewLoading(false)
    setPreviewError(''); setRetention(null); setBusy(false); setLoading(false); setError(''); setNotice(''); setName('')
    load()
    return () => {
      alive.current = false
      selectionRequest.current++
      for (const controller of requests.current) controller.abort()
      requests.current.clear()
      listRequest.current = null; previewRequest.current = null; mutation.current = null
    }
  }, [docId, restoreOperation.identityEpoch])
  const choose = async (revision) => {
    previewRequest.current?.abort()
    const controller = beginRequest()
    if (!controller) return
    previewRequest.current = controller
    const ticket = ++selectionRequest.current
    setSelected(revision); setPreview(null); setPreviewLoading(true); setPreviewError(''); setName('')
    try {
      const response = await request.get(`${base}/${revision}`, restoreOperation.config(controller.context, controller.signal))
      if (isLive(controller) && ticket === selectionRequest.current) {
        previewContext.current = controller.context
        setPreview(response.data.content); setError('')
        setName(history?.namedVersions.find(version => version.revision === revision)?.name || '')
      }
    } catch (ex) { if (isLive(controller) && ticket === selectionRequest.current) setPreviewError(ex.message || '版本读取失败') }
    finally {
      requests.current.delete(controller)
      if (previewRequest.current === controller) previewRequest.current = null
      if (alive.current && ticket === selectionRequest.current) {
        setPreviewLoading(false)
        requestAnimationFrame(() => {
          if (!isLive(controller) || ticket !== selectionRequest.current) return
          previewRegion.current?.focus({ preventScroll: true })
          previewRegion.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
        })
      }
    }
  }
  const mark = async (remove = false) => {
    const controller = beginMutation()
    if (!controller) return
    try {
      if (remove) await request.delete(`${base}/${selected}/name`, restoreOperation.config(controller.context, controller.signal))
      else await request.put(`${base}/${selected}/name`, { name }, restoreOperation.config(controller.context, controller.signal))
      if (isLive(controller)) { setNotice(remove ? '已取消重要版本标记' : '重要版本已保存'); await load() }
    } catch (ex) { if (isLive(controller)) setError(mutationError(ex, '重要版本更新结果未确认，请刷新列表核对后再决定是否重试')) }
    finally { finishMutation(controller) }
  }
  const restore = (targetRevision, expectedRevision, context) => {
    if (!alive.current || mutation.current || !restoreOperation.isCurrent(context)) return
    return restoreOperation.start(targetRevision, expectedRevision)
  }
  const named = history?.namedVersions || []
  const compact = async (context) => {
    if (restoreOperation.snapshot().target || !restoreOperation.isCurrent(context)) return
    const controller = beginMutation()
    if (!controller) return
    try {
      await request.post(base + '/compact', { expectedRevision: retention.currentRevision, beforeRevision: retention.proposedMinimumRevision }, restoreOperation.config(controller.context, controller.signal))
      if (isLive(controller)) { setSelected(null); setPreview(null); setNotice('历史已清理，重要版本继续保留'); await load() }
    } catch (ex) { if (isLive(controller)) setError(mutationError(ex, '历史清理结果未确认，请刷新列表和保留范围后再决定是否重试')) }
    finally { finishMutation(controller) }
  }
  const rows = [...new Map([
    ...(history && !versions.some(v => v.revision === history.minimumRevision)
      ? [{ revision: history.minimumRevision, name: history.minimumRevision === 0 ? '初始版本' : '保留范围起点' }] : []),
    ...(history && !versions.some(v => v.revision === history.currentRevision)
      ? [{ revision: history.currentRevision, name: '当前版本' }] : []),
    ...(history ? versions : []), ...named,
  ].map(v => [v.revision, v])).values()].sort((a, b) => b.revision - a.revision)
  const restoreFeedback = (restoreError || restoreOperation.notice || restoreOperation.target) &&
    <div ref={restoreFeedbackRegion} className="history-restore-feedback" role="region" aria-label="历史恢复结果">
    {restoreOperation.error && <Alert type="warning" showIcon message={restoreOperation.error} />}
    {restoreOperation.notice && <Alert showIcon type={restoreOperation.notice.type} message={restoreOperation.notice.message} />}
    {restoreOperation.target && <Alert type="warning" showIcon
      message={`待确认的恢复：版本 ${restoreOperation.target.targetRevision}`}
      description="原请求已保存在此浏览器。关闭窗口、刷新或重新登录原账号后，仍可在本篇历史中确认；查看其他版本不会改变原目标。请先确认结果，再恢复其他版本或清理历史。"
      action={<Space wrap>
        <Button loading={restoreOperation.busy} disabled={writing || !isOwner} onClick={() => {
          if (!mutation.current) restoreOperation.retryOriginal()
        }}>确认原恢复</Button>
        <Button disabled={writing} onClick={() => {
          const confirmation = restoreOperation.prepareEndWaiting()
          if (!confirmation) return
          modal.confirm({ className: 'history-confirm-modal', title: '结束原恢复的等待？',
            content: `原请求可能已经恢复到版本 ${confirmation.target.targetRevision}。结束等待不会撤销或确认该恢复；再次恢复可能生成另一个版本。请先查看当前正文。`,
            okText: '确认结束等待', cancelText: '继续等待', onOk: () => restoreOperation.endWaiting(confirmation) })
        }}>结束等待</Button>
      </Space>} />}
    </div>
  return <Drawer rootClassName="history-drawer" title="历史版本" aria-label="历史版本" open width={720} onClose={onClose} maskClosable={!writing} closable={!writing} keyboard={!writing}>
    {contextHolder}
    <Typography.Paragraph>查看已保存的版本。恢复会生成新版本，旧记录仍保留；重要版本会在普通历史清理后继续保留。</Typography.Paragraph>
    {error && <Alert type="warning" showIcon message={error} />}
    {notice && <Alert type="success" showIcon message={notice} />}
    {!(history && selected != null) && restoreFeedback}
    {history && <Typography.Paragraph type="secondary">当前版本：{history.currentRevision}；连续历史从版本 {history.minimumRevision} 开始。</Typography.Paragraph>}
    {retention && <Alert type="info" showIcon message={retention.protectedDocument ? '该文档受保护，不清理历史' :
      `普通历史保留 ${retention.days} 天，最多 ${retention.maxOperations} 次操作、${Math.round(retention.maxBytes/1024/1024)} MiB。自动清理${retention.enabled?'已开启':'未开启'}。`} />}
    {isOwner && retention && retention.proposedMinimumRevision > retention.minimumRevision && <Button danger disabled={writing || Boolean(restoreOperation.target)} onClick={() => {
      const context = restoreOperation.captureContext()
      if (!context) return
      modal.confirm({
      className:'history-confirm-modal',
      title:'清理超过保留范围的普通历史？',content:`版本 ${retention.proposedMinimumRevision} 之前的普通历史将不可恢复；重要版本和当前正文保留。`,
      okText:'确认清理',cancelText:'取消',onOk:() => compact(context),
    })}}>清理过期历史</Button>}
    <div className="history-version-list"><Spin spinning={loading}>
      <List rowKey="revision" dataSource={rows} renderItem={v => <List.Item actions={[
        <Button key="view" disabled={writing || loading} onClick={() => choose(v.revision)}>查看版本 {v.revision}</Button>,
      ]}>
        <Space direction="vertical"><Typography.Text>{v.name || `版本 ${v.revision}`}</Typography.Text>
          <Typography.Text type="secondary">{v.savedAt || ''} {v.author || ''}</Typography.Text>
          {named.some(n => n.revision === v.revision) && <Tag color="blue">重要版本</Tag>}
        </Space>
      </List.Item>} />
    </Spin></div>
    <Space wrap>
      <Button disabled={loading || writing} onClick={() => load()}>刷新列表</Button>
      {history?.nextBeforeRevision != null && <Button disabled={loading || writing} onClick={() => load(history.nextBeforeRevision)}>加载更早版本</Button>}
    </Space>
    {history && selected != null && <section ref={previewRegion} className="history-preview" tabIndex={-1} aria-label={`版本 ${selected} 预览`}>
      <Typography.Title level={5}>版本 {selected}</Typography.Title>
      {previewLoading && <div role="status"><Spin size="small" /> 正在加载版本…</div>}
      {previewError && <Alert type="warning" showIcon message={previewError}
        action={<Button onClick={() => choose(selected)}>重试此版本</Button>} />}
      {preview && <DocumentPreview content={preview} label="历史版本内容" />}
      {isOwner && preview && <div ref={previewActions}><Space direction="vertical" style={{ width: '100%', marginTop: 16 }}>
        <Input value={name} maxLength={100} disabled={writing} onChange={e => setName(e.target.value)} placeholder="重要版本名称" aria-label="重要版本名称" />
        <Space wrap>
          <Button disabled={writing || !name.trim()} onClick={() => mark()}>保存重要版本</Button>
          {named.some(n => n.revision === selected) && <Button disabled={writing} onClick={() => mark(true)}>取消标记</Button>}
          <Button danger loading={restoreOperation.busy} disabled={writing || restoreOperation.trackingFailed || Boolean(restoreOperation.target) || loading || !history} onClick={() => {
            const context = restoreOperation.captureContext()
            if (!context) return
            const targetRevision = selected, expectedRevision = history.currentRevision
            modal.confirm({
            className: 'history-confirm-modal',
            title: `恢复到版本 ${selected}？`, content: '将用该版本的正文生成一个新版本，并同步给其他在线协作者。',
            okText: '确认恢复', cancelText: '取消', onOk: () => restore(targetRevision, expectedRevision, context),
          })}}>恢复此版本</Button>
        </Space>
      </Space></div>}
      {restoreFeedback}
    </section>}
  </Drawer>
}
