import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const origin = process.env.COPAGE_TEMPLATE_ORIGIN || 'http://localhost:8081'
const created = []
let token, socket
async function api(path, method = 'GET', body, status = 200, auth = token) {
  const r = await fetch(origin + '/api' + path, {method, headers: {
    ...(auth ? {Authorization:'Bearer '+auth} : {}), ...(body ? {'Content-Type':'application/json'} : {}),
  }, body:body ? JSON.stringify(body) : undefined})
  const json=await r.json(); assert.equal(r.status,status,`${path}: ${json.message}`)
  if(status===200)assert.equal(json.code,0)
  return json.data
}
try {
  await api('/doc/templates','GET',undefined,401,null)
  token=(await api('/auth/login','POST',{username:'testA',password:'123456'})).token
  const templates=await api('/doc/templates');assert.equal(templates.length,3)
  await api('/doc','POST',{templateId:'nonexistent'},400)
  const template=templates.find(t=>t.id==='meeting'), title='TemplateSmoke-'+randomUUID()
  const doc=await api('/doc','POST',{title,templateId:template.id});created.push(doc.id)
  const another=await api('/doc','POST',{templateId:template.id});created.push(another.id)
  assert.equal(another.title,template.title)
  assert.deepEqual((await api('/doc/'+doc.id)).content,template.content)
  socket=new WebSocket(origin.replace(/^http/,'ws')+'/ws/collab?token='+encodeURIComponent(token))
  const messages=[];socket.addEventListener('message',e=>messages.push(JSON.parse(e.data)))
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})})
  const wait=async predicate=>{const deadline=Date.now()+15000;while(Date.now()<deadline){const m=messages.find(predicate);if(m)return m;await new Promise(r=>setTimeout(r,20))}throw new Error('WS timeout')}
  socket.send(JSON.stringify({type:'join',docId:doc.id,clientId:'template-smoke',lastRevision:0,syncId:'initial'}))
  const sync=await wait(m=>m.type==='sync');assert.deepEqual(sync.content,template.content)
  socket.send(JSON.stringify({type:'op',docId:doc.id,clientId:'template-smoke',opId:randomUUID(),baseRevision:0,op:{ops:[{insert:'已编辑：'}]}}))
  await wait(m=>m.type==='ack'&&m.revision===1)
  assert.deepEqual((await api(`/doc/${doc.id}/history/0`)).content,template.content)
  assert.deepEqual((await api('/doc/'+another.id)).content,template.content)
  await api(`/doc/${doc.id}/history/0/restore`,'POST',{expectedRevision:1,requestId:randomUUID()})
  assert.equal((await api('/doc/'+doc.id)).revision,2)
  assert.deepEqual((await api('/doc/'+doc.id)).content,template.content)
  const search=await api('/search?q='+encodeURIComponent(title))
  assert.ok(search.list.some(row=>row.id===doc.id),'template document is searchable')
  console.log(JSON.stringify({docIds:created,templates:3,authenticated:true,independentDocuments:true,initialSnapshot:true,restore:true,search:true}))
} finally {
  socket?.close()
  for(const id of created)await api('/doc/'+id,'DELETE')
}
