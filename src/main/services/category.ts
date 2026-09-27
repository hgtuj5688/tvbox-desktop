import type { CategoryBucket, CategoryPage, CategorySiteIds, CategorySub, Site, SiteClass, SiteSearchResult, Vod } from '@shared/types'
import { buildCmsBrowseUrl, buildCmsUrl, asArray, isCmsOk } from './cms'
import { fetchText, parseLooseJson } from './http'
import { cmsItemToVod } from './search'
import { getSettings } from './settings'
import { getSites, resolveHeader } from './sites'

/**
 * 分类浏览。
 *
 * 每个采集站都有自己的分类树（`?ac=list` 返回的 `class` 数组，元素形如
 * `{type_id, type_name, type_pid}`）。同一个大类在各站点的叫法和 id 都不一样：
 *   非凡/电影天堂：电影片#1 连续剧#2 综艺片#3 动漫片#4
 *   量子资源：    电影片#1 连续剧#2 综艺片#3 动漫片#4 电影解说#35 体育#36 …
 *   素博资源：    电影#1 电视剧#2 动漫#3 综艺#4 纪录片#5 体育赛事#23 …
 * 所以这里把各站的分类归并到一组固定的中文大类（见 BUCKETS），
 * 大类下再按子分类（动作片 / 韩剧 / 大陆综艺 …）细分（见 SUBS）。
 *
 * 三个实测结论决定了查询方式：
 *   1. 父分类 id 查不出东西（`t=1` 返回 0 条），必须展开到叶子分类；
 *   2. 重复的 t 参数是按 OR 处理的（`t=6&t=7` 的 total 等于两者各自之和），
 *      所以一次请求就能覆盖一个站点在某个分类下的全部叶子；
 *   3. **归并必须按叶子分类名来判**，不能只看顶层分类：天堂／量子的「记录片」
 *      挂在「电影片」下面，非凡／天堂的「短剧」挂在「连续剧」下面，量子／天堂的
 *      「动画片」也挂在「电影片」下面——只看顶层就会把这些全算进电影或电视剧。
 */

/** 「作品类型」之外的分类，连同它整棵子树一起丢掉 */
const SKIP = /(解说|演员|明星|资讯|新闻|预告|花絮|伦理|福利|写真|片花|榜单)/

/**
 * 归并规则：从上往下第一个命中的就是结果，所以顺序有讲究
 * （「短剧」必须排在「电视剧」前面，否则会被「剧」吃掉）。
 * 「电影」里也不能写 `片$`：那会把「综艺片」「动漫片」「纪录片」全吃成电影。
 */
const BUCKETS: Array<{ name: string; re: RegExp }> = [
  { name: '电影', re: /电影|影院/ },
  { name: '短剧', re: /短剧|微剧|竖屏/ },
  { name: '纪录片', re: /纪录|记录|纪实/ },
  { name: '动漫', re: /动漫|动画|番剧|漫画|漫剧/ },
  { name: '综艺', re: /综艺|真人秀|脱口秀/ },
  { name: '体育', re: /体育|赛事|足球|篮球|台球/ },
  { name: '少儿', re: /少儿|儿童|亲子|幼教|益智/ },
  { name: '电视剧', re: /电视剧|连续剧|电视|剧集|国产剧|美剧|韩剧|日剧|港剧|台剧|泰剧/ }
]

/** 目录里大类的展示顺序 */
const ORDER = ['电影', '电视剧', '动漫', '综艺', '纪录片', '短剧', '体育', '少儿']

/**
 * 叶子名自己也命中某个大类、但它挂在另一个作品大类底下时的例外。
 *
 * 归并的主规则是「叶子名优先，认不出才往上找父分类」，这是为了救
 * `记录片`（挂在电影片下、该进纪录片）和 `短剧`（挂在连续剧下）。
 * 但同一条规则会把「电影片 → 动画片」判成动漫，而它放的其实是动画电影
 * （跟光速 / 素博的「动漫电影」是同一类东西），于是同一类内容裂成
 * 「电影 → 动画」和「动漫 → 动画片」两个区。
 *
 * 所以这里精确列出要跟着父分类走的叶子：父正则只对着祖先链匹配，
 * 别的站点真把「动画片」挂在「动漫片」下时不受影响。
 */
