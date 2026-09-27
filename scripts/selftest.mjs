/**
 * 端到端自检脚本（开发用）。
 *
 * 它做两件事：
 *   1. 起一个本地桩服务器（见 scripts/stub-server.mjs），提供苹果CMS 接口、异常返回、网页规则页、假直播流；
 *   2. 通过 CDP 连到已经用 `--remote-debugging-port=9222` 启动的 dev 窗口，走一遍
 *      「加配置源 → 同步 → 站点列表 → 连通性测试 → 搜索 → 详情 → 选集 → 播放器 → 分类浏览」的真实链路。
 *
 * 用法：
 *   终端 A： npm run dev:debug
 *   终端 B： npm run selftest
 *
 * 依赖：samples/selftest-config.json
 */
import { createStub, listen, state, BASE, MEDIA, MEDIA_2, DEAD_MEDIA, POSTER_1, POSTER_2 } from './stub-server.mjs'

const DETAIL_URL = `${BASE}/detail/1`

const CDP = 'http://127.0.0.1:9222'

const stub = createStub()
await listen(stub)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let targets
try {
  targets = await (await fetch(`${CDP}/json`)).json()
} catch {
  console.error(`连不上调试端口 ${CDP}。请先用「npm run dev:debug」启动开发窗口。`)
  stub.close()
  process.exit(1)
}

const page = targets.find((t) => t.type === 'page' && /localhost:5173/.test(t.url)) ?? targets.find((t) => t.type === 'page')
if (!page) {
  console.error('调试端口里没有页面目标。')
  stub.close()
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const pageErrors = []

function send(method, params = {}) {
  const msgId = ++id
  ws.send(JSON.stringify({ id: msgId, method, params }))
  return new Promise((resolve) => pending.set(msgId, resolve))
}

/**
 * 这些报错是浏览器媒体规范本身产生的噪声，不是应用的问题：
 * - play() 被新的 load() 打断 / 元素被移出文档：切线路、翻集、热更新重载都会触发它，
 *   是 HTMLMediaElement 的既定行为（见 https://goo.gl/LdLk22）。
 * 不滤掉的话自检结果会随「跑之前改没改过代码」漂移。
 */
const BENIGN_ERROR = /AbortError: The play\(\) request was interrupted/i
const recordError = (text) => {
  if (BENIGN_ERROR.test(text)) return
  pageErrors.push(text)
}

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result)
    pending.delete(msg.id)
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    recordError(
      msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text
    )
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    recordError('[console.error] ' + msg.params.args.map((a) => a.value ?? a.description).join(' '))
  }
})

await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable')

// 窗口被遮挡 / 最小化时 document.visibilityState 是 hidden，rAF 与 IntersectionObserver
// 会被完全节流（一次回调都不发）。「滚到底自动加载」这类断言依赖渲染帧，不先把页面
// 弄成可见 + 聚焦，测出来永远是「没反应」。
await send('Page.enable')
await send('Page.bringToFront')
await send('Page.setWebLifecycleState', { state: 'active' })
try {
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
} catch {
  // 老版本 Chromium 没有这个域，忽略
}

// 编辑代码时的中途保存可能给 Vite 留下一次失败的 HMR 报错（"Failed to reload …"），
// 它会一直挂在页面 console 里，被后面每一条「没有 JS 异常」断言当成新错误抓到。
// 先刷新一次，既清掉这类陈旧报错，也保证下面跑的是当前这份代码。
pageErrors.length = 0
await send('Page.reload')
await new Promise((r) => setTimeout(r, 3500))

const evalJs = async (expr) => {
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (res?.exceptionDetails) return `THREW: ${res.exceptionDetails.exception?.description}`
  return res?.result?.value
}

/**
 * 轮询等某个表达式的值满足条件（默认最多 12s），返回最后读到的值。
 * 搜索结果是一条条推过来的、详情页要等主进程解析，死等固定毫秒数会在
 * 机器慢一点或被别的进程抢 IO 时假失败。
 */
const waitFor = async (expr, ok, timeout = 12000) => {
  const deadline = Date.now() + timeout
  let value = await evalJs(expr)
  while (!ok(value) && Date.now() < deadline) {
    await sleep(200)
    value = await evalJs(expr)
  }
  return value
}

/**
 * 切到指定路由。给了 expect 时会轮询等标题变成期望值（最多 5s），
 * 而不是死等固定 800ms —— 渲染慢一点就误报「实际是上一个页面」。
 */
const goto = async (hash, expect) => {
  const readTitle =
    "document.querySelector('.page-title')?.textContent?.trim() ?? document.querySelector('h1')?.textContent?.trim() ?? ''"
  const deadline = Date.now() + 8000
  let title = ''
  for (;;) {
    // 每次都重设一次 hash：渲染进程正忙时偶尔会漏掉第一次导航（表现为
    // 「上一个页面还留在屏幕上」的假失败）。hash 没变时不会触发 hashchange，
    // 所以重复设置是安全的。
    await evalJs(`location.hash = ${JSON.stringify(hash)}`)
    await sleep(200)
    title = await evalJs(readTitle)
    if (!expect || title === expect || Date.now() > deadline) break
  }
  return {
    title,
    rows: await evalJs("document.querySelectorAll('.list-row').length")
  }
}

const checks = []
const check = (name, actual, expected) => {
  const pass = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected)
  checks.push({ name, pass, actual })
  console.log(`  ${pass ? '✓' : '✗'} ${name}${pass ? '' : `  实际 ${JSON.stringify(actual)}`}`)
}

// 自检会自己收藏、自己播片写历史，而 [9/13] 段还要把收藏与历史清干净才对得上
// 数目。所以**在动任何东西之前**先把你真实的收藏与观看记录备份下来，脚本最后
// 再还原（见末尾）。时间戳没法原样写回（recordHistory 里一定会盖 Date.now()），
// 还原时按从旧到新的顺序补进去，至少把内容和排序保住。
const libraryBackup = JSON.parse(await evalJs('window.api.library.get().then(l => JSON.stringify(l))'))

console.log('\n[1/13] 六个路由都能渲染出标题')
for (const [hash, title] of [
  ['#/search', '分类浏览'],
  ['#/live', '电视直播'],
  ['#/library', '收藏与历史'],
  ['#/sites', '影视源'],
  ['#/settings', '设置']
]) {
  const got = await goto(hash, title)
  check(`${hash} → ${title}`, got.title, title)
}

console.log('\n[2/13] 添加本地自检配置并同步')
for (const sid of JSON.parse(await evalJs('window.api.sources.list().then(l => JSON.stringify(l.map(s => s.id)))'))) {
  await evalJs(`window.api.sources.remove(${JSON.stringify(sid)})`)
}
const added = await evalJs(
  `window.api.sources.add({ name: '本地自检', url: ${JSON.stringify(new URL('../samples/selftest-config.json', import.meta.url).pathname.slice(1))}, kind: 'file' }).then(s => JSON.stringify(s))`
)
const sourceId = JSON.parse(added).id
const synced = JSON.parse(
  await evalJs(
    `window.api.sources.sync(${JSON.stringify(sourceId)}).then(s => JSON.stringify({ error: s.error ?? null, siteCount: s.siteCount, liveCount: s.liveCount, parseCount: s.parseCount }))`
  )
)
check('同步无错误', synced.error, null)
check('解析出 5 个站点', synced.siteCount, 5)
check('解析出 2 个直播源', synced.liveCount, 2)
check('解析出 1 个解析接口', synced.parseCount, 1)

