import type { LiveHealth } from '@shared/types'
import { isHttpUrl } from '@shared/liveUrl'
import { DEFAULT_UA, matchHeaderRules } from './http'
import { getSettings } from './settings'
import { getParsed, listSources } from './sources'
import { readStore, writeStore } from './store'

/**
 * 直播线路体检。
 *
 * 公开 IPTV 源的真实可用率很低（实测某条主力源 27% 的线路是死链，另一条 88%），
 * 而一个频道往往挂着好几条线路 —— 只要知道「哪几条是活的」，点击体验就从
 * 「随缘播放 + 手动换线」变成「直接播通的那条」。
 *
 * 体检刻意做得很轻：只读响应体的前几 KB，够看到 #EXTM3U 就够。
 * 绝不能把整条流拉下来 —— 那是几百 MB 的事，而且直播流根本不会结束。
 */

const STORE = 'live-health'
/** 只读这么多字节就够判断了：master/media 播放列表都在最前面 */
const MAX_BYTES = 4096
/** 探测通的线路 30 分钟内不重复探；不通的 5 分钟后重试（公开源恢复得很快） */
const OK_TTL = 30 * 60 * 1000
const FAIL_TTL = 5 * 60 * 1000
const DEFAULT_TIMEOUT = 6
const MAX_CONCURRENCY = 8
/** 一次 IPC 最多探这么多条，防止界面手滑传进来 800 条把网络打满 */
const MAX_URLS = 60

export type HealthMap = Record<string, LiveHealth>

export function isFresh(h: LiveHealth | undefined, now = Date.now()): boolean {
  if (!h?.at) return false
  return now - h.at < (h.ok ? OK_TTL : FAIL_TTL)
}

interface ProbeOutcome {
  ok: boolean
  ms: number
  height?: number
  bandwidth?: number
  error?: string
}

async function probeOne(url: string, timeout: number, header: Record<string, string>): Promise<ProbeOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout * 1000)
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*', ...header }
    })
    if (!res.ok) {
      // 403/404 是公开源最常见的死法；把状态码原样带出来，用户一眼能看懂
      await res.body?.cancel().catch(() => undefined)
      return { ok: false, ms: Date.now() - started, error: `HTTP ${res.status}` }
    }

    // 只读到够判断为止，然后主动断开 —— 否则会把整条直播流拉完
    let text = ''
    const reader = res.body?.getReader()
    if (reader) {
      const decoder = new TextDecoder('utf-8')
      let got = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
        got += value.length
        if (got >= MAX_BYTES) break
      }
      await reader.cancel().catch(() => undefined)
    }
    const ms = Date.now() - started

    if (!/#EXTM3U/i.test(text)) {
      const type = res.headers.get('content-type') ?? ''
      return { ok: false, ms, error: type ? `不是 m3u8（${type.split(';')[0]}）` : '返回的不是 m3u8' }
    }

    // master 播放列表：顺手记下最高一档，挑线路时能偏向高画质的那条
    const bands = [...text.matchAll(/BANDWIDTH=(\d+)/gi)].map((m) => Number(m[1]))
    const heights = [...text.matchAll(/RESOLUTION=\d+x(\d+)/gi)].map((m) => Number(m[1]))
    return {
      ok: true,
      ms,
      bandwidth: bands.length ? Math.max(...bands) : undefined,
      height: heights.length ? Math.max(...heights) : undefined
    }
  } catch (err) {
    const e = err as Error
    const why = e.name === 'AbortError' ? `超时（${timeout}s）` : e.message || '网络错误'
    return { ok: false, ms: Date.now() - started, error: why }
  } finally {
    clearTimeout(timer)
  }
}

/** 并发池：直播源同一台 CDN 上可能挂着几十条线路，一次性并发会被限速 */
async function pool<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = cursor++
        if (i >= items.length) return
        out[i] = await run(items[i])
      }
    })
  )
  return out
}

export async function getHealth(): Promise<HealthMap> {
  return readStore<HealthMap>(STORE, {})
}

export async function clearHealth(): Promise<HealthMap> {
  writeStore<HealthMap>(STORE, {})
  return {}
}

/**
 * 体检一批地址，结果并进缓存后返回**整张表**。
 * 传进来的地址无论新旧都会被重探（调用方只在「需要知道当下结果」时才调）。
 */
export async function probeLines(
  urls: string[],
  options: { timeout?: number; force?: boolean } = {}
): Promise<HealthMap> {
  const settings = await getSettings()
  const store = await getHealth()
  const now = Date.now()

  const unique = [...new Set(urls.map((u) => u.trim()).filter(Boolean))]
  const targets = unique.filter(isHttpUrl)
  const todo = options.force
    ? targets
    : targets.filter((u) => !isFresh(store[u], now)).slice(0, MAX_URLS)

  if (todo.length) {
    const timeout = options.timeout ?? Math.min(settings.timeout, DEFAULT_TIMEOUT * 2)
    // 和站点请求一样走「全局 headers 规则」：不少直播网关校验 Referer / UA，
    // 不带就一律 403，会把好线路误判成死的
    const rules = (await listSources())
      .filter((s) => s.enabled)
      .flatMap((s) => getParsed(s.id)?.headers ?? [])
    const outcomes = await pool(todo, MAX_CONCURRENCY, (url) =>
      probeOne(url, timeout, { 'User-Agent': settings.userAgent, ...matchHeaderRules(url, rules) })
    )
    for (let i = 0; i < todo.length; i++) {
      const o = outcomes[i]
      store[todo[i]] = {
        ok: o.ok,
        ms: o.ms,
        at: Date.now(),
        ...(o.height ? { height: o.height } : {}),
        ...(o.bandwidth ? { bandwidth: o.bandwidth } : {}),
        ...(o.error ? { error: o.error } : {})
      }
    }
    writeStore(STORE, store)
  }

  return store
}
