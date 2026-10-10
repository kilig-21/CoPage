import { useEffect, useState } from 'react'
import { Alert, Button, Card, Empty, Layout, List, Pagination, Popconfirm, Space, Typography } from 'antd'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import request from '../api/request'
import WorkspaceHeader from '../components/WorkspaceHeader'
import useDocumentLifecycle from '../api/useDocumentLifecycle'
import { documentHref } from '../navigation/documents'

const PAGE_SIZE=20
export default function Trash() {
  const navigate = useNavigate()
  const location = useLocation()
  const [params,setParams]=useSearchParams()
  const rawPage=Number(params.get('page')||1)
  const page=Number.isSafeInteger(rawPage)&&rawPage>0&&rawPage<=1000000?rawPage:1
  const setPage=next=>setParams(next===1?{}:{page:String(next)})
  const [docs,setDocs]=useState([])
  const [total,setTotal]=useState(0)
  const [refresh,setRefresh]=useState(0)
  const [loading,setLoading]=useState(false)
  const [error,setError]=useState('')
  const [loadedFrom,setLoadedFrom]=useState(null)
  const listKey=JSON.stringify([page,refresh])
  const restoration=useDocumentLifecycle({operation:'restore',ready:loadedFrom===listKey&&!loading&&!error,
    onConfirmed:()=>setRefresh(n=>n+1)})
  useEffect(()=>{
    const controller=new AbortController()
    setLoading(true);setError('')
    setDocs([]);setTotal(0)
    request.get('/doc/trash',{params:{page,size:PAGE_SIZE},signal:controller.signal})
      .then(response=>{
        if(controller.signal.aborted)return
        const lastPage=Math.max(1,Math.ceil(response.data.total/PAGE_SIZE))
        if(page>lastPage){setPage(lastPage);return}
        setDocs(response.data.list);setTotal(response.data.total)
        setLoadedFrom(listKey)
      }).catch(ex=>{if(!controller.signal.aborted){setDocs([]);setError(ex.message||'回收站加载失败')}})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false)})
    return ()=>controller.abort()
  },[page,refresh])
  return <Layout className="app-shell">
    <WorkspaceHeader title="回收站">
      <Button disabled={loading||restoration.busy} onClick={()=>setRefresh(n=>n+1)}>刷新回收站</Button>
    </WorkspaceHeader>
    <main className="content-wrap">
      <Typography.Title level={2}>找回删除的文档</Typography.Title>
      <Typography.Paragraph type="secondary">这里只显示你拥有的已删除文档。恢复保留正文、版本与原协作者权限；已清理的普通历史不会重建。</Typography.Paragraph>
      {error&&<Alert type="error" showIcon message={error} action={<Button disabled={loading} onClick={()=>setRefresh(n=>n+1)}>重试</Button>} />}
      {restoration.uncertain&&<Alert className="lifecycle-review-alert" type="warning" showIcon
        message={restoration.error||'恢复结果未确认，请先核对当前状态。'} description={'待核对文档：'+restoration.uncertain.title}
        action={<Button disabled={restoration.busy} loading={restoration.checking} onClick={restoration.review}>核对恢复结果</Button>} />}
      {restoration.error&&!restoration.uncertain&&<Alert type="error" showIcon message={restoration.error} />}
      {restoration.notice&&<Alert className="lifecycle-review-alert" type={restoration.notice.type} showIcon message={restoration.notice.message}
        action={restoration.notice.openId&&<Button onClick={()=>navigate(documentHref(restoration.notice.openId,location.pathname+location.search))}>打开恢复的文档</Button>} />}
      <Card className="trash-list-card"><List rowKey="id" loading={loading} dataSource={docs}
        locale={{emptyText:loading?'正在加载…':error?'列表暂不可用':<Empty description="回收站是空的" />}}
        renderItem={doc=><List.Item actions={[<Popconfirm key="restore" overlayClassName="document-action-confirm" title={`恢复“${doc.title}”？`}
          description="恢复后，原协作者将重新获得原来的权限。" okText="确认恢复" cancelText="取消"
          disabled={restoration.blocked} onConfirm={()=>restoration.run(doc)}>
          <Button disabled={restoration.blocked} loading={restoration.pendingId===doc.id}>恢复文档</Button></Popconfirm>]}>
          <List.Item.Meta title={doc.title} description={'删除时间：'+doc.deletedAt} />
        </List.Item>} />
        {total>PAGE_SIZE&&<Pagination current={page} pageSize={PAGE_SIZE} total={total} showSizeChanger={false} responsive showLessItems
          disabled={loading||restoration.busy} onChange={setPage} />}
      </Card>
    </main>
  </Layout>
}
