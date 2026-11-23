import { readFile } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
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
  expect(Number.isSafeInteger(id) && id > 0).toBe(true)
  await expect(saved(page)).toHaveText('所有修改已保存')
  return id
}

async function createProject(page, request, name) {
  const token = await page.evaluate(() => localStorage.getItem('collab-token'))
  const reply = await request.post(`${backend}/api/projects`, {
    headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() },
    data: { name, description: '', groupId: 0 },
  })
  expect(reply.status()).toBe(200)
  const project = await reply.json()
  expect(project.code).toBe(0)
  return project.data.id
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
  await expect(page.getByLabel('用户名')).toBeVisible()
  await expect(page.getByRole('group', { name: '本地演示账号' })).toHaveCount(0)
})

test('narrow navigation keeps primary links visible and keyboard access to other pages', async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 850 })
  await login(page, await createAccount(request))
  const navigation = page.getByRole('navigation', { name: '应用导航' })

  for (const route of ['/home', '/search']) {
    await page.goto(route)
    for (const name of ['工作台', '我的文档', '搜索']) {
      await expect(navigation.getByRole('link', { name, exact: true })).toBeInViewport({ ratio: 1 })
    }
  }

  const more = navigation.getByRole('button', { name: '更多页面' })
  await more.press('Enter')
  await page.keyboard.press('Tab')
  await expect(navigation.getByRole('link', { name: '我的小组' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(more).toBeFocused()
  await expect(more).toHaveAttribute('aria-expanded', 'false')

  await more.press('Enter')
  await navigation.getByRole('link', { name: '回收站' }).press('Enter')
  await expect(page).toHaveURL(/\/trash$/)
  await expect(navigation.getByRole('button', { name: '更多页面，当前是回收站' })).toHaveAttribute('aria-expanded', 'false')
})

test('share and collaborator dialogs keep keyboard focus at desktop and narrow widths', async ({ page, request }) => {
  await login(page, await createAccount(request))
  await createDocument(page)

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 850 })
    const shareButton = page.getByRole('button', { name: '分享链接' })
    await shareButton.press('Enter')
    const share = page.getByRole('dialog', { name: '分享文档链接' })
    await share.getByRole('button', { name: '设置协作者权限' }).press('Enter')
    const collaborators = page.getByRole('dialog', { name: /^协作者管理/ })
    await expect(collaborators.getByText('尚未添加协作者')).toBeVisible()
    await collaborators.getByRole('button', { name: '返回分享' }).press('Enter')
    await expect(share).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(share).toBeHidden()
    await expect(shareButton).toBeFocused()

    await shareButton.press('Enter')
    const copy = share.getByRole('button', { name: '复制链接' })
    await expect(copy).toBeFocused()
    await copy.evaluate(button => button.blur())
    await expect(page.locator('body')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(share).toBeHidden()
    await expect(shareButton).toBeFocused()
  }
})

test('adding a collaborator confirms the grant in place and keeps sharing reachable', async ({ page, request }) => {
  await login(page, await createAccount(request))
  const colleague = await createAccount(request)

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 850 })
    await page.goto('/home')
    await createDocument(page)
    await page.getByRole('button', { name: '分享链接', exact: true }).press('Enter')
    await page.getByRole('button', { name: '设置协作者权限', exact: true }).press('Enter')
    const dialog = page.getByRole('dialog', { name: /^协作者管理/ })
    await dialog.getByRole('textbox', { name: '已注册用户名' }).fill(colleague.username)
    const submit = dialog.getByRole('button', { name: '添加协作者' })
    await expect(submit).toBeEnabled()
    await submit.press('Enter')
    const confirmation = dialog.getByRole('status').filter({ hasText: '已添加协作者' })
    await expect(confirmation).toContainText(colleague.username)
    await expect(confirmation).toContainText('本次授予只读')
    await expect(confirmation).toBeFocused()
    await expect(confirmation).toBeInViewport({ ratio: 1 })
    await dialog.getByRole('button', { name: '返回分享' }).press('Enter')
    await expect(page.getByRole('dialog', { name: '分享文档链接' }).getByRole('button', { name: '复制链接' })).toBeFocused()
  }
})

