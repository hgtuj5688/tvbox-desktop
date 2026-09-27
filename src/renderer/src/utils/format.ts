/** 相对时间：刚刚 / 5 分钟前 / 3 小时前 / 2 天前 / 具体日期 */
export function relativeTime(ts: number): string {
  if (!ts) return '从未同步'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 秒数转时钟：95 → 1:35，1387 → 23:07，4000 → 1:06:40 */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const mm = String(m % 60).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

/** 观看进度百分比；时长未知（直播、或者还没读出时长）时返回 null，界面上就不画进度 */
export function watchPercent(item: { position: number; duration: number }): number | null {
  if (!item.duration || item.duration <= 0) return null
  return Math.min(100, Math.max(0, Math.round((item.position / item.duration) * 100)))
}

/** 截断长文本，保留头尾，中间用省略号 */
export function ellipsis(text: string, head = 42, tail = 18): string {
  if (!text) return ''
  if (text.length <= head + tail + 3) return text
  return `${text.slice(0, head)}…${text.slice(-tail)}`
}
