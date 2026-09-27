import Artplayer from 'artplayer'
import Hls from 'hls.js'
import { isHls } from '@/utils/media'

/**
 * Artplayer 的构造被播放页（点播）和直播页共用，所以抽到这里。
 * 最容易踩的坑写在下面 createArt 里。
 */

/** 给 hls.js 的分片请求带上 Referer：不少 CDN 会校验来源 */
function makeM3u8Loader(referer?: string) {
  return function playM3u8(video: HTMLVideoElement, url: string, art: Artplayer): void {
    const host = art as Artplayer & { hls?: Hls }
    if (host.hls) {
      host.hls.destroy()
      host.hls = undefined
    }
    if (Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 30,
        manifestLoadingTimeOut: 15000,
        // 默认 abrEwmaDefaultEstimate 是 500kbps：多档直播会先从最低档起播，
        // 糊着放好几秒才慢慢往上爬。实测公开 IPTV 的 master 播放列表里
        // 多档的虽然只占少数，但档位差距能到 3 倍（691k–2231k），值得起播就给足。
        abrEwmaDefaultEstimate: 4_000_000,
        // 直播断流大多是短暂丢包，多给几次重试
        manifestLoadingMaxRetry: 3,
        levelLoadingMaxRetry: 4,
        fragLoadingMaxRetry: 4,
        xhrSetup: referer
          ? (xhr): void => {
              try {
                xhr.setRequestHeader('Referer', referer)
              } catch {
                /* 某些环境不允许设置，忽略 */
              }
            }
          : undefined
      })
      hls.loadSource(url)
      hls.attachMedia(video)
      host.hls = hls

      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        if (data.levels.length < 2) return
        // 挑分辨率最高的那一档（height 优先，其次码率），而不是简单地取最后一档
        let best = 0
        let bestScore = (data.levels[0].height ?? 0) * 1e6 + (data.levels[0].bitrate ?? 0)
        for (let i = 1; i < data.levels.length; i++) {
          const score = (data.levels[i].height ?? 0) * 1e6 + (data.levels[i].bitrate ?? 0)
          if (score > bestScore) {
            best = i
            bestScore = score
          }
        }
        // 用 nextLevel 而不是 currentLevel：currentLevel 会把 ABR 钉死在这一档，
        // nextLevel 只影响下一片，网速跟不上时 ABR 还能自己降回来。
        if (best > 0) hls.nextLevel = best
      })

      let recovered = 0
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return
        // 直播流断线是常态，先自己救两次，救不回来才告诉用户
        if (recovered < 2) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            recovered++
            hls.startLoad()
            return
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            recovered++
            hls.recoverMediaError()
            return
          }
        }
        art.notice.show = `播放出错：${data.details}`
      })
      art.on('destroy', () => hls.destroy())
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url
    } else {
      art.notice.show = '当前环境不支持 HLS 播放'
    }
  }
}

export interface ArtOptions {
  url: string
  referer?: string
  accent?: string
  poster?: string
  /** 直播源通常没有时长/倍速的意义 */
  live?: boolean
}

export function createArt(el: HTMLDivElement, opts: ArtOptions): Artplayer {
  const hls = isHls(opts.url)
  return new Artplayer({
    container: el,
    url: opts.url,
    // type / customType / poster 都只在有值时才传。
    // Artplayer 的 option 校验器（artplayer.mjs 的 scheme 表）要求这几项必须是字符串，
    // 显式传 undefined 会直接抛 `'option.type' require 'string' type, but got 'undefined'`
    // 或 `'option.poster' ...`，而 React 没有错误边界时会把整棵组件树卸载 —— 整页白屏。
    ...(opts.poster ? { poster: opts.poster } : {}),
    ...(hls ? { type: 'm3u8' as const, customType: { m3u8: makeM3u8Loader(opts.referer) } } : {}),
    autoplay: true,
    volume: 0.8,
    pip: true,
    fullscreen: true,
    fullscreenWeb: true,
    setting: true,
    hotkey: true,
    playbackRate: !opts.live,
    aspectRatio: true,
    miniProgressBar: true,
    airplay: true,
    theme: opts.accent ?? '#2563EB',
    lang: 'zh-CN',
    moreVideoAttr: opts.referer ? { crossOrigin: 'anonymous' } : {}
  })
}
