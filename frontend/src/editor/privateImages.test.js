import assert from 'node:assert/strict'
import test from 'node:test'
import { IMAGE_PENDING, IMAGE_REFERENCE, privateImagePath, registerPrivateImageBlot } from './privateImages.js'

const key = 'images/2026/11/11111111-1111-1111-1111-111111111111.png'
const savedReference = 'https://images.example.invalid/collab/' + key

test('private image references map to an authenticated relative API path', () => {
  assert.equal(privateImagePath(savedReference), '/' + key)
  for (const reference of [
    'blob:https://frontend.example.invalid/' + key,
    'https://images.example.invalid/' + key,
    savedReference + '?untrusted=1',
    savedReference + '#untrusted',
    savedReference.replace('https://', 'https://user@'),
    savedReference.replace('/11/', '/19/'),
    savedReference.replace('/11/', '/11%2Fanother/'),
    'https://another.example.invalid/cover.png',
  ]) assert.equal(privateImagePath(reference), null)
})

test('private Quill embeds retain the saved URL when their image source is replaced by a blob', () => {
  class BaseImage {
    static create(src) {
      const attributes = new Map()
      return { src, setAttribute: (key, value) => attributes.set(key, value), getAttribute: key => attributes.get(key) ?? null }
    }
    static value(node) { return node.src }
  }
  let Image
  const quill = {
    import: () => BaseImage,
    register(path, definition) {
      assert.equal(path, 'formats/image')
      Image = definition
    },
  }
  registerPrivateImageBlot(quill)
  const node = Image.create(savedReference)
  assert.equal(node.src, undefined)
  assert.equal(node.getAttribute(IMAGE_REFERENCE), savedReference)
  assert.equal(node.getAttribute(IMAGE_PENDING), '')
  node.src = 'blob:https://frontend.example.invalid/preview'
  assert.equal(Image.value(node), savedReference)
  const external = 'https://another.example.invalid/cover.png'
  assert.equal(Image.value(Image.create(external)), external)
})
