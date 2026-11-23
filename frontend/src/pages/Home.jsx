import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Layout, Skeleton, Typography } from 'antd'
import { ArrowRightOutlined, FileTextOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons'
import { Link, useLocation } from 'react-router-dom'
import { documentHref } from '../navigation/documents'
import useDocumentReturnFocus from '../navigation/useDocumentReturnFocus'
import { usePageSession } from '../auth/PageSessionContext'
import { parseAccountProfile } from '../auth/accountProfile'
import { hasAccountDraftRecords } from '../editor/accountDrafts'
import WorkspaceOverview from '../components/WorkspaceOverview'
import WorkspaceHeader from '../components/WorkspaceHeader'
import DocumentLifecycleFeedback from '../components/DocumentLifecycleFeedback'
import PendingDocumentCreations from '../components/PendingDocumentCreations'
import useBlankDocumentCreation from '../api/useBlankDocumentCreation'
import useDocumentLifecycle from '../api/useDocumentLifecycle'
import useWorkspaceOverview from '../api/useWorkspaceOverview'
import { requestFailureMessage } from '../api/requestError'
import '../styles/workbench.css'

export default function Home() {
  const session = usePageSession()
  const { request } = session
  const location = useLocation()
  const sourcePath = location.pathname + location.search + location.hash
  const workspace = useWorkspaceOverview()
  const invitationCount = workspace.data?.pendingInvitationCount ?? 0
  const { creating, createBlankDocument, openCreatedDocument, creationIdentity } = useBlankDocumentCreation()
  const [data, setData] = useState(null)
  useDocumentReturnFocus(Boolean(data))
  const [profile, setProfile] = useState(null)
  const [profileLoading, setProfileLoading] = useState(true)
  const [profileError, setProfileError] = useState('')
  const [profileRefresh, setProfileRefresh] = useState(0)
  const profileRetry = useRef(null)
  const greeting = useRef(null)
  const displayName = profile?.nickname?.trim() || profile?.username || session.identity?.account
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const lifecycle = useDocumentLifecycle({ onConfirmed: () => setRefresh(value => value + 1) })
  const [DraftsDrawer, setDraftsDrawer] = useState(null)
  const [draftsStatus, setDraftsStatus] = useState('idle')
  const [draftSession, setDraftSession] = useState(null)
  const hasLocalDrafts = draftSession === session
  const draftsTrigger = useRef(null)
  const draftsRetry = useRef(null)
  const main = useRef(null)
  async function openDrafts(event) {
    if (draftsStatus === 'loading' || !session.current()) return
    draftsTrigger.current = event.currentTarget
    setDraftsStatus('loading')
    try {
      const { default: Drawer } = await import('../components/AccountDraftsDrawer')
      if (session.current()) setDraftsDrawer(() => Drawer)
      setDraftsStatus('idle')
    } catch {
      setDraftsStatus(session.current() ? 'failed' : 'idle')
    }
  }
  function closeDrafts() {
    setDraftsDrawer(null)
    queueMicrotask(() => {
      const trigger = draftsTrigger.current
      const target = trigger?.isConnected ? trigger : main.current
      target?.focus({ preventScroll: true })
    })
  }
  useEffect(() => {
    if (draftsStatus === 'failed' && document.activeElement === draftsTrigger.current) {
      draftsRetry.current?.focus()
    }
  }, [draftsStatus])
  useEffect(() => {
    function updateDraftPresence() {
      try {
        const hasRecords = hasAccountDraftRecords({
          storage: localStorage, username: session.identity?.account, isCurrent: session.current,
        })
        setDraftSession(hasRecords ? session : null)
      } catch {
        setDraftSession(null)
      }
    }
    updateDraftPresence()
    window.addEventListener('storage', updateDraftPresence)
    window.addEventListener('copage-auth-changed', updateDraftPresence)
    return () => {
      window.removeEventListener('storage', updateDraftPresence)
      window.removeEventListener('copage-auth-changed', updateDraftPresence)
    }
  }, [session])
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
    setProfileLoading(true)
    request.get('/account/me', { signal: controller.signal }).then(({ data }) => {
      if (controller.signal.aborted) return
      setProfile(parseAccountProfile(data))
      setProfileError('')
      if (greeting.current && document.activeElement === profileRetry.current) {
        greeting.current.focus({ preventScroll: true })
        greeting.current.scrollIntoView({ block: 'center', behavior: 'instant' })
      }
    }).catch(failure => {
      if (!controller.signal.aborted) setProfileError(requestFailureMessage(failure, '账号资料暂时无法加载，可单独重试。'))
    }).finally(() => { if (!controller.signal.aborted) setProfileLoading(false) })
    return () => controller.abort()
  }, [profileRefresh, request])
  const draftsAction = <>
    <Button loading={draftsStatus === 'loading'} aria-busy={draftsStatus === 'loading'} onClick={openDrafts}>
      {draftsStatus === 'loading' ? '正在打开草稿…' : '查看本地草稿'}
    </Button>
    {draftsStatus === 'failed' && <Alert className="cp-workbench-draft-error" type="warning" showIcon
      message="暂时无法打开草稿清单" description="刷新页面后重试，本地记录会保留。"
      action={<Button ref={draftsRetry} onClick={() => window.location.reload()}>刷新页面</Button>} />}
  </>
  return <Layout className="app-shell">
    <WorkspaceHeader title="工作台" />
    <main ref={main} id="workspace-main" tabIndex={-1} className="content-wrap workbench">
      <header className="cp-workbench-heading">
        <Typography.Title level={1}>工作台</Typography.Title>
        {displayName && <p ref={greeting} tabIndex={-1} className="cp-workbench-greeting">你好，{displayName}</p>}
        <div className="cp-workbench-actions">
          <Button size="large" type="primary" icon={<PlusOutlined aria-hidden="true" />}
            loading={creating} onClick={createBlankDocument}>新建文档</Button>
          <Link to="/search" className="cp-workbench-action"><SearchOutlined aria-hidden="true" />搜索文档</Link>
          <Link to="/templates" className="cp-workbench-action">从模板开始<ArrowRightOutlined aria-hidden="true" /></Link>
        </div>
      </header>
      {hasLocalDrafts && <section className="cp-workbench-notice" aria-label="本地草稿提醒">
        <p role="status"><strong>有本地草稿</strong><span>可核对此浏览器保存的记录，或下载副本。</span></p>
        {draftsAction}
      </section>}
      {invitationCount > 0 && <section className="cp-workbench-notice" aria-label="小组邀请提醒">
        <p role="status"><strong>有 {invitationCount} 个小组邀请待处理</strong>
          {invitationCount === 1 && workspace.data.invitations[0] && <span>{workspace.data.invitations[0].name}</span>}
        </p>
        <Link to="/groups#group-invitations" className="cp-workbench-action">查看并处理邀请<ArrowRightOutlined aria-hidden="true" /></Link>
      </section>}
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
      {profileError && <Alert className="cp-workbench-profile-error" type="warning" showIcon message={profileError}
        action={<Button loading={profileLoading} aria-busy={profileLoading} onClick={event => {
          profileRetry.current = event.currentTarget
          setProfileRefresh(value => value + 1)
        }}>重试账号资料</Button>} />}
      <div className="cp-workbench-secondary">
        <WorkspaceOverview {...workspace} />
        {!hasLocalDrafts && <aside className="cp-workbench-tools" aria-label="资料工具">
          <section className="cp-workbench-tool"><Typography.Title level={3}>本地草稿</Typography.Title>
            <Typography.Paragraph type="secondary">继续处理保存在这个浏览器里的草稿，或下载副本。</Typography.Paragraph>
            {draftsAction}
          </section>
        </aside>}
      </div>
    </main>
    {DraftsDrawer && <DraftsDrawer sourcePath={sourcePath} onClose={closeDrafts} />}
  </Layout>
}
