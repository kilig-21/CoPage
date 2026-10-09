import { useEffect, useState } from 'react'
import { ArrowLeftOutlined, FileTextOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Empty, Input, List, Space, Typography } from 'antd'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { documentHref } from '../navigation/documents'
import request from '../api/request'
import LogoutButton from '../components/LogoutButton'
import { snippetParts } from '../search/snippet'

const PAGE_SIZE = 10

export default function Search() {
  const navigate = useNavigate()
  const location = useLocation()
  const sourcePath = location.pathname + location.search + location.hash
  const [params, setParams] = useSearchParams()
  const query = (params.get('q') || '').trim()
  const rawPage = Number(params.get('page') || 1)
  const page = Number.isInteger(rawPage) && rawPage > 0 && rawPage <= 1000 ? rawPage : 1
  const [input, setInput] = useState(query)
  const [results, setResults] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)

  useEffect(() => { setInput(query) }, [query])
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setResults([])
    setTotal(0)
    setError('')
    setLoading(Boolean(query) && query.length <= 100)
    if (query.length > 100) setError('搜索内容不能超过 100 个字符')
    if (query && query.length <= 100) {
      request.get('/search', { params: { q: query, page, size: PAGE_SIZE }, signal: controller.signal })
        .then((response) => {
          if (!active) return
          const lastPage = Math.max(1, Math.ceil(Math.min(response.data.total, 10000) / PAGE_SIZE))
          if (page > lastPage) {
            setParams({ q: query, page: String(lastPage) }, { replace: true })
            return
          }
          setResults(response.data.list)
          setTotal(response.data.total)
        })
        .catch((failure) => {
          if (active) setError(failure?.message || '搜索失败，请重试')
        })
        .finally(() => { if (active) setLoading(false) })
    }
    return () => { active = false; controller.abort() }
  }, [query, page, retry])

  function search(value) {
    setParams(value.trim() ? { q: value.trim() } : {})
    setRetry((value) => value + 1)
  }

  return (
    <main className="content-wrap">
      <Space className="search-title"><Button type="text" aria-label="返回文档列表" icon={<ArrowLeftOutlined />} onClick={() => navigate('/docs')} /><Typography.Title level={2}>搜索文档</Typography.Title><Button onClick={() => navigate('/home')}>工作台</Button><LogoutButton /></Space>
      <Input.Search aria-label="搜索标题和正文" placeholder="搜索标题和正文" value={input} maxLength={100} onChange={(event) => setInput(event.target.value)} onSearch={search} loading={loading} size="large" enterButton="搜索" className="search-box" />
      {error && <Alert type="error" showIcon message={error} action={<Button size="small" onClick={() => setRetry((value) => value + 1)}>重试</Button>} />}
      <Card className="search-results-card">
        {query && !loading && !error && <Typography.Paragraph type="secondary">找到 {total} 篇可访问的文档</Typography.Paragraph>}
        {total > 10000 && !loading && !error && <Typography.Paragraph type="secondary">最多显示前 10000 条结果，试试更具体的关键词。</Typography.Paragraph>}
        <List loading={loading} dataSource={results}
          locale={{ emptyText: <Empty description={error ? '暂时无法显示搜索结果' : query ? '没有找到相关文档' : '输入关键词，搜索你有权限访问的标题和正文'} /> }}
          pagination={total > PAGE_SIZE ? { current: page, pageSize: PAGE_SIZE, total: Math.min(total, 10000), showSizeChanger: false, onChange: (next) => setParams({ q: query, page: String(next) }) } : false}
          renderItem={(item) => <List.Item><List.Item.Meta avatar={<FileTextOutlined className="doc-icon" />} title={<Link to={documentHref(item.id, sourcePath)}>{item.title}</Link>} description={<span>{snippetParts(item.snippet).map((part, index) => part.highlighted ? <strong key={index}>{part.text}</strong> : part.text)}</span>} /></List.Item>} />
      </Card>
    </main>
  )
}
