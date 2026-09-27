import type { ParseAttempt, ParseInfo, ParseItem, ParseResult, ParseStat, ParseTestResult } from '@shared/types'
import { decodeResponse, parseLooseJson, request } from './http'
import { listSources, getParsed } from './sources'
import { readStore, writeStore } from './store'

/**
 * 解析接口（TVBox 里的 parses）。
 *
 * 为什么需要它：不少采集站的线路给的不是直链，而是一个**分享页地址**
 * （实测素博的 `subyun` 线路就是 `https://play.xluuss.com/play/nelOoxJd`），
 * 这种地址交给 <video> 是播不出来的，得先拿它去问「解析接口」换一个真地址。
 *
 * 协议（TVBox 的约定）：把分享页地址做 URL 编码后接到接口后面，
 *   https://okjx.cc/?url=https%3A%2F%2Fplay.xluuss.com%2Fplay%2FnelOoxJd
 * 响应可能是三种东西，都要认：
 *   · 直接 302 到 m3u8（看最终 URL）；
 *   · JSON，地址在 url / data.url / result.url 之类的键里；
 *   · 一段网页，地址藏在 `var main = "..."` 或 `player_aaaa={"url":"..."}` 里。
 *
 * 只做 HTTP 那一类（type=1/2）。type=0 是要真实浏览器嗅探的，先不碰。
 */

const STATS = 'parse-stats'
const CUSTOM = 'parses'

/** 单条解析的超时（秒）。解析接口本身要替我们去第三方站点抓地址，给宽一点 */
const PARSE_TIMEOUT = 8
/** 一轮解析最多花多久（毫秒）。轮询完所有接口不能无限等下去 */
const PARSE_BUDGET = 24_000

/** 设置页「测一下」默认拿这个网页地址当素材 —— 一个公开的视频页 */
export const SAMPLE_TARGET = 'https://v.qq.com/x/cover/mzc00200mp8vo9b.html'

/* ---------- 地址判定 ---------- */