test('login surfaces Chinese messages for bad credentials, offline, timeout, and HTTP errors', async ({ page, context, request }) => {
  const account = await createAccount(request)
  const endpoint = `${backend}/api/auth/login`
  const loginButton = page.getByRole('button', { name: /^登\s*录$/ })
  await page.goto('/login')
  await page.getByLabel('用户名').fill(account.username)
  await page.getByLabel('密码', { exact: true }).fill('Incorrect fixture password')
  await loginButton.click()
  await expect(page.getByText('用户名或密码错误', { exact: true })).toBeVisible()

  await context.setOffline(true)
  try {
    await loginButton.click()
    await expect(page.getByText('无法连接服务，请检查网络后重试。', { exact: true })).toBeVisible()
  } finally {
    await context.setOffline(false)
  }

  await page.route(endpoint, () => { /* Keep the browser request open until Axios times out. */ })
  await loginButton.click()
  await expect(page.getByText('请求超时，请稍后重试。', { exact: true })).toBeVisible({ timeout: 17_000 })
  await page.unroute(endpoint)

  const failures = [
    [403, '当前账号没有权限执行此操作。'], [404, '资源不存在或已被删除。'],
    [409, '数据已发生变化或正在处理，请刷新后重试。'], [429, '操作过于频繁，请稍后重试。'],
    [500, '服务器处理失败，请稍后重试。'], [503, '服务暂不可用，请稍后重试。'],
  ]
  for (const [status, expected] of failures) {
    await page.route(endpoint, route => route.fulfill({ status, contentType: 'text/html',
      headers: { 'access-control-allow-origin': new URL(page.url()).origin }, body: 'gateway error' }), { times: 1 })
    await loginButton.click()
    await expect(page.getByText(expected, { exact: true })).toBeVisible()
  }
  await login(page, account)
})

test('a failed document creation uses one toast with the configured Ant Design theme', async ({ page, request }) => {
  const contextWarnings = []
  page.on('console', message => {
    if (/static function.*context/i.test(message.text())) contextWarnings.push(message.text())
  })
  await login(page, await createAccount(request))
  await page.getByRole('link', { name: '我的文档' }).click()
  await page.route(`${backend}/api/doc`, route => route.fulfill({ status: 503, contentType: 'application/json',
    headers: { 'access-control-allow-origin': new URL(page.url()).origin }, json: { code: 503, message: '服务暂不可用，请稍后重试。' } }), { times: 1 })
  await page.getByRole('button', { name: /新建文档$/ }).click()
  const toast = page.locator('.ant-message-error')
  await expect(toast).toHaveCount(1)
  await expect(toast).toContainText('服务暂不可用，请稍后重试。 创建结果未确认。')
  await expect(toast.locator('.anticon')).toHaveCSS('color', 'rgb(180, 35, 24)')
  expect(contextWarnings).toEqual([])
  await page.getByRole('button', { name: /新建文档$/ }).click()
  await expect(page).toHaveURL(/\/docs\/\d+(\?|$)/)
  await expect(saved(page)).toHaveText('所有修改已保存')
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

test('name a new document from the editor title on desktop and narrow screens', async ({ page, request }) => {
  await login(page, await createAccount(request))

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 850 })
    await page.getByRole('button', { name: '新建文档' }).press('Enter')
    await expect(saved(page)).toHaveText('所有修改已保存')
    await page.getByRole('button', { name: '命名文档', exact: true }).press('Enter')
    const field = page.getByRole('textbox', { name: '文档标题' })
    await expect(field).toBeFocused()
    expect(await field.evaluate(input => input.value.slice(input.selectionStart, input.selectionEnd))).toBe('未命名文档')
    const documentTitle = '写作计划 ' + width
    await page.keyboard.insertText(documentTitle)
    await field.press('Enter')
    await expect(title(page)).toHaveText(documentTitle)
    await expect(page.getByRole('button', { name: '查看完整标题：' + documentTitle })).toBeFocused()
    await page.getByRole('button', { name: '返回工作台' }).click()
    await expect(page.getByRole('link', { name: new RegExp(documentTitle) })).toBeVisible()
  }
})

