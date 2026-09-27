/**
 * 开发用：把一段 JS 表达式丢进正在运行的 dev 窗口里执行，打印返回值。
 *
 * 用法： node scripts/eval.mjs "document.title"
 *        node scripts/eval.mjs --goto "#/sites" "document.querySelectorAll('.list-row').length"
 *
 * 前置：另一个终端跑着 npm run dev:debug
 */
const CDP = 'http://127.0.0.1:9222'
const argv = process.argv.slice(2)

let waitMs = 600
let toFront = false
const args = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--wait') {
    waitMs = Number(argv[++i])
  } else if (argv[i] === '--front') {
    toFront = true
  } else {
    args.push(argv[i])
  }
}

const targets = await (await fetch(`${CDP}/json`)).json()
const page = targets.find((t) => t.type === 'page' && /localhost:5173/.test(t.url)) ?? targets.find((t) => t.type === 'page')
if (!page) {
  console.error('调试端口里没有页面目标，请先 npm run dev:debug')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params = {}) => {
  const msgId = ++id
  ws.send(JSON.stringify({ id: msgId, method, params }))
  return new Promise((r) => pending.set(msgId, r))
}
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result)
    pending.delete(msg.id)
  }
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable')

const evalJs = async (expr) => {
  const res = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  })
  if (res?.exceptionDetails) return `THREW: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`
  return res?.result?.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 窗口被遮挡 / 最小化时 document.visibilityState 是 hidden，rAF 与 IntersectionObserver
// 都会被完全节流（一次回调都不发）。要验证滚动加载这类依赖渲染帧的逻辑，必须先
// 把页面提到前台并强制「聚焦」，否则测出来的永远是「没反应」。
if (toFront) {
  await send('Page.enable')
  await send('Page.bringToFront')
  await send('Page.setWebLifecycleState', { state: 'active' })
  try {
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  } catch {
    // 老版本 Chromium 没有这个域，忽略
  }
  await sleep(500)
}

for (const arg of args) {
  if (arg.startsWith('#')) {
    await evalJs(`location.hash = ${JSON.stringify(arg)}`)
    await evalJs(
      `(() => { if (!document.getElementById('__dbg')) { const s = document.createElement('style'); s.id='__dbg'; s.textContent='*,*::before,*::after{animation:none!important;transition:none!important}'; document.head.appendChild(s); } })()`
    )
    await sleep(waitMs)
  } else {
    const value = await evalJs(arg)
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  }
}

ws.close()