const LEAF_FOLLOWS_PARENT: Array<{ leaf: RegExp; parent: RegExp; bucket: string }> = [
  { leaf: /^动画片$/, parent: /电影/, bucket: '电影' }
]

/**
 * 子分类归一表。各站点对同一个子分类的叫法差别很大
 * （韩剧 / 韩国剧、美剧 / 欧美剧、港澳剧 / 香港剧），
 * 不归一的话目录里会并排出现「韩剧」和「韩国剧」两个标签。
 * 没命中的就用叶子自己的名字，所以没见过的站点也能正常显示。
 */
const SUBS: Record<string, Array<{ name: string; re: RegExp }>> = {
  电影: [
    { name: '动作', re: /动作/ },
    { name: '喜剧', re: /喜剧/ },
    { name: '爱情', re: /爱情/ },
    { name: '科幻', re: /科幻/ },
    { name: '恐怖', re: /恐怖|惊悚/ },
    { name: '剧情', re: /剧情/ },
    { name: '战争', re: /战争/ },
    { name: '动画', re: /动画|动漫/ }
  ],
  电视剧: [
    { name: '国产', re: /国产|大陆/ },
    { name: '香港', re: /香港|港澳|港剧/ },
    { name: '台湾', re: /台湾|台剧/ },
    { name: '韩国', re: /韩国|韩剧/ },
    { name: '日本', re: /日本|日剧/ },
    { name: '欧美', re: /欧美|美剧/ },
    { name: '泰国', re: /泰国|泰剧/ },
    { name: '海外', re: /海外|其他/ }
  ],
  动漫: [
    { name: '国产', re: /国产|中国/ },
    { name: '日本', re: /日本|日韩/ },
    { name: '欧美', re: /欧美/ },
    { name: '港台', re: /港台/ },
    { name: '海外', re: /海外/ },
    { name: '动画电影', re: /电影/ },
    { name: '动画片', re: /动画片/ }
  ],
  综艺: [
    { name: '大陆', re: /大陆|国产/ },
    { name: '港台', re: /港台/ },
    { name: '日韩', re: /日韩/ },
    { name: '欧美', re: /欧美/ }
  ],
  体育: [
    { name: '足球', re: /足球/ },
    { name: '篮球', re: /篮球/ },
    { name: '网球', re: /网球/ },
    { name: '台球', re: /台球|斯诺克/ },
    { name: '其他', re: /其他|综合/ }
  ],
  短剧: [
    { name: '擦边短剧', re: /擦边/ },
    { name: '古装仙侠', re: /古装|仙侠/ },
    { name: '现代都市', re: /现代|都市/ },
    { name: '穿越年代', re: /穿越|年代/ },
    { name: '言情总裁', re: /言情|总裁/ },
    { name: '重生民国', re: /重生|民国/ },
    { name: '反转爽剧', re: /反转|爽剧/ },
    { name: '脑洞悬疑', re: /脑洞|悬疑/ },
    { name: '短剧', re: /短剧|微剧|竖屏/ }
  ],
  纪录片: [{ name: '纪录片', re: /纪录|记录|纪实/ }]
}

interface ClassCacheEntry {
  at: number
  classes: SiteClass[]
}

/** 分类树半天不会变，缓存 10 分钟，免得每次进目录页都打一轮请求 */
const CLASS_TTL = 10 * 60 * 1000
const classCache = new Map<string, ClassCacheEntry>()
const inflight = new Map<string, Promise<SiteClass[]>>()
/** 换一次配置源就 +1，用来认出「还在飞的那次请求」属于上一套源 */
let categoryGeneration = 0

/**
 * 配置源一变就把分类树缓存清掉。
 * 缓存按站点 key 存，换一整套订阅后 key 不同本来也会自然失效，
 * 但「原地改掉某个源的地址」时 key 可能没变，而它的分类树已经换了，
 * 所以由 index.ts 在增删改/同步配置源时主动作废。
 */
export function clearCategoryCache(): void {
  classCache.clear()
  inflight.clear()
  // inflight.clear() 只是让后来者重新发请求，**已经在飞的那次**跑完照样会
  // 把结果写进 classCache —— 于是上一套源的分类树又盖回来了。用代次号挡住。
  categoryGeneration++
}

function str(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim()
}

