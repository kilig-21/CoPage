import { useEffect, useState } from 'react'
import { ArrowLeftOutlined, CloudOutlined, TeamOutlined } from '@ant-design/icons'
import { Alert, Avatar, Button, Layout, Modal, Space, Tag, Tooltip, Typography } from 'antd'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { documentHref, documentReturn } from '../navigation/documents'
import useQuillCollab from '../editor/useQuillCollab'
import CollaboratorModal from '../components/CollaboratorModal'
import HistoryDrawer from '../components/HistoryDrawer'
import ExportModal from '../components/ExportModal'
import PrintModal from '../components/PrintModal'
import CopyModal from '../components/CopyModal'
import RenameModal from '../components/RenameModal'
import ShareModal from '../components/ShareModal'
import { draftRecordsJson } from '../editor/draftRecords'
import { downloadTextFile } from '../editor/downloadTextFile'
import DraftBackupDownloads from '../components/DraftBackupDownloads'
import DocumentFindPanel from '../components/DocumentFindPanel'
import UserGuide from '../components/UserGuide'

export default function Editor() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const returnTarget = documentReturn(location.search)
  const docId = Number(id)
  const [renaming, setRenaming] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [managing, setManaging] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showPrint, setShowPrint] = useState(false)
  const [showCopy, setShowCopy] = useState(false)
  const [showFind, setShowFind] = useState(false)
  const [showGuide, setShowGuide] = useState(false)
  const [findFocusEpoch, setFindFocusEpoch] = useState(0)
  const [draftDownloadNotice, setDraftDownloadNotice] = useState('')
  const { editorHostRef, connection, users, error, title, permission, isOwner,
    saveStatus, titleError, refreshTitle, retryLoad, recoveryDraft, unreadableDrafts, unavailableDrafts, recoverDraft, discardDraft, canRestoreHistory, canExportDocument, documentFindState, startDocumentFind, closeDocumentFind, queryDocument, nextDocumentMatch, replaceDocumentMatch, focusDocumentEditor } = useQuillCollab(docId)
  const isConnected = connection === '已连接'
  useEffect(() => {
    if (!isOwner || permission !== 2) setManaging(false)
  }, [isOwner, permission])
  useEffect(() => {
    if (permission <= 0) setShowHistory(false)
    if (permission !== 2) setRenaming(false)
  }, [permission])
  useEffect(() => {
    document.title = permission > 0 && title ? `${title} · CoPage` : '文档 · CoPage'
  }, [title, permission])
  useEffect(() => setDraftDownloadNotice(''), [docId])
  function openFind() {
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
      if (permission <= 0 || recoveryDraft || renaming || sharing || managing || showHistory || showExport || showPrint || showCopy || showGuide ||
          event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || !['f', 'p'].includes(event.key.toLowerCase())) return
      event.preventDefault()
      if (event.key.toLowerCase() === 'p') setShowPrint(true)
      else openFind()
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [permission, recoveryDraft, renaming, sharing, managing, showHistory, showExport, showPrint, showCopy, showGuide, startDocumentFind])
  function saveRawDrafts() {
    try {
      downloadTextFile(draftRecordsJson(docId, unreadableDrafts), `原始草稿-${docId}.json`, 'application/json;charset=utf-8')
      setDraftDownloadNotice('原始草稿副本已生成，请确认浏览器下载完成。')
    } catch {
      setDraftDownloadNotice('下载失败，请重试；原始记录仍保存在此浏览器。')
    }
  }

  return (
    <Layout className="app-shell">
      <header className="topbar editor-topbar">
        <div className="editor-title-row">
          <Button type="text" aria-label={returnTarget.label} icon={<ArrowLeftOutlined />} onClick={() => navigate(returnTarget.path)}>{returnTarget.label}</Button>
          <Typography.Text className="editor-title" strong>{title || '协同文档 #' + id}</Typography.Text>
          {permission === 2 && <Button onClick={() => setRenaming(true)}>重命名</Button>}
        </div>
        <Space wrap className="editor-actions">
          <Button onClick={() => setShowGuide(true)}>使用指南</Button>
          {permission > 0 && <Button aria-label="文档内查找" title="文档内查找（Ctrl/⌘+F）" onClick={openFind}>文档内查找</Button>}
          {permission > 0 && <Button onClick={() => setSharing(true)}>分享链接</Button>}
          {permission > 0 && <Button onClick={() => setShowHistory(true)}>历史版本</Button>}
          {permission > 0 && <Button onClick={() => setShowExport(true)}>导出文档</Button>}
          {permission > 0 && <Button onClick={() => setShowCopy(true)}>创建副本</Button>}
          {permission > 0 && <Button title="打印 / PDF（Ctrl/⌘+P）" onClick={() => setShowPrint(true)}>打印 / PDF</Button>}
          {isOwner && permission === 2 && <Button icon={<TeamOutlined />} onClick={() => setManaging(true)}>协作者管理</Button>}
        </Space>
      </header>
      <main className="editor-wrap">
        <div className="editor-status-row">
          <Space wrap>
            <Tag color={isConnected ? 'green' : 'gold'} icon={<CloudOutlined />}>{connection}</Tag>
            <Typography.Text role="status" aria-live="polite">{saveStatus}</Typography.Text>
          </Space>
          <Avatar.Group max={{ count: 4 }}>
            {users.map(user => <Tooltip key={user.userId} title={user.nickname}>
              <Avatar style={{ backgroundColor: user.color }}>{user.nickname?.slice(0, 1).toUpperCase()}</Avatar>
            </Tooltip>)}
          </Avatar.Group>
        </div>
        {titleError && <Alert className="editor-alert" type="warning" message={titleError}
          action={<Button onClick={refreshTitle}>重试标题</Button>} />}
        {permission === 1 && <Alert className="editor-alert" type="info" showIcon message="你拥有只读权限，不能修改此文档" />}
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
      {renaming && permission === 2 && <RenameModal doc={{ id: docId, title }} onSaved={refreshTitle} onClose={() => setRenaming(false)} />}
      {sharing && <ShareModal docId={docId} isOwner={isOwner && permission === 2} onClose={() => setSharing(false)}
        onManage={() => { setSharing(false); setManaging(true) }} />}
      {managing && isOwner && permission === 2 && <CollaboratorModal doc={{ id: docId, title }} onClose={() => setManaging(false)} />}
      {showHistory && permission > 0 && <HistoryDrawer docId={docId} isOwner={isOwner && permission === 2}
        canRestore={canRestoreHistory} onClose={() => setShowHistory(false)} />}
      {showExport && <ExportModal docId={docId} canExport={() => permission > 0 && !recoveryDraft && canExportDocument()}
        onClose={() => setShowExport(false)} />}
      {showCopy && permission > 0 && <CopyModal doc={{ id: docId, title }}
        canCopy={() => permission > 0 && !recoveryDraft && canExportDocument()}
        onClose={() => setShowCopy(false)} onCreated={data => { setShowCopy(false); navigate(documentHref(data.id, returnTarget.path)) }} />}
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
