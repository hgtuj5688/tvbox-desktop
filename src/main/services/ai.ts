import type { AiFrame, AiSummaryInput, AiSummaryResult } from '@shared/types'
import { getSettings } from './settings'

/**
 * 用 DeepSeek 给「当前这一集」写一段剧情总结。两条路：
 *
 * 1. summarizeEpisode()       只看文本资料。站点侧只给得到整部剧的资料
 *                             （片名 / 类型 / 演员 / 简介），没有分集字幕，
 *                             所以模型只能在自己已有的剧集知识上推。不靠谱。
 * 2. summarizeEpisodeVisual() 渲染进程从正在播的 <video> 上按 20 秒一帧抽出画面
 *                             （utils/frames.ts），这里把它们按时间顺序交给
 *                             deepseek-flash —— 它是多模态的，能真的「看」。
 *                             提示词里写死了这次没有声音，不许编对白。
 *
 * 想换成别的 OpenAI 兼容服务，改设置页里的 baseUrl 和 model 就行。
 * 注意视觉只有 deepseek-flash 支持，deepseek-v4-pro 会拒图。
 */

const OFFICIAL_BASE = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-flash'
/** 纯文本那条路很快 */
const TIMEOUT = 90_000
/** 视觉那条路要传几十张图，基线给宽一点，再按帧数往上加（上限见下面） */
const VISUAL_TIMEOUT = 120_000
const VISUAL_TIMEOUT_MAX = 300_000
/** 单次请求最多塞多少帧，防止一次性把 600 的接口上限撞穿 */
const MAX_FRAMES = 140

const SYSTEM_TEXT = [
  '你是一个中文影视剧剧情助手。用户会给你一部剧（或番剧、综艺、动漫）的资料，以及他当前正在看的集数。',
  '请针对「这一集」输出内容，不要复述整部剧的简介。',
  '',
  '输出格式（纯文本，不要用 Markdown 标题符号）：',
  '第一段：用 2 到 4 句话说清这一集讲了什么。',
  '然后另起一行写「本集看点」，下面用「- 」列 3 到 5 条。',
  '',
  '硬性要求：',
  '1. 如果资料不足以确定这一集的具体情节，就在第一段里如实说明「仅凭现有资料无法确定这一集的具体情节」，然后只写你能推断的内容，绝对不要编造具体的人物、台词或事件。',
  '2. 不要写「好的」「以下是」这类客套话。',
  '3. 不要重复用户给你的原始资料。',
  '4. 全文控制在 400 字以内，用简体中文。'
].join('\n')

const SYSTEM_VISUAL = [
  '你是一个中文影视剧剧情解说。用户会给你一部剧集的资料，以及**按时间顺序从这一集里抽出来的画面**——每张图前面标着它在片中的时间点。',
  '你要根据这些画面写出这一集实际发生了什么，而不是根据剧名去猜。',
  '',
  '输出格式（纯文本，不要用 Markdown 标题符号）：',
  '第一段：用 3 到 6 句话说清这一集的剧情走向，按时间顺序。',
  '然后另起一行写「剧情节点」，下面用「- [时间] 内容」的形式列 4 到 8 条关键节点。把相邻的画面合并成一条，不要一帧一条。',
  '然后另起一行写「本集看点」，下面用「- 」列 2 到 4 条。',
  '',
  '硬性要求：',
  '1. 这些画面是每 20 秒抽一帧得到的，而且**没有声音**。所以：画面上出现字幕或文字时可以照实引用；但**不要编造对白、人物姓名，或画面上根本看不到的情节**；只描述你确实从画面里看到的东西，拿不准的地方就明说看不出来。',
  '2. 如果画面几乎全是片头、黑屏、静态图或者内容高度重复，就在第一段里直接说明「这一集抽到的画面信息量很少」，不要硬编。',
  '3. 不要写「好的」「以下是」这类客套话，不要重复用户给你的资料。',
  '4. 全文控制在 600 字以内，用简体中文。'
].join('\n')

function nonEmpty(label: string, value?: string): string {
  const text = (value ?? '').trim()
  return text ? `${label}：${text}` : ''
}

function buildUser(input: AiSummaryInput): string {
  const meta = [
    nonEmpty('片名', input.vodName),
    nonEmpty('类型', input.typeName),
    nonEmpty('年份', input.year),
    nonEmpty('地区', input.area),
    nonEmpty('导演', input.director),
    nonEmpty('演员', input.actor),
    nonEmpty('评分', input.score),
    nonEmpty('备注', input.remarks)
  ].filter(Boolean)

  const total = input.epTotal > 0 ? input.epTotal : '?'
  const line = input.lineName ? `，线路「${input.lineName}」` : ''
  const episode = `当前正在看：${input.epName}（第 ${input.epIndex + 1} 集 / 共 ${total} 集${line}）`

  const intro = (input.content ?? '').trim()

  return [
    '【影片资料】',
    meta.join('\n'),
    '',
    episode,
    intro ? `\n【整部剧的简介】\n${intro.slice(0, 1200)}` : ''
  ]
    .filter((part) => part !== '')
    .join('\n')
}

/** 把秒数写成 mm:ss，给模型当时间锚点 */
function stamp(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }

