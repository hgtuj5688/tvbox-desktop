import { randomUUID } from 'node:crypto'
import type { ConfigSource, ParsedConfig } from '@shared/types'
import { parseConfig, loadConfigSource } from './config'
import { getSettings } from './settings'
import { readStore, writeStore } from './store'

const NAME = 'sources'

/** 已解析配置的内存缓存：sourceId -> ParsedConfig */
const parsedCache = new Map<string, ParsedConfig>()
let hydrated = false

export async function listSources(): Promise<ConfigSource[]> {
  const list = await readStore<ConfigSource[]>(NAME, [])
  return Array.isArray(list) ? list : []
}

async function saveSources(list: ConfigSource[]): Promise<void> {
  writeStore(NAME, list)
}

/** 启动时用上次成功的原始配置回填缓存，做到「首屏不等网络」 */
export async function hydrate(): Promise<void> {
  if (hydrated) return
  hydrated = true
  const list = await listSources()
  for (const source of list) {
    if (!source.enabled || !source.raw) continue
    try {
      parsedCache.set(
        source.id,
        parseConfig(source.raw, { sourceId: source.id, sourceName: source.name })
      )
    } catch (err) {
      console.warn(`[sources] 回填 ${source.name} 失败`, err)
    }
  }
}

export function getParsed(sourceId: string): ParsedConfig | undefined {
  return parsedCache.get(sourceId)
}

export async function addSource(input: {
  name?: string
  url: string
  kind?: 'url' | 'file'
}): Promise<ConfigSource> {
  const url = input.url.trim()
  if (!url) throw new Error('地址不能为空')
  const kind = input.kind ?? (/^https?:\/\//i.test(url) ? 'url' : 'file')
  const list = await listSources()
  if (list.some((s) => s.url === url)) throw new Error('该配置源已存在')

  const source: ConfigSource = {
    id: randomUUID(),
    name: (input.name || '').trim() || guessName(url, kind),
    url,
    kind,
    enabled: true,
    lastSync: 0,
    siteCount: 0,
    liveCount: 0,
    parseCount: 0
  }
  list.push(source)
  await saveSources(list)
  return source
}

function guessName(url: string, kind: 'url' | 'file'): string {
  if (kind === 'file') {
    const base = url.split(/[\\/]/).pop() ?? '本地配置'
    return base.replace(/\.json$/i, '')
  }
  try {
    return new URL(url).hostname
  } catch {
    return '远程配置'
  }
}

export async function updateSource(
  id: string,
  patch: Partial<Pick<ConfigSource, 'name' | 'url' | 'enabled'>>
): Promise<ConfigSource> {
  const list = await listSources()
  const idx = list.findIndex((s) => s.id === id)
  if (idx < 0) throw new Error('配置源不存在')
  const next: ConfigSource = { ...list[idx], ...patch }
  if (patch.url) next.kind = /^https?:\/\//i.test(patch.url) ? 'url' : 'file'
  list[idx] = next
  await saveSources(list)
  if (patch.enabled === false) parsedCache.delete(id)
  return next
}

export async function removeSource(id: string): Promise<void> {
  const list = await listSources()
  await saveSources(list.filter((s) => s.id !== id))
  parsedCache.delete(id)
}

export async function syncSource(id: string): Promise<ConfigSource> {
  const list = await listSources()
  const idx = list.findIndex((s) => s.id === id)
  if (idx < 0) throw new Error('配置源不存在')
  const source = list[idx]
  const settings = await getSettings()

  const next: ConfigSource = { ...source }
  try {
    const parsed = await loadConfigSource(source, settings.timeout)
    parsedCache.set(source.id, parsed)
    next.raw = parsed.raw
    next.lastSync = Date.now()
    next.error = undefined
    next.name = source.name || parsed.name
    next.notice = parsed.notice
    next.siteCount = parsed.sites.length
    next.liveCount = parsed.lives.length
    next.parseCount = parsed.parses.length
  } catch (err) {
    next.error = (err as Error).message
    // 同步失败但本地有缓存时保留可用数据，界面只提示不中断
  }
  list[idx] = next
  await saveSources(list)
  return next
}

export async function syncAll(onlyEnabled = true): Promise<ConfigSource[]> {
  const list = await listSources()
  const targets = list.filter((s) => (onlyEnabled ? s.enabled : true))
  const results: ConfigSource[] = []
  // 顺序同步即可：站点数量有限，避免同时打太多源触发风控
  for (const source of targets) {
    results.push(await syncSource(source.id))
  }
  return results
}
