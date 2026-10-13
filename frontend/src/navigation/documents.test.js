import test from 'node:test'
import assert from 'node:assert/strict'
import { documentHref, documentReturn } from './documents.js'
import { safeReturnPath } from '../auth/session.js'

test('打开文档、刷新与登录返回保留来源的中文关键词、分页和锚点', () => {
  for (const from of ['/docs?scope=shared&keyword=中文%26%25&page=2#list',
    '/search?q=会议%2B计划&page=2', '/projects?scope=group&groupId=3&project=8&docKeyword=资料&docPage=2',
    '/home', '/trash?page=2', '/templates?category=planning&keyword=需求']) {
    const href = documentHref(26, from)
    assert.equal(safeReturnPath(href), href)
    assert.equal(documentReturn(href.slice(href.indexOf('?'))).path, from)
  }
})

test('返回入口说明真实来源，私人模板与内置模板区分', () => {
  const labels = {
    '/home': '返回工作台', '/docs?scope=owned': '返回文档列表', '/search?q=资料': '返回搜索结果',
    '/projects?project=8': '返回项目', '/templates': '返回模板中心',
    '/templates?source=personal&category=learning': '返回我的模板',
    '/trash': '返回回收站',
  }
  for (const [from, label] of Object.entries(labels)) {
    const href = documentHref(26, from)
    assert.deepEqual(documentReturn(href.slice(href.indexOf('?'))), { path: from, label })
  }
})

test('伪造的外部、协议相对、登录、编辑器、控制字符与超长来源退回文档列表', () => {
  for (const from of ['https://example.com', '//example.com', '/\\example.com', 'javascript:alert(1)',
    '/docs/27', '/login', '/projects/8', '/docs\n?keyword=a', '/docs?keyword=' + 'a'.repeat(4096),
    '/%64ocs', null, undefined]) {
    assert.equal(documentHref(26, from), '/docs/26')
    assert.deepEqual(documentReturn('?' + new URLSearchParams({ returnTo: from })),
      { path: '/docs', label: '返回文档列表' })
  }
})

test('直接分享地址及重复返回参数使用确定的安全默认入口，不二次解码地址', () => {
  const fallback = { path: '/docs', label: '返回文档列表' }
  assert.deepEqual(documentReturn(''), fallback)
  assert.deepEqual(documentReturn('?returnTo=%2Fhome&returnTo=%2Fprojects'), fallback)
  assert.deepEqual(documentReturn('?returnTo=%252Fhome'), fallback)
  assert.deepEqual(documentReturn('?returnTo=%2F%2Fexample.com'), fallback)
})

test('恢复文档打开及重登后返回回收站，完整保留200字标题查找和页码', () => {
  for (const keyword of ['周报 中文😀 %_&+?#', '中文'.repeat(100)]) {
    const from='/trash?'+new URLSearchParams({keyword,page:'12'})+'#list'
    const href=documentHref(41,from)
    assert.equal(safeReturnPath(href),href)
    const returned=documentReturn(href.slice(href.indexOf('?')))
    assert.deepEqual(returned,{path:from,label:'返回回收站'})
    const params=new URLSearchParams(returned.path.split('?')[1].split('#')[0])
    assert.equal(params.get('keyword'),keyword)
    assert.equal(params.get('page'),'12')
  }
})
