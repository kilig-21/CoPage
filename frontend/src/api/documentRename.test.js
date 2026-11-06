import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDocumentRenameReply as parse } from './documentRename.js'

const reply = { code: 0, data: { id: 33, title: '原文档的新标题', updateTime: '2026-11-06 16:00:00' } }
test('rename confirmation accepts only the original document and submitted title', () => {
  assert.equal(parse(reply, 33, reply.data.title), reply.data)
  assert.throws(() => parse(reply, 34, reply.data.title))
  assert.throws(() => parse(reply, 33, '另一标题'))
})
test('metadata confirms current title without claiming that the original write succeeded', () => {
  assert.equal(parse(reply, 33).title, reply.data.title)
  assert.equal(parse({code:0,data:{id:33,title:'另一位编辑者修改的标题'}},33).title,'另一位编辑者修改的标题')
})
test('bad envelopes, targets and incomplete titles cannot release an unknown rename', () => {
  for (const bad of [null, [], {}, {code:500,data:reply.data}, {code:'0',data:reply.data}, {code:0},
    ...[null,[],{title:'标题'}, {id:'33',title:'标题'}, {id:34,title:'标题'}, {id:33},
      {id:33,title:null},{id:33,title:''},{id:33,title:' '},{id:33,title:'a'.repeat(201)}].map(data=>({code:0,data}))]) {
    assert.throws(()=>parse(bad,33))
  }
  for(const id of [0,-1,'33',NaN,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>parse(reply,id))
})
