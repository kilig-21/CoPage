import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Empty, Input, List, Modal, Pagination, Typography } from 'antd'
import request from '../api/request'

export default function ProjectDocumentsModal({ project, onClose, onAdded, onReview }) {
  const [input, setInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const mutation = useRef(null)
  useEffect(() => () => mutation.current?.abort(), [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setData(null); setError('')
    request.get('/projects/' + project.id + '/candidates', { params: { keyword, page, size: 20 }, signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return
        const last = Math.max(1, Math.ceil(data.total / 20))
        if (page > last) { setPage(last); return }
        setData(data)
      }).catch(failure => { if (!controller.signal.aborted) setError([400, 403, 404].includes(failure?.code)
        ? failure.message : '可加入的文档未能加载，请重试。') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [project.id, keyword, page, refresh])
  async function add(doc) {
    if (mutation.current || !data || loading || uncertain) return
    const controller = new AbortController(); mutation.current = controller
    setBusy(true); setError('')
    try {
      const result = await request.post('/projects/' + project.id + '/documents', { docId: doc.id }, { signal: controller.signal })
      if (!controller.signal.aborted) onAdded(result.data.changed)
    } catch (failure) {
      if (!controller.signal.aborted) {
        const rejected = [400, 401, 403, 404].includes(failure?.code)
        setUncertain(!rejected)
        setError(rejected ? failure.message : '加入结果未确认，请关闭后刷新项目文档核对，再决定是否重试。')
      }
    } finally {
      if (mutation.current === controller) mutation.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  return <Modal open title="加入已有文档" width={720} onCancel={busy ? undefined : onClose}
    closable={!busy} maskClosable={!busy} keyboard={!busy} footer={[
      uncertain && <Button key="review" disabled={busy} onClick={onReview}>核对项目文档</Button>,
      <Button key="close" disabled={busy} onClick={onClose}>关闭</Button>,
    ]}>
    <Typography.Paragraph>项目：{project.name}</Typography.Paragraph>
    <Typography.Paragraph>{project.groupId > 0 ? '小组项目只能主动加入你拥有的文档，其他成员仍需单篇授权。' : '个人项目可以整理你当前有权限阅读的资料。'}</Typography.Paragraph>
    <Typography.Paragraph type="secondary">保留原正文和版本，通过关联分类；加入项目不修改成员权限。</Typography.Paragraph>
    <Input.Search aria-label="筛选可加入的文档" value={input} maxLength={200} disabled={busy || uncertain}
      placeholder="按标题筛选" onChange={e => setInput(e.target.value)} onSearch={value => { setKeyword(value.trim()); setPage(1) }} enterButton="筛选" />
    {error && <Alert type="error" showIcon message={error} action={!uncertain &&
      <Button disabled={busy || loading} onClick={() => setRefresh(n => n + 1)}>重试读取</Button>} />}
    <List rowKey="id" loading={loading} dataSource={data?.list || []} className="project-document-picker"
      locale={{ emptyText: loading ? '正在加载…' : !data ? '文档列表暂不可用' : <Empty description="没有可加入的文档，试试其他标题或先创建一篇" /> }}
      renderItem={doc => <List.Item actions={[<Button key="add" disabled={busy || loading || uncertain || !data}
        onClick={() => add(doc)}>加入项目</Button>]}><List.Item.Meta title={doc.title} /></List.Item>} />
    {data?.total > 20 && <Pagination current={page} total={data.total} pageSize={20} showSizeChanger={false}
      disabled={busy || loading || uncertain} onChange={setPage} />}
  </Modal>
}