// 配置源是在渲染进程背后换掉的（上面直接调的 window.api.sources.*），
// 不刷新的话渲染进程里还留着上一套 categories / live，
// 后面的界面断言就会拿旧数据去比 —— 表现成「自检第一次跑必挂，第二次才过」。
// （第一次跑时应用配的是真实源，第二次跑时已经是桩源了，所以第二次反而对得上。）
pageErrors.length = 0
await send('Page.reload')
await new Promise((r) => setTimeout(r, 3500))

console.log('\n[3/13] 站点类型归一化')
const sites = JSON.parse(
  await evalJs(
    `window.api.sites.list().then(l => JSON.stringify(Object.fromEntries(l.map(s => [s.key, { type: s.type, searchable: s.searchable, unsupported: s.unsupported ?? null }]))))`
  )
)
check('字符串 cms → type 3', sites.self_cms_base?.type, 3)
check('数字 3 保持 type 3', sites.self_cms_tpl?.type, 3)
check('字符串 html → type 1', sites.self_html_ok?.type, 1)

console.log('\n[4/13] 连通性测试（本地桩，结果可判定）')
const tests = {}
for (const key of ['self_cms_base', 'self_cms_tpl', 'self_html_ok', 'self_html_bad', 'self_cms_bad']) {
  tests[key] = JSON.parse(await evalJs(`window.api.sites.test(${JSON.stringify(key)}).then(r => JSON.stringify(r))`))
  console.log(`      ${key.padEnd(14)} ${tests[key].ok ? 'OK ' : 'ERR'} ${tests[key].message}`)
}
check('基地址式 CMS 测试通过', tests.self_cms_base.ok, true)
check('CMS 能取到影片名', tests.self_cms_base.sample, '自检影片甲')
check('占位符式 CMS 测试通过', tests.self_cms_tpl.ok, true)
check('网页规则站选择器匹配成功', tests.self_html_ok.ok, true)
check('选择器失效时如实报错', tests.self_html_bad.ok, false)
check('CMS 异常码被识别', tests.self_cms_bad.ok, false)
check('站点自定义请求头被带上', state.lastHeaders?.['x-self-test'], '1')

console.log('\n[5/13] 界面渲染')
await evalJs('location.reload()')
await sleep(2500)
check('影视源页渲染 5 行', (await goto('#/sites')).rows, 5)
await goto('#/')
check('首页标题', await evalJs("document.querySelector('h1')?.textContent ?? ''"), 'TVBox Desktop')
check(
  '首页统计卡有 6 张',
  await evalJs("document.querySelectorAll('.stat').length"),
  6
)
check('里程碑 5 个', await evalJs("document.querySelectorAll('.milestone').length"), 5)
const errorsBeforeUi = pageErrors.length
check('M1 阶段没有 JS 异常 / console.error', pageErrors, [])

console.log('\n[6/13] M2：聚合搜索 → 详情 → 选集 → 播放器')

// 解说过滤的开关是持久化的，上一次跑或用户手动关过都会影响断言。
// 先显式打开再刷新：刷新是为了让渲染进程的 store 重新从主进程读一遍设置。
await evalJs("window.api.settings.set({ filterCommentary: true })")
await evalJs('location.reload()')
await sleep(2500)
check(
  '解说过滤开关处于打开状态',
  await evalJs("window.api.settings.get().then(s => s.filterCommentary)"),
  true
)

check(
  '能订阅搜索进度事件',
  await evalJs(`
    (() => {
      window.__progress = []
      if (window.__off) window.__off()
      window.__off = window.api.search.onProgress((p) => {
        window.__progress.push({ site: p.result.siteKey, done: p.done, total: p.total, ok: p.result.ok, count: p.result.list.length })
      })
      return true
    })()
  `),
  true
)

const search = JSON.parse(
  await evalJs(
    `window.api.search.run('自检', { sites: ['self_cms_base','self_cms_tpl','self_html_ok','self_html_bad','self_cms_bad'] })
       .then(r => JSON.stringify(r)).catch(e => JSON.stringify({ error: e.message }))`
  )
)
const seen = JSON.parse(await evalJs('JSON.stringify(window.__progress)'))
await evalJs('window.__off && window.__off()')

check('搜索覆盖 5 个站点', search.total, 5)
check('返回 5 份站点结果', search.results?.length, 5)
const byKey = Object.fromEntries((search.results ?? []).map((r) => [r.siteKey, r]))

/** 原始命中里的全部片名（未合并、未过滤） */
const rawNames = (search.results ?? []).flatMap((r) => r.list.map((v) => v.vod_name))
// 搜索时桩会额外塞两条解说条目，所以能返回数据的站点各有 4 条；
// 界面上应该只剩 2 张卡（解说被挡掉了）。
check('苹果CMS 搜到 4 条（含 2 条解说）', byKey.self_cms_base?.list?.length, 4)
check('占位符式 CMS 搜到 4 条（含 2 条解说）', byKey.self_cms_tpl?.list?.length, 4)
check('网页规则站搜到 2 条（列表页没有分类字段，桩不放解说）', byKey.self_html_ok?.list?.length, 2)
check('网页规则站取到详情页地址', byKey.self_html_ok?.list?.[0]?.vod_id, DETAIL_URL)
check('网页规则站海报补成绝对地址', byKey.self_html_ok?.list?.[0]?.vod_pic, POSTER_1)
check('异常码站点如实报错', byKey.self_cms_bad?.ok, false)
check('选择器失效站点如实报错', byKey.self_html_bad?.ok, false)
check('进度事件推了 5 次', seen.length, 5)
check('最后一次进度是 5/5', `${seen.at(-1)?.done}/${seen.at(-1)?.total}`, '5/5')
check('进度事件带站点标识', typeof seen.at(-1)?.site, 'string')
check('搜索请求带上了站点自定义请求头', state.lastHeaders?.['x-self-test'], '1')

const cmsDetail = JSON.parse(
  await evalJs(
    `window.api.detail.get('self_cms_base','1').then(d => JSON.stringify({
       name: d.vod_name,
       lines: d.lines.length,
       eps: d.lines.map(l => l.episodes.length),
       lineNames: d.lines.map(l => l.name),
       first: d.lines[0] && d.lines[0].episodes[0],
       content: d.vod_content
     })).catch(e => JSON.stringify({ error: e.message }))`
  )
)
check('CMS 详情取到片名', cmsDetail.name, '自检影片甲')
check('CMS 详情解析出 2 条线路', cmsDetail.lines, 2)
check('两条线路各自的集数解析正确', JSON.stringify(cmsDetail.eps), '[3,2]')
check('线路名解析正确', JSON.stringify(cmsDetail.lineNames), '["自检线路1","自检线路2"]')
check('第一集名称正确', cmsDetail.first?.name, '自检第01集')
check('第一集地址正确', cmsDetail.first?.url, MEDIA)
check('详情带上了简介', /自检简介/.test(cmsDetail.content ?? ''), true)

