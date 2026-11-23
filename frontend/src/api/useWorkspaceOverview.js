import { useEffect, useState } from 'react'
import { usePageRequest } from '../auth/PageSessionContext'

export default function useWorkspaceOverview() {
  const request = usePageRequest()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setData(null)
    request.get('/workspace/overview', { signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) setData(data) })
      .catch(failure => { if (!controller.signal.aborted) setError([400, 403, 404].includes(failure?.code)
        ? failure.message : '小组与项目概览暂时无法加载，请重试。') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh, request])

  return { data, loading, error, retry: () => setRefresh(value => value + 1) }
}