/** 把 `class` 数组归一化成 {id,name,pid}，缺字段的条目直接丢掉 */
export function normalizeClasses(raw: unknown): SiteClass[] {
  return asArray<Record<string, unknown>>(raw)
    .map((item) => ({
      id: str(item.type_id ?? item.id ?? item.tid),
      name: str(item.type_name ?? item.name ?? item.title),
      pid: str(item.type_pid ?? item.pid ?? '0') || '0'
    }))
    .filter((c) => c.id && c.name)
}

/**
 * 收集某个分类子树下的**叶子** id。
 * 有子分类就往下一路展开（父分类 id 查不出东西），没有子分类就用自己。
 */
export function leafIds(classes: SiteClass[], rootId: string): string[] {
  const children = classes.filter((c) => c.pid === rootId)
  if (!children.length) return [rootId]
  return children.flatMap((c) => leafIds(classes, c.id))
}

/** 把站点自己的分类名归到固定大类 */
export function bucketOf(name: string): string | null {
  if (!name || SKIP.test(name)) return null
  for (const { name: bucket, re } of BUCKETS) if (re.test(name)) return bucket
  return null
}

/** 把叶子分类名归到某个大类下的子分类；没命中的就用它自己的名字 */
export function subOf(bucket: string, leafName: string): string {
  for (const { name, re } of SUBS[bucket] ?? []) if (re.test(leafName)) return name
  return leafName
}

/**
 * 从叶子往上找它的祖先链（叶子自己排第一）。
 * 走到顶级（pid === '0'）或者父节点不存在就停，顺便用 depth 兜住脏数据造成的环。
 */
function ancestry(leaf: SiteClass, byId: Map<string, SiteClass>): SiteClass[] {
  const chain: SiteClass[] = []
  let cur: SiteClass | undefined = leaf
  for (let depth = 0; cur && depth < 8; depth++) {
    chain.push(cur)
    if (cur.pid === '0') break
    cur = byId.get(cur.pid)
  }
  return chain
}

/** 归一化后的叶子：位于哪个大类、哪个子分类 */
interface Leaf {
  id: string
  bucket: string
  sub: string
  /** 归一表里的位置，用来给子分类排稳定顺序 */
  order: number
}

function collectLeaves(classes: SiteClass[]): Leaf[] {
  const byId = new Map(classes.map((c) => [c.id, c]))
  // 有子节点的都不是叶子
  const parents = new Set(classes.filter((c) => c.pid !== '0').map((c) => c.pid))
  const leaves: Leaf[] = []

  for (const leaf of classes) {
    if (parents.has(leaf.id)) continue

    const chain = ancestry(leaf, byId)
    // 祖先链上只要有「解说 / 伦理 / 预告」这类非作品分类，整棵子树都丢掉
    if (chain.some((c) => SKIP.test(c.name))) continue

    // 叶子自己的名字优先，认不出来才往上找父分类（「动作片」→「电影片」）
    // bucketOf 对 SKIP 名返回 null，所以这一步天然会跳过被挡的祖先
    let bucket = chain.map((c) => bucketOf(c.name)).find((b): b is string => Boolean(b))

    const follow = LEAF_FOLLOWS_PARENT.find(
      (r) => r.leaf.test(leaf.name) && chain.some((c) => r.parent.test(c.name))
    )
    if (follow) bucket = follow.bucket
    if (!bucket) continue

    const sub = subOf(bucket, leaf.name)
    const rules = SUBS[bucket] ?? []
    const at = rules.findIndex((r) => r.name === sub)
    leaves.push({ id: leaf.id, bucket, sub, order: at < 0 ? rules.length : at })
  }
  return leaves
}

async function loadClasses(site: Site): Promise<SiteClass[]> {
  const cached = classCache.get(site.key)
  if (cached && Date.now() - cached.at < CLASS_TTL) return cached.classes

  const pending = inflight.get(site.key)
  if (pending) return pending

  const gen = categoryGeneration

  const task = (async (): Promise<SiteClass[]> => {
    try {
      const url = buildCmsUrl(site, { ac: 'list' })
      const text = await fetchText(url, { header: await resolveHeader(site, url) })
      const payload = parseLooseJson(text)
      if (!isCmsOk(payload)) return []
      const classes = normalizeClasses((payload as Record<string, unknown>).class)
      // 期间换过配置源就别写回缓存了，否则上一套源的分类树会盖住新的
      if (gen === categoryGeneration) classCache.set(site.key, { at: Date.now(), classes })
      return classes
    } catch {
      // 分类拉不到不该让整个目录页崩掉，当作这个站点没有目录
      return []
    } finally {
      inflight.delete(site.key)
    }
  })()

  inflight.set(site.key, task)
  return task
}