test('a built-in template can be previewed and dismissed from the first screen', async ({ page, request }) => {
  await login(page, await createAccount(request))
  await page.emulateMedia({ reducedMotion: 'reduce' })

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 850 })
    await page.goto('/home')
    await page.getByRole('link', { name: '从模板开始' }).press('Enter')
    const preview = page.getByRole('button', { name: '预览并使用会议纪要' })
    await expect(preview).toBeInViewport({ ratio: 1 })
    await preview.press('Enter')
    const dialog = page.getByRole('dialog', { name: '使用会议纪要' })
    await expect(dialog.locator('.document-preview .ql-editor')).toBeAttached()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(preview).toBeFocused()
  }
})

test('personal template actions distinguish each row and keep keyboard focus on dismissal', async ({ page, request }) => {
  await login(page, await createAccount(request))
  const docId = await createDocument(page)
  await append(page, 'Reusable template fixture')
  const token = await page.evaluate(() => localStorage.getItem('collab-token'))
  for (const name of ['校刊采访记录', '校园场地手记']) {
    const reply = await request.post(`${backend}/api/personal-templates`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { docId, name, description: '', category: 'collaboration' },
    })
    expect(reply.status()).toBe(200)
    expect((await reply.json()).code).toBe(0)
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 850 })
    await page.goto('/templates?source=personal')
    const preview = page.getByRole('button', { name: '预览并使用「校刊采访记录」', exact: true })
    await expect(page.getByRole('button', { name: '预览并使用「校园场地手记」', exact: true })).toBeVisible()
    await preview.press('Enter')
    const dialog = page.getByRole('dialog', { name: '使用模板：校刊采访记录' })
    await dialog.getByRole('textbox', { name: '个人模板新文档标题' }).press('Escape')
    await expect(dialog).toBeHidden()
    await expect(preview).toBeFocused()

    await page.keyboard.press('Tab')
    const remove = page.getByRole('button', { name: '删除模板「校刊采访记录」', exact: true })
    await expect(remove).toBeFocused()
    await page.keyboard.press('Enter')
    const confirm = page.locator('.document-action-confirm')
    await expect(confirm.getByText('删除模板“校刊采访记录”？', { exact: true })).toBeVisible()
    await confirm.getByRole('button', { name: /^取\s*消$/ }).press('Enter')
    await expect(confirm).toBeHidden()
    await expect(remove).toBeFocused()
    await expect(preview).toBeVisible()
  }
})

test('the project document picker starts in the filter and returns to its trigger', async ({ page, request }) => {
  await login(page, await createAccount(request))
  const docId = await createDocument(page)
  const docTitle = '场地交接记录'
  await rename(page, docTitle)
  const projectId = await createProject(page, request, '校刊资料')

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 850 })
    await page.goto(`/projects?project=${projectId}`)
    const trigger = page.getByRole('button', { name: '加入已有文档', exact: true })
    await trigger.press('Enter')
    const picker = page.getByRole('dialog', { name: '加入已有文档' })
    const filter = picker.getByRole('textbox', { name: '筛选可加入的文档' })
    await expect(filter).toBeFocused()
    const add = picker.getByRole('button', { name: `加入项目「${docTitle}」（文档 #${docId}）`, exact: true })
    await expect(add).toBeVisible()
    await page.keyboard.insertText('不存在的资料')
    await page.keyboard.press('Enter')
    await expect(picker.getByText('没有匹配的可加入文档')).toBeVisible()
    await picker.getByRole('button', { name: '清除筛选', exact: true }).press('Enter')
    await expect(filter).toBeFocused()
    await expect(add).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(picker).toBeHidden()
    await expect(trigger).toBeFocused()
  }
})

