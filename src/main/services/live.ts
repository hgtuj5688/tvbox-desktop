import { readFile } from 'node:fs/promises'
import type { LiveGroupEntry, LiveResult, LiveSourceStat, ParsedConfig } from '@shared/types'
import { isHttpUrl } from '@shared/liveUrl'
import { getSettings } from './settings'
import { fetchText } from './http'
import { getParsed, listSources } from './sources'

/**
 * 电视直播源的解析。
 *
 * 配置里的 lives 只有元信息（name / type / url / epg），真正的内容要另外拉一次。
 * 两种格式都要吃：
 *   · m3u —— 标准的 #EXTM3U / #EXTINF:-1 tvg-name="..." group-title="...",显示名
 *   · txt —— 国内常见的「分组名,#genre#」开头，随后每行「频道名,地址」
 * type 字段只能当提示，实际以内容判断（配置写错了也能用）。
 */

interface RawChannel {
  name: string
  url: string
  group: string
  logo?: string
}

/** 能直接当播放地址的写法（huya:// 与 douyin:// 是房间号，播放前才换成真地址） */
const ADDRESS_RE = /^(https?|rtmp|rtsp|rtp|udp|file|huya|douyin):\/\//i

/**
 * 分组名归一。
 *
 * 公开源里的分组名带装修符，同一类内容在不同源里写法不一样：
 * 「•游戏「赛事」」去掉符号后是「游戏赛事」，跟本地内置的「游戏赛事」要落到同一组，
 * 否则用户会看到两个意思一样的分组。
 */
function stripDecorator(raw: string): string {
  return raw
    .replace(/^[\s•·・*\-—]+/, '')
    .replace(/[「」【】《》[\]（）()]/g, '')
    .trim()
}

const GROUP_ALIAS: Array<{ re: RegExp; name: string }> = [
  { re: /^游戏/, name: '游戏赛事' },
  { re: /^影视/, name: '影视轮播' },
  { re: /^咪咕/, name: '咪咕移动' }
]

function normalizeGroup(raw: string): string {
  const name = stripDecorator(raw)
  if (!name) return '其它'
  if (/^(未分组|其他|其它|默认|default|undefined|null)$/i.test(name)) return '其它'
  for (const alias of GROUP_ALIAS) if (alias.re.test(name)) return alias.name
  return name
}

export function parseM3u(text: string): RawChannel[] {
  const out: RawChannel[] = []
  let pending: { name: string; group: string; logo?: string } | null = null

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith('#EXTINF')) {
      // 属性段在冒号之后、第一个逗号之前；逗号之后的才是显示名
      const body = line.slice(line.indexOf(':') + 1)
      const comma = body.lastIndexOf(',')
      const attrs = comma >= 0 ? body.slice(0, comma) : body
      const label = comma >= 0 ? body.slice(comma + 1).trim() : ''
      const pick = (key: string): string => {
        const m = attrs.match(new RegExp(`${key}="([^"]*)"`, 'i'))
        return m ? m[1].trim() : ''
      }
      const name = pick('tvg-name') || label
      pending = {
        name,
        group: pick('group-title'),
        logo: pick('tvg-logo') || undefined
      }
      continue
    }

    if (line.startsWith('#')) continue

    if (pending) {
      out.push({
        name: pending.name || line,
        url: line,
        group: normalizeGroup(pending.group),
        logo: pending.logo
      })
      pending = null
    }
  }
  return out.filter((c) => c.url && c.name)
}

export function parseTxt(text: string): RawChannel[] {
  const out: RawChannel[] = []
  let group = '其它'

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('//')) continue

    // 「央视频道,#genre#」——#genre# 也可能写成 #genre 或 #类型#
    if (/#genre#?/i.test(line)) {
      group = normalizeGroup(line.split(',')[0])
      continue
    }
    if (line.startsWith('#')) continue

    const idx = line.indexOf(',')
    if (idx <= 0) continue
    const name = line.slice(0, idx).trim()
    const url = line.slice(idx + 1).trim()
    // 有些 txt 会把一堆地址塞在同一行，用 # 分隔
    if (!url) continue
    if (ADDRESS_RE.test(url)) {
      out.push({ name, url, group })
      continue
    }
    for (const piece of url.split('#')) {
      const one = piece.trim()
      if (one) out.push({ name, url: one, group })
    }
  }
  return out
}

/** 按内容判断格式：有 #EXTM3U / #EXTINF 就是 m3u，其余当 txt */
export function parseLiveContent(text: string): RawChannel[] {
  return /#EXTM3U|#EXTINF/i.test(text) ? parseM3u(text) : parseTxt(text)
}

async function readSource(source: { url: string }, timeout: number): Promise<string> {
  if (isHttpUrl(source.url)) return fetchText(source.url, { timeout })
  // 本地文件：支持 file:/// 与 Windows 盘符路径
  const path = source.url.replace(/^file:\/\/\/?/i, '')
  return readFile(decodeURIComponent(path), 'utf8')
}

