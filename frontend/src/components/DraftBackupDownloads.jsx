import { useState } from 'react'
import { Button, Space, Typography } from 'antd'
import { draftBackupJson, draftBackupText } from '../editor/draftBackup'
import { downloadTextFile } from '../editor/downloadTextFile'

export default function DraftBackupDownloads({ backup }) {
  const [notice, setNotice] = useState('')
  const json = draftBackupJson(backup)
  const large = new TextEncoder().encode(json).length > 1024 * 1024 || backup.content.ops.length > 10000
  function download(content, extension, type) {
    try {
      downloadTextFile(content, `本地草稿-${backup.docId}.${extension}`, type)
      setNotice('副本已生成，请确认浏览器下载完成；原草稿仍保存在此浏览器。')
    } catch { setNotice('下载失败，请重试；原草稿仍保存在此浏览器。') }
  }
  return <>
    {Number.isFinite(backup.savedAt) && <Typography.Paragraph type="secondary">
      保存时间：{new Date(backup.savedAt).toLocaleString()}
    </Typography.Paragraph>}
    <Space wrap>
      <Button onClick={() => download(json, 'copage.json', 'application/json;charset=utf-8')}>下载富文本草稿</Button>
      <Button onClick={() => download(draftBackupText(backup), 'txt', 'text/plain;charset=utf-8')}>下载纯文本草稿</Button>
    </Space>
    <Typography.Paragraph style={{ marginTop: 12 }}>副本保存这份本地草稿的完整正文、格式和图片地址，可从文档列表导入为新文档。它不会补交原操作，不包含图片文件、协作者或历史。</Typography.Paragraph>
    {large && <Typography.Paragraph>此副本超过导入的 1 MiB 或 10000 片段上限；仍可完整下载保存，后续需分段整理再导入。</Typography.Paragraph>}
    {notice && <Typography.Paragraph role="status">{notice}</Typography.Paragraph>}
  </>
}
