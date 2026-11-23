import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Layout, Skeleton, Typography } from 'antd'
import { ArrowRightOutlined, FileTextOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons'
import { Link, useLocation } from 'react-router-dom'
import { documentHref } from '../navigation/documents'
import useDocumentReturnFocus from '../navigation/useDocumentReturnFocus'
import { usePageRequest } from '../auth/PageSessionContext'
import { parseAccountProfile } from '../auth/accountProfile'
import WorkspaceOverview from '../components/WorkspaceOverview'
import WorkspaceHeader from '../components/WorkspaceHeader'
import AccountDraftsDrawer from '../components/AccountDraftsDrawer'
import DocumentLifecycleFeedback from '../components/DocumentLifecycleFeedback'
import PendingDocumentCreations from '../components/PendingDocumentCreations'
import useBlankDocumentCreation from '../api/useBlankDocumentCreation'
import useDocumentLifecycle from '../api/useDocumentLifecycle'
import { requestFailureMessage } from '../api/requestError'
import '../styles/workbench.css'

export default function Home() {
  const request = usePageRequest()
  const location = useLocation()
  const sourcePath = location.pathname + location.search + location.hash
  const { creating, createBlankDocument, openCreatedDocument, creationIdentity } = useBlankDocumentCreation()
  const [data, setData] = useState(null)
  useDocumentReturnFocus(Boolean(data))
  const [profile, setProfile] = useState(null)
  const [profileLoading, setProfileLoading] = useState(true)
  const [profileError, setProfileError] = useState('')
  const [profileRefresh, setProfileRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const lifecycle = useDocumentLifecycle({ onConfirmed: () => setRefresh(value => value + 1) })
  const [showDrafts, setShowDrafts] = useState(false)
  const draftsButton = useRef(null)
  function closeDrafts() {
    setShowDrafts(false)
    queueMicrotask(() => draftsButton.current?.focus())
  }
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setData(null)
    request.get('/doc/workbench', { signal: controller.signal }).then(({ data }) => {
      if (controller.signal.aborted) return
      setData(data)
    }).catch(failure => {
      if (!controller.signal.aborted) setError(requestFailureMessage(failure, '文档概览暂时无法加载，请重试。'))
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh, request])
  useEffect(() => {
    const controller = new AbortController()
    setProfileLoading(true); setProfileError(''); setProfile(null)
    request.get('/account/me', { signal: controller.signal }).then(({ data }) => {
      if (!controller.signal.aborted) setProfile(parseAccountProfile(data))
    }).catch(failure => {
      if (!controller.signal.aborted) setProfileError(requestFailureMessage(failure, '账号资料暂时无法加载，可单独重试。'))
    }).finally(() => { if (!controller.signal.aborted) setProfileLoading(false) })
    return () => controller.abort()
  }, [profileRefresh, request])
  return <Layout className="app-shell">
    <WorkspaceHeader title="工作台" />
    <main id="workspace-main" tabIndex={-1} className="content-wrap workbench">
      <header className="cp-workbench-heading">
        <Typography.Title level={1}>工作台</Typography.Title>
        {profile && <p className="cp-workbench-greeting">你好，{profile.nickname?.trim() || profile.username}</p>}
        <div className="cp-workbench-actions">
          <Button size="large" type="primary" icon={<PlusOutlined aria-hidden="true" />}
            loading={creating} onClick={createBlankDocument}>新建文档</Button>
          <Link to="/search" className="cp-workbench-action"><SearchOutlined aria-hidden="true" />搜索文档</Link>
          <Link to="/templates" className="cp-workbench-action">从模板开始<ArrowRightOutlined aria-hidden="true" /></Link>
        </div>
      </header>
      {profileError && <Alert type="warning" showIcon message={profileError}
        action={<Button disabled={profileLoading} onClick={() => setProfileRefresh(value => value + 1)}>重试账号资料</Button>} />}
      <PendingDocumentCreations expectedIdentity={creationIdentity} disabled={creating} onCreated={openCreatedDocument} />
      <DocumentLifecycleFeedback lifecycle={lifecycle} returnTo={sourcePath} />
      <section className="workbench-documents" aria-labelledby="workbench-recent-title">
        <div className="cp-workbench-section-title">
          <Typography.Title level={2} id="workbench-recent-title">最近文档</Typography.Title>
          <Link to="/docs">全部文档<ArrowRightOutlined aria-hidden="true" /></Link>
        </div>
        {loading && <div className="cp-workbench-recent-status" role="status">
          <span className="cp-workbench-sr-only">正在加载最近文档</span>
          <Skeleton title={false} paragraph={{ rows: 2 }} />
        </div>}
        {error && <Alert type="error" showIcon message={error}
          action={<Button onClick={() => setRefresh(value => value + 1)}>重试文档概览</Button>} />}
        {data?.recent.length > 0 && <ul className="cp-recent-list">
          {data.recent.map(doc => <li key={doc.id}>
            <Link className="cp-recent-link" to={documentHref(doc.id, sourcePath)} data-document-id={doc.id}>
              <FileTextOutlined className="cp-recent-document-icon" aria-hidden="true" />
              <span className="cp-recent-document-text">
                <strong>{doc.title}</strong>
                <span className="cp-recent-document-meta">
                  <span>{doc.isOwner ? '我创建的' : doc.permission === 2 ? '可编辑' : '只读'}</span>
                  <span>{typeof doc.ownerName === 'string' && doc.ownerName.trim() ? doc.ownerName
                    : Number.isSafeInteger(doc.ownerId) && doc.ownerId > 0 ? '用户 #' + doc.ownerId : '所有者暂不可用'}</span>
                  <span>更新于 {doc.updateTime}</span>
                </span>
              </span>
              <ArrowRightOutlined className="cp-recent-arrow" aria-hidden="true" />
            </Link>
          </li>)}
        </ul>}
        {data?.recent.length === 0 && <p className="cp-workbench-empty">新建一篇文档，或请同伴与你共享文档。</p>}
        {data && <div className="cp-document-counts" aria-label="文档概览">
          <Link to="/docs?scope=owned"><span>我创建的文档</span><strong>{data.ownedCount}</strong></Link>
          <Link to="/docs?scope=shared"><span>与我协作的文档</span><strong>{data.sharedCount}</strong></Link>
        </div>}
      </section>
      <div className="cp-workbench-secondary">
        <WorkspaceOverview />
        <aside className="cp-workbench-tools" aria-label="资料工具">
          <section className="cp-workbench-tool"><Typography.Title level={3}>本地草稿</Typography.Title>
            <Typography.Paragraph type="secondary">继续处理保存在这个浏览器里的草稿，或下载副本。</Typography.Paragraph>
            <Button ref={draftsButton} onClick={() => setShowDrafts(true)}>查看本地草稿</Button>
          </section>
        </aside>
      </div>
    </main>
    {showDrafts && <AccountDraftsDrawer sourcePath={sourcePath} onClose={closeDrafts} />}
  </Layout>
}
