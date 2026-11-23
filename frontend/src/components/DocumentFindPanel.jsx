import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DownOutlined, UpOutlined } from '@ant-design/icons'
import { Button, Input, Space, Typography } from 'antd'

export default function DocumentFindPanel({ state, permission, focusEpoch, onQuery, onNext, onReplace, onReveal, onClose }) {
  const queryRef = useRef(null)
  const replacementRef = useRef(null)
  const queryComposing = useRef(false), replacementComposing = useRef(false)
  const previousReplaceVisible = useRef(false)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [replacement, setReplacement] = useState('')
  const replaceVisible = permission === 2 && replaceOpen
  useEffect(() => { queryRef.current?.focus({ cursor: 'all', preventScroll: true }) }, [focusEpoch])
  useLayoutEffect(() => {
    if (replaceVisible === previousReplaceVisible.current) return
    previousReplaceVisible.current = replaceVisible
    if (replaceVisible) replacementRef.current?.focus({ preventScroll: true })
    else {
      if (replacementComposing.current) {
        replacementComposing.current = false
        onQuery(state.query, state.caseSensitive, !queryComposing.current)
      }
      if (document.activeElement === document.body) queryRef.current?.focus({ preventScroll: true })
    }
    onReveal()
  }, [replaceVisible, state.query, state.caseSensitive, onQuery, onReveal])

  return <section className="document-find-panel" data-document-find-panel aria-label={permission === 2 ? '文档内查找与替换' : '文档内查找'}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.nativeEvent.isComposing || queryComposing.current || replacementComposing.current) return
      event.preventDefault()
      onClose()
    }}>
    <div className="document-find-main">
      <Typography.Text strong className="document-find-title">文档内查找</Typography.Text>
      <Input ref={queryRef} className="document-find-query" aria-label="查找本文文字" placeholder="查找本文文字"
        value={state.query} maxLength={200} aria-keyshortcuts="Enter Shift+Enter"
        onCompositionStart={event => { queryComposing.current = true; onQuery(event.currentTarget.value, state.caseSensitive, false) }}
        onCompositionEnd={event => { queryComposing.current = false; onQuery(event.currentTarget.value, state.caseSensitive, !replacementComposing.current) }}
        onChange={event => onQuery(event.target.value, state.caseSensitive,
          !queryComposing.current && !replacementComposing.current && !event.nativeEvent.isComposing)}
        onKeyDown={event => {
          if (queryComposing.current || event.isComposing || event.nativeEvent.isComposing) { event.stopPropagation(); return }
          if (event.key === 'Enter') { event.preventDefault(); onNext(event.shiftKey ? -1 : 1) }
        }} />
      <div className="document-find-navigation">
        <Button className="document-find-step" icon={<UpOutlined aria-hidden="true" />} disabled={!state.count}
          aria-label="上一处" title="上一处（Shift+Enter）" onClick={() => onNext(-1)}><span className="document-find-step-label">上一处</span></Button>
        <Button className="document-find-step" icon={<DownOutlined aria-hidden="true" />} disabled={!state.count}
          aria-label="下一处" title="下一处（Enter）" onClick={() => onNext(1)}><span className="document-find-step-label">下一处</span></Button>
        <Typography.Text className="document-find-count" role="status">{state.query
          ? state.count ? state.current + ' / ' + state.count : '没有匹配的文字' : '输入文字后查找'}</Typography.Text>
        <Button type={state.caseSensitive ? 'primary' : 'default'} aria-pressed={state.caseSensitive} aria-label="区分大小写"
          title="区分大小写" onClick={() => onQuery(state.query, !state.caseSensitive)}>Aa</Button>
      </div>
      <Space size={4} className="document-find-actions">
        {permission === 2 && <Button type="text" aria-expanded={replaceVisible} aria-controls="document-find-replacement"
          onClick={() => setReplaceOpen(open => !open)}>{replaceVisible ? '收起替换' : '替换'}</Button>}
        <Button type="text" onClick={onClose} aria-label="关闭查找">关闭</Button>
      </Space>
    </div>
    {permission === 2 && <div id="document-find-replacement" className="document-find-replacement" hidden={!replaceVisible}>
      {replaceVisible && <>
        <div className="document-find-row">
          <Input ref={replacementRef} className="document-find-field" aria-label="替换为" placeholder="替换为，留空则删除匹配文字"
            maxLength={10000} value={replacement} onChange={event => setReplacement(event.target.value)}
            onCompositionStart={() => { replacementComposing.current = true; onQuery(state.query, state.caseSensitive, false) }}
            onCompositionEnd={event => {
              replacementComposing.current = false
              setReplacement(event.currentTarget.value)
              onQuery(state.query, state.caseSensitive, !queryComposing.current)
            }} />
          <Space wrap>
            <Button disabled={!state.count || !state.canReplace} onClick={() => onReplace(replacement, false)}>替换当前</Button>
            <Button disabled={!state.count || !state.canReplace} onClick={() => onReplace(replacement, true)}>全部替换</Button>
          </Space>
        </div>
        {!state.canReplace && <Typography.Text type="secondary">替换前请等待编辑保存、图片上传和输入完成。</Typography.Text>}
      </>}
    </div>}
    {state.notice && <Typography.Paragraph role="status" style={{ marginBottom: 0 }}>{state.notice}</Typography.Paragraph>}
  </section>
}
