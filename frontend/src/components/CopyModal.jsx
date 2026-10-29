import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Alert, Button, Input, Modal, Typography } from 'antd'
import { useNavigate } from 'react-router-dom'
import createDocument from '../api/createDocument'
import { confirmCopy } from '../api/copyDocuments'
import { copyIdentity, sameCopyIdentity } from '../api/usePendingCopies'

export default function CopyModal({ doc, onClose, onCreated, canCopy = () => true }) {
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const [confirmed, setConfirmed] = useState(null)
  const [ready, setReady] = useState(() => { try { return canCopy() } catch { return false } })
  const alive = useRef(true)
  const inFlight = useRef(null)
  const prepared = useRef(null)
  const feedback = useRef(null)
  const canCopyRef = useRef(canCopy)
  canCopyRef.current = canCopy
  useEffect(() => {
    alive.current = true
    const timer = setInterval(() => {
      try { setReady(Boolean(prepared.current) || canCopyRef.current()) }
      catch { setReady(Boolean(prepared.current)) }
    }, 200)
    return () => { alive.current = false; clearInterval(timer); inFlight.current?.abort() }
  }, [])
  useLayoutEffect(() => {
    if (error || !ready) {
      const body = feedback.current?.closest('.ant-modal-body')
      if (body) body.scrollTop = 0
    }
  }, [error, ready])
  async function createCopy() {
    if (inFlight.current) return
    if (confirmed) {
      try { onCreated(confirmed) }
      catch { setError('副本已确认，页面未能打开；请从我的文档查看已创建副本。') }
      return
    }
    if (!prepared.current) {
      let canCreate = false
      try { canCreate = canCopyRef.current() } catch { /* 当前来源状态不可读时不发送新的创建。 */ }
      if (!canCreate) { setError('请先等待连接、同步和保存完成'); return }
    }
    const controller = new AbortController()
    const identity = copyIdentity()
    let accepted = false
    const current = () => alive.current && !controller.signal.aborted && sameCopyIdentity(identity)
    inFlight.current = controller; setBusy(true); setError('')
    try {
      const config = { signal: controller.signal, deferCleanup: true, onPrepared: summary => {
        if (!current()) throw new DOMException('副本创建页面或账号已变更', 'AbortError')
        prepared.current = summary; setUncertain(true)
      } }
      let result = prepared.current ? await confirmCopy(prepared.current, config)
        : await createDocument('/doc/' + doc.id + '/copy', title.trim() ? { title: title.trim() } : {}, config)
      if (!current()) return
      result = await result.confirmTracking()
      if (!current()) return
      accepted = true
      setConfirmed(result.data); setUncertain(false)
      prepared.current = null
      onCreated(result.data)
    } catch (ex) {
      if (current()) {
        setUncertain(!accepted && Boolean(prepared.current))
        setError(accepted ? '副本已确认，页面未能打开；请从我的文档查看已创建副本。'
          : prepared.current ? '副本创建结果未确认，原标题与创建标识已保留。可确认原副本，或关闭窗口后从我的文档继续。'
            : ex?.message || '副本创建尚未发送，请恢复本站存储后重试。')
      }
    } finally {
      if (inFlight.current === controller) inFlight.current = null
      if (alive.current) setBusy(false)
    }
  }
  return <Modal className="document-copy-modal document-transfer-modal" title="创建独立副本" open onCancel={busy ? undefined : onClose} onOk={createCopy}
    okText={confirmed ? '打开已确认副本' : uncertain ? '确认原副本' : '创建副本'} cancelText={confirmed ? '关闭' : uncertain ? '稍后确认' : '取消'} confirmLoading={busy} okButtonProps={{ disabled: !confirmed && !ready && !uncertain }}
    closable={!busy} maskClosable={!busy} keyboard={!busy} cancelButtonProps={{ disabled: busy }}>
    {(!ready && !confirmed || error) && <div ref={feedback} style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
      {!ready && !confirmed && <Alert type="warning" showIcon message="请先等待连接、同步和保存完成" />}
      {error && <Alert type={uncertain ? 'warning' : 'error'} showIcon message={error}
        action={(uncertain || confirmed) && <Button disabled={busy} onClick={() => {
          onClose(); navigate('/docs?' + new URLSearchParams({ scope: 'owned', ...(title.trim() ? { keyword: title.trim() } : {}) }).toString())
        }}>核对我的文档</Button>} />}
    </div>}
    <Typography.Paragraph>来源：{doc.title}</Typography.Paragraph>
    <Typography.Paragraph>复制操作时服务端已保存的完整版本，保留正文、格式和图片地址。新文档归你所有，不复制协作者权限、历史或本地未确认草稿，也不会修改原文档。</Typography.Paragraph>
    <Typography.Paragraph type="secondary">图片继续使用原地址，不复制图片文件。待确认记录按当前账号与服务保存在本浏览器，仅含来源、标题和创建标识；关闭标签、刷新或重登原账号后，可从我的文档主动确认，不会自动重发。清除站点数据或换浏览器可能失去记录。</Typography.Paragraph>
    <Input aria-label="副本文档标题" maxLength={200} disabled={busy || uncertain || Boolean(confirmed)} value={title}
      placeholder="可选：留空使用原标题加“的副本”" onChange={event => setTitle(event.target.value)} />
  </Modal>
}
