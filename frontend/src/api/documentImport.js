const failure = (reason, message, uncertain = false, code) => Object.assign(new Error(message), { reason, uncertain, code })
const abort = uncertain => Object.assign(new DOMException('导入来源页面或账号已变化', 'AbortError'), { uncertain })
const validIdentity = value => value && ['account', 'token', 'service'].every(key => typeof value[key] === 'string' && value[key])

// 仅保留当前弹窗的原文件引用，不把文件或正文写入浏览器持久存储。
export function createDocumentImporter({ create, readIdentity, isCurrent = () => true }) {
  let identity = null
  try {
    const value = readIdentity()
    if (validIdentity(value)) identity = Object.freeze({ account: value.account, token: value.token, service: value.service })
  } catch { /* 打开时无法绑定身份的窗口不能发送导入。 */ }
  let status = 'idle', original = null, confirmed = null, inFlight = false, uncertain = false
  function current(signal) {
    try {
      if (!identity || signal?.aborted || isCurrent() !== true) return false
      const value = readIdentity()
      return validIdentity(value) && ['account', 'token', 'service'].every(key => value[key] === identity[key])
    } catch { return false }
  }
  function getSnapshot() {
    return { status, filename: original?.filename ?? '', title: original?.title ?? '' }
  }
  async function submit(input, { signal } = {}) {
    if (!current(signal)) throw abort(uncertain)
    if (status === 'confirmed') return confirmed
    if (inFlight) throw failure('DOCUMENT_IMPORT_BUSY', '正在导入，请等待原请求。', uncertain)
    if (!original) {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).length !== 2 || !Object.hasOwn(input, 'file') || !Object.hasOwn(input, 'title') ||
          !(input.file instanceof Blob) || typeof input.file.name !== 'string' || !/\.(txt|json)$/i.test(input.file.name) ||
          input.file.size <= 0 || input.file.size > 3 * 1024 * 1024 ||
          typeof input.title !== 'string' || input.title.length > 200) {
        throw failure('DOCUMENT_IMPORT_INPUT', '请选择不超过 3 MiB 的非空 .txt 或 CoPage .json 文件，并核对标题；尚未发送请求。', false, 400)
      }
      original = Object.freeze({ file: input.file, filename: input.file.name, title: input.title.trim() })
    }
    const body = new FormData()
    body.append('file', original.file, original.filename)
    if (original.title) body.append('title', original.title)
    // 未知后的输入一律忽略，只确认已冻结的原文件和实际发送标题。
    if (!current(signal)) {
      if (!uncertain) original = null
      throw abort(uncertain)
    }
    inFlight = true; status = 'importing'
    try {
      // 重建窗口也可能重选了已有未确认槽；委托层依据实际原槽识别，而非只看本窗口状态。
      const result = await create('/doc/import', body, { signal, copageExpectedSessionToken: identity.token,
        preserveRejectedTracking: true })
      if (!current(signal)) throw abort(true)
      if (!Number.isSafeInteger(result?.data?.id) || result.data.id <= 0) {
        throw failure('DOCUMENT_IMPORT_RESPONSE', '导入结果无法确认，请确认原导入或核对文档列表。', true)
      }
      confirmed = Object.freeze({ ...result, data: Object.freeze({ ...result.data }) })
      status = 'confirmed'; uncertain = false
      return confirmed
    } catch (error) {
      const active = current(signal)
      uncertain = uncertain || !active || error?.uncertain === true || ![400, 403, 404].includes(error?.code)
      status = uncertain ? 'uncertain' : 'idle'
      if (!uncertain) original = null
      if (!active) throw abort(uncertain)
      throw failure(error?.reason || 'DOCUMENT_IMPORT_REQUEST', error?.message || '导入结果未确认，请确认原导入或核对文档列表。', uncertain, error?.code)
    } finally { inFlight = false }
  }
  return { submit, getSnapshot }
}
