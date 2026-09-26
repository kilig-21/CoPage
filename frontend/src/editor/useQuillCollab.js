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
    const clientId = createClientId()
    let composing = false
    let compositionDirty = false
    let lastKnownContents = quill.getContents()

    const client = new CollabClient({
      docId,
      clientId,
      Delta,
      onSync: (content) => {
        quill.setContents(content, 'api')
        lastKnownContents = quill.getContents()
        setError('')
      },
      onRemote: (operation) => {
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
    })

    const socket = new CollabSocket({
      token,
      onOpen: () => {
        setConnection('已连接')
        client.join()
      },
      onMessage: (message) => client.receive(message),
      onClose: () => setConnection('正在重连'),
      onError: setError,
    })
    client.attachSocket(socket)

    const submit = (delta) => {
      if (delta.ops?.length) client.submit(delta)
      lastKnownContents = quill.getContents()
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
    const onCompositionEnd = () => {
      composing = false
      if (!compositionDirty) return
      compositionDirty = false
      submit(lastKnownContents.diff(quill.getContents()))
    }

    quill.on('text-change', onTextChange)
    quill.root.addEventListener('compositionstart', onCompositionStart)
    quill.root.addEventListener('compositionend', onCompositionEnd)

    request.get('/doc/' + docId)
      .then((response) => {
        if (!active) return
        const doc = response.data
        setTitle(doc.title)
        setPermission(doc.permission)
        quill.setContents(new Delta(doc.content), 'api')
        lastKnownContents = quill.getContents()
        quill.enable(doc.permission === 2)
        if (token) {
          setConnection('正在连接')
          socket.connect()
        } else {
          setConnection('未登录')
          setError('请先登录后再使用实时协同')
        }
      })
      .catch((loadError) => {
        if (!active) return
        setConnection('加载失败')
        setError(loadError?.message || '文档加载失败')
      })

    return () => {
      active = false
      quill.off('text-change', onTextChange)
      quill.root.removeEventListener('compositionstart', onCompositionStart)
      quill.root.removeEventListener('compositionend', onCompositionEnd)
      client.close()
      socket.close()
      quillRef.current = null
    }
  }, [docId])

  return { editorHostRef, connection, users, error, title, permission }
}
