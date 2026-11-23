import { useEffect, useRef, useState } from 'react'
import { App } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'
import { usePageSession } from '../auth/PageSessionContext'
import { useCreationTrackingWarning } from '../components/useCreationTrackingWarning'
import { documentHref } from '../navigation/documents'
import createDocumentRequest from './createDocument'
import { UNTITLED_DOCUMENT_TITLE } from './documentRename'
import { requestFailureMessage } from './requestError'

export default function useBlankDocumentCreation() {
  const { message } = App.useApp()
  const { identity } = usePageSession()
  const warnTracking = useCreationTrackingWarning()
  const location = useLocation()
  const navigate = useNavigate()
  const sourcePath = location.pathname + location.search + location.hash
  const [creating, setCreating] = useState(false)
  const attempt = useRef(null)

  useEffect(() => {
    setCreating(false)
    return () => {
      attempt.current?.abort()
      attempt.current = null
    }
  }, [location.key])

  function openCreatedDocument(data) {
    navigate(documentHref(data.id, sourcePath))
  }

  async function createBlankDocument() {
    if (attempt.current) return
    const controller = new AbortController()
    attempt.current = controller
    setCreating(true)
    try {
      const response = await createDocumentRequest('/doc', { title: UNTITLED_DOCUMENT_TITLE }, {
        signal: controller.signal,
        expectedIdentity: identity,
      })
      if (controller.signal.aborted) return
      warnTracking(response)
      openCreatedDocument(response.data)
    } catch (error) {
      if (controller.signal.aborted) return
      const detail = requestFailureMessage(error, '')
      const retry = '创建结果未确认。可以重试本次创建，或先刷新列表核对。相同请求不会重复创建文档。'
      message.error(error?.code === 400 && detail ? detail : [detail, retry].filter(Boolean).join(' '))
    } finally {
      if (attempt.current === controller) attempt.current = null
      if (!controller.signal.aborted) setCreating(false)
    }
  }

  return { creating, createBlankDocument, openCreatedDocument, creationIdentity: identity }
}
