import iconv from 'iconv-lite'

/**
 * 统一网络层：所有对外请求都从这里走。
 * 放在主进程的好处：不受 CORS 限制、可自定义 UA/Referer、可处理 GBK 等非 UTF-8 编码。
 */

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export interface RequestOptions {
  /** 站点级 / 全局规则合并后的请求头 */
  header?: Record<string, string>
  timeout?: number
  method?: string
  body?: string | URLSearchParams
  /** 强制指定编码，不传则自动嗅探 */
  encoding?: string
  /** 允许非 2xx 也当成功（部分站点返回 500 但带数据） */
  allowHttpError?: boolean
}

export interface RawResponse {
  ok: boolean
  status: number
  finalUrl: string
  headers: Record<string, string>
  buffer: Buffer
}

function detectEncoding(buffer: Buffer, contentType: string, forced?: string): string {
  if (forced) return forced
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]
  if (fromHeader) return fromHeader.toLowerCase()
  // 嗅探前 4KB 里的 <meta charset>
  const head = buffer.subarray(0, 4096).toString('latin1')
  const meta =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
    /<\?xml[^>]+encoding=["']([\w-]+)["']/i.exec(head)?.[1]
  return meta ? meta.toLowerCase() : 'utf-8'
}

export async function request(url: string, options: RequestOptions = {}): Promise<RawResponse> {
  const timeoutMs = (options.timeout ?? 20) * 1000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = {
      'User-Agent': DEFAULT_UA,
      Accept: '*/*',
      ...(options.header ?? {})
    }
    const res = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body,
      redirect: 'follow',
      signal: controller.signal
    })
    const buffer = Buffer.from(await res.arrayBuffer())
    const flatHeaders: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      flatHeaders[k] = v
    })
    if (!res.ok && !options.allowHttpError) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`)
    }
    return { ok: res.ok, status: res.status, finalUrl: res.url || url, headers: flatHeaders, buffer }
  } catch (err) {
    const e = err as Error
    if (e.name === 'AbortError') throw new Error(`请求超时（${timeoutMs / 1000}s）`)
    throw new Error(e.message || '网络请求失败')
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchText(url: string, options: RequestOptions = {}): Promise<string> {
  const res = await request(url, options)
  return decodeResponse(res, options.encoding)
}

/** 已经拿到 RawResponse 时的解码版本：按响应头 / 内容嗅探编码再转成文本 */
export function decodeResponse(res: RawResponse, forced?: string): string {
  const contentType = res.headers['content-type'] ?? ''
  const encoding = detectEncoding(res.buffer, contentType, forced)
  if (encoding === 'utf-8' || encoding === 'utf8') return res.buffer.toString('utf-8')
  if (!iconv.encodingExists(encoding)) return res.buffer.toString('utf-8')
  return iconv.decode(res.buffer, encoding)
}

/** 带 JSON.parse 容错的文本接口：部分站点返回 BOM 或非标准 JSON */
export async function fetchJson<T = unknown>(url: string, options: RequestOptions = {}): Promise<T> {
  const text = await fetchText(url, options)
  return parseLooseJson<T>(text)
}

export function parseLooseJson<T = unknown>(text: string): T {
  const cleaned = text.replace(/^\uFEFF/, '').trim()
  try {
    return JSON.parse(cleaned) as T
  } catch {
    // 兜底：截取第一个 { 到最后一个 }
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as T
    throw new Error('返回内容不是合法 JSON')
  }
}

/** 按 host 通配规则匹配请求头，支持 *.example.com */
export function matchHeaderRules(
  url: string,
  rules: Array<{ host: string; header: Record<string, string> }>
): Record<string, string> {
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    return {}
  }
  const merged: Record<string, string> = {}
  for (const rule of rules) {
    const pattern = rule.host?.trim()
    if (!pattern) continue
    const re = new RegExp(
      '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      'i'
    )
    if (re.test(host)) Object.assign(merged, rule.header ?? {})
  }
  return merged
}
