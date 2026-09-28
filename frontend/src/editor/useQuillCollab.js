import { useEffect, useRef, useState } from 'react'
import Quill from 'quill'
import 'quill/dist/quill.snow.css'
import CollabSocket from '../ws/CollabSocket'
import CollabClient from '../ws/CollabClient'
import request from '../api/request'

function createClientId() {
  return globalThis.crypto?.randomUUID?.() ?? `client-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export default function useQuillCollab(docId) {
  const editorHostRef = useRef(null)
  const quillRef = useRef(null)
  const [connection, setConnection] = useState('未连接')
  const [users, setUsers] = useState([])
  const [error, setError] = useState('')
  const [title, setTitle] = useState('')
  const [permission, setPermission] = useState(0)
  const [recoveryDraft, setRecoveryDraft] = useState(null)
  const recoveryActionsRef = useRef(null)

  useEffect(() => {
    const host = editorHostRef.current
    if (!host || !Number.isSafeInteger(docId) || docId <= 0) return undefined
    let active = true
    setConnection('加载中')
    setError('')

    const quill = new Quill(host, {
      theme: 'snow',
      placeholder: '开始协同编辑…',
      modules: {
        toolbar: {
          container: [
            [{ header: [1, 2, false] }],
            ['bold', 'italic', 'underline', 'strike'],
            [{ list: 'ordered' }, { list: 'bullet' }],
            ['blockquote', 'code-block', 'link', 'image'],
            ['clean'],
          ],
          handlers: {
            image: () => setError('图片上传即将接入，暂时无法插入图片'),
          },
        },
      },
    })
    quill.enable(false)
    quillRef.current = quill
    const Delta = Quill.import('delta')
    const token = localStorage.getItem('collab-token')
    const username = localStorage.getItem('collab-user')
    const draftPrefix = username ? `copage-draft:v1:${encodeURIComponent(username)}:${docId}:` : null
    const tabKey = `copage-tab-client:${docId}`
    const clientId = sessionStorage.getItem(tabKey) || createClientId()
    sessionStorage.setItem(tabKey, clientId)
    let composing = false
    let compositionDirty = false
    let lastKnownContents = quill.getContents()
    let canEdit = false
    let connected = false
    let synced = false
    const updateEditable = () => quill.enable(canEdit && connected && synced)

    const client = new CollabClient({
      docId,
      clientId,
      Delta,
      onSync: (content) => {
        if (!active || !connected) return
        if (content) quill.setContents(content, 'api')
        lastKnownContents = quill.getContents()
      },
      onRemote: (operation) => {
        if (!active) return
        const selection = quill.getSelection()
        quill.updateContents(operation, 'api')
        if (selection) {
          const nextIndex = operation.transformPosition(selection.index, true)
          quill.setSelection(nextIndex, selection.length, 'silent')
        }
        lastKnownContents = quill.getContents()
      },
      onUsers: setUsers,
      onError: setError,
      onState: (state) => {
        if (!active) return
        synced = state === 'ready'
        updateEditable()
        setConnection({ ready: '已连接', syncing: '正在恢复编辑', offline: '正在重连', blocked: '本地内容已保留' }[state])
        if (state === 'ready') setError('')
      },
    })

    const socket = new CollabSocket({
      token,
      onOpen: () => {
        if (!active) return
        connected = true
        synced = false
        updateEditable()
        setConnection('同步中')
        client.join()
      },
      onMessage: (message) => {
        if (!active) return
        flushComposition()
        client.receive(message)
        persistDraft()
      },
      onClose: () => {
        if (!active) return
        flushComposition()
        connected = false
        synced = false
        updateEditable()
        client.disconnect()
        persistDraft()
      },
      onError: setError,
    })
    client.attachSocket(socket)

    const persistDraft = () => {
      if (!draftPrefix || recoveryActionsRef.current) return
      const key = draftPrefix + client.clientId
      try {
        const draft = client.exportDraft(quill.getContents())
        if (draft) localStorage.setItem(key, JSON.stringify(draft))
        else localStorage.removeItem(key)
      } catch {
        setError('本地草稿保存失败；离开页面前请复制当前内容')
      }
    }
    const findDraft = () => {
      if (!draftPrefix) return null
      const found = []
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index)
        if (!key?.startsWith(draftPrefix)) continue
        try {
          const draft = JSON.parse(localStorage.getItem(key))
          if (draft?.docId === docId && draft?.version === 1) found.push({ key, draft })
        } catch {
          // 损坏的草稿保持原样，避免自动删除可能有用的本地内容。
        }
      }
      return found.find(({ key }) => key === draftPrefix + clientId)
        ?? found.sort((a, b) => (b.draft.savedAt ?? 0) - (a.draft.savedAt ?? 0))[0]
        ?? null
    }
    const startSocket = () => {
      if (token) {
        setConnection('正在连接')
        socket.connect()
      } else {
        setConnection('未登录')
        setError('请先登录后再使用实时协同')
      }
    }

    const submit = (delta) => {
      if (delta.ops?.length) client.submit(delta)
      lastKnownContents = quill.getContents()
      persistDraft()
    }
    const onTextChange = (delta, _old, source) => {
      if (source !== 'user') return
      if (composing) {
        compositionDirty = true
        return
      }
      submit(delta)
    }
    const onCompositionStart = () => { composing = true }
    const flushComposition = () => {
      if (!compositionDirty) return
      compositionDirty = false
      submit(lastKnownContents.diff(quill.getContents()))
    }
    const onCompositionEnd = () => {
      composing = false
      flushComposition()
    }
    const onBeforeUnload = (event) => {
      flushComposition()
      persistDraft()
      if (!client.hasUnconfirmedChanges() && !compositionDirty) return
      event.preventDefault()
      event.returnValue = ''
    }

    quill.on('text-change', onTextChange)
    quill.root.addEventListener('compositionstart', onCompositionStart)
    quill.root.addEventListener('compositionend', onCompositionEnd)
    window.addEventListener('beforeunload', onBeforeUnload)

    request.get('/doc/' + docId)
      .then((response) => {
        if (!active) return
        const doc = response.data
        setTitle(doc.title)
        setPermission(doc.permission)
        canEdit = doc.permission === 2
        quill.setContents(new Delta(doc.content), 'api')
        lastKnownContents = quill.getContents()
        updateEditable()
        const stored = findDraft()
        if (stored) {
          setConnection('等待恢复选择')
          setRecoveryDraft({ savedAt: stored.draft.savedAt })
          recoveryActionsRef.current = {
            recover: () => {
              if (!canEdit) {
                setError('当前已无编辑权限，草稿仍保存在此浏览器中')
                return
              }
              try {
                const content = client.restoreDraft(stored.draft)
                quill.setContents(content, 'api')
                lastKnownContents = quill.getContents()
                sessionStorage.setItem(tabKey, client.clientId)
                setRecoveryDraft(null)
                recoveryActionsRef.current = null
                persistDraft()
                startSocket()
              } catch {
                setError('草稿无法自动恢复，原始草稿仍保存在此浏览器中')
              }
            },
            discard: () => {
              localStorage.removeItem(stored.key)
              setRecoveryDraft(null)
              recoveryActionsRef.current = null
              startSocket()
            },
          }
        } else {
          startSocket()
        }
      })
      .catch((loadError) => {
        if (!active) return
        setConnection('加载失败')
        setError(loadError?.message || '文档加载失败')
      })

    return () => {
      flushComposition()
      persistDraft()
      active = false
      quill.off('text-change', onTextChange)
      quill.root.removeEventListener('compositionstart', onCompositionStart)
      quill.root.removeEventListener('compositionend', onCompositionEnd)
      window.removeEventListener('beforeunload', onBeforeUnload)
      client.close()
      socket.close()
      recoveryActionsRef.current = null
      quill.getModule('toolbar')?.container.remove()
      host.replaceChildren()
      quillRef.current = null
    }
  }, [docId])

  return {
    editorHostRef, connection, users, error, title, permission, recoveryDraft,
    recoverDraft: () => recoveryActionsRef.current?.recover(),
    discardDraft: () => recoveryActionsRef.current?.discard(),
  }
}
