import { Link } from 'react-router-dom'
import type { Vod } from '@shared/types'
import { Poster } from '@/components/Poster'

/**
 * 一张影片卡。搜索结果和首页内容位共用。
 *
 * 首页内容位给的是各站自己的原始列表（没有做跨站同名合并），所以这里
 * `alternatives` / `allSiteKeys` 都是可选的——没有就不显示「N 个源」那个标签。
 */
export function VodCard({
  vod
}: {
  vod: Vod & { alternatives?: Vod[]; allSiteKeys?: string[] }
}): JSX.Element {
  const target = { pathname: `/detail/${encodeURIComponent(vod.siteKey)}/${encodeURIComponent(vod.vod_id)}` }
  const altCount = vod.allSiteKeys?.length ?? 1
  return (
    <Link className="vod-card" to={target}>
      <Poster src={vod.vod_pic} name={vod.vod_name} />
      <div className="vod-card-body">
        <div className="vod-card-title" title={vod.vod_name}>
          {vod.vod_name}
        </div>
        <div className="vod-card-meta">
          {vod.vod_remarks ? <span className="vod-card-remarks">{vod.vod_remarks}</span> : null}
          {vod.vod_score && Number(vod.vod_score) > 0 ? (
            <span className="vod-card-score">{vod.vod_score}</span>
          ) : null}
        </div>
      </div>
      <div className="vod-card-footer">
        <span className="tag tag-outline" title={(vod.alternatives ?? []).map((a) => a.siteName).join('、') || vod.siteName}>
          {vod.siteName}
        </span>
        {altCount > 1 ? (
          <span className="tag tag-accent" title={`可切换片源：${(vod.alternatives ?? []).map((a) => a.siteName).join('、')}`}>
            {altCount} 个源
          </span>
        ) : null}
      </div>
    </Link>
  )
}
