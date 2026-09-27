/**
 * 开发用截图脚本：通过 CDP 驱动已经跑起来的 dev 窗口。
 *
 * 用法：
 *   node scripts/shot.mjs                      # 按固定顺序拍全部
 *   node scripts/shot.mjs home sites           # 只拍指定的几张
 *   node scripts/shot.mjs search --wd=某剧名    # 换搜索关键词
 *   node scripts/shot.mjs player --keep        # 不重载页面，保留当前 store 状态
 *
 * --keep 的用处：播放页的「片源」列表来自内存里的搜索结果，
 * 重载一下 store 就空了，只能拍到「只找到这一个片源」。想拍带片源列表的
 * 播放页，先用 eval.mjs 搜一次再带着 --keep 拍。
 *
 * 前置：
 *   1. 另一个终端跑着 npm run dev:debug
 *   2. 应用里已添加配置源；--keep 模式下还需要先跑过搜索
 */
import { writeFileSync } from 'node:fs'

const CDP = 'http://127.0.0.1:9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const argv = process.argv.slice(2)
const flags = argv.filter((a) => a.startsWith('--'))
const only = argv.filter((a) => !a.startsWith('--'))
const keep = flags.includes('--keep')
const pick = (key, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${key}=`))
  return hit ? hit.slice(key.length + 3) : fallback
}
const wd = pick('wd', '自检')
const site = pick('site', 'self_cms_base')
const id = pick('id', '1')
const line = pick('line', '0')
const ep = pick('ep', '0')

const list = await (await fetch(`${CDP}/json/list`)).json()
const page =
  list.find((t) => t.type === 'page' && t.url.includes('localhost:5173')) ??
  list.find((t) => t.type === 'page')
if (!page) {
  console.error('没有找到渲染进程页面：', list.map((t) => `${t.type} ${t.url}`))
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})

let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})

function send(method, params = {}) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJs(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text)
  return res.result?.value
}

async function shot(hash, name, wait = 1000, after) {
  await evalJs(`location.hash = ${JSON.stringify(hash)}`)
  await sleep(wait)
  if (after) {
    await evalJs(after)
    await sleep(3000)
  }
  // 窗口不在前台时 Chromium 会节流合成器，入场动画可能被冻在中途；
  // 截图前先把动画与过渡关掉，拿到的才是稳定态。
  await evalJs(
    `(() => { let s = document.getElementById('__shot'); if (!s) { s = document.createElement('style'); s.id = '__shot'; s.textContent = '*,*::before,*::after{animation:none !important;transition:none !important}'; document.head.appendChild(s); } })()`
  )
  await sleep(150)
  // 窗口被遮挡 / 最小化时 captureScreenshot 会返回整张白图，先把它提到前台
  await send('Page.bringToFront')
  await sleep(200)
  const res = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  writeFileSync(`shots/${name}.png`, Buffer.from(res.data, 'base64'))
  const note = await evalJs("document.querySelector('.page-title')?.textContent ?? document.body.innerText.slice(0, 40)")
  console.log(`shots/${name}.png  ← ${note}`)
}

// 先重载一次：Search 页用 ref 记住「这个关键词搜过了」，不重载的话
// 换关键词可能不触发新的搜索。--keep 时跳过，保留内存里的搜索结果。
if (!keep) {
  await evalJs('location.reload()')
  await sleep(2500)
}

const all = [
  ['#/', 'firstrun', 1200],
  ['#/', 'home', 9000],
  [
    '#/',
    'home-rows',
    9000,
    `document.querySelectorAll('.section')[1]?.scrollIntoView({ block: 'start' })`
  ],
  ['#/sites', 'sites', 900],
  ['#/settings', 'settings', 900],
  [
    '#/settings',
    'settings-ai',
    1200,
    `[...document.querySelectorAll('.section-title')].find((e) => e.textContent === 'AI 总结')?.closest('.section')?.scrollIntoView({ block: 'start' })`
  ],
  [
    '#/settings',
    'settings-parse',
    1600,
    `[...document.querySelectorAll('.section-title')].find((e) => e.textContent === '解析接口')?.closest('.section')?.scrollIntoView({ block: 'start' })`
  ],
  [
    '#/settings',
    'settings-player',
    1600,
    `(() => {
       const label = [...document.querySelectorAll('.field > label')].find((e) => e.textContent.trim() === '本机播放器')
       label?.parentElement?.querySelector('button')?.click()
       setTimeout(() => label?.scrollIntoView({ block: 'center' }), 900)
     })()`
  ],
  [
    '#/live',
    'live',
    30000,
    `document.querySelectorAll('.live-channel')[0]?.click()`
  ],
  ['#/library', 'library', 1400],
  [
    '#/library',
    'library-history',
    1400,
    `[...document.querySelectorAll('.chip')].find((e) => e.textContent.startsWith('观看历史'))?.click()`
  ],
  [
    '#/live',
    'live-game',
    6500,
    `[...document.querySelectorAll('.live-group')].find((e) => e.textContent.includes('游戏赛事'))?.click()`
  ],
  ['#/search', 'browse', 3500],
  [
    '#/search',
    'browse-sub',
    3500,
    `[...document.querySelectorAll('.cat-card')].find((e) => e.textContent.startsWith('电影'))?.click()`
  ],
  [`#/search?wd=${/%/.test(wd) ? wd : encodeURIComponent(wd)}`, 'search', 3000],
  [`#/detail/${site}/${id}`, 'detail', 1800],
  [`#/play/${site}/${id}/${line}/${ep}`, 'player', 2600]
]

for (const [hash, name, wait, after] of all) {
  if (only.length && !only.includes(name)) continue
  await shot(hash, name, wait, after)
}

ws.close()
