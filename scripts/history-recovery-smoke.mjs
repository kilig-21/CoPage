import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Delta from '../frontend/node_modules/quill-delta/dist/Delta.js'
import CollabClient from '../frontend/src/ws/CollabClient.js'
const origin = process.env.COPAGE_HISTORY_ORIGIN || 'http://localhost:8081'
let token
const sockets=[]; const docs=[]
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(predicate,description) { const end=Date.now()+30000; while(Date.now()<end) {if(predicate())return;await pause(10)} throw new Error(description) }
async function api(path,method='GET',body,status=200) {
  const response=await fetch(origin+'/api'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined})
  const result=await response.json(); assert.equal(response.status,status,`${path}: ${result.message}`); return result.data
}
async function connect(docId,clientId,onMessage) {
  const ws=new WebSocket(origin.replace(/^http/,'ws')+'/ws/collab?token='+encodeURIComponent(token));sockets.push(ws)
  const messages=[];ws.addEventListener('message',e=>{const m=JSON.parse(e.data);messages.push(m);onMessage?.(m)})
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})})
  return {ws,messages,send:message=>{ws.send(JSON.stringify(message));return true}}
}
async function scenario(committed) {
  const docId=(await api('/doc','POST',{title:'LongHistory-'+randomUUID()})).id;docs.push(docId)
  let document=new Delta().insert('AB\n'), paged=false, pages=0
  const clientId='recover-'+randomUUID()
  const client=new CollabClient({docId,clientId,Delta,onSync:content=>{if(content)document=content},onRemote:op=>{document=document.compose(op)},onError:message=>{throw new Error(message)}})
  client.submit(new Delta().insert('A'));client.submit(new Delta().retain(1).insert('B'))
  const pending=client.pending
  const writer=await connect(docId,'writer-'+randomUUID())
  writer.send({type:'join',docId,clientId:'writer',lastRevision:0,syncId:'writer'})
  // 真实 session/clientId 必须一致，因此 writer 加入使用固定 writer。
  await until(()=>writer.messages.some(m=>m.type==='sync'),'writer join')
  let revision=0
  if(committed) {
    const lost=await connect(docId,clientId)
    lost.send({type:'join',docId,clientId,lastRevision:0,syncId:'lost'})
    await until(()=>lost.messages.some(m=>m.type==='sync'),'lost join')
    lost.send({type:'op',docId,clientId,baseRevision:0,opId:pending.opId,op:pending.original})
    await until(()=>lost.messages.some(m=>m.type==='ack'),'lost commit')
    lost.ws.close();revision=1
  }
  for(let i=0;i<2005;i++) {
    writer.send({type:'op',docId,clientId:'writer',baseRevision:revision,opId:'remote-'+i,op:{ops:[{insert:'R'}]}})
    const expected=++revision
    await until(()=>writer.messages.some(m=>m.type==='ack'&&m.revision===expected),'remote commit '+expected)
  }
  client.disconnect()
  const recovered=await connect(docId,clientId,m=>{if(m.type==='sync')paged ||= m.historyPaged===true;if(m.type==='history_page')pages++;client.receive(m)})
  client.attachSocket(recovered);client.join()
  await until(()=>client.state==='ready'&&!client.hasUnconfirmedChanges(),'recovered and acknowledged')
  const durable=await api(`/doc/${docId}`)
  assert.equal(paged,true);assert.ok(pages>=8);assert.deepEqual(document.ops,durable.content.ops)
  assert.equal(durable.content.ops[0].insert,'R'.repeat(2005)+'AB\n')
  assert.equal(durable.revision,2007)
  // 用合成文档验收真实事务裁剪、重要版本保留和过期重试拒绝。
  const base=`/doc/${docId}/history`
  await api(base+'/1/name','PUT',{name:'清理后仍可恢复'})
  const preview=await api(base+'/retention');assert.equal(preview.maxOperations,10000)
  await api(base+'/compact','POST',{expectedRevision:2006,beforeRevision:1000},409)
  await api(base+'/compact','POST',{expectedRevision:2007,beforeRevision:1000})
  assert.equal((await api(base)).minimumRevision,1000)
  await api(base+'/999','GET',undefined,409)
  assert.ok((await api(base+'/1000')).content.ops.length)
  assert.ok((await api(base+'/1')).content.ops.length)
  // 被清理的首条远端操作不能因收据移除而再执行。
  writer.send({type:'op',docId,clientId:'writer',baseRevision:committed?1:0,opId:'remote-0',op:{ops:[{insert:'R'}]}})
  await until(()=>writer.messages.some(m=>m.type==='error'&&m.code===40903),'expired retry rejected')
  assert.equal((await api(`/doc/${docId}`)).revision,2007)
  await api(base+'/1/restore','POST',{expectedRevision:2007,requestId:randomUUID()})
  assert.equal((await api(`/doc/${docId}`)).revision,2008)
  await api(base+'/1/name','DELETE')
  client.close();recovered.ws.close();writer.ws.close()
  console.log(JSON.stringify({docId,committedPending:committed,pages,converged:true,revision:2008,baselineReadable:true,namedVersionSurvives:true,expiredRetryRejected:true}))
}
try {
  token=(await api('/auth/login','POST',{username:'testA',password:'123456'})).token
  await api('/doc/26/history/compact','POST',{expectedRevision:7,beforeRevision:1},403)
  await scenario(false);await scenario(true)
} finally {
  for(const ws of sockets)ws.close()
  for(const docId of docs)await api('/doc/'+docId,'DELETE')
}
