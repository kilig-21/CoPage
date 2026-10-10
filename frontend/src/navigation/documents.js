const sources = {
  '/docs': '返回文档列表',
  '/home': '返回工作台',
  '/search': '返回搜索结果',
  '/projects': '返回项目',
  '/templates': '返回模板中心',
  '/trash': '返回回收站',
}

// 返回来源只用于站内导航，不能指向外部地址、另一篇编辑器或登录页面。
function sourcePath(path) {
  if (typeof path !== 'string' || path.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(path)) return null
  const route = path.split(/[?#]/, 1)[0]
  return Object.hasOwn(sources, route) ? { path, label: route === '/templates' &&
    new URLSearchParams(path.split('?')[1]?.split('#')[0]).get('source') === 'personal'
    ? '返回我的模板' : sources[route] } : null
}

export function documentHref(docId, from) {
  const source = sourcePath(from)
  return '/docs/' + docId + (source ? '?' + new URLSearchParams({ returnTo: source.path }).toString() : '')
}

export function documentReturn(search) {
  const values = new URLSearchParams(search).getAll('returnTo')
  return (values.length === 1 ? sourcePath(values[0]) : null) || { path: '/docs', label: sources['/docs'] }
}