function buildVisualUser(input: AiSummaryInput, frames: AiFrame[]): ContentBlock[] {
  const blocks: ContentBlock[] = [
    { type: 'text', text: buildUser(input) },
    {
      type: 'text',
      text: `\n【按时间顺序抽取的画面】共 ${frames.length} 帧，每帧前标着它在片中的时间点。`
    }
  ]
  for (const frame of frames) {
    blocks.push({ type: 'text', text: `[${stamp(frame.t)}]` })
    blocks.push({
      type: 'image_url',
      // detail:'low' 会先缩到 512×512 再推理，省钱也更快；这些图本来就只有 512 宽
      image_url: { url: `data:image/jpeg;base64,${frame.b64}`, detail: 'low' }
    })
  }
  return blocks
}

interface ApiChoice {
  message?: { content?: string }
}
interface ApiUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}
interface ApiResponse {
  choices?: ApiChoice[]
  usage?: ApiUsage
  error?: { message?: string; type?: string }
}

/** 把 HTTP 状态码翻译成人能看懂的话 */
function explainStatus(status: number, detail: string): string {
  if (status === 401) return 'DeepSeek 说这个 API Key 不对（401）。去「设置 → AI 总结」里检查一下。'
  if (status === 402) return 'DeepSeek 账户余额不足（402），去 platform.deepseek.com 充值后再试。'
  if (status === 404) return `模型名可能不对（404）。${detail}`
  if (status === 413) return '这次传的画面太多了，接口拒收（413）。把「抽帧间隔」调大一点再试。'
  if (status === 429) return '请求太频繁被限流了（429），等一会儿再试。'
  if (status >= 500) return `DeepSeek 服务端出错（HTTP ${status}），稍后再试。`
  return `DeepSeek 返回了 HTTP ${status}。${detail}`
}

interface Config {
  apiKey: string
  model: string
  base: string
  url: string
}

async function loadConfig(): Promise<Config> {
  const settings = await getSettings()
  const apiKey = (settings.ai?.apiKey ?? '').trim()
  if (!apiKey) {
    throw new Error('还没有配置 DeepSeek API Key。去「设置 → AI 总结」里填一下就能用了。')
  }
  const model = (settings.ai?.model ?? '').trim() || DEFAULT_MODEL
  const base = ((settings.ai?.baseUrl ?? '').trim() || OFFICIAL_BASE).replace(/\/+$/, '')
  return { apiKey, model, base, url: `${base}/chat/completions` }
}

interface CallOptions {
  system: string
  user: string | ContentBlock[]
  maxTokens: number
  timeout: number
}

async function callDeepSeek(cfg: Config, opts: CallOptions): Promise<AiSummaryResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeout)
  const startedAt = Date.now()

  let res: Response
  try {
    res = await fetch(cfg.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user }
        ],
        // 写摘要不需要思维链：关掉它，快很多也便宜很多
        thinking: { type: 'disabled' },
        max_tokens: opts.maxTokens,
        stream: false
      })
    })
  } catch (err) {
    const e = err as Error
    if (e.name === 'AbortError') {
      throw new Error(
        `等 DeepSeek 回复超过 ${Math.round(opts.timeout / 1000)} 秒，先不等了。可以再点一次重试。`
      )
    }
    throw new Error(`连不上 ${cfg.base}：${e.message}。检查网络，或者系统代理是不是开着但没跑起来。`)
  } finally {
    clearTimeout(timer)
  }

  const raw = await res.text()
  let json: ApiResponse = {}
  try {
    json = JSON.parse(raw) as ApiResponse
  } catch {
    // 保持 json 为空对象，下面按状态码报错
  }

  if (!res.ok) {
    const detail = (json.error?.message ?? raw.slice(0, 200)).trim()
    throw new Error(explainStatus(res.status, detail))
  }

  const text = json.choices?.[0]?.message?.content?.trim() ?? ''
  if (!text) {
    throw new Error('DeepSeek 这次没返回任何内容，再点一次试试。')
  }

  return {
    text,
    model: cfg.model,
    ms: Date.now() - startedAt,
    usage: json.usage
      ? {
          prompt: json.usage.prompt_tokens ?? 0,
          completion: json.usage.completion_tokens ?? 0,
          total: json.usage.total_tokens ?? 0
        }
      : undefined
  }
}

/** 只看站点资料，让模型依据自己的剧集知识写。看不清片的时候用这条。 */
export async function summarizeEpisode(input: AiSummaryInput): Promise<AiSummaryResult> {
  const cfg = await loadConfig()
  return callDeepSeek(cfg, {
    system: SYSTEM_TEXT,
    user: buildUser(input),
    maxTokens: 900,
    timeout: TIMEOUT
  })
}

/** 抽了画面，让模型真的看一遍。frames 为空时退回文本那条路。 */
export async function summarizeEpisodeVisual(
  input: AiSummaryInput,
  frames: AiFrame[]
): Promise<AiSummaryResult> {
  const usable = frames.filter((f) => typeof f?.b64 === 'string' && f.b64.length > 64).slice(0, MAX_FRAMES)
  if (!usable.length) return summarizeEpisode(input)

  const cfg = await loadConfig()
  return callDeepSeek(cfg, {
    system: SYSTEM_VISUAL,
    user: buildVisualUser(input, usable),
    maxTokens: 1600,
    // 帧多了以后上传 + 推理都慢，按帧数把超时放宽
    timeout: Math.min(VISUAL_TIMEOUT + usable.length * 1000, 300_000)
  })
}