const htmlDetail = JSON.parse(
  await evalJs(
    `window.api.detail.get('self_html_ok','${DETAIL_URL}').then(d => JSON.stringify({
       name: d.vod_name,
       eps: d.lines[0] && d.lines[0].episodes.length,
       url: d.lines[0] && d.lines[0].episodes[0] && d.lines[0].episodes[0].url,
       content: d.vod_content
     })).catch(e => JSON.stringify({ error: e.message }))`
  )
)
check('网页规则站详情取到片名', htmlDetail.name, '自检影片甲')
check('网页规则站解析出 2 集', htmlDetail.eps, 2)
check('网页规则站剧集地址正确', htmlDetail.url, MEDIA)
check('网页规则站详情取到内容', /网页规则站的详情页/.test(htmlDetail.content ?? ''), true)

const players = JSON.parse(
  await evalJs(
    "window.api.player.detect().then(l => JSON.stringify(l)).catch(e => JSON.stringify({ error: e.message }))"
  )
)
check('外部播放器探测返回数组', Array.isArray(players), true)
console.log(
  '      本机检测到的播放器：' +
    (Array.isArray(players) && players.length
      ? players.map((p) => `${p.name} @ ${p.path}`).join(' | ')
      : '（没有 PotPlayer / mpv / VLC）')
)

await evalJs("location.hash = '#/search?wd=' + encodeURIComponent('自检')")
// 能返回数据的 3 个站点里，两条解说条目各命中 2 次；同名合并 + 过滤解说后应该只剩 2 张卡
await waitFor("document.querySelectorAll('.vod-card').length", (v) => v >= 2, 15000)
check('同名影片合并后只剩 2 张卡', await evalJs("document.querySelectorAll('.vod-card').length"), 2)
check(
  '带解说的片名被挡掉了（原始命中里确实有它们）',
  rawNames.filter((n) => n.includes('解说')).length,
  2
)
check(
  '片名干净但分类是「影视解说」的也被挡掉了',
  rawNames.filter((n) => n.includes('深度解读')).length,
  2
)
check(
  '搜索页提示挡掉了多少条解说',
  await evalJs("!!/已挡掉 \\d+ 条解说/.test(document.querySelector('.page-sub')?.textContent || '')"),
  true
)
check('搜索页给出站点筛选 chips', await evalJs("document.querySelectorAll('.chip').length"), (v) => v >= 4)
// 海报用的是 loading="lazy"：窗口不在前台时 Chromium 不会去加载它，
// 所以这里不去断言 naturalWidth，而是断言「地址正确」且「渲染进程真的能取到这张图」。
check(
  '海报地址都指向真实图床',
  await evalJs(
    "JSON.stringify([...document.querySelectorAll('.poster img')].map(i => i.src).sort())"
  ),
  JSON.stringify([POSTER_1, POSTER_2])
)
check(
  '海报图能从渲染进程取到（CSP 与网络都通）',
  await evalJs(
    `fetch(${JSON.stringify(POSTER_1)}).then(r => r.ok && r.headers.get('content-type').startsWith('image/')).catch(() => false)`
  ),
  true
)

await evalJs("location.hash = '#/detail/self_cms_base/1'")
await waitFor("document.querySelectorAll('.episode').length", (v) => v >= 3)
check('详情页渲染色集按钮', await evalJs("document.querySelectorAll('.episode').length"), 3)
check('详情页有线路切换', await evalJs("document.querySelectorAll('.section .chip').length"), 2)
check(
  '详情页列出可切换的片源（含当前这条）',
  await evalJs("document.querySelectorAll('#source-picker .source-item').length"),
  (v) => v >= 2
)
check(
  '当前片源在列表里被标成「正在看」',
  await evalJs(
    "!!document.querySelector('#source-picker .source-item.active .source-name')?.textContent?.includes('正在看')"
  ),
  true
)

await evalJs("location.hash = '#/play/self_cms_base/1/0/0'")
await waitFor("document.querySelectorAll('.player-stage video').length", (v) => v >= 1, 15000)
check('播放器已挂到页面上', await evalJs("document.querySelectorAll('.art-video-player').length"), 1)
check('播放器里有 video 元素', await evalJs("document.querySelectorAll('.player-stage video').length"), 1)
check('播放页侧栏列出 3 集', await evalJs("document.querySelectorAll('.player-episodes .episode').length"), 3)
check('播放页高亮当前集', await evalJs("document.querySelectorAll('.player-episodes .episode.active').length"), 1)
check(
  '播放页有下一集按钮',
  await evalJs("[...document.querySelectorAll('.player-bar .btn')].some(b => b.textContent.includes('下一集'))"),
  true
)
check(
  '播放地址展示出来了',
  await evalJs("!!document.querySelector('.player-url')?.textContent?.includes('.m3u8')"),
  true
)
check(
  '播放地址做成了可点的小方框（带浏览器打开按钮）',
  await evalJs("!!document.querySelector('button.player-url .player-url-go')"),
  true
)
check(
  '播放页列出了可切换的片源',
  await evalJs("document.querySelectorAll('.chip-source').length"),
  (v) => v >= 2
)
check(
  '当前片源在播放页被高亮',
  await evalJs("document.querySelectorAll('.chip-source.active').length"),
  1
)

check(
  '搜索 / 详情 / 播放全程没有 JS 异常',
  pageErrors.filter((e) => !/hls|manifest|frag|MEDIA_ERR|视频|网络/i.test(e)),
  []
)
if (pageErrors.length > errorsBeforeUi) {
  console.log(`      （播放器阶段另有 ${pageErrors.length - errorsBeforeUi} 条与假视频流相关的报错，属预期）`)
}

console.log('\n[7/13] 分类浏览（大类 → 子分类 → 滚动自动加载）')

state.lastTypes = []
state.lastPage = 0
state.pageCalls = []
state.typeCalls = []

const cats = await evalJs(
  `(async () => {
     const list = await window.api.category.list()
     return list.map((b) => ({
       name: b.name,
       subs: b.subs.map((s) => ({
         name: s.name,
         sites: s.sites.length,
         ids: s.sites.map((x) => x.typeIds.join(','))
       }))
     }))
   })()`
)
const allLeafIds = cats.flatMap((c) => c.subs).flatMap((s) => s.sites).flatMap((x) => x.typeIds)
const subOf = (bucket) => cats.find((c) => c.name === bucket)?.subs ?? []

