/**
 * 把一个本地配置 JSON 推进正在运行的应用里，然后逐站测试、真搜一次。
 *
 * 用法： node scripts/apply-sources.mjs samples/public-sources.json [关键词]
 * 前置： 另一个终端跑着 npm run dev:debug，且桩服务器不需要（这里打的是真站点）
 */
const CDP = 'http://127.0.0.1:9222'
const configPath = process.argv[2]
const keyword = process.argv[3] ?? '庆余年'
if (!configPath) {
  console.error('用法：node scripts/apply-sources.mjs <配置.json> [关键词]')
  process.exit(1)
}

const targets = await (await fetch(`${CDP}/json`)).json()
const page =
  targets.find((t) => t.type === 'page' && /localhost:5173/.test(t.url)) ??
  targets.find((t) => t.type === 'page')
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
  if (res?.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
  }
  return res?.result?.value
}

// ── 1. 清掉旧配置源，只留这一个 ──────────────────────────────────────────
const removed = await evalJs(`(async () => {
  const old = await window.api.sources.list()
  for (const s of old) await window.api.sources.remove(s.id)
  return old.map(s => s.name)
})()`)
console.log(`清掉旧配置源 ${removed.length} 个：${removed.join('、') || '（无）'}`)

// ── 2. 添加并同步 ────────────────────────────────────────────────────────
const added = await evalJs(
  `window.api.sources.add({ name: '公开可用源', url: ${JSON.stringify(configPath)}, kind: 'file' })`
)
console.log(`已添加配置源：${added.name}  ${added.url}`)
const synced = await evalJs(`window.api.sources.sync(${JSON.stringify(added.id)})`)
console.log(
  `同步结果：${synced.error ? `失败（${synced.error}）` : '成功'}` +
    `  站点 ${synced.siteCount ?? '?'} · 直播 ${synced.liveCount ?? '?'} · 解析 ${synced.parseCount ?? '?'}` +
    `  最近同步 ${synced.lastSync ? new Date(synced.lastSync).toLocaleTimeString('zh-CN') : '—'}`
)

// ── 3. 列出站点 ──────────────────────────────────────────────────────────
const sites = await evalJs(`window.api.sites.list()`)
console.log(`\n归一化后 ${sites.length} 个站点：`)
for (const s of sites) {
  console.log(`  · ${s.name.padEnd(16)} type=${s.type}  可搜索=${s.searchable}  ${s.api}`)
}

// ── 4. 逐站连通性测试（走应用自己的 testSite）────────────────────────────
console.log(`\n逐站测试（应用内 testSite）：`)
const results = await evalJs(`(async () => {
  const keys = ${JSON.stringify(sites.map((s) => s.key))}
  const out = []
  const pool = async (items, size, fn) => {
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
      while (cursor < items.length) { const i = cursor++; out[i] = await fn(items[i]) }
    }))
  }
  await pool(keys, 6, async (k) => ({ key: k, ...(await window.api.sites.test(k)) }))
  return out
})()`)
let okCount = 0
for (const r of results) {
  if (r.ok) okCount++
  const name = sites.find((s) => s.key === r.key)?.name ?? r.key
  console.log(
    `  ${r.ok ? '✓' : '✗'} ${name.padEnd(16)} ${String(r.ms + 'ms').padStart(7)}  ${r.message}`
  )
}
console.log(`连通性：${okCount}/${results.length} 个站点可用`)

// ── 5. 真搜一次，验证搜索链路 ────────────────────────────────────────────
console.log(`\n聚合搜索「${keyword}」：`)
const search = await evalJs(
  `window.api.search.run(${JSON.stringify(keyword)}, { concurrency: 6 })`
)
for (const r of search.results) {
  const name = sites.find((s) => s.key === r.siteKey)?.name ?? r.siteKey
  console.log(`  ${r.ok ? '✓' : '✗'} ${name.padEnd(16)} ${String(r.ms + 'ms').padStart(7)}  ${r.message}`)
}
console.log(`共命中 ${search.total} 条，耗时 ${search.ms}ms`)

// ── 6. 拿第一条真结果跑一次详情，验证选集链路 ────────────────────────────
const first = search.results.find((r) => r.ok && r.list.length)
if (!first) {
  console.log('\n没有命中任何结果，跳过详情测试')
  process.exit(okCount === 0 ? 1 : 0)
}
const vod = first.list[0]
console.log(`\n取第一条测详情：${vod.vod_name}（${vod.siteName}）`)
try {
  const detail = await evalJs(
    `window.api.detail.get(${JSON.stringify(first.siteKey)}, ${JSON.stringify(vod.vod_id)})`
  )
  const total = detail.lines.reduce((n, l) => n + l.episodes.length, 0)
  console.log(`  ✓ ${detail.vod_name}  ${detail.lines.length} 条线路 / ${total} 个剧集`)
  for (const line of detail.lines) {
    console.log(`      ${line.name}：${line.episodes.length} 集，第一集 ${line.episodes[0]?.name}`)
  }
  const playUrl = detail.lines[0]?.episodes[0]?.url
  console.log(`      首个播放地址：${playUrl}`)

  // 再确认这个地址真的拉得动（渲染进程直接发请求，webSecurity 已关）
  const reach = await evalJs(`(async () => {
    try {
      const r = await fetch(${JSON.stringify(playUrl)}, { method: 'GET', headers: { Range: 'bytes=0-1023' } })
      const buf = await r.arrayBuffer()
      return { ok: r.ok || r.status === 206, status: r.status, bytes: buf.byteLength, type: r.headers.get('content-type') }
    } catch (e) { return { ok: false, err: String(e.message ?? e) } }
  })()`)
  console.log(
    reach.ok
      ? `      ✓ 播放地址可拉取：HTTP ${reach.status}，${reach.bytes} 字节，${reach.type}`
      : `      ✗ 播放地址拉不动：${reach.err ?? 'HTTP ' + reach.status}`
  )
} catch (err) {
  console.log(`  ✗ 详情失败：${err.message}`)
}

ws.close()
process.exit(0)
