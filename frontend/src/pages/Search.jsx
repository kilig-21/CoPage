import { useEffect, useRef, useState } from 'react'
import { ArrowLeftOutlined, FileTextOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Empty, Input, Layout, List, Tag, Typography } from 'antd'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { documentHref } from '../navigation/documents'
import { usePageRequest } from '../auth/PageSessionContext'
import WorkspaceHeader from '../components/WorkspaceHeader'
import { snippetParts } from '../search/snippet'

const PAGE_SIZE = 10

export default function Search() {
  const request = usePageRequest()
  const navigate = useNavigate()
  const location = useLocation()
  const sourcePath = location.pathname + location.search + location.hash
  const [params, setParams] = useSearchParams()
  const query = (params.get('q') || '').trim()
  const rawPage = Number(params.get('page') || 1)
  const page = Number.isInteger(rawPage) && rawPage > 0 && rawPage <= 1000 ? rawPage : 1
  const [input, setInput] = useState(query)
  const [read, setRead] = useState(null)
  const [retry, setRetry] = useState(0)
  const readKey = JSON.stringify([query, page, retry])
  const currentKey = useRef(readKey), activeRequest = useRef(null)
  currentKey.current = readKey
  const validationError = query.length > 100 ? '搜索内容不能超过 100 个字符' : ''
  const validQuery = Boolean(query && !validationError)
  const currentRead = read?.key === readKey ? read : null
  const ready = validQuery && currentRead?.status === 'success'
  const loading = validQuery && (!currentRead || currentRead.status === 'loading')
  const error = validationError || (currentRead?.status === 'error' ? currentRead.error : '')
  const results = ready ? currentRead.list : []
  const total = ready ? currentRead.total : 0

  function discardRead() {
    const old = activeRequest.current
    activeRequest.current = null
    old?.controller.abort()
    setRead(null)
  }
  function changePage(next, replace = false) {
    discardRead()
    setParams({ q: query, page: String(next) }, { replace })
  }

  useEffect(() => { setInput(query) }, [query])
  useEffect(() => {
    const controller = new AbortController()
    const attempt = { key: readKey, controller }
    activeRequest.current = attempt
    const current = () => activeRequest.current === attempt && currentKey.current === attempt.key && !controller.signal.aborted
    setRead({ key: readKey, status: validQuery ? 'loading' : 'idle' })
    if (validQuery) {
      request.get('/search', { params: { q: query, page, size: PAGE_SIZE }, signal: controller.signal })
        .then((response) => {
          if (!current()) return
          const data = response.data
          if (!Number.isSafeInteger(data?.total) || data.total < 0 || !Array.isArray(data.list)) throw new Error('搜索响应无效')
          const lastPage = Math.max(1, Math.ceil(Math.min(data.total, 10000) / PAGE_SIZE))
          if (page > lastPage) {
            changePage(lastPage, true)
            return
          }
          setRead({ key: readKey, status: 'success', list: data.list, total: data.total })
        })
        .catch((failure) => {
          if (current()) setRead({ key: readKey, status: 'error', error: [400, 401, 403, 404].includes(failure?.code)
            ? failure.message || '搜索请求未获准，请核对当前账号与关键词。' : '搜索暂时无法加载，请检查网络后重试。' })
        })
        .finally(() => { if (current()) activeRequest.current = null })
    }
    return () => { controller.abort(); if (activeRequest.current === attempt) activeRequest.current = null }
  }, [query, page, retry])

  function search(value) {
    const next = value.trim()
    setInput(next)
    discardRead()
    if (next === query && page === 1) setRetry(value => value + 1)
    else setParams(next ? { q: next } : {})
  }
  function retrySearch() {
    if (loading || !validQuery) return
    discardRead()
    setRetry(value => value + 1)
  }

  return (
    <Layout className="app-shell"><WorkspaceHeader title="搜索" />
    <main id="workspace-main" tabIndex={-1} className="content-wrap">
      <div className="page-heading"><div><Typography.Title level={2}>搜索文档</Typography.Title>
        <Typography.Paragraph type="secondary">从有权限访问的标题和正文中，找到需要的资料。</Typography.Paragraph></div>
        <Button type="text" aria-label="返回文档列表" icon={<ArrowLeftOutlined />} onClick={() => navigate('/docs')}>返回文档列表</Button></div>
      <Input.Search aria-label="搜索标题和正文" placeholder="搜索标题和正文" value={input} maxLength={100} onChange={(event) => setInput(event.target.value)} onSearch={search} size="large" enterButton="搜索" className="search-box" />
      {error && <Alert type="error" showIcon message={error} action={validQuery && <Button size="small" disabled={loading} onClick={retrySearch}>重试</Button>} />}
      <Card role="region" aria-label="搜索结果" aria-busy={loading} className="search-results-card">
        {ready && <Typography.Paragraph type="secondary">找到 {total} 篇可访问的文档</Typography.Paragraph>}
        {ready && total > 10000 && <Typography.Paragraph type="secondary">最多显示前 10000 条结果，试试更具体的关键词。</Typography.Paragraph>}
        <List rowKey="id" loading={loading} dataSource={results}
          locale={{ emptyText: loading ? '正在搜索…' : <Empty description={error ? '暂时无法显示搜索结果' : ready ? '没有找到相关文档' : '输入关键词，搜索你有权限访问的标题和正文'} /> }}
          pagination={ready && total > PAGE_SIZE ? { current: page, pageSize: PAGE_SIZE, total: Math.min(total, 10000), showSizeChanger: false, responsive: true, showLessItems: true, onChange: (next) => changePage(next) } : false}
          renderItem={(item) => <List.Item><List.Item.Meta avatar={<FileTextOutlined className="doc-icon" />} title={<Link to={documentHref(item.id, sourcePath)}>{item.title}</Link>} description={<div className="search-result-description">
            <div className="search-result-metadata">
              <Tag>{item.isOwner === true ? '所有者' : item.permission === 2 ? '可编辑' : item.permission === 1 ? '只读' : '打开后查看权限'}</Tag>
              <Typography.Text type="secondary">文档 #{item.id}</Typography.Text>
              <Typography.Text type="secondary" className="search-result-owner">所有者：{typeof item.ownerName === 'string' && item.ownerName.trim()
                ? item.ownerName : Number.isSafeInteger(item.ownerId) && item.ownerId > 0 ? `用户 #${item.ownerId}` : '暂不可用'}</Typography.Text>
            </div>
            <div className="search-result-snippet">{snippetParts(item.snippet).map((part, index) => part.highlighted ? <strong key={index}>{part.text}</strong> : part.text)}</div>
            {typeof item.updateTime === 'string' && item.updateTime && <Typography.Text type="secondary" className="search-result-updated">更新于 {item.updateTime}</Typography.Text>}
          </div>} /></List.Item>} />
      </Card>
    </main></Layout>
  )
}
