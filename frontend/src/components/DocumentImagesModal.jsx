import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Alert, Button, Input, Modal, Typography } from 'antd'

export default function DocumentImagesModal({ state, permission, onSave, onClose }) {
  const [selected, setSelected] = useState(null)
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [imageFailed, setImageFailed] = useState(false)
  const inputRef = useRef(null)
  const feedbackRef = useRef(null)
  function select(image) {
    setSelected(image ? { id: image.id, alt: image.alt } : null)
    setDescription(image?.alt ?? '')
    setError(''); setNotice('')
    if (selected?.id !== image?.id) setImageFailed(false)
  }
  useEffect(() => { if (!selected && state.images.length) select(state.images[0]) }, [state.images, selected])
  const image = state.images.find(item => item.id === selected?.id)
  const ordinal = image ? state.images.indexOf(image) + 1 : 0
  const conflict = image && image.alt !== selected.alt
  const disabled = !image || !state.canEdit || Boolean(conflict)
  const missing = Boolean(selected && !image)
  function revealFocusedInput() {
    const input = inputRef.current?.input, feedback = feedbackRef.current
    if (!input || !feedback || input.ownerDocument.activeElement !== input) return
    const body = feedback.closest('.ant-modal-body')
    const field = input.closest('.ant-input-affix-wrapper') ?? input
    const overlap = feedback.getBoundingClientRect().bottom + 8 - field.getBoundingClientRect().top
    if (body && overlap > 0) body.scrollTop = Math.max(0, body.scrollTop - overlap)
  }
  useLayoutEffect(() => {
    revealFocusedInput()
    if (!feedbackRef.current || typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(revealFocusedInput)
    observer.observe(feedbackRef.current)
    return () => observer.disconnect()
  }, [conflict, error, notice, missing])
  function save() {
    try {
      const result = onSave(selected?.id, description, selected?.alt)
      if (!result) throw new Error('当前文档已关闭，请重新打开；填写的说明仍保留')
      setSelected(current => ({ ...current, alt: result.description }))
      setError('')
      setNotice(result.changed ? '说明已应用，请以文档的连接和保存状态确认同步结果。' : '说明没有变化，正文未修改。')
    } catch (failure) { setNotice(''); setError(failure.message); inputRef.current?.focus({ preventScroll: true }) }
  }
  return <Modal title="图片说明" open width={720} className="document-images-modal" onCancel={onClose}
    footer={<><Button onClick={onClose}>关闭</Button><Button type="primary" disabled={disabled} onClick={save}>保存说明</Button></>}>
    {(missing || conflict || error || notice) && <div className="document-images-feedback" ref={feedbackRef}>
      {selected && !image && <Alert type="warning" showIcon message="图片已被移除或替换，当前输入保留。请重新选择目标。" />}
      {conflict && <Alert type="warning" showIcon message="说明已更新，当前输入保留。" description="读取最新说明会替换当前输入，请先保留需要的文字。"
        action={<Button onClick={() => select(image)}>读取最新说明</Button>} />}
      {error && <Alert type="error" showIcon message={error} />}
      {notice && <Typography.Paragraph role="status" aria-live="polite">{notice}</Typography.Paragraph>}
    </div>}
    <Typography.Paragraph type="secondary">为看不到图片的同伴补充内容说明。说明随正文共同保存，CoPage 富文本副本会保留说明；纯文本副本仅带图片地址。图片文件和访问权限不变。</Typography.Paragraph>
    {!state.images.length && !selected ? <Typography.Paragraph>本文暂时没有图片。可以先从正文工具栏上传图片，或粘贴带图片的内容。</Typography.Paragraph> : <>
      <label className="document-images-label" htmlFor="document-image-choice">选择本文图片（共{state.images.length}张）</label>
      <select id="document-image-choice" aria-label="选择本文图片" value={image?.id ?? ''}
        onChange={event => select(state.images.find(item => item.id === event.target.value))}>
        {!image && <option value="">请选择图片</option>}
        {state.images.map((item, index) => <option key={item.id} value={item.id}>图片 {index + 1} · {item.alt ? item.alt.slice(0, 40) : '未填写说明'}</option>)}
      </select>
      {image && <div className="document-image-preview"><img key={image.id} src={image.src} alt={image.alt || `图片 ${ordinal}（尚未填写说明）`}
        onError={() => setImageFailed(true)} />{imageFailed && <Typography.Text>图片暂时无法显示，原地址和说明仍保留。</Typography.Text>}</div>}
      <label className="document-images-label" htmlFor="document-image-description">图片内容说明</label>
      <Input id="document-image-description" ref={inputRef} aria-label="图片内容说明" maxLength={512} showCount
        value={description} onChange={event => { setDescription(event.target.value); setError(''); setNotice('') }}
        onFocus={() => queueMicrotask(revealFocusedInput)}
        readOnly={permission !== 2} aria-describedby="document-image-help" />
      <Typography.Paragraph id="document-image-help" type="secondary">用一段简短文字描述图片传达的信息，最多512个字符。留空表示未填写说明。</Typography.Paragraph>
    </>}
    {permission === 1 ? <Typography.Paragraph>当前为只读，可以查看说明；修改需要文档编辑权限。</Typography.Paragraph>
      : !state.canEdit && <Typography.Paragraph>保存说明前请等待连接、同步、输入和当前修改保存完成。</Typography.Paragraph>}
  </Modal>
}
