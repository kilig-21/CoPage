import test from 'node:test'
import assert from 'node:assert/strict'
import { confirmPrintAccess, parsePrintSnapshot } from './printSnapshot.js'

const reply = (change = {}) => ({ code: 0, data: { id: 545, title: '项目计划', revision: 0,
  content: { ops: [{ insert: '\n' }] }, ...change } })
const rejects = value => assert.throws(() => parsePrintSnapshot(value, 545), /打印预览回复不完整或格式不符/)

test('打印固定副本接受版本0及真正的空白文档，保持原始引用', () => {
  const value = reply()
  assert.strictEqual(parsePrintSnapshot(value, 545), value.data)
  assert.strictEqual(parsePrintSnapshot(value, 545).content, value.data.content)
})

test('缺失详情/正文、错误文档、非法标题或版本不能作为固定副本', () => {
  for (const value of [null, undefined, [], '页面回复', {}, {code:0}, {code:403, data:reply().data},
    reply({id:546}), reply({id:'545'}), reply({title:null}), reply({title:'  '}),
    reply({revision:-1}), reply({revision:0.5}), reply({revision:Number.MAX_SAFE_INTEGER+1}),
    reply({content:undefined}), reply({content:null}), reply({content:'正文'}), reply({content:[]}),
    reply({content:{}}), reply({content:{ops:[]}})]) rejects(value)
  assert.throws(() => parsePrintSnapshot(reply(), '545'))
})

test('完整正文拒绝编辑操作、非法嵌入及会破坏渲染的格式结构', () => {
  for (const op of [null, [], '文字', {retain:1}, {delete:1}, {insert:'a',retain:1}, {insert:''},
    {insert:1}, {insert:{video:'https://example.com'}}, {insert:{image:''}}, {insert:{image:1}},
    {insert:{image:'https://example.com/image.png',other:true}}, {insert:'a',attributes:[]},
    {insert:'a',attributes:null}, {insert:'a',attributes:{bold:{value:true}}},
    {insert:'a',attributes:{color:['red']}}, {insert:'a',attributes:{indent:Infinity}}]) {
    rejects(reply({content:{ops:[op,{insert:'\n'}]}}))
  }
  rejects(reply({content:{ops:[{insert:'没有完整结尾'}]}}))
  rejects(reply({content:{ops:[{insert:{image:'https://example.com/image.png'}}]}}))
})

test('全文保留Unicode、图片、旧标量属性和超过导入片段限制的内容，不截断合并', () => {
  const ops = Array.from({length:10001}, (_, index) => ({insert: index % 2 ? '中文🙂' : '文本',
    attributes: {bold:index % 2 === 0}}))
  ops.push({insert:{image:'https://example.com/image.png'}, attributes:{alt:'示意图',width:'50%'}})
  ops.push({insert:'\n', attributes:{'legacy-marker':'旧标记', 'code-block':false, indent:0, align:null}})
  const value = reply({title:'历史文档🙂',revision:123,content:{ops}})
  const before = JSON.stringify(value)
  assert.strictEqual(parsePrintSnapshot(value,545).content.ops, ops)
  assert.equal(JSON.stringify(value), before)
})

test('打印前必须收到本篇文档明确成功的权限确认', () => {
  assert.equal(confirmPrintAccess({code:0,data:{id:545,title:'原标题'}},545),undefined)
  for (const value of [null, [], {}, {code:0}, {code:0,data:{}}, {code:403,data:{id:545}},
    {code:0,data:{id:546}}, {code:0,data:{id:'545'}}]) {
    assert.throws(() => confirmPrintAccess(value,545), /打印权限回复无法确认/)
  }
})

test('已授权存量全文不套用导入2MiB边界，原字符串不截断', () => {
  const text = '中文🙂'.repeat(250000) + '\n'
  assert.ok(Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024)
  const value = reply({content:{ops:[{insert:text}]}})
  assert.strictEqual(parsePrintSnapshot(value,545).content, value.data.content)
  assert.equal(value.data.content.ops[0].insert, text)
})
