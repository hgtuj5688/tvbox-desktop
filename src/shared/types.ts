/**
 * 主进程与渲染进程共用的类型定义。
 * 这里的结构同时兼容 TVBox 既有生态与桌面端扩展字段。
 */

/** 站点类型：0=需spider 1=网页/规则 2=自定义 3=苹果CMS 4=CMS变体 */
export type SiteType = 0 | 1 | 2 | 3 | 4

export interface Site {
  key: string
  name: string
  type: SiteType
  /** 归一化后的请求模板，含 {ac} {wd} {pg} {t} {ids} 占位符 */
  api: string
  ext?: string
  jar?: string
  searchable: boolean
  quickSearch: boolean
  filterable: boolean
  playerType: number
  categories?: string[]
  style?: { type?: string; ratio?: number }
  header?: Record<string, string>
  timeout?: number
  /** 来源配置源 id / 名称 */
  sourceId: string
  sourceName: string
  /** 本地启用开关（覆盖配置里的默认值） */
  enabled: boolean
  /** 最近一次连通性测试延迟(ms)，-1 表示失败，undefined 表示未测 */
  health?: number
  /** 不支持的原因，有值则桌面端会跳过该站点 */
  unsupported?: string
  /** 手写配置的网页解析规则 */
  rules?: HtmlRules
}

export interface HtmlRules {
  list?: string
  name?: string
  link?: string
  pic?: string
  remarks?: string
  search?: string
  detailName?: string
  detailContent?: string
  playList?: string
  playItem?: string
}

export interface ParseItem {
  name: string
  type: number
  url: string
  ext?: unknown
}

/** 一条解析接口的实测战绩，用来做「可用性排行」 */
export interface ParseStat {
  ok: number
  fail: number
  /** 最近一次成功的时间戳，0 表示从未成功 */
  lastOk: number
  /** 最近一次成功的耗时(ms) */
  lastMs: number
  lastError?: string
}

export interface ParseInfo extends ParseItem {
  /** 配置里带的，还是用户在设置页手动加的 */
  origin: 'config' | 'custom'
  /** ext.flag 里声明的线路名，空数组 = 通配 */
  flags: string[]
  stat: ParseStat
}

export interface ParseAttempt {
  name: string
  ok: boolean
  ms: number
  url?: string
  error?: string
}

export interface ParseResult {
  ok: boolean
  /** 能直接播的地址，失败时为空字符串 */
  url: string
  /** true = 本来就是直链，没走解析 */
  direct: boolean
  /** 命中的解析接口名 */
  parseName?: string
  ms: number
  attempts: ParseAttempt[]
  error?: string
}

export interface ParseTestResult {
  ok: boolean
  ms: number
  /** 测试时实际用的目标地址 */
  target: string
  url?: string
  error?: string
}


export interface LiveSource {
  name: string
  type: number | string
  url: string
  epg?: string
}

export interface HeaderRule {
  host: string
  header: Record<string, string>
}

export interface ParsedConfig {
  name: string
  notice?: string
  sites: Site[]
  parses: ParseItem[]
  lives: LiveSource[]
  flags: string[]
  headers: HeaderRule[]
  theme?: ThemeConfig
  externalPlayer?: ExternalPlayerConfig
  home?: HomeConfig
  raw: unknown
}

export interface ThemeConfig {
  accent?: string
  posterRatio?: number
  density?: 'comfortable' | 'compact'
}

export interface ExternalPlayerConfig {
  command?: string
  args?: string[]
  prefer?: string[]
}

export interface HomeConfig {
  sections?: Array<{ title: string; site: string; typeId?: number | string }>
}

export interface ConfigSource {
  id: string
  name: string
  /** 远程 URL 或本地绝对路径 */
  url: string
  kind: 'url' | 'file'
  enabled: boolean
  /** 0 表示从未成功同步 */
  lastSync: number
  /** 最近一次同步失败原因 */
  error?: string
  siteCount: number
  liveCount: number
  parseCount: number
  notice?: string
  /** 最近一次成功的原始配置，用于离线 */
  raw?: unknown
}

/** 内置推荐订阅（只把摘要送到界面，配置内容留在主进程） */
export interface SourcePresetInfo {
  id: string
  name: string
  desc: string
  siteCount: number
  liveCount: number
}

export interface Vod {
  vod_id: string
  vod_name: string
  vod_pic: string
  vod_remarks: string
  vod_year: string
  vod_area: string
  vod_actor: string
  vod_director: string
  type_name: string
  vod_score: string
  siteKey: string
  siteName: string
  sourceId: string
}

