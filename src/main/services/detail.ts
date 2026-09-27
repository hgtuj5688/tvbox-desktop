import * as cheerio from 'cheerio'
import type { Cheerio } from 'cheerio'
import type { AnyNode } from 'domhandler'
import type { Episode, Line, Site, Vod, VodDetail } from '@shared/types'
import { asArray, buildCmsUrl, isCmsOk } from './cms'
import { fetchText, parseLooseJson } from './http'
import { cmsItemToVod } from './search'
import { extract, selectAll } from './htmlRules'
import { getSettings } from './settings'
import { getSite, resolveHeader } from './sites'

/**
 * 把苹果CMS 的 vod_play_from / vod_play_url 拆成线路与剧集。
 * 约定格式：线路之间用 $$$ 分隔，剧集之间用 # 分隔，剧集名与地址用 $ 分隔。
 */
export function parseLines(from: string, url: string, note = ''): Line[] {
  const froms = (from ?? '').split('$$$')
  const groups = (url ?? '').split('$$$')
  const notes = (note ?? '').split('$$$')
  const lines: Line[] = []

  groups.forEach((group, gi) => {
    const name = (froms[gi] || notes[gi] || `线路${gi + 1}`).trim()
    const episodes: Episode[] = []
    for (const segment of group.split('#')) {
      const seg = segment.trim()
      if (!seg) continue
      const split = seg.indexOf('$')
      const epName = split >= 0 ? seg.slice(0, split).trim() : ''
      const epUrl = split >= 0 ? seg.slice(split + 1).trim() : seg
      if (!epUrl) continue
      episodes.push({
        name: epName || `第${episodes.length + 1}集`,
        url: epUrl,
        index: episodes.length
      })
    }
    if (episodes.length) lines.push({ name, episodes })
  })
  return lines
}

async function detailCms(site: Site, vodId: string): Promise<VodDetail> {
  const timeout = site.timeout ?? (await getSettings()).timeout
  const url = buildCmsUrl(site, { ac: 'detail', ids: vodId })
  const header = await resolveHeader(site, url)
  const text = await fetchText(url, { header, timeout })
  const payload = parseLooseJson<Record<string, unknown>>(text)
  if (!isCmsOk(payload)) {
    throw new Error(`接口返回异常：${String(payload?.msg ?? 'code 非成功')}`)
  }
  const raw = asArray<Record<string, unknown>>(payload.list)[0]
  if (!raw) throw new Error('接口没有返回该影片的详情')

  const base = cmsItemToVod(raw, site)
  const s = (v: unknown): string => (v === undefined || v === null ? '' : String(v))
  return {
    ...base,
    vod_content: s(raw.vod_content ?? raw.vod_blurb ?? '').replace(/<[^>]+>/g, '').trim(),
    lines: parseLines(s(raw.vod_play_from), s(raw.vod_play_url), s(raw.vod_play_note))
  }
}

async function detailHtml(site: Site, vodId: string): Promise<VodDetail> {
  if (!/^https?:\/\//i.test(vodId)) {
    throw new Error('该网页规则站没有解析出可用的详情页地址')
  }
  const timeout = site.timeout ?? (await getSettings()).timeout
  const header = await resolveHeader(site, vodId)
  const text = await fetchText(vodId, { header, timeout })
  const $ = cheerio.load(text)
  const rules = site.rules ?? {}
  const scope = ($('body').length ? $('body') : $.root()) as unknown as Cheerio<AnyNode>

  const name =
    extract($, scope, rules.detailName, vodId, ['Text']) ||
    $('h1').first().text().trim() ||
    $('title').first().text().trim()
  const content = extract($, scope, rules.detailContent, vodId, ['Text'])
    .replace(/\s+/g, ' ')
    .trim()
  const pic = extract($, scope, rules.pic, vodId, ['data-src', 'data-original', 'src'])

  const lines: Line[] = []
  const containers = selectAll($, scope, rules.playList)
  if (containers.length && rules.playItem) {
    containers.each((i, el) => {
      const node = $(el)
      const episodes: Episode[] = []
      selectAll($, node as unknown as Cheerio<AnyNode>, rules.playItem).each((_j, a) => {
        const anchor = $(a)
        const url = (anchor.attr('href') ?? '').trim()
        const label = anchor.text().replace(/\s+/g, ' ').trim()
        if (!url) return
        episodes.push({
          name: label || `第${episodes.length + 1}集`,
          url,
          index: episodes.length
        })
      })
      if (episodes.length) {
        const label =
          (node.attr('data-name') ?? '').trim() ||
          node.find('h3,h2,.title,.name').first().text().trim() ||
          `线路${i + 1}`
        lines.push({ name: label, episodes })
      }
    })
  }
  if (!lines.length && rules.playItem) {
    // 没有线路容器时退化成单线路
    const episodes: Episode[] = []
    selectAll($, scope, rules.playItem).each((_j, a) => {
      const anchor = $(a)
      const url = (anchor.attr('href') ?? '').trim()
      const label = anchor.text().replace(/\s+/g, ' ').trim()
      if (!url) return
      episodes.push({ name: label || `第${episodes.length + 1}集`, url, index: episodes.length })
    })
    if (episodes.length) lines.push({ name: '默认线路', episodes })
  }

  if (!name && !lines.length) {
    throw new Error('详情页没有解析出内容，规则可能已失效')
  }

  const placeholder: Vod = {
    vod_id: vodId,
    vod_name: name || vodId,
    vod_pic: pic,
    vod_remarks: '',
    vod_year: '',
    vod_area: '',
    vod_actor: '',
    vod_director: '',
    type_name: '',
    vod_score: '',
    siteKey: site.key,
    siteName: site.name,
    sourceId: site.sourceId
  }
  return { ...placeholder, vod_content: content, lines }
}

export async function getVodDetail(siteKey: string, vodId: string): Promise<VodDetail> {
  const site = await getSite(siteKey)
  if (!site) throw new Error('站点不存在或已被禁用')
  if (site.unsupported) throw new Error(site.unsupported)
  if (!vodId) throw new Error('缺少影片 id')

  if (site.type === 3 || site.type === 4) return detailCms(site, vodId)
  if (site.type === 1) return detailHtml(site, vodId)
  throw new Error(site.unsupported ?? '该类型暂不支持获取详情')
}
