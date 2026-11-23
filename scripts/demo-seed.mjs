const examples = [
  {
    requestId: 'bd22f54d-815c-4d25-9d52-1a27cf5d4989',
    title: '校园阅读节｜筹备会议',
    sections: [
      ['上周定下来的事', '首场活动放在图书馆二楼。场地靠窗的一侧留给安静阅读，中间四张桌用来交换书签。'],
      ['本周要确认', '小周联系图书馆，确认周六是否可以提前半小时布置。小林整理报名表，把参与人数和志愿者人数分开统计。'],
      ['下次碰头', '周四晚 19:30。带上桌牌草稿和确认过的物料清单，当场定下分工。'],
    ],
  },
  {
    requestId: '6bea5979-3ee2-4292-98a8-9e286d3270a8',
    title: '校园阅读节｜现场清单',
    permission: 1,
    sections: [
      ['开场前 30 分钟', '取四个桌牌、一盒彩笔和两叠便签。入口留一张空桌给签到，书架旁保留轮椅通道。'],
      ['活动进行中', '志愿者按报名名单签到。临时参加的同学写下姓名，现场有空位时再安排入座。'],
      ['结束后', '归还借来的书和钥匙。收下想留给下一场读者的书签，拍照记录桌面布置。'],
    ],
  },
  {
    requestId: '024a7d75-24fc-4fff-bd4c-56a550c37746',
    title: '校园阅读节｜活动方案',
    permission: 2,
    sections: [
      ['带一本书来，留一句话走', '这是一场给校园读者的小型交换会。带来最近读过的一本书，和同桌分享它，再写一张可以留在书里的便签。'],
      ['时间与地点', '周六 14:00–16:00，图书馆二楼阅览区。前 20 分钟自由翻阅，接着两人一组交换推荐，最后一起读几张便签。'],
      ['报名与准备', '报名表只收姓名和场次，每场 24 人。书可以来自图书馆，也可以带自己的。无需准备发言稿。'],
      ['一起补完这份方案', '请在下方补上适合破冰的提问和想推荐的书。现场物料请对照「现场清单」。'],
    ],
  },
]

const accounts = { owner: 'testA', peer: 'testB', password: '123456' }
const roleLabel = { 1: '只读', 2: '可编辑' }

function localOrigin(args) {
  if (args.length !== 1 || !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?\/?$/.test(args[0])) {
    throw new Error('请指定本地后端地址。用法：node scripts/demo-seed.mjs http://127.0.0.1:8080')
  }
  return new URL(args[0]).origin
}

function client(origin, token) {
  return async (path, { method = 'GET', payload, requestId, allowMissing = false } = {}) => {
    const headers = { Accept: 'application/json' }
    const multipart = payload instanceof FormData
    if (token) headers.Authorization = `Bearer ${token}`
    if (payload && !multipart) headers['Content-Type'] = 'application/json'
    if (requestId) headers['Idempotency-Key'] = requestId

    let response
    try {
      response = await fetch(`${origin}/api${path}`, {
        method,
        headers,
        body: multipart ? payload : JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      throw new Error(`${method} ${path} 请求失败。请确认本地 CoPage 后端已就绪且此地址无需跳转。`)
    }

    let result
    try {
      result = await response.json()
    } catch {
      throw new Error(`${method} ${path} 返回 HTTP ${response.status}，请确认地址指向 CoPage 后端。`)
    }
    if (allowMissing && response.status === 404 && result?.code === 404) return null
    if (!response.ok || result?.code !== 0) {
      throw new Error(`${method} ${path}（HTTP ${response.status}）${result?.message || '返回异常'}`)
    }
    return result.data
  }
}

async function signIn(origin, username) {
  const session = await client(origin)('/auth/login', {
    method: 'POST',
    payload: { username, password: accounts.password },
  })
  if (!session?.token || session.user?.username !== username) {
    throw new Error(`无法核对演示账号 ${username}。`)
  }
  return session.token
}

function importForm({ title, sections }) {
  const ops = sections.flatMap(([heading, body]) => [
    { insert: heading },
    { insert: '\n', attributes: { header: 2 } },
    { insert: `${body}\n` },
  ])
  const data = { format: 'copage', version: 1, title, content: { ops } }
  const form = new FormData()
  form.append('file', new Blob([JSON.stringify(data)], { type: 'application/json' }), `${title}.json`)
  return form
}

async function verifyOrShare(api, id, permission, newlyImported) {
  const path = `/doc/${id}/collaborators`
  const getPermission = async () => (
    (await api(path)).find(({ username }) => username === accounts.peer)?.permission
  )
  const current = await getPermission()
  if (current === permission) return true
  if (!newlyImported || current !== undefined) return false

  try {
    await api(path, { method: 'POST', payload: { username: accounts.peer, permission } })
  } catch (error) {
    // A parallel import or lost response may already have applied the requested grant.
    if (await getPermission() !== permission) {
      throw new Error(`文档 #${id} 已导入。请为 ${accounts.peer} 检查「${roleLabel[permission]}」权限。`, { cause: error })
    }
  }
  return true
}

async function seed(origin) {
  const token = await signIn(origin, accounts.owner)
  await signIn(origin, accounts.peer)
  const api = client(origin, token)

  for (const example of examples) {
    const receipt = await api(`/doc/creation-requests/${example.requestId}`, { allowMissing: true })
    if (receipt && receipt.kind !== 'import') {
      throw new Error(`无法核对「${example.title}」的导入记录。`)
    }
    if (receipt && (!receipt.available || receipt.deleted)) {
      console.log(`保留回收站或移除状态 #${receipt.id} · ${example.title}`)
      continue
    }

    const { id, title } = receipt ?? await api('/doc/import', {
      method: 'POST',
      payload: importForm(example),
      requestId: example.requestId,
    })
    const prefix = `${receipt ? '保留' : '导入'} #${id} · ${title}`
    if (!example.permission) {
      console.log(prefix)
    } else if (await verifyOrShare(api, id, example.permission, !receipt)) {
      console.log(`${prefix} · ${accounts.peer} ${roleLabel[example.permission]}`)
    } else {
      console.log(`${prefix} · 保留当前权限，可在协作面板核对 ${accounts.peer}`)
    }
  }
}

try {
  await seed(localOrigin(process.argv.slice(2)))
} catch (error) {
  console.error(`演示资料准备失败。 ${error.message}`)
  if (error.cause) console.error(error.cause.message)
  process.exitCode = 1
}