check(
  '大类按顺序归并出来',
  cats.map((c) => c.name),
  ['电影', '电视剧', '动漫', '综艺', '纪录片', '短剧']
)
// 真实站点里「记录片」挂在电影片下面、写的是「记录」不是「纪录」，
// 漏了这个字它就会留在电影里（这是真出现过的 bug）。
check(
  '「记录片」归到了纪录片而不是电影',
  subOf('纪录片').map((s) => s.ids[0]),
  ['20']
)
check(
  '「短剧」从连续剧里拆出来归到短剧',
  subOf('短剧').map((s) => s.ids[0]),
  ['36']
)
check(
  '「动画片」归到了动漫',
  subOf('动漫').map((s) => s.ids[0]),
  ['49']
)
// 父分类 id 打头的是 1/2/3/4，叶子是 6/7/13/…，出现 1 就说明没展开成叶子。
check(
  '大类下面的子分类是叶子 id 而不是父分类 id',
  subOf('电影').map((s) => `${s.name}:${s.ids[0]}`),
  ['动作:6', '喜剧:7']
)
check('子分类里的「伦理片」整棵子树被丢掉', allLeafIds.includes('34'), false)
check(
  '顶层「电影解说」也没进目录',
  cats.some((c) => /解说/.test(c.name)) || allLeafIds.includes('35'),
  false
)
check(
  '每个子分类都覆盖桩上的 2 个站点',
  cats.every((c) => c.subs.every((s) => s.sites === 2)),
  true
)

await goto('#/search', '分类浏览')
const catCards = await waitFor("document.querySelectorAll('.cat-card').length", (v) => v >= 6)
check('目录页列出分类卡片', catCards, (v) => v >= 6)
check(
  '分类卡上标出子分类个数',
  await evalJs("document.querySelector('.cat-card .cat-meta')?.textContent ?? ''"),
  (v) => String(v).includes('个子分类')
)
check(
  '目录页副标题提示先选分类',
  await evalJs("document.querySelector('.page-sub')?.textContent ?? ''"),
  (v) => /选一个分类/.test(String(v))
)
check('还没有选分类时不出内容', await evalJs("document.querySelectorAll('.vod-card').length"), 0)

// ---- 选中大类：默认落在第一个子分类 ----
await evalJs(
  "[...document.querySelectorAll('.cat-card')].find((b) => b.textContent.startsWith('电影')).click()"
)
const firstPage = await waitFor("document.querySelectorAll('.vod-card').length", (v) => v >= 2, 15000)
check('选中大类后出海报卡', firstPage, (v) => v >= 2)
check(
  '大类里默认选中第一个子分类',
  await evalJs("document.querySelector('.page-sub')?.textContent ?? ''"),
  (v) => /电影 · 动作/.test(String(v))
)
const subChips = await evalJs(
  "[...document.querySelectorAll('.sub-bar .chip')].map((e) => e.textContent).join('|')"
)
check(
  '子分类条列出「全部」加每个子分类',
  ['全部', '动作', '喜剧'].every((n) => String(subChips).includes(n)),
  true
)
check('默认那一屏只查了叶子 6', state.typeCalls.every((t) => t.length === 1 && t[0] === '6'), true)
// 桩每页只给 2 条，一屏装不满，哨兵一开始就在视口里，所以自动加载会紧接着把
// 第 2 页也拉过来（pageCalls 变成 [1,1,2,2]）。这里只断言「头两次是第 1 页」。
check('首屏把两个站点都请求了第 1 页', state.pageCalls.slice(0, 2), [1, 1])

// ---- 切到「全部」：每个叶子各发一次请求，绝不并列进同一个 t ----
state.pageCalls = []
state.typeCalls = []
await evalJs(
  "[...document.querySelectorAll('.sub-bar .chip')].find((e) => e.textContent.includes('全部')).click()"
)
const allDeadline = Date.now() + 20000
while (
  !(
    state.typeCalls.some((t) => t[0] === '6') && state.typeCalls.some((t) => t[0] === '7')
  ) &&
  Date.now() < allDeadline
) {
  await sleep(300)
}
check(
  '「全部」把两个叶子都查了',
  [state.typeCalls.some((t) => t[0] === '6'), state.typeCalls.some((t) => t[0] === '7')],
  [true, true]
)
check(
  '每个请求只带一个叶子（重复 t 是「最后一个生效」，不能并列）',
  state.typeCalls.every((t) => t.length === 1),
  true
)
check('没有请求父分类 1 或伦理片 34', !state.typeCalls.some((t) => t[0] === '1' || t[0] === '34'), true)

// ---- 滚到底自动加载 ----
// 翻页不能把已经上屏的卡片重排：新一页里和前面同名的条目会让那一组多出一个源，
// 而默认排序的第一关键字就是源数，整块会跳到最前面 —— 看起来就是「一翻页全部刷新」。
const cardsBeforeMore = await evalJs("document.querySelectorAll('.vod-card').length")
const headBeforeMore = await evalJs(
  "[...document.querySelectorAll('.vod-card-title')].slice(0, 3).map((e) => e.textContent).join('|')"
)
state.pageCalls = []
await evalJs("document.querySelector('.app-content').scrollTop = 999999")
const scrolled = await waitFor(
  "document.querySelector('.load-more')?.textContent ?? ''",
  (v) => /第 [2-9]/.test(String(v)) || /到底了/.test(String(v)),
  20000
)
const cardsAfterMore = await waitFor(
  "document.querySelectorAll('.vod-card').length",
  (v) => v > cardsBeforeMore,
  20000
)
// 这里刻意断言「卡片变多了」而不是「又发了第 2 页的请求」：
// 首屏画完后后台已经把第 2 页预取好了，滚动时直接用现成的，不会再发请求。
check('滚到底后接上了下一页', cardsAfterMore > cardsBeforeMore, true)
check('加载状态在页面上有回显', /第 [2-9]|到底了/.test(String(scrolled)), true)

const headAfterMore = await evalJs(
  "[...document.querySelectorAll('.vod-card-title')].slice(0, 3).map((e) => e.textContent).join('|')"
)
if (headBeforeMore) {
  check('翻页后开头几张卡的位置没变', headAfterMore, headBeforeMore)
}

check(
  '分类浏览全程没有 JS 异常',
  pageErrors.filter((e) => !/hls|manifest|frag|MEDIA_ERR|视频|网络/i.test(e)),
  []
)

console.log('\n[8/13] 电视直播（m3u / txt 两种格式 + 跨源合并）')

