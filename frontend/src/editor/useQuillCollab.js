import { useEffect, useRef, useState } from 'react'
import Quill from 'quill'
import 'quill/dist/quill.snow.css'
import CollabSocket from '../ws/CollabSocket'
import CollabClient from '../ws/CollabClient'
import request from '../api/request'
import { createReconnectSessionCheck, expireSession } from '../auth/session'
import { IMAGE_ACCEPT, createImageInsertion, finishImageInsertion, imageValidationError, uploadEditorImage } from './imageUpload'
import RemoteCursorLayer from './RemoteCursorLayer'
import { DOCUMENT_FORMATS } from './formats'
import { configureEditorToolbar } from './toolbar'
import { configureLinkEditor, normalizePastedLinks } from './links'
import { clipboardPasteError, configureClipboardImages } from './clipboardImages'
import { createCompositionInbox } from './compositionInbox'

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
  const [saveStatus, setSaveStatus] = useState('等待同步')
  const [titleError, setTitleError] = useState('')
  const refreshTitleRef = useRef(null)
  const [permission, setPermission] = useState(0)
  const [isOwner, setIsOwner] = useState(false)
  const [recoveryDraft, setRecoveryDraft] = useState(null)
  const recoveryActionsRef = useRef(null)
  const historyReadyRef = useRef(null)
  const exportReadyRef = useRef(null)

  useEffect(() => {
    const host = editorHostRef.current
    if (!host || !Number.isSafeInteger(docId) || docId <= 0) return undefined
    let active = true
    setConnection('加载中')
    setTitle('')
    setTitleError('')
    setSaveStatus('等待同步')
    setRecoveryDraft(null)
    setUsers([])
    setError('')
    setPermission(0)
    setIsOwner(false)

    const imageInput = document.createElement('input')
    imageInput.type = 'file'
    imageInput.accept = IMAGE_ACCEPT
    imageInput.hidden = true

    const quill = new Quill(host, {
      bounds: host,
      formats: DOCUMENT_FORMATS,
      theme: 'snow',
      placeholder: '开始协同编辑…',
      modules: {
        history: { userOnly: true },
        uploader: {
          mimetypes: IMAGE_ACCEPT.split(','),
          handler: (range, files) => { void uploadImageFiles(range, files) },
        },
        toolbar: {
          container: [
            ['undo', 'redo'],
            [{ header: [1, 2, false] }],
            ['bold', 'italic', 'underline', 'strike'],
            [{ list: 'ordered' }, { list: 'bullet' }],
            ['blockquote', 'code-block', 'link', 'image'],
            ['clean'],
          ],
          handlers: {
            undo: function () { if (this.quill.isEnabled()) this.quill.getModule('history').undo() },
            redo: function () { if (this.quill.isEnabled()) this.quill.getModule('history').redo() },
            image: () => {
              if (!canEdit || !connected || !synced || uploading) {
                setError(uploading ? '请等待当前图片上传完成' : '文档尚未就绪，暂时不能插入图片')
                return
              }
              imageInsertIndex = quill.getSelection(true)?.index ?? Math.max(0, quill.getLength() - 1)
              imageInput.click()
            },
          },
        },
      },
    })
    host.appendChild(imageInput)
    quill.enable(false)
    const updateToolbar = configureEditorToolbar(quill)
    updateToolbar()
    const linkEditor = configureLinkEditor(quill)
    quill.clipboard.addMatcher('A', normalizePastedLinks)
    configureClipboardImages(quill, (...args) => uploadImageFiles(...args), setError)
    quill.root.setAttribute('role', 'textbox')
    quill.root.setAttribute('aria-label', '文档正文')
    quill.root.setAttribute('aria-multiline', 'true')
    quillRef.current = quill
    const cursorLayer = new RemoteCursorLayer(quill)
    const Delta = Quill.import('delta')
    const token = localStorage.getItem('collab-token')
    const sessionCheckController = new AbortController()
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
    let uploading = false
    let imageInsertIndex = null
    let pendingImageOperation = null
    let uploadController = null
    let titleController = null
    const refreshTitle = async () => {
      titleController?.abort()
      const controller = new AbortController()
      titleController = controller
      try {
        const response = await request.get('/doc/' + docId + '/metadata', { signal: controller.signal })
        if (active && !controller.signal.aborted) { setTitle(response.data.title); setTitleError('') }
      } catch {
        if (active && !controller.signal.aborted) setTitleError('标题暂未更新，请重试')
      }
    }
    refreshTitleRef.current = refreshTitle
    const updateSaveStatus = () => {
      if (!active) return
      const pending = client.hasUnconfirmedChanges()
      setSaveStatus(recoveryActionsRef.current ? '等待恢复本地草稿'
        : !connected || !synced ? (pending ? '有修改尚未同步' : '等待同步')
        : uploading ? '正在上传图片'
        : composing ? '正在输入'
        : pending ? '正在保存…'
        : canEdit ? '所有修改已保存' : '只读 · 内容已同步')
    }
    const updateEditable = () => {
      quill.enable(canEdit && connected && synced)
      updateToolbar()
    }
    let cursorSendTimer = null
    let lastSentCursor = null

    const sendCursor = (force = false) => {
      if (!active || !connected || !synced) return
      const selection = quill.hasFocus() ? quill.getSelection() : null
      const next = {
        type: 'cursor', docId,
        index: selection?.index ?? 0,
        length: selection?.length ?? 0,
        visible: Boolean(selection),
      }
      if (!force && lastSentCursor && next.index === lastSentCursor.index &&
          next.length === lastSentCursor.length && next.visible === lastSentCursor.visible) return
      if (socket.send(next)) lastSentCursor = next
    }
    const scheduleCursor = () => {
      if (cursorSendTimer !== null) return
      cursorSendTimer = window.setTimeout(() => {
        cursorSendTimer = null
        sendCursor()
      }, 50)
    }
    const hideCursor = () => {
      if (cursorSendTimer !== null) window.clearTimeout(cursorSendTimer)
      cursorSendTimer = null
      if (connected && lastSentCursor?.visible) {
        socket.send({ type: 'cursor', docId, index: 0, length: 0, visible: false })
      }
      lastSentCursor = null
    }

    const abortImageUpload = () => {
      uploadController?.abort()
      imageInsertIndex = null
      pendingImageOperation = null
    }

    const uploadImageFiles = async (range, files, operation = null, notice = '') => {
      if (!files.length) return
      const validationError = files.length > 10 ? '一次最多上传10张图片，请分批添加'
        : files.map(imageValidationError).find(Boolean)
      if (validationError) {
        imageInsertIndex = null
        setError(validationError)
        return
      }
      if (!active || !canEdit || !connected || !synced || uploading) {
        imageInsertIndex = null
        setError('文档尚未就绪，暂时不能插入图片')
        return
      }
      uploading = true
      pendingImageOperation = operation ?? createImageInsertion(range, files.length, Delta)
      updateSaveStatus()
      const controller = new AbortController()
      uploadController = controller
      try {
        const urls = []
        for (const file of files) urls.push(await uploadEditorImage(request, file, controller.signal))
        if (!active || controller.signal.aborted || !pendingImageOperation || !canEdit || !connected || !synced) {
          if (active) setError('上传期间协同连接中断，请重连后重新选择图片')
          return
        }
        const { delta, insertionEnd } = finishImageInsertion(pendingImageOperation, urls, Delta)
        const capacityError = clipboardPasteError(delta, quill.getContents())
        if (capacityError) { setError(capacityError); return }
        pendingImageOperation = null
        imageInsertIndex = null
        quill.updateContents(delta, 'user')
        quill.setSelection(insertionEnd, 0, 'silent')
        setError(notice)
      } catch (uploadError) {
        if (active && !controller.signal.aborted) setError(uploadError?.message || '图片上传失败')
      } finally {
        uploading = false
        updateSaveStatus()
        uploadController = null
        imageInsertIndex = null
        pendingImageOperation = null
      }
    }
    const onImageChange = async () => {
      const file = imageInput.files?.[0]
      imageInput.value = ''
      if (!file) { imageInsertIndex = null; return }
      const index = imageInsertIndex ?? Math.max(0, quill.getLength() - 1)
      await uploadImageFiles({ index, length: 0 }, [file])
    }
    const onImageCancel = () => { imageInsertIndex = null }
    imageInput.addEventListener('change', onImageChange)
    imageInput.addEventListener('cancel', onImageCancel)

    const client = new CollabClient({
      docId,
      clientId,
      Delta,
      onSync: (content) => {
        if (!active || !connected) return
        abortImageUpload()
        cursorLayer.clear()
        lastSentCursor = null
        // 仅应用服务端差异，避免重连全文替换抹掉本标签的撤销记录。
        if (content) quill.updateContents(quill.getContents().diff(content), 'api')
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
      onUsers: (onlineUsers) => {
        setUsers(onlineUsers)
        if (lastSentCursor?.visible) sendCursor(true)
      },
      onCursor: (cursor) => cursorLayer.update(cursor),
      onError: setError,
      onState: (state) => {
        if (!active) return
        if (state !== 'ready') {
          hideCursor()
          cursorLayer.clear()
        }
        synced = state === 'ready'
        if (!synced) abortImageUpload()
        updateEditable()
        setConnection({ ready: '已连接', syncing: '正在恢复编辑', offline: '正在重连', blocked: client.hasUnconfirmedChanges() ? '本地内容已保留' : '已暂停' }[state])
        updateSaveStatus()
        if (state === 'ready') {
          refreshTitle()
          setError('')
          scheduleCursor()
        }
      },
    })

    const deliverMessage = (message) => {
      if (!active) return
      if (message.type === 'metadata' && message.docId === docId) { refreshTitle(); return }
      // 撤权必须立即生效；先把尚未结束的组合输入收进本地草稿。
      flushComposition()
      if (message.docId === docId && [0, 1, 2].includes(message.permission)) {
        setPermission(message.permission)
        canEdit = message.permission === 2
        if (!canEdit) abortImageUpload()
        updateEditable()
        client.receive({ type: 'permission', docId, permission: message.permission })
        if (message.permission === 0) {
          persistDraft()
          socket.close()
          return
        }
      }
      client.receive(message)
      persistDraft()
    }
    const compositionInbox = createCompositionInbox({
      isComposing: () => composing,
      deliver: deliverMessage,
      resync: () => client.join(),
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
        if (active) compositionInbox.receive(message)
      },
      onClose: () => {
        if (!active) return
        hideCursor()
        cursorLayer.clear()
        abortImageUpload()
        flushComposition()
        composing = false
        compositionInbox.clear()
        connected = false
        synced = false
        updateEditable()
        client.disconnect()
        persistDraft()
        checkReconnectSession()
      },
      onError: setError,
    })
    const checkReconnectSession = createReconnectSessionCheck({
      isCurrent: () => active && localStorage.getItem('collab-token') === token,
      getStatus: async () => {
        const origin = (import.meta.env.VITE_BACKEND_HTTP_ORIGIN ?? '').replace(/\/$/, '')
        const response = await fetch(`${origin}/api/doc/${docId}/metadata`, {
          headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
          signal: AbortSignal.any([sessionCheckController.signal, AbortSignal.timeout(5000)]),
        })
        await response.body?.cancel()
        return response.status
      },
      onExpired: () => {
        flushComposition()
        persistDraft()
        socket.close()
        expireSession(localStorage, token,
          () => window.dispatchEvent(new Event('copage-auth-expired')))
      },
    })
    client.attachSocket(socket)
    historyReadyRef.current = () => connected && synced && canEdit && !uploading
      && !composing && !client.hasUnconfirmedChanges()
    exportReadyRef.current = () => connected && synced && !uploading
      && !composing && !client.hasUnconfirmedChanges()
    const draftChannel = draftPrefix && typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(`copage-draft-owner:${draftPrefix}`) : null
    draftChannel?.addEventListener('message', (event) => {
      if (!active || event.data?.type !== 'probe' || event.data.clientId !== client.clientId) return
      draftChannel.postMessage({ type: 'active', requestId: event.data.requestId })
    })

    const isDraftOwnerActive = (ownerClientId) => new Promise((resolve) => {
      if (!draftChannel) {
        resolve(false)
        return
      }
      const requestId = createClientId()
      const finish = (found) => {
        clearTimeout(timer)
        draftChannel.removeEventListener('message', onMessage)
        resolve(found)
      }
      const onMessage = (event) => {
        if (event.data?.type === 'active' && event.data.requestId === requestId) finish(true)
      }
      const timer = setTimeout(() => finish(false), 500)
      draftChannel.addEventListener('message', onMessage)
      draftChannel.postMessage({ type: 'probe', requestId, clientId: ownerClientId })
    })

    const persistDraft = () => {
      updateSaveStatus()
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
    const findDrafts = () => {
      if (!draftPrefix) return []
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
      return found.sort((a, b) =>
        Number(b.key === draftPrefix + clientId) - Number(a.key === draftPrefix + clientId)
        || (b.draft.savedAt ?? 0) - (a.draft.savedAt ?? 0))
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
      updateToolbar()
      linkEditor.transform(delta)
      if (pendingImageOperation) pendingImageOperation = delta.transform(pendingImageOperation, true)
      if (imageInsertIndex !== null) imageInsertIndex = delta.transformPosition(imageInsertIndex, true)
      cursorLayer.transform(delta)
      if (source !== 'user') return
      scheduleCursor()
      if (composing) {
        compositionDirty = true
        return
      }
      submit(delta)
    }
    const onCompositionStart = () => { composing = true; updateSaveStatus() }
    const flushComposition = () => {
      if (composing) {
        // Quill 延迟到 compositionend 微任务才结束 batch。断线/撤权/离开
        // 页面时须先收集 DOM 中的输入，不能只读取尚未更新的 Delta。
        quill.scroll.batchEnd()
        quill.update('user')
      }
      if (!compositionDirty) return
      compositionDirty = false
      submit(lastKnownContents.diff(quill.getContents()))
    }
    const onCompositionEnd = () => {
      // Quill 先结束自己的 batch，再提交本地输入和按序处理远端消息。
      queueMicrotask(() => {
        if (!active) return
        flushComposition()
        composing = false
        compositionInbox.drain()
        updateSaveStatus()
      })
    }
    const onSelectionChange = (range, _old, source) => {
      if (source === 'user' || range === null) scheduleCursor()
    }
    const renderRemoteCursors = () => cursorLayer.render()
    const onBeforeUnload = (event) => {
      flushComposition()
      persistDraft()
      if (!client.hasUnconfirmedChanges() && !compositionDirty) return
      event.preventDefault()
      event.returnValue = ''
    }

    quill.on('text-change', onTextChange)
    quill.on('selection-change', onSelectionChange)
    quill.root.addEventListener('compositionstart', onCompositionStart)
    quill.root.addEventListener('compositionend', onCompositionEnd)
    quill.root.addEventListener('scroll', renderRemoteCursors)
    window.addEventListener('resize', renderRemoteCursors)
    window.addEventListener('beforeunload', onBeforeUnload)
    const cursorKeepaliveTimer = window.setInterval(() => {
      cursorLayer.expire()
      if (lastSentCursor?.visible) sendCursor(true)
    }, 20_000)

    request.get('/doc/' + docId)
      .then(async (response) => {
        if (!active) return
        const doc = response.data
        setTitle(doc.title)
        setPermission(doc.permission)
        setIsOwner(doc.isOwner === true)
        canEdit = doc.permission === 2
        quill.setContents(new Delta(doc.content), 'api')
        lastKnownContents = quill.getContents()
        updateEditable()
        let stored = null
        let activeDraftFound = false
        for (const candidate of findDrafts()) {
          if (await isDraftOwnerActive(candidate.draft.clientId)) {
            activeDraftFound = true
            if (candidate.draft.clientId === client.clientId) {
              client.clientId = createClientId()
              sessionStorage.setItem(tabKey, client.clientId)
            }
          } else {
            stored = candidate
            break
          }
        }
        if (!active) return
        if (stored) {
          setConnection('等待恢复选择')
          setSaveStatus('等待恢复本地草稿')
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
          if (activeDraftFound) setError('另一标签页正在编辑，未接管它的本地草稿')
          startSocket()
        }
      })
      .catch((loadError) => {
        if (!active) return
        setConnection('加载失败')
        setError(loadError?.message || '文档加载失败')
      })

    return () => {
      hideCursor()
      flushComposition()
      persistDraft()
      active = false
      compositionInbox.clear()
      sessionCheckController.abort()
      titleController?.abort()
      linkEditor.dispose()
      refreshTitleRef.current = null
      window.clearInterval(cursorKeepaliveTimer)
      quill.off('text-change', onTextChange)
      quill.off('selection-change', onSelectionChange)
      quill.root.removeEventListener('compositionstart', onCompositionStart)
      quill.root.removeEventListener('compositionend', onCompositionEnd)
      quill.root.removeEventListener('scroll', renderRemoteCursors)
      window.removeEventListener('resize', renderRemoteCursors)
      window.removeEventListener('beforeunload', onBeforeUnload)
      client.close()
      socket.close()
      abortImageUpload()
      imageInput.removeEventListener('change', onImageChange)
      imageInput.removeEventListener('cancel', onImageCancel)
      draftChannel?.close()
      cursorLayer.destroy()
      recoveryActionsRef.current = null
      historyReadyRef.current = null
      exportReadyRef.current = null
      quill.getModule('toolbar')?.container.remove()
      host.replaceChildren()
      quillRef.current = null
    }
  }, [docId])

  return {
    editorHostRef, connection, users, error, title, permission, isOwner, recoveryDraft, saveStatus, titleError,
    refreshTitle: () => refreshTitleRef.current?.(),
    recoverDraft: () => recoveryActionsRef.current?.recover(),
    discardDraft: () => recoveryActionsRef.current?.discard(),
    canRestoreHistory: () => Boolean(historyReadyRef.current?.()),
    canExportDocument: () => Boolean(exportReadyRef.current?.()),
  }
}
