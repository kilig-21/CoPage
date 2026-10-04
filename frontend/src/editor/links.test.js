import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeDocumentLink, normalizePastedLinks } from './links.js'

test('链接补齐常见域名的HTTPS，规范完整网址、中文路径及协议相对地址', () => {
  assert.equal(normalizeDocumentLink(' www.example.com/path?q=1 '), 'https://www.example.com/path?q=1')
  assert.equal(normalizeDocumentLink('//example.com/path'), 'https://example.com/path')
  assert.equal(normalizeDocumentLink('HTTPS://EXAMPLE.COM/笔记'), 'https://example.com/%E7%AC%94%E8%AE%B0')
  assert.equal(normalizeDocumentLink('localhost:5173/docs/1'), 'https://localhost:5173/docs/1')
  assert.equal(normalizeDocumentLink('example.com:8080/docs/1'), 'https://example.com:8080/docs/1')
  assert.equal(normalizeDocumentLink('http://[::1]:8080/doc'), 'http://[::1]:8080/doc')
})

test('邮箱和电话链接保留；清空链接地址可以移除格式', () => {
  assert.equal(normalizeDocumentLink('mailto:reader@example.com'), 'mailto:reader@example.com')
  assert.equal(normalizeDocumentLink('tel:+8613800000000'), 'tel:+8613800000000')
  assert.equal(normalizeDocumentLink('  '), '')
})

test('无效链接先在本地拒绝，不产生无法落库的链接格式', () => {
  for (const link of ['javascript:alert(1)', 'data:text/html,x', 'file:///tmp/a', 'sms:123', '/docs/1',
    '任意说明', 'https://name:password@example.com', 'https://bad_host.example', 'https://example..com',
    'https://example.com\n/path', 'mailto:', 'https://', 'https://example.com:99999']) {
    assert.throws(() => normalizeDocumentLink(link), /有效网址/)
  }
  assert.throws(() => normalizeDocumentLink('https://example.com/' + 'a'.repeat(2048)), /2048/)
  assert.throws(() => normalizeDocumentLink('https://example.com/' + '中'.repeat(300)), /2048/)
})

test('粘贴无效链接只移除链接属性，保留正文、图片和其他格式；有效链接规范化', () => {
  const delta = { ops: [
    { insert: '说明', attributes: { bold: true, link: 'javascript:alert(1)' } },
    { insert: '网址', attributes: { link: 'www.example.com' } },
    { insert: '路径', attributes: { link: '/relative' } },
    { insert: { image: 'https://example.com/p.png' }, attributes: { width: '64', link: 'data:text/html,x' } },
    { insert: '\n' },
  ] }
  const result = normalizePastedLinks(null, delta)
  assert.deepEqual(result.ops, [
    { insert: '说明', attributes: { bold: true } },
    { insert: '网址', attributes: { link: 'https://www.example.com/' } },
    { insert: '路径' },
    { insert: { image: 'https://example.com/p.png' }, attributes: { width: '64' } },
    { insert: '\n' },
  ])
})
