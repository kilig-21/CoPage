import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'

const backend = process.env.COPAGE_E2E_BACKEND_ORIGIN
const fresh = () => randomBytes(6).toString('hex')
const editor = page => page.getByRole('textbox', { name: '文档正文' })
const saved = page => page.locator('.editor-save-status')
const title = page => page.getByRole('heading', { level: 1 })

async function createAccount(request) {
  const username = 'e2e' + fresh()
  const password = `CopageFixture-${randomBytes(20).toString('hex')}-Aa9!`
  const reply = await request.post(`${backend}/api/auth/register`, { data: { username, password, nickname: username } })
  expect(reply.status()).toBe(200)
  expect((await reply.json()).code).toBe(0)
  return { username, password }
}

async function login(page, { username, password }) {
  await page.goto('/login')
  await page.getByLabel('用户名').fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: /^登\s*录$/ }).click()
  await expect(page).toHaveURL(/\/home$/)
  await expect(page.getByRole('navigation', { name: '应用导航' })).toBeVisible()
}

async function createDocument(page) {
  await page.getByRole('link', { name: '我的文档' }).click()
  await page.getByRole('button', { name: /新建文档$/ }).click()
  await expect(page).toHaveURL(/\/docs\/\d+(\?|$)/)
  const id = Number(new URL(page.url()).pathname.split('/').at(-1))
  expect(Number.isSafeInteger(id) && id > 0 && ![26, 536, 548].includes(id)).toBe(true)
  await expect(saved(page)).toHaveText('所有修改已保存')
  return id
}

async function tool(page, label) {
  await page.getByRole('button', { name: '更多文档操作' }).click()
  await page.getByRole('menuitem', { name: label, exact: true }).click()
}

async function rename(page, nextTitle) {
  await tool(page, '重命名')
  const dialog = page.getByRole('dialog', { name: '重命名文档' })
  await dialog.getByRole('textbox', { name: '文档标题' }).fill(nextTitle)
  await dialog.getByRole('button', { name: /^确\s*定$/ }).click()
  await expect(dialog).toBeHidden()
  await expect(title(page)).toHaveText(nextTitle)
}

async function append(page, text, { acknowledge = true } = {}) {
  await editor(page).click()
  await page.keyboard.press('End')
  await page.keyboard.insertText(text)
  await expect(editor(page)).toContainText(text.trim())
  if (acknowledge) await expect(saved(page)).toHaveText('所有修改已保存')
}

async function grantEditor(page, request, documentId, username) {
  const token = await page.evaluate(() => localStorage.getItem('collab-token'))
  const reply = await request.post(`${backend}/api/doc/${documentId}/collaborators`, {
    headers: { Authorization: `Bearer ${token}` }, data: { username, permission: 2 },
  })
  expect(reply.status()).toBe(200)
  expect((await reply.json()).code).toBe(0)
}

test('login, logout, and protected route redirect', async ({ page, request }) => {
  await login(page, await createAccount(request))
  await page.getByRole('button', { name: '退出账号' }).click()
  await expect(page).toHaveURL(/\/login(?:\?|$)/)
  await page.goto('/docs')
  await expect(page).toHaveURL(/\/login(?:\?|$)/)
})

test('create, approximate composition in Quill, and reload the saved document', async ({ page, request }) => {
  await login(page, await createAccount(request))
  await createDocument(page)
  await append(page, 'Saved text ')
  await editor(page).evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
    document.execCommand('insertText', false, '中文组合输入样例')
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文组合输入样例' }))
  })
  await expect(editor(page)).toContainText('中文组合输入样例')
  await expect(saved(page)).toHaveText('所有修改已保存')
  await page.reload()
  await expect(saved(page)).toHaveText('所有修改已保存')
  await expect(editor(page)).toContainText('Saved text 中文组合输入样例')
})

test('two accounts converge and recover a draft after losing the connection', async ({ page, browser, context, request }) => {
  const owner = await createAccount(request)
  const member = await createAccount(request)
  let holdOperation = false, held = 0
  await page.routeWebSocket('**/ws/collab', downstream => {
    const upstream = downstream.connectToServer()
    downstream.onMessage(message => {
      if (holdOperation && typeof message === 'string' && JSON.parse(message).type === 'op') held++
      else upstream.send(message)
    })
  })
  await login(page, owner)
  const docId = await createDocument(page)
  await grantEditor(page, request, docId, member.username)
  const peerContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const peer = await peerContext.newPage()
    await login(peer, member)
    await peer.goto(`/docs/${docId}`)
    await expect(saved(peer)).toHaveText('所有修改已保存')
    await append(page, 'Owner edit ')
    await expect(editor(peer)).toHaveText('Owner edit')
    await append(peer, 'Member edit ')
    await expect(editor(page)).toHaveText('Owner edit Member edit')

    holdOperation = true
    await append(page, 'Recovered edit', { acknowledge: false })
    await expect.poll(() => held).toBeGreaterThan(0)
    await context.setOffline(true)
    await expect(saved(page)).toHaveText('有修改尚未同步')
    page.on('dialog', dialog => dialog.accept())
    const closed = page.waitForEvent('close')
    await page.close({ runBeforeUnload: true })
    await closed
    await context.setOffline(false)

    const recovered = await context.newPage()
    await recovered.goto(`/docs/${docId}`)
    const choice = recovered.getByRole('dialog', { name: '发现未确认的本地编辑' })
    await expect(choice).toBeVisible()
    await choice.getByRole('button', { name: '恢复草稿并同步' }).click()
    await expect(saved(recovered)).toHaveText('所有修改已保存')
    const expected = 'Owner edit Member edit Recovered edit'
    await expect(editor(recovered)).toHaveText(expected)
    await expect(editor(peer)).toHaveText(expected)
  } finally {
    await peerContext.close()
  }
})

