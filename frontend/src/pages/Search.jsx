import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRightOutlined } from '@ant-design/icons'
import { Alert, Button, Input, Layout, List, Skeleton, Tag, Typography } from 'antd'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { documentHref } from '../navigation/documents'
import { usePageRequest } from '../auth/PageSessionContext'
import { requestFailureMessage } from '../api/requestError'
import WorkspaceHeader from '../components/WorkspaceHeader'
import SearchExcerpt from '../components/SearchExcerpt'
import WorkspacePageHeading from '../components/WorkspacePageHeading'

const PAGE_SIZE = 10

export default function Search() {
  const request = usePageRequest()
  const location = useLocation()
  const sourcePath = location.pathname + location.search + location.hash
  const [params, setParams] = useSearchParams()
  const query = (params.get('q') || '').trim()
  const rawPage = Number(params.get('page') || 1)
  const page = Number.isInteger(rawPage) && rawPage > 0 && rawPage <= 1000 ? rawPage : 1
  const [input, setInput] = useState(query)
  const searchInput = useRef(null)
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

  const discardRead = useCallback(() => {
    const old = activeRequest.current
    activeRequest.current = null
    old?.controller.abort()
    setRead(null)
  }, [])
  const changePage = useCallback((next, replace = false) => {
    discardRead()
    setParams({ q: query, page: String(next) }, { replace })
  }, [discardRead, query, setParams])

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
          if (current()) setRead({ key: readKey, status: 'error', error: requestFailureMessage(failure, '搜索暂时无法加载，请重试。') })
        })
        .finally(() => { if (current()) activeRequest.current = null })
    }
    return () => { controller.abort(); if (activeRequest.current === attempt) activeRequest.current = null }
  }, [query, page, readKey, validQuery, changePage, request])

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
  function clearSearch() {
    search('')
    searchInput.current?.focus()
  }

  const resultStatus = loading ? '正在搜索…'
    : ready ? (total === 0 ? '没有找到相关文档' : `找到 ${total} 篇可访问的文档`)
      : error ? '' : '可按标题或正文查找有权限访问的文档。'

  return (
    <Layout className="app-shell"><WorkspaceHeader title="搜索" />
    <main id="workspace-main" tabIndex={-1} className="content-wrap document-search">
      <WorkspacePageHeading title="搜索文档" />
      <div role="search" aria-label="文档搜索">
        <Input.Search ref={searchInput} aria-label="搜索标题和正文" placeholder="搜索标题和正文" value={input} maxLength={100}
          onChange={event => setInput(event.target.value)} onSearch={search} size="large" enterButton="搜索" />
      </div>
      <div className="search-result-summary">
        <p role="status">{resultStatus}</p>
        {(query || input) && <Button type="text" onClick={clearSearch}>清除搜索</Button>}
      </div>
      <section aria-label="搜索结果" aria-busy={loading} className="search-results">
        {error && <Alert type="error" showIcon message={error}
          action={validQuery && <Button onClick={retrySearch}>重试搜索</Button>} />}
        {loading && <div className="search-loading" aria-hidden="true"><Skeleton title={false} paragraph={{ rows: 2 }} /></div>}
        {ready && total === 0 && <p className="search-empty-hint">试试减少关键词，或换一个文档标题或正文中的词。</p>}
        {ready && total > 10000 && <Typography.Paragraph type="secondary">最多显示前 10000 条结果，试试更具体的关键词。</Typography.Paragraph>}
        {results.length > 0 && <List rowKey="id" dataSource={results}
          pagination={ready && total > PAGE_SIZE ? { current: page, pageSize: PAGE_SIZE, total: Math.min(total, 10000), showSizeChanger: false, responsive: true, showLessItems: true, onChange: (next) => changePage(next) } : false}
          renderItem={item => <List.Item className="search-result-item">
            <h2 className="search-result-title"><Link to={documentHref(item.id, sourcePath)}>
              <span>{item.title}</span><ArrowRightOutlined aria-hidden="true" />
            </Link></h2>
            <SearchExcerpt snippet={item.snippet} title={item.title} />
            <div className="search-result-metadata">
              <Tag>{item.isOwner === true ? '所有者' : item.permission === 2 ? '可编辑' : item.permission === 1 ? '只读' : '打开后查看权限'}</Tag>
              <Typography.Text type="secondary" className="search-result-owner">所有者：{typeof item.ownerName === 'string' && item.ownerName.trim()
                ? item.ownerName : Number.isSafeInteger(item.ownerId) && item.ownerId > 0 ? `用户 #${item.ownerId}` : '暂不可用'}</Typography.Text>
              {typeof item.updateTime === 'string' && item.updateTime && <Typography.Text type="secondary">更新于 {item.updateTime}</Typography.Text>}
              <Typography.Text type="secondary">文档 #{item.id}</Typography.Text>
            </div>
          </List.Item>} />}
      </section>
      <Link to="/docs" className="search-document-list-link">返回文档列表</Link>
    </main></Layout>
  )
}