const liveInfo = await evalJs(
  `window.api.live.load().then((r) => JSON.stringify({
     groups: r.groups.map((g) => g.name),
     total: r.total,
     merged: r.groups.reduce((n, g) => n + g.channels.length, 0),
     room: (r.groups.find((g) => g.name === '游戏赛事')?.channels ?? []).map((c) => ({
       name: c.name,
       url: c.urls[0]?.url
     })),
     sources: r.sources.map((s) => ({ name: s.name, channels: s.channels, error: s.error ?? null }))
   }))`
)
const live = JSON.parse(liveInfo)
const liveByName = Object.fromEntries(live.sources.map((s) => [s.name, s.channels]))
// 桩里：txt 源 4 条（央视频道 2 + 自检卫视 2）、m3u 源 3 条（自检卫视 + 自检纪录 + 自检停播台），
// 合并后 6 个不同频道。另外主进程永远会塞一路内置频道（danking直播），所以总数都比桩多 1。
check('内置自定义频道始终在，且只有 1 条', liveByName['内置自定义频道'], 1)
check(
  '两个桩直播源都拉到了频道',
  [liveByName['自检直播源（txt）'], liveByName['自检直播源（m3u）']],
  [4, 3]
)
check('跨源合并成 6 个频道（原始 8 条）', [live.merged, live.total], [6, 8])
check('归并出 5 个分组（含内置频道带来的游戏赛事）', live.groups, (v) => {
  const names = String(v).split(',')
  return names.length === 5 && names.includes('游戏赛事')
})
check('内置的房间频道用 huya:// 写法', live.room, [{ name: 'danking直播', url: 'huya://10188' }])
check(
  '分组名里的装饰符已被清掉',
  live.groups.filter((n) => /[•·「」【】]/.test(n)),
  []
)
check(
  '房间号必须是纯数字，否则直接拒绝',
  await evalJs(`window.api.live.resolve('huya://abc').then(() => 'ok').catch((e) => e.message)`),
  (v) => /不认识的房间地址/.test(String(v))
)

await goto('#/live', '电视直播')
check(
  '直播页副标题报出分组与频道数',
  await evalJs("document.querySelector('.page-sub')?.textContent ?? ''"),
  (v) => /5 个分组/.test(String(v)) && /6 个频道/.test(String(v))
)
check('左侧列出全部 5 个分组', await evalJs("document.querySelectorAll('.live-group').length"), 5)
// 默认落在频道最多的分组（央视频道，2 个频道）
check('默认分组列出它的频道', await evalJs("document.querySelectorAll('.live-channel').length"), 2)

await evalJs("[...document.querySelectorAll('.live-group')].find((b) => b.textContent.includes('自检卫视')).click()")
const multi = await waitFor("document.querySelectorAll('.live-channel').length", (v) => v >= 1)
check('切到自检卫视分组只剩 1 个频道', multi, 1)
check(
  '同名频道跨源合并成 2 条线路',
  await evalJs("document.querySelector('.live-channel-lines')?.textContent ?? ''"),
  '2 线'
)

await evalJs("document.querySelector('.live-channel').click()")
// 点频道时若这条还没轮到后台预热体检，play() 会当场探一遍再挂播放器，
// 而单条探测的超时上限是 12s（liveHealth.ts 的 min(settings.timeout, 12)）。
// 等待必须明显大于 12s，否则预热还没轮到该频道时会假失败（曾偶发 176/177）。
const mounted = await waitFor("document.querySelectorAll('.live-stage video').length", (v) => v >= 1, 30000)
check('点频道后播放器挂起来了', mounted, (v) => v >= 1)
check(
  '播放器上标出当前频道',
  await evalJs("document.querySelector('.live-stage-name')?.textContent ?? ''"),
  '自检卫视'
)

// React 是受控输入：直接改 .value 再派发 input 事件不会触发 onChange，
// 必须走原型上的原生 setter 改写，React 的值追踪器才会认为值变了。
await evalJs(
  `(() => {
     const input = document.querySelector('.live-search input')
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
     setter.call(input, 'CCTV')
     input.dispatchEvent(new Event('input', { bubbles: true }))
   })()`
)
const searched = await waitFor("document.querySelectorAll('.live-channel').length", (v) => v >= 2)
check('搜索频道名能跨分组过滤', searched, 2)

// ---------- 线路体检 ----------
// 直播页进分组后 400ms 会自己在后台预热，这里显式跑一遍好断言。
const healthInfo = await evalJs(
  `window.api.live.probe(${JSON.stringify([MEDIA, MEDIA_2, DEAD_MEDIA])}, { force: true }).then((h) => JSON.stringify({
     asked: Object.keys(h).length,
     live: h[${JSON.stringify(MEDIA)}],
     dead: h[${JSON.stringify(DEAD_MEDIA)}]
   }))`
)
const health = JSON.parse(healthInfo)
check('体检表按地址记结果', health.asked, (v) => v >= 3)
check(
  '能拉起来的线路标成可用',
  { ok: health.live?.ok, err: health.live?.error ?? null },
  { ok: true, err: null }
)
check(
  '404 的线路标成不可用并写清原因',
  { ok: health.dead?.ok, err: health.dead?.error },
  { ok: false, err: 'HTTP 404' }
)
check(
  '体检结果会留在磁盘上（下次打开不用重探）',
  await evalJs(`window.api.live.health().then((h) => Boolean(h[${JSON.stringify(MEDIA)}]?.ok))`),
  true
)

// 死链频道默认被藏起来：切到「自检停播」分组，等后台体检跑完，那张卡应该消失
await evalJs(
  "[...document.querySelectorAll('.live-group')].find((b) => b.textContent.includes('自检停播'))?.click()"
)
const deadHidden = await waitFor("document.querySelectorAll('.live-channel').length", (v) => v === 0, 15000)
check('整组都是死链时频道默认被藏起来', deadHidden, 0)
check(
  '顶部给出「显示 N 个不可用」开关',
  await evalJs("[...document.querySelectorAll('.live-channels-head button')].map((b) => b.textContent.trim())"),
  (v) => String(v).includes('显示 1 个不可用')
)
await evalJs("document.querySelector('.live-channels-head button')?.click()")
check(
  '点开后能看到被藏起来的频道，并标成不可用',
  await waitFor("document.querySelectorAll('.live-channel.is-dead').length", (v) => v >= 1, 8000),
  (v) => v >= 1
)
// 桩的地址不该留在体检表里陪跑真实源
check('清空体检表', await evalJs('window.api.live.clearHealth().then((h) => Object.keys(h).length)'), 0)

check(
  '电视直播全程没有 JS 异常',
  pageErrors.filter((e) => !/hls|manifest|frag|MEDIA_ERR|视频|网络/i.test(e)),
  []
)

console.log('\n[9/13] 收藏与观看历史')

// 先把收藏与历史清干净，否则上一次跑留下的数据会让数目对不上。
// 备份在脚本开头就做好了（那时还没跑过任何一段），还原在脚本末尾。
await evalJs('window.api.library.clearFavorites()')
await evalJs('window.api.library.clearHistory()')

await evalJs("location.hash = '#/detail/self_cms_base/1'")
await waitFor(
  "[...document.querySelectorAll('.detail-actions .btn')].some(b => b.textContent.includes('收藏'))",
  (v) => v === true,
  15000
)
check(
  '详情页有收藏按钮，初始是未收藏',
  await evalJs(
    "(() => { const b = [...document.querySelectorAll('.detail-actions .btn')].find(x => x.textContent.includes('收藏')); return b ? b.textContent.trim() : '' })()"
  ),
  '收藏'
)

