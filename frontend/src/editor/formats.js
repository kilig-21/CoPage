// 仅列出已注册的Quill格式；图片的alt/width/height由image本身处理。
// 与后端文档范围保持一致，禁用video/formula等未交付的嵌入类型。
export const DOCUMENT_FORMATS = [
  'bold', 'italic', 'underline', 'strike', 'blockquote', 'code', 'code-block', 'header',
  'list', 'indent', 'align', 'direction', 'font', 'size', 'color', 'background', 'link', 'script', 'image',
]