export interface Episode {
  name: string
  url: string
  index: number
}

export interface Line {
  name: string
  episodes: Episode[]
}

export interface VodDetail extends Vod {
  vod_content: string
  lines: Line[]
}

export interface Category {
  type_id: string | number
  type_name: string
}

export interface VodPage {
  page: number
  pagecount: number
  total: number
  list: Vod[]
}

export interface LiveChannel {
  name: string
  url: string
  group: string
  logo?: string
}

export interface LiveGroup {
  name: string
  channels: LiveChannel[]
}

/** 合并后的频道：同一个频道名在多个直播源里出现时，收成一张卡、卡上列多条线路 */
export interface LiveChannelEntry {
  name: string
  group: string
  logo?: string
  urls: Array<{ url: string; source: string }>
}

export interface LiveGroupEntry {
  name: string
  channels: LiveChannelEntry[]
}

export interface LiveSourceStat {
  name: string
  url: string
  channels: number
  error?: string
}

export interface LiveResult {
  groups: LiveGroupEntry[]
  /** 合并前的原始频道条数 */
  total: number
  sources: LiveSourceStat[]
}

/**
 * 一条直播线路的体检结果。
 *
 * 公开 IPTV 源里死链很多，所以界面上要能区分「确定能拉起来」和「没试过」：
 * 没试过的线路照常显示，确定拉不起来的排到最后、默认藏起来。
 */
export interface LiveHealth {
  ok: boolean
  /** 探测耗时（毫秒） */
  ms: number
  /** 探测时间戳 */
  at: number
  /** master 播放列表里最高一档的分辨率高度，用来挑高画质的那条 */
  height?: number
  /** master 播放列表里最高一档的码率 */
  bandwidth?: number
  /** 失败原因，例如 `HTTP 404` / `超时（6s）` */
  error?: string
}

/**
 * 房间号频道的播放信息。
 *
 * 虎牙/抖音的 m3u8 地址带防盗链参数（wsSecret/wsTime、ttwid），几小时就过期，
 * 所以直播源里只写 `huya://10188` 这种房间号，真正地址等点时再换。
 * referer 是必须的：两个平台都校验 Referer，缺了直接 403。
 */
export interface LiveResolved {
  /** 换出来的真实地址 */
  url: string
  /** 播放时要带的 Referer */
  referer: string
  /** 线路名，用于界面上提示换的是哪条线 */
  line?: string
}

/** 收藏的一部影片。键是 `${siteKey}::${vodId}` */
export interface FavoriteItem {
  siteKey: string
  siteName: string
  vodId: string
  name: string
  pic?: string
  remarks?: string
  score?: string
  addedAt: number
}

/** 一条观看历史，带上次看到第几条线路第几集以及播放进度 */
export interface HistoryItem {
  siteKey: string
  siteName: string
  vodId: string
  name: string
  pic?: string
  lineIndex: number
  epIndex: number
  epName: string
  /** 已播放秒数 */
  position: number
  /** 总时长秒数，直播或未知时为 0 */
  duration: number
  updatedAt: number
}

/**
 * 合并后的一条观看历史：同一部剧在多个资源上看过时合成一条。
 *
 * 分组发生在读取时（`listHistory`），磁盘上仍然是「一个源一条」，
 * 这样删掉某个源、或者换了订阅，都不会把别的源的进度一起弄丢。
 */
export interface HistoryGroup {
  /** 归一化后的片名，同一部剧在不同站点上算出来的 key 相同 */
  key: string
  /** 展示用的片名，取主记录那一条 */
  name: string
  pic?: string
  /** 同一部剧在各资源上的记录，按最近看过排序 —— items[0] 就是主记录 */
  items: HistoryItem[]
  /** 组里最新一次的观看时间 */
  updatedAt: number
}

export interface LibrarySnapshot {
  favorites: FavoriteItem[]
  history: HistoryGroup[]
}

export interface AppSettings {
  /** 聚合搜索并发数 */
  concurrency: number
  /** 单请求超时秒数 */
  timeout: number
  userAgent: string
  accent: string
  density: 'comfortable' | 'compact'
  sidebarCollapsed: boolean
  /** 搜索结果里隐藏「解说 / 速看 / 混剪」这类二创内容 */
  filterCommentary: boolean
  externalPlayer: ExternalPlayerConfig
  window: { width: number; height: number }
  /** AI 剧情总结（DeepSeek） */
  ai: AiSettings
}

