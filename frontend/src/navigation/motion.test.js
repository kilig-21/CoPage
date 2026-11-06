import test from 'node:test'
import assert from 'node:assert/strict'
import { previewScrollBehavior } from './motion.js'

test('history preview respects reduced motion and retains normal smooth positioning',()=>{
  const environment={matchMedia:query=>{assert.equal(query,'(prefers-reduced-motion: reduce)');return {matches:true}}}
  assert.equal(previewScrollBehavior(environment),'instant')
  environment.matchMedia=()=>({matches:false})
  assert.equal(previewScrollBehavior(environment),'smooth')
})
test('preference changes are read at each action rather than captured when opening history',()=>{
  let reduced=false
  const environment={matchMedia:()=>({matches:reduced})}
  assert.equal(previewScrollBehavior(environment),'smooth')
  reduced=true
  assert.equal(previewScrollBehavior(environment),'instant')
  reduced=false
  assert.equal(previewScrollBehavior(environment),'smooth')
})
test('unavailable or failed preference queries choose immediate positioning',()=>{
  for(const environment of [{},{matchMedia:()=>undefined},{matchMedia:()=>({})},{matchMedia:()=>{throw Error('unavailable')}}])
    assert.equal(previewScrollBehavior(environment),'instant')
})
