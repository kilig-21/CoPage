export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/gif,image/webp'
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

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
