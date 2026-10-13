import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Empty, Input, Layout, List, Pagination, Popconfirm, Space, Typography } from 'antd'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import request from '../api/request'
import WorkspaceHeader from '../components/WorkspaceHeader'
import useDocumentLifecycle from '../api/useDocumentLifecycle'
import { documentHref } from '../navigation/documents'

const PAGE_SIZE=20
export default function Trash() {
  const navigate = useNavigate()
  const location = useLocation()
  const sourcePath=location.pathname+location.search+location.hash
  const [params,setParams]=useSearchParams()
  const keyword=(params.get('keyword')||'').slice(0,200).trim()
  const [input,setInput]=useState(keyword)
  const rawPage=Number(params.get('page')||1)
  const page=Number.isSafeInteger(rawPage)&&rawPage>0&&rawPage<=1000000?rawPage:1
  const setPage=next=>setParams({...(keyword?{keyword}:{}),page:String(next)})
  const [docs,setDocs]=useState([])
  const [total,setTotal]=useState(0)
  const [refresh,setRefresh]=useState(0)
  const [loading,setLoading]=useState(false)
  const [error,setError]=useState('')
  const [loadedFrom,setLoadedFrom]=useState(null)
  const listKey=JSON.stringify([page,keyword,refresh])
  const currentKey=useRef(listKey)
  currentKey.current=listKey
  const listReady=loadedFrom===listKey&&!loading&&!error
  const reading=loading||(!error&&loadedFrom!==listKey)
  const restoration=useDocumentLifecycle({operation:'restore',ready:listReady,
    onConfirmed:()=>setRefresh(n=>n+1)})
  useEffect(()=>setInput(keyword),[keyword])
  const applyFilter=value=>{
    if(restoration.busy)return
    const next=value.slice(0,200).trim()
    setInput(next)
    setParams({...(next?{keyword:next}:{}),page:'1'})
    if(next===keyword&&page===1)setRefresh(n=>n+1)
  }
  useEffect(()=>{
    const controller=new AbortController()
    const current=()=>!controller.signal.aborted&&currentKey.current===listKey
    setLoading(true);setError('')
    setDocs([]);setTotal(0)
    request.get('/doc/trash',{params:{page,size:PAGE_SIZE,keyword},signal:controller.signal})
      .then(response=>{
        if(!current())return
        const lastPage=Math.max(1,Math.ceil(response.data.total/PAGE_SIZE))
        if(page>lastPage){setPage(lastPage);return}
        setDocs(response.data.list);setTotal(response.data.total)
        setLoadedFrom(listKey)
      }).catch(ex=>{if(current()){setDocs([]);setError([400,401,403,404].includes(ex?.code)
        ? ex.message||'读取请求未获准，请核对当前账号。' : '回收站未能加载，请重试。')}})
      .finally(()=>{if(current())setLoading(false)})
    return ()=>controller.abort()
  },[page,keyword,refresh])
  return <Layout className="app-shell">
    <WorkspaceHeader title="回收站">
      <Button disabled={loading||restoration.busy} onClick={()=>setRefresh(n=>n+1)}>刷新回收站</Button>
    </WorkspaceHeader>
    <main className="content-wrap">
      <Typography.Title level={2}>找回删除的文档</Typography.Title>
      <Typography.Paragraph type="secondary">这里只显示你拥有的已删除文档。恢复保留正文、版本与原协作者权限；已清理的普通历史不会重建。</Typography.Paragraph>
      <Input.Search aria-label="按标题查找已删除文档" placeholder="按文档标题查找" maxLength={200} value={input}
        disabled={restoration.busy} onChange={event=>setInput(event.target.value)} onSearch={applyFilter} enterButton="查找文档"
        size="large" style={{width:'100%',maxWidth:480,marginBottom:12}} />
      <Space wrap style={{display:'flex',marginBottom:16}}>
        {listReady&&<Typography.Text role="status">{keyword?'匹配的已删除文档：':'回收站文档：'}{total} 篇</Typography.Text>}
        {keyword&&<Button disabled={restoration.busy} onClick={()=>applyFilter('')}>清除查找</Button>}
      </Space>
      {error&&<Alert type="error" showIcon message={error} action={<Button disabled={loading} onClick={()=>setRefresh(n=>n+1)}>重试</Button>} />}
      {restoration.uncertain&&<Alert className="lifecycle-review-alert" type="warning" showIcon
        message={restoration.error||'恢复结果未确认，请先核对当前状态。'} description={'待核对文档：'+restoration.uncertain.title}
        action={<Button disabled={restoration.busy} loading={restoration.checking} onClick={restoration.review}>核对恢复结果</Button>} />}
      {restoration.error&&!restoration.uncertain&&<Alert type="error" showIcon message={restoration.error} />}
      {restoration.notice&&<Alert className="lifecycle-review-alert" type={restoration.notice.type} showIcon message={restoration.notice.message}
        action={restoration.notice.openId&&<Button onClick={()=>navigate(documentHref(restoration.notice.openId,sourcePath))}>打开恢复的文档</Button>} />}
      <Card className="trash-list-card"><List rowKey="id" loading={reading} dataSource={listReady?docs:[]}
        locale={{emptyText:reading?'正在加载…':error?'列表暂不可用':<Empty description={keyword?'没有匹配标题的已删除文档，试试其他关键词或清除查找':'回收站是空的'} />}}
        renderItem={doc=><List.Item actions={[<Popconfirm key="restore" overlayClassName="document-action-confirm" title={`恢复“${doc.title}”？`}
          description="恢复后，原协作者将重新获得原来的权限。" okText="确认恢复" cancelText="取消"
          disabled={restoration.blocked} onConfirm={()=>restoration.run(doc)}>
          <Button disabled={restoration.blocked} loading={restoration.pendingId===doc.id}>恢复文档</Button></Popconfirm>]}>
          <List.Item.Meta title={doc.title} description={'删除时间：'+doc.deletedAt} />
        </List.Item>} />
        {listReady&&total>PAGE_SIZE&&<Pagination current={page} pageSize={PAGE_SIZE} total={total} showSizeChanger={false} responsive showLessItems
          disabled={loading||restoration.busy} onChange={setPage} />}
      </Card>
    </main>
  </Layout>
}
