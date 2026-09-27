import type { Cheerio, CheerioAPI } from 'cheerio'
import type { AnyNode, Element } from 'domhandler'

/**
 * 网页规则站的取值语法，刻意与 TVBox 的 html 规则保持一致：
 *
 *   ".title a&&href"       取 .title a 的 href
 *   ".title&&Text"         取文本
 *   ".pic&&data-src"       取 data-src 属性
 *   ".a&&href||.b&&Text"   前者取不到时用后者
 *
 * `&&` 后面用逗号分隔（如 "Text,href"）表示取不到文本就退到 href，
 * 因为网上流传的规则两种写法都有。
 */

export interface RulePart {
  selector: string
  /** 要尝试的属性，按顺序取第一个非空值；Text/Html 是伪属性 */
  args: string[]
}

type Selection = Cheerio<AnyNode>

/** 把一条规则串拆成若干候选分支 */
export function parseRule(rule: string | undefined): RulePart[] {
  if (!rule) return []
  return rule
    .split('||')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const segs = part
        .split('&&')
        .map((s) => s.trim())
        .filter(Boolean)
      const selector = segs[0] ?? ''
      const args: string[] = []
      for (const seg of segs.slice(1)) {
        for (const a of seg.split(',')) {
          const t = a.trim()
          if (t) args.push(t)
        }
      }
      return { selector, args }
    })
}

/** 只取选择器部分，用于「先选出元素再逐个取值」的场景（剧集列表） */
export function ruleSelector(rule: string | undefined): string {
  return parseRule(rule)[0]?.selector ?? ''
}

/** 把可能是相对路径的地址补全成绝对地址 */
export function absolutize(url: string, base: string): string {
  const value = (url ?? '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  if (/^data:/i.test(value)) return value
  if (value.startsWith('//')) return `https:${value}`
  try {
    return new URL(value, base).toString()
  } catch {
    return value
  }
}

function readArg($: CheerioAPI, el: Selection, arg: string, base: string): string {
  const key = arg.trim()
  const lower = key.toLowerCase()
  if (lower === 'text' || lower === 'textnodes') {
    return el.text().replace(/\s+/g, ' ').trim()
  }
  if (lower === 'html' || lower === 'innerhtml') {
    return el.html()?.trim() ?? ''
  }
  if (lower === 'outerhtml') {
    return $.html(el)?.trim() ?? ''
  }
  // 属性名大小写敏感的场景极少，两种都试一遍
  const raw = el.attr(key) ?? el.attr(lower) ?? ''
  const value = (raw ?? '').trim()
  if (!value) return ''
  if (lower === 'href' || lower === 'src' || lower.endsWith('src') || lower.endsWith('-url')) {
    return absolutize(value, base)
  }
  return value
}

/**
 * 从一个元素上按规则取值。
 * @param fallback 规则里没写属性时的默认候选（例如链接默认取 href）
 */
export function extract(
  $: CheerioAPI,
  el: Selection,
  rule: string | undefined,
  base: string,
  fallback: string[] = ['Text']
): string {
  const parts = parseRule(rule)
  const branches: RulePart[] = parts.length ? parts : [{ selector: '', args: fallback }]
  for (const part of branches) {
    const target: Selection = part.selector
      ? ($(el).find(part.selector).first() as Selection)
      : $(el)
    if (!target.length) continue
    const args = part.args.length ? part.args : fallback
    for (const arg of args) {
      const value = readArg($, target, arg, base)
      if (value) return value
    }
  }
  return ''
}

/** 按规则选出所有元素（剧集、线路容器等）；规则为空时返回空集合 */
export function selectAll($: CheerioAPI, scope: Selection, rule: string | undefined): Selection {
  const selector = ruleSelector(rule)
  if (!selector) return $('.__tvbox_none__') as Selection
  return scope.find(selector) as Selection
}
