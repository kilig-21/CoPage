import { useEffect, useState } from 'react'
import { ArrowLeftOutlined, CloudOutlined, TeamOutlined } from '@ant-design/icons'
import { Alert, Avatar, Button, Layout, Modal, Space, Tag, Tooltip, Typography } from 'antd'
import { useNavigate, useParams } from 'react-router-dom'
import useQuillCollab from '../editor/useQuillCollab'
import CollaboratorModal from '../components/CollaboratorModal'
import HistoryDrawer from '../components/HistoryDrawer'
import ExportModal from '../components/ExportModal'
import RenameModal from '../components/RenameModal'
import ShareModal from '../components/ShareModal'
import { draftRecordsJson } from '../editor/draftRecords'
import { downloadTextFile } from '../editor/downloadTextFile'
import DraftBackupDownloads from '../components/DraftBackupDownloads'

export default function Editor() {
  const { id } = useParams()
  const navigate = useNavigate()
  const docId = Number(id)
  const [renaming, setRenaming] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [managing, setManaging] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [draftDownloadNotice, setDraftDownloadNotice] = useState('')
  const { editorHostRef, connection, users, error, title, permission, isOwner,
    saveStatus, titleError, refreshTitle, retryLoad, recoveryDraft, unreadableDrafts, unavailableDrafts, recoverDraft, discardDraft, canRestoreHistory, canExportDocument } = useQuillCollab(docId)
  const isConnected = connection === '已连接'
  useEffect(() => {
    document.title = permission > 0 && title ? `${title} · CoPage` : '文档 · CoPage'
  }, [title, permission])
  useEffect(() => setDraftDownloadNotice(''), [docId])
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
          <Button type="text" aria-label="返回文档列表" icon={<ArrowLeftOutlined />} onClick={() => navigate('/docs')} />
          <Typography.Text className="editor-title" strong>{title || '协同文档 #' + id}</Typography.Text>
          {permission === 2 && <Button onClick={() => setRenaming(true)}>重命名</Button>}
        </div>
        <Space wrap className="editor-actions">
          {permission > 0 && <Button onClick={() => setSharing(true)}>分享链接</Button>}
          {permission > 0 && <Button onClick={() => setShowHistory(true)}>历史版本</Button>}
          {permission > 0 && <Button onClick={() => setShowExport(true)}>导出文档</Button>}
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
            <Button onClick={() => navigate('/docs')}>稍后处理，返回列表</Button></>} />}
        <section className="editor-canvas">
          <div ref={editorHostRef} className="editor-host" aria-label="协同编辑器" />
        </section>
      </main>
      {renaming && <RenameModal doc={{ id: docId, title }} onSaved={refreshTitle} onClose={() => setRenaming(false)} />}
      {sharing && <ShareModal docId={docId} isOwner={isOwner && permission === 2} onClose={() => setSharing(false)}
        onManage={() => { setSharing(false); setManaging(true) }} />}
      {managing && <CollaboratorModal doc={{ id: docId, title }} onClose={() => setManaging(false)} />}
      {showHistory && <HistoryDrawer docId={docId} isOwner={isOwner && permission === 2}
        canRestore={canRestoreHistory} onClose={() => setShowHistory(false)} />}
      {showExport && <ExportModal docId={docId} canExport={() => permission > 0 && !recoveryDraft && canExportDocument()}
        onClose={() => setShowExport(false)} />}
      <Modal title="发现未确认的本地编辑" open={Boolean(recoveryDraft)} closable={false}
        maskClosable={false} keyboard={false} onCancel={() => undefined}
        footer={[
          <Button key="discard" danger onClick={discardDraft}>丢弃本地草稿</Button>,
          <Button key="later" onClick={() => navigate('/docs')}>稍后处理</Button>,
          <Button key="recover" type="primary" disabled={permission !== 2} onClick={recoverDraft}>恢复草稿并同步</Button>,
        ]}>
        <Typography.Paragraph>这份草稿可能包含服务端尚未确认的修改。恢复前不会自动重发，也不会覆盖本地草稿。</Typography.Paragraph>
        {permission !== 2 && <Typography.Paragraph>当前没有编辑权限，暂时不能同步这份草稿。可以先下载副本或稍后处理，草稿会继续保留。</Typography.Paragraph>}
        {recoveryDraft && <DraftBackupDownloads key={`${docId}:${recoveryDraft.savedAt}`} backup={recoveryDraft} />}
      </Modal>
    </Layout>
  )
}