test('adding a document confirms its identity in project details with the existing filter', async ({ page, request }) => {
  await login(page, await createAccount(request))
  const docId = await createDocument(page)
  const docTitle = '校刊定稿'
  await rename(page, docTitle)
  const docKeyword = '活动日程'

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 850 })
    const projectId = await createProject(page, request, `校刊资料 ${width}`)
    await page.goto('/projects?' + new URLSearchParams({ project: String(projectId), docKeyword }))
    await page.getByRole('button', { name: '加入已有文档', exact: true }).press('Enter')
    const picker = page.getByRole('dialog', { name: '加入已有文档' })
    await picker.getByRole('button', { name: `加入项目「${docTitle}」（文档 #${docId}）`, exact: true }).press('Enter')

    const result = page.getByRole('region', { name: '加入文档结果' })
    await expect(result).toContainText('文档已加入项目')
    await expect(result).toContainText(`文档 #${docId}`)
    await expect(result).toBeFocused()
    await expect(result).toBeInViewport({ ratio: 1 })
    await expect(page.getByRole('textbox', { name: '筛选项目内文档' })).toHaveValue(docKeyword)
    await expect(page.getByText('没有符合条件且可访问的文档')).toBeVisible()

    await page.keyboard.press('Tab')
    await expect(result.getByRole('link', { name: `打开文档「${docTitle}」（文档 #${docId}）` })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/docs/${docId}(\\?|$)`))
    await expect(title(page)).toHaveText(docTitle)
  }
})

test('returning from the editor focuses the same project document among identical titles', async ({ page, request }) => {
  await login(page, await createAccount(request))
  const docTitle = '同名交接记录'
  const docId = await createDocument(page)
  await rename(page, docTitle)
  await page.goto('/home')
  const twinId = await createDocument(page)
  await rename(page, docTitle)
  const projectId = await createProject(page, request, '校刊项目')
  const token = await page.evaluate(() => localStorage.getItem('collab-token'))
  for (const id of [docId, twinId]) {
    const reply = await request.post(`${backend}/api/projects/${projectId}/documents`, {
      headers: { Authorization: `Bearer ${token}` }, data: { docId: id },
    })
    expect((await reply.json()).code).toBe(0)
  }
  const source = '/projects?' + new URLSearchParams({ project: String(projectId), docKeyword: '交接' })

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 850 })
    await page.goto(source)
    const titles = page.locator('#project-detail .ant-list-item-meta-title')
    const original = titles.getByRole('link', { name: docTitle, exact: true })
      .and(page.locator(`a[href^="/docs/${docId}?"]`))
    await expect(titles.getByRole('link', { name: docTitle, exact: true })).toHaveCount(2)
    await original.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/docs/${docId}(\\?|$)`))
    await page.getByRole('button', { name: '返回项目', exact: true }).press('Enter')
    await expect(page.getByRole('textbox', { name: '筛选项目内文档' })).toHaveValue('交接')
    await expect(original).toBeFocused()
    await expect(original).toBeInViewport({ ratio: 1 })
  }
})

test('the complete title opens in the viewport with reduced motion enabled', async ({ page, request }) => {
  await login(page, await createAccount(request))
  await createDocument(page)
  const documentTitle = '校园阅读节｜长篇场地巡查手记'.repeat(6)
  await rename(page, documentTitle)
  await page.emulateMedia({ reducedMotion: 'reduce' })

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 850 })
    const trigger = page.getByRole('button', { name: '查看完整标题：' + documentTitle })
    await trigger.press('Enter')
    const fullTitle = page.locator('.editor-full-title')
    await expect(fullTitle).toHaveText(documentTitle)
    await expect(fullTitle).toBeInViewport({ ratio: 1 })
    await trigger.press('Escape')
    await expect(fullTitle).toBeHidden()
    await expect(trigger).toBeFocused()
  }
})