test('history preview restores the old text as a new revision', async ({ page, request }) => {
  await login(page, await createAccount(request))
  await createDocument(page)
  await append(page, 'First revision')
  await append(page, ' second revision')
  await tool(page, '历史版本')
  const drawer = page.getByRole('dialog', { name: '历史版本' })
  await drawer.getByRole('button', { name: '查看版本 1', exact: true }).click()
  const preview = drawer.getByRole('region', { name: '版本 1 预览' })
  await expect(preview.getByText('First revision', { exact: true })).toBeVisible()
  await preview.getByRole('button', { name: '恢复此版本' }).click()
  await page.getByRole('button', { name: '确认恢复', exact: true }).click()
  await expect(drawer.getByText(/当前版本：3/)).toBeVisible()
  await drawer.getByRole('button', { name: 'Close' }).click()
  await expect(editor(page)).toHaveText('First revision')
  await page.reload()
  await expect(editor(page)).toHaveText('First revision')
})

test('search returns a saved document from a body-only keyword', async ({ page, request }, testInfo) => {
  await login(page, await createAccount(request))
  await createDocument(page)
  const docTitle = 'Search fixture ' + fresh()
  const marker = 'SearchBody' + fresh()
  await rename(page, docTitle)
  await append(page, marker)
  await page.goto('/search')
  const query = page.getByRole('textbox', { name: '搜索标题和正文' })
  await query.fill(marker)
  const hit = page.getByRole('region', { name: '搜索结果' }).getByRole('link', { name: docTitle })
  await expect(async () => {
    await query.press('Enter')
    await expect(hit).toBeVisible({ timeout: 1_500 })
  }).toPass({ timeout: 30_000, intervals: [500, 1_000, 2_000] })
  await page.screenshot({ path: testInfo.outputPath('search-result.png') })
  await hit.click()
  await expect(editor(page)).toContainText(marker)
})

test('trash removes a document from the list and restores the same document and content', async ({ page, request }) => {
  await login(page, await createAccount(request))
  const docId = await createDocument(page)
  const docTitle = 'Trash fixture ' + fresh()
  await rename(page, docTitle)
  await append(page, 'Recover me from trash')
  await page.getByRole('button', { name: '返回文档列表' }).click()
  const entry = page.getByRole('link', { name: docTitle, exact: true })
  const row = page.locator('.ant-list-item').filter({ has: entry })
  await row.getByRole('button', { name: /^删\s*除$/ }).click()
  await page.getByRole('button', { name: /^确\s*定$/ }).click()
  await expect(entry).toBeHidden()
  await page.getByRole('link', { name: '回收站', exact: true }).click()
  await page.getByRole('button', { name: `恢复文档 #${docId}：${docTitle}` }).click()
  await page.getByRole('button', { name: '确认恢复' }).click()
  await page.getByRole('link', { name: '打开文档' }).click()
  await expect(page).toHaveURL(new RegExp(`/docs/${docId}(\\?|$)`))
  await expect(editor(page)).toHaveText('Recover me from trash')
})

test('print preview, real export download, and import into a separate document', async ({ page, request }, testInfo) => {
  await login(page, await createAccount(request))
  const original = await createDocument(page)
  const marker = 'Exported body ' + fresh()
  await append(page, marker)
  await tool(page, '打印 / PDF')
  const print = page.getByRole('dialog', { name: '打印 / 另存为 PDF' })
  await expect(print.getByRole('article', { name: '打印文档预览' })).toContainText(marker)
  await print.getByRole('button', { name: /^关\s*闭$/ }).click()
  await tool(page, '导出文档')
  const exportDialog = page.getByRole('dialog', { name: '导出文档' })
  const [download] = await Promise.all([
    page.waitForEvent('download'), exportDialog.getByRole('button', { name: '下载副本' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/\.json$/)
  const file = testInfo.outputPath('copage-fixture.json')
  await download.saveAs(file)
  const exported = JSON.parse(await readFile(file, 'utf8'))
  expect(exported).toMatchObject({ format: 'copage', version: 1 })
  expect(JSON.stringify(exported.content)).toContain(marker)
  await exportDialog.getByRole('button', { name: /^关\s*闭$/ }).click()
  await page.getByRole('button', { name: '返回文档列表' }).click()
  await page.getByRole('button', { name: '导入文档' }).click()
  const importDialog = page.getByRole('dialog', { name: '导入为新文档' })
  await importDialog.getByLabel('选择文件').setInputFiles(file)
  const importedTitle = 'Imported fixture ' + fresh()
  await importDialog.getByRole('textbox', { name: '导入文档标题' }).fill(importedTitle)
  await importDialog.getByRole('button', { name: '导入文档' }).click()
  await expect(title(page)).toHaveText(importedTitle)
  expect(new URL(page.url()).pathname).not.toBe(`/docs/${original}`)
  await expect(editor(page)).toHaveText(marker)
})
