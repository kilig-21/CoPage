import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Button } from 'antd'
import { snippetParts } from '../search/snippet'

export default function SearchExcerpt({ snippet, title }) {
  const content = useRef(null)
  const contentId = useId()
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)

  useEffect(() => { setExpanded(false) }, [snippet])
  useLayoutEffect(() => {
    const element = content.current
    if (!element) return undefined
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight)
      setOverflows(Number.isFinite(lineHeight) && element.scrollHeight > lineHeight * 3 + 1)
    }
    measure()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    if (observer) observer.observe(element)
    else window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      if (!observer) window.removeEventListener('resize', measure)
    }
  }, [snippet])

  return <div className="search-excerpt">
    <div ref={content} id={contentId} className={'search-result-snippet' + (expanded ? '' : ' is-collapsed')}>
      {snippetParts(snippet).map((part, index) => part.highlighted ? <strong key={index}>{part.text}</strong> : part.text)}
    </div>
    {overflows && <Button type="text" size="small" className="search-excerpt-toggle"
      aria-expanded={expanded} aria-controls={contentId} aria-label={`${expanded ? '收起' : '展开'}“${title}”的正文摘要`}
      onClick={() => setExpanded(value => !value)}>{expanded ? '收起摘要' : '展开摘要'}</Button>}
  </div>
}
