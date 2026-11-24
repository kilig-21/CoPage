import { Avatar } from 'antd'
import { useEffect, useRef } from 'react'

const previewSize = 2
const displayName = user => user.nickname?.trim() || '协作者'

export default function EditorPresence({ users }) {
  const details = useRef(null)
  const trigger = useRef(null)
  const extra = users.length - previewSize

  useEffect(() => {
    function closeOutside(event) {
      const panel = details.current
      if (panel?.open && !panel.contains(event.target)) panel.open = false
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [])

  return <div className="editor-presence" role="group" aria-label="在线协作者">
    <details ref={details} onBlur={event => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false
    }} onKeyDown={event => {
      if (event.key !== 'Escape' || event.isComposing || !event.currentTarget.open) return
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.open = false
      trigger.current?.focus({ preventScroll: true })
    }}>
      <summary ref={trigger} className="editor-presence-trigger" aria-label={`查看在线协作者（${users.length} 位）`}>
        <span className="editor-presence-avatars" aria-hidden="true">
          {users.slice(0, previewSize).map(user => <Avatar key={user.userId} size={28}
            style={{ backgroundColor: user.color }}>{displayName(user).slice(0, 1).toUpperCase()}</Avatar>)}
          {extra > 0 && <span className="editor-presence-extra">+{extra}</span>}
        </span>
      </summary>
      <div className="editor-presence-panel">
        <p className="editor-presence-heading"><strong>在线协作者</strong><span>{users.length} 位</span></p>
        <ul className="editor-presence-list" aria-label="在线协作者名单" tabIndex={0}>
          {users.map(user => <li key={user.userId}>
            <span aria-hidden="true" className="editor-presence-color" style={{ backgroundColor: user.color }} />
            <span>{displayName(user)}</span>
          </li>)}
        </ul>
      </div>
    </details>
  </div>
}
