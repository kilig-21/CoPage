import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Empty, Input, Layout, List, Modal, Space, Spin, Typography } from 'antd'
import { Link, useNavigate } from 'react-router-dom'
import request from '../api/request'
import DocumentPreview from '../components/DocumentPreview'
import UserGuide from '../components/UserGuide'

export default function Templates() {
  const navigate = useNavigate()
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [showGuide, setShowGuide] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState(null)
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const createController = useRef(null)
  useEffect(() => () => createController.current?.abort(), [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    request.get('/doc/templates', { signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setTemplates(response.data) })
      .catch(ex => { if (!controller.signal.aborted) setError(ex.message || '模板加载失败，请重试') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh])

  async function create() {
    if (createController.current) return
    if (!title.trim()) { setError('请输入文档标题'); return }
    const controller = new AbortController()
    createController.current = controller
    setCreating(true); setError('')
    try {
      const response = await request.post('/doc', { title: title.trim(), templateId: selected.id }, { signal: controller.signal })
      if (controller.signal.aborted) return
      navigate('/docs/' + response.data.id)
    } catch (ex) {
      if (!controller.signal.aborted) setError(ex?.code === 400 ? ex.message : '创建结果未确认，请先回到列表检查是否已创建，再决定是否重试')
    } finally {
      if (createController.current === controller) createController.current = null
      if (!controller.signal.aborted) setCreating(false)
    }
  }

  return <Layout className="app-shell">
    <header className="topbar"><Typography.Title level={4}>文档模板</Typography.Title><Space wrap><Button onClick={() => navigate('/home')}>工作台</Button><Button onClick={() => setShowGuide(true)}>使用指南</Button><Button onClick={() => navigate('/docs')}>返回我的文档</Button></Space></header>
    <main className="content-wrap">
      <Typography.Title level={2}>从模板开始</Typography.Title>
      <Typography.Paragraph type="secondary">选择框架后创建自己的文档。模板不会引用其他用户的内容。</Typography.Paragraph>
      {error && !selected && <Alert type="error" showIcon message={error} action={<Button onClick={() => setRefresh(n => n + 1)}>重试</Button>} />}
      <Spin spinning={loading}><List grid={{ gutter: 16, xs: 1, sm: 1, md: 2, lg: 3, xl: 3, xxl: 3 }} dataSource={templates}
        locale={{ emptyText: loading || error ? ' ' : <Empty description="暂无可用模板" /> }}
        renderItem={template => <List.Item><Card title={template.title}>
          <Typography.Paragraph>{template.description}</Typography.Paragraph>
          <Button onClick={() => { setSelected(template); setTitle(template.title); setError('') }}>预览并使用{template.title}</Button>
        </Card></List.Item>} /></Spin>
      <Space><Link to="/docs">也可以返回列表创建空白文档</Link></Space>
    </main>
    {showGuide && <UserGuide onClose={() => setShowGuide(false)} />}
    <Modal title={selected ? '使用' + selected.title : '使用模板'} open={Boolean(selected)} width={720}
      onCancel={() => { if (!creating) { setSelected(null); setError('') } }} onOk={create}
      okText="创建文档" confirmLoading={creating} closable={!creating} maskClosable={!creating} cancelButtonProps={{ disabled: creating }}>
      {error && selected && <Alert type="error" showIcon message={error} />}
      <Typography.Paragraph>创建后可自由编辑；模板内容会作为文档的初始版本保留。</Typography.Paragraph>
      <Input aria-label="新文档标题" maxLength={200} value={title} disabled={creating} onChange={e => setTitle(e.target.value)} />
      {selected && <DocumentPreview content={selected.content} label="模板内容预览" />}
    </Modal>
  </Layout>
}
