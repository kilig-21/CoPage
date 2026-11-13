import { useRef } from 'react'
import { Alert, Button, Popconfirm, Space } from 'antd'
import { Link } from 'react-router-dom'
import { documentHref } from '../navigation/documents'

export default function DocumentLifecycleFeedback({ lifecycle, returnTo }) {
  const { record, error, storageFailed, busy, checking, review, reviewFailed, endWaiting, notice, retryStorage } = lifecycle
  const confirmedRecord = useRef(null)
  const target = record?.target
  const verb = target?.operation === 'delete' ? '删除' : '恢复'
  const canEnd = Boolean(record && (!target || reviewFailed))

  return <>
    {record && <Alert className="lifecycle-review-alert" type="warning" showIcon
      message={error || (target ? `${verb}结果未确认，请核对文档 #${target.id} 的当前状态。` : '有一条待核对记录无法读取。')}
      description={target ? '核对会读取这篇文档的当前状态。' : '可结束等待以清除这条记录。'}
      action={<Space wrap>
        {target && <Button loading={checking} disabled={busy} onClick={review}>核对{verb}结果</Button>}
        {canEnd && <Popconfirm title="结束等待？" description="这只会移除浏览器中的待核对记录。请先查看原资料，再决定是否重新操作。"
          overlayClassName="document-action-confirm" okText="结束等待" cancelText="继续保留"
          onOpenChange={open => { if (open) confirmedRecord.current = record.raw }}
          onConfirm={() => endWaiting(confirmedRecord.current)} disabled={busy}>
          <Button disabled={busy}>结束本次等待</Button>
        </Popconfirm>}
      </Space>} />}
    {error && !record && <Alert type="error" showIcon message={error}
      action={storageFailed && <Button disabled={busy} onClick={retryStorage}>重读记录</Button>} />}
    {notice && <Alert className="lifecycle-review-alert" type={notice.type} showIcon message={notice.message}
      action={notice.id && (notice.deleted ? <Link to="/trash">查看回收站</Link>
        : <Link to={documentHref(notice.id, returnTo)}>打开文档</Link>)} />}
  </>
}
