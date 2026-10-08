import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Drawer, Input, List, Modal, Space, Spin, Tag, Typography } from 'antd'
import request from '../api/request'
import DocumentPreview from './DocumentPreview'

const rejectedCodes = new Set([400, 401, 403, 404, 40901, 40902, 40903, 40904])
const mutationError = (error, uncertain) => rejectedCodes.has(error?.code)
  ? error.message || '请求被拒绝，请核对后重试' : uncertain

export default function HistoryDrawer({ docId, isOwner, canRestore, onClose }) {
  const [modal, contextHolder] = Modal.useModal()
  const [history, setHistory] = useState(null)
  const [versions, setVersions] = useState([])
  const [selected, setSelected] = useState(null)
  const [preview, setPreview] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const previewRegion = useRef(null)
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [retention, setRetention] = useState(null)
  const alive = useRef(true)
  const selectionRequest = useRef(0)
  const restoreRequest = useRef(null)
  const requests = useRef(new Set())
  const listRequest = useRef(null)
  const previewRequest = useRef(null)
  const mutation = useRef(null)
  const base = `/doc/${docId}/history`
  const beginRequest = () => {
    const controller = new AbortController()
    requests.current.add(controller)
    return controller
  }
  const isLive = controller => alive.current && !controller.signal.aborted
  const beginMutation = () => {
    if (!alive.current || mutation.current) return null
    const controller = beginRequest()
    mutation.current = controller
    setBusy(true); setError(''); setNotice('')
    return controller
  }
  const finishMutation = controller => {
    requests.current.delete(controller)
    if (mutation.current === controller) mutation.current = null
    if (isLive(controller)) setBusy(false)
  }
  const load = async (before) => {
    listRequest.current?.abort()
    const controller = beginRequest()
    listRequest.current = controller
    setLoading(true)
    try {
      const response = await request.get(base, { params: before == null ? {} : { beforeRevision: before }, signal: controller.signal })
      if (!isLive(controller)) return
      setHistory(response.data)
      setVersions(old => before == null ? response.data.list : [...old, ...response.data.list])
      if (isOwner) {
        const policy = await request.get(base + '/retention', { signal: controller.signal })
        if (isLive(controller)) setRetention(policy.data)
      }
      if (isLive(controller)) setError('')
    } catch (ex) { if (isLive(controller)) setError(ex.message || '历史加载失败') }
    finally {
      requests.current.delete(controller)
      if (listRequest.current === controller) listRequest.current = null
      if (isLive(controller)) setLoading(false)
    }
  }
  useEffect(() => {
    alive.current = true
    load()
    return () => {
      alive.current = false
      selectionRequest.current++
      for (const controller of requests.current) controller.abort()
      requests.current.clear()
      listRequest.current = null; previewRequest.current = null; mutation.current = null
    }
  }, [docId])
  const choose = async (revision) => {
    previewRequest.current?.abort()
    const controller = beginRequest()
    previewRequest.current = controller
    const ticket = ++selectionRequest.current
    setSelected(revision); setPreview(null); setPreviewLoading(true); setPreviewError(''); setName(''); restoreRequest.current = null
    try {
      const response = await request.get(`${base}/${revision}`, { signal: controller.signal })
      if (isLive(controller) && ticket === selectionRequest.current) {
        setPreview(response.data.content); setError('')
        setName(history?.namedVersions.find(version => version.revision === revision)?.name || '')
      }
    } catch (ex) { if (isLive(controller) && ticket === selectionRequest.current) setPreviewError(ex.message || '版本读取失败') }
    finally {
      requests.current.delete(controller)
      if (previewRequest.current === controller) previewRequest.current = null
      if (isLive(controller) && ticket === selectionRequest.current) {
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
      if (remove) await request.delete(`${base}/${selected}/name`, { signal: controller.signal })
      else await request.put(`${base}/${selected}/name`, { name }, { signal: controller.signal })
      if (isLive(controller)) { setNotice(remove ? '已取消重要版本标记' : '重要版本已保存'); await load() }
    } catch (ex) { if (isLive(controller)) setError(mutationError(ex, '重要版本更新结果未确认，请刷新列表核对后再决定是否重试')) }
    finally { finishMutation(controller) }
  }
  const restore = async () => {
    if (!alive.current || mutation.current) return
    if (!canRestore()) { setError('请等待连接恢复、当前编辑保存和图片上传完成后再恢复版本'); return }
    const controller = beginMutation()
    if (!controller) return
    try {
      // 超时后的重试复用请求 ID 和原预期版本，防止重复恢复。
      restoreRequest.current ??= { expectedRevision: history.currentRevision, requestId: globalThis.crypto.randomUUID() }
      const response = await request.post(`${base}/${selected}/restore`, restoreRequest.current, { signal: controller.signal })
      if (isLive(controller)) { setNotice(`已恢复，生成版本 ${response.data.revision}`); restoreRequest.current = null; await load() }
    } catch (ex) {
      if (isLive(controller)) {
        setError(mutationError(ex, '恢复结果未确认，可重试这次恢复以核对结果，也可刷新历史列表查看最新版本'))
        if (ex.code === 40902) {
          restoreRequest.current = null
          await load()
          if (isLive(controller)) setError('文档已有新编辑，请重新核对最新版本后再恢复')
        }
      }
    } finally { finishMutation(controller) }
  }
  const named = history?.namedVersions || []
  const compact = async () => {
    const controller = beginMutation()
    if (!controller) return
    try {
      await request.post(base + '/compact', { expectedRevision: retention.currentRevision, beforeRevision: retention.proposedMinimumRevision }, { signal: controller.signal })
      if (isLive(controller)) { setSelected(null); setPreview(null); setNotice('历史已清理，重要版本继续保留'); await load() }
    } catch (ex) { if (isLive(controller)) setError(mutationError(ex, '历史清理结果未确认，请刷新列表和保留范围后再决定是否重试')) }
    finally { finishMutation(controller) }
  }
  const rows = [...new Map([
    ...(history && !versions.some(v => v.revision === history.minimumRevision)
      ? [{ revision: history.minimumRevision, name: history.minimumRevision === 0 ? '初始版本' : '保留范围起点' }] : []),
    ...(history && !versions.some(v => v.revision === history.currentRevision)
      ? [{ revision: history.currentRevision, name: '当前版本' }] : []),
    ...versions, ...named,
  ].map(v => [v.revision, v])).values()].sort((a, b) => b.revision - a.revision)
  return <Drawer title="历史版本" aria-label="历史版本" open width={720} onClose={onClose} maskClosable={!busy} closable={!busy} keyboard={!busy}>
    {contextHolder}
    <Typography.Paragraph>查看已保存的版本。恢复会生成新版本，旧记录仍保留；重要版本会在普通历史清理后继续保留。</Typography.Paragraph>
    {error && <Alert type="warning" showIcon message={error} />}
    {notice && <Alert type="success" showIcon message={notice} />}
    {history && <Typography.Paragraph type="secondary">当前版本：{history.currentRevision}；连续历史从版本 {history.minimumRevision} 开始。</Typography.Paragraph>}
    {retention && <Alert type="info" showIcon message={retention.protectedDocument ? '该文档受保护，不清理历史' :
      `普通历史保留 ${retention.days} 天，最多 ${retention.maxOperations} 次操作、${Math.round(retention.maxBytes/1024/1024)} MiB。自动清理${retention.enabled?'已开启':'未开启'}。`} />}
    {retention && retention.proposedMinimumRevision > retention.minimumRevision && <Button danger disabled={busy} onClick={() => modal.confirm({
      title:'清理超过保留范围的普通历史？',content:`版本 ${retention.proposedMinimumRevision} 之前的普通历史将不可恢复；重要版本和当前正文保留。`,
      okText:'确认清理',cancelText:'取消',onOk:compact,
    })}>清理过期历史</Button>}
    <div className="history-version-list"><Spin spinning={loading}>
      <List rowKey="revision" dataSource={rows} renderItem={v => <List.Item actions={[
        <Button key="view" disabled={busy || loading} onClick={() => choose(v.revision)}>查看版本 {v.revision}</Button>,
      ]}>
        <Space direction="vertical"><Typography.Text>{v.name || `版本 ${v.revision}`}</Typography.Text>
          <Typography.Text type="secondary">{v.savedAt || ''} {v.author || ''}</Typography.Text>
          {named.some(n => n.revision === v.revision) && <Tag color="blue">重要版本</Tag>}
        </Space>
      </List.Item>} />
    </Spin></div>
    <Space wrap>
      <Button disabled={loading || busy} onClick={() => load()}>刷新列表</Button>
      {history?.nextBeforeRevision != null && <Button disabled={loading || busy} onClick={() => load(history.nextBeforeRevision)}>加载更早版本</Button>}
    </Space>
    {selected != null && <section ref={previewRegion} className="history-preview" tabIndex={-1} aria-label={`版本 ${selected} 预览`}>
      <Typography.Title level={5}>版本 {selected}</Typography.Title>
      {previewLoading && <div role="status"><Spin size="small" /> 正在加载版本…</div>}
      {previewError && <Alert type="warning" showIcon message={previewError}
        action={<Button onClick={() => choose(selected)}>重试此版本</Button>} />}
      {preview && <DocumentPreview content={preview} label="历史版本内容" />}
      {isOwner && preview && <Space direction="vertical" style={{ width: '100%', marginTop: 16 }}>
        <Input value={name} maxLength={100} disabled={busy} onChange={e => setName(e.target.value)} placeholder="重要版本名称" aria-label="重要版本名称" />
        <Space wrap>
          <Button disabled={busy || !name.trim()} onClick={() => mark()}>保存重要版本</Button>
          {named.some(n => n.revision === selected) && <Button disabled={busy} onClick={() => mark(true)}>取消标记</Button>}
          <Button danger loading={busy} disabled={busy} onClick={() => modal.confirm({
            title: `恢复到版本 ${selected}？`, content: '将用该版本的正文生成一个新版本，并同步给其他在线协作者。',
            okText: '确认恢复', cancelText: '取消', onOk: restore,
          })}>恢复此版本</Button>
        </Space>
      </Space>}
    </section>}
  </Drawer>
}
