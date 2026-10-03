import test from 'node:test'
import assert from 'node:assert/strict'
import { snippetParts } from './snippet.js'

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
