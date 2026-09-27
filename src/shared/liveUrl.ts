/**
 * 直播源里「房间号频道」的写法。
 *
 * 虎牙和抖音的真正播放地址都带防盗链参数、几小时就过期，没法写进直播源里，
 * 所以源里只写房间号（`huya://10188`、`douyin://59288147052`），播放前再去换真地址。
 * 主进程（streamResolve.ts）和渲染进程（Live 页的加载态）都要认这个写法，所以放在 shared。
 */
export const ROOM_URL_RE = /^(huya|douyin):\/\/(\d+)$/i

export function isRoomUrl(url: string): boolean {
  return ROOM_URL_RE.test((url ?? '').trim())
}

/** 房间号频道属于哪个平台，用来在界面上说人话 */
export function roomPlatform(url: string): string | null {
  const m = (url ?? '').trim().match(ROOM_URL_RE)
  if (!m) return null
  return m[1].toLowerCase() === 'huya' ? '虎牙' : '抖音'
}