export interface AiSettings {
  /** DeepSeek API Key。只存在本机 data/settings.json 里，不进代码、不上传 */
  apiKey: string
  /** 模型名。截至写这段时可用的是 deepseek-flash / deepseek-v4-pro */
  model: string
  /** 接口地址，留空就用官方 https://api.deepseek.com */
  baseUrl: string
}

/** 送给模型的一集资料。站点只提供整部剧的信息，没有分集字幕 */
export interface AiSummaryInput {
  vodName: string
  typeName?: string
  year?: string
  area?: string
  actor?: string
  director?: string
  score?: string
  remarks?: string
  /** 整部剧的简介 vod_content */
  content?: string
  epName: string
  /** 从 0 开始的集号 */
  epIndex: number
  epTotal: number
  lineName?: string
}

export interface AiSummaryResult {
  text: string
  model: string
  ms: number
  usage?: { prompt: number; completion: number; total: number }
}

/**
 * 从正在播的 <video> 上抽的一帧。b64 是裸 base64（不带 data: 前缀），
 * 渲染进程抓帧后经 IPC 传给主进程拼成 image_url。
 */
export interface AiFrame {
  /** 这一帧在片中的时间点（秒） */
  t: number
  b64: string
}

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  userData: string
}

export interface TestResult {
  ok: boolean
  ms: number
  message: string
  sample?: string
}

/* ---------- M2：聚合搜索 / 详情 / 播放 ---------- */

/** 单个站点的一次搜索结果 */
export interface SiteSearchResult {
  siteKey: string
  siteName: string
  ok: boolean
  ms: number
  /** 失败原因，或成功时的补充说明 */
  message: string
  list: Vod[]
}

/** 边搜边回报的进度事件 */
export interface SearchProgress {
  wd: string
  done: number
  total: number
  result: SiteSearchResult
}

export interface SearchResponse {
  wd: string
  /** 总耗时(ms) */
  ms: number
  total: number
  results: SiteSearchResult[]
}

export interface PlayerInfo {
  name: string
  path: string
  /** scan = 扫常见安装路径找到的；registry = 从系统文件关联里问出来的；manual = 设置里手填的 */
  source?: 'scan' | 'registry' | 'manual'
}

export interface SearchOptions {
  /** 限定站点 key，不传则搜索全部可用站点 */
  sites?: string[]
  /** 单站点最多返回多少条 */
  limitPerSite?: number
  concurrency?: number
}

/* ---------- 分类浏览 ---------- */

/** 站点自己分类树里的一个节点 */
export interface SiteClass {
  id: string
  name: string
  /** 父分类 id，顶级为 "0" */
  pid: string
}

/** 一个站点在某个子分类下可查询的叶子分类 id */
export interface CategorySiteIds {
  siteKey: string
  siteName: string
  /** 该站点在这个子分类下的叶子分类 id */
  typeIds: string[]
}

/**
 * 大类下的子分类（动作片 / 韩剧 / 大陆综艺 …）。
 * 各站点的叫法不一样（韩剧 / 韩国剧、美剧 / 欧美剧），统一归一化后再按名字合并。
 */
export interface CategorySub {
  name: string
  sites: CategorySiteIds[]
}

/**
 * 归并后的大类（电影 / 电视剧 / 动漫 …）。
 * 各站点的分类名和 id 都不一样，所以每个站点单独带一份可查询的分类 id 列表。
 */
export interface CategoryBucket {
  name: string
  /** 该大类下的子分类，「全部」不在里面，由界面自己加 */
  subs: CategorySub[]
}

export interface CategoryPage {
  page: number
  /** 已知的最大页码（各站点里最深的那个） */
  pageCount: number
  bucket: string
  /** 选中的子分类名，空串表示「全部」 */
  sub: string
  results: SiteSearchResult[]
}

/** 首页的一个内容位（一行横向滑动的内容） */
export interface HomeSection {
  /** 去重用的标识：`站点key::分类id`，没有分类时是 `站点key::latest` */
  key: string
  title: string
  /** config = 配置源的 home.sections 里写的；default = 没配时按每个可用源自动生成 */
  origin: 'config' | 'default'
  siteKey?: string
  siteName?: string
  items: Vod[]
  /** 有值表示这一条没拉起来，界面上只让这一行自己提示，不影响其它行 */
  error?: string
}
