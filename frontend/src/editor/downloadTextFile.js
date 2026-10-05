export function downloadTextFile(content, filename, type) {
  const link = document.createElement('a')
  const url = URL.createObjectURL(new Blob([content], { type }))
  try {
    link.href = url
    link.download = filename
    document.body.append(link)
    link.click()
  } finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
