import type { Site } from '@shared/types'

/**
 * 苹果CMS(MacCMS V10) 接口地址构造。
 * 同时支持「基地址 + 参数」和「模板地址（含 {ac} {wd} {pg} {t} {ids} 占位符）」两种写法。
 */

export interface CmsQuery {
  ac?: 'list' | 'detail' | 'videolist'
  wd?: string
  pg?: number | string
  t?: number | string
  ids?: number | string
  h?: string
}

const PLACEHOLDERS: Array<[keyof CmsQuery, RegExp]> = [
  ['ac', /\{ac\}/g],
  ['wd', /\{(wd|kw|key|keyword)\}/g],
  ['pg', /\{(pg|page)\}/g],
  ['t', /\{(t|type|typeid|class)\}/g],
  ['ids', /\{(ids|id)\}/g]
]

export function buildCmsUrl(site: Site, query: CmsQuery): string {
  const api = site.api ?? ''
  let templated = false
  let url = api

  for (const [key, re] of PLACEHOLDERS) {
    if (re.test(url)) {
      templated = true
      const value = query[key]
      url = url.replace(re, value === undefined ? '' : encodeURIComponent(String(value)))
    }
  }

  if (templated) {
    let out = url.replace(/\{h\}/g, String(query.h ?? ''))
    // 模板里没有 {ids} 槽位时，详情请求还是要能带上 ids：
    // 只替换不追加的话，`?ac={ac}&t={t}&pg={pg}&wd={wd}` 这种模板
    // 永远取不到详情页（实测桩上就是这个现象——点进去一直解析不出剧集）。
    if (query.ids !== undefined && !/[?&]ids=/.test(out)) {
      const sep = out.includes('?') ? (out.endsWith('?') || out.endsWith('&') ? '' : '&') : '?'
      out = `${out}${sep}ids=${encodeURIComponent(String(query.ids))}`
    }
    return out
  }

  // 基地址模式：安全拼接查询串
  const params = new URLSearchParams()
  if (query.ac) params.set('ac', query.ac)
  if (query.wd !== undefined) params.set('wd', query.wd)
  if (query.pg !== undefined) params.set('pg', String(query.pg))
  if (query.t !== undefined && query.t !== '') params.set('t', String(query.t))
  if (query.ids !== undefined) params.set('ids', String(query.ids))

  const qs = params.toString()
  if (!qs) return url
  const sep = url.includes('?') ? (url.endsWith('?') || url.endsWith('&') ? '' : '&') : '?'
  return `${url}${sep}${qs}`
}

/**
 * 分类浏览用的地址，和 buildCmsUrl 的区别是 t 可以传多个。
 *
 * 苹果CMS 把同一个大类拆成一堆叶子分类（电影 → 动作片/喜剧片/爱情片…），
 * 而**父分类 id 查不出任何东西**（实测 t=1 返回 0 条），只能落到叶子上。
 *
 * 注意：**不要指望把多个叶子 id 并列进同一次请求**。实测重复的 t 参数是
 * 「最后一个生效」而不是 OR——`t=6&t=7` 的 total 等于 t=7 的 total、返回的也全是
 * 喜剧片，`t=6,7` 则只认第一个。所以调用方（category.ts）对每个子分类单独发一次请求，
 * 拿回来自己合并；这里传多个 id 只是给模板式站点留个兜底。
 * 模板式站点只有一个 {t} 槽位，塞不下多个值，只取第一个叶子。
 */
export function buildCmsBrowseUrl(site: Site, ac: string, types: string[], pg: number): string {
  const api = site.api ?? ''
  // 只要地址里有任何占位符就算模板式。不能只认 {t}：像
  // `...?ac={ac}&pg={pg}&wd={wd}` 这种没有 {t} 的模板，如果走下面的「追加参数」
  // 分支，模板里的字面量 {ac}/{pg}/{wd} 会和新参数同时留在 URL 上，
  // 服务端读到哪一个完全看它先取哪个，等于随机。
  const templated = /\{(ac|wd|kw|key|keyword|pg|page|t|type|typeid|class|ids|id|h)\}/.test(api)
  if (templated) {
    return buildCmsUrl(site, { ac: ac as CmsQuery['ac'], t: types[0] ?? '', pg })
  }
  const params = new URLSearchParams()
  params.set('ac', ac)
  for (const t of types) if (t) params.append('t', t)
  params.set('pg', String(pg))
  const sep = api.includes('?') ? (api.endsWith('?') || api.endsWith('&') ? '' : '&') : '?'
  return `${api}${sep}${params.toString()}`
}

/** 归一化苹果CMS 返回，容忍 code 为 1 / "1" / "ok" 等写法 */
export function isCmsOk(payload: unknown): boolean {  if (!payload || typeof payload !== 'object') return false
  const code = (payload as Record<string, unknown>).code
  if (code === undefined || code === null || code === '') return true
  const s = String(code).toLowerCase()
  return s === '1' || s === 'true' || s === 'ok' || s === 'success' || s === '200'
}

export function asArray<T = unknown>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === 'object') return [value as T]
  return []
}
