import { Alert, Button } from 'antd'
import { useNavigate } from 'react-router-dom'
import usePendingCopies from '../api/usePendingCopies'

export default function PendingCopyHint({ sourceId }) {
  const pending = usePendingCopies(), navigate = useNavigate()
  if (!pending.records.some(record => record.sourceId === sourceId)) return null
  return <Alert className="editor-alert" type="info" showIcon
    message="有副本创建尚待确认；来源无法打开时仍可确认已创建的私人副本"
    action={<Button onClick={() => navigate('/docs?scope=owned')}>查看待确认副本</Button>} />
}
