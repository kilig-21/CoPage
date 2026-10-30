import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Input, Modal, Select, Typography } from 'antd'
import { usePageSession } from '../auth/PageSessionContext'
import { createProjectDocument, confirmProjectDocument, sameProjectDocumentIdentity } from '../api/projectDocuments'
import DocumentPreview from './DocumentPreview'

export default function CreateProjectDocumentModal({ project, contextKey, onClose, onCreated, onBusyChange }) {
  const pageSession = usePageSession()
  const request = pageSession.request
  const [title, setTitle] = useState('未命名文档'), [templateId, setTemplateId] = useState(null)
  const [templates, setTemplates] = useState([]), [templateError, setTemplateError] = useState(''), [loadingTemplates, setLoadingTemplates] = useState(true)
  const [reload, setReload] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [pending, setPending] = useState(null), [confirmed, setConfirmed] = useState(null)
  const alive = useRef(false), attempt = useRef(null), prepared = useRef(null), scope = useRef(contextKey)
  scope.current = contextKey
  useEffect(() => {
    alive.current = true
    setBusy(false); setError('')
    return () => { alive.current = false; const old = attempt.current; attempt.current = null; old?.abort(); if (old) onBusyChange(false) }
  }, [contextKey, onBusyChange])
  useEffect(() => {
    const controller = new AbortController()
    setLoadingTemplates(true); setTemplateError('')
    request.get('/doc/templates', { signal: controller.signal }).then(({ data }) => {
      if (controller.signal.aborted) return
      if (!Array.isArray(data) || data.some(row => typeof row?.id !== 'string' || !row.id || typeof row.title !== 'string' || !row.content)) throw new Error('模板列表响应无效')
      setTemplates(data)
    }).catch(() => { if (!controller.signal.aborted) setTemplateError('内置模板暂时无法读取。可以先建空白文档，或重试模板。') })
      .finally(() => { if (!controller.signal.aborted) setLoadingTemplates(false) })
    return () => controller.abort()
  }, [reload])
  const selected = templates.find(row => row.id === templateId)
  function chooseTemplate(next) {
    if (!title.trim() || title === '未命名文档' || title === selected?.title) setTitle(templates.find(row => row.id === next)?.title || '未命名文档')
    setTemplateId(next)
  }
  async function save() {
    if (attempt.current) return
    if (!pageSession.current()) { setError('登录状态已变化，本页旧操作未发送；请重新登录原账号继续。'); return }
    if (confirmed) { try { onCreated(confirmed) } catch { setError('文档已确认，请从我的文档打开原文档。') }; return }
    const controller = new AbortController(), identity = pageSession.identity, key = contextKey
    attempt.current = controller; setBusy(true); onBusyChange(true); setError('')
    const current = () => alive.current && attempt.current === controller && !controller.signal.aborted && scope.current === key && sameProjectDocumentIdentity(identity)
    let accepted = false
    try {
      const config = pageSession.options({ signal: controller.signal, deferCleanup: true, onPrepared: record => {
        if (!current()) throw new DOMException('创建页面或账号已变化', 'AbortError')
        prepared.current = record; setPending(record)
      } })
      let response = prepared.current ? await confirmProjectDocument(prepared.current, config)
        : await createProjectDocument({ projectId: project.id, projectName: project.name, title: title.trim(), templateId }, config)
      if (!current()) return
      response = response.confirmTracking(); accepted = true
      prepared.current = null; setPending(null); setConfirmed(response.data); onCreated(response.data)
    } catch (failure) {
      if (current()) setError(accepted ? '文档已确认，请从我的文档打开原文档。' : prepared.current
        ? '结果未确认，原项目、标题和起始内容已保留。请确认原创建，或稍后继续。' : failure?.message || '创建尚未发送，请稍后重试。')
    } finally {
      if (attempt.current === controller) { attempt.current = null; if (alive.current) { setBusy(false); onBusyChange(false) } }
    }
  }
  const frozen = busy || Boolean(pending) || Boolean(confirmed)
  return <Modal open className="project-document-create-modal" title="新建文档并加入项目" width={640}
    onCancel={busy ? undefined : onClose} closable={!busy} maskClosable={!busy} keyboard={!busy}
    onOk={save} confirmLoading={busy} okText={confirmed ? '打开已确认文档' : pending ? '确认原创建' : '新建并开始编辑'}
    cancelText={pending ? '稍后确认' : '取消'} cancelButtonProps={{ disabled: busy }}
    okButtonProps={{ disabled: !pending && !confirmed && (!title.trim() || Boolean(templateId && !selected)) }}>
    <Typography.Paragraph>加入项目：<Typography.Text strong>{project.name}</Typography.Text></Typography.Paragraph>
    <Typography.Paragraph type="secondary">新文档归你所有；创建与归类一起完成。{project.groupId ? '小组其他成员仍需逐篇授权，才能阅读或编辑。' : '保留独立的正文、版本和权限。'}</Typography.Paragraph>
    {error && <Alert className="project-read-alert" type="warning" showIcon message={error} />}
    <Typography.Paragraph>文档标题</Typography.Paragraph>
    <Input aria-label="新文档标题" value={title} maxLength={200} autoFocus disabled={frozen} onChange={event => setTitle(event.target.value)} />
    <Typography.Paragraph style={{ marginTop: 16 }}>起始内容</Typography.Paragraph>
    <Select aria-label="起始内容" value={templateId || ''} disabled={frozen} loading={loadingTemplates} onChange={next => chooseTemplate(next || null)}
      options={[{ value: '', label: '空白文档' }, ...templates.map(row => ({ value: row.id, label: row.title }))]} />
    {templateError && <Alert className="project-read-alert" type="info" showIcon message={templateError}
      action={<Button disabled={frozen || loadingTemplates} onClick={() => setReload(value => value + 1)}>重试模板</Button>} />}
    {selected && <div className="project-document-template-preview"><Typography.Paragraph type="secondary">{selected.description}</Typography.Paragraph>
      <DocumentPreview content={selected.content} label="起始模板预览" /></div>}
    <Typography.Paragraph type="secondary" className="project-document-local-note">回复暂未取得时，可从项目页的“待确认的新文档”继续原创建；记录只在当前浏览器保留，不含正文或登录凭据。</Typography.Paragraph>
  </Modal>
}
