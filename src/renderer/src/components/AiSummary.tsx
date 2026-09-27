import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { AiFrame, AiSummaryInput, AiSummaryResult } from '@shared/types'
import { Icon } from '@/components/icons'
import { formatClock } from '@/utils/format'
import { captureFrames, planFrames, type FrameProgress } from '@/utils/frames'

interface Props {
  /** 这一集的资料，变化时由外面用 key 重建组件，所以这里不用自己清状态 */
  input: AiSummaryInput
  /** 设置页里填过 API Key 没有 */
  hasKey: boolean
  /** 取当前播放器的 <video>。抽帧要用，拿不到就退化成只看资料 */
  getVideo: () => HTMLVideoElement | null
}

/** 抽帧间隔。写死 20 秒：一集 45 分钟约 135 帧，再密就超接口单次张数上限了 */
const INTERVAL = 20
const MAX_FRAMES = 120
/** 一次请求最多带多少帧（主进程那边也有一个上限，这里先挡一道） */
const SEND_FRAMES = MAX_FRAMES

type Phase = 'idle' | 'capture' | 'summarize'

/**
 * 播放页视频地址下面的 AI 剧情总结。
 *
 * 两条路，都**点了才请求**（自动调会白花钱，用户也可能不想看）：
 * 1. 「看一遍再总结」：用 canvas 从正在播的 <video> 上按 20 秒抽一帧，
 *    把几十张画面连同剧集资料交给 deepseek-flash。它有多模态能力，
 *    所以写的是画面里实际发生的事，而不是拿剧名去猜。
 * 2. 「只看资料」：不抽帧，让模型依据自己的剧集知识和站点简介写。便宜、快，
 *    但对新剧或冷门剧基本是瞎猜。
 *
 * API Key 不出主进程（services/ai.ts），这里只负责抽帧和交互。
 */
