import type { FavoriteItem, HistoryGroup, HistoryItem, LibrarySnapshot } from '@shared/types'
import { readStore, writeStore } from './store'

/**
 * 收藏与观看历史。
 *
 * 都按 `${siteKey}::${vodId}` 作为主键 —— 同一部片在不同站点算不同的条目，
 * 因为换源之后剧集地址完全不同，进度没法通用。
 *
 * 历史只保留最近 MAX_HISTORY 条，避免看久了文件无限膨胀。
 */

const FAVORITES = 'favorites'
const HISTORY = 'history'
const MAX_HISTORY = 200

export const itemKey = (siteKey: string, vodId: string): string => `${siteKey}::${vodId}`

async function readFavorites(): Promise<FavoriteItem[]> {
  const list = await readStore<FavoriteItem[]>(FAVORITES, [])
  return Array.isArray(list) ? list : []
}

async function readHistory(): Promise<HistoryItem[]> {
  const list = await readStore<HistoryItem[]>(HISTORY, [])
  return Array.isArray(list) ? list : []
}

export async function listFavorites(): Promise<FavoriteItem[]> {
  const list = await readFavorites()
  return [...list].sort((a, b) => b.addedAt - a.addedAt)
}

/**
 * 片名的归一化键：全角转半角、统一小写、去掉空格与标点。
 * 用来判断「这几个站上的是不是同一部剧」。
 *
 * 刻意保守：只做上面这些，不去剥「第二季」「(国语)」这类后缀。
 * 宁可漏合（「庆余年」和「庆余年 第二季」算两条），也不要把不同季的进度串到一起。
 */
export function normalizeName(name: string): string {
  const key = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
  return key || name.trim().toLowerCase()
}

/**
 * 按归一化片名把「一个源一条」的记录合成「一部剧一条」。
 * 组内按最近看过排序，items[0] 就是主记录；组与组之间也按最近看过排。
 */
export async function listHistory(): Promise<HistoryGroup[]> {
  const list = await readHistory()
  const groups = new Map<string, HistoryGroup>()
  for (const item of list) {
    const key = normalizeName(item.name)
    const found = groups.get(key)
    if (found) found.items.push(item)
    else groups.set(key, { key, name: item.name, pic: item.pic, items: [item], updatedAt: item.updatedAt })
  }
  const out = [...groups.values()]
  for (const g of out) {
    g.items.sort((a, b) => b.updatedAt - a.updatedAt)
    g.name = g.items[0].name
    g.pic = g.items[0].pic ?? g.items.find((i) => i.pic)?.pic
    g.updatedAt = g.items[0].updatedAt
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getLibrary(): Promise<LibrarySnapshot> {
  const [favorites, history] = await Promise.all([listFavorites(), listHistory()])
  return { favorites, history }
}

/** 收藏 / 取消收藏，返回操作后的状态，界面据此改按钮 */
export async function toggleFavorite(
  input: Omit<FavoriteItem, 'addedAt'>
): Promise<{ favorited: boolean }> {
  const key = itemKey(input.siteKey, input.vodId)
  const list = await readFavorites()
  const idx = list.findIndex((f) => itemKey(f.siteKey, f.vodId) === key)
  if (idx >= 0) {
    list.splice(idx, 1)
    writeStore(FAVORITES, list)
    return { favorited: false }
  }
  list.push({ ...input, addedAt: Date.now() })
  writeStore(FAVORITES, list)
  return { favorited: true }
}

export async function removeFavorite(key: string): Promise<void> {
  const list = await readFavorites()
  writeStore(
    FAVORITES,
    list.filter((f) => itemKey(f.siteKey, f.vodId) !== key)
  )
}

export async function clearFavorites(): Promise<void> {
  writeStore(FAVORITES, [])
}

/**
 * 记一次播放。同一个条目重复播放只更新进度与时间，不新增行，
 * 否则拖一次进度条就会多出一条历史。
 *
 * 关键：**不允许用 0/0 覆盖已有的真实进度**。
 * 播放页挂载的瞬间就会先写一条（那时 video 的 duration 还是 NaN），
 * 所以「打开播放页 → 立刻退出」「在播放页上刷新/重开应用」都会送进来一条
 * position 0 / duration 0 的记录。如果无条件覆盖，进度条就会永远显示不出来。
 * 只有在同一集的进度确实是新的（拿到了有效时长）时才覆盖进度。
 */
export async function recordHistory(input: Omit<HistoryItem, 'updatedAt'>): Promise<void> {
  const key = itemKey(input.siteKey, input.vodId)
  const list = await readHistory()
  const idx = list.findIndex((h) => itemKey(h.siteKey, h.vodId) === key)
  const prev = idx >= 0 ? list[idx] : undefined

  let next: HistoryItem = { ...input, updatedAt: Date.now() }

  // 同一集时，只有这次真的拿到了时长才允许改写进度；否则沿用上一次记下的进度。
  if (prev && prev.lineIndex === input.lineIndex && prev.epIndex === input.epIndex) {
    const known = input.duration > 0
    next = {
      ...next,
      position: known ? input.position : prev.position,
      duration: known ? input.duration : prev.duration
    }
  }

  if (idx >= 0) list.splice(idx, 1)
  list.unshift(next)

  // 超出上限时砍掉最旧的
  const trimmed = list
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_HISTORY)
  writeStore(HISTORY, trimmed)
}

/** 删掉一整组 —— 同一部剧在**所有**源上的记录一起去掉。key 是 normalizeName 的结果 */
export async function removeHistoryGroup(key: string): Promise<void> {
  const list = await readHistory()
  writeStore(
    HISTORY,
    list.filter((h) => normalizeName(h.name) !== key)
  )
}

export async function clearHistory(): Promise<void> {
  writeStore(HISTORY, [])
}
