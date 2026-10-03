import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const origin=process.env.COPAGE_HISTORY_ORIGIN || 'http://localhost:8081'
const docker=process.env.COPAGE_DOCKER || 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
const docs=[]; let token
async function api(path,method='GET',body,status=200) {
  const response=await fetch(origin+'/api'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined})
  const result=await response.json();assert.equal(response.status,status,`${path}: ${result.message}`);return result.data
}
function sql(input) {
  const result=spawnSync(docker,['exec','-i','collab-mysql','mysql','-uroot','-p123456','collab_doc','-N'],{input,encoding:'utf8',timeout:60000,maxBuffer:1024*1024})
  assert.equal(result.status,0,(result.stderr||'SQL failed').slice(0,500));return result.stdout.trim()
}
async function fixture() {
  const doc=(await api('/doc','POST',{title:'RetentionFixture-'+randomUUID()}));docs.push(doc.id)
  assert.equal(sql(`SELECT COUNT(*) FROM document WHERE id=${doc.id} AND title LIKE 'RetentionFixture-%' AND revision=0;`),'1')
  return doc.id
}
try {
  const account=await api('/auth/login','POST',{username:'testA',password:'123456'});token=account.token
  const id=await fixture(), base=`/doc/${id}/history`
  sql(`SET SESSION cte_max_recursion_depth=12000;
    INSERT INTO doc_operation(doc_id,revision,op,user_id)
      WITH RECURSIVE n AS(SELECT 1 i UNION ALL SELECT i+1 FROM n WHERE i<10050)
      SELECT ${id},i,JSON_OBJECT('ops',JSON_ARRAY(JSON_OBJECT('insert','A'))),${account.user.id} FROM n;
    INSERT INTO doc_operation_receipt(doc_id,user_id,client_id,op_id,revision,request_hash)
      SELECT doc_id,user_id,'fixture',CONCAT('op-',revision),revision,REPEAT('0',64) FROM doc_operation WHERE doc_id=${id};
    UPDATE document SET revision=10050,content=JSON_OBJECT('ops',JSON_ARRAY(JSON_OBJECT('insert',CONCAT(REPEAT('A',10050),CHAR(10))))) WHERE id=${id};`)
  assert.equal((await api(base+'/retention')).proposedMinimumRevision,50)
  sql(`UPDATE doc_operation SET create_time=DATE_SUB(NOW(),INTERVAL 40 DAY) WHERE doc_id=${id} AND revision<=100;`)
  const age=await api(base+'/retention');assert.equal(age.proposedMinimumRevision,100)
  await api(base+'/1/name','PUT',{name:'早期里程碑'})
  for(let revision=2;revision<=20;revision++) await api(base+`/${revision}/name`,'PUT',{name:'重要版本 '+revision})
  await api(base+'/21/name','PUT',{name:'超出数量'},400)
  await api(base+'/1/name','PUT',{name:'早期里程碑（更新名称）'})
  await api(base+'/compact','POST',{expectedRevision:10050,beforeRevision:age.proposedMinimumRevision})
  assert.equal(sql(`SELECT MIN(revision) FROM doc_operation WHERE doc_id=${id};`),'101')
  assert.equal(sql(`SELECT MIN(revision) FROM doc_operation_receipt WHERE doc_id=${id};`),'101')
  assert.equal((await api(base+'/100')).content.ops[0].insert,'A'.repeat(100)+'\n')
  assert.equal((await api(base+'/1')).content.ops[0].insert,'A\n')
  await api(base+'/1/name','DELETE')
  console.log(JSON.stringify({docId:id,countLimit:true,ageLimit:true,receiptsTrimmedSafely:true,namedRetained:true,namedLimit:true}))

  const large=await fixture(), largeBase=`/doc/${large}/history`
  sql(`SET SESSION cte_max_recursion_depth=3000;
    INSERT INTO doc_operation(doc_id,revision,op,user_id)
      WITH RECURSIVE n AS(SELECT 1 i UNION ALL SELECT i+1 FROM n WHERE i<2000)
      SELECT ${large},i,IF(i=1,JSON_OBJECT('ops',JSON_ARRAY(JSON_OBJECT('insert',REPEAT('a',1048576)))),
        JSON_OBJECT('ops',JSON_ARRAY(JSON_OBJECT('retain',1,'attributes',JSON_OBJECT('bold',MOD(i,2)=0))))),${account.user.id} FROM n;
    SET @fixture_body=JSON_OBJECT('ops',JSON_ARRAY(JSON_OBJECT('insert','a','attributes',JSON_OBJECT('bold',1)),
      JSON_OBJECT('insert',CONCAT(REPEAT('a',1048575),CHAR(10)))));
    INSERT INTO doc_snapshot(doc_id,revision,content) SELECT ${large},revision,@fixture_body FROM doc_operation WHERE doc_id=${large} AND MOD(revision,20)=0;
    UPDATE document SET revision=2000,content=@fixture_body WHERE id=${large};`)
  const capacity=await api(largeBase+'/retention');assert.ok(capacity.proposedMinimumRevision>0)
  await api(largeBase+'/compact','POST',{expectedRevision:2000,beforeRevision:capacity.proposedMinimumRevision})
  const bytes=Number(sql(`SELECT COALESCE((SELECT SUM(OCTET_LENGTH(op)) FROM doc_operation WHERE doc_id=${large}),0)+COALESCE((SELECT SUM(OCTET_LENGTH(content)) FROM doc_snapshot WHERE doc_id=${large}),0);`))
  assert.ok(bytes<=67108864,`quota exceeded: ${bytes}`)
  assert.equal((await api(`/doc/${large}`)).revision,2000)
  console.log(JSON.stringify({docId:large,capacityLimit:true,minimumRevision:capacity.proposedMinimumRevision,logicalBytes:bytes,currentRevisionPreserved:2000}))
} finally {
  for(const docId of docs) {
    // 仅精确清除本脚本创建的合成历史，避免容量验收数据留在用户数据库。
    await api('/doc/'+docId,'DELETE')
    assert.equal(sql(`SELECT COUNT(*) FROM document WHERE id=${docId} AND title LIKE 'RetentionFixture-%' AND is_deleted=1;`),'1')
    sql(`DELETE FROM doc_operation WHERE doc_id=${docId}; DELETE FROM doc_operation_receipt WHERE doc_id=${docId}; DELETE FROM doc_snapshot WHERE doc_id=${docId}; DELETE FROM doc_named_version WHERE doc_id=${docId}; DELETE FROM doc_history_boundary WHERE doc_id=${docId};`)
  }
}