export function AiSummary({ input, hasKey, getVideo }: Props): JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<FrameProgress | null>(null)
  const [frames, setFrames] = useState<AiFrame[]>([])
  const [mode, setMode] = useState<'visual' | 'text'>('visual')
  const [result, setResult] = useState<AiSummaryResult | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const cancelRef = useRef({ current: false })

  const busy = phase !== 'idle'

  const idle = (): void => {
    setPhase('idle')
    setProgress(null)
    cancelRef.current = { current: false }
  }

  const reset = (): void => {
    idle()
    setResult(null)
    setError('')
    setCopied(false)
    setFrames([])
  }

  /** 只看资料：不抽帧，直接问 */
  const runText = async (): Promise<void> => {
    setMode('text')
    setResult(null)
    setError('')
    setCopied(false)
    setPhase('summarize')
    try {
      setResult(await window.api.ai.summarize(input))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      idle()
    }
  }

  /** 看一遍：先抽帧，再把画面交给模型 */
  const runVisual = async (): Promise<void> => {
    const video = getVideo()
    if (!video) {
      setError('播放器还没准备好。等画面出来再点，或者先点「只看资料」跳过着片。')
      return
    }
    setMode('visual')
    setResult(null)
    setError('')
    setCopied(false)
    setFrames([])
    cancelRef.current = { current: false }
    setPhase('capture')

    let shots: AiFrame[] = []
    try {
      shots = await captureFrames(video, {
        interval: INTERVAL,
        maxFrames: MAX_FRAMES,
        width: 512,
        quality: 0.7,
        onProgress: setProgress,
        cancel: cancelRef.current
      })
    } catch (err) {
      setError((err as Error).message)
      idle()
      return
    }
    if (cancelRef.current.current || !shots.length) {
      idle()
      return
    }

    setFrames(shots)
    setPhase('summarize')
    try {
      setResult(await window.api.ai.summarizeVisual(input, shots.slice(0, SEND_FRAMES)))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      idle()
    }
  }

  const video0 = getVideo()
  const duration = video0 && Number.isFinite(video0.duration) ? video0.duration : 0
  const estimate = planFrames(duration, { interval: INTERVAL, maxFrames: MAX_FRAMES }).length

  const percent =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <div className="ai-block">
      <div className="ai-head">
        <div className="ai-head-text">
          <div className="ai-title">
            <Icon name="sparkle" size={14} /> AI 剧情总结
          </div>
          <div className="ai-sub text-3 fs-12">
            {input.epName} · 让 DeepSeek 看一遍这一集，点了才开始
          </div>
        </div>

        {result ? (
          <div className="hstack">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                void navigator.clipboard.writeText(result.text).then(
                  () => setCopied(true),
                  () => setCopied(false)
                )
              }}
            >
              <Icon name="link" size={12} /> {copied ? '已复制' : '复制'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void runVisual()}
            >
              {busy ? <span className="spin" /> : <Icon name="refresh" size={12} />} 重新看一遍
            </button>
            <button type="button" className="btn btn-sm" onClick={reset}>
              <Icon name="close" size={12} /> 收起
            </button>
          </div>
        ) : (
          <div className="hstack">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || !hasKey}
              onClick={() => void runText()}
              title="不抽画面，只把剧集资料发给模型。快、便宜，但没有看片准"
            >
              只看资料
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || !hasKey}
              onClick={() => void runVisual()}
            >
              {busy ? <span className="spin" /> : <Icon name="sparkle" size={13} />}
              {phase === 'capture' ? '正在抽帧…' : phase === 'summarize' ? '正在看片…' : '看一遍再总结'}
            </button>
          </div>
        )}
      </div>

      {!hasKey ? (
        <div className="ai-body ai-hint">
          还没有配置 DeepSeek API Key，
          <Link to="/settings">去「设置 → AI 总结」</Link> 填一下就能用了。
        </div>
      ) : null}

      {!result && !busy && hasKey ? (
        <div className="ai-body ai-hint">
          点「看一遍再总结」会先把这一集快速过一遍，每 {INTERVAL} 秒抓一张画面
          {estimate ? `（约 ${estimate} 张）` : ''} 再交给 deepseek-flash。
          <br />
          抓画面会把整集缓冲一遍，通常要 1 分钟左右；画面没有声音，所以带硬字幕的片读得准，
          不带字幕的只能看出画面在演什么。
        </div>
      ) : null}

      {phase === 'capture' && progress ? (
        <div className="ai-body">
          <div className="ai-hint">
            <span className="spin" /> 正在抽帧 {progress.done} / {progress.total} ·{' '}
            {formatClock(progress.at)} · {percent}%
          </div>
          <div className="ai-bar">
            <div className="ai-bar-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="ai-foot text-3 fs-12">
            抽帧是把整集拉一遍，不要在进度中间关页面
            <button
              type="button"
              className="btn btn-sm"
              style={{ marginLeft: 8 }}
              onClick={() => {
                cancelRef.current.current = true
              }}
            >
              停止
            </button>
          </div>
        </div>
      ) : null}

      {phase === 'summarize' && !result ? (
        <div className="ai-body ai-hint">
          <span className="spin" />{' '}
          {mode === 'visual'
            ? `正在让 DeepSeek 看这 ${frames.length || estimate} 张画面并写剧情…`
            : '正在让 DeepSeek 写这一集的剧情，通常几秒就好…'}
        </div>
      ) : null}

      {error ? (
        <div className="ai-body">
          <div className="banner banner-danger">{error}</div>
        </div>
      ) : null}

      {result ? (
        <>
          <div className="ai-body ai-text">{result.text}</div>
          <div className="ai-foot text-3 fs-12">
            {result.model} · 耗时 {(result.ms / 1000).toFixed(1)}s
            {result.usage ? ` · ${result.usage.total} tokens` : ''}
            {mode === 'visual' && frames.length ? ` · 看了 ${frames.length} 张画面` : ' · 只看资料'}·
            <span className="ai-warn"> AI 生成，可能不准，仅供参考</span>
          </div>
        </>
      ) : null}
    </div>
  )
}
