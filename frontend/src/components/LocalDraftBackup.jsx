import { useEffect, useState } from 'react'
import { draftBackupJson, draftBackupText } from '../editor/draftBackup'
import { downloadTextFile } from '../editor/downloadTextFile'

export default function LocalDraftBackup({ backup, onContinue }) {
  const [notice, setNotice] = useState('')
  const text = draftBackupText(backup)
  const json = draftBackupJson(backup)
  const large = new TextEncoder().encode(json).length > 1024 * 1024 || backup.content.ops.length > 10000
  useEffect(() => {
    const warn = event => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  function download(content, extension, type) {
    try {
      downloadTextFile(content, `本地草稿-${backup.docId}.${extension}`, type)
      setNotice('已生成本地副本，请确认浏览器下载完成，再继续登录。')
    } catch { setNotice('未能下载，请选中下方文字手动复制。') }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(text); setNotice('文字已复制，请粘贴到安全的位置保存。') }
    catch { setNotice('浏览器未允许自动复制，请选中下方文字手动复制。') }
  }
  return <main className="page-load-message" role="alert">
    <h1>请先备份未确认内容</h1>
    <p>浏览器没能保存本地草稿，当前内容暂时保留在此页。请下载副本或复制文字后再继续；刷新或关闭此页会失去这份临时备份。</p>
    <p style={{ overflowWrap: 'anywhere' }}>原账号：{backup.username || '未知'}；文档：{backup.title}</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button onClick={() => download(json, 'copage.json', 'application/json;charset=utf-8')}>下载富文本备份</button>
      <button onClick={() => download(text, 'txt', 'text/plain;charset=utf-8')}>下载纯文本备份</button>
      <button onClick={copy}>复制文字</button>
    </div>
    <p>富文本副本保留当前正文、格式和图片地址，重新登录后可从列表导入为新文档。它不会补交原文档操作，不包含图片文件、成员或历史。</p>
    {large && <p>此副本超过导入的 1 MiB 或 10000 片段上限；仍可完整下载保存，后续需分段整理再导入。</p>}
    <textarea aria-label="未确认内容备份" readOnly value={text} onFocus={event => event.target.select()}
      style={{ width: '100%', minHeight: 180, font: 'inherit' }} />
    {notice && <p role="status">{notice}</p>}
    <p><button onClick={onContinue}>已备份，继续登录</button></p>
  </main>
}
