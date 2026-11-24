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

test('a denied shared document shows the active account and opens after permission is granted', async ({ page, browser, request }) => {
  await login(page, await createAccount(request))
  const reader = await createAccount(request)
  const readerContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const peer = await readerContext.newPage()
    await login(peer, reader)
    const token = await page.evaluate(() => localStorage.getItem('collab-token'))
    for (const width of [1280, 320]) {
      await page.goto('/home')
      const docId = await createDocument(page)
      await append(page, 'Shared document content')
      await peer.setViewportSize({ width, height: width === 320 ? 640 : 850 })
      await peer.goto(`/docs/${docId}`)
      const recovery = peer.getByRole('region', { name: '当前账号没有访问权限' })
      await expect(recovery.getByRole('alert')).toContainText(reader.username)
      await expect(editor(peer)).toBeHidden()
      const retry = recovery.getByRole('button', { name: '重试加载' })
      await expect(retry).toBeInViewport({ ratio: 1 })

      const grant = await request.post(`${backend}/api/doc/${docId}/collaborators`, {
        headers: { Authorization: `Bearer ${token}` }, data: { username: reader.username, permission: 1 },
      })
      expect((await grant.json()).code).toBe(0)
      await retry.press('Enter')
      await expect(recovery).toBeHidden()
      await expect(editor(peer)).toHaveText('Shared document content')
      await expect(editor(peer)).toHaveAttribute('aria-readonly', 'true')
      await expect(saved(peer)).toHaveText('只读 · 内容已同步')
      await readerContext.setOffline(true)
      await expect(saved(peer)).toHaveText('只读 · 等待同步')
      await expect(editor(peer)).toHaveAttribute('aria-readonly', 'true')
      await readerContext.setOffline(false)
      await expect(saved(peer)).toHaveText('只读 · 内容已同步')
    }
  } finally {
    await readerContext.close()
  }
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

test('a slow account profile failure leaves recent documents in the workbench viewport', async ({ page, request }) => {
  const account = await createAccount(request)
  await login(page, account)
  const token = await page.evaluate(() => localStorage.getItem('collab-token'))
  const documentName = '首屏工作文档'
  const created = await request.post(`${backend}/api/doc`, {
    headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() },
    data: { title: documentName },
  })
  expect(created.ok()).toBe(true)
  expect((await created.json()).code).toBe(0)

  const recent = page.getByRole('region', { name: '最近文档' })
  const doc = recent.getByRole('link', { name: new RegExp(documentName) })
  const documentTitle = doc.getByText(documentName, { exact: true })
  const greeting = page.getByText(`你好，${account.username}`, { exact: true })
  const retry = page.getByRole('button', { name: '重试账号资料' })
  const profilePath = '**/api/account/me'
  for (const [width, height] of [[1280, 850], [320, 480]]) {
    await page.setViewportSize({ width, height })
    let failFirst
    const first = new Promise(resolve => { failFirst = resolve })
    await page.route(profilePath, async route => {
      await first
      await route.fulfill({ status: 503, json: { code: 503, message: '账号资料暂时无法加载' } })
    }, { times: 1 })
    await page.goto('/home')
    let top
    try {
      await expect(greeting).toBeVisible()
      await expect(documentTitle).toBeInViewport({ ratio: 1 })
      top = await documentTitle.evaluate(element => element.getBoundingClientRect().top)
    } finally {
      failFirst()
    }
    await expect(retry).toBeVisible()
    await expect(documentTitle).toBeInViewport({ ratio: 1 })
    expect(await documentTitle.evaluate(element => element.getBoundingClientRect().top)).toBe(top)

    let releaseRetry
    const second = new Promise(resolve => { releaseRetry = resolve })
    await page.route(profilePath, async route => {
      await second
      await route.continue()
    }, { times: 1 })
    const directory = recent.getByRole('link', { name: '全部文档' })
    try {
      await retry.press('Enter')
      await expect(retry).toBeFocused()
      await expect(retry).toHaveAttribute('aria-busy', 'true')
      if (width === 320) await directory.focus()
    } finally {
      releaseRetry()
    }
    await expect(retry).toHaveCount(0)
    await expect(width === 320 ? directory : greeting).toBeFocused()
    await expect(page.locator('html')).toHaveJSProperty('scrollWidth', width)

    await doc.press('Enter')
    await expect(saved(page)).toHaveText('所有修改已保存')
    await page.getByRole('button', { name: '返回工作台' }).press('Enter')
    await expect(doc).toBeFocused()
    await expect(documentTitle).toBeInViewport({ ratio: 1 })
  }
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

test('collaborator removal can be cancelled and returns focus to the same account', async ({ page, request }) => {
  await login(page, await createAccount(request))
  const docId = await createDocument(page)
  const first = await createAccount(request)
  const second = await createAccount(request)
  await grantEditor(page, request, docId, first.username)
  await grantEditor(page, request, docId, second.username)

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 850 })
    await page.getByRole('button', { name: '分享链接', exact: true }).press('Enter')
    await page.getByRole('button', { name: '设置协作者权限', exact: true }).press('Enter')
    const management = page.getByRole('dialog', { name: /^协作者管理/ })
    await expect(management.getByRole('button', { name: `移除「${second.username}」的访问权限` })).toBeVisible()
    const trigger = management.getByRole('button', { name: `移除「${first.username}」的访问权限` })
    await trigger.press('Enter')
    const confirmation = page.getByRole('dialog', { name: '移除文档访问权限？' })
    await expect(confirmation.getByRole('strong')).toHaveText(first.username)
    const cancel = confirmation.getByRole('button', { name: /^取\s*消$/ })
    await expect(cancel).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(confirmation.getByRole('button', { name: '移除权限', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(confirmation).toBeHidden()
    await expect(trigger).toBeFocused()

    await management.getByRole('button', { name: '返回分享' }).press('Enter')
    await page.getByRole('dialog', { name: '分享文档链接' }).getByRole('button', { name: /^关\s*闭$/ }).press('Enter')
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

test('document creation replaces its failure toast and dismisses it on success', async ({ page, request }) => {
  const contextWarnings = []
  page.on('console', message => {
    if (/static function.*context/i.test(message.text())) contextWarnings.push(message.text())
  })
  await login(page, await createAccount(request))
  await page.getByRole('link', { name: '我的文档' }).click()
  let failures = 0
  await page.route(`${backend}/api/doc`, route => route.fulfill({
    status: 503,
    headers: { 'access-control-allow-origin': new URL(page.url()).origin },
    json: { code: 503, message: ++failures === 1 ? '服务暂不可用，请稍后重试。' : '服务仍在恢复，请稍后重试。' },
  }), { times: 2 })
  const create = page.getByRole('button', { name: /新建文档$/ })
  await create.click()
  const toast = page.locator('.ant-message-error')
  await expect(toast).toHaveCount(1)
  await expect(toast).toContainText('服务暂不可用，请稍后重试。 创建结果未确认。')
  await expect(toast.locator('.anticon')).toHaveCSS('color', 'rgb(180, 35, 24)')
  await expect(create).not.toHaveClass(/ant-btn-loading/)
  await create.press('Enter')
  await expect(toast).toContainText('服务仍在恢复，请稍后重试。 创建结果未确认。')
  await expect(toast).toHaveCount(1)
  await expect(create).not.toHaveClass(/ant-btn-loading/)
  expect(contextWarnings).toEqual([])
  await create.press('Enter')
  await expect(page).toHaveURL(/\/docs\/\d+(\?|$)/)
  await expect(toast).toBeHidden({ timeout: 700 })
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

test('keyboard creation starts writing without jumping away from a control during sync', async ({ page, request }) => {
  await login(page, await createAccount(request))
  for (const [width, source, key] of [[1280, '/home', 'Enter'], [320, '/docs', 'Space']]) {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 850 })
    await page.goto(source)
    await page.getByRole('button', { name: '新建文档', exact: true }).press(key)
    await expect(editor(page)).toBeFocused()
    await page.keyboard.insertText('Keyboard-created document ' + width)
    await expect(saved(page)).toHaveText('所有修改已保存')
    await page.keyboard.press('Shift+Tab')
    await expect(editor(page)).not.toBeFocused()
    await page.reload()
    await expect(saved(page)).toHaveText('所有修改已保存')
    await expect(editor(page)).toHaveText('Keyboard-created document ' + width)
    await expect(editor(page)).not.toBeFocused()
  }

  let releaseSync
  const heldSync = new Promise(resolve => { releaseSync = resolve })
  await page.routeWebSocket('**/ws/collab', socket => {
    const server = socket.connectToServer()
    server.onMessage(async frame => {
      if (JSON.parse(frame).type === 'sync') await heldSync
      socket.send(frame)
    })
  })
  await page.goto('/home')
  await page.getByRole('button', { name: '新建文档', exact: true }).press('Enter')
  const back = page.getByRole('button', { name: '返回工作台' })
  try {
    await expect(back).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(back).toBeFocused()
  } finally {
    releaseSync()
  }
  await expect(saved(page)).toHaveText('所有修改已保存')
  await expect(back).toBeFocused()
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

test('opening group members keeps the list and invitation inbox available', async ({ page, request }) => {
  await login(page, await createAccount(request))
  const token = await page.evaluate(() => localStorage.getItem('collab-token'))
  const groups = []
  for (const name of ['写作小组', '校对小组']) {
    const reply = await request.post(`${backend}/api/groups`, {
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() },
      data: { name, description: '协作验收用资料' },
    })
    expect(reply.status()).toBe(200)
    const { code, data } = await reply.json()
    expect(code).toBe(0)
    groups.push({ name, id: data.id })
  }

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 760 })
    await page.goto('/groups')
    const groupButton = name => page.getByRole('listitem')
      .filter({ hasText: name }).getByRole('button', { name: '查看成员' })
    const [writing, review] = groups
    const writingButton = groupButton(writing.name)
    const reviewButton = groupButton(review.name)
    await expect(writingButton).toBeEnabled()
    await expect(page.getByText('暂无待处理邀请')).toBeVisible()

    const requests = []
    const recordResources = req => {
      const path = new URL(req.url()).pathname
      if (req.method() === 'GET' && path.startsWith('/api/groups')) requests.push(path)
    }
    page.on('request', recordResources)
    let releaseWriting
    const holdWriting = new Promise(resolve => { releaseWriting = resolve })
    const writingPath = `**/api/groups/${writing.id}`
    await page.route(writingPath, async route => {
      await holdWriting
      await route.continue()
    })
    await page.route(`**/api/groups/${review.id}`, route => route.fulfill({
      status: 503,
      json: { code: 503, message: '暂时无法读取小组资料' },
    }), { times: 1 })

    try {
      await writingButton.press('Enter')
      await expect(writingButton).toHaveAttribute('aria-expanded', 'true')
      await expect(reviewButton).toBeEnabled()
      await expect(page.getByRole('region', { name: '小组资料' }).getByRole('heading')).not.toBeFocused()
    } finally {
      releaseWriting()
    }
    const writingHeading = page.getByRole('heading', { name: writing.name, exact: true, level: 3 })
    await expect(writingHeading).toBeFocused()
    await expect(writingHeading).toBeInViewport()
    await page.unroute(writingPath)

    await reviewButton.press('Enter')
    const fallback = page.getByRole('region', { name: '小组资料' })
    await expect(fallback.getByRole('heading')).toBeFocused()
    await expect(fallback.getByRole('alert')).toBeVisible()
    await expect(writingButton).toBeEnabled()
    await expect(writingHeading).toHaveCount(0)
    await fallback.getByRole('button', { name: '重试小组资料' }).press('Enter')
    const reviewDetail = page.getByRole('region', { name: review.name })
    await expect(reviewDetail.getByText('我的角色：创建者')).toBeVisible()
    await expect(reviewDetail.getByText('没有待接受邀请')).toBeVisible()
    await expect(reviewButton).toHaveAttribute('aria-expanded', 'true')
    expect(requests).toEqual([
      `/api/groups/${writing.id}`,
      `/api/groups/${review.id}`,
      `/api/groups/${review.id}`,
    ])
    page.off('request', recordResources)

    const filter = page.getByRole('textbox', { name: '筛选小组名称或简介' })
    await filter.fill('无匹配的小组名称')
    await filter.press('Enter')
    await expect(page.getByText('没有匹配的小组，请调整关键词或清除筛选')).toBeVisible()
    await expect(reviewDetail).toHaveCount(0)
    await page.getByRole('button', { name: '清除小组筛选' }).press('Enter')
    await expect(writingButton).toBeEnabled()
    await expect(reviewButton).toBeEnabled()

    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/groups')
    await page.getByRole('button', { name: '刷新小组', exact: true }).press('Enter')
    expect((await refreshed).ok()).toBe(true)
    await page.goto(`/groups?page=8&group=${writing.id}`)
    await expect(page).toHaveURL(url => url.searchParams.get('page') === '1' &&
      url.searchParams.get('group') === String(writing.id))
    await expect(writingHeading).toBeVisible()
    await expect(writingButton).toBeEnabled()
  }
})

test('project lists and selected documents load independently at desktop and narrow widths', async ({ page, request }) => {
  await login(page, await createAccount(request))
  const name = '校园写作项目'
  const projectId = await createProject(page, request, name)
  const listPath = '/api/projects'
  const detailPath = `${listPath}/${projectId}`
  const open = page.getByRole('button', { name: '查看项目' })
  const detail = page.getByRole('region', { name })
  const heading = detail.getByRole('heading', { name, exact: true })

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 760 })
    await page.goto('/projects')
    await expect(open).toBeEnabled()
    const reads = []
    const record = request => {
      const url = new URL(request.url())
      if (request.method() === 'GET' && [listPath, detailPath].includes(url.pathname)) reads.push(url)
    }
    page.on('request', record)
    const detailRoute = `**${detailPath}?*`
    let release
    const delayed = new Promise(resolve => { release = resolve })
    await page.route(detailRoute, async route => {
      await delayed
      await route.continue()
    }, { times: 1 })

    try {
      await open.press('Enter')
      await expect(open).toBeEnabled()
      await expect(open).toHaveAttribute('aria-expanded', 'true')
      await expect(page.getByRole('region', { name: '项目资料' }).getByRole('heading')).not.toBeFocused()
    } finally {
      release()
    }
    await expect(heading).toBeFocused()
    await expect(heading).toBeInViewport()
    await expect(detail.getByText('还没有你可访问的文档，可以新建一篇或加入已有文档')).toBeVisible()

    const filter = detail.getByRole('textbox', { name: '筛选项目内文档' })
    await filter.fill('待查文档')
    await filter.press('Enter')
    await expect(detail.getByText('没有符合条件且可访问的文档')).toBeVisible()
    await expect(open).toBeEnabled()
    const fail = { status: 503, json: { code: 503, message: '暂时无法读取' } }
    await page.route(detailRoute, route => route.fulfill(fail), { times: 1 })
    await detail.getByRole('button', { name: '刷新项目资料' }).press('Enter')
    const failed = detail.getByRole('region', { name: '项目文档' })
    await expect(failed.getByRole('alert')).toBeVisible()
    await expect(filter).toHaveValue('待查文档')
    await expect(open).toBeEnabled()
    await failed.getByRole('button', { name: '重试项目资料' }).press('Enter')
    await expect(detail.getByText('没有符合条件且可访问的文档')).toBeVisible()
    await expect(filter).toBeFocused()
    expect(reads.map(url => url.pathname)).toEqual([detailPath, detailPath, detailPath, detailPath])
    expect(reads[1].searchParams.get('keyword')).toBe('待查文档')
    reads.length = 0

    await page.goto(`/projects?project=${projectId}&page=8&docPage=8`)
    await expect(page).toHaveURL(url => url.searchParams.get('project') === String(projectId) &&
      url.searchParams.get('page') === '1' && url.searchParams.get('docPage') === '1')
    await expect(open).toBeEnabled()
    await expect(heading).toBeVisible()
    for (const path of [listPath, detailPath]) {
      expect(reads.filter(url => url.pathname === path).map(url => url.searchParams.get('page'))).toEqual(['8', '1'])
    }
    reads.length = 0

    await page.route('**/api/projects?*', route => route.fulfill(fail), { times: 1 })
    await page.reload()
    const retryList = page.getByRole('button', { name: '重试项目列表' })
    await expect(retryList).toBeEnabled()
    await expect(heading).toBeVisible()
    await retryList.press('Enter')
    await expect(open).toBeEnabled()
    await expect(heading).toBeVisible()
    expect(reads.filter(url => url.pathname === listPath)).toHaveLength(2)
    expect(reads.filter(url => url.pathname === detailPath)).toHaveLength(1)
    page.off('request', record)
  }
})

