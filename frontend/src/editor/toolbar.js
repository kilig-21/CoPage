export const EDITOR_FORMAT_TOOLBAR_ID = 'editor-format-toolbar'

export function configureEditorToolbar(quill) {
  const toolbar = quill.getModule('toolbar').container
  const history = quill.getModule('history')
  toolbar.id = EDITOR_FORMAT_TOOLBAR_ID
  toolbar.setAttribute('aria-label', '正文格式与编辑')
  const labels = {
    undo: ['撤销自己的编辑', '撤销自己的编辑（Ctrl/⌘+Z）'],
    redo: ['重做自己的编辑', '重做自己的编辑（Ctrl/⌘+Shift+Z，Windows也可Ctrl+Y）'],
    bold: ['粗体', '粗体（Ctrl/⌘+B）'],
    italic: ['斜体', '斜体（Ctrl/⌘+I）'],
    underline: ['下划线', '下划线（Ctrl/⌘+U）'],
    strike: ['删除线'],
    blockquote: ['引用'],
    'code-block': ['代码块'],
    link: ['添加或移除链接', '选中文字后添加链接；已有链接可在预览中编辑'],
    image: ['上传图片'],
    clean: ['清除格式'],
  }
  for (const [format, [label, title = label]] of Object.entries(labels)) {
    const button = toolbar.querySelector(`button.ql-${format}`)
    if (!button) continue
    button.setAttribute('aria-label', label)
    button.title = title
    if (format === 'undo' || format === 'redo') button.textContent = format === 'undo' ? '撤销' : '重做'
  }
  for (const button of toolbar.querySelectorAll('button.ql-list')) {
    const label = button.value === 'ordered' ? '有序列表' : '无序列表'
    button.setAttribute('aria-label', label)
    button.title = label
  }
  const headerPicker = toolbar.querySelector('.ql-header.ql-picker')
  const headerLabel = headerPicker?.querySelector('.ql-picker-label')
  if (headerLabel) {
    headerLabel.setAttribute('aria-label', '段落样式')
    headerLabel.title = '段落样式'
    for (const item of headerPicker.querySelectorAll('.ql-picker-item')) {
      const label = item.dataset.value === '1' ? '一级标题' : item.dataset.value === '2' ? '二级标题' : '正文'
      item.dataset.label = label
      item.setAttribute('aria-label', label)
    }
    headerLabel.dataset.label = headerPicker.querySelector('.ql-selected')?.dataset.label ?? '正文'
  }
  const undo = toolbar.querySelector('button.ql-undo')
  const redo = toolbar.querySelector('button.ql-redo')
  const formatButtons = [...toolbar.querySelectorAll('button')].filter(button => button !== undo && button !== redo)
  let wasEditable
  return () => {
    const editable = quill.isEnabled()
    if (editable !== wasEditable) {
      wasEditable = editable
      toolbar.inert = !editable
      for (const button of formatButtons) button.disabled = !editable
    }
    const undoDisabled = !editable || history.stack.undo.length === 0
    const redoDisabled = !editable || history.stack.redo.length === 0
    if (undo.disabled !== undoDisabled) undo.disabled = undoDisabled
    if (redo.disabled !== redoDisabled) redo.disabled = redoDisabled
  }
}
