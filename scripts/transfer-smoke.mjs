import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
const origin=process.env.COPAGE_TRANSFER_ORIGIN || 'http://localhost:8080'
const ids=[]
let owner,member
async function api(auth,path,method='GET',body,status=200) {
 const form=body instanceof FormData
 const r=await fetch(origin+'/api'+path,{method,headers:{...(auth?{Authorization:'Bearer '+auth}:{}),...(!form&&body?{'Content-Type':'application/json'}:{})},body:form?body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)})
 const j=await r.json();assert.equal(r.status,status,`${method} ${path}: ${j.message}`);if(status===200)assert.equal(j.code,0);return j.data
}
function file(name,text,title){const form=new FormData();form.append('file',new Blob([text]),name);if(title)form.append('title',title);return form}
const marker='Transfer-'+randomUUID()
try {
 owner=await api(null,'/auth/login','POST',{username:'testA',password:'123456'})
 member=await api(null,'/auth/login','POST',{username:'testB',password:'123456'})
 await api(null,'/doc/import','POST',file('a.txt','a'),401)
 await api(owner.token,'/doc/import','POST',new FormData(),400)
 for(const bad of [file('bad.json','{}'),file('bad.txt',new Uint8Array([0xC3])),file('bad.html','<h1>html</h1>'),file('bad.txt','x'.repeat(1024*1024+1))])await api(owner.token,'/doc/import','POST',bad,400)
 const doc=await api(owner.token,'/doc/import','POST',file(marker+'.txt','\uFEFF中文 <script>literal</script>\r\n第二行',marker));ids.push(doc.id)
 const detail=await api(owner.token,'/doc/'+doc.id)
 assert.equal(detail.revision,0);assert.deepEqual(detail.content,{ops:[{insert:'中文 <script>literal</script>\n第二行\n'}]})
 assert.deepEqual((await api(owner.token,`/doc/${doc.id}/history/0`)).content,detail.content)
 await api(member.token,`/doc/${doc.id}/export?format=txt`,'GET',undefined,403)
 await api(owner.token,`/doc/${doc.id}/collaborators`,'POST',{username:'testB',permission:1})
 const txt=await api(member.token,`/doc/${doc.id}/export?format=txt`)
 assert.equal(txt.content,'中文 <script>literal</script>\n第二行\n');assert.equal(txt.revision,0)
 const copy=await api(member.token,`/doc/${doc.id}/export?format=copage`)
 assert.deepEqual(Object.keys(JSON.parse(copy.content)).sort(),['content','format','title','version'])
 const imported=await api(member.token,'/doc/import','POST',file(copy.filename,copy.content,marker+'-copy'));ids.push(imported.id)
 const second=await api(member.token,'/doc/'+imported.id)
 assert.equal(second.ownerId,member.user.id);assert.equal(second.revision,0);assert.deepEqual(second.content,detail.content)
 assert.equal((await api(member.token,`/doc/${imported.id}/collaborators`)).length,0)
 await api(owner.token,'/doc/'+imported.id,'GET',undefined,403)
 const rich={format:'copage',version:1,title:marker+'-rich',content:{ops:[{insert:'粗体',attributes:{bold:true}},{insert:'\n',attributes:{header:1}},{insert:{image:'http://localhost:9000/collab/transfer-fixture.png'}},{insert:'\n'}]}}
 const richDoc=await api(owner.token,'/doc/import','POST',file('rich.json',JSON.stringify(rich)));ids.push(richDoc.id)
 assert.deepEqual(JSON.parse((await api(owner.token,`/doc/${richDoc.id}/export?format=copage`)).content).content,rich.content)
 const malicious=structuredClone(rich);malicious.content.ops[0].attributes.link='javascript:alert(1)'
 await api(owner.token,'/doc/import','POST',file('bad.json',JSON.stringify(malicious)),400)
 await api(owner.token,`/doc/${doc.id}/export?format=html`,'GET',undefined,400)
 await api(owner.token,`/doc/${doc.id}/collaborators/${member.user.id}`,'DELETE')
 await api(member.token,`/doc/${doc.id}/export?format=txt`,'GET',undefined,403)
 await api(owner.token,'/doc/'+richDoc.id,'DELETE')
 await api(owner.token,`/doc/${richDoc.id}/export?format=copage`,'GET',undefined,404)
 console.log(JSON.stringify({docIds:ids,origin,utf8AndBaseline:true,readOnlyExport:true,richRoundTrip:true,independentOwnership:true,revokedAndDeletedBlocked:true,invalidInputsRejected:true}))
} finally {
 if(owner&&member)for(const id of ids){const auth=id===ids[1]?member.token:owner.token;await api(auth,`/doc/${id}/restore`,'POST');const collaborators=await api(auth,`/doc/${id}/collaborators`);for(const collaborator of collaborators)await api(auth,`/doc/${id}/collaborators/${collaborator.userId}`,'DELETE');await api(auth,`/doc/${id}`,'DELETE')}
}
