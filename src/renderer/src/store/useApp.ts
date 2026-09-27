import { create } from 'zustand'
import type {
  AppInfo,
  AppSettings,
  CategoryBucket,
  CategoryPage,
  ConfigSource,
  FavoriteItem,
  HistoryGroup,
  HistoryItem,
  HomeSection,
  LiveResult,
  Site,
  SiteSearchResult,
  SourcePresetInfo,
  Vod,
  VodDetail
} from '@shared/types'
import { isCommentary, normalizeName, scoreCandidate } from '@/utils/normalize'

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'warn' | 'danger'
  text: string
}

/** 收藏与历史都以 `${siteKey}::${vodId}` 为主键：同一部片换源后剧集地址不同，进度不能通用 */
export const libraryKey = (siteKey: string, vodId: string): string => `${siteKey}::${vodId}`

/** 上一次已经提示过的直播源失败签名，用来避免每次进直播页都重复弹同一条警告 */
let lastLiveWarn = ''

export type FavoriteInput = Omit<FavoriteItem, 'addedAt'>
export type HistoryInput = Omit<HistoryItem, 'updatedAt'>

/** 把一条影片记录转成收藏项，省得每个页面各写一遍字段映射 */
export function toFavoriteInput(
  vod: Pick<Vod, 'siteKey' | 'siteName' | 'vod_id' | 'vod_name' | 'vod_pic' | 'vod_remarks' | 'vod_score'>
): FavoriteInput {
  return {
    siteKey: vod.siteKey,
    siteName: vod.siteName,
    vodId: String(vod.vod_id),
    name: vod.vod_name,
    pic: vod.vod_pic,
    remarks: vod.vod_remarks,
    score: vod.vod_score
  }
}

/** 一次聚合搜索的完整状态；离开页面再回来时结果还在 */
export interface SearchSession {
  wd: string
  running: boolean
  total: number
  done: number
  results: SiteSearchResult[]
  /** 参与搜索的站点 key，用于筛选 chips */
  scope: string[]
  error?: string
}

/** 聚合视图里的一条：同名影片可能来自多个站点 */
export interface MergedVod extends Vod {
  /** 拥有这部影片的全部站点 key（第一个是代表） */
  allSiteKeys: string[]
  /** 除了代表之外，其它可切换的站点 */
  alternatives: Vod[]
}

/**
 * 搜索的批次号。React 的 StrictMode 会把副作用跑两遍，界面上的「清空再搜」
 * 也可能连发两次；旧的一批必须彻底闭嘴，否则它晚一步返回的空结果会把新一批
 * 的真实结果盖掉。
 */
let searchRunId = 0

const emptySearch = (): SearchSession => ({
  wd: '',
  running: false,
  total: 0,
  done: 0,
  results: [],
  scope: []
})

/** 分类浏览的一次会话（大类 + 子分类 + 已经翻到第几页 + 累积的结果） */
export interface BrowseSession {
  bucket: string
  /** 选中的子分类名，空串表示「全部」 */
  sub: string
  page: number
  pageCount: number
  /** 正在加载第一页 */
  running: boolean
  /** 正在追加下一页 */
  loadingMore: boolean
  results: SiteSearchResult[]
  error?: string
}

const emptyBrowse = (): BrowseSession => ({
  bucket: '',
  sub: '',
  page: 0,
  pageCount: 0,
  running: false,
  loadingMore: false,
  results: []
})

/**
 * 站点集合一变（同步订阅 / 启停站点），分类目录和当前浏览结果就作废。
 * 主进程那份 classCache 是按站点 key 存的，换源后 key 不同会自然失效；
 * 但渲染进程这份 categories 是个数组，不清掉的话 Search.tsx 里
 * `if (categories.length || categoriesLoading) return` 那道守卫
 * 会让目录一直停在上一套分类上 —— 表现就是「子分类只剩几个」。
 */
const staleCatalog = () => ({
  categories: [],
  categoriesLoading: false,
  browse: emptyBrowse(),
  /** 换了配置源 / 改了启用开关，首页内容位也得重拉（主进程那边缓存也清了） */
  home: [] as HomeSection[],
  homeLoaded: false
})