test('a pending project document filter keeps focus and discards results from older queries', async ({ page, request }) => {
  await login(page, await createAccount(request))
  const name = '校园写作项目'
  const projectId = await createProject(page, request, name)
  const otherName = '校对计划'
  await createProject(page, request, otherName)
  const docId = await createDocument(page)
  const documentName = '阅读节素材'
  await rename(page, documentName)
  const token = await page.evaluate(() => localStorage.getItem('collab-token'))
  const link = await request.post(`${backend}/api/projects/${projectId}/documents`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { docId },
  })
  expect(link.status()).toBe(200)
  expect((await link.json()).code).toBe(0)

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 760 })
    await page.goto(`/projects?project=${projectId}`)
    const detail = page.getByRole('region', { name })
    const filter = detail.getByRole('textbox', { name: '筛选项目内文档' })
    const doc = detail.getByRole('link', { name: documentName, exact: true })
    const openProject = projectName => page.getByRole('listitem')
      .filter({ hasText: projectName }).getByRole('button', { name: '查看项目' })
    await expect(doc).toBeVisible()
    await filter.fill('未提交的查询')
    await openProject(otherName).press('Enter')
    const otherDetail = page.getByRole('region', { name: otherName })
    await expect(otherDetail.getByRole('textbox', { name: '筛选项目内文档' })).toHaveValue('')
    await expect(doc).toHaveCount(0)
    await openProject(name).press('Enter')
    await expect(doc).toBeVisible()

    const slowQuery = '无匹配结果'
    const slowRoute = url => url.pathname === `/api/projects/${projectId}` && url.searchParams.get('keyword') === slowQuery
    let release
    const delayed = new Promise(resolve => { release = resolve })
    const slowRequest = page.waitForRequest(req => slowRoute(new URL(req.url())))
    await page.route(slowRoute, async route => {
      await delayed
      await route.continue()
    }, { times: 1 })
    try {
      await filter.fill(slowQuery)
      await filter.press('Enter')
      await slowRequest
      await expect(detail.getByRole('status')).toHaveText('正在读取项目文档…')
      await expect(filter).toBeFocused()
      await expect(filter).toBeInViewport()
      await expect(doc).toHaveCount(0)
      await expect(detail.getByRole('button', { name: '新建文档' })).toBeDisabled()

      await filter.fill('阅读节')
      await filter.press('Enter')
      await expect(doc).toBeVisible()
      await expect(filter).toBeFocused()
    } finally {
      release()
    }
    const denied = page.waitForResponse(response => new URL(response.url()).pathname === `/api/projects/${projectId}` &&
      response.status() === 403)
    await page.route(`**/api/projects/${projectId}?*`, route => route.fulfill({
      status: 403,
      json: { code: 403, message: '当前账号无权访问该项目' },
    }), { times: 1 })
    await filter.fill('换个查询')
    await filter.press('Enter')
    await denied
    const unavailable = page.getByRole('region', { name: '项目资料' })
    await expect(unavailable.getByRole('alert')).toBeVisible()
    await expect(filter).toHaveCount(0)
    await expect(doc).toHaveCount(0)
    await expect(unavailable.getByRole('button', { name: '重试项目资料' })).toBeEnabled()
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

