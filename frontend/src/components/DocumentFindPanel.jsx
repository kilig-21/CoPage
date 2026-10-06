import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox, Input, Space, Typography } from 'antd'

export default function DocumentFindPanel({ state, permission, focusEpoch, onQuery, onNext, onReplace, onClose }) {
  const queryRef = useRef(null)
  const queryComposing = useRef(false), replacementComposing = useRef(false)
  const [replacement, setReplacement] = useState('')
  useEffect(() => { queryRef.current?.focus({ cursor: 'all', preventScroll: true }) }, [focusEpoch])
  return <section className="document-find-panel" data-document-find-panel aria-label="文档内查找与替换">
    <div className="document-find-row">
      <Typography.Text strong>文档内查找与替换</Typography.Text>
      <Button type="text" onClick={onClose} aria-label="关闭查找">关闭</Button>
    </div>
    <div className="document-find-row">
      <Input ref={queryRef} className="document-find-field" aria-label="查找本文文字" placeholder="输入本文中的文字"
        value={state.query} maxLength={200}
        onCompositionStart={event => { queryComposing.current = true; onQuery(event.currentTarget.value, state.caseSensitive, false) }}
        onCompositionEnd={event => { queryComposing.current = false; onQuery(event.currentTarget.value, state.caseSensitive, !replacementComposing.current) }}
        onChange={event => onQuery(event.target.value, state.caseSensitive,
          !queryComposing.current && !replacementComposing.current && !event.nativeEvent.isComposing)}
        onKeyDown={event => {
          if (queryComposing.current || event.isComposing || event.nativeEvent.isComposing) { event.stopPropagation(); return }
          if (event.key === 'Enter') { event.preventDefault(); onNext(event.shiftKey ? -1 : 1) }
          if (event.key === 'Escape') { event.preventDefault(); onClose() }
        }} />
      <Space wrap>
        <Button disabled={!state.count} onClick={() => onNext(-1)}>上一处</Button>
        <Button disabled={!state.count} onClick={() => onNext(1)}>下一处</Button>
        <Typography.Text role="status" aria-live="polite">{state.query
          ? state.count ? state.current + ' / ' + state.count : '没有匹配的文字' : '输入文字后查找'}</Typography.Text>
      </Space>
    </div>
    <div className="document-find-row">
      <Checkbox checked={state.caseSensitive} onChange={event => onQuery(state.query, event.target.checked)}>区分大小写</Checkbox>
      <Typography.Text type="secondary">按文字查找，不使用正则表达式；Enter下一处，Shift+Enter上一处。</Typography.Text>
    </div>
    <div className="document-find-row">
      <Input className="document-find-field" aria-label="替换为" placeholder="替换为，留空则删除匹配文字" maxLength={10000}
        value={replacement} onChange={event => setReplacement(event.target.value)}
        onCompositionStart={() => { replacementComposing.current = true; onQuery(state.query, state.caseSensitive, false) }}
        onCompositionEnd={event => { replacementComposing.current = false; setReplacement(event.currentTarget.value); onQuery(state.query, state.caseSensitive, !queryComposing.current) }}
        onKeyDown={event => {
          if (replacementComposing.current || event.nativeEvent.isComposing) { event.stopPropagation(); return }
          if (event.key === 'Escape') onClose()
        }} />
      <Space wrap>
        <Button disabled={!state.count || !state.canReplace} onClick={() => onReplace(replacement, false)}>替换当前</Button>
        <Button disabled={!state.count || !state.canReplace} onClick={() => onReplace(replacement, true)}>全部替换</Button>
      </Space>
    </div>
    {!state.canReplace && <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
      {permission === 1 ? '只读文档可查找，不能替换。' : '替换前请等待编辑保存、图片上传和输入完成。'}
    </Typography.Paragraph>}
    {state.notice && <Typography.Paragraph role="status" style={{ marginBottom: 0 }}>{state.notice}</Typography.Paragraph>}
  </section>
}