/** 同 searchRunId：连点两个分类时，先发起的那一批要闭嘴 */
let browseRunId = 0

/**
 * 后台预取的下一页。
 *
 * 实测首屏 5 个站点并发拉一页要 3~4 秒；等用户滚到底才发请求就是干等 3 秒。
 * 所以首屏一画完就把下一页悄悄拉好，滚到那里直接用现成的。
 * key 里带上 bucket/sub/page，换分类或换子分类就对不上，自然作废。
 */
let browsePrefetch: { key: string; promise: Promise<CategoryPage> } | null = null

function prefetchKey(bucket: string, sub: string, page: number): string {
  return `${bucket}::${sub}::${page}`
}

/** 悄悄拉下一页。已经到底、或者同一页已经在飞，就什么都不做 */
function startBrowsePrefetch(bucket: string, sub: string, page: number, pageCount: number): void {
  if (!bucket || page < 1 || page > pageCount) return
  const key = prefetchKey(bucket, sub, page)
  if (browsePrefetch?.key === key) return
  const promise = window.api.category.browse(bucket, sub, page)
  // 预取失败不弹提示：用户还没滚到那儿，真翻页时会再走一次正常流程并如实报错
  promise.catch(() => undefined)
  browsePrefetch = { key, promise }
}

/** 取走预取好的那一页；没有或对不上就返回 null，调用方自己发请求 */
function takeBrowsePrefetch(
  bucket: string,
  sub: string,
  page: number
): Promise<CategoryPage> | null {
  if (browsePrefetch?.key !== prefetchKey(bucket, sub, page)) return null
  const promise = browsePrefetch.promise
  browsePrefetch = null
  return promise
}

export function detailKey(siteKey: string, vodId: string): string {
  return `${siteKey}::${vodId}`
}

/**
 * 片名与关键词的贴合度，越小越靠前。
 * 只按「有几个源」排会把《庆余年之帝王业》排到《庆余年第一季》前面，
 * 所以要先用关键词贴合度兜住相关性，再让源多的胜出。
 */
function matchRank(name: string, keyword: string): number {
  const n = normalizeName(name)
  const k = normalizeName(keyword)
  if (!k) return 3
  if (n === k) return 0
  if (n.startsWith(k)) return 1
  if (n.includes(k)) return 2
  return 3
}

/**
 * 同一个站点可能对同一部影片返回好几条（国语版 / 粤语版 / 重复收录），
 * 这里每个站点只留一条：先看信息全不全，再优先用最干净的那个片名，
 * 免得卡片上顶着「庆余年第二季粤语」这种带了后缀的标题。
 */
function collapseBySite(list: Vod[]): Vod[] {
  const sorted = [...list].sort((a, b) => {
    const sa = scoreCandidate(a)
    const sb = scoreCandidate(b)
    if (sa !== sb) return sb - sa
    return (a.vod_name ?? '').length - (b.vod_name ?? '').length
  })
  const seen = new Set<string>()
  const out: Vod[] = []
  for (const vod of sorted) {
    if (seen.has(vod.siteKey)) continue
    seen.add(vod.siteKey)
    out.push(vod)
  }
  return out
}

/**
 * 把各站点的结果按归一化片名合并成「一部影片一条」。
 *
 * 代表条目取信息最全的那条（有海报 > 有备注 > 有评分），所以合并后的卡片
 * 不会因为先到的站点没给海报就变成灰块。
 */
