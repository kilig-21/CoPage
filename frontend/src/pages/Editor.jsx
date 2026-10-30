import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeftOutlined, CloudOutlined, MoreOutlined, SearchOutlined, ShareAltOutlined } from '@ant-design/icons'
import { Alert, Avatar, Button, Dropdown, Layout, Modal, Popover, Space, Tag, Tooltip, Typography } from 'antd'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { documentHref, documentReturn } from '../navigation/documents'
import useQuillCollab from '../editor/useQuillCollab'
import useEditorStickyOffsets from '../editor/useEditorStickyOffsets'
import CollaboratorModal from '../components/CollaboratorModal'
import HistoryDrawer from '../components/HistoryDrawer'
import ExportModal from '../components/ExportModal'
import PrintModal from '../components/PrintModal'
import CopyModal from '../components/CopyModal'
import SavePersonalTemplateModal from '../components/SavePersonalTemplateModal'
import RenameModal from '../components/RenameModal'
import ShareModal from '../components/ShareModal'
import { draftRecordsJson } from '../editor/draftRecords'
import { downloadTextFile } from '../editor/downloadTextFile'
import DraftBackupDownloads from '../components/DraftBackupDownloads'
import DocumentFindPanel from '../components/DocumentFindPanel'
import DocumentImagesModal from '../components/DocumentImagesModal'
import UserGuide from '../components/UserGuide'
import PendingCopyHint from '../components/PendingCopyHint'
import { usePageRequest } from '../auth/PageSessionContext'
import '../styles/editor-workspace.css'

