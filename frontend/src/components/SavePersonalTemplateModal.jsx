import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Input, Modal, Radio, Typography } from 'antd'
import request from '../api/request'
import { templateCategories } from '../templates/categories'

export default function SavePersonalTemplateModal({ doc, onClose, onSaved, onReview, onUncertain }) {
  const [name, setName] = useState(doc.title)
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('collaboration')
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState('')
  const [submittedName, setSubmittedName] = useState('')
  const mutation = useRef(null)
  useEffect(() => () => mutation.current?.abort(), [])
  async function save() {
    if (mutation.current || uncertain || !name.trim()) return
    const controller = new AbortController(); mutation.current = controller
    setBusy(true); setError(''); setSubmittedName(name.trim())
    try {
      const result = await request.post('/personal-templates', { docId: doc.id, name: name.trim(), description: description.trim(), category }, { signal: controller.signal })
      if (!controller.signal.aborted) onSaved({ ...result.data, name: name.trim() })
    } catch (failure) {
      if (!controller.signal.aborted) {
        const rejected = [400, 401, 403, 404].includes(failure?.code)
        setUncertain(!rejected)
        if (!rejected) onUncertain?.(name.trim())
        setError(rejected ? failure.message : '保存结果未确认，请先核对我的模板，再决定是否重试。')
      }
    } finally {
      if (mutation.current === controller) mutation.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return <Modal open title="保存为个人模板" className="personal-template-modal"
    closable={!busy} maskClosable={!busy} keyboard={!busy} onCancel={busy ? undefined : onClose}
    footer={[
      <Button key="close" disabled={busy} onClick={onClose}>关闭</Button>,
      uncertain && <Button key="review" onClick={() => onReview(submittedName)}>核对我的模板</Button>,
      <Button key="save" type="primary" loading={busy} disabled={uncertain || !name.trim()} onClick={save}>保存模板</Button>,
    ]}>
    {error && <Alert type={uncertain ? 'warning' : 'error'} showIcon message={error} />}
    <Typography.Paragraph>来源：{doc.title}</Typography.Paragraph>
    <Typography.Paragraph>复制服务器已保存的正文，作为只供你使用的独立模板；不包含未确认编辑。每次使用都会创建新文档，不改变来源的正文或权限。</Typography.Paragraph>
    <Typography.Paragraph type="secondary">请先整理好可复用的内容。个人模板最多100份，正文合计32 MiB，单份最多2 MiB。</Typography.Paragraph>
    <Typography.Paragraph>模板名称</Typography.Paragraph>
    <Input aria-label="个人模板名称" maxLength={200} value={name} disabled={busy || uncertain} onChange={e => setName(e.target.value)} />
    <Typography.Paragraph style={{ marginTop: 12 }}>用途分类</Typography.Paragraph>
    <Radio.Group aria-label="个人模板用途" value={category} disabled={busy || uncertain}
      options={Object.entries(templateCategories).map(([value, label]) => ({ value, label }))} onChange={e => setCategory(e.target.value)} />
    <Typography.Paragraph style={{ marginTop: 12 }}>模板说明</Typography.Paragraph>
    <Input.TextArea aria-label="个人模板说明" maxLength={300} rows={3} showCount value={description} disabled={busy || uncertain} onChange={e => setDescription(e.target.value)} />
  </Modal>
}
