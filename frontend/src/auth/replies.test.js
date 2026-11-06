import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLoginReply as login, confirmRegistrationReply as register, confirmPasswordChangeReply as password } from './replies.js'
import { parseAccountProfileReply } from './accountProfile.js'
import { saveSession } from './session.js'

const user={id:4,username:'Canonical-User',nickname:null,avatar:null}
test('complete login preserves the server canonical name and opaque token',()=>{
  assert.deepEqual(login({code:0,data:{token:'original-token',user}}),{token:'original-token',user})
})
test('bad login replies cannot reach session replacement or touch drafts',()=>{
  const values=new Map([['collab-token','original'],['collab-user','original-user'],['draft:original','keep'],['draft:other','keep-other']]),before=new Map(values)
  const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}
  for(const reply of [null,[],{}, {code:500,data:{token:'new',user}}, {code:'0',data:{token:'new',user}},
    {code:0,data:{token:'',user}},{code:0,data:{token:'new',user:{...user,id:0}}},
    {code:0,data:{token:'new',user:{...user,username:''}}},{code:0,data:{token:'new'}}]) {
    assert.throws(()=>{const verified=login(reply);saveSession(storage,{token:verified.token,username:verified.user.username})},{reason:'LOGIN_RESPONSE'})
    assert.deepEqual(values,before)
  }
})
test('registration requires an actual account reply before reporting success',()=>{
  assert.deepEqual(register({code:0,data:user}),user)
  for(const r of [null,{}, {code:500,data:user},{code:0,data:null},{code:0,data:{...user,id:'4'}}])assert.throws(()=>register(r),{reason:'REGISTRATION_RESPONSE'})
})
test('password changes require complete business acknowledgement',()=>{
  assert.doesNotThrow(()=>password({code:0,data:null}))
  for(const r of [null,{}, {code:0},{code:'0',data:null},{code:500,data:null},{code:0,data:{}},{code:0,data:[]}])assert.throws(()=>password(r),{reason:'ACCOUNT_PASSWORD_RESPONSE'})
})
test('account reads and nickname confirmation reject failed envelopes even with valid profile data',()=>{
  assert.deepEqual(parseAccountProfileReply({code:0,data:user}),user)
  for(const reply of [{data:user},{code:500,data:user},{code:'0',data:user}])assert.throws(()=>parseAccountProfileReply(reply),{reason:'ACCOUNT_PROFILE_RESPONSE'})
  assert.throws(()=>parseAccountProfileReply({code:0,data:{...user,id:5}},{expectedProfile:user}),{reason:'ACCOUNT_PROFILE_RESPONSE'})
})
