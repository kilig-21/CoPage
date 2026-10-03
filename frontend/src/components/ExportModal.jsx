import { useEffect, useState } from 'react'
import { Alert, Modal, Radio, Typography } from 'antd'
import request from '../api/request'

export default function ExportModal({ docId, onClose, canExport }) {
  const [format, setFormat] = useState('copage')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [ready, setReady] = useState(() => canExport())
  useEffect(() => {
    setReady(canExport())
    const timer = setInterval(() => setReady(canExport()), 200)
    return () => clearInterval(timer)
  }, [canExport])
  async function download() {
    if (busy) return
    if (!canExport()) { setError('请先等待连接、同步和保存完成'); return }
    setBusy(true); setError(''); setNotice('')
    try {
      const { data } = await request.get(`/doc/${docId}/export`, { params: { format } })
      const url = URL.createObjectURL(new Blob([data.content], { type: data.mediaType }))
      const link = document.createElement('a'); link.href = url; link.download = data.filename
      document.body.append(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice(`已生成服务端版本 ${data.revision} 的副本，请查看浏览器下载`)
    } catch (ex) { setError(ex.message || '导出失败，请重试') }
    finally { setBusy(false) }
  }
  return <Modal title="导出文档" open onCancel={busy ? undefined : onClose} onOk={download}
    okText="下载副本" cancelText="关闭" confirmLoading={busy} okButtonProps={{ disabled: !ready }}
    cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={!busy} keyboard={!busy}>
    <Radio.Group value={format} onChange={event => setFormat(event.target.value)} disabled={busy}>
      <Radio value="copage">CoPage 富文本副本（.json）</Radio><Radio value="txt">纯文本（.txt）</Radio>
    </Radio.Group>
    <Typography.Paragraph style={{ marginTop: 16 }}>导出已保存到服务端的一个完整版本，最多 1 MiB。CoPage 副本可再次导入并保留格式，纯文本便于直接阅读，但不保留格式，图片显示为地址。</Typography.Paragraph>
    <Typography.Paragraph type="secondary">图片保留原地址，不打包图片文件；副本不包含成员权限、历史版本或本地草稿。</Typography.Paragraph>
    {!ready && <Alert type="warning" showIcon message="请先等待连接、同步和保存完成；本地未确认草稿不会进入副本" />}
    {error && <Alert type="error" showIcon message={error} />}
    {notice && <Alert type="success" showIcon message={notice} />}
  </Modal>
}
