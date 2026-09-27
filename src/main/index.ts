import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { IPC } from '@shared/ipc'
import type { AiFrame, AiSummaryInput, AppInfo, FavoriteItem, HistoryItem, SearchOptions, SearchResponse } from '@shared/types'
import { getVodDetail } from './services/detail'
import { summarizeEpisode, summarizeEpisodeVisual } from './services/ai'
import { browseCategory, clearCategoryCache, listCategories } from './services/category'
import { clearHomeCache, listHomeSections } from './services/home'
import { clearLiveCache, loadLive } from './services/live'
import { clearHealth, getHealth, probeLines } from './services/liveHealth'
import { headersFor, resolveRoomUrl } from './services/streamResolve'
import {
  clearFavorites,
  clearHistory,
  getLibrary,
  recordHistory,
  removeFavorite,
  removeHistoryGroup,
  toggleFavorite
} from './services/library'
import { ensureReachableProxy } from './services/proxy'
import { detectPlayers, openInPlayer } from './services/player'
import {
  addParse,
  listParses,
  removeParse,
  resetParseStats,
  resolvePlayUrl,
  testParse
} from './services/parse'
import type { ResolveOptions } from './services/parse'
import { cancelSearch, searchAll } from './services/search'
import { DEFAULT_SETTINGS, getSettings, saveSettings } from './services/settings'
import { getSites, setSiteEnabled, setSitesEnabled, testSite } from './services/sites'
import { addPreset, listPresets } from './services/presets'
import {
  addSource,
  hydrate,
  listSources,
  removeSource,
  syncAll,
  syncSource,
  updateSource
} from './services/sources'
import { flushStore } from './services/store'

// ── 数据目录：跟着程序走，不写 C 盘用户目录 ────────────────────────────────
// 开发时是项目根下的 data/；打包后是 exe 同级的 data/（免安装便携形态）。
// 必须在 app ready 之前调用，否则 Chromium 已经把缓存写进默认的 userData 了。
const DATA_DIR = join(app.isPackaged ? dirname(app.getPath('exe')) : app.getAppPath(), 'data')

/** 把老版本留在默认 userData 里的 store 文件搬过来，避免升级后配置丢失 */
function migrateLegacyData(legacy: string): void {
  if (legacy === DATA_DIR) return
  for (const name of ['settings', 'sources', 'sites']) {
    const from = join(legacy, `${name}.json`)
    const to = join(DATA_DIR, `${name}.json`)
    if (existsSync(to) || !existsSync(from)) continue
    try {
      copyFileSync(from, to)
    } catch {
      // 搬不动就算了，用默认值重建
    }
  }
}

function redirectUserData(): void {
  const legacy = app.getPath('userData')
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    app.setPath('userData', DATA_DIR)
    // 缓存单独放一层，让 data/ 根目录只剩我们自己的几个 json
    app.setPath('sessionData', join(DATA_DIR, 'session'))
  } catch (err) {
    // 建不出来（比如装到了只读位置）就退回默认目录，至少保证程序能启动
    console.error('[data] 无法切到便携数据目录，继续用默认目录：', err)
    return
  }
  migrateLegacyData(legacy)
}

redirectUserData()

let mainWindow: BrowserWindow | null = null

