import { useEffect, useState } from 'react'
import { Alert, Button, Drawer, Empty, List, Space, Spin, Tag, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'
import Delta from 'quill-delta'
import { enumerateAccountDrafts, readAccountDraft } from '../editor/accountDrafts'
import { draftBackupJson, draftBackupText } from '../editor/draftBackup'
import { draftRecordsJson } from '../editor/draftRecords'
import { downloadTextFile } from '../editor/downloadTextFile'
import { documentHref } from '../navigation/documents'
import '../styles/account-drafts.css'

function captureIdentity() {
  try {
    const token = localStorage.getItem('collab-token'), username = localStorage.getItem('collab-user')
    return token && username ? { token, username } : null
  } catch { return null }
}

export default function AccountDraftsDrawer({ onClose, sourcePath }) {
  const navigate = useNavigate()
  const [identity] = useState(captureIdentity)
  const [records, setRecords] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  function isCurrent() {
    try { return Boolean(identity && localStorage.getItem('collab-token') === identity.token &&
      localStorage.getItem('collab-user') === identity.username) }
    catch { return false }
  }
  function showFailure(failure, action = 'read') {
    setNotice('')
    if (!isCurrent() || failure?.code === 'DRAFT_IDENTITY_CHANGED') {
      setRecords(null)
      setError('当前账号信息已变更或无法读取。请恢复本站存储后关闭并重开；切换账号时需重新登录原账号。本地记录保留。')
    } else if (failure?.code === 'DRAFT_MISSING') {
      setError('当前未找到这份本地记录，请刷新清单核对；这不表示内容已同步。')
    } else if (failure?.code === 'DRAFT_STORAGE_UNAVAILABLE') {
      setError('暂时无法读取本地草稿，请允许本站读取浏览器存储后重试；原始记录保留。')
    } else if (failure?.code === 'DRAFT_RECORD_CHANGED' || failure?.code === 'DRAFT_KEY_INVALID') {
      setError('这份本地记录已变化，请刷新清单后核对；原始记录保留。')
    } else {
      setError(action === 'download' ? '副本未能生成，请重试下载；原记录仍保存在此浏览器。'
        : '暂时无法读取本地草稿，请恢复本站存储后重试；原始记录保留。')
    }
  }
  function options() { return { storage: localStorage, username: identity?.username, Delta, isCurrent } }
  function refresh() {
    setRecords(null); setError(''); setNotice('')
    try {
      const next = enumerateAccountDrafts(options())
      setRecords(next.sort((a, b) => (b.savedAt ?? -1) - (a.savedAt ?? -1) || a.key.localeCompare(b.key)))
    } catch (failure) { showFailure(failure) }
  }
  useEffect(() => {
    refresh()
    const changed = event => {
      if (event.type === 'storage' && event.key !== null && !['collab-token', 'collab-user'].includes(event.key)) return
      if (!isCurrent()) showFailure({ code: 'DRAFT_IDENTITY_CHANGED' })
    }
    window.addEventListener('storage', changed)
    window.addEventListener('copage-auth-changed', changed)
    return () => { window.removeEventListener('storage', changed); window.removeEventListener('copage-auth-changed', changed) }
  }, [])
  useEffect(() => {
    const escape = event => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [onClose])
  function read(record) {
    const next = readAccountDraft({ ...options(), key: record.key })
    if (next.docId !== record.docId) throw Object.assign(new Error(), { code: 'DRAFT_RECORD_CHANGED' })
    return next
  }
  function download(record, kind) {
    try {
      const current = read(record)
      if (!isCurrent()) throw Object.assign(new Error(), { code: 'DRAFT_IDENTITY_CHANGED' })
      if (kind !== 'raw' && !current.readable) {
        setError('这份记录现在无法识别，请刷新清单后保存原始记录。'); return
      }
      if (kind === 'raw' && current.readable) {
        setError('这份记录现在可以识别，请刷新清单后选择富文本或纯文本下载。'); return
      }
      const text = kind === 'raw' ? draftRecordsJson(current.docId, [{ key: current.key, raw: current.raw }])
        : kind === 'text' ? draftBackupText(current.backup) : draftBackupJson(current.backup)
      if (!isCurrent()) throw Object.assign(new Error(), { code: 'DRAFT_IDENTITY_CHANGED' })
      downloadTextFile(text, `本地草稿-${current.docId ?? '原始记录'}.${kind === 'text' ? 'txt' : kind === 'raw' ? 'records.json' : 'copage.json'}`,
        kind === 'text' ? 'text/plain;charset=utf-8' : 'application/json;charset=utf-8')
      const large = current.readable && (new TextEncoder().encode(draftBackupJson(current.backup)).length > 1024 * 1024 || current.backup.content.ops.length > 10000)
      setError('')
      setNotice('副本已生成，请确认浏览器下载完成；原记录保留。' + (large ? '此草稿超过导入上限，仍已完整保存，需分段整理后导入。' : ''))
    } catch (failure) { showFailure(failure, 'download') }
  }
  function continueDocument(record) {
    try {
      const current = read(record)
      if (!isCurrent()) throw Object.assign(new Error(), { code: 'DRAFT_IDENTITY_CHANGED' })
      if (!current.docId) return
      navigate(documentHref(current.docId, sourcePath))
    } catch (failure) { showFailure(failure) }
  }
  const current = isCurrent()
  const visible = current ? records : null
  return <Drawer title="本地草稿" aria-label="本地草稿" open width="min(680px, 100vw)" rootClassName="cp-local-drafts" onClose={onClose}
    extra={<Button disabled={!current} onClick={refresh}>刷新清单</Button>}>
    <Typography.Paragraph>此浏览器、当前账号保存的本地记录，可能包含尚未同步的内容。正文只留在本机；清单不代表服务器保存状态。</Typography.Paragraph>
    <Typography.Paragraph type="secondary">先下载副本留存，或回到原文档按提示处理。多标签可能留下多份记录；打开文档不会自动接管或提交草稿。撤权、删除或网络故障不影响本地下载。</Typography.Paragraph>
    {(error || !current) && <Alert showIcon type="warning" message={error || '账号信息已变化，请关闭后重新登录原账号；本地记录保留。'} />}
    {notice && current && <Alert showIcon type="info" role="status" message={notice} />}
    {visible === null && !error && current && <Spin aria-label="正在读取本地草稿" />}
    {visible && <List dataSource={visible} rowKey="key" locale={{ emptyText: <Empty description="当前账号未找到本地草稿记录" /> }}
      renderItem={(record, index) => <List.Item className="cp-local-draft-record" aria-label={`${record.docId ? '文档 ' + record.docId : '未知文档'}的本地记录 ${index + 1}`}>
        <div className="cp-local-draft-heading"><Typography.Title level={3}>{record.docId ? `文档 ${record.docId}` : '无法识别文档编号的记录'}</Typography.Title>
          <Tag>记录 {index + 1}</Tag></div>
        <Typography.Paragraph type="secondary">{record.savedAt ? '本地保存于 ' + new Date(record.savedAt).toLocaleString() : '本地保存时间未知或异常'}</Typography.Paragraph>
        {!record.readable && <Typography.Paragraph>这份记录无法自动恢复，可保存原始记录留存。原始记录不能直接导入为文档。</Typography.Paragraph>}
        <Space wrap className="cp-local-draft-actions">
          {record.readable ? <><Button onClick={() => download(record, 'json')}>下载富文本草稿</Button><Button onClick={() => download(record, 'text')}>下载纯文本草稿</Button></>
            : <Button onClick={() => download(record, 'raw')}>保存原始记录</Button>}
          {record.docId && <Button type="link" onClick={() => continueDocument(record)}>继续处理此文档</Button>}
        </Space>
      </List.Item>} />}
    <Typography.Paragraph type="secondary">富文本副本包含完整正文、格式和图片地址，可从文档列表导入新文档；不包含图片文件、成员或历史。这里只读取记录，不删除或自动恢复草稿。</Typography.Paragraph>
  </Drawer>
}