export default function Editor() {
  const request = usePageRequest()
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const returnTarget = documentReturn(location.search)
  const docId = Number(id)
  const topbarRef = useRef(null)
  const statusRef = useRef(null)
  const toolsButtonRef = useRef(null)
  useEditorStickyOffsets(topbarRef, statusRef)
  const [renaming, setRenaming] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [managing, setManaging] = useState(null)
  const activeManagement = useRef(null)
  const managementScope = useRef(null)
  const [shareError, setShareError] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showPrint, setShowPrint] = useState(false)
  const [showCopy, setShowCopy] = useState(false)
  const [savingTemplate, setSavingTemplate] = useState(null)
  const [templateNotice, setTemplateNotice] = useState(null)
  const templateScope = useRef(null)
  const [showFind, setShowFind] = useState(false)
  const [showImages, setShowImages] = useState(false)
  const [showGuide, setShowGuide] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [titleOpen, setTitleOpen] = useState(false)
  const [findFocusEpoch, setFindFocusEpoch] = useState(0)
  const [draftDownloadNotice, setDraftDownloadNotice] = useState('')
  const { editorHostRef, connection, users, error, title, permission, isOwner,
    saveStatus, titleError, refreshTitle, retryLoad, recoveryDraft, unreadableDrafts, unavailableDrafts, skippedDraftNotice, dismissSkippedDraftNotice, recoverDraft, discardDraft, canRestoreHistory, canExportDocument, documentFindState, startDocumentFind, closeDocumentFind, queryDocument, nextDocumentMatch, replaceDocumentMatch, focusDocumentEditor, revealDocumentMatch,
    documentImagesState, startDocumentImages, closeDocumentImages, saveDocumentImageDescription } = useQuillCollab(docId)
  useLayoutEffect(() => {
    if (showFind) revealDocumentMatch()
  }, [showFind, findFocusEpoch, revealDocumentMatch])
  const isConnected = connection === '已连接'
  managementScope.current = { docId, isOwner, permission }
  templateScope.current = { docId, permission, routeKey: location.key }
  const displayTitle = title || '协同文档 #' + id
  const documentTools = [
    ...(permission === 2 ? [{ key: 'rename', label: '重命名' }] : []),
    { key: 'history', label: '历史版本' }, { key: 'copy', label: '创建副本' },
    { key: 'images', label: '图片说明' },
    { key: 'template', label: '保存为个人模板', disabled: Boolean(templateNotice?.type === 'warning' && currentTemplateContext(templateNotice.context)) },
    { key: 'export', label: '导出文档' }, { key: 'print', label: '打印 / PDF' },
  ]
  const tools = [
    ...(permission > 0 ? [{ type: 'group', label: '文档', children: documentTools }] : []),
    ...(isOwner && permission === 2 ? [{ type: 'group', label: '协作', children: [{ key: 'manage', label: '协作者管理' }] }] : []),
    ...(permission > 0 ? [{ type: 'divider' }] : []),
    { key: 'guide', label: '使用指南' },
  ]
  function selectTool({ key }) {
    setToolsOpen(false)
    if (key === 'images') { startDocumentImages(); setShowImages(true); return }
    if (key === 'manage') { openManagement(false); return }
    if (key === 'template') { setSavingTemplate(templateContext()); return }
    const actions = { rename: setRenaming, history: setShowHistory, copy: setShowCopy,
      export: setShowExport, print: setShowPrint, guide: setShowGuide }
    actions[key]?.(true)
  }
  function managementContext(fromShare) {
    const scope = managementScope.current
    if (!scope?.isOwner || scope.permission !== 2) return null
    try {
      const account = localStorage.getItem('collab-user'), token = localStorage.getItem('collab-token')
      return account && token ? { docId: scope.docId, account, token, service: request.defaults.baseURL, fromShare } : null
    } catch { return null }
  }
  function templateContext() {
    const scope = templateScope.current
    if (!scope || scope.permission <= 0) return null
    try {
      const account = localStorage.getItem('collab-user'), token = localStorage.getItem('collab-token')
      return account && token ? { id: scope.docId, title, routeKey: scope.routeKey, account, token, service: request.defaults.baseURL } : null
    } catch { return null }
  }
  function currentTemplateContext(context) {
    const current = templateContext()
    return Boolean(context && current && context.id === current.id && context.routeKey === current.routeKey &&
      context.account === current.account && context.token === current.token && context.service === current.service)
  }
  function viewPersonalTemplates(name) {
    navigate('/templates?' + new URLSearchParams({ source: 'personal', keyword: name }).toString())
  }
  function currentManagement(context) {
    const current = managementContext(false)
    return Boolean(context && current && context.docId === current.docId && context.account === current.account &&
      context.token === current.token && context.service === current.service)
  }
  function changeManagement(context) {
    activeManagement.current = context
    setManaging(context)
  }
  function openManagement(fromShare) {
    const context = managementContext(fromShare)
    if (!context) {
      if (fromShare) setShareError('当前账号或权限暂时无法核对，请恢复登录信息后再设置协作者；分享链接仍可查看。')
      return
    }
    setShareError('')
    if (fromShare) setSharing(false)
    changeManagement(context)
  }
  function closeManagement(context) {
    if (activeManagement.current !== context) return
    const returnToShare = context?.fromShare && currentManagement(context)
    changeManagement(null)
    if (returnToShare) setSharing(true)
  }
  useEffect(() => { setToolsOpen(false); setTitleOpen(false) }, [docId, permission])
  useEffect(() => { changeManagement(null); setSharing(false); setShareError(''); setShowImages(false) }, [docId])
  useEffect(() => { setSavingTemplate(null); setTemplateNotice(null) }, [docId, location.key])
  useEffect(() => {
    const close = event => {
      if (event.type === 'storage' && event.key !== null && !['collab-user', 'collab-token'].includes(event.key)) return
      changeManagement(null); setSharing(false); setShareError('')
      setSavingTemplate(null); setTemplateNotice(null)
      setShowImages(false)
    }
    window.addEventListener('storage', close)
    window.addEventListener('copage-auth-changed', close)
    return () => { window.removeEventListener('storage', close); window.removeEventListener('copage-auth-changed', close) }
  }, [])
  useEffect(() => {
    if (!isOwner || permission !== 2) changeManagement(null)
  }, [isOwner, permission])
  useEffect(() => {
    if (permission <= 0) { setShowHistory(false); setShowCopy(false); setSharing(false); setSavingTemplate(null); setTemplateNotice(null); setShowImages(false) }
    if (permission !== 2) setRenaming(false)
  }, [permission])
  useEffect(() => {
    document.title = permission > 0 && title ? `${title} · CoPage` : '文档 · CoPage'
  }, [title, permission])
  useEffect(() => setDraftDownloadNotice(''), [docId])
  function openFind() {
    setToolsOpen(false)
    startDocumentFind()
    setShowFind(true)
    setFindFocusEpoch(value => value + 1)
  }
  function closeFind() {
    closeDocumentFind()
    setShowFind(false)
    queueMicrotask(focusDocumentEditor)
  }
  useEffect(() => {
    const shortcut = event => {
      if (permission <= 0 || recoveryDraft || renaming || sharing || managing || savingTemplate || showHistory || showExport || showPrint || showCopy || showGuide || showImages ||
          event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || !['f', 'p'].includes(event.key.toLowerCase())) return
      event.preventDefault()
      if (event.key.toLowerCase() === 'p') { setToolsOpen(false); setShowPrint(true) }
      else openFind()
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [permission, recoveryDraft, renaming, sharing, managing, savingTemplate, showHistory, showExport, showPrint, showCopy, showGuide, showImages, startDocumentFind])
  function saveRawDrafts() {
    try {
      downloadTextFile(draftRecordsJson(docId, unreadableDrafts), `原始草稿-${docId}.json`, 'application/json;charset=utf-8')
      setDraftDownloadNotice('原始草稿副本已生成，请确认浏览器下载完成。')
    } catch {
      setDraftDownloadNotice('下载失败，请重试；原始记录仍保存在此浏览器。')
    }
  }

  return (
    <Layout className="app-shell editor-workspace">
      <header className="topbar editor-topbar" ref={topbarRef}>
        <div className="editor-title-row">
          <Tooltip title={returnTarget.label}><Button type="text" className="editor-return" aria-label={returnTarget.label}
            icon={<ArrowLeftOutlined aria-hidden="true" />} onClick={() => navigate(returnTarget.path)}><span className="editor-action-label">{returnTarget.label}</span></Button></Tooltip>
          <div className="editor-document-context">
            <span className="editor-brand">CoPage</span>
            <h1 className="editor-title"><Popover title="文档标题" content={<p className="editor-full-title">{displayTitle}</p>}
              trigger="click" open={titleOpen} onOpenChange={setTitleOpen} placement="bottom" overlayClassName="editor-title-popover">
              <Button className="editor-title-reveal" type="text" aria-label={'查看完整标题：' + displayTitle} aria-expanded={titleOpen}
                onBlur={() => setTitleOpen(false)} onKeyDown={event => { if (event.key === 'Escape') setTitleOpen(false) }}><span>{displayTitle}</span></Button>
            </Popover></h1>
          </div>
        </div>
        <Space className="editor-actions" size={4}>
          {permission > 0 && <Tooltip title="文档内查找（Ctrl/⌘+F）"><Button type="text" aria-label="文档内查找"
            icon={<SearchOutlined aria-hidden="true" />} onClick={openFind}><span className="editor-action-label">查找</span></Button></Tooltip>}
          {permission > 0 && <Tooltip title="分享链接"><Button type="text" aria-label="分享链接" icon={<ShareAltOutlined aria-hidden="true" />}
            onClick={() => setSharing(true)}><span className="editor-action-label">分享</span></Button></Tooltip>}
          <Dropdown trigger={['click']} autoFocus open={toolsOpen} onOpenChange={setToolsOpen} menu={{ items: tools, onClick: selectTool }}>
            <Button ref={toolsButtonRef} type="text" aria-label="更多文档操作" aria-haspopup="menu" aria-expanded={toolsOpen} icon={<MoreOutlined aria-hidden="true" />}>
              <span className="editor-action-label">更多</span></Button>
          </Dropdown>
        </Space>
      </header>
      <main className="editor-wrap">
        <PendingCopyHint sourceId={docId} />
        {templateNotice && currentTemplateContext(templateNotice.context) && <Alert className="editor-alert" type={templateNotice.type} showIcon
          message={templateNotice.message} action={<Button onClick={() => { if (currentTemplateContext(templateNotice.context)) viewPersonalTemplates(templateNotice.name) }}>{templateNotice.type === 'warning' ? '核对我的模板' : '查看我的模板'}</Button>} />}
        <div className="editor-status-row" ref={statusRef}>
          <Space wrap className="editor-save-state">
            <Tag color={isConnected ? 'green' : 'gold'} icon={<CloudOutlined />}>{connection}</Tag>
            <Typography.Text className="editor-save-status" role="status" aria-live="polite">{saveStatus}</Typography.Text>
          </Space>
          {isConnected && <div className="editor-presence" role="group" aria-label="在线协作者"><Avatar.Group size={28} max={{ count: 2 }}>
            {users.map(user => <Tooltip key={user.userId} title={user.nickname} trigger={['hover', 'focus']}>
              <Avatar tabIndex={0} aria-label={user.nickname} style={{ backgroundColor: user.color }}>{user.nickname?.slice(0, 1).toUpperCase()}</Avatar>
            </Tooltip>)}
          </Avatar.Group></div>}
        </div>
        {titleError && <Alert className="editor-alert" type="warning" message={titleError}
          action={<Button onClick={refreshTitle}>重试标题</Button>} />}
        {permission === 1 && <Alert className="editor-alert" type="info" showIcon message="你拥有只读权限，不能修改此文档" />}
        {skippedDraftNotice && <Alert className="editor-alert editor-draft-notice" type="info" showIcon
          message="打开文档时发现其他标签的本地草稿，本页未接管"
          description="请回原标签或工作台的本地草稿核对。本页显示的保存状态仅针对本页编辑；关闭此提示不会删除草稿。"
          action={<Button onClick={dismissSkippedDraftNotice}>关闭提示</Button>} />}
        {unreadableDrafts.length > 0 && <Alert className="editor-alert" type="warning" showIcon
          message={`有 ${unreadableDrafts.length} 份旧草稿无法自动恢复，原始记录已保留`}
          description={<><p>{connection === '加载失败' ? '服务器正文未能加载。' : '当前正文来自服务器已保存版本。'}请保存原始草稿副本留存；它不能直接作为文档导入。</p>
            <Button onClick={saveRawDrafts}>保存原始草稿</Button>
            {draftDownloadNotice && <p role="status">{draftDownloadNotice}</p>}</>} />}
        {error && <Alert className="editor-alert" type="warning" showIcon message={error}
          action={connection === '加载失败' ? <Button onClick={retryLoad}>重试加载</Button> : undefined} />}
        {unavailableDrafts.length > 0 && <Alert className="editor-alert" type="info" showIcon
          message="文档未能打开，但此账号的本地草稿仍可保存"
          description={<><p>以下是此浏览器中保存的草稿副本，可能包含未同步内容。保存副本不会恢复原文档访问权限，也不会向服务器提交修改。</p>
            {unavailableDrafts.map(({ key, backup }, index) => <div key={key}>
              {unavailableDrafts.length > 1 && <Typography.Paragraph strong>本地草稿 {index + 1}</Typography.Paragraph>}
              <DraftBackupDownloads backup={backup} />
            </div>)}
            <Button onClick={() => navigate(returnTarget.path)}>稍后处理，{returnTarget.label}</Button></>} />}
        {showFind && permission > 0 && <DocumentFindPanel state={documentFindState} permission={permission}
          focusEpoch={findFocusEpoch} onQuery={queryDocument} onNext={nextDocumentMatch}
          onReplace={replaceDocumentMatch} onClose={closeFind} />}
        <section className="editor-canvas">
          <div ref={editorHostRef} className="editor-host" aria-label="协同编辑器" />
        </section>
      </main>
      {showGuide && <UserGuide initialSection="save" onClose={() => setShowGuide(false)} />}
      {showImages && permission > 0 && <DocumentImagesModal state={documentImagesState} permission={permission}
        onSave={saveDocumentImageDescription} onClose={() => {
          closeDocumentImages(); setShowImages(false)
          queueMicrotask(() => toolsButtonRef.current?.focus({ preventScroll: true }))
        }} />}
      {renaming && permission === 2 && <RenameModal doc={{ id: docId, title }} onSaved={refreshTitle} onClose={() => setRenaming(false)} />}
      {sharing && <ShareModal docId={docId} isOwner={isOwner && permission === 2} managementError={shareError} onClose={() => setSharing(false)}
        onManage={() => openManagement(true)} />}
      {managing && currentManagement(managing) && <CollaboratorModal doc={{ id: docId, title }} returnToShare={managing.fromShare} onClose={() => closeManagement(managing)} />}
      {showHistory && permission > 0 && <HistoryDrawer docId={docId} isOwner={isOwner && permission === 2}
        canRestore={canRestoreHistory} onClose={() => setShowHistory(false)} />}
      {showExport && <ExportModal docId={docId} canExport={() => permission > 0 && !recoveryDraft && canExportDocument()}
        onClose={() => setShowExport(false)} />}
      {showCopy && permission > 0 && <CopyModal doc={{ id: docId, title }}
        canCopy={() => permission > 0 && !recoveryDraft && canExportDocument()}
        onClose={() => setShowCopy(false)} onCreated={data => { setShowCopy(false); navigate(documentHref(data.id, returnTarget.path)) }} />}
      {savingTemplate && currentTemplateContext(savingTemplate) && <SavePersonalTemplateModal key={savingTemplate.id + ':' + savingTemplate.routeKey}
        doc={savingTemplate} canSave={() => currentTemplateContext(savingTemplate) && !recoveryDraft && canExportDocument()}
        onClose={() => setSavingTemplate(null)} onReview={name => { if (currentTemplateContext(savingTemplate)) viewPersonalTemplates(name) }}
        onUncertain={name => { if (currentTemplateContext(savingTemplate)) setTemplateNotice({ context: savingTemplate, name, type: 'warning',
          message: '模板保存结果未确认。请先核对我的模板，再决定是否重新保存；原文档与本地草稿保留。' }) }}
        onSaved={data => {
          if (!currentTemplateContext(savingTemplate)) return
          setTemplateNotice({ context: savingTemplate, name: data.name, type: 'success',
            message: '已将服务端版本 ' + data.sourceRevision + ' 保存为个人模板，可以继续编辑。' })
          setSavingTemplate(null)
        }} />}
      {showPrint && permission > 0 && <PrintModal docId={docId}
        canPrint={() => permission > 0 && !recoveryDraft && canExportDocument()}
        onClose={() => setShowPrint(false)} />}
      <Modal title="发现未确认的本地编辑" open={Boolean(recoveryDraft)} closable={false}
        maskClosable={false} keyboard={false} onCancel={() => undefined}
        footer={[
          <Button key="discard" danger onClick={discardDraft}>丢弃本地草稿</Button>,
          <Button key="later" onClick={() => navigate(returnTarget.path)}>稍后处理</Button>,
          <Button key="recover" type="primary" disabled={permission !== 2} onClick={recoverDraft}>恢复草稿并同步</Button>,
        ]}>
        <Typography.Paragraph>这份草稿可能包含服务端尚未确认的修改。恢复前不会自动重发，也不会覆盖本地草稿。</Typography.Paragraph>
        {permission !== 2 && <Typography.Paragraph>当前没有编辑权限，暂时不能同步这份草稿。可以先下载副本或稍后处理，草稿会继续保留。</Typography.Paragraph>}
        {recoveryDraft && <DraftBackupDownloads key={`${docId}:${recoveryDraft.savedAt}`} backup={recoveryDraft} />}
      </Modal>
    </Layout>
  )
}