async function createWindow(): Promise<void> {
  const saved = (await getSettings()).window
  mainWindow = new BrowserWindow({
    width: saved.width || DEFAULT_SETTINGS.window.width,
    height: saved.height || DEFAULT_SETTINGS.window.height,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    // 纯白风格：先把底色刷白，避免启动瞬间的黑屏闪烁
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 必须关掉：渲染进程的页面源是 file://，而海报图与 m3u8 分片大多来自
      // 第三方 http(s) 站点，hls.js 用 XHR 拉分片时会被同源策略拦下。
      webSecurity: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 窗口尺寸记忆：拖动时防抖 400ms 再落盘，避免频繁写文件
  let resizeTimer: NodeJS.Timeout | null = null
  mainWindow.on('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isMaximized() || mainWindow.isMinimized()) return
      const [width, height] = mainWindow.getSize()
      void saveSettings({ window: { width, height } })
    }, 400)
  })

  // 外部链接一律交给系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.appInfo, (): AppInfo => {
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: `${process.platform} ${process.arch}`,
      userData: app.getPath('userData')
    }
  })

  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('仅支持打开 http/https 链接')
    await shell.openExternal(url)
  })

  ipcMain.handle(IPC.settingsGet, () => getSettings())
  ipcMain.handle(IPC.settingsSet, (_e, patch) => saveSettings(patch))

  // 配置源一变，直播频道缓存和分类树缓存就作废：否则换完订阅再进「电视直播」
  // 或「分类浏览」还会看到上一个源的分组 / 分类。
  // 放在这里而不是 sources.ts 里，是因为 live.ts / category.ts 都依赖 sources.ts，反向 import 会成环。
  ipcMain.handle(IPC.sourcesList, () => listSources())
  ipcMain.handle(IPC.sourcesAdd, async (_e, input) => {
    const result = await addSource(input)
    clearLiveCache()
    clearCategoryCache()
    clearHomeCache()
    return result
  })
  ipcMain.handle(IPC.sourcesUpdate, async (_e, id: string, patch) => {
    const result = await updateSource(id, patch)
    clearLiveCache()
    clearCategoryCache()
    clearHomeCache()
    return result
  })
  ipcMain.handle(IPC.sourcesRemove, async (_e, id: string) => {
    await removeSource(id)
    clearLiveCache()
    clearCategoryCache()
    clearHomeCache()
  })
  ipcMain.handle(IPC.sourcesSync, async (_e, id: string) => {
    const result = await syncSource(id)
    clearLiveCache()
    clearCategoryCache()
    clearHomeCache()
    return result
  })
  ipcMain.handle(IPC.sourcesSyncAll, async () => {
    const result = await syncAll()
    clearLiveCache()
    clearCategoryCache()
    clearHomeCache()
    return result
  })
  ipcMain.handle(IPC.sourcesPickFile, async (): Promise<string | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择配置文件',
      filters: [{ name: 'JSON 配置', extensions: ['json'] }],
      properties: ['openFile']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(IPC.sourcesPresets, () => listPresets())
  ipcMain.handle(IPC.sourcesAddPreset, (_e, id: string) => addPreset(id))

  ipcMain.handle(IPC.sitesList, () => getSites())
  ipcMain.handle(IPC.sitesSetEnabled, (_e, key: string, enabled: boolean) =>
    setSiteEnabled(key, enabled)
  )
  ipcMain.handle(IPC.sitesSetAllEnabled, (_e, keys: string[], enabled: boolean) =>
    setSitesEnabled(keys, enabled)
  )
  ipcMain.handle(IPC.sitesTest, (_e, key: string) => testSite(key))

  ipcMain.handle(
    IPC.searchRun,
    async (_e, wd: string, options?: SearchOptions): Promise<SearchResponse> => {
      return searchAll(wd, options ?? {}, (result, done, total) => {
        // 边搜边推：界面可以先把已完成的站点铺出来，不必等最慢的那个
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.searchProgress, { wd, done, total, result })
        }
      })
    }
  )
  ipcMain.handle(IPC.searchCancel, () => {
    cancelSearch()
  })

  ipcMain.handle(IPC.detailGet, (_e, siteKey: string, vodId: string) =>
    getVodDetail(siteKey, vodId)
  )

  ipcMain.handle(IPC.categoryList, () => listCategories())
  ipcMain.handle(IPC.categoryBrowse, (_e, bucket: string, sub: string, page: number) =>
    browseCategory(bucket, sub, page)
  )

  ipcMain.handle(IPC.liveLoad, (_e, force?: boolean) => loadLive(Boolean(force)))
  ipcMain.handle(IPC.liveResolve, (_e, url: string) => resolveRoomUrl(url))
  ipcMain.handle(IPC.liveHealth, () => getHealth())
  ipcMain.handle(IPC.liveProbe, (_e, urls: string[], options?: { timeout?: number; force?: boolean }) =>
    probeLines(Array.isArray(urls) ? urls : [], options ?? {})
  )
  ipcMain.handle(IPC.liveClearHealth, () => clearHealth())

  ipcMain.handle(IPC.libraryGet, () => getLibrary())
  ipcMain.handle(IPC.libraryToggleFavorite, (_e, input: Omit<FavoriteItem, 'addedAt'>) =>
    toggleFavorite(input)
  )
  ipcMain.handle(IPC.libraryRemoveFavorite, (_e, key: string) => removeFavorite(key))
  ipcMain.handle(IPC.libraryClearFavorites, () => clearFavorites())
  ipcMain.handle(IPC.libraryRecord, (_e, input: Omit<HistoryItem, 'updatedAt'>) =>
    recordHistory(input)
  )
  ipcMain.handle(IPC.libraryRemoveHistory, (_e, key: string) => removeHistoryGroup(key))
  ipcMain.handle(IPC.libraryClearHistory, () => clearHistory())

  ipcMain.handle(IPC.playerDetect, () => detectPlayers())
  ipcMain.handle(IPC.playerOpen, (_e, url: string, title: string) => openInPlayer(url, title))

  ipcMain.handle(IPC.parseList, () => listParses())
  ipcMain.handle(
    IPC.parseResolve,
    (_e, url: string, options: ResolveOptions) => resolvePlayUrl(url, options)
  )
  ipcMain.handle(IPC.parseTest, (_e, url: string, target?: string) => testParse(url, target))
  ipcMain.handle(
    IPC.parseAdd,
    (_e, input: { name?: string; type?: number; url: string; flags?: string[] }) => addParse(input)
  )
  ipcMain.handle(IPC.parseRemove, (_e, url: string) => removeParse(url))
  ipcMain.handle(IPC.parseResetStats, () => resetParseStats())

  ipcMain.handle(IPC.homeSections, (_e, force?: boolean) => listHomeSections(force === true))

  ipcMain.handle(IPC.aiSummary, (_e, input: AiSummaryInput) => summarizeEpisode(input))
  ipcMain.handle(IPC.aiSummaryVisual, (_e, input: AiSummaryInput, frames: AiFrame[]) =>
    summarizeEpisodeVisual(input, frames)
  )
}

void app.whenReady().then(async () => {
  app.setAppUserModelId('com.tvbox.desktop')

  // 必须在建窗口之前跑完：系统代理指向一个没在监听的端口时（代理软件退出了、
  // Windows 的代理开关还留着），Chromium 的每个请求都会 ERR_PROXY_CONNECTION_FAILED，
  // 海报和视频全黑，而主进程的 Node fetch 不读系统代理所以看起来一切正常。
  await ensureReachableProxy()

  // 房间号频道（huya:// / douyin://）换出来的 m3u8 带防盗链，
  // 而 hls.js 没法自己设 Referer（forbidden header，会被静默忽略），只能在会话层补。
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['*://*/*'] },
    (details, callback) => {
      const extra = headersFor(details.url)
      if (extra) Object.assign(details.requestHeaders, extra)
      callback({ requestHeaders: details.requestHeaders })
    }
  )

  registerIpc()
  await hydrate()
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void flushStore()
})