test('document library pagination keeps keyboard access to the filtered results', async ({ page, request }) => {
  await login(page, await createAccount(request))
  const token = await page.evaluate(() => localStorage.getItem('collab-token'))
  const keyword = '阅读节策划'
  for (let index = 1; index <= 22; index += 1) {
    const response = await request.post(`${backend}/api/doc`, {
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() },
      data: { title: keyword + ' ' + String(index).padStart(2, '0') },
    })
    expect(response.ok()).toBe(true)
    expect((await response.json()).code).toBe(0)
  }
  const path = '/docs?scope=owned&keyword=' + encodeURIComponent(keyword)
  const list = page.getByRole('region', { name: '文档列表' })
  const documents = list.getByRole('link')
  const next = list.locator('li[title="下一页"]')
  const filter = page.getByRole('textbox', { name: '按文档标题筛选' })
  const onPage = (url, pageNumber) => url.pathname === '/api/doc/list' && url.searchParams.get('page') === pageNumber

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 760 })
    await page.goto(path)
    await expect(documents).toHaveCount(20)
    let release
    const hold = new Promise(resolve => { release = resolve })
    await page.route(url => onPage(url, '2'), async route => {
      await hold
      await route.fulfill({ status: 503, json: { code: 503, message: '文档列表暂时无法加载' } })
    }, { times: 1 })
    try {
      await next.press('Enter')
      await expect(list).toBeFocused()
      await expect(list).toHaveAttribute('aria-busy', 'true')
      await expect(documents).toHaveCount(0)
    } finally {
      release()
    }
    await expect(list.getByRole('alert')).toBeVisible()
    await page.keyboard.press('Tab')
    const retry = list.getByRole('button', { name: '重试文档列表' })
    await expect(retry).toBeFocused()
    await retry.press('Enter')
    await expect(documents).toHaveCount(2)
    await expect(list).toBeFocused()
    await page.keyboard.press('Tab')
    const name = await documents.first().innerText()
    const first = list.getByRole('link', { name, exact: true })
    await expect(first).toBeFocused()
    await expect(first).toBeInViewport({ ratio: 1 })
    await first.press('Enter')
    await expect(saved(page)).toHaveText('所有修改已保存')
    await page.getByRole('button', { name: '返回文档列表' }).press('Enter')
    await expect(page).toHaveURL(url => url.searchParams.get('scope') === 'owned' &&
      url.searchParams.get('keyword') === keyword && url.searchParams.get('page') === '2')
    await expect(first).toBeFocused()

    await page.goto('/home')
    let complete
    const clamp = new Promise(resolve => { complete = resolve })
    await page.route(url => onPage(url, '99'), async route => {
      await clamp
      await route.continue()
    }, { times: 1 })
    try {
      await page.goto(path + '&page=99')
      await expect(list).toHaveAttribute('aria-busy', 'true')
      await filter.focus()
    } finally {
      complete()
    }
    await expect(page).toHaveURL(url => url.searchParams.get('page') === '2')
    await expect(documents).toHaveCount(2)
    await expect(filter).toBeFocused()
    await page.goBack()
    await expect(page).toHaveURL(/\/home$/)
    await page.goForward()
    await expect(page).toHaveURL(url => url.searchParams.get('page') === '2')
    await filter.fill('未匹配的标题')
    await filter.press('Enter')
    await expect(list.getByText('没有匹配的标题，试试其他关键词')).toBeVisible()
    await expect(filter).toBeFocused()
  }
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
    const discard = choice.getByRole('button', { name: '丢弃本地草稿' })
    await discard.press('Enter')
    const confirmation = recovered.getByRole('dialog', { name: '丢弃这份本地草稿？' })
    await expect(confirmation.getByRole('button', { name: '保留草稿' })).toBeFocused()
    await recovered.keyboard.press('Escape')
    await expect(discard).toBeFocused()
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

