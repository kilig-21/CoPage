import test from 'node:test'
import assert from 'node:assert/strict'
import Delta from 'quill-delta'
import { createDocumentImages, documentImages } from './documentImages.js'

const url = 'https://example.com/image.png'
function editor(content = new Delta().insert('正文😀').insert({ image: url }, { width: '64', alt: '原说明' }).insert('\n')) {
  let current = content, editable = true, state, controller
  const changes = []
  const quill = {
    getContents: () => current,
    getModule: () => ({ cutoff() {} }),
    updateContents: (operation, source) => { current = current.compose(operation); changes.push({ operation, source }); controller.changed(operation) },
  }
  controller = createDocumentImages(quill, { Delta, canEdit: () => editable, onState: next => { state = next } })
  controller.start()
  return { controller, quill, changes, get state() { return state }, get content() { return current }, setEditable(value) { editable = value; controller.refreshStatus() } }
}

test('图片列表保留UTF-16索引与逐张说明，同URL也逐张区分', () => {
  const content = new Delta().insert('😀甲').insert({ image: url }, { alt: '一' }).insert({ image: url }).insert('\n')
  assert.deepEqual(documentImages(content), [{ index: 3, src: url, alt: '一' }, { index: 4, src: url, alt: '' }])
  const e = editor(content)
  assert.notEqual(e.state.images[0].id, e.state.images[1].id)
})

test('说明作为普通用户格式操作保存，其他文字、图片和尺寸保持', () => {
  const e = editor(), image = e.state.images[0]
  assert.equal(e.controller.save(image.id, '新说明😀', image.alt).changed, true)
  assert.deepEqual(e.changes[0].operation.ops, [{ retain: 4 }, { retain: 1, attributes: { alt: '新说明😀' } }])
  assert.equal(e.changes[0].source, 'user')
  assert.deepEqual(e.content.ops, new Delta().insert('正文😀').insert({ image: url }, { width: '64', alt: '新说明😀' }).insert('\n').ops)
})

test('相同说明不提交，明确留空仅移除alt而保留原图片', () => {
  const e = editor(), image = e.state.images[0]
  assert.equal(e.controller.save(image.id, '原说明', image.alt).changed, false)
  assert.equal(e.changes.length, 0)
  e.controller.save(image.id, '', image.alt)
  assert.deepEqual(e.content.ops[1], { insert: { image: url }, attributes: { width: '64' } })
})

test('同伴在图片前输入时保持图片身份并变换提交索引', () => {
  const e = editor(), image = e.state.images[0]
  e.quill.updateContents(new Delta().retain(4).insert('前插'), 'api')
  assert.equal(e.state.images[0].id, image.id)
  e.controller.save(image.id, '跟随图片', image.alt)
  assert.equal(e.changes[1].operation.ops[0].retain, 6)
})

test('删除后同位置同URL替换不接受旧图片表单，不能误改新图片', () => {
  const e = editor(), image = e.state.images[0]
  e.quill.updateContents(new Delta().retain(4).delete(1).insert({ image: url }, { alt: '替换图片' }), 'api')
  assert.notEqual(e.state.images[0].id, image.id)
  assert.throws(() => e.controller.save(image.id, '错误覆盖', image.alt), /移除或替换/)
  assert.equal(e.content.ops[1].attributes.alt, '替换图片')
  assert.equal(e.changes.length, 1)
})

test('相邻相同URL图片的删除不把旧表单指向后一张', () => {
  const e = editor(new Delta().insert({ image: url }).insert({ image: url }, { alt: '第二张' }).insert('\n'))
  const [first, second] = e.state.images
  e.quill.updateContents(new Delta().delete(1), 'api')
  assert.equal(e.state.images[0].id, second.id)
  assert.throws(() => e.controller.save(first.id, '误改', ''), /移除或替换/)
})

test('说明被同伴修改时拒绝旧值覆盖，原输入可用于核对后再次保存', () => {
  const e = editor(), image = e.state.images[0]
  e.quill.updateContents(new Delta().retain(4).retain(1, { alt: '同伴说明' }), 'api')
  assert.throws(() => e.controller.save(image.id, '我的输入', image.alt), /说明已被修改/)
  assert.equal(e.changes.length, 1)
  e.controller.save(image.id, '核对后的说明', '同伴说明')
  assert.equal(e.content.ops[1].attributes.alt, '核对后的说明')
})

test('降权、断线或未保存状态在动作时拒绝，不把已显示的编辑入口当授权', () => {
  const e = editor(), image = e.state.images[0]
  e.setEditable(false)
  assert.equal(e.state.canEdit, false)
  assert.throws(() => e.controller.save(image.id, '越权', image.alt), /恢复编辑权限/)
  assert.equal(e.changes.length, 0)
  e.setEditable(true)
  e.controller.save(image.id, '正常', image.alt)
  assert.equal(e.changes.length, 1)
})

test('长度和控制字符按既有后端边界拒绝，不静默截断用户输入', () => {
  const e = editor(), image = e.state.images[0]
  for (const text of ['x'.repeat(513), '😀'.repeat(257), '换\n行', '\0', '\u007f']) {
    assert.throws(() => e.controller.save(image.id, text, image.alt), /512个字符/)
  }
  assert.equal(e.changes.length, 0)
  e.controller.save(image.id, '😀'.repeat(256), image.alt)
  assert.equal(e.content.ops[1].attributes.alt.length, 512)
})

test('暂停或销毁旧窗口后不提交，重开不能复用原图片身份', () => {
  const e = editor(), old = e.state.images[0]
  e.controller.pause()
  assert.throws(() => e.controller.save(old.id, '迟到', old.alt))
  e.controller.start()
  assert.notEqual(e.state.images[0].id, old.id)
  assert.throws(() => e.controller.save(old.id, '迟到', old.alt), /移除或替换/)
  e.controller.dispose()
  assert.throws(() => e.controller.save(e.state.images[0].id, '迟到', old.alt))
  assert.equal(e.changes.length, 0)
})

test('图片说明也受完整正文容量限制，拒绝时不截断正文或说明', () => {
  const base = new Delta().insert('x').insert({ image: url }, { alt: '原说明' }).insert('\n')
  const size = value => new TextEncoder().encode(JSON.stringify(value)).byteLength
  const content = new Delta().insert('x'.repeat(2 * 1024 * 1024 - size(base)))
    .insert({ image: url }, { alt: '原说明' }).insert('\n')
  assert.ok(size(content) <= 2 * 1024 * 1024)
  const e = editor(content), image = e.state.images[0]
  assert.throws(() => e.controller.save(image.id, 'x'.repeat(512), image.alt), /超过 2 MiB/)
  assert.equal(e.changes.length, 0)
  assert.deepEqual(e.content, content)
})

test('多图文档前插后保留逐张身份，末张说明不影响相同URL的其他图片', () => {
  const content = new Delta()
  for (let i = 0; i < 3000; i++) content.insert({ image: url })
  content.insert('\n')
  const e = editor(content), ids = e.state.images.map(image => image.id)
  e.quill.updateContents(new Delta().insert('前插'), 'api')
  assert.deepEqual(e.state.images.map(image => image.id), ids)
  e.controller.save(ids.at(-1), '末张说明', '')
  assert.equal(e.state.images.at(-1).index, 3001)
  assert.equal(e.state.images.at(-1).alt, '末张说明')
  assert.ok(e.state.images.slice(0, -1).every(image => image.alt === ''))
})
