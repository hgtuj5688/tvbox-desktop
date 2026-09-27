import type { SiteType } from './types'

/** 站点类型的中文说明，主进程与界面共用，避免两处文案不一致 */
export const SITE_TYPE_LABEL: Record<SiteType, string> = {
  0: '需 Spider',
  1: '网页规则',
  2: '未知类型',
  3: '苹果CMS',
  4: 'CMS 变体'
}

/** 徽标配色，对应 global.css 里的 tag-* 类 */
export const SITE_TYPE_TAG: Record<SiteType, string> = {
  0: 'tag-warn',
  1: 'tag-accent',
  2: 'tag-danger',
  3: 'tag-success',
  4: 'tag-outline'
}