export function mergeResults(
  results: SiteSearchResult[],
  options: {
    keyword?: string
    filterCommentary?: boolean
    /**
     * 上一轮已经上屏的顺序（归一化片名 → 名次），只有分类浏览翻页时会传。
     * 传了就把老卡片原样排在前面、新一页的追在后面。
     */
    previousOrder?: Map<string, number>
  } = {}
): { merged: MergedVod[]; hidden: number } {
  const { keyword = '', filterCommentary = true } = options
  const groups = new Map<string, Vod[]>()
  let hidden = 0

  for (const result of results) {
    for (const vod of result.list) {
      const name = (vod.vod_name ?? '').trim()
      if (!name) continue
      if (filterCommentary && isCommentary(name, vod.type_name)) {
        hidden++
        continue
      }
      const key = normalizeName(name)
      if (!key) continue
      const bucket = groups.get(key)
      if (!bucket) groups.set(key, [vod])
      else bucket.push(vod)
    }
  }

  const merged: MergedVod[] = []
  for (const bucket of groups.values()) {
    const bySite = collapseBySite(bucket)
    const [best, ...rest] = bySite
    merged.push({ ...best, allSiteKeys: bySite.map((v) => v.siteKey), alternatives: rest })
  }

  merged.sort((a, b) => {
    const ra = matchRank(a.vod_name, keyword)
    const rb = matchRank(b.vod_name, keyword)
    if (ra !== rb) return ra - rb
    if (a.allSiteKeys.length !== b.allSiteKeys.length) {
      return b.allSiteKeys.length - a.allSiteKeys.length
    }
    const sa = scoreCandidate(a)
    const sb = scoreCandidate(b)
    if (sa !== sb) return sb - sa
    return a.vod_name.localeCompare(b.vod_name, 'zh-CN')
  })

  // 翻页时保住已经上屏的顺序。
  //
  // 上面那个排序的第一关键字是「有几个源」，而新一页里和第一页同名的条目会并进
  // 已有的组、把它的源数抬高，于是那一组整块跳到最前面 —— 实测加载第 2 页时
  // 开头从「法医秦明之龙番往事 / 黑岛监狱 / 兰香如故」变成「惩罚者2026 /
  // 蜂鸟行动 / 热血部落」，看起来就是「一加载下一页全部刷新」。
  //
  // 所以翻页时分成两拨：上一轮已经在屏幕上的按原名次排前面，新出来的按自己
  // 的名次追在后面。搜索不传 previousOrder（那边本来就希望好结果往上浮）。
  const previous = options.previousOrder
  if (previous?.size) {
    const known: MergedVod[] = []
    const fresh: MergedVod[] = []
    for (const v of merged) {
      const k = normalizeName(v.vod_name)
      if (previous.has(k)) known.push(v)
      else fresh.push(v)
    }
    known.sort(
      (a, b) =>
        (previous.get(normalizeName(a.vod_name)) ?? 0) -
        (previous.get(normalizeName(b.vod_name)) ?? 0)
    )
    merged.length = 0
    merged.push(...known, ...fresh)
  }

  return { merged, hidden }
}

/**
 * 详情页用的「同一部影片的全部片源」。
 *
 * 直接用搜索结果里归一化片名相同的条目，并保证当前正在看的这一条在里面
 * （即使它的片名和搜索结果差几个字，也不会把自己弄丢）。
 */
export function findSourceGroup(
  results: SiteSearchResult[],
  current: { siteKey: string; vodId: string; vodName: string },
  siteNames: Map<string, string>,
  filterCommentary = true
): Vod[] {
  const target = normalizeName(current.vodName)
  const picked = new Map<string, Vod>()

  if (target) {
    for (const result of results) {
      for (const vod of result.list) {
        if (filterCommentary && isCommentary(vod.vod_name, vod.type_name)) continue
        if (normalizeName(vod.vod_name) !== target) continue
        const prev = picked.get(vod.siteKey)
        // 每个站点只留一条：正在看的这条永远保留，其余取信息更全的
        const isCurrent = vod.siteKey === current.siteKey && vod.vod_id === current.vodId
        const prevIsCurrent = prev?.vod_id === current.vodId
        if (!prev || isCurrent || (!prevIsCurrent && scoreCandidate(vod) > scoreCandidate(prev))) {
          picked.set(vod.siteKey, vod)
        }
      }
    }
  }

  const out = [...picked.values()]

  // 当前这条即便没出现在搜索结果里（比如直接从收藏点进来），也要在最前面
  const currentIndex = out.findIndex(
    (v) => v.siteKey === current.siteKey && v.vod_id === current.vodId
  )
  if (currentIndex >= 0) {
    out.unshift(...out.splice(currentIndex, 1))
  } else {
    out.unshift({
      vod_id: current.vodId,
      vod_name: current.vodName,
      vod_pic: '',
      vod_remarks: '',
      vod_year: '',
      vod_area: '',
      vod_actor: '',
      vod_director: '',
      type_name: '',
      vod_score: '',
      siteKey: current.siteKey,
      siteName: siteNames.get(current.siteKey) ?? current.siteKey,
      sourceId: ''
    })
  }

  return out
}

