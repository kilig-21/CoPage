const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// Validate a complete stored document without importing, normalizing or limiting it.
// Legacy scalar attributes, original fragments and image addresses stay untouched.
export function isDocumentSnapshotContent(content) {
  if (!record(content) || !Array.isArray(content.ops) || !content.ops.length) return false
  for (const op of content.ops) {
    if (!record(op) || !Object.hasOwn(op, 'insert') ||
        Object.keys(op).some(key => !['insert', 'attributes'].includes(key))) return false
    if (typeof op.insert === 'string') {
      if (!op.insert.length) return false
    } else if (!record(op.insert) || Object.keys(op.insert).length !== 1 ||
        typeof op.insert.image !== 'string' || !op.insert.image.length) return false
    if (Object.hasOwn(op, 'attributes') && (!record(op.attributes) ||
        Object.values(op.attributes).some(value => value !== null &&
          !['string', 'boolean'].includes(typeof value) && !(typeof value === 'number' && Number.isFinite(value))))) return false
  }
  const last = content.ops.at(-1).insert
  return typeof last === 'string' && last.endsWith('\n')
}
