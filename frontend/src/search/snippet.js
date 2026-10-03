// 后端只允许自己生成的 strong 标记；其余内容一律以 React 文本渲染。
export function snippetParts(snippet = '') {
  let highlighted = false
  const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }
  return String(snippet).split(/(<strong>|<\/strong>)/).flatMap((text) => {
    if (text === '<strong>') { highlighted = true; return [] }
    if (text === '</strong>') { highlighted = false; return [] }
    return text ? [{ text: text.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, (entity) => entities[entity]), highlighted }] : []
  })
}