interface AppState {
  ready: boolean
  info: AppInfo | null
  settings: AppSettings | null
  sources: ConfigSource[]
  sites: Site[]
  /** 正在同步中的配置源 id */
  syncing: Record<string, boolean>
  toasts: Toast[]
  /** 内置推荐订阅（首启页与设置页展示，点一下才添加） */
  presets: SourcePresetInfo[]

  search: SearchSession
  /** 详情缓存，key 由 detailKey() 生成 */
  details: Record<string, VodDetail>

  /** 分类目录（各站点分类归并后的大类） */
  categories: CategoryBucket[]
  categoriesLoading: boolean
  browse: BrowseSession

  /** 电视直播：所有配置源里的频道合并后的结果 */
  live: LiveResult | null
  liveLoading: boolean

  /** 收藏与观看历史（历史已按片名合并成「一部剧一条」） */
  favorites: FavoriteItem[]
  history: HistoryGroup[]

  /** 首页内容位（一行一个源 / 一个分类） */
  home: HomeSection[]
  homeLoading: boolean
  /** 这一轮启动有没有拉过首页内容位（Home.tsx 用它决定要不要自动触发） */
  homeLoaded: boolean

  init: () => Promise<void>
  refreshSources: () => Promise<void>
  refreshSites: () => Promise<void>
  refreshAll: () => Promise<void>
  syncSource: (id: string) => Promise<void>
  syncAll: () => Promise<void>
  addPreset: (id: string) => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  setSiteEnabled: (key: string, enabled: boolean) => Promise<void>
  setSitesEnabled: (keys: string[], enabled: boolean) => Promise<void>
  runSearch: (wd: string, sites?: string[]) => Promise<void>
  clearSearch: () => void
  loadDetail: (siteKey: string, vodId: string) => Promise<VodDetail>
  loadCategories: () => Promise<void>
  browseCategory: (bucket: string, sub?: string) => Promise<void>
  browseMore: () => Promise<void>
  clearBrowse: () => void
  loadLive: (force?: boolean) => Promise<void>
  loadLibrary: () => Promise<void>
  toggleFavorite: (vod: FavoriteInput) => Promise<void>
  removeFavorite: (key: string) => Promise<void>
  clearFavorites: () => Promise<void>
  recordHistory: (entry: HistoryInput) => Promise<void>
  /** key 是 HistoryGroup.key（归一化片名），删掉这部片在所有源上的记录 */
  removeHistory: (key: string) => Promise<void>
  clearHistory: () => Promise<void>
  /** 拉首页内容位；force=true 时连主进程的 10 分钟缓存一起绕过 */
  loadHome: (force?: boolean) => Promise<void>
  notify: (text: string, kind?: Toast['kind']) => void
  dismiss: (id: number) => void
}

