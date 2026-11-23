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

export function searchTitleParts(title, query) {
  if (!query) return [{ text: title, highlighted: false }]
  const literal = query.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')
  const match = new RegExp(literal, 'iu').exec(title)
  if (!match) return [{ text: title, highlighted: false }]
  const prefix = title.slice(0, match.index)
  const prefixCharacters = Array.from(prefix)
  const visiblePrefix = prefixCharacters.length > 22
    ? prefixCharacters.slice(0, 18).join('').trimEnd() + '… '
    : prefix
  return [
    { text: visiblePrefix, highlighted: false },
    { text: match[0], highlighted: true },
    { text: title.slice(match.index + match[0].length), highlighted: false },
  ].filter(part => part.text)
}
