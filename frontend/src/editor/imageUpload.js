export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/gif,image/webp'
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const IMAGE_PLACEHOLDER = 'copage-upload-image:'

export function createImageInsertion(range, count, Delta) {
  const operation = new Delta().retain(range.index).delete(range.length)
  for (let index = 0; index < count; index++) operation.insert({ image: IMAGE_PLACEHOLDER + index })
  return operation
}

export function finishImageInsertion(operation, urls, Delta) {
  let position = 0
  let insertionEnd = 0
  const ops = operation.ops.map(op => {
    if (op.retain) position += op.retain
    if (op.insert?.image?.startsWith(IMAGE_PLACEHOLDER)) {
      const index = Number(op.insert.image.slice(IMAGE_PLACEHOLDER.length))
      if (!urls[index]) throw new Error('图片上传结果不完整，请重新选择文件')
      insertionEnd = ++position
      return { ...op, insert: { image: urls[index] } }
    }
    return op
  })
  return { delta: new Delta(ops), insertionEnd }
}

export function imageValidationError(file) {
  if (!file || file.size === 0) return '请选择非空图片'
  if (!IMAGE_ACCEPT.split(',').includes(file.type)) return '仅支持 JPEG、PNG、GIF、WebP 图片'
  if (file.size > MAX_IMAGE_BYTES) return '图片不能超过 10 MiB'
  return null
}

export async function uploadEditorImage(request, file, signal) {
  const error = imageValidationError(file)
  if (error) throw new Error(error)

  const body = new FormData()
  body.append('file', file)
  const response = await request.post('/upload/image', body, { signal })
  const value = response?.data?.url
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('上传成功但服务器未返回有效图片地址')
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('上传成功但服务器未返回安全的图片地址')
  }
  return url.href
}
