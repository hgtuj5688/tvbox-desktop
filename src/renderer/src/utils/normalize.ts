/**
 * 片名归一化与「解说类」内容识别。
 *
 * 归一化的目的只有一个：让不同站点上的同一部影片落到同一个 key 上。
 * 采集站对同一部剧的写法千奇百怪，实际见过的有：
 *   庆余年第二季 / 庆余年 第二季 / 庆余年（第二季） / 庆余年第二季[全36集]
 *   庆余年，全世界都以为我是废物太子（庆余年之大凉太子爷）
 * 这些应该合并；而下面这些必须保持区分，否则会把不同的作品合成一部：
 *   庆余年第一季 / 庆余年第二季 / 庆余年之帝王业 / 庆余年之风起沧州
 *
 * 所以规则是「只去掉不影响作品身份的噪声」，季数、部数、副标题一律保留。
 */

/** 全角转半角（只处理 ASCII 可见区，中文标点单独在标点表里） */
function toHalfWidth(text: string): string {
  return text.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
}

/**
 * 会被丢掉的标点与符号。
 * 注意不要放「第」「季」「部」「集」这些能区分作品的字。
 */
const PUNCTUATION = /[\s·・:：;；\-—_~～.,，。!！?？'"“”‘’`^&*+=<>《》()（）[\]【】{}｛｝/\\|@#$%]/g

/**
 * 同一部作品的常见后缀/前缀噪声，去掉后不影响身份判定。
 * 这些词在采集站上经常被随意加上，加了就是同一部剧。
 */
const NOISE_WORDS =
  /(高清版?|超清|蓝光|完整版?|全集|全\d+集|国语版?|粤语版?|普通话版?|中字|双语|hd|bd|4k|1080p|720p|2160p)/gi

/**
 * 尾部的别名括号。采集站常把别名直接塞在片名后面，实际见过的有：
 *   庆余年，全世界都以为我是废物太子（庆余年之大凉太子爷）
 * 括号里只是同一部剧的另一个叫法，应该并到主名上。
 *
 * 但括号里若是「第二季 / 第61-81集 / 特别篇」这种分季分集信息就绝不能丢，
 * 否则会把第一季和第二季合成一部。
 */
const ALIAS_TAIL = /[（(]([^（()）]*)[)）]\s*$/
const SEASON_MARK = /第\s*[0-9一二三四五六七八九十百千]+\s*[季部集篇辑]|番外|特别篇|前传|后传|续集/

/** 去掉不影响作品身份的尾部括号别名；整名都是括号时保持原样 */
function stripAliasTail(text: string): string {
  let out = text.trim()
  for (;;) {
    const m = out.match(ALIAS_TAIL)
    if (!m || SEASON_MARK.test(m[1])) return out
    const head = out.slice(0, m.index ?? 0).trim()
    if (!head) return out
    out = head
  }
}

/** 归一化片名。空名字返回空串，调用方靠空串跳过。 */
export function normalizeName(name: string): string {
  if (!name) return ''
  return toHalfWidth(stripAliasTail(name))
    .replace(NOISE_WORDS, '')
    .replace(PUNCTUATION, '')
    .toLowerCase()
}

/**
 * 解说 / 二创类内容。用户明确要求「去除掉每个源的电影解说」。
 *
 * 这些条目在采集站上通常是几分钟的解说短片，和正片同名同封面，
 * 混在搜索结果里非常干扰，而且点进去往往只有一集。
 *
 * 两条线索都用上：
 *   · 片名，例如「庆余年[电影解说]」「XX一口气看完」
 *   · 分类，例如 vod_class/vod_type_name = 「影视解说」「电影解说」
 * 只按片名判断会漏掉那些片名干净、靠分类标记的条目。
 */
const COMMENTARY_RE = /(解说|速看|盘点|混剪|拆解|影评|剧情介绍|一口气看完|分钟看完)/

/** 片名或分类看起来是不是解说/二创内容 */
export function isCommentary(name: string, typeName?: string): boolean {
  return COMMENTARY_RE.test(name ?? '') || COMMENTARY_RE.test(typeName ?? '')
}

/**
 * 把同名影片的候选按「信息量」排序，用来挑代表条目。
 * 有海报、有备注、有评分的排前面——这样合并后的卡片看起来最完整。
 */
export function scoreCandidate(vod: {
  vod_pic?: string
  vod_remarks?: string
  vod_score?: string | number
}): number {
  let score = 0
  if (vod.vod_pic) score += 4
  if (vod.vod_remarks) score += 2
  if (vod.vod_score && Number(vod.vod_score) > 0) score += 1
  return score
}
