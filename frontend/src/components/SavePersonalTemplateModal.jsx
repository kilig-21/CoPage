import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Input, Modal, Radio, Typography } from 'antd'
import { usePageSession } from '../auth/PageSessionContext'
import { templateCategories } from '../templates/categories'
import { createPersonalTemplateSaver } from '../api/personalTemplateSave'

export default function SavePersonalTemplateModal({ doc, onClose, onSaved, onReview, onUncertain, canSave = () => true }) {
  const pageSession = usePageSession()
  const request = pageSession.request
  const [name, setName] = useState(doc.title)
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('collaboration')
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState('')
  const [submittedName, setSubmittedName] = useState('')
  const [confirmed, setConfirmed] = useState(null), [ready, setReady] = useState(false)
  const mutation = useRef(null), alive = useRef(false), source = useRef(doc.id), currentDoc = useRef(doc.id), saveReady = useRef(canSave)
  currentDoc.current = doc.id; saveReady.current = canSave
  const saver = useRef(null)
  if (!saver.current) saver.current = createPersonalTemplateSaver({ docId: source.current,
    readIdentity: () => pageSession.current() ? pageSession.identity : null,
    canSave: () => saveReady.current(), isCurrent: () => alive.current && currentDoc.current === source.current,
    post: (path, body, config) => request.post(path, body, config) })
  useEffect(() => {
    alive.current = true
    const refresh = () => setReady(saver.current.ready())
    refresh()
    const timer = setInterval(refresh, 200)
    return () => { alive.current = false; clearInterval(timer); mutation.current?.abort() }
  }, [])
  async function save() {
    if (mutation.current || uncertain || confirmed || !name.trim()) return
    const controller = new AbortController(); mutation.current = controller
    setBusy(true); setError(''); setSubmittedName(name.trim())
    try {
      const result = await saver.current.save({ name: name.trim(), description: description.trim(), category }, {
        signal: controller.signal, onSaved,
      })
      if (alive.current && !controller.signal.aborted && saver.current.current()) {
        setConfirmed(result.data)
        if (result.callbackError) setError('模板已保存，页面提示或跳转未完成；可以查看我的模板，或关闭后继续编辑。')
      }
    } catch (failure) {
      if (alive.current && !controller.signal.aborted && saver.current.current()) {
        const unknown = failure?.uncertain === true
        setUncertain(unknown)
        setError(unknown ? '保存结果未确认，请先核对我的模板，再决定是否操作；不会自动重试。'
          : failure?.message || '模板尚未保存，请稍后重试。')
        if (unknown) { try { await onUncertain?.(name.trim()) } catch { /* 原未知状态仍保留，不重新提交。 */ } }
      }
    } finally {
      if (mutation.current === controller) mutation.current = null
      if (alive.current) setBusy(false)
    }
  }
  const frozen = busy || uncertain || Boolean(confirmed)
  function review() {
    if (!saver.current.current()) return
    try { onReview(confirmed?.name || submittedName) }
    catch { setError(confirmed ? '模板已保存，暂时无法打开我的模板；请关闭后从模板中心查看。' : '暂时无法打开我的模板，原保存结果仍未确认。') }
  }
  return <Modal open title="保存为个人模板" className="personal-template-modal personal-template-save-modal"
    closable={!busy} maskClosable={!busy} keyboard={!busy} onCancel={busy ? undefined : onClose}
    footer={[
      <Button key="close" disabled={busy} onClick={onClose}>关闭</Button>,
      (uncertain || confirmed) && <Button key="review" disabled={busy} onClick={review}>{confirmed ? '查看我的模板' : '核对我的模板'}</Button>,
      !confirmed && <Button key="save" type="primary" loading={busy} disabled={uncertain || !ready || !name.trim()} onClick={save}>保存模板</Button>,
    ]}>
    {error && <Alert type={uncertain ? 'warning' : 'error'} showIcon message={error} />}
    {confirmed && <Alert type="success" showIcon message={'已保存服务端版本 ' + confirmed.sourceRevision + ' 的私人模板，原文档保持不变。'} />}
    {!ready && !uncertain && !confirmed && <Alert type="info" showIcon message="请先等待连接、同步和保存完成；未确认的本地编辑不会进入模板。" />}
    <Typography.Paragraph>来源：{doc.title}</Typography.Paragraph>
    <Typography.Paragraph>复制服务器已保存的正文，作为只供你使用的独立模板；不包含未确认编辑。每次使用都会创建新文档，不改变来源的正文或权限。</Typography.Paragraph>
    <Typography.Paragraph type="secondary">请先整理好可复用的内容。个人模板最多100份，正文合计32 MiB，单份最多2 MiB。</Typography.Paragraph>
    <Typography.Paragraph>模板名称</Typography.Paragraph>
    <Input aria-label="个人模板名称" maxLength={200} value={name} disabled={frozen} onChange={e => setName(e.target.value)} />
    <Typography.Paragraph style={{ marginTop: 12 }}>用途分类</Typography.Paragraph>
    <Radio.Group aria-label="个人模板用途" value={category} disabled={frozen}
      options={Object.entries(templateCategories).map(([value, label]) => ({ value, label }))} onChange={e => setCategory(e.target.value)} />
    <Typography.Paragraph style={{ marginTop: 12 }}>模板说明</Typography.Paragraph>
    <Input.TextArea aria-label="个人模板说明" maxLength={300} rows={3} showCount value={description} disabled={frozen} onChange={e => setDescription(e.target.value)} />
  </Modal>
}
