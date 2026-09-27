import type { Line } from '@shared/types'

/** 看起来像视频直链的地址；不是直链的大概率得走解析接口（M4）或外部播放器 */
export function isDirectMedia(url: string): boolean {
  return /\.(m3u8|mp4|flv|mkv|ts|avi|mov|webm|m4v|rmvb|wmv|mp3|m4a)(\?|#|$)/i.test(url)
}

export function isHls(url: string): boolean {
  return /\.m3u8(\?|#|$)/i.test(url) || /\/hls\//i.test(url)
}

/**
 * 挑一条默认线路：优先第一条「地址看起来能直接播」的线路。
 *
 * 实测发现采集站常把网页分享地址放在第 1 条线路，真正的 m3u8 在第 2 条
 * （例如量子资源的 liangzi 给的是 /share/xxx 分享页，lzm3u8 才是 index.m3u8）。
 * 直接播第 0 条会黑屏，所以这里先扫一遍。全都不是直链时退回第 0 条，
 * 交给外部播放器或后续的解析接口。
 */
export function pickPlayableLine(lines: Line[]): number {
  if (!lines.length) return 0
  const index = lines.findIndex((l) => l.episodes.length > 0 && isDirectMedia(l.episodes[0].url))
  return index >= 0 ? index : 0
}