test('the online collaborator roster stays accessible and follows live membership', async ({ page, browser, context, request }) => {
  const owner = await createAccount(request)
  const members = [await createAccount(request), await createAccount(request)]
  await login(page, owner)
  const id = await createDocument(page)
  const peerContexts = []
  try {
    for (const member of members) {
      await grantEditor(page, request, id, member.username)
      const peerContext = await browser.newContext({ baseURL: new URL(page.url()).origin })
      peerContexts.push(peerContext)
      const peer = await peerContext.newPage()
      await login(peer, member)
      await peer.goto(`/docs/${id}`)
      await expect(saved(peer)).toHaveText('所有修改已保存')
    }

    const presence = page.getByRole('group', { name: '在线协作者' })
    const threePeople = presence.getByLabel('查看在线协作者（3 位）')
    const roster = presence.getByRole('list', { name: '在线协作者名单' })
    const panel = presence.locator('.editor-presence-panel')
    const status = page.locator('.editor-status-row')
    for (const [width, height] of [[1280, 850], [320, 480]]) {
      await page.setViewportSize({ width, height })
      await expect(threePeople).toBeVisible()
      await expect(threePeople).toHaveText(/\+1$/)
      const rowHeight = (await status.boundingBox()).height
      await page.getByRole('button', { name: '更多文档操作' }).focus()
      await page.keyboard.press('Tab')
      await expect(threePeople).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(roster.getByRole('listitem')).toHaveCount(3)
      for (const person of [owner, ...members]) {
        await expect(roster.getByText(person.username, { exact: true })).toBeVisible()
      }
      await expect(panel).toBeInViewport({ ratio: 1 })
      expect((await status.boundingBox()).height).toBe(rowHeight)
      await expect(page.locator('html')).toHaveJSProperty('scrollWidth', width)
      await page.keyboard.press('Tab')
      await expect(roster).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(roster).toBeHidden()
      await expect(threePeople).toBeFocused()

      await threePeople.click()
      await expect(roster).toBeVisible()
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
      const writingArea = await editor(page).boundingBox()
      await page.mouse.click(writingArea.x + 12, writingArea.y + 24)
      await expect(roster).toBeHidden()
      await expect(editor(page)).toBeFocused()
    }

    await threePeople.press('Enter')
    await peerContexts.pop().close()
    await expect(roster.getByRole('listitem')).toHaveCount(2)
    await expect(roster.getByText(members[1].username, { exact: true })).toHaveCount(0)
    await peerContexts.pop().close()
    await expect(roster.getByRole('listitem')).toHaveCount(1)
    await expect(roster.getByText(owner.username, { exact: true })).toBeVisible()
    await context.setOffline(true)
    await expect(presence).toHaveCount(0)
    await expect(saved(page)).toHaveText('等待同步')
    await context.setOffline(false)
    await expect(presence.getByLabel('查看在线协作者（1 位）')).toBeVisible()
    await expect(roster).toBeHidden()
    await append(page, '继续写校刊')
  } finally {
    await Promise.all(peerContexts.map(peer => peer.close()))
  }
})

