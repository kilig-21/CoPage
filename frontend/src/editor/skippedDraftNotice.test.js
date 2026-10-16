import test from 'node:test'
import assert from 'node:assert/strict'
import { createSkippedDraftNotice } from './skippedDraftNotice.js'

const first = 'copage-draft:v1:owner:26:first'
const second = 'copage-draft:v1:owner:26:second'
function fixture(entries = []) {
  const values = new Map(entries), reads = [], changes = [], listeners = new Set()
  let unreadable = false
  const storage = { getItem(key) { reads.push(key); if (unreadable) throw Error('storage denied'); return values.get(key) ?? null },
    setItem: () => assert.fail('提示不能写入草稿'), removeItem: () => assert.fail('提示不能删除草稿') }
  const eventTarget = {
    addEventListener(type, handler) { assert.equal(type, 'storage'); listeners.add(handler) },
    removeEventListener(type, handler) { assert.equal(type, 'storage'); listeners.delete(handler) },
  }
  const notice = createSkippedDraftNotice({ storage, eventTarget, onChange: value => changes.push(value) })
  const event = (key, extra = {}) => { for (const handler of [...listeners]) handler({ storageArea: storage, key, ...extra }) }
  return { values, reads, changes, listeners, storage, notice, event, unreadable: value => { unreadable = value } }
}

test('初始不发布空提示，探测期间已移除的候选不会闪现', () => {
  const f = fixture()
  assert.deepEqual(f.changes, [])
  f.notice.track(first)
  assert.deepEqual(f.changes, []); assert.deepEqual(f.reads, [first])
})

test('精确候选仍在才显示，ACK移除后重新读取才清；重复track不重复发布', () => {
  const f = fixture([[first, '原草稿']])
  f.notice.track(first); f.notice.track(first)
  assert.deepEqual(f.changes, [true]); assert.equal(f.values.get(first), '原草稿')
  f.values.delete(first); f.event(first)
  assert.deepEqual(f.changes, [true, false]); assert.ok(f.reads.every(key => key === first))
})

test('多个已跳过槽位须全部真实null才清，不因一个标签ACK忽略另一份', () => {
  const f = fixture([[first, '草稿1'], [second, '草稿2']])
  f.notice.track(first); f.notice.track(second)
  f.values.delete(first); f.event(first)
  assert.deepEqual(f.changes, [true])
  f.values.delete(second); f.event(second)
  assert.deepEqual(f.changes, [true, false])
})

test('忽略无关键、当前标签自己的槽及sessionStorage事件，不读取其它候选正文', () => {
  const f = fixture([[first, '原草稿']])
  f.notice.track(first)
  const count = f.reads.length
  f.values.delete(first)
  f.event('copage-draft:v1:owner:26:current')
  f.event('copage-draft:v1:other:26:first')
  f.event('collab-token')
  f.event(first, { storageArea: {} })
  f.event(null, { storageArea: {} })
  assert.equal(f.reads.length, count); assert.deepEqual(f.changes, [true])
  f.event(first)
  assert.deepEqual(f.changes, [true, false])
})

test('clear事件仍重读精确集合，排队旧newValue不决定草稿是否存在', () => {
  const f = fixture([[first, '当前仍有草稿']])
  f.notice.track(first)
  f.event(first, { newValue: null })
  f.event(null)
  assert.deepEqual(f.changes, [true])
  f.values.delete(first)
  f.event(first, { newValue: '排队中的旧内容' })
  assert.deepEqual(f.changes, [true, false])
  f.values.set(first, '当前又存在')
  f.event(null)
  assert.deepEqual(f.changes, [true, false, true]); assert.ok(f.reads.every(key => key === first))
})

test('初次或后续读取异常都保留未核对提示，不把不可读当作草稿已消失', () => {
  const f = fixture()
  f.unreadable(true); f.notice.track(first)
  assert.deepEqual(f.changes, [true])
  f.event(first); f.event(null)
  assert.deepEqual(f.changes, [true])
  f.unreadable(false); f.event(first)
  assert.deepEqual(f.changes, [true, false])
  f.values.set(first, '原草稿'); f.event(first)
  f.unreadable(true); f.values.delete(first); f.event(first)
  assert.deepEqual(f.changes, [true, false, true])
  f.unreadable(false); f.event(null)
  assert.deepEqual(f.changes, [true, false, true, false])
})

test('dismiss仅隐藏不写删，随后旧事件、重新track或clear都不重新弹起', () => {
  const f = fixture([[first, '必须保留'], [second, '另一份']])
  f.notice.track(first); f.notice.dismiss(); f.notice.dismiss()
  assert.deepEqual(f.changes, [true, false]); assert.equal(f.values.get(first), '必须保留')
  const count = f.reads.length
  f.event(first); f.event(null); f.notice.track(second)
  assert.equal(f.reads.length, count); assert.deepEqual(f.changes, [true, false])
  assert.deepEqual([...f.values], [[first, '必须保留'], [second, '另一份']])
})

test('dispose移除监听且不发清空回调，已排队旧handler与后续操作无ghost callback', () => {
  const f = fixture([[first, '原草稿']])
  f.notice.track(first)
  const queued = [...f.listeners][0], count = f.reads.length
  f.notice.dispose(); f.notice.dispose()
  assert.equal(f.listeners.size, 0); assert.deepEqual(f.changes, [true])
  f.values.delete(first)
  queued({ storageArea: f.storage, key: first })
  f.event(first); f.notice.track(second); f.notice.dismiss()
  assert.equal(f.reads.length, count); assert.deepEqual(f.changes, [true])
})

test('同步读取期间scope被dispose，不得把结果发回已离开的页面', () => {
  const changes = [], handlers = new Set(); let notice
  const storage = { getItem: () => { notice.dispose(); return '原草稿' } }
  notice = createSkippedDraftNotice({ storage, eventTarget: {
    addEventListener: (_, handler) => handlers.add(handler), removeEventListener: (_, handler) => handlers.delete(handler),
  }, onChange: value => changes.push(value) })
  notice.track(first)
  assert.deepEqual(changes, []); assert.equal(handlers.size, 0)
})