test('document find leaves room to read and opens replacement only when requested', async ({ page, request }) => {
  await login(page, await createAccount(request))
  await createDocument(page)
  await append(page, '地点交接记录。另一个地点交接。')

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 480 : 850 })
    await page.getByRole('button', { name: '文档内查找', exact: true }).press('Enter')
    const find = page.getByRole('region', { name: '文档内查找与替换' })
    const query = find.getByRole('textbox', { name: '查找本文文字' })
    await expect(query).toBeFocused()
    await query.fill('地点交接')
    await expect(find.getByRole('status')).toHaveText('1 / 2')
    const spaceBelow = await find.evaluate(element => window.innerHeight - element.getBoundingClientRect().bottom)
    expect(spaceBelow).toBeGreaterThanOrEqual(200)
    if (width === 320) {
      await expect(find.getByRole('button', { name: '下一处' }).locator('.document-find-step-label')).toBeHidden()
    }
    await query.press('Enter')
    await expect(find.getByRole('status')).toHaveText('2 / 2')
    await query.press('Shift+Enter')
    await expect(find.getByRole('status')).toHaveText('1 / 2')

    const replacement = find.getByRole('textbox', { name: '替换为' })
    await expect(replacement).toHaveCount(0)
    await find.getByRole('button', { name: '替换', exact: true }).press('Enter')
    await expect(replacement).toBeFocused()
    await find.getByRole('button', { name: '收起替换', exact: true }).press('Enter')
    await expect(replacement).toHaveCount(0)
    await expect(query).toHaveValue('地点交接')
    await page.keyboard.press('Escape')
    await expect(find).toBeHidden()
    await expect(editor(page)).toBeFocused()
  }
})

test('formatting a selection deep in a document keeps it in view at desktop and narrow widths', async ({ page, request }) => {
  await login(page, await createAccount(request))
  await createDocument(page)
  const body = Array.from({ length: 48 }, (_, index) =>
    `${index + 1} 记录志愿者接待、书目归还与场地整理。仅用于编辑验收。`).join('\n')
  await editor(page).click()
  await editor(page).evaluate((element, text) => document.execCommand('insertText', false, text), body)

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 850 })
    const paragraph = editor(page).locator('p').filter({ hasText: width === 1280 ? /^47 / : /^48 / })
    await expect(paragraph).toBeVisible()
    await expect(saved(page)).toHaveText('所有修改已保存')
    await paragraph.click()
    await page.keyboard.press('End')
    await page.keyboard.press('Shift+Home')
    const selection = await page.evaluate(() => window.getSelection().toString())
    expect(selection).toContain('验收')
    const position = await page.evaluate(() => window.scrollY)
    expect(position).toBeGreaterThan(300)
    const controls = page.locator('.editor-format-controls')
    await expect(controls).toBeInViewport()

    const bold = page.getByRole('button', { name: '粗体' })
    if (width === 320) {
      const toggle = page.getByRole('button', { name: '格式工具' })
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await page.keyboard.press('Shift+Tab')
      await expect(toggle).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      for (let step = 0; step < 8 && !await bold.evaluate(button => button === document.activeElement); step += 1) {
        await page.keyboard.press('Tab')
      }
      await expect(bold).toBeFocused()
      await page.keyboard.press('Enter')
    } else {
      await bold.click()
    }

    const formatted = paragraph.locator('strong')
    await expect(formatted).toHaveText(selection)
    await expect(formatted).toBeInViewport()
    const controlsBounds = await controls.boundingBox()
    const textBounds = await formatted.boundingBox()
    expect(textBounds.y).toBeGreaterThan(controlsBounds.y + controlsBounds.height)
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(position - 120)
    await expect(saved(page)).toHaveText('所有修改已保存')
    await page.reload()
    await expect(formatted).toHaveText(selection)
  }
})

test('returning from the editor reveals and focuses the same entry in a long document list', async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 850 })
  await login(page, await createAccount(request))
  const token = await page.evaluate(() => localStorage.getItem('collab-token'))
  for (let index = 1; index <= 14; index += 1) {
    const reply = await request.post(`${backend}/api/doc`, {
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() },
      data: { title: 'Return fixture ' + index },
    })
    expect((await reply.json()).code).toBe(0)
  }

  await page.goto('/docs?scope=owned')
  const entry = page.getByRole('link', { name: 'Return fixture 1', exact: true })
  await entry.scrollIntoViewIfNeeded()
  await entry.press('Enter')
  await expect(saved(page)).toHaveText('所有修改已保存')
  await page.getByRole('button', { name: '返回文档列表' }).press('Enter')
  await expect(page).toHaveURL(/\/docs\?scope=owned$/)
  await expect(entry).toBeFocused()
  await expect(entry).toBeInViewport({ ratio: 1 })
})

