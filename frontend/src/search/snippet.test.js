import test from 'node:test'
import assert from 'node:assert/strict'
import { searchTitleParts, snippetParts } from './snippet.js'

test('only server strong markers become highlights, document HTML remains text', () => {
  assert.deepEqual(snippetParts('&lt;img src=x onerror=alert(1)&gt; <strong>需求</strong> &lt;strong&gt;原文&lt;/strong&gt;'), [
    { text: '<img src=x onerror=alert(1)> ', highlighted: false },
    { text: '需求', highlighted: true },
    { text: ' <strong>原文</strong>', highlighted: false },
  ])
  assert.deepEqual(snippetParts('<script>alert(1)</script>'), [{ text: '<script>alert(1)</script>', highlighted: false }])
})

test('entities are decoded once and empty snippets are supported', () => {
  assert.deepEqual(snippetParts('&amp;lt; &quot; &#39; &amp;'), [{ text: '&lt; " \' &', highlighted: false }])
  assert.deepEqual(snippetParts(), [])
})

test('search titles highlight literal punctuation and keep original case', () => {
  assert.deepEqual(searchTitleParts('场地 [Audit+1] 初稿', '[audit+1]'), [
    { text: '场地 ', highlighted: false },
    { text: '[Audit+1]', highlighted: true },
    { text: ' 初稿', highlighted: false },
  ])
  assert.deepEqual(searchTitleParts('活动方案', '报名'), [{ text: '活动方案', highlighted: false }])
  assert.deepEqual(searchTitleParts('活动方案', ''), [{ text: '活动方案', highlighted: false }])
})

test('long search titles place the literal hit after the start of the title', () => {
  const prefix = '😀'.repeat(30)
  assert.deepEqual(searchTitleParts(prefix + ' 活动报名初稿', '活动报名'), [
    { text: '😀'.repeat(18) + '… ', highlighted: false },
    { text: '活动报名', highlighted: true },
    { text: '初稿', highlighted: false },
  ])
})