const MEDIA_RE = /\.(m3u8|mp4|flv|mkv|ts|mov|avi|webm|m4v|mpd|mp3|m4a)(\?|#|$)/i
const DIRECT_RE = /^(https?|rtmp|rtsp|file):\/\//i

/**
 * 这个地址能不能直接交给播放器。
 *
 * 判据只有「看起来是不是媒体文件」这一条 —— 不做域名白名单，因为采集站的 CDN
 * 域名每天都在换，白名单一定会误判。反过来，把网页地址当直链播放的表现是
 * 播放器一直转圈、不报错（实测过），所以宁可多走一次解析也不要把网页直接丢进去。
 */
export function isDirectMedia(raw: string): boolean {
  const url = (raw ?? '').trim()
  if (!url) return false
  if (/^(rtmp|rtsp|file):/i.test(url)) return true
  return MEDIA_RE.test(url)
}

/**
 * 把分享页地址接成解析接口的请求地址。
 *
 * 三种写法都要认：
 *   `...?url=`（TVBox 配置里最常见，末尾已经带等号，直接接）
 *   `...?a=1`（已经有别的参数，用 & 接）
 *   `.../jx/`（什么都没有，用 ? 接）
 */
export function buildParseUrl(template: string, target: string): string {
  const tpl = (template ?? '').trim()
  if (!tpl) throw new Error('解析接口地址为空')
  if (/\{url\}/i.test(tpl)) return tpl.replace(/\{url\}/gi, encodeURIComponent(target))
  if (/[?&][^=&]*=$/.test(tpl)) return tpl + encodeURIComponent(target)
  const sep = tpl.includes('?') ? '&' : '?'
  return `${tpl}${sep}url=${encodeURIComponent(target)}`
}

/* ---------- 从响应里挖地址 ---------- */

function unescapeUrl(raw: string): string {
  return raw
    .replace(/\\\//g, '/')
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/g, '&')
    .trim()
}

const URL_KEYS = ['url', 'playurl', 'play_url', 'm3u8', 'src', 'video', 'link', 'address']

/**
 * 一眼就能看出不是播放地址的后缀。
 *
 * 实测踩过两次：腾讯的剧集页里扫出 `xxx_avatar.png`；某个解析接口的跳板页里
 * 扫出 `wasm_exec.js`，还被当成「解析成功了」。这两种都要挡掉。
 * 反过来，**没有后缀**的地址要放行 —— 不少接口给的就是 `…/live/abc?token=…`。
 */
const NON_MEDIA_RE =
  /\.(js|mjs|cjs|css|json|xml|html?|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|map|txt|apk|zip)(\?|#|$)/i

function looksLikeStream(url: string): boolean {
  if (isDirectMedia(url)) return true
  return !NON_MEDIA_RE.test(url)
}

function asPlayable(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const url = unescapeUrl(value)
  // 必须是完整地址，而且中间不能有空格 —— 否则多半是从一段 JS 里截出来的残片
  if (!DIRECT_RE.test(url) || /\s/.test(url)) return null
  return url
}

/**
 * 直接在整段响应里扫一个媒体文件地址。
 *
 * 这条比「猜变量名」有用得多：实测素博的分享页就是个 DPlayer 壳，地址写成
 *   const vid = 'https://play.xluuss.com/play/nelOoxJd/index.m3u8';
 * 变量名千奇百怪（vid / main / playerUrl…），但**后缀是骗不了人的**。
 * 优先 m3u8，其次其它容器格式。
 */
function scanMediaUrl(text: string): string | null {
  const flat = unescapeUrl(text)
  const hls = /https?:\/\/[^\s'"<>()]+\.m3u8(?:\?[^\s'"<>()]*)?/i.exec(flat)
  if (hls) return hls[0]
  const other = /https?:\/\/[^\s'"<>()]+\.(?:mp4|flv|mkv|mov|webm|m4v|mpd)(?:\?[^\s'"<>()]*)?/i.exec(flat)
  return other ? other[0] : null
}

function deepFindUrl(node: unknown, depth = 0): string | null {
  if (node == null || depth > 4) return null
  const direct = asPlayable(node)
  if (direct) return direct
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = deepFindUrl(item, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (typeof node !== 'object') return null

  const obj = node as Record<string, unknown>
  // 先按已知的键名找
  for (const key of Object.keys(obj)) {
    if (!URL_KEYS.includes(key.toLowerCase())) continue
    const hit = deepFindUrl(obj[key], depth + 1)
    if (hit) return hit
  }
  // 再进常见的容器键
  for (const key of ['data', 'result', 'info', 'content']) {
    if (key in obj) {
      const hit = deepFindUrl(obj[key], depth + 1)
      if (hit) return hit
    }
  }
  return null
}

/**
 * 从解析接口的响应里挖出真实播放地址。
 *
 * `requireMedia` 是给「自己读播放页」那条路用的：读的是**任意一个网页**，
 * 里面的 `src=` / `url=` 可能是头像、广告、预告片，所以必须看得见媒体后缀才认
 * （实测踩过：腾讯的剧集页里扫出个 xxx_avatar.png）。而解析接口是专门干这个的，
 * 它返回什么就信什么 —— 有些接口给的是不带后缀的直链。
 */
export function extractUrl(body: string, options: { requireMedia?: boolean } = {}): string | null {
  const text = (body ?? '').trim()
  if (!text) return null
  const accept = (value: string | null): string | null => {
    if (!value) return null
    // 自己读网页时必须有媒体后缀；解析接口只要求「不像个静态资源」
    if (options.requireMedia) return isDirectMedia(value) ? value : null
    return looksLikeStream(value) ? value : null
  }

  const bare = accept(asPlayable(text))
  if (bare) return bare

  try {
    const hit = accept(deepFindUrl(parseLooseJson<unknown>(text)))
    if (hit) return hit
  } catch {
    // 不是 JSON，继续按网页找
  }

  // 整段扫一遍媒体地址 —— 比下面那串变量名模式管用得多
  const scanned = scanMediaUrl(text)
  if (scanned) return scanned

  const patterns = [
    /\bvar\s+main\s*=\s*['"]([^'"]+)['"]/i,
    /\bvar\s+url\s*=\s*['"]([^'"]+)['"]/i,
    /"url"\s*:\s*"([^"]+)"/i,
    /'url'\s*:\s*'([^']+)'/i,
    /"playUrl"\s*:\s*"([^"]+)"/i,
    /<video[^>]+src=["']([^"']+)["']/i,
    /<source[^>]+src=["']([^"']+)["']/i,
    /(?:src|url)\s*=\s*["'](https?:\\?\/\\?\/[^"']+)["']/i
  ]
  for (const re of patterns) {
    // 要遍历所有匹配：第一个往往是个图片或脚本地址，直接取第一个就会误判
    for (const m of text.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))) {
      const url = accept(asPlayable(m[1]))
      if (url) return url
    }
  }

  // 爱奇艺那套播放器把结果塞在 player_aaaa 里
  const pm = /player_aaaa\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i.exec(text)
  if (pm) {
    try {
      const data = JSON.parse(pm[1]) as unknown
      const hit = accept(deepFindUrl(data))
      if (hit) return hit
    } catch {
      // 忽略
    }
  }
  return null
}

