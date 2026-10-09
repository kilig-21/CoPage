import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Empty, Input, Layout, List, Modal, Radio, Space, Spin, Tag, Typography } from 'antd'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { documentHref } from '../navigation/documents'
import request from '../api/request'
import LogoutButton from '../components/LogoutButton'
import DocumentPreview from '../components/DocumentPreview'
import UserGuide from '../components/UserGuide'

import { templateCategories as categories } from '../templates/categories'
export default function Templates() {
  const navigate = useNavigate()
  const location = useLocation()
  const sourcePath = location.pathname + location.search + location.hash
  const [params, setParams] = useSearchParams()
  const category = Object.hasOwn(categories, params.get('category')) ? params.get('category') : 'all'
  const keyword = (params.get('keyword') || '').slice(0, 200).trim()
  const [input, setInput] = useState(keyword)
  const [templates, setTemplates] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showGuide, setShowGuide] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [createError, setCreateError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState(null)
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [submittedTitle, setSubmittedTitle] = useState('')
  const createController = useRef(null)
  useEffect(() => {
    createController.current?.abort(); createController.current = null
    setSelected(null); setCreating(false)
    return () => createController.current?.abort()
  }, [location.key])
  useEffect(() => setInput(keyword), [keyword])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setLoadError(''); setTemplates(null)
    request.get('/doc/templates', { signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setTemplates(response.data) })
      .catch(ex => { if (!controller.signal.aborted) setLoadError([400, 403, 404].includes(ex?.code) ? ex.message : '模板未能加载，请重试。') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh])
  const filtered = (templates || []).filter(template => (category === 'all' || template.category === category) &&
    (!keyword || (template.title + ' ' + template.description).toLocaleLowerCase().includes(keyword.toLocaleLowerCase())))
  const filter = (nextCategory, nextKeyword) => setParams({
    ...(nextCategory !== 'all' ? { category: nextCategory } : {}),
    ...(nextKeyword ? { keyword: nextKeyword } : {}),
  })
  const review = () => navigate('/docs?' + new URLSearchParams({ scope: 'owned', keyword: submittedTitle }).toString())
  async function create() {
    if (createController.current || uncertain || !selected || !templates || loading) return
    if (!title.trim()) { setCreateError('请输入文档标题'); return }
    const controller = new AbortController()
    createController.current = controller
    setCreating(true); setCreateError(''); setSubmittedTitle(title.trim())
    try {
      const response = await request.post('/doc', { title: title.trim(), templateId: selected.id }, { signal: controller.signal })
      if (!controller.signal.aborted) navigate(documentHref(response.data.id, sourcePath))
    } catch (ex) {
      if (!controller.signal.aborted) {
        const rejected = [400, 401, 403, 404].includes(ex?.code)
        setUncertain(!rejected)
        setCreateError(rejected ? ex.message : '创建结果未确认，请核对我的文档，确认是否已创建后再继续。')
      }
    } finally {
      if (createController.current === controller) createController.current = null
      if (!controller.signal.aborted) setCreating(false)
    }
  }
  return <Layout className="app-shell">
    <header className="topbar"><Typography.Title level={4}>模板中心</Typography.Title><Space wrap>
      <Link to="/home">工作台</Link><Link to="/docs">我的文档</Link><Link to="/templates?source=personal">我的模板</Link>
      <Button onClick={() => setShowGuide(true)}>使用指南</Button>
      <LogoutButton />
    </Space></header>
    <main className="content-wrap template-center">
      <Typography.Title level={2}>选一个适合这次工作的框架</Typography.Title>
      <Typography.Paragraph type="secondary">先预览内容，再创建独立文档。内置模板只提供通用框架，不读取其他用户的资料。</Typography.Paragraph>
      {loadError && <Alert type="error" showIcon message={loadError} action={<Button disabled={loading} onClick={() => setRefresh(n => n + 1)}>重试读取</Button>} />}
      {uncertain && !selected && <Alert type="warning" showIcon message={createError}
        action={<Button onClick={review}>核对我的文档</Button>} />}
      <Space wrap className="template-filters">
        <Radio.Group aria-label="模板分类" value={category} disabled={creating}
          options={[{ label: '全部', value: 'all' }, ...Object.entries(categories).map(([value, label]) => ({ value, label }))]}
          onChange={e => filter(e.target.value, keyword)} />
      </Space>
      <Input.Search aria-label="筛选模板" maxLength={200} value={input} disabled={creating} placeholder="搜索模板名称或用途"
        onChange={e => setInput(e.target.value)} onSearch={value => filter(category, value.trim())} enterButton="筛选" />
      {templates && <Space wrap className="template-filters"><Typography.Text type="secondary">找到 {filtered.length} 个模板</Typography.Text>
        {(category !== 'all' || keyword) && <Button disabled={creating} onClick={() => filter('all', '')}>清除筛选</Button>}</Space>}
      <Spin spinning={loading}><List rowKey="id" grid={{ gutter: 16, xs: 1, sm: 1, md: 2, lg: 3, xl: 3, xxl: 3 }}
        dataSource={filtered} locale={{ emptyText: loading ? '正在加载…' : !templates ? '模板列表暂不可用' : <Empty description="没有匹配的模板，试试其他分类或关键词" /> }}
        renderItem={template => <List.Item><Card title={template.title}>
          <Tag>{categories[template.category] || '通用'}</Tag><Typography.Paragraph>{template.description}</Typography.Paragraph>
          <Button disabled={loading || uncertain} onClick={() => { setSelected(template); setTitle(template.title); setCreateError('') }}>预览并使用{template.title}</Button>
        </Card></List.Item>} /></Spin>
      <Link to="/docs">也可以返回我的文档创建空白文档</Link>
    </main>
    {showGuide && <UserGuide onClose={() => setShowGuide(false)} />}
    <Modal title={selected ? '使用' + selected.title : '使用模板'} open={Boolean(selected)} width={720}
      onCancel={() => { if (!creating) { setSelected(null); if (!uncertain) setCreateError('') } }}
      closable={!creating} maskClosable={!creating} keyboard={!creating} footer={[
        <Button key="close" disabled={creating} onClick={() => { setSelected(null); if (!uncertain) setCreateError('') }}>关闭</Button>,
        uncertain && <Button key="review" onClick={review}>核对我的文档</Button>,
        <Button key="create" type="primary" loading={creating} disabled={uncertain || !title.trim() || !templates || loading} onClick={create}>创建文档</Button>,
      ]}>
      {createError && selected && <Alert type={uncertain ? 'warning' : 'error'} showIcon message={createError} />}
      <Typography.Paragraph>创建后可自由编辑；模板内容会作为文档的初始版本保留。</Typography.Paragraph>
      <Input aria-label="新文档标题" maxLength={200} value={title} disabled={creating || uncertain} onChange={e => setTitle(e.target.value)} />
      {selected && <DocumentPreview content={selected.content} label="模板内容预览" />}
    </Modal>
  </Layout>
}
