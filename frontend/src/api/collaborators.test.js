import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCollaboratorsReply as parse, confirmCollaboratorUpdate as confirm } from './collaborators.js'
const member = {userId:4,username:'member',nickname:null,permission:1}
test('valid empty and populated lists preserve current permission and nullable nickname',()=>{
  const list=[member,{userId:5,username:'editor',nickname:'编辑者',permission:2}]
  assert.deepEqual(parse({code:0,data:[]}),[])
  assert.equal(parse({code:0,data:list}),list)
})
test('failed and incomplete lists never become a reliable permission state',()=>{
  for(const bad of [null,[],{}, {code:500,data:[]},{code:'0',data:[]},{code:0}, {code:0,data:{}},
    ...[{...member,userId:undefined},{...member,userId:'4'},{...member,userId:0},
      {...member,permission:3},{...member,permission:'1'},{...member,username:''},
      {...member,nickname:undefined}].map(m=>({code:0,data:[m]})),
    {code:0,data:[member,member]}, {code:0,data:[member,{...member,userId:5,username:'MEMBER'}]}])assert.throws(()=>parse(bad))
})
test('only complete business success acknowledges a member update',()=>{
  assert.doesNotThrow(()=>confirm({code:0,data:null}))
  for(const value of [null,[],{}, {code:0}, {code:'0',data:null},{code:500,data:null},{code:0,data:[]},{code:0,data:{}}])assert.throws(()=>confirm(value))
})