test('a collaborator can download held edits from the editor after a permission change', async ({ page, browser, request }) => {
  await login(page, await createAccount(request))
  const reader = await createAccount(request)
  const docId = await createDocument(page)
  await grantEditor(page, request, docId, reader.username)
  const token = await page.evaluate(() => localStorage.getItem('collab-token'))
  const members = `${backend}/api/doc/${docId}/collaborators`
  const headers = { Authorization: `Bearer ${token}` }
  const listing = await request.get(members, { headers })
  const collaborator = (await listing.json()).data.find(member => member.username === reader.username)
  expect(collaborator).toBeTruthy()

  const viewerContext = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 320, height: 640 } })
  try {
    const peer = await viewerContext.newPage()
    let held = 0
    await peer.routeWebSocket('**/ws/collab', downstream => {
      const upstream = downstream.connectToServer()
      downstream.onMessage(message => {
        if (typeof message === 'string' && JSON.parse(message).type === 'op') held++
        else upstream.send(message)
      })
    })
    await login(peer, reader)
    await peer.goto(`/docs/${docId}`)
    await expect(saved(peer)).toHaveText('所有修改已保存')
    await append(peer, 'Unsynced collaborator text', { acknowledge: false })
    await expect.poll(() => held).toBeGreaterThan(0)

    const update = await request.put(`${members}/${collaborator.userId}`, { headers, data: { permission: 1 } })
    expect((await update.json()).code).toBe(0)
    await expect(editor(peer)).toHaveAttribute('aria-readonly', 'true')
    const action = peer.getByRole('button', { name: '备份草稿', exact: true })
    await expect(action).toBeInViewport({ ratio: 1 })
    await action.press('Enter')
    const dialog = peer.getByRole('dialog', { name: '备份未同步的编辑' })
    const downloading = peer.waitForEvent('download')
    await dialog.getByRole('button', { name: '下载纯文本草稿' }).press('Enter')
    expect(await readFile(await (await downloading).path(), 'utf8')).toContain('Unsynced collaborator text')
    await peer.keyboard.press('Escape')
    await expect(action).toBeFocused()
    await expect(editor(page)).not.toContainText('Unsynced collaborator text')
  } finally {
    await viewerContext.close()
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

test('keyboard pagination and retry resume at the search results', async ({ page, request }) => {
  await login(page, await createAccount(request))
  const token = await page.evaluate(() => localStorage.getItem('collab-token'))
  const marker = '阅读节策划'
  for (let index = 1; index <= 12; index += 1) {
    const response = await request.post(`${backend}/api/doc`, {
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() },
      data: { title: marker + ' ' + String(index).padStart(2, '0') },
    })
    expect(response.ok()).toBe(true)
    expect((await response.json()).code).toBe(0)
  }

  const path = '/search?q=' + encodeURIComponent(marker)
  const onSecondPage = url => url.pathname === '/api/search' && url.searchParams.get('page') === '2'
  const next = page.locator('li[title="下一页"]')
  const results = page.getByRole('region', { name: '搜索结果' })
  const query = page.getByRole('textbox', { name: '搜索标题和正文' })
  const first = results.getByRole('heading').first().getByRole('link')

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 760 })
    await page.goto(path)
    await expect(next).toBeVisible()
    let release
    const delayed = new Promise(resolve => { release = resolve })
    await page.route(onSecondPage, async route => {
      await delayed
      await route.fulfill({ status: 503, json: { code: 503, message: '搜索服务暂时不可用' } })
    }, { times: 1 })

    try {
      await next.scrollIntoViewIfNeeded()
      await next.press('Enter')
      await expect(results).toBeFocused()
      await expect(results).toHaveAttribute('aria-busy', 'true')
      await expect(page.getByRole('status')).toHaveText('正在搜索…')
      await expect(first).toHaveCount(0)
    } finally {
      release()
    }
    await expect(results.getByRole('alert')).toBeVisible()
    await expect(results).toBeFocused()
    await page.keyboard.press('Tab')
    const retry = results.getByRole('button', { name: '重试搜索' })
    await expect(retry).toBeFocused()
    await retry.press('Enter')
    await expect(page.getByRole('status')).toContainText('第 2 页')
    await expect(first).toBeInViewport({ ratio: 1 })
    await expect(results).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(first).toBeFocused()
    const returnedName = await first.getAttribute('aria-label')
    await first.press('Enter')
    await expect(editor(page)).toBeVisible()
    await page.getByRole('button', { name: '返回搜索结果' }).press('Enter')
    await expect(page).toHaveURL(url => url.searchParams.get('page') === '2')
    await expect(results.getByRole('link', { name: returnedName, exact: true })).toBeFocused()

    await page.goto(path)
    await expect(next).toBeVisible()
    let resume
    const paused = new Promise(resolve => { resume = resolve })
    await page.route(onSecondPage, async route => {
      await paused
      await route.continue()
    }, { times: 1 })
    try {
      await next.press('Enter')
      await expect(results).toBeFocused()
      await query.focus()
    } finally {
      resume()
    }
    await expect(first).toBeVisible()
    await expect(query).toBeFocused()
    await query.fill('没有匹配的合成搜索词')
    await query.press('Enter')
    await expect(page.getByRole('status')).toHaveText('没有找到相关文档')
    await expect(query).toBeFocused()
  }
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
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 760 })
    const docId = await createDocument(page)
    const docTitle = 'Trash fixture ' + fresh()
    await rename(page, docTitle)
    await append(page, 'Recover me from trash')
    await page.getByRole('button', { name: '返回文档列表' }).press('Enter')
    const entry = page.getByRole('link', { name: docTitle, exact: true })
    const row = page.locator('.ant-list-item').filter({ has: entry })
    await row.getByRole('button', { name: /^删\s*除$/ }).click()
    await page.getByRole('button', { name: /^确\s*定$/ }).click()
    await expect(entry).toBeHidden()

    await page.goto('/trash')
    const restore = page.getByRole('button', { name: `恢复文档 #${docId}：${docTitle}` })
    await restore.press('Enter')
    const confirm = page.getByRole('button', { name: '确认恢复' })
    let release
    const held = new Promise(resolve => { release = resolve })
    await page.route(`**/api/doc/${docId}/restore`, async route => {
      await held
      await route.continue()
    }, { times: 1 })
    try {
      await confirm.press('Enter')
      await expect(confirm).toBeFocused()
      await expect(page.getByRole('link', { name: '打开文档' })).toHaveCount(0)
    } finally {
      release()
    }
    const restored = page.getByRole('link', { name: '打开文档' })
    await expect(restored).toBeFocused()
    await expect(restored).toBeInViewport({ ratio: 1 })
    await expect(page.getByText('回收站是空的')).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/docs/${docId}(\\?|$)`))
    await expect(editor(page)).toHaveText('Recover me from trash')
    await page.getByRole('button', { name: '返回回收站' }).press('Enter')
    await expect(page.getByText('回收站是空的')).toBeVisible()
  }
})

test('restoring a document respects later focus and still allows confirmation after an unknown reply', async ({ page, request }) => {
  await login(page, await createAccount(request))
  await page.setViewportSize({ width: 320, height: 640 })
  const token = await page.evaluate(() => localStorage.getItem('collab-token'))
  const workbench = page.getByRole('navigation', { name: '应用导航' }).getByRole('link', { name: '工作台' })
  const restored = page.getByRole('link', { name: '打开文档' })

  for (const loseReply of [false, true]) {
    const name = '活动记录'
    const headers = { Authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() }
    const created = await request.post(`${backend}/api/doc`, { headers, data: { title: name } })
    expect(created.ok()).toBe(true)
    const { data } = await created.json()
    const removed = await request.delete(`${backend}/api/doc/${data.id}`, { headers })
    expect((await removed.json()).code).toBe(0)

    await page.goto('/trash')
    await page.getByRole('button', { name: `恢复文档 #${data.id}：${name}` }).press('Enter')
    let release
    const held = new Promise(resolve => { release = resolve })
    const restorePath = `/api/doc/${data.id}/restore`
    const sent = page.waitForRequest(req => new URL(req.url()).pathname === restorePath)
    await page.route(`**${restorePath}`, async route => {
      await held
      if (!loseReply) { await route.continue(); return }
      const response = await route.fetch()
      expect((await response.json()).code).toBe(0)
      await route.fulfill({ status: 503, json: { code: 503, message: '暂未收到恢复结果' } })
    }, { times: 1 })
    try {
      await page.getByRole('button', { name: '确认恢复' }).press('Enter')
      await sent
      await workbench.focus()
      await expect(workbench).toBeFocused()
    } finally {
      release()
    }
    if (loseReply) {
      const review = page.getByRole('button', { name: '核对恢复结果' })
      await expect(review).toBeVisible()
      await expect(restored).toHaveCount(0)
      await review.press('Enter')
      await expect(restored).toBeFocused()
    } else {
      await expect(restored).toBeVisible()
      await expect(workbench).toBeFocused()
    }
    await expect(restored).toHaveAttribute('href', `/docs/${data.id}?returnTo=%2Ftrash`)
  }
})

