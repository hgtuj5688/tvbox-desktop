import type { AiFrame } from '@shared/types'

/**
 * 从一个正在播的 <video> 上按时间点抽帧，交给 deepseek-flash「看一遍」。
 *
 * 为什么能这么干：ArtPlayer 用 hls.js 播 m3u8，<video>.src 是 MSE 喂的 blob:，
 * 属于同源，所以 drawImage 到 canvas 之后 toDataURL() 不会抛跨域异常。
 * （普通 <video src="http://别的域/x.m3u8"> 直接播会污染 canvas，这里不会。）
 *
 * 代价：为了跳到每个时间点，整个视频会被下载一遍，所以要给用户看进度。
 */

export interface FrameProgress {
  done: number
  total: number
  /** 当前正在抽的时间点（秒） */
  at: number
}

export interface CaptureOptions {
  /** 隔多少秒抽一帧，默认 20 */
  interval?: number
  /** 最多抽多少帧，默认 120 */
  maxFrames?: number
  /** 缩到多宽，默认 512（deepseek 的 detail:'low' 本来也会缩到 512） */
  width?: number
  /** jpeg 质量，默认 0.7 */
  quality?: number
  /** 单次 seek 的超时，默认 15 秒 */
  seekTimeout?: number
  onProgress?: (p: FrameProgress) => void
  /** 传一个对象进来，cancel.current = true 就能中断 */
  cancel?: { current: boolean }
}

/** 估算会抽多少帧，用来在开始前告诉用户「大概要抽 N 帧」 */
export function planFrames(duration: number, opts: Pick<CaptureOptions, 'interval' | 'maxFrames'> = {}): number[] {
  const interval = opts.interval ?? 20
  const maxFrames = opts.maxFrames ?? 120
  if (!Number.isFinite(duration) || duration <= 1) return []
  // 从 2 秒开始，末尾留 1 秒，避开纯黑的开头与结尾
  const span = duration - 3
  if (span <= 0) return [Math.min(2, duration)]
  let step = interval
  if (span / step > maxFrames) step = span / maxFrames
  const out: number[] = []
  for (let t = 2; t < duration - 1 && out.length < maxFrames; t += step) out.push(t)
  return out
}

function seekTo(video: HTMLVideoElement, t: number, timeout: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // 已经停在这里了，seeked 永远不会再触发，直接放行
    if (Math.abs(video.currentTime - t) < 0.06 && video.readyState >= 2) {
      resolve()
      return
    }
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error(`跳到 ${Math.round(t)} 秒超时`))
    }, timeout)
    const onSeeked = (): void => {
      cleanup()
      resolve()
    }
    const cleanup = (): void => {
      window.clearTimeout(timer)
      video.removeEventListener('seeked', onSeeked)
    }
    video.addEventListener('seeked', onSeeked)
    try {
      video.currentTime = t
    } catch (err) {
      cleanup()
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/** 等这一帧真的画出来再抓，否则 canvas 上还是上一帧 */
function waitFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise<void>((resolve) => {
    const rvfc = (
      video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number
      }
    ).requestVideoFrameCallback
    if (typeof rvfc === 'function') {
      const timer = window.setTimeout(resolve, 1000)
      rvfc.call(video, () => {
        window.clearTimeout(timer)
        resolve()
      })
      return
    }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

let sharedCanvas: HTMLCanvasElement | null = null

function grabFrame(video: HTMLVideoElement, width: number, quality: number): string {
  if (!video.videoWidth || !video.videoHeight) throw new Error('还没拿到画面尺寸')
  if (!sharedCanvas) sharedCanvas = document.createElement('canvas')
  const canvas = sharedCanvas
  const outW = Math.max(64, Math.min(width, video.videoWidth))
  const outH = Math.max(1, Math.round((outW * video.videoHeight) / video.videoWidth))
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('拿不到 canvas 上下文')
  ctx.drawImage(video, 0, 0, outW, outH)
  const url = canvas.toDataURL('image/jpeg', quality)
  return url.slice(url.indexOf(',') + 1)
}

/**
 * 抽帧。抽完会把播放位置和播放/暂停状态还原。
 * 单个时间点失败就跳过它，不要因为一帧毁掉整次扫描。
 */
export async function captureFrames(
  video: HTMLVideoElement,
  opts: CaptureOptions = {}
): Promise<AiFrame[]> {
  const width = opts.width ?? 512
  const quality = opts.quality ?? 0.7
  const seekTimeout = opts.seekTimeout ?? 15_000
  const targets = planFrames(video.duration, opts)
  if (!targets.length) throw new Error('这个视频拿不到时长，没法扫。等它加载出来再试。')

  const wasTime = video.currentTime
  const wasPaused = video.paused
  video.pause()

  const frames: AiFrame[] = []
  let skipped = 0
  try {
    for (let i = 0; i < targets.length; i += 1) {
      if (opts.cancel?.current) break
      const t = targets[i]
      opts.onProgress?.({ done: i, total: targets.length, at: t })
      try {
        await seekTo(video, t, seekTimeout)
        await waitFrame(video)
        frames.push({ t, b64: grabFrame(video, width, quality) })
      } catch {
        skipped += 1
      }
    }
  } finally {
    try {
      video.currentTime = wasTime
    } catch {
      // 还原失败无所谓
    }
    if (!wasPaused) void video.play().catch(() => undefined)
  }

  opts.onProgress?.({ done: targets.length, total: targets.length, at: wasTime })
  if (!frames.length) {
    throw new Error(`一个画面都没抓到${skipped ? `（${skipped} 个时间点都失败了）` : ''}，可能这个源不让跳转。`)
  }
  return frames
}
