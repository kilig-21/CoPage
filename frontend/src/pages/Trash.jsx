import { useEffect, useState } from 'react'
import { Alert, Button, Card, Empty, Layout, List, Pagination, Popconfirm, Typography } from 'antd'
import { Link } from 'react-router-dom'
import request from '../api/request'

const PAGE_SIZE=20
export default function Trash() {
  const [docs,setDocs]=useState([])
  const [total,setTotal]=useState(0)
  const [page,setPage]=useState(1)
  const [refresh,setRefresh]=useState(0)
  const [loading,setLoading]=useState(false)
  const [restoring,setRestoring]=useState(null)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  useEffect(()=>{
    const controller=new AbortController()
    setLoading(true);setError('')
    request.get('/doc/trash',{params:{page,size:PAGE_SIZE},signal:controller.signal})
      .then(response=>{
        if(controller.signal.aborted)return
        const lastPage=Math.max(1,Math.ceil(response.data.total/PAGE_SIZE))
        if(page>lastPage){setPage(lastPage);return}
        setDocs(response.data.list);setTotal(response.data.total)
      }).catch(ex=>{if(!controller.signal.aborted){setDocs([]);setError(ex.message||'回收站加载失败')}})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false)})
    return ()=>controller.abort()
  },[page,refresh])
  async function restore(doc) {
    if(restoring!==null)return
    setRestoring(doc.id);setError('');setNotice('')
    try {await request.post(`/doc/${doc.id}/restore`);setNotice(`已恢复“${doc.title}”，可回到我的文档打开`);setRefresh(n=>n+1)}
    catch(ex){setError(ex.message||'恢复失败，请重试')}
    finally {setRestoring(null)}
  }
  return <Layout className="app-shell">
    <header className="topbar"><Typography.Title level={4}>回收站</Typography.Title><Link to="/docs"><Button>返回我的文档</Button></Link></header>
    <main className="content-wrap">
      <Typography.Title level={2}>找回删除的文档</Typography.Title>
      <Typography.Paragraph type="secondary">这里只显示你拥有的已删除文档。恢复保留正文、版本与原协作者权限；已清理的普通历史不会重建。</Typography.Paragraph>
      {error&&<Alert type="error" showIcon message={error} action={<Button disabled={loading} onClick={()=>setRefresh(n=>n+1)}>重试</Button>} />}
      {notice&&<Alert type="success" showIcon message={notice} />}
      <Card><List loading={loading} dataSource={docs}
        locale={{emptyText:loading?'正在加载…':error?'列表暂不可用':<Empty description="回收站是空的" />}}
        renderItem={doc=><List.Item actions={[<Popconfirm key="restore" title="恢复这篇文档？"
          description="恢复后，原协作者将重新获得原来的权限。" okText="确认恢复" cancelText="取消"
          disabled={restoring!==null} onConfirm={()=>restore(doc)}>
          <Button disabled={restoring!==null} loading={restoring===doc.id}>恢复文档</Button></Popconfirm>]}>
          <List.Item.Meta title={doc.title} description={'删除时间：'+doc.deletedAt} />
        </List.Item>} />
        {total>PAGE_SIZE&&<Pagination current={page} pageSize={PAGE_SIZE} total={total} showSizeChanger={false}
          disabled={loading||restoring!==null} onChange={setPage} />}
      </Card>
    </main>
  </Layout>
}
