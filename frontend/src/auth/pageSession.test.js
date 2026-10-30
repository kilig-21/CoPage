import test from 'node:test'
import assert from 'node:assert/strict'
import { bindRequestIdentity, createPageRequest, createPageSession, readPageIdentity } from './pageSession.js'

function fixture() {
  const state = { identity: { account: 'A', token: 'token-A', service: '/api' }, unreadable: false }
  const read = () => { if (state.unreadable) throw Error('storage unavailable'); return state.identity }
  const session = createPageSession(read), calls = []
  const client = { defaults: { baseURL: '/api' } }
  for (const method of ['get', 'delete', 'head', 'options', 'post', 'put', 'patch', 'request'])
    client[method] = async (...args) => { calls.push({ method, args }); return { code: 0, data: 'original result' } }
  return { state, read, session, calls, client, request: createPageRequest(client, session) }
}
const nextAccount = f => { f.state.identity = { account: 'B', token: 'token-B', service: '/api' } }
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return { promise, resolve, reject } }

test('页面原身份不会被换号后的新弹窗重新捕获，准备记录之前就拒绝', () => {
  const f=fixture(), lateChild=()=>f.session
  nextAccount(f)
  assert.equal(lateChild().identity.account,'A'); assert.ok(Object.isFrozen(f.session.identity))
  let prepared=0
  assert.throws(()=>{ const config=lateChild().options(); prepared++; return config },e=>e.reason==='PAGE_SESSION_CHANGED'&&e.code===400&&!e.uncertain)
  assert.equal(prepared,0)
})

test('所有原页面HTTP方法在换号后异步拒绝，不发送新账号请求', async () => {
  const f=fixture(); nextAccount(f)
  for(const method of ['get','delete','head','options','post','put','patch','request']) {
    let pending
    assert.doesNotThrow(()=>{ pending=method==='request'?f.request.request({url:'/doc/1'}):f.request[method]('/doc/1') })
    await assert.rejects(pending,e=>e.code===400&&e.reason==='PAGE_SESSION_CHANGED')
  }
  assert.equal(f.calls.length,0)
})

test('读取、写入及request配置均固定原令牌并保留调用方配置', async () => {
  const f=fixture(), controller=new AbortController(), input={signal:controller.signal,params:{page:2}}
  await f.request.get('/doc/list',input)
  await f.request.put('/doc/1',{title:'保留标题'},input)
  await f.request.request({url:'/doc/1',method:'get'})
  assert.equal(f.calls[0].args[1].copageExpectedSessionToken,'token-A')
  assert.equal(f.calls[1].args[2].copageExpectedSessionToken,'token-A')
  assert.deepEqual(f.calls[1].args[1],{title:'保留标题'})
  assert.equal(f.calls[2].args[0].copageExpectedSessionToken,'token-A')
  assert.equal(Object.hasOwn(input,'copageExpectedSessionToken'),false)
})

test('原账号请求已发送而回复迟到时不交给新页面，标记原结果仍待确认', async () => {
  const f=fixture(), gate=deferred()
  f.client.post=async (...args)=>{f.calls.push({args});return gate.promise}
  const pending=f.request.post('/doc/1/copy',{title:'A的输入'})
  assert.equal(f.calls.length,1); nextAccount(f); gate.resolve({code:0,data:{id:33}})
  await assert.rejects(pending,e=>e.code===500&&e.uncertain===true&&e.reason==='PAGE_SESSION_CHANGED')
  assert.equal(f.state.identity.account,'B'); assert.equal(f.state.identity.token,'token-B')
})

test('迟到失败不转交原服务错误，也不清除新账号身份', async () => {
  const f=fixture(), gate=deferred()
  f.client.get=()=>gate.promise
  const pending=f.request.get('/doc/1/metadata');nextAccount(f);gate.reject({code:401,message:'A error'})
  await assert.rejects(pending,e=>e.reason==='PAGE_SESSION_CHANGED'&&e.uncertain)
  assert.equal(f.state.identity.token,'token-B')
})

test('API适配器拒绝显式空身份、伪造的原令牌及不同服务，不降级到当前账号', () => {
  const f=fixture(), original=f.session.identity
  for(const config of [{expectedIdentity:null},{expectedIdentity:{...original,account:'B'}},{copageExpectedSessionToken:'token-B'}])
    assert.throws(()=>bindRequestIdentity(config,f.read),e=>e.code===400)
  f.state.identity={...f.state.identity,service:'https://other.invalid/api'}
  assert.throws(()=>bindRequestIdentity({expectedIdentity:original},f.read),e=>e.code===400)
})

test('同账号换令牌或存储不可读也不续接旧页面；初始缺失身份不能日后补绑', async () => {
  const f=fixture();f.state.identity={...f.state.identity,token:'rotated-A'}
  await assert.rejects(f.request.get('/doc/1'),e=>e.code===400)
  f.state.unreadable=true
  await assert.rejects(f.request.post('/doc'),e=>e.code===400)
  let identity=null
  const missing=createPageSession(()=>identity)
  identity={account:'B',token:'token-B',service:'/api'}
  assert.equal(missing.identity,null); assert.throws(()=>missing.options(),e=>e.code===400)
  assert.equal(f.calls.length,0)
})

test('取消不发送，传输层同步抛错仍遵守Promise契约，原服务拒绝不改写', async () => {
  const f=fixture(),controller=new AbortController();controller.abort()
  await assert.rejects(f.request.get('/doc/1',{signal:controller.signal}),e=>e.name==='AbortError')
  assert.equal(f.calls.length,0)
  const rejection={code:403,message:'permission denied'};f.client.put=()=>{throw rejection}
  let pending;assert.doesNotThrow(()=>{pending=f.request.put('/doc/1',{})})
  await assert.rejects(pending,e=>e===rejection)
})

test('存储读取只取账号和令牌，不扫描正文或草稿', () => {
  const keys=[]
  assert.deepEqual(readPageIdentity({getItem:key=>{keys.push(key);return key==='collab-user'?'A':'token-A'}},'/api'),{account:'A',token:'token-A',service:'/api'})
  assert.deepEqual(keys,['collab-user','collab-token'])
  assert.equal(readPageIdentity({getItem:()=>{throw Error('blocked')}},'/api'),null)
})