test('object retain is rejected on the wire without advancing document revision', async ({ page, request }) => {
  await login(page, await createAccount(request))
  const docId = await createDocument(page)
  const wsUrl = backend.replace(/^http/, 'ws') + '/ws/collab'
  const rejection = await page.evaluate(({ url, id }) => new Promise((resolve, reject) => {
    const token = localStorage.getItem('collab-token')
    const socket = new WebSocket(url, ['copage.v1', `bearer.${token}`])
    const clientId = crypto.randomUUID()
    const timer = setTimeout(() => { socket.close(); reject(new Error('No collaboration reply')) }, 8000)
    socket.onopen = () => socket.send(JSON.stringify({ type: 'join', docId: id, clientId, lastRevision: 0, syncId: 'qa-object-retain' }))
    socket.onmessage = event => {
      const message = JSON.parse(event.data)
      if (message.type === 'sync') {
        socket.send(JSON.stringify({ type: 'op', docId: id, clientId, baseRevision: 0, opId: 'qa-object-retain',
          op: { ops: [{ retain: { image: { alt: 'example' } } }] } }))
      } else if (message.type === 'error' || message.type === 'ack') {
        clearTimeout(timer)
        socket.close()
        resolve({ type: message.type, code: message.code })
      }
    }
  }), { url: wsUrl, id: docId })
  expect(rejection).toEqual({ type: 'error', code: 400 })
  const current = await page.evaluate(async origin => {
    const token = localStorage.getItem('collab-token')
    const id = location.pathname.split('/').at(-1)
    const reply = await fetch(`${origin}/api/doc/${id}`, { headers: { Authorization: `Bearer ${token}` } })
    return (await reply.json()).data.revision
  }, backend)
  expect(current).toBe(0)
  await append(page, 'Valid edit')
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
    await recovered.setViewportSize({ width: 320, height: 850 })
    await recovered.goto('/home')
    const draftReminder = recovered.getByRole('region', { name: '本地草稿提醒' })
    const openDrafts = draftReminder.getByRole('button', { name: '查看本地草稿' })
    await expect(openDrafts).toBeInViewport({ ratio: 1 })
    await openDrafts.press('Enter')
    const localDrafts = recovered.getByRole('dialog', { name: '本地草稿' })
    await expect(localDrafts.getByRole('heading', { name: `文档 ${docId}`, exact: true })).toBeVisible()
    await localDrafts.getByRole('button', { name: '继续处理此文档' }).press('Enter')
    const choice = recovered.getByRole('dialog', { name: '发现未确认的本地编辑' })
    await expect(choice).toBeVisible()
    await choice.getByRole('button', { name: '恢复草稿并同步' }).click()
    await expect(saved(recovered)).toHaveText('所有修改已保存')
    const expected = 'Owner edit Member edit Recovered edit'
    await expect(editor(recovered)).toHaveText(expected)
    await expect(editor(peer)).toHaveText(expected)
    await recovered.goto('/home')
    await expect(recovered.locator('.cp-workbench-tools').getByRole('button', { name: '查看本地草稿' })).toBeVisible()
    await expect(draftReminder).toBeHidden()
  } finally {
    await peerContext.close()
  }
})

