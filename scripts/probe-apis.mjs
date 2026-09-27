// 探测一批公开采集站接口，看谁现在真的活着。
// 用法：node scripts/probe-apis.mjs [候选.txt]
// 不带参数就用内置候选表。
import { readFileSync } from 'node:fs'

const CANDIDATES = [
  ['ffzy', 'https://api.ffzyapi.com/api.php/provide/vod'],
  ['ffzy2', 'https://cj.ffzyapi.com/api.php/provide/vod'],
  ['heimuer', 'https://json.heimuer.xyz/api.php/provide/vod'],
  ['heimuer2', 'https://heimuer.tv/api.php/provide/vod'],
  ['wolong', 'https://collect.wolongzyw.com/api.php/provide/vod'],
  ['dyttzy', 'https://caiji.dyttzyapi.com/api.php/provide/vod'],
  ['lzi', 'https://cj.lziapi.com/api.php/provide/vod'],
  ['wwzy', 'https://api.wwzy.tv/api.php/provide/vod'],
  ['kuaikan', 'https://zy.kuaikan-api.com/api.php/provide/vod'],
  ['guangsu', 'https://api.guangsuapi.com/api.php/provide/vod'],
  ['wujin', 'https://api.wujinapi.me/api.php/provide/vod'],
  ['ukuzy', 'https://cj.ukuzy.me/api.php/provide/vod'],
  ['ukuzy2', 'https://cj.ukuzy.com/api.php/provide/vod'],
  ['1080zyku', 'https://api.1080zyku.com/api.php/provide/vod'],
  ['maotai', 'https://api.maotaizy.cc/api.php/provide/vod'],
  ['xiaomaomi', 'https://api.xiaomaomi.cc/api.php/provide/vod'],
  ['tyyszy', 'https://api.tyyszy.com/api.php/provide/vod'],
  ['360zy', 'https://api.360zy.com/api.php/provide/vod'],
  ['88kanqiu', 'https://api.88kanqiu.com/api.php/provide/vod'],
  ['79zyw', 'https://api.79zyw.com/api.php/provide/vod'],
  ['yzzy', 'https://api.yzzy-api.com/inc/apijson.php'],
  ['mozhua', 'https://mozhuazy.com/api.php/provide/vod'],
  ['jisu', 'https://api.jisuapi.com/api.php/provide/vod'],
  ['subo', 'https://subocaiji.com/api.php/provide/vod'],
  ['apibox', 'https://api.apibox.cc/api.php/provide/vod'],
  ['bttwo', 'https://api.bttwo.com/api.php/provide/vod'],
  ['ddzy', 'https://api.ddzyplay.com/api.php/provide/vod'],
  ['nangua', 'https://api.nangua.org/api.php/provide/vod'],
  ['leshijie', 'https://api.leshijie.com/api.php/provide/vod'],
  ['huangcang', 'https://api.huangcang.com/api.php/provide/vod']
]

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const list = process.argv[2]
  ? readFileSync(process.argv[2], 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => {
        const [name, url] = l.split(/\s+/)
        return [name, url]
      })
  : CANDIDATES

async function probe([name, api]) {
  const started = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  try {
    const res = await fetch(`${api}?ac=list&pg=1`, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
      signal: ctrl.signal
    })
    const ms = Date.now() - started
    if (!res.ok) return { name, api, ok: false, ms, why: `HTTP ${res.status}` }
    const text = await res.text()
    let data
    try {
      data = JSON.parse(text.replace(/^\uFEFF/, ''))
    } catch {
      return { name, api, ok: false, ms, why: `不是 JSON：${text.slice(0, 60)}` }
    }
    const arr = Array.isArray(data.list) ? data.list : Array.isArray(data.data) ? data.data : []
    if (!arr.length) {
      return {
        name,
        api,
        ok: false,
        ms,
        why: `list 为空（code=${JSON.stringify(data.code)} msg=${String(data.msg ?? '').slice(0, 40)}）`
      }
    }

    // 再试一次真实搜索——列表能通不代表搜索能用（有的站挂了 WAF 只放行列表）
    const sRes = await fetch(`${api}?ac=detail&wd=${encodeURIComponent('庆余年')}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
      signal: ctrl.signal
    })
    if (!sRes.ok) {
      return { name, api, ok: false, ms: Date.now() - started, why: `搜索 HTTP ${sRes.status}` }
    }
    const sData = JSON.parse((await sRes.text()).replace(/^\uFEFF/, ''))
    const hits = Array.isArray(sData.list) ? sData.list : Array.isArray(sData.data) ? sData.data : []
    if (!hits.length) {
      return { name, api, ok: false, ms: Date.now() - started, why: '搜索无结果' }
    }
    return {
      name,
      api,
      ok: true,
      ms: Date.now() - started,
      count: arr.length,
      hits: hits.length,
      hasPlay: hits.filter((h) => h.vod_play_url).length,
      sample: hits[0].vod_name
    }
  } catch (err) {
    return {
      name,
      api,
      ok: false,
      ms: Date.now() - started,
      why: err.name === 'AbortError' ? '超时（10s）' : String(err.message ?? err)
    }
  } finally {
    clearTimeout(timer)
  }
}

async function pool(items, size, fn) {
  const out = new Array(items.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++
        out[i] = await fn(items[i])
      }
    })
  )
  return out
}

const results = await pool(list, 8, probe)

const alive = results.filter((r) => r.ok)
const dead = results.filter((r) => !r.ok)

console.log(`\n探活结果：${alive.length}/${results.length} 可用（列表 + 搜索都通）\n`)
for (const r of alive) {
  console.log(
    `  ✓ ${r.name.padEnd(12)} ${String(r.ms + 'ms').padStart(7)}  ` +
      `搜索 ${r.hits} 条（${r.hasPlay} 条带剧集）  例：${r.sample}`
  )
  console.log(`      ${r.api}`)
}
if (dead.length) {
  console.log(`\n  不可用：`)
  for (const r of dead) console.log(`  ✗ ${r.name.padEnd(12)} ${r.why}`)
}
console.log()
process.exit(alive.length ? 0 : 1)