test('print preview follows the active image node and recovers from a failed image read', async ({ page, request }) => {
  await login(page, await createAccount(request))
  const token = await page.evaluate(() => localStorage.getItem('collab-token'))
  const headers = { Authorization: 'Bearer ' + token }
  const checker = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAqklEQVR4nO3XsQlCQRAA0dnpxQosxXYMjezJEj72YgU2oJHBOXAvXDY4OFiYeT3vfHK+nT/Oj+vxV/sSJ3ESJ3ESJ3ESN6fLI3Hvjy/7+R+QOImTOImTOImb3QOLSZzESZzESZzEze6BxSRO4iRO4iRO4mb3wGISJ3ESJ3ESJ3Gze2AxiZM4iZM4iZO42T2wmMRJnMRJnMRJ3OweWEziJE7iJE7iXP2AX70Bq9JieVC1JQMAAAAASUVORK5CYII=',
    'base64',
  )
  const upload = await request.post(`${backend}/api/upload/image`, {
    headers, multipart: { file: { name: 'checker.png', mimeType: 'image/png', buffer: checker } },
  })
  expect(upload.status()).toBe(200)
  const imageUrl = (await upload.json()).data.url
  const source = {
    format: 'copage', version: 1, title: 'Print image fixture',
    content: { ops: [{ insert: 'Saved content\n' }, { insert: { image: imageUrl } }, { insert: '\n' }] },
  }
  const imported = await request.post(`${backend}/api/doc/import`, {
    headers, multipart: {
      file: { name: 'print.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(source)) },
    },
  })
  expect(imported.status()).toBe(200)
  const documentId = (await imported.json()).data.id
  const dialog = page.getByRole('dialog', { name: '打印 / 另存为 PDF' })
  const image = dialog.locator('.document-print-sheet .ql-editor img')
  const print = dialog.getByRole('button', { name: '打开打印窗口' })
  const refresh = dialog.getByRole('button', { name: '刷新预览' })

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 850 })
    await page.goto(`/docs/${documentId}`)
    await expect(saved(page)).toHaveText('所有修改已保存')
    await expect(editor(page).locator('img')).toHaveJSProperty('naturalWidth', 64)

    let release
    const held = new Promise(resolve => { release = resolve })
    await page.route('**/api/images/**', async route => {
      await held
      await route.continue()
    }, { times: 1 })
    try {
      await tool(page, '打印 / PDF')
      await expect(dialog.getByText('正在加载打印图片…')).toBeVisible()
      await expect(print).toBeDisabled()
      // Preview initialization can replace an image after the print modal starts listening.
      await image.evaluate(node => node.replaceWith(node.cloneNode(true)))
    } finally {
      release()
    }
    await expect(image).toHaveJSProperty('naturalWidth', 64)
    await expect(print).toBeEnabled({ timeout: 4_000 })

    await page.route('**/api/images/**', route => route.fulfill({
      status: 503, json: { code: 503, message: '服务暂不可用' },
    }), { times: 1 })
    await refresh.press('Enter')
    const missing = dialog.getByRole('alert').filter({ hasText: '1 张图片未能加载' })
    await expect(missing).toBeVisible({ timeout: 4_000 })
    await expect(print).toBeDisabled()
    await missing.getByRole('checkbox').press('Space')
    await expect(print).toBeEnabled()

    await refresh.press('Enter')
    await expect(image).toHaveJSProperty('naturalWidth', 64)
    await expect(missing).toBeHidden()
    await expect(print).toBeEnabled({ timeout: 4_000 })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  }
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
