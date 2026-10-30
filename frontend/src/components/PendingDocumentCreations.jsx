import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, List, Popconfirm, Space, Typography } from 'antd'
import { Link } from 'react-router-dom'
import { confirmDocumentCreation, endDocumentCreationWaiting, sameDocumentCreationIdentity } from '../api/createDocument'
import usePendingDocumentCreations from '../api/usePendingDocumentCreations'
import '../styles/document-creations.css'

const label = record => record.kind === 'import' ? '导入文档' : record.kind.startsWith('personal-template:') ? '私人模板创建' : record.templateId ? '内置模板创建' : '新建文档'
export default function PendingDocumentCreations({ expectedIdentity, onCreated, disabled }) {
  const pending = usePendingDocumentCreations(expectedIdentity)
  const [busy, setBusy] = useState(''), [errors, setErrors] = useState({}), [notice, setNotice] = useState(null)
  const alive = useRef(false), attempt = useRef(null), ending = useRef(null)
  useEffect(() => {
    alive.current = true
    const cancel = () => {
      if (sameDocumentCreationIdentity(pending.identity)) return
      const old = attempt.current; attempt.current = null; old?.abort(); if (alive.current) setBusy('')
    }
    window.addEventListener('storage', cancel); window.addEventListener('copage-auth-changed', cancel)
    return () => { alive.current = false; attempt.current?.abort(); attempt.current = null; window.removeEventListener('storage', cancel); window.removeEventListener('copage-auth-changed', cancel) }
  }, [pending.identity])
  async function perform(record, end = false) {
    if (attempt.current || disabled || !sameDocumentCreationIdentity(pending.identity)) return
    const controller = new AbortController(); attempt.current = controller
    setBusy(record.key); setErrors(previous => ({ ...previous, [record.key]: '' })); setNotice(null)
    const current = () => alive.current && attempt.current === controller && !controller.signal.aborted && sameDocumentCreationIdentity(pending.identity)
    try {
      const config = { signal: controller.signal, expectedIdentity: pending.identity, deferCleanup: true }
      if (end) {
        await endDocumentCreationWaiting(record, config)
        if (current()) setNotice({ type: 'warning', text: '已结束这项创建的等待；没有撤销后台请求、删除文档或认定创建成功。原请求仍可能已完成，请核对文档列表。' })
      } else {
        let response = await confirmDocumentCreation(record, config)
        if (!current()) return
        response = await response.confirmTracking()
        if (!current()) return
        const data = response.data
        if (response.creationTrackingWarning) setNotice({ type: 'warning', text: `原创建 #${data.id} 已确认。${response.creationTrackingWarning}` })
        else if (!data.available) setNotice({ type: 'warning', text: `原请求已确认创建 #${data.id}，目前无法打开；没有重新创建或恢复文档。` })
        else if (data.deleted) setNotice({ type: 'info', trash: true, text: `原请求已确认创建 #${data.id}「${data.title}」，目前在回收站；没有自动恢复。` })
        else {
          try { onCreated(data) } catch { setNotice({ type: 'success', text: `原创建 #${data.id} 已确认，请从文档列表打开。` }) }
        }
      }
    } catch (error) {
      if (current()) setErrors(previous => ({ ...previous, [record.key]: error.code === 404
        ? '暂未找到原收据，这不能证明后台未完成。请稍后核对；重试原请求请回到原标签并保留原内容。另开标签再次创建或导入是另一项请求，可能生成重复文档。'
        : error.message || '暂时无法确认原请求，原记录保留。' }))
    } finally {
      if (attempt.current === controller) { attempt.current = null; if (alive.current) setBusy('') }
    }
  }
  if (!pending.records.length && !pending.error && !pending.unreadable && !notice) return null
  return <Card className="document-creation-review" role="region" aria-label="待确认的创建" title="待确认的创建"
    extra={<Button disabled={Boolean(busy) || pending.loading} onClick={pending.refresh}>刷新记录</Button>}>
    <Typography.Paragraph>这些新建、模板创建或导入尚未取得确认。按原请求查询结果，不重新上传文件，也不改写文档。</Typography.Paragraph>
    <Typography.Paragraph type="secondary">记录按账号和服务保存在此浏览器，不保存正文或登录凭据。关页或重登原账号后仍可主动核对；另开标签的新建是另一项请求，不会吞并同名创建。</Typography.Paragraph>
    {pending.error && <Alert type="warning" showIcon message={pending.error} />}
    {pending.unreadable > 0 && <Alert type="warning" showIcon message={`${pending.unreadable} 份创建记录无法读取，已保留；仍可核对下方可用记录。`} />}
    {notice && <Alert role="status" type={notice.type} showIcon message={notice.text} action={notice.trash && <Link to="/trash">查看回收站</Link>} />}
    {pending.records.length > 0 && <List rowKey="key" dataSource={pending.records} pagination={pending.records.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
      renderItem={record => <List.Item actions={[
        <Button key="confirm" loading={busy === record.key} disabled={Boolean(busy) || pending.loading || disabled}
          onClick={() => perform(record)}>确认原创建</Button>,
        errors[record.key] && <Popconfirm key="end" overlayClassName="document-action-confirm" title="结束这项创建的等待？"
          description="只移除此浏览器的待确认标识，不撤销后台请求或删除文档。原请求仍可能完成；再次新建可能生成重复文档，请先核对文档列表。"
          okText="结束等待" cancelText="继续保留" disabled={Boolean(busy) || disabled}
          onOpenChange={open => { if (open) ending.current = record }}
          onConfirm={() => { const original = ending.current; ending.current = null; if (original === record) perform(original, true) }}>
          <Button disabled={Boolean(busy) || disabled}>结束本次等待</Button>
        </Popconfirm>,
      ].filter(Boolean)}>
        <List.Item.Meta title={record.title || '由原文件决定标题的导入'} description={<Space direction="vertical" size={4}>
          <span>{label(record)}{record.filename ? ` · ${record.filename}` : ''}</span>
          <span>准备于 {new Date(record.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
          {errors[record.key] && <Alert type="warning" showIcon message={errors[record.key]} />}
        </Space>} />
      </List.Item>} />}
  </Card>
}
