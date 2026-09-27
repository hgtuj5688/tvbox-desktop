import * as cheerio from 'cheerio'
import type { SearchOptions, SearchResponse, Site, SiteSearchResult, Vod } from '@shared/types'
import { asArray, buildCmsUrl, isCmsOk } from './cms'
import { fetchText, parseLooseJson } from './http'
import { absolutize, extract } from './htmlRules'
import { getSettings } from './settings'
import { getSites, resolveHeader } from './sites'

const DEFAULT_LIMIT = 30

/** 搜索请求的取消令牌：发起新搜索时旧的那一批会自行停下 */
let currentToken = 0

export function cancelSearch(): void {
  currentToken++
}

function fail(site: Site, message: string, ms = 0): SiteSearchResult {
  return { siteKey: site.key, siteName: site.name, ok: false, ms, message, list: [] }
}

/** 把苹果CMS 返回的一条记录归一化成 Vod */
export function cmsItemToVod(raw: Record<string, unknown>, site: Site): Vod {
  const s = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim())
  return {
    vod_id: s(raw.vod_id ?? raw.id),
    vod_name: s(raw.vod_name ?? raw.name),
    vod_pic: absolutize(s(raw.vod_pic ?? raw.pic), site.api),
    vod_remarks: s(raw.vod_remarks ?? raw.remarks),
    vod_year: s(raw.vod_year ?? raw.year),
    vod_area: s(raw.vod_area ?? raw.area),
    vod_actor: s(raw.vod_actor ?? raw.actor),
    vod_director: s(raw.vod_director ?? raw.director),
    type_name: s(raw.type_name ?? raw.class),
    vod_score: s(raw.vod_score ?? raw.score),
    siteKey: site.key,
    siteName: site.name,
    sourceId: site.sourceId
  }
}

async function searchCms(site: Site, wd: string, limit: number, timeout: number): Promise<Vod[]> {
  // 搜索用 ac=detail：MacCMS V10 的 detail 同时支持 wd 关键词，且一次就带回
  // vod_play_url，省掉一次详情请求。只有配置作者在模板里写了 {ac} 时，才按
  // TVBox 惯例填 videolist（部分老版本 CMS 只认这个写法）。
  const ac = /\{ac\}/i.test(site.api) ? 'videolist' : 'detail'
  const url = buildCmsUrl(site, { ac, wd, pg: 1 })
  const header = await resolveHeader(site, url)
  const text = await fetchText(url, { header, timeout })
  const payload = parseLooseJson<Record<string, unknown>>(text)
  if (!isCmsOk(payload)) {
    throw new Error(`接口返回异常：${String(payload?.msg ?? 'code 非成功')}`)
  }
  return asArray<Record<string, unknown>>(payload.list)
    .slice(0, limit)
    .map((item) => cmsItemToVod(item, site))
    .filter((v) => v.vod_name && v.vod_id)
}

async function searchHtml(site: Site, wd: string, limit: number, timeout: number): Promise<Vod[]> {
  const template = (site.rules?.search || site.api).trim()
  const target = template.replace(/\{(wd|kw|key|keyword)\}/gi, encodeURIComponent(wd))
  if (!/^https?:\/\//i.test(target)) {
    throw new Error('网页规则站缺少可请求的搜索地址')
  }
  const header = await resolveHeader(site, target)
  const text = await fetchText(target, { header, timeout })
  const $ = cheerio.load(text)
  const rules = site.rules ?? {}
  const nodes = $((rules.list || '').trim())
  if (!nodes.length) throw new Error('列表选择器没有匹配到节点，规则可能已失效')

  const out: Vod[] = []
  nodes.slice(0, limit).each((_i, el) => {
    const node = $(el)
    const link = extract($, node, rules.link, target, ['href', 'Text'])
    const name = extract($, node, rules.name, target, ['Text'])
    if (!name) return
    out.push({
      // 网页规则站没有稳定的数字 id，直接把详情页地址当作 id。
      // 这样详情页不需要再猜一次地址，也不会因为站点改版而失效。
      vod_id: link || name,
      vod_name: name,
      vod_pic: extract($, node, rules.pic, target, ['data-src', 'data-original', 'src']),
      vod_remarks: extract($, node, rules.remarks, target, ['Text']),
      vod_year: '',
      vod_area: '',
      vod_actor: '',
      vod_director: '',
      type_name: '',
      vod_score: '',
      siteKey: site.key,
      siteName: site.name,
      sourceId: site.sourceId
    })
  })
  return out
}

/** 搜索单个站点；任何异常都收敛成一个 ok:false 的结果，不影响其它站点 */
export async function searchSite(
  site: Site,
  wd: string,
  limit = DEFAULT_LIMIT
): Promise<SiteSearchResult> {
  const start = Date.now()
  if (site.unsupported) return fail(site, site.unsupported)
  if (!site.searchable) return fail(site, '该站点已关闭搜索')
  if (!site.api) return fail(site, '站点未配置接口地址')

  try {
    const timeout = site.timeout ?? (await getSettings()).timeout
    let list: Vod[]
    if (site.type === 3 || site.type === 4) {
      list = await searchCms(site, wd, limit, timeout)
    } else if (site.type === 1) {
      list = await searchHtml(site, wd, limit, timeout)
    } else {
      return fail(site, site.unsupported ?? '该类型暂不支持搜索')
    }
    const ms = Date.now() - start
    return {
      siteKey: site.key,
      siteName: site.name,
      ok: true,
      ms,
      message: list.length ? `找到 ${list.length} 条` : '没有匹配结果',
      list
    }
  } catch (err) {
    return fail(site, (err as Error).message, Date.now() - start)
  }
}

/** 列出当前可以参与聚合搜索的站点 */
export async function searchableSites(): Promise<Site[]> {
  const sites = await getSites()
  return sites.filter((s) => s.enabled && s.searchable && !s.unsupported)
}

/**
 * 聚合搜索：按并发数把所有启用站点跑一遍。
 * 每完成一个站点就通过 onResult 回报一次，界面可以边搜边出结果。
 */
export async function searchAll(
  wd: string,
  options: SearchOptions = {},
  onResult?: (result: SiteSearchResult, done: number, total: number) => void,
  onStart?: (total: number) => void
): Promise<SearchResponse> {
  const keyword = (wd ?? '').trim()
  const started = Date.now()
  if (!keyword) return { wd: keyword, ms: 0, total: 0, results: [] }

  const token = ++currentToken
  const all = await searchableSites()
  const targets = options.sites?.length
    ? all.filter((s) => options.sites?.includes(s.key))
    : all
  if (!targets.length) return { wd: keyword, ms: 0, total: 0, results: [] }
  onStart?.(targets.length)

  const settings = await getSettings()
  const concurrency = Math.max(
    1,
    Math.min(32, options.concurrency ?? settings.concurrency ?? 8)
  )
  const limit = options.limitPerSite ?? DEFAULT_LIMIT

  const results: SiteSearchResult[] = []
  let cursor = 0
  let done = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      if (token !== currentToken) return
      const index = cursor++
      if (index >= targets.length) return
      const result = await searchSite(targets[index], keyword, limit)
      if (token !== currentToken) return
      results.push(result)
      done++
      onResult?.(result, done, targets.length)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, () => worker())
  )

  return { wd: keyword, ms: Date.now() - started, total: targets.length, results }
}