await evalJs(
  "[...document.querySelectorAll('.detail-actions .btn')].find(b => b.textContent.includes('收藏')).click()"
)
const favBtn = await waitFor(
  "(() => { const b = [...document.querySelectorAll('.detail-actions .btn')].find(x => x.textContent.includes('收藏')); return b ? b.textContent.trim() : '' })()",
  (v) => v === '已收藏'
)
check('点收藏后按钮变成已收藏', favBtn, '已收藏')
check(
  '收藏落到了数据文件里',
  JSON.parse(
    await evalJs("window.api.library.get().then(l => JSON.stringify(l.favorites.length))")
  ),
  1
)

// 重新进详情页，验证收藏是持久化的而不是只活在内存里
await goto('#/sites', '影视源')
await evalJs("location.hash = '#/detail/self_cms_base/1'")
const persisted = await waitFor(
  "(() => { const b = [...document.querySelectorAll('.detail-actions .btn')].find(x => x.textContent.includes('收藏')); return b ? b.textContent.trim() : '' })()",
  (v) => v === '已收藏',
  15000
)
check('重新进入详情页收藏状态还在', persisted, '已收藏')

// 播放一次，看历史有没有记下「第 2 集」
await evalJs("location.hash = '#/play/self_cms_base/1/0/1'")
await waitFor("document.querySelectorAll('.player-stage video').length", (v) => v >= 1, 15000)
const recorded = await waitFor(
  "window.api.library.get().then(l => l.history.length)",
  (v) => v >= 1,
  10000
)
check('播放后自动记了一条观看历史', recorded, (v) => v >= 1)
check(
  '历史里记的是当前这一集',
  JSON.parse(
    await evalJs(
      // 注意 history 是「一部剧一条」的分组，真正的记录在 items[0]
      "window.api.library.get().then(l => JSON.stringify({ ep: l.history[0]?.items?.[0]?.epName, line: l.history[0]?.items?.[0]?.lineIndex, ep2: l.history[0]?.items?.[0]?.epIndex, name: l.history[0]?.items?.[0]?.name }))"
    )
  ),
  { ep: '自检第02集', line: 0, ep2: 1, name: '自检影片甲' }
)

await goto('#/library', '收藏与历史')
check('收藏页显示 1 张收藏卡', await evalJs("document.querySelectorAll('.vod-card').length"), 1)
check(
  '收藏页副标题报出收藏数与历史数',
  await evalJs("document.querySelector('.page-sub')?.textContent ?? ''"),
  (v) => /收藏 1 部/.test(String(v)) && /观看记录 1 条/.test(String(v))
)

await evalJs(
  "[...document.querySelectorAll('.chips .chip')].find(c => c.textContent.includes('观看历史')).click()"
)
const histRows = await waitFor("document.querySelectorAll('.history-row').length", (v) => v >= 1)
check('历史栏列出 1 条记录', histRows, 1)
check(
  '历史行里有继续观看按钮',
  await evalJs(
    "[...document.querySelectorAll('.history-actions .btn')].some(b => b.textContent.includes('继续观看'))"
  ),
  true
)

// 首页的「继续观看」用的就是同一份历史
await goto('#/', '')
check('首页出现继续观看区块', await evalJs("document.querySelectorAll('.continue-card').length"), 1)

// 取消收藏，确认能回到 0
await goto('#/library', '收藏与历史')
await evalJs("document.querySelector('.vod-card .btn-ghost')?.click()")
const afterRemove = await waitFor("document.querySelectorAll('.vod-card').length", (v) => v === 0)
check('取消收藏后收藏清零', afterRemove, 0)

// 同一部剧换个源再看一次：历史里应该还是**一条**，并且给出可切换的源
await evalJs("location.hash = '#/play/self_cms_tpl/1/0/0'")
await waitFor("document.querySelectorAll('.player-stage video').length", (v) => v >= 1, 15000)
const mergedCount = await waitFor(
  "window.api.library.get().then(l => l.history.length)",
  (v) => v === 1,
  10000
)
check('同一部剧在两个源上只算一条历史', mergedCount, 1)
check(
  '这条历史里收着两个源的记录',
  JSON.parse(
    await evalJs(
      "window.api.library.get().then(l => JSON.stringify({ n: l.history[0]?.items?.length ?? 0, src: (l.history[0]?.items ?? []).map(i => i.siteKey).sort().join(',') }))"
    )
  ),
  (v) => v.n === 2 && v.src === 'self_cms_base,self_cms_tpl'
)

await goto('#/library', '收藏与历史')
await evalJs(
  "[...document.querySelectorAll('.chips .chip')].find(c => c.textContent.includes('观看历史')).click()"
)
const srcChips = await waitFor("document.querySelectorAll('.history-sources .chip').length", (v) => v === 2)
check('历史行上给出两个源可以切换', srcChips, 2)
check('两个源时历史仍然只有一行', await evalJs("document.querySelectorAll('.history-row').length"), 1)

check(
  '收藏与历史全程没有 JS 异常',
  pageErrors.filter((e) => !/hls|manifest|frag|MEDIA_ERR|视频|网络/i.test(e)),
  []
)

console.log('\n[10/13] AI 剧情总结（点击才请求）')

check(
  'window.api.ai.summarize 是函数',
  await evalJs('typeof window.api.ai?.summarize'),
  'function'
)

check(
  'window.api.ai.summarizeVisual 是函数（看片模式）',
  await evalJs('typeof window.api.ai?.summarizeVisual'),
  'function'
)

// 有人在设置里填过真 Key 时，这里刻意**不**发请求：自检不该花用户的钱，
// 也不该依赖外网。所以只按「有没有 Key」分别断言界面该有的样子。
const hasKey = JSON.parse(
  await evalJs(
    "window.api.settings.get().then((s) => JSON.stringify(Boolean((s.ai?.apiKey ?? '').trim())))"
  )
)

if (!hasKey) {
  // 没 Key 时主进程在发请求之前就抛了，这条同时证明它不会偷偷联网
  const noKey = await evalJs(
    "window.api.ai.summarize({ vodName: '自检影片甲', epName: '第01集', epIndex: 0, epTotal: 2 })" +
      ".then(() => 'ok', (e) => e.message)"
  )
  check('没配 API Key 时给出明确提示', /还没有配置 DeepSeek API Key/.test(noKey), true)
}

await goto('#/play/self_cms_base/1/0/1', '自检影片甲')
await waitFor("document.querySelectorAll('.ai-block').length", (v) => v >= 1)

const ai = JSON.parse(
  await evalJs(`JSON.stringify({
    blocks: document.querySelectorAll('.ai-block').length,
    sub: document.querySelector('.ai-sub')?.textContent?.trim() ?? '',
    hint: document.querySelector('.ai-hint')?.textContent?.trim() ?? '',
    primary: document.querySelector('.ai-head .btn-primary')?.textContent?.trim() ?? '',
    disabled: document.querySelector('.ai-head .btn')?.disabled ?? null,
    body: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 160),
    hash: location.hash,
    title: document.querySelector('.page-title')?.textContent?.trim() ?? '',
    afterUrl: (() => {
      const url = document.querySelector('.player-url')
      const block = document.querySelector('.ai-block')
      if (!url || !block) return false
      return Boolean(url.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING)
    })()
  })`)
)

