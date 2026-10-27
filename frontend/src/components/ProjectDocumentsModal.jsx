import { useEffect, useState } from 'react'
import { Alert, Button, Empty, Input, List, Modal, Pagination, Space, Tag, Typography } from 'antd'
import request from '../api/request'
import { documentHref } from '../navigation/documents'

export default function ProjectDocumentsModal({ project, from, busy, uncertain, error, onClose, onAdd, onReview }) {
  const [input, setInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [readError, setReadError] = useState('')
  const [dataFrom, setDataFrom] = useState('')
  const [refresh, setRefresh] = useState(0)
  const readKey = JSON.stringify([project.id, keyword, page, refresh])
  const current = dataFrom === readKey ? data : null
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
  }, [project.id, keyword, page, refresh])
  return <Modal open title="加入已有文档" className="project-document-picker-modal" width={720} onCancel={busy ? undefined : onClose}
    closable={!busy} maskClosable={!busy} keyboard={!busy} footer={[
      uncertain && <Button key="review" disabled={busy} onClick={onReview}>核对项目文档</Button>,
      <Button key="close" disabled={busy} onClick={onClose}>关闭</Button>,
    ]}>
    <Typography.Paragraph>项目：{project.name}</Typography.Paragraph>
    <Typography.Paragraph>{project.groupId > 0 ? '小组项目只能主动加入你拥有的文档，其他成员仍需单篇授权。' : '个人项目可以整理你当前有权限阅读的资料。'}</Typography.Paragraph>
    <Typography.Paragraph type="secondary">保留原正文和版本，通过关联分类；加入项目不修改成员权限。</Typography.Paragraph>
    <Input.Search aria-label="筛选可加入的文档" value={input} maxLength={200} disabled={busy || uncertain}
      placeholder="按标题筛选" onChange={e => setInput(e.target.value)} onSearch={value => { setKeyword(value.trim()); setPage(1) }} enterButton="筛选" />
    {error && <Alert className="project-read-alert" type="error" showIcon message={error} />}
    {readError && <Alert className="project-read-alert" type="error" showIcon message={readError} action={!uncertain &&
      <Button disabled={busy || loading} onClick={() => setRefresh(n => n + 1)}>重试读取</Button>} />}
    <List rowKey="id" loading={loading} dataSource={current?.list || []} className="project-document-picker"
      locale={{ emptyText: loading ? '正在加载…' : !current ? '文档列表暂不可用' : <Empty description="没有可加入的文档，试试其他标题或先创建一篇" /> }}
      renderItem={doc => <List.Item actions={[
        <a key="view" className="document-open-link" href={documentHref(doc.id, from)} target="_blank" rel="noopener noreferrer"
          aria-label={'查看文档 #' + doc.id + '（新标签页）'}>查看文档（新标签页）</a>,
        <Button key="add" disabled={busy || loading || uncertain || !current}
          onClick={() => { if (!busy && !loading && !uncertain && current) onAdd(doc) }}>加入项目</Button>,
      ]}><List.Item.Meta title={doc.title} description={<Space wrap>
        <span>文档 #{doc.id}</span><Tag>{doc.isOwner === true ? '所有者' : doc.permission === 2 ? '可编辑' : doc.permission === 1 ? '只读' : '打开后查看权限'}</Tag>
        <span>所有者：{typeof doc.ownerName === 'string' && doc.ownerName.trim() ? doc.ownerName : '用户 #' + doc.ownerId}</span>
        <span>更新于 {doc.updateTime}</span>
      </Space>} /></List.Item>} />
    {current?.total > 20 && <Pagination current={page} total={current.total} pageSize={20} showSizeChanger={false}
      disabled={busy || loading || uncertain} onChange={setPage} />}
  </Modal>
}
