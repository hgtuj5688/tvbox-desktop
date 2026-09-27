/** IPC 通道名常量，主进程与渲染进程共用，避免字符串写错 */
export const IPC = {
  appInfo: 'app:info',
  openExternal: 'app:open-external',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  sourcesList: 'sources:list',
  sourcesAdd: 'sources:add',
  sourcesUpdate: 'sources:update',
  sourcesRemove: 'sources:remove',
  sourcesSync: 'sources:sync',
  sourcesSyncAll: 'sources:sync-all',
  sourcesPickFile: 'sources:pick-file',
  sourcesPresets: 'sources:presets',
  sourcesAddPreset: 'sources:add-preset',

  sitesList: 'sites:list',
  sitesSetEnabled: 'sites:set-enabled',
  sitesSetAllEnabled: 'sites:set-all-enabled',
  sitesTest: 'sites:test',

  searchRun: 'search:run',
  searchCancel: 'search:cancel',
  /** 主进程 → 渲染进程：每完成一个站点推一次 */
  searchProgress: 'search:progress',

  detailGet: 'detail:get',

  categoryList: 'category:list',
  categoryBrowse: 'category:browse',

  liveLoad: 'live:load',
  liveResolve: 'live:resolve',
  /** 读线路体检缓存 */
  liveHealth: 'live:health',
  /** 体检一批线路（点开频道时懒体检 / 切分组时预热） */
  liveProbe: 'live:probe',
  liveClearHealth: 'live:clear-health',

  libraryGet: 'library:get',
  libraryToggleFavorite: 'library:toggle-favorite',
  libraryRemoveFavorite: 'library:remove-favorite',
  libraryClearFavorites: 'library:clear-favorites',
  libraryRecord: 'library:record',
  libraryRemoveHistory: 'library:remove-history-group',
  libraryClearHistory: 'library:clear-history',

  playerDetect: 'player:detect',
  playerOpen: 'player:open',

  parseList: 'parse:list',
  parseResolve: 'parse:resolve',
  parseTest: 'parse:test',
  parseAdd: 'parse:add',
  parseRemove: 'parse:remove',
  parseResetStats: 'parse:reset-stats',

  /** 首页内容位。force=true 时忽略缓存重新拉一遍 */
  homeSections: 'home:sections',

  aiSummary: 'ai:summary',
  /** 带上从播放器里抽出来的画面，让模型真的看一遍 */
  aiSummaryVisual: 'ai:summary-visual'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