/** 汇总各站点的分类，按「大类 → 子分类」归并后返回目录 */
export async function listCategories(): Promise<CategoryBucket[]> {
  const sites = (await getSites()).filter((s) => s.enabled && (s.type === 3 || s.type === 4))
  const trees = await Promise.all(
    sites.map(async (site) => ({ site, classes: await loadClasses(site) }))
  )

  // 大类 → 子分类 → 站点 → 叶子 id
  const grouped = new Map<string, Map<string, Map<string, { name: string; ids: Set<string>; order: number }>>>()

  for (const { site, classes } of trees) {
    for (const leaf of collectLeaves(classes)) {
      const subs = grouped.get(leaf.bucket) ?? new Map()
      grouped.set(leaf.bucket, subs)
      const sitesOfSub = subs.get(leaf.sub) ?? new Map()
      subs.set(leaf.sub, sitesOfSub)
      const entry = sitesOfSub.get(site.key) ?? { name: site.name, ids: new Set<string>(), order: leaf.order }
      for (const id of leafIds(classes, leaf.id)) entry.ids.add(id)
      sitesOfSub.set(site.key, entry)
    }
  }

  const buckets: CategoryBucket[] = []
  for (const [bucket, subs] of grouped) {
    const list: Array<CategorySub & { order: number }> = []
    for (const [name, sitesOfSub] of subs) {
      const sitesOf: CategorySiteIds[] = [...sitesOfSub.entries()]
        .filter(([, v]) => v.ids.size)
        .map(([siteKey, v]) => ({ siteKey, siteName: v.name, typeIds: [...v.ids] }))
      if (!sitesOf.length) continue
      list.push({ name, sites: sitesOf, order: Math.min(...[...sitesOfSub.values()].map((v) => v.order)) })
    }
    // 归一表里靠前的子分类排前面，表里没有的（站点自造的名字）按中文排到最后
    list.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh-CN'))
    if (list.length) buckets.push({ name: bucket, subs: list.map(({ name, sites: s }) => ({ name, sites: s })) })
  }

  const byName = new Map(buckets.map((b) => [b.name, b]))
  const known = ORDER.filter((n) => byName.has(n)).map((n) => byName.get(n)!)
  const rest = buckets
    .filter((b) => !ORDER.includes(b.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  return [...known, ...rest]
}

function fail(site: Site, message: string, ms = 0): SiteSearchResult {
  return { siteKey: site.key, siteName: site.name, ok: false, ms, message, list: [] }
}

interface SitePage {
  result: SiteSearchResult
  /** 站点自己报的总页数，拿不到时退回「这一页满不满」的猜测 */
  pageCount: number
}

async function browseSite(
  site: Site,
  typeIds: string[],
  page: number,
  limit: number
): Promise<SitePage> {
  const started = Date.now()
  try {
    // ac=detail 会把 vod_play_url 一起带回来，详情页就不用再请求一次
    const url = buildCmsBrowseUrl(site, 'detail', typeIds, page)
    const text = await fetchText(url, { header: await resolveHeader(site, url) })
    const ms = Date.now() - started
    const payload = parseLooseJson(text)
    if (!isCmsOk(payload)) {
      const msg = str((payload as Record<string, unknown>)?.msg) || '接口返回异常'
      return { result: fail(site, `接口返回异常：${msg}`, ms), pageCount: 0 }
    }
    const body = payload as Record<string, unknown>
    const raw = asArray<Record<string, unknown>>(body.list)
    const list = raw.slice(0, limit).map((item) => cmsItemToVod(item, site))
    // 多数采集站每页固定 20 条，和我们要的 limit 不一定一致，
    // 所以页数优先读接口自己报的 pagecount，读不到才按「这一页满没满」猜
    const reported = Number(body.pagecount)
    const pageCount = Number.isFinite(reported) && reported > 0 ? reported : list.length ? page + 1 : page
    if (!list.length) return { result: fail(site, '这个分类下没有返回内容', ms), pageCount }
    return {
      result: {
        siteKey: site.key,
        siteName: site.name,
        ok: true,
        ms,
        message: `返回 ${list.length} 条`,
        list
      },
      pageCount
    }
  } catch (err) {
    return { result: fail(site, (err as Error).message, Date.now() - started), pageCount: 0 }
  }
}

/**
 * 把同一个站点上多个子分类的结果交替穿插成一条列表。
 * 直接首尾相接的话，第一屏会全是某个子分类的片子；交替取能让第一屏就有各种类型。
 * 顺带按 vod_id 去重（同一个片子在站点的多个分类下都可能出现）。
 */
function interleave(lists: Vod[][]): Vod[] {
  const out: Vod[] = []
  const seen = new Set<string>()
  const depth = Math.max(0, ...lists.map((l) => l.length))
  for (let i = 0; i < depth; i++) {
    for (const list of lists) {
      const vod = list[i]
      if (!vod || seen.has(vod.vod_id)) continue
      seen.add(vod.vod_id)
      out.push(vod)
    }
  }
  return out
}

/**
 * 打开某个大类（可选某个子分类）的一页。
 * `sub` 传空串表示「全部」，这时会把该大类下**每个**子分类都查一遍再合并。
 */
export async function browseCategory(bucket: string, sub = '', page = 1): Promise<CategoryPage> {
  const categories = await listCategories()
  const target = categories.find((c) => c.name === bucket)
  if (!target) throw new Error(`没有找到「${bucket}」这个分类`)

  const picked = sub ? target.subs.filter((s) => s.name === sub) : target.subs
  if (!picked.length) throw new Error(`「${bucket}」下没有「${sub}」这个子分类`)

  const limit = 30
  const all = await getSites()
  const byKey = new Map(all.map((s) => [s.key, s]))

  // 一个子分类一个请求。**不能把多个叶子 id 塞进同一次请求**：重复的 t 参数
  // 服务端只认最后一个（实测 t=6&t=7 的 total 等于 t=7，返回的也全是喜剧片），
  // 所以「全部」只能分开查、拿回结果以后自己合并。
  interface Job {
    siteKey: string
    siteName: string
    site: Site
    ids: string[]
  }
  const jobs: Job[] = []
  for (const s of picked) {
    for (const entry of s.sites) {
      const site = byKey.get(entry.siteKey)
      if (site) jobs.push({ siteKey: entry.siteKey, siteName: entry.siteName, site, ids: entry.typeIds })
    }
  }

  const settings = await getSettings()
  const concurrency = Math.max(1, Math.min(32, settings.concurrency ?? 8))
  const pages: SitePage[] = new Array(jobs.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= jobs.length) return
      const job = jobs[index]
      pages[index] = await browseSite(job.site, job.ids, page, limit)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()))

  // 按站点归拢，同一站点的多个子分类合并成一条结果（界面上一站一个 chip）
  const perSite = new Map<string, { siteName: string; results: SiteSearchResult[] }>()
  for (let i = 0; i < jobs.length; i++) {
    const slot = perSite.get(jobs[i].siteKey) ?? { siteName: jobs[i].siteName, results: [] }
    slot.results.push(pages[i].result)
    perSite.set(jobs[i].siteKey, slot)
  }

  const results: SiteSearchResult[] = []
  // 一个站点能翻多深，取决于它**最浅**的那个子分类——只有每个子分类都还有第 N 页，
  // 合并出来的第 N 页才是完整的
  const siteDepth: number[] = []
  for (const [siteKey, slot] of perSite) {
    const ok = slot.results.filter((r) => r.ok)
    const list = interleave(ok.map((r) => r.list)).slice(0, limit)
    if (!list.length) {
      results.push(
        slot.results.find((r) => !r.ok) ?? {
          siteKey,
          siteName: slot.siteName,
          ok: false,
          ms: 0,
          message: '这个分类下没有返回内容',
          list: []
        }
      )
      continue
    }
    const depths = jobs
      .map((job, i) => (job.siteKey === siteKey ? pages[i].pageCount : 0))
      .filter((n) => n > 0)
    if (depths.length) siteDepth.push(Math.min(...depths))
    results.push({
      siteKey,
      siteName: slot.siteName,
      ok: true,
      ms: Math.max(...slot.results.map((r) => r.ms)),
      message: `返回 ${list.length} 条`,
      list
    })
  }

  // 各站点能翻到的深度不一样，取最深的那个，界面上至少能一直翻到某一站到底
  const pageCount = Math.max(page, ...siteDepth)
  return { page, pageCount, bucket, sub, results }
}