/** 合并同一频道的多条线路：同名频道收成一张卡，卡上列出来自哪些源 */
function mergeChannels(raw: Array<RawChannel & { source: string }>): LiveGroupEntry[] {
  const byName = new Map<string, LiveGroupEntry['channels'][number]>()

  for (const ch of raw) {
    const key = ch.name
    const hit = byName.get(key)
    if (hit) {
      if (!hit.urls.some((u) => u.url === ch.url)) hit.urls.push({ url: ch.url, source: ch.source })
      if (!hit.logo && ch.logo) hit.logo = ch.logo
      continue
    }
    byName.set(key, {
      name: ch.name,
      group: ch.group,
      logo: ch.logo,
      urls: [{ url: ch.url, source: ch.source }]
    })
  }

  const groups = new Map<string, LiveGroupEntry>()
  for (const ch of byName.values()) {
    let g = groups.get(ch.group)
    if (!g) {
      g = { name: ch.group, channels: [] }
      groups.set(ch.group, g)
    }
    g.channels.push(ch)
  }
  for (const g of groups.values()) g.channels.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))

  // 「其它」永远排最后，其余按频道数从多到少
  return [...groups.values()].sort((a, b) => {
    if (a.name === '其它') return 1
    if (b.name === '其它') return -1
    return b.channels.length - a.channels.length || a.name.localeCompare(b.name, 'zh-CN')
  })
}

/** 从所有启用配置源里收集 lives，并去重 */
export function collectLiveSources(parsed: ParsedConfig[]): Array<{ name: string; url: string }> {
  const seen = new Set<string>()
  const out: Array<{ name: string; url: string }> = []
  for (const config of parsed) {
    for (const live of config.lives) {
      const url = (live.url ?? '').trim()
      if (!url || seen.has(url)) continue
      seen.add(url)
      out.push({ name: live.name || url, url })
    }
  }
  return out
}

/**
 * 内置的自定义频道。
 *
 * 这些不是任何 IPTV 订阅能提供的东西 —— 它们是某个主播的房间，地址要现解析
 * （见 streamResolve.ts）。写死在代码里，跟着应用走：换订阅、跑自检清空配置源都不会把它们弄丢。
 *
 * 分组名「游戏赛事」会被 normalizeGroup 的别名规则并到公开源的「•游戏「赛事」」里。
 */
export const BUILTIN_LIVE = `游戏赛事,#genre#
danking直播,huya://10188
`

/** 内置频道始终算一个直播源 */
const BUILTIN_SOURCE = { name: '内置自定义频道', url: 'builtin://custom' }

let cache: { at: number; result: LiveResult } | null = null
const TTL = 10 * 60 * 1000
/** 换一次配置源就 +1，用来认出「还在飞的那次加载」属于上一套源 */
let generation = 0

export function clearLiveCache(): void {
  cache = null
  // 光清 cache 不够：很可能正好有一次 loadLive 还在飞，它跑完会把**上一个源**
  // 的结果写回 cache。表现成「同步完新订阅再进电视直播，看到的还是旧分组」，
  // 而且只在换源和首次加载撞上时才复现（自检第一次跑必挂就是这么来的）。
  generation++
}

export async function loadLive(force = false): Promise<LiveResult> {
  if (!force && cache && Date.now() - cache.at < TTL) return cache.result

  const gen = generation

  const list = await listSources()
  const parsed = list
    .filter((s) => s.enabled)
    .map((s) => getParsed(s.id))
    .filter((p): p is ParsedConfig => Boolean(p))
  const sources = collectLiveSources(parsed)

  const settings = await getSettings()
  const stats: LiveSourceStat[] = []
  const all: Array<RawChannel & { source: string }> = []

  // 内置频道先塞进去，这样即使一个配置源都没有，电视直播页也不是空的
  const builtin = parseLiveContent(BUILTIN_LIVE)
  for (const ch of builtin) all.push({ ...ch, source: BUILTIN_SOURCE.name })
  stats.push({ ...BUILTIN_SOURCE, channels: builtin.length })

  await Promise.all(
    sources.map(async (source) => {
      try {
        const text = await readSource(source, settings.timeout)
        const channels = parseLiveContent(text)
        if (!channels.length) {
          stats.push({ ...source, channels: 0, error: '没有解析出任何频道，格式可能不兼容' })
          return
        }
        for (const ch of channels) all.push({ ...ch, source: source.name })
        stats.push({ ...source, channels: channels.length })
      } catch (err) {
        stats.push({ ...source, channels: 0, error: (err as Error).message })
      }
    })
  )

  const groups = mergeChannels(all)
  const result: LiveResult = { groups, total: all.length, sources: stats }
  // 期间换过配置源就说明这份结果已经过期了，别写回缓存 —— 照旧把本次结果
  // 返回给调用方（它要的就是当下这一次），但不让它污染下一次。
  if (gen === generation) cache = { at: Date.now(), result }
  return result
}