test('revision gaps and a missed final broadcast catch up on the same socket', async ({ page, browser, request }) => {
  const owner = await createAccount(request)
  const member = await createAccount(request)
  const ownerJoins = []
  await page.routeWebSocket('**/ws/collab', route => {
    const server = route.connectToServer()
    route.onMessage(frame => {
      if (JSON.parse(frame).type === 'join') ownerJoins.push(true)
      server.send(frame)
    })
  })
  await login(page, owner)
  const docId = await createDocument(page)
  await grantEditor(page, request, docId, member.username)
  const peerContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
  const dropped = []
  const requests = []
  const heartbeat = []
  let peerSockets = 0
  try {
    const peer = await peerContext.newPage()
    const secondary = process.env.COPAGE_E2E_SECONDARY_BACKEND_ORIGIN
    const browserOrigin = new URL(page.url()).origin
    const primarySocket = backend.replace('http:', 'ws:')
    const secondarySocket = secondary.replace('http:', 'ws:')
    // Keep the shared HTTP origin and send only the peer's WebSocket to backend B.
    await peer.route(url => url.origin === browserOrigin && url.pathname.endsWith('.js'), async route => {
      const response = await route.fetch()
      const source = await response.text()
      if (source.includes(primarySocket)) await route.fulfill({ response, body: source.replaceAll(primarySocket, secondarySocket) })
      else await route.fulfill({ response })
    })
    await peer.routeWebSocket('**/ws/collab', route => {
      peerSockets++
      expect(new URL(route.url()).host).toBe(new URL(secondary).host)
      const server = route.connectToServer()
      let extensionSent = false
      route.onMessage(frame => {
        requests.push(JSON.parse(frame))
        server.send(frame)
      })
      server.onMessage(frame => {
        const message = JSON.parse(frame)
        if (message.type === 'op' && [1, 3].includes(message.revision)) dropped.push(message.revision)
        else {
          if (message.type === 'pong') heartbeat.push(message.revision)
          route.send(frame)
          if (message.type === 'sync' && !extensionSent) {
            extensionSent = true
            route.send(JSON.stringify({ type: 'future-editor-event', docId, permission: 0 }))
          }
        }
      })
    })
    await login(peer, member)
    await peer.goto(`/docs/${docId}`)
    await expect(saved(peer)).toHaveText('所有修改已保存')

    await append(page, 'one ')
    await expect.poll(() => dropped).toContain(1)
    await append(page, 'two ')
    await expect(editor(peer)).toHaveText('one two')
    expect(requests.some(message => message.type === 'history_request' && message.afterRevision === 0 && message.throughRevision === 2)).toBe(true)

    await append(page, 'final')
    await expect.poll(() => dropped).toEqual([1, 3])
    await expect(editor(peer)).toHaveText('one two final', { timeout: 26_000 })
    expect(heartbeat).toContain(3)
    expect(requests.some(message => message.type === 'history_request' && message.afterRevision === 2 && message.throughRevision === 3)).toBe(true)
    expect(requests.filter(message => message.type === 'join')).toHaveLength(1)
    expect(ownerJoins).toHaveLength(1)
    expect(peerSockets).toBe(1)
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

test('document menus and deletion confirmation stay on screen with reduced motion', async ({ page, request }) => {
  await login(page, await createAccount(request))
  await createDocument(page)
  const docTitle = 'Popup fixture ' + fresh()
  await rename(page, docTitle)
  const docUrl = page.url()
  await page.emulateMedia({ reducedMotion: 'reduce' })

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 850 })
    await page.goto(docUrl)
    await expect(title(page)).toHaveText(docTitle)
    await page.getByRole('button', { name: '更多文档操作' }).press('Enter')
    const editTitle = page.getByRole('menuitem', { name: '重命名', exact: true })
    await expect(editTitle).toBeInViewport({ ratio: 1 })
    await editTitle.press('Escape')
    await expect(editTitle).toBeHidden()
    await page.getByRole('button', { name: '返回文档列表' }).press('Enter')

    const entry = page.getByRole('link', { name: docTitle, exact: true })
    const row = page.locator('.ant-list-item').filter({ has: entry })
    await row.getByRole('button', { name: '更多操作：' + docTitle }).press('Enter')
    const copy = page.getByRole('menuitem', { name: '创建副本', exact: true })
    await expect(copy).toBeInViewport({ ratio: 1 })
    await copy.press('Escape')
    await expect(copy).toBeHidden()
    await row.getByRole('button', { name: '删除', exact: true }).press('Enter')
    const cancel = page.locator('.document-action-confirm').getByRole('button', { name: /^取\s*消$/ })
    await expect(cancel).toBeInViewport({ ratio: 1 })
    await cancel.press('Enter')
    await expect(cancel).toBeHidden()
    await expect(entry).toBeVisible()
  }
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