let toastSeq = 0

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  info: null,
  settings: null,
  sources: [],
  sites: [],
  syncing: {},
  toasts: [],
  presets: [],

  search: emptySearch(),
  details: {},

  categories: [],
  categoriesLoading: false,
  browse: emptyBrowse(),

  live: null,
  liveLoading: false,

  favorites: [],
  history: [],

  home: [],
  homeLoading: false,
  homeLoaded: false,

  async init() {
    const [info, settings, sources, sites, presets, library] = await Promise.all([
      window.api.info(),
      window.api.settings.get(),
      window.api.sources.list(),
      window.api.sites.list(),
      window.api.sources.presets(),
      window.api.library.get()
    ])
    set({
      info,
      settings,
      sources,
      sites,
      presets,
      favorites: library.favorites,
      history: library.history,
      ready: true
    })
    applyTheme(settings)
  },

  async refreshSources() {
    set({ sources: await window.api.sources.list() })
  },

  async refreshSites() {
    set({ sites: await window.api.sites.list(), ...staleCatalog() })
  },

  async refreshAll() {
    await Promise.all([get().refreshSources(), get().refreshSites()])
  },

  async addPreset(id) {
    try {
      const source = await window.api.sources.addPreset(id)
      await get().refreshSources()
      await get().syncSource(source.id)
    } catch (err) {
      get().notify((err as Error).message, 'danger')
    }
  },

  async syncSource(id) {
    set((s) => ({ syncing: { ...s.syncing, [id]: true } }))
    try {
      const updated = await window.api.sources.sync(id)
      set((s) => ({
        sources: s.sources.map((x) => (x.id === id ? updated : x))
      }))
      if (updated.error) get().notify(`「${updated.name}」同步失败：${updated.error}`, 'danger')
      else get().notify(`「${updated.name}」同步完成，${updated.siteCount} 个站点`, 'success')
      await get().refreshSites()
    } catch (err) {
      get().notify((err as Error).message, 'danger')
    } finally {
      set((s) => {
        const next = { ...s.syncing }
        delete next[id]
        return { syncing: next }
      })
    }
  },

  async syncAll() {
    const ids = get().sources.filter((s) => s.enabled).map((s) => s.id)
    if (!ids.length) {
      get().notify('没有已启用的配置源', 'warn')
      return
    }
    set({ syncing: Object.fromEntries(ids.map((id) => [id, true])) })
    try {
      const results = await window.api.sources.syncAll()
      set((s) => ({
        sources: s.sources.map((x) => results.find((r) => r.id === x.id) ?? x)
      }))
      const failed = results.filter((r) => r.error)
      if (failed.length) get().notify(`${results.length - failed.length} 个成功，${failed.length} 个失败`, 'warn')
      else get().notify(`已同步 ${results.length} 个配置源`, 'success')
      await get().refreshSites()
    } catch (err) {
      get().notify((err as Error).message, 'danger')
    } finally {
      set({ syncing: {} })
    }
  },

  async updateSettings(patch) {
    const settings = await window.api.settings.set(patch)
    set({ settings })
    applyTheme(settings)
  },

  async setSiteEnabled(key, enabled) {
    await window.api.sites.setEnabled(key, enabled)
    set((s) => ({
      sites: s.sites.map((x) => (x.key === key ? { ...x, enabled } : x)),
      ...staleCatalog()
    }))
  },

  async setSitesEnabled(keys, enabled) {
    await window.api.sites.setAllEnabled(keys, enabled)
    const set0 = new Set(keys)
    set((s) => ({
      sites: s.sites.map((x) => (set0.has(x.key) ? { ...x, enabled } : x)),
      ...staleCatalog()
    }))
  },

  async runSearch(wd, sites) {
    const keyword = (wd ?? '').trim()
    if (!keyword) return
    const runId = ++searchRunId
    // 先把上一次搜索停掉，否则它还会继续往结果里塞数据
    await window.api.search.cancel()
    // cancel() 是异步的，这期间可能又发起了新的一批，那这一批就该直接放弃
    if (runId !== searchRunId) return
    set({
      search: { wd: keyword, running: true, total: 0, done: 0, results: [], scope: sites ?? [] }
    })

    const off = window.api.search.onProgress((p) => {
      if (runId !== searchRunId) return
      set((s) => {
        if (s.search.wd !== p.wd) return {}
        const results = s.search.results.filter((r) => r.siteKey !== p.result.siteKey)
        results.push(p.result)
        return { search: { ...s.search, done: p.done, total: p.total, results } }
      })
    })

    try {
      const res = await window.api.search.run(keyword, sites?.length ? { sites } : undefined)
      if (runId !== searchRunId) return
      set((s) =>
        s.search.wd === keyword
          ? {
              search: {
                ...s.search,
                running: false,
                total: res.total,
                done: res.results.length,
                results: res.results
              }
            }
          : {}
      )
    } catch (err) {
      if (runId !== searchRunId) return
      set((s) => ({ search: { ...s.search, running: false, error: (err as Error).message } }))
      get().notify(`搜索失败：${(err as Error).message}`, 'danger')
    } finally {
      off()
    }
  },

  clearSearch() {
    // 让还在路上的那一批结果作废
    searchRunId++
    set({ search: emptySearch() })
  },

  async loadDetail(siteKey, vodId) {
    const key = detailKey(siteKey, vodId)
    const cached = get().details[key]
    if (cached) return cached
    const detail = await window.api.detail.get(siteKey, vodId)
    set((s) => ({ details: { ...s.details, [key]: detail } }))
    return detail
  },

  async loadCategories() {
    set({ categoriesLoading: true })
    try {
      const categories = await window.api.category.list()
      set({ categories, categoriesLoading: false })
    } catch (err) {
      set({ categoriesLoading: false })
      get().notify(`读取分类目录失败：${(err as Error).message}`, 'danger')
    }
  },

  async browseCategory(bucket, sub = '') {
    const runId = ++browseRunId
    // 换分类就把手上那份预取作废
    browsePrefetch = null
    set({ browse: { ...emptyBrowse(), bucket, sub, running: true } })
    try {
      const page = await window.api.category.browse(bucket, sub, 1)
      if (runId !== browseRunId) return
      set((s) => ({
        browse: {
          ...s.browse,
          running: false,
          sub,
          page: page.page,
          pageCount: page.pageCount,
          results: page.results
        }
      }))
      // 首屏已经上屏了，趁用户看第一页的时候把下一页拉好
      startBrowsePrefetch(bucket, sub, page.page + 1, page.pageCount)
    } catch (err) {
      if (runId !== browseRunId) return
      set((s) => ({ browse: { ...s.browse, running: false, error: (err as Error).message } }))
      get().notify(`加载「${bucket}」失败：${(err as Error).message}`, 'danger')
    }
  },

  async browseMore() {
    const current = get().browse
    if (!current.bucket || current.running || current.loadingMore) return
    if (current.page >= current.pageCount) return
    const runId = browseRunId
    const next = current.page + 1
    // 进入新一页前先清掉上一次的失败标记，否则界面上的「重试」会一直是错误态
    set((s) => ({ browse: { ...s.browse, loadingMore: true, error: undefined } }))
    try {
      // 首屏之后我们已经在后台把这一页拉好了，直接取现成的；没取到才自己发请求
      const page =
        takeBrowsePrefetch(current.bucket, current.sub, next) ??
        window.api.category.browse(current.bucket, current.sub, next)
      const resolved = await page
      if (runId !== browseRunId) return
      set((s) => {
        // 同一个站点在新的页码上返回整批重复内容时（有些站点翻页是假的），
        // 用 siteKey + vod_id 去重，免得界面上出现两遍同样的卡片。
        // 注意是「把新一页接到旧列表后面」，不是用新一页整个替换掉——
        // 替换的话页面上永远只有最后一页那几条。
        const seen = new Set(
          s.browse.results.flatMap((r) => r.list.map((v) => `${r.siteKey}::${v.vod_id}`))
        )
        const byKey = new Map(s.browse.results.map((r) => [r.siteKey, r]))
        for (const r of resolved.results) {
          const fresh = r.list.filter((v) => !seen.has(`${r.siteKey}::${v.vod_id}`))
          const prev = byKey.get(r.siteKey)
          byKey.set(r.siteKey, { ...r, list: prev ? [...prev.list, ...fresh] : fresh })
        }
        return {
          browse: {
            ...s.browse,
            loadingMore: false,
            page: resolved.page,
            pageCount: Math.max(s.browse.pageCount, resolved.pageCount),
            results: [...byKey.values()]
          }
        }
      })
      // 接着把下下页也拉好，这样一路往下滚都是一次到位
      startBrowsePrefetch(
        current.bucket,
        current.sub,
        resolved.page + 1,
        Math.max(current.pageCount, resolved.pageCount)
      )
    } catch (err) {
      if (runId !== browseRunId) return
      const message = (err as Error).message
      // 页码不前进，所以自动加载必须靠 error 停下来：否则哨兵一直在视口里就会
      // 无限重试同一页，把站点打爆、界面也一直转圈。
      set((s) => ({ browse: { ...s.browse, loadingMore: false, error: message } }))
      get().notify(`加载下一页失败：${message}`, 'danger')
    }
  },

  clearBrowse() {
    browseRunId++
    browsePrefetch = null
    set({ browse: emptyBrowse() })
  },

  async loadLive(force = false) {
    if (get().liveLoading) return
    // 这里刻意不拿内存里的 live 当缓存直接返回：主进程那份缓存会在配置源变动时
    // 作废，渲染进程这份不会。之前写成 `if (!force && get().live) return`，
    // 结果同步完新订阅再进电视直播，看到的还是上一个源的分组，只有重启才好。
    // 现在每次进页面都问一次主进程，它缓存还新鲜时就是一个来回的 IPC，很便宜。
    set({ liveLoading: true })
    try {
      const live = await window.api.live.load(force)
      set({ live, liveLoading: false })
      const bad = live.sources.filter((s) => s.error)
      const sig = bad.map((s) => `${s.name}:${s.error}`).join('|')
      if (bad.length) {
        // 同一个错误只说一次，否则每次进直播页都弹一遍
        if (sig !== lastLiveWarn) {
          lastLiveWarn = sig
          get().notify(`${bad.length} 个直播源没拉到频道：${bad[0].error}`, 'warn')
        }
      } else {
        lastLiveWarn = ''
      }
    } catch (err) {
      set({ liveLoading: false })
      get().notify(`读取直播源失败：${(err as Error).message}`, 'danger')
    }
  },

  async loadLibrary() {
    const { favorites, history } = await window.api.library.get()
    set({ favorites, history })
  },

  async toggleFavorite(vod) {
    const { favorited } = await window.api.library.toggleFavorite(vod)
    await get().loadLibrary()
    get().notify(favorited ? `已收藏「${vod.name}」` : `已取消收藏「${vod.name}」`, 'success')
  },

  async removeFavorite(key) {
    await window.api.library.removeFavorite(key)
    await get().loadLibrary()
  },

  async clearFavorites() {
    await window.api.library.clearFavorites()
    await get().loadLibrary()
    get().notify('收藏已清空', 'success')
  },

  async recordHistory(entry) {
    await window.api.library.record(entry)
    await get().loadLibrary()
  },

  async removeHistory(key) {
    await window.api.library.removeHistory(key)
    await get().loadLibrary()
  },

  async clearHistory() {
    await window.api.library.clearHistory()
    await get().loadLibrary()
    get().notify('观看历史已清空', 'success')
  },

  async loadHome(force = false) {
    if (get().homeLoading) return
    set({ homeLoading: true })
    try {
      const home = await window.api.home.sections(force)
      set({ home, homeLoading: false, homeLoaded: true })
      if (force) get().notify(`内容位已刷新（${home.length} 行）`, 'success')
    } catch (err) {
      set({ homeLoading: false, homeLoaded: true })
      get().notify(`首页内容位拉取失败：${(err as Error).message}`, 'danger')
    }
  },

  notify(text, kind = 'info') {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
    setTimeout(() => get().dismiss(id), kind === 'danger' ? 6000 : 3000)
  },

  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  }
}))

/** 把设置里的强调色与密度写到根节点，CSS 变量驱动全局 */
function applyTheme(settings: AppSettings): void {
  const root = document.documentElement
  if (settings.accent) {
    root.style.setProperty('--accent', settings.accent)
    root.style.setProperty('--accent-hover', shade(settings.accent, -12))
  }
  root.dataset.density = settings.density
}

/** 简单调暗/调亮 hex 颜色 */
function shade(hex: string, percent: number): string {
  const m = /^#?([\da-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const num = parseInt(m[1], 16)
  const clamp = (v: number): number => Math.max(0, Math.min(255, v))
  const amt = Math.round(2.55 * percent)
  const r = clamp(((num >> 16) & 0xff) + amt)
  const g = clamp(((num >> 8) & 0xff) + amt)
  const b = clamp((num & 0xff) + amt)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}