check('AI 区块只出现一次', ai.blocks, 1)
console.log(`    （诊断）页面开头：${ai.body}`)
console.log(`    （诊断）hash=${ai.hash} title=${ai.title}`)
check('AI 区块排在视频地址下面', ai.afterUrl, true)
check('区块说明写明点了才开始', /点了才开始/.test(ai.sub), true)
check('主动作是「看一遍再总结」而不是纯文本推断', /看一遍再总结/.test(ai.primary), true)

if (hasKey) {
  check('配了 Key 时按钮可以点', ai.disabled, false)
  check('配了 Key 时不显示设置引导', /还没有配置/.test(ai.hint), false)
  check('开始时说明会抽帧、以及画面没有声音', /抓一张画面/.test(ai.hint) && /没有声音/.test(ai.hint), true)
} else {
  check('没配 Key 时按钮是禁用的', ai.disabled, true)
  check('没配 Key 时给出设置入口', /设置/.test(ai.hint), true)
}

console.log('\n[11/13] 解析接口（本地桩：读分享页 / 兜底问接口 / 坏的排后面）')

// 这一段的桩都在本地，不碰外网。跑完只删自己加的那两条，不碰你自己的解析接口。
const existingParses = JSON.parse(
  await evalJs('window.api.parse.list().then(l => JSON.stringify(l.map(p => p.url)))')
)
const PARSE_OK = `${BASE}/parse-api?url=`
const PARSE_BAD = `${BASE}/parse-bad?url=`

/** resolve 一次，只把关心的几个字段带回来（attempts 太长） */
const resolveOne = async (url, options) => {
  const raw = await evalJs(
    `window.api.parse.resolve(${JSON.stringify(url)}, ${JSON.stringify(options ?? {})}).then(r => JSON.stringify(r))`
  )
  const r = JSON.parse(raw)
  return {
    ok: r.ok,
    url: r.url,
    direct: r.direct,
    who: r.parseName,
    n: r.attempts.length,
    err: r.error,
    tries: r.attempts.map((a) => (a.ok ? 'ok' : a.name)).join(',')
  }
}

// 0. 自检配置里自己带了一条 parses：「自检解析」。它应该跟着配置源一起出现在列表里，
//    来源标成 config（这条接口地址在桩上是故意不存在的，正好顺便看看会不会被判失败）。
const fromConfig = JSON.parse(
  await evalJs(
    'window.api.parse.list().then(l => JSON.stringify(l.filter(p => p.origin === "config").map(p => p.name)))'
  )
)
check('配置里带的解析接口会出现在列表里', fromConfig, ['自检解析'])

// 1. 本来就是直链的，不该白跑一趟解析
const asDirect = await resolveOne(MEDIA)
check('直链原样返回、标成 direct', { ok: asDirect.ok, direct: asDirect.direct, url: asDirect.url }, {
  ok: true,
  direct: true,
  url: MEDIA
})
check('直链不做任何尝试', asDirect.n, 0)

// 2. 分享页把地址写在脚本里 —— 应用自己读一遍就够，用不到解析接口
const easy = await resolveOne(`${BASE}/share/easy`)
check('分享页里能直接读出 m3u8', { ok: easy.ok, url: easy.url }, { ok: true, url: MEDIA })
check('这条路标成「直接从播放页里取」', easy.who, '直接从播放页里取')

// 3. 什么都读不出来的分享页，必须靠解析接口兜底
await evalJs(
  `window.api.parse.add(${JSON.stringify({ name: '自检解析（可用）', url: PARSE_OK, flags: [] })})`
)
await evalJs(
  `window.api.parse.add(${JSON.stringify({ name: '自检解析（停用）', url: PARSE_BAD, flags: [] })})`
)
const hard = await resolveOne(`${BASE}/share/hard`)
check('读不出来时兜底问解析接口', { ok: hard.ok, url: hard.url }, { ok: true, url: `${BASE}/media/live2.m3u8` })
check('用的是那个可用的接口', hard.who, '自检解析（可用）')
// 这条证明它是「轮询」而不是只问一条 —— 至少走了「自己读一遍 + 问接口」两条路子
check('兜底时会往下轮询，不是只问一条就放弃', hard.n > 1, true)

// 3b. 失败轮询 + 可用性排行：只留那条停用的接口，应当被真的问一遍并且记下失败；
//     再把可用的加回来，下一次就应当绕过失败的那条、直接用可用的。
await evalJs(`window.api.parse.remove(${JSON.stringify(PARSE_OK)})`)
const onlyBad = await resolveOne(`${BASE}/share/hard`)
check('只剩坏接口时如实报失败', onlyBad.ok, false)
check('坏接口确实被问过一遍（不是跳过了事）', /自检解析（停用）/.test(onlyBad.tries), true)

await evalJs(
  `window.api.parse.add(${JSON.stringify({ name: '自检解析（可用）', url: PARSE_OK, flags: [] })})`
)
const afterFail = await resolveOne(`${BASE}/share/hard`)
check('失败过的接口沉到后面，下次直接用成功过的', afterFail.who, '自检解析（可用）')

// 4. 坏接口会被标成失败，并且排到后面去
const badTest = JSON.parse(
  await evalJs(`window.api.parse.test(${JSON.stringify(PARSE_BAD)}).then(r => JSON.stringify(r))`)
)
check('停用的接口被测出失败', badTest.ok, false)
check('失败原因写清楚了', /接口已停用|没有拿到/.test(badTest.error ?? ''), true)

const afterTests = JSON.parse(
  await evalJs(
    `window.api.parse.list().then(l => JSON.stringify(l.filter(p => p.url === ${JSON.stringify(PARSE_BAD)})[0]))`
  )
)
check('失败一次会记进战绩', afterTests.stat.fail >= 1, true)

// 战绩是分开记的：成功过的那条记 ok，失败过的那条记 fail。
// （「谁排在谁前面」不在这里断言 —— parse.list() 给的是插入顺序，
//  真正的排行走的是 resolve 时的 orderParses()，上面 3b 已经用实际解析结果验过了。）
const allStats = JSON.parse(
  await evalJs(
    `window.api.parse.list().then(l => JSON.stringify(Object.fromEntries(l.map(p => [p.url, p.stat]))))`
  )
)
check(
  '战绩分开记：成功过的记 ok、失败过的记 fail、而且不互相污染',
  {
    okOk: allStats[PARSE_OK]?.ok >= 1,
    okFail: allStats[PARSE_OK]?.fail,
    badFail: allStats[PARSE_BAD]?.fail >= 1,
    badOk: allStats[PARSE_BAD]?.ok
  },
  { okOk: true, okFail: 0, badFail: true, badOk: 0 }
)

