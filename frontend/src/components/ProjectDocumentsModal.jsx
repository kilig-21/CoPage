import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Input, List, Modal, Pagination, Space, Tag, Typography } from 'antd'
import ListEmptyState from './ListEmptyState'
import { usePageRequest } from '../auth/PageSessionContext'
import { documentHref } from '../navigation/documents'
import { focusDialogControl, useDialogEscapeFallback } from './dialogFocus'

export default function ProjectDocumentsModal({ project, from, busy, uncertain, error, triggerRef, onClose, onAdd, onReview }) {
  const request = usePageRequest()
  const [input, setInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [readError, setReadError] = useState('')
  const [dataFrom, setDataFrom] = useState('')
  const [refresh, setRefresh] = useState(0)
  const filterField = useRef(null)
  const readKey = JSON.stringify([project.id, keyword, page, refresh])
  const current = dataFrom === readKey ? data : null
  const waiting = loading || (!current && !readError)
  useDialogEscapeFallback(onClose, () => !busy, triggerRef)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setData(null); setReadError('')
    request.get('/projects/' + project.id + '/candidates', { params: { keyword, page, size: 20 }, signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return
        const last = Math.max(1, Math.ceil(data.total / 20))
        if (page > last) { setPage(last); return }
        setData(data); setDataFrom(readKey)
      }).catch(failure => { if (!controller.signal.aborted) setReadError([400, 403, 404].includes(failure?.code)
        ? failure.message : '可加入的文档未能加载，请重试。') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [project.id, keyword, page, readKey, request])
  function filter(value) {
    setInput(value)
    setKeyword(value.trim())
    setPage(1)
  }

  return <Modal open title="加入已有文档" className="project-document-picker-modal" width={720} onCancel={busy ? undefined : onClose}
    afterOpenChange={open => { if (open) focusDialogControl(filterField.current?.input) }}
    closable={!busy} maskClosable={!busy} keyboard={!busy} footer={[
      uncertain && <Button key="review" disabled={busy} onClick={onReview}>核对项目文档</Button>,
      <Button key="close" disabled={busy} onClick={onClose}>关闭</Button>,
    ]}>
    <div className="project-document-picker-context">
      <Typography.Text strong>{project.name}</Typography.Text>
      <Typography.Text type="secondary">{project.groupId > 0
        ? '可加入你拥有的文档。小组成员仍需逐篇授权。'
        : '可加入你有权阅读的文档。正文、版本和权限均保留。'}</Typography.Text>
    </div>
    <Input.Search ref={filterField} aria-label="筛选可加入的文档" value={input} maxLength={200} disabled={busy || uncertain}
      placeholder="按标题筛选" onChange={e => setInput(e.target.value)} onSearch={filter} enterButton="筛选" />
    {error && <Alert className="project-read-alert" type="error" showIcon message={error} />}
    {readError && <Alert className="project-read-alert" type="error" showIcon message={readError} action={!uncertain &&
      <Button disabled={busy || loading} onClick={() => setRefresh(n => n + 1)}>重试读取</Button>} />}
    {waiting && <Typography.Paragraph className="project-document-picker-status" role="status">正在读取可加入的文档…</Typography.Paragraph>}
    {!waiting && current && (
      <List rowKey="id" dataSource={current.list} className="project-document-picker"
        locale={{ emptyText: (
          <ListEmptyState description={keyword ? '没有匹配的可加入文档' : '暂无可加入的文档'}>
            {keyword && <Button disabled={busy || uncertain} onClick={() => {
              filter('')
              filterField.current?.focus({ preventScroll: true })
            }}>清除筛选</Button>}
          </ListEmptyState>
        ) }}
        renderItem={doc => <List.Item actions={[
          <Button key="add" aria-label={`加入项目「${doc.title}」（文档 #${doc.id}）`} disabled={busy || uncertain}
            onClick={() => { if (!busy && !uncertain) onAdd(doc) }}>加入项目</Button>,
          <a key="view" className="document-open-link" href={documentHref(doc.id, from)} target="_blank" rel="noopener noreferrer"
            aria-label={`另开查看「${doc.title}」（文档 #${doc.id}，新标签页）`}>另开查看</a>,
        ]}><List.Item.Meta title={doc.title} description={<Space wrap>
          <span>文档 #{doc.id}</span><Tag>{doc.isOwner === true ? '所有者' : doc.permission === 2 ? '可编辑' : doc.permission === 1 ? '只读' : '打开后查看权限'}</Tag>
          <span>所有者：{typeof doc.ownerName === 'string' && doc.ownerName.trim() ? doc.ownerName : '用户 #' + doc.ownerId}</span>
          <span>更新于 {doc.updateTime}</span>
        </Space>} /></List.Item>} />
    )}
    {!waiting && current?.total > 20 && <Pagination current={page} total={current.total} pageSize={20} showSizeChanger={false}
      disabled={busy || uncertain} onChange={setPage} />}
  </Modal>
}
