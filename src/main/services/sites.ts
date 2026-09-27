import * as cheerio from 'cheerio'
import type { Site, TestResult } from '@shared/types'
import { buildCmsUrl, isCmsOk } from './cms'
import { fetchText, matchHeaderRules } from './http'
import { getSettings } from './settings'
import { getParsed, listSources } from './sources'
import { readStore, writeStore } from './store'

const NAME = 'sites'

export interface SiteOverride {
  enabled?: boolean
  order?: number
  health?: number
  header?: Record<string, string>
  timeout?: number
  name?: string
}

type OverrideMap = Record<string, SiteOverride>

async function readOverrides(): Promise<OverrideMap> {
  const data = await readStore<OverrideMap>(NAME, {})
  return data && typeof data === 'object' ? data : {}
}

async function writeOverrides(map: OverrideMap): Promise<void> {
  writeStore(NAME, map)
}

/**
 * 汇总所有启用配置源的站点。
 * 去重规则：同名 key 以「配置源列表顺序在前」的为准（后面的源不覆盖前面的）。
 */
export async function getSites(): Promise<Site[]> {
  const sources = await listSources()
  const overrides = await readOverrides()
  const seen = new Set<string>()
  const out: Site[] = []

  for (const source of sources) {
    if (!source.enabled) continue
    const parsed = getParsed(source.id)
    if (!parsed) continue
    for (const site of parsed.sites) {
      if (seen.has(site.key)) continue
      seen.add(site.key)
      const ov = overrides[site.key]
      const merged: Site = { ...site }
      if (ov) {
        if (ov.enabled !== undefined) merged.enabled = ov.enabled
        if (ov.name) merged.name = ov.name
        if (ov.timeout) merged.timeout = ov.timeout
        if (ov.header) merged.header = { ...merged.header, ...ov.header }
        if (ov.health !== undefined) merged.health = ov.health
      }
      out.push(merged)
    }
  }

  out.sort((a, b) => {
    const oa = overrides[a.key]?.order ?? Number.MAX_SAFE_INTEGER
    const ob = overrides[b.key]?.order ?? Number.MAX_SAFE_INTEGER
    if (oa !== ob) return oa - ob
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })
  return out
}

export async function getSite(key: string): Promise<Site | undefined> {
  return (await getSites()).find((s) => s.key === key)
}

export async function setSiteEnabled(key: string, enabled: boolean): Promise<void> {
  const map = await readOverrides()
  map[key] = { ...(map[key] ?? {}), enabled }
  await writeOverrides(map)
}

export async function setSitesEnabled(keys: string[], enabled: boolean): Promise<void> {
  const map = await readOverrides()
  for (const key of keys) map[key] = { ...(map[key] ?? {}), enabled }
  await writeOverrides(map)
}

export async function setSiteOrder(key: string, order: number): Promise<void> {
  const map = await readOverrides()
  map[key] = { ...(map[key] ?? {}), order }
  await writeOverrides(map)
}

/** 合并全局 headers 规则与站点自身请求头 */
export async function resolveHeader(site: Site, url: string): Promise<Record<string, string>> {
  const sources = await listSources()
  const rules = sources
    .filter((s) => s.enabled)
    .flatMap((s) => getParsed(s.id)?.headers ?? [])
  const settings = await getSettings()
  return {
    'User-Agent': settings.userAgent,
    ...matchHeaderRules(url, rules),
    ...(site.header ?? {})
  }
}

/** 连通性测试：发一次最小请求，能解析出结果就算通 */
export async function testSite(key: string): Promise<TestResult> {
  const site = await getSite(key)
  if (!site) return { ok: false, ms: 0, message: '站点不存在' }
  if (site.unsupported) return { ok: false, ms: 0, message: site.unsupported }
  if (!site.api) return { ok: false, ms: 0, message: '站点未配置接口地址' }

  const settings = await getSettings()
  const timeout = site.timeout ?? settings.timeout
  const start = Date.now()

  try {
    if (site.type === 3 || site.type === 4) {
      const url = buildCmsUrl(site, { ac: 'detail', pg: 1 })
      const header = await resolveHeader(site, url)
      const text = await fetchText(url, { header, timeout })
      const payload = JSON.parse(text.replace(/^\uFEFF/, '').trim())
      if (!isCmsOk(payload)) {
        return { ok: false, ms: Date.now() - start, message: `接口返回异常：${(payload as any).msg ?? 'code 非成功'}` }
      }
      const list = (payload as any).list
      const count = Array.isArray(list) ? list.length : 0
      if (!count) return { ok: false, ms: Date.now() - start, message: '接口连通但未返回数据' }
      const sample = String((list[0] as any)?.vod_name ?? '')
      await saveHealth(key, Date.now() - start)
      return { ok: true, ms: Date.now() - start, message: `正常，返回 ${count} 条`, sample }
    }

    if (site.type === 1) {
      // 网页规则站：请求搜索地址，再用 rules.list 选择器验证页面结构是否还认得出来。
      // 注意 rules.list 是 CSS 选择器而不是 URL，不能拿它去发请求。
      const selector = site.rules?.list?.trim()
      const template = (site.rules?.search || site.api).trim()
      const target = template.replace(/\{(wd|kw|key|keyword)\}/gi, encodeURIComponent('测试'))
      if (!/^https?:\/\//i.test(target)) {
        return { ok: false, ms: 0, message: '网页规则站需要一个 http(s) 地址，当前地址不可请求' }
      }
      const header = await resolveHeader(site, target)
      const text = await fetchText(target, { header, timeout })
      const len = text.length
      if (len < 50) return { ok: false, ms: Date.now() - start, message: '页面内容过短，可能被拦截' }
      if (selector) {
        const count = cheerio.load(text)(selector).length
        if (!count) {
          return {
            ok: false,
            ms: Date.now() - start,
            message: `页面可访问，但列表选择器「${selector}」没有匹配到节点，规则可能已失效`
          }
        }
        await saveHealth(key, Date.now() - start)
        return { ok: true, ms: Date.now() - start, message: `正常，匹配到 ${count} 个列表节点` }
      }
      await saveHealth(key, Date.now() - start)
      return { ok: true, ms: Date.now() - start, message: `正常，页面 ${len} 字节` }
    }

    return { ok: false, ms: 0, message: site.unsupported ?? '该类型暂不支持测试' }
  } catch (err) {
    await saveHealth(key, -1)
    return { ok: false, ms: Date.now() - start, message: (err as Error).message }
  }
}

async function saveHealth(key: string, ms: number): Promise<void> {
  const map = await readOverrides()
  map[key] = { ...(map[key] ?? {}), health: ms }
  await writeOverrides(map)
}