// 5. 收拾干净：只删自己加的那两条
for (const url of [PARSE_OK, PARSE_BAD]) {
  await evalJs(`window.api.parse.remove(${JSON.stringify(url)})`)
}
const leftOver = JSON.parse(
  await evalJs('window.api.parse.list().then(l => JSON.stringify(l.map(p => p.url)))')
)
check('跑完没有留下自检用的解析接口', leftOver, existingParses)

console.log('\n[12/13] 首页内容位（配置里的 home.sections 优先）')
const homeSections = JSON.parse(
  await evalJs(
    `window.api.home.sections(true).then(s => JSON.stringify(s.map(x => ({ title: x.title, origin: x.origin, siteKey: x.siteKey ?? null, n: x.items.length, first: x.items[0]?.vod_name ?? null, error: x.error ?? null }))))`
  )
)
check(
  '配置里写了几条就是几条（走的是 tvboxDesktop.home.sections 这个命名空间）',
  homeSections.map((s) => s.title),
  ['自检·最近更新（按站点 key）', '自检·分类推荐（按中文名 + 指定分类）', '自检·写了个不存在的源']
)
check('来自配置的内容位标成 config 而不是走默认', homeSections.map((s) => s.origin), ['config', 'config', 'config'])
// 不指定 typeId 时拉的是「最近更新」（ac=detail&pg=1，不带 t）
check('按站点 key 找得到源并拉到内容', homeSections[0].siteKey === 'self_cms_base' && homeSections[0].n > 0, true)
// 配置里写的是中文名，得能对上站点
check('按中文名也能找到源', homeSections[1].siteKey, 'self_cms_tpl')
// 指定了 typeId 就得走分类浏览的地址（桩上 t=6 返回的是「自检分类片6第N页之M」）
check(
  '指定了分类就按分类拉，而不是拿最近更新糊弄',
  /^自检分类片6第1页之\d+$/.test(homeSections[1].first ?? ''),
  true
)
check(
  '写错的源只让那一行报错，不拖累别的行',
  homeSections[2].n === 0 && /这个站点不存在/.test(homeSections[2].error ?? ''),
  true
)

// 界面：首页得真的把内容位画出来。写错的第三条没有内容、只有一行错误文字，
// 所以只有两行 .home-row —— 这本身就说明错误的那条没把别人带坏。
await goto('#/', 'TVBox Desktop')
await sleep(600)
const homeDom = JSON.parse(
  await evalJs(
    `JSON.stringify({ rows: document.querySelectorAll('.home-row').length, cards: document.querySelectorAll('.home-row .vod-card').length, first: document.querySelector('.home-row .vod-card-title')?.textContent?.trim() ?? '' })`
  )
)
check('首页把拉到的内容位画成了两条横排（写错的那条只有文字）', homeDom.rows, 2)
check('内容位里的卡片真的渲染出来了', homeDom.cards > 0, true)
check('第一条卡片有片名', homeDom.first.length > 0, true)

console.log('\n[13/13] 外部播放器（检测 + 兜底的地址校验）')
// 这一步在每台机器上的结果都不一样（谁的电脑上装了什么播放器就有什么），
// 所以只能断言「形状对」和「非法输入会被挡住」，不能断言找到几个。
const localPlayers = JSON.parse(await evalJs('window.api.player.detect().then(p => JSON.stringify(p))'))
check('检测本机播放器返回的是数组', Array.isArray(localPlayers), true)
check(
  '检测出来的每一条都有名字和路径',
  localPlayers.every(
    (p) => typeof p.name === 'string' && p.name.length > 0 && typeof p.path === 'string' && p.path.length > 0
  ),
  true
)
check(
  '检测出来的都是 exe',
  localPlayers.every((p) => /\.exe$/i.test(p.path)),
  true
)
// openInPlayer 先校验协议、再去找播放器，所以这条不会真的弹出播放器窗口
const badProtocol = await evalJs(
  `window.api.player.open('javascript:alert(1)', '').then(() => 'opened', (e) => String(e && e.message))`
)
check('外部播放器不认的协议会被挡住', /不是受支持的协议/.test(badProtocol), true)

// 界面：设置页那块的按钮得在，点了之后得给出「找到 N 个」或「一个都没找到」
await goto('#/settings', '设置')
const playerDom = JSON.parse(
  await evalJs(
    `(() => {
       const label = [...document.querySelectorAll('.field > label')].find((e) => e.textContent.trim() === '本机播放器')
       const btn = label?.parentElement?.querySelector('button')
       if (!btn) return JSON.stringify({ btn: false })
       btn.click()
       return JSON.stringify({ btn: true, text: btn.textContent.trim() })
     })()`
  )
)
check('设置页有「检测本机播放器」按钮', playerDom.btn && /检测本机播放器/.test(playerDom.text ?? ''), true)
await sleep(1200)
const playerResult = await evalJs(
  `(() => {
     const label = [...document.querySelectorAll('.field > label')].find((e) => e.textContent.trim() === '本机播放器')
     return label?.parentElement?.querySelector('.fs-12')?.textContent?.trim() ?? ''
   })()`
)
check('点完会给出结果，而不是一直转圈', /找到 \d+ 个|一个都没找到/.test(playerResult), true)
console.log(`    （诊断）本机播放器：${localPlayers.length} 个，界面提示：${playerResult}`)

// 把使用者原本的收藏与观看记录放回去。放在最后是因为 [10/13] 也会开播放页、
// 也会往历史里写一条。
await evalJs('window.api.library.clearFavorites()')
await evalJs('window.api.library.clearHistory()')
for (const f of [...(libraryBackup.favorites ?? [])].reverse()) {
  await evalJs(`window.api.library.toggleFavorite(${JSON.stringify(f)})`)
}
for (const g of [...(libraryBackup.history ?? [])].reverse()) {
  for (const h of [...(g.items ?? [])].reverse()) {
    await evalJs(`window.api.library.record(${JSON.stringify(h)})`)
  }
}
const restored = JSON.parse(
  await evalJs(
    'window.api.library.get().then(l => JSON.stringify({ fav: l.favorites.length, hist: l.history.length, histItems: l.history.reduce((n, g) => n + g.items.length, 0) }))'
  )
)
const before = {
  fav: (libraryBackup.favorites ?? []).length,
  items: (libraryBackup.history ?? []).reduce((n, g) => n + (g.items?.length ?? 0), 0)
}
console.log(
  `\n已还原你原本的收藏与观看记录：${restored.fav} 部收藏 / ${restored.histItems} 条历史` +
    `（分组后 ${restored.hist} 组；原来 ${before.fav} / ${before.items}）`
)
if (restored.fav !== before.fav || restored.histItems !== before.items) {
  console.log('  ⚠️ 还原后的条数和原来对不上，请检查')
}

const failed = checks.filter((c) => !c.pass)
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length) console.log('失败项：' + failed.map((f) => f.name).join('、'))

ws.close()
stub.close()
process.exit(failed.length ? 1 : 0)