/**
 * 这个响应本身是不是一个「去别处」的跳板。
 *
 * 实测公开解析接口很爱这么干：`jx.aidouer.net` 什么都不解析，只回一个
 *   <meta http-equiv="refresh" content="3;url=https://jx.77flv.cc/?url=…">
 * 真正干活的在下一跳。不跟过去就永远只得到「没有可识别的播放地址」。
 */
export function extractRedirect(body: string, base: string): string | null {
  const text = (body ?? '').trim()
  if (!text) return null
  const patterns = [
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*?url=([^"';\s>]+)/i,
    /content=["'][^"']*?url=([^"';\s>]+)["'][^>]*http-equiv=["']?refresh/i,
    /(?:window\.)?location\.href\s*=\s*['"]([^'"]+)['"]/i,
    /(?:window\.)?location\.replace\(\s*['"]([^'"]+)['"]/i,
    /(?:window\.)?location\s*=\s*['"]([^'"]+)['"]/i
  ]
  for (const re of patterns) {
    const m = re.exec(text)
    if (!m) continue
    const raw = unescapeUrl(m[1])
    if (!/^https?:\/\//i.test(raw)) continue
    try {
      const resolved = new URL(raw, base).toString()
      if (resolved !== base) return resolved
    } catch {
      // 地址不合法就换下一个模式
    }
  }
  return null
}

/* ---------- 解析列表 ---------- */

function flagsOf(item: ParseItem): string[] {
  const ext = item.ext as { flag?: unknown } | undefined
  const raw = ext?.flag
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean)
  if (typeof raw === 'string') {
    return raw
      .split(/[,|]/)
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return []
}

/** 配置里带的所有解析接口（只看已启用的配置源） */
async function configParses(): Promise<ParseItem[]> {
  const sources = await listSources()
  const out: ParseItem[] = []
  for (const source of sources) {
    if (!source.enabled) continue
    const parsed = getParsed(source.id)
    if (parsed?.parses?.length) out.push(...parsed.parses)
  }
  return out
}

function emptyStat(): ParseStat {
  return { ok: 0, fail: 0, lastOk: 0, lastMs: 0 }
}

/** 配置里带的 + 手动加的，去重后带上战绩 */
export async function listParses(): Promise<ParseInfo[]> {
  const stats = await readStore<Record<string, ParseStat>>(STATS, {})
  const custom = await readStore<ParseItem[]>(CUSTOM, [])
  const out: ParseInfo[] = []
  const seen = new Set<string>()

  const push = (item: ParseItem, origin: 'config' | 'custom'): void => {
    const url = (item.url ?? '').trim()
    if (!url || seen.has(url)) return
    seen.add(url)
    const name = (item.name ?? '').trim()
    out.push({
      name: name || url,
      type: Number(item.type ?? 1),
      url,
      ext: item.ext,
      origin,
      flags: flagsOf(item),
      stat: stats[url] ?? emptyStat()
    })
  }

  for (const item of await configParses()) push(item, 'config')
  for (const item of Array.isArray(custom) ? custom : []) push(item, 'custom')
  return out
}

export async function addParse(input: {
  name?: string
  type?: number
  url: string
  flags?: string[]
}): Promise<ParseInfo[]> {
  const url = (input.url ?? '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('解析接口地址要以 http(s):// 开头')
  const all = await listParses()
  if (all.some((p) => p.url === url)) throw new Error('这条解析接口已经有了')

  const custom = await readStore<ParseItem[]>(CUSTOM, [])
  const flags = (input.flags ?? []).map((f) => f.trim()).filter(Boolean)
  custom.push({
    name: (input.name ?? '').trim() || url,
    type: Number(input.type ?? 1),
    url,
    ext: flags.length ? { flag: flags } : undefined
  })
  writeStore(CUSTOM, custom)
  return listParses()
}

export async function removeParse(url: string): Promise<ParseInfo[]> {
  const custom = await readStore<ParseItem[]>(CUSTOM, [])
  writeStore(
    CUSTOM,
    custom.filter((item) => (item.url ?? '').trim() !== url.trim())
  )
  return listParses()
}

/** 清空可用性排行（换了网络环境、或者想重新比一遍时用） */
export async function resetParseStats(): Promise<ParseInfo[]> {
  writeStore(STATS, {})
  return listParses()
}

/* ---------- 排行 ---------- */

function scoreOf(stat: ParseStat): number {
  // 拉普拉斯平滑：没测过的排在 1 胜 0 负和 0 胜 1 负之间，不会因为「没数据」被压到最后
  const rate = (stat.ok + 1) / (stat.ok + stat.fail + 2)
  const speed = stat.lastMs > 0 ? Math.max(0, 1 - Math.min(stat.lastMs, 8000) / 8000) : 0.5
  return rate * 2 + speed
}

/**
 * 决定先试哪条解析。
 *
 * 分档比按分数排更重要：声明了「我专门解析 subyun 这条线路」的接口，
 * 一定要排在通配的那批前面 —— 否则它可能被一堆更快的通配接口挤到后面，
 * 而通配接口对这条线路其实是解析不了的。
 */
function orderParses(list: ParseInfo[], flag?: string, prefer?: string): ParseInfo[] {
  const tier = (p: ParseInfo): number => {
    if (prefer && (p.name === prefer || p.url === prefer)) return 0
    const flags = p.flags
    if (flags.length && flag && flags.some((f) => f.toLowerCase() === flag.toLowerCase())) return 1
    if (!flags.length) return 2
    return 3
  }
  // type=0 是要真实浏览器嗅探的，纯 HTTP 多半换不出东西，放最后
  const kind = (p: ParseInfo): number => (p.type === 0 ? 1 : 0)

  return [...list].sort((a, b) => {
    const t = tier(a) - tier(b)
    if (t !== 0) return t
    const k = kind(a) - kind(b)
    if (k !== 0) return k
    return scoreOf(b.stat) - scoreOf(a.stat)
  })
}

/* ---------- 单条解析 ---------- */

function headersOf(item: ParseInfo): Record<string, string> {
  const ext = item.ext as { header?: unknown } | undefined
  const out: Record<string, string> = {}
  if (ext?.header && typeof ext.header === 'object') {
    for (const [k, v] of Object.entries(ext.header as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
  }
  // 解析接口基本都校验来源，不带就是 403
  if (!out.Referer) out.Referer = item.url
  return out
}

/** 最多跟几跳。实测常见的是一跳 meta refresh，给 3 跳足够，也防止绕圈 */
const MAX_HOPS = 3

/**
 * 从一个地址出发，跟着跳转、逐跳找播放地址。
 * 「读播放页本身」和「问解析接口」走的是同一套逻辑，只是起点和请求头不同。
 */
async function walk(
  start: string,
  headers: Record<string, string>,
  label: string,
  strict = false
): Promise<ParseAttempt> {
  const started = Date.now()
  let current = start
  try {
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const api = current
      const res = await request(api, { timeout: PARSE_TIMEOUT, header: headers })
      const ms = Date.now() - started

      // 一：自己 302 到了媒体文件
      if (res.finalUrl && res.finalUrl !== api && isDirectMedia(res.finalUrl)) {
        return { name: label, ok: true, ms, url: res.finalUrl }
      }
      // 二：从响应体里挖
      const text = decodeResponse(res)
      const found = extractUrl(text, { requireMedia: strict })
      if (found && found !== api) return { name: label, ok: true, ms, url: found }
      // 三：这是个跳板，跟过去接着找
      const next = extractRedirect(text, res.finalUrl || api)
      if (!next || next === api) break
      current = next
    }
    return {
      name: label,
      ok: false,
      ms: Date.now() - started,
      error: current === start ? '没有拿到可识别的播放地址' : '跟着跳转找了几跳，还是没拿到播放地址'
    }
  } catch (err) {
    return { name: label, ok: false, ms: Date.now() - started, error: (err as Error).message }
  }
}

/** 这一步不走解析接口，只把「读出来」记在展示里，名字要让人看得懂 */
const DIRECT_LABEL = '直接从播放页里取'

/**
 * 先自己读一遍播放页。
 *
 * 很多采集站的「分享页」就是个 DPlayer 壳，地址明文写在脚本里
 * （实测素博的 subyun 线路就是），一次 GET 就能拿到，不必麻烦任何第三方解析。
 * 读不出来才去问解析接口 —— 顺序反过来的话，明明能自己解决的地址也要绕一圈外网。
 */
async function tryDirect(target: string): Promise<ParseAttempt> {
  const headers: Record<string, string> = {}
  try {
    headers.Referer = `${new URL(target).origin}/`
  } catch {
    // 相对地址之类，不补来源
  }
  return walk(target, headers, DIRECT_LABEL, true)
}

async function tryParse(item: ParseInfo, target: string): Promise<ParseAttempt> {
  return walk(buildParseUrl(item.url, target), headersOf(item), item.name)
}

async function recordStat(url: string, attempt: ParseAttempt): Promise<void> {
  const stats = await readStore<Record<string, ParseStat>>(STATS, {})
  const cur = stats[url] ?? emptyStat()
  stats[url] = attempt.ok
    ? { ok: cur.ok + 1, fail: cur.fail, lastOk: Date.now(), lastMs: attempt.ms }
    : {
        ok: cur.ok,
        fail: cur.fail + 1,
        lastOk: cur.lastOk,
        lastMs: cur.lastMs,
        lastError: attempt.error
      }
  writeStore(STATS, stats)
}

/* ---------- 对外入口 ---------- */

export interface ResolveOptions {
  /** 线路名（详情里的 line.name），用来挑专门解析这条线路的接口 */
  flag?: string
  /** 用户在界面上手动指定的一条解析（按名字或地址） */
  prefer?: string
}

/**
 * 把一个播放地址变成「真的能播的地址」。
 *
 * 直链直接放行；网页地址则按排行依次问每一条解析接口，第一个成功就返回。
 * 失败**不抛异常**，而是把每条接口的失败原因一起返回 —— 界面上要能列出来让用户
 * 知道是「全都挂了」还是「某一条超时」。
 */
export async function resolvePlayUrl(
  rawUrl: string,
  options: ResolveOptions = {}
): Promise<ParseResult> {
  const url = (rawUrl ?? '').trim()
  if (!url) throw new Error('没有播放地址')

  if (isDirectMedia(url)) {
    return { ok: true, url, direct: true, ms: 0, attempts: [] }
  }

  const list = await listParses()
  const started = Date.now()
  const attempts: ParseAttempt[] = []

  // 第一步：先自己把播放页读一遍。很多分享页地址就明文写在里面。
  const direct = await tryDirect(url)
  attempts.push(direct)
  if (direct.ok && direct.url) {
    return {
      ok: true,
      url: direct.url,
      direct: false,
      parseName: direct.name,
      ms: Date.now() - started,
      attempts
    }
  }

  if (!list.length) {
    return {
      ok: false,
      url: '',
      direct: false,
      ms: Date.now() - started,
      attempts,
      error: '这个地址是网页而不是直链，播放页里也没找到播放地址，而配置里一条解析接口都没有'
    }
  }

  const ordered = orderParses(list, options.flag, options.prefer)

  for (const item of ordered) {
    if (Date.now() - started > PARSE_BUDGET) {
      attempts.push({ name: item.name, ok: false, ms: 0, error: '整体超时，没轮到这条' })
      continue
    }
    const attempt = await tryParse(item, url)
    attempts.push(attempt)
    await recordStat(item.url, attempt)
    if (attempt.ok && attempt.url) {
      return {
        ok: true,
        url: attempt.url,
        direct: false,
        parseName: attempt.name,
        ms: Date.now() - started,
        attempts
      }
    }
  }

  const reason = attempts.find((a) => a.error)?.error ?? '未知原因'
  return {
    ok: false,
    url: '',
    direct: false,
    ms: Date.now() - started,
    attempts,
    error: `${attempts.length} 条路子都没能换出地址（${reason}）`
  }
}

/** 单独测一条解析接口 */
export async function testParse(parseUrl: string, target?: string): Promise<ParseTestResult> {
  const use = (target ?? '').trim() || SAMPLE_TARGET
  const list = await listParses()
  const item = list.find((p) => p.url === parseUrl)
  if (!item) throw new Error('没有这条解析接口')
  const attempt = await tryParse(item, use)
  await recordStat(item.url, attempt)
  return {
    ok: attempt.ok,
    ms: attempt.ms,
    target: use,
    url: attempt.url,
    error: attempt.error
  }
}
