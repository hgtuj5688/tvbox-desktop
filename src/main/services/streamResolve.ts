import type { LiveResolved } from '@shared/types'
import { ROOM_URL_RE } from '@shared/liveUrl'
import { DEFAULT_UA } from './http'

/**
 * 房间号频道（虎牙 / 抖音）的地址解析。
 *
 * 为什么不能在直播源里直接写 m3u8：
 *   · 虎牙 `data.stream.hls.multiLine[].url` 带 wsSecret / wsTime / fm，几小时就失效；
 *   · 抖音 `hls_pull_url_map` 每次进房都不一样。
 * 所以直播源里只写 `huya://<房间号>` 或 `douyin://<web_rid>`，用户点开频道时才换真地址。
 *
 * 两个平台都校验 Referer，而且必须带浏览器 UA，缺任一个都是 403。
 */

/** 解析时不能设太短：抖音要先取一次首页拿 ttwid，再进房 */
const TIMEOUT = 12_000

async function fetchRaw(
  url: string,
  headers: Record<string, string>,
  timeout = TIMEOUT
): Promise<{ text: string; cookies: string[] }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': DEFAULT_UA, 'accept-language': 'zh-CN,zh;q=0.9', ...headers },
      redirect: 'follow'
    })
    const text = await res.text()
    const cookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie().map((c) => c.split(';')[0])
        : []
    return { text, cookies }
  } catch (err) {
    const e = err as Error
    if (e.name === 'AbortError') throw new Error(`解析超时（${Math.round(timeout / 1000)}s）`)
    throw new Error(`解析失败：${e.message}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 拉一个地址看它到底是哪种 m3u8。
 *
 * 这里必须区分「媒体播放列表」和「主播放列表」，否则会踩一个大坑：
 * 虎牙 TX/AL 两条线给的是**主播放列表**（只有 `#EXT-X-STREAM-INF`），
 * 里面那一条变体地址被改写成 `http://<边缘节点IP>/tx.hls.huya.com/src/...`，
 * 浏览器带着 `Host: <IP>` 去拉一律 403（实测过还原主机名、加 Origin、加 Referer 都还是 403）。
 * 而 HS 那条直接给**媒体播放列表**（有 `#EXTINF`），分片是相对路径，实测 200 + `video/MP2T`。
 * 所以优先要 media，master 只当兜底。
 */
async function probePlaylist(
  url: string,
  referer: string
): Promise<{ ok: boolean; media: boolean }> {
  try {
    const { text } = await fetchRaw(url, { referer, accept: '*/*' }, 8000)
    if (!text.includes('#EXTM3U')) return { ok: false, media: false }
    return { ok: true, media: text.includes('#EXTINF') }
  } catch {
    return { ok: false, media: false }
  }
}

/* ---------- 会话层补 Referer ---------- */

/**
 * hls.js 用 XHR 拉播放列表和分片，而 `Referer` 是浏览器的 forbidden header ——
 * `xhr.setRequestHeader('Referer', …)` 会被**静默忽略**。实测发出去的是页面自己的来源
 * （`http://localhost:5173/`），虎牙边缘节点因此对分片回 403，播放器停在 readyState 0
 * 且不报错（`video.error` 一直是 null），非常难查。
 *
 * 所以只能在会话层补：用 `webRequest.onBeforeSendHeaders` 给虎牙/抖音的请求写上正确来源。
 * 只按域名后缀判断，因为虎牙会把分片地址改写成 `http://<边缘节点IP>/tx.hls.huya.com/src/…`，
 * 主机名跑到了 path 里，按 host 匹配会漏。
 */
const REFERER_RULES: Array<{ re: RegExp; referer: string; origin: string }> = [
  { re: /huya\.com/i, referer: 'https://www.huya.com/', origin: 'https://www.huya.com' },
  {
    re: /(douyin|douyincdn|bytefcdn|volccdn|pstatp|ixigua|bytedance|byteimg|snssdk)\.com/i,
    referer: 'https://live.douyin.com/',
    origin: 'https://live.douyin.com'
  }
]

/** 命中平台规则时返回要补的头部；https 才补 Origin（http 下实测不需要，多补反而可能被拒） */
export function headersFor(url: string): Record<string, string> | null {
  const rule = REFERER_RULES.find((r) => r.re.test(url))
  if (!rule) return null
  const headers: Record<string, string> = { Referer: rule.referer }
  if (url.startsWith('https:')) headers.Origin = rule.origin
  return headers
}

/* ---------- 虎牙 ---------- */

interface HuyaLine {
  url: string
  cdnType?: string
}

async function resolveHuya(roomId: string): Promise<LiveResolved> {
  const referer = 'https://www.huya.com/'
  const { text } = await fetchRaw(
    `https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid=${roomId}`,
    { referer, accept: 'application/json, text/plain, */*' }
  )

  let json: {
    status?: number
    message?: string
    data?: { liveStatus?: string; nick?: string; stream?: { hls?: { multiLine?: HuyaLine[] } } }
  }
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('虎牙返回的不是 JSON，接口可能改了')
  }

  const data = json.data
  if (!data) throw new Error(json.message || '虎牙没有返回房间数据')

  const status = (data.liveStatus ?? '').toUpperCase()
  if (status === 'OFF' || status === '') throw new Error('主播当前没有开播')
  if (status === 'REPLAY') throw new Error('主播当前没有开播（房间在放录像）')

  const lines = (data.stream?.hls?.multiLine ?? []).filter((l) => /\.m3u8/i.test(l.url ?? ''))
  if (!lines.length) throw new Error('虎牙没有给出 HLS 线路')

  // AL（阿里云）实测常年 403，排到最后；HS 优先，因为它直接给媒体播放列表
  const rank = (t?: string): number => (t === 'HS' ? 0 : t === 'AL' ? 2 : 1)
  const ordered = [...lines].sort((a, b) => rank(a.cdnType) - rank(b.cdnType))

  let masterFallback: HuyaLine | null = null
  for (const line of ordered) {
    const probe = await probePlaylist(line.url, referer)
    if (!probe.ok) continue
    if (probe.media) return { url: line.url, referer, line: line.cdnType || undefined }
    if (!masterFallback) masterFallback = line
  }
  // 退而求其次：主播放列表里的变体地址多数播不了，但万一某天能播也不至于直接报错
  if (masterFallback) {
    return { url: masterFallback.url, referer, line: masterFallback.cdnType || undefined }
  }
  throw new Error(`虎牙给了 ${lines.length} 条线路，但没有一条能拉下来`)
}

/* ---------- 抖音 ---------- */

interface DouyinRoom {
  status?: number
  title?: string
  owner?: { nickname?: string }
  stream_url?: { hls_pull_url_map?: Record<string, string> }
}

async function resolveDouyin(webRid: string): Promise<LiveResolved> {
  const referer = 'https://live.douyin.com/'
  // 先进一次首页拿 ttwid：没有它进房接口会返回空数据
  const home = await fetchRaw('https://live.douyin.com/', { accept: 'text/html' })
  const cookie = home.cookies.join('; ')

  const query =
    'aid=6383&app_name=douyin_web&live_id=1&device_platform=web&language=zh-CN' +
    '&enter_from=web_live&cookie_enabled=true&screen_width=1920&screen_height=1080' +
    '&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=126.0.0.0'
  const { text } = await fetchRaw(
    `https://live.douyin.com/webcast/room/web/enter/?${query}&web_rid=${webRid}`,
    { referer: `${referer}${webRid}`, cookie, accept: 'application/json, text/plain, */*' }
  )

  let json: { status_code?: number; data?: { data?: DouyinRoom[] } }
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('抖音返回的不是 JSON，可能需要签名参数了')
  }

  const room = json.data?.data?.[0]
  if (!room) throw new Error('抖音没有返回房间数据，房间号可能不对')

  const status = Number(room.status ?? 0)
  if (status === 4) throw new Error('主播当前没有开播（本场已结束）')
  if (status !== 2) throw new Error('主播当前没有开播')

  const map = room.stream_url?.hls_pull_url_map ?? {}
  // 清晰度从高到低，缺档就往下退
  const pick = ['FULL_HD1', 'HD1', 'SD1', 'SD2'].map((k) => map[k]).find(Boolean) ?? Object.values(map)[0]
  if (!pick) throw new Error('抖音没有给出 HLS 线路')

  return { url: pick, referer, line: room.owner?.nickname || undefined }
}

/** 把 `huya://` / `douyin://` 房间地址换成能播的 m3u8 */
export async function resolveRoomUrl(raw: string): Promise<LiveResolved> {
  const url = (raw ?? '').trim()
  const m = url.match(ROOM_URL_RE)
  if (!m) throw new Error(`不认识的房间地址：${url}`)
  const [, platform, roomId] = m
  return platform.toLowerCase() === 'huya' ? resolveHuya(roomId) : resolveDouyin(roomId)
}
