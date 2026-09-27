import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { EmptyState } from '@/components/EmptyState'
import { Poster } from '@/components/Poster'
import { Icon } from '@/components/icons'
import { detailKey, findSourceGroup, libraryKey, toFavoriteInput, useApp } from '@/store/useApp'
import { pickPlayableLine } from '@/utils/media'

/** 从列表页/收藏/历史里先凑出来的一份「已知信息」，用来把详情页的头几秒填满 */
interface PreviewInfo {
  name: string
  pic?: string
  remarks?: string
  score?: string
}

export function Detail(): JSX.Element {
  const { siteKey = '', vodId = '' } = useParams()
  const navigate = useNavigate()
  const sites = useApp((s) => s.sites)
  const details = useApp((s) => s.details)
  const loadDetail = useApp((s) => s.loadDetail)
  const searchResults = useApp((s) => s.search.results)
  const browseResults = useApp((s) => s.browse.results)
  const filterCommentary = useApp((s) => s.settings?.filterCommentary ?? true)
  const favorites = useApp((s) => s.favorites)
  const history = useApp((s) => s.history)
  const toggleFavorite = useApp((s) => s.toggleFavorite)

  /**
   * 从搜索页点进来时数据在 search.results，从分类浏览点进来时在 browse.results。
   * 两个都要看，否则分类浏览进来的详情页既拿不到片源列表、也没有可用的已知信息。
   */
  const crossResults = useMemo(() => {
    const hasSite = (rs: typeof searchResults): boolean => rs.some((r) => r.siteKey === siteKey)
    if (hasSite(searchResults)) return searchResults
    if (hasSite(browseResults)) return browseResults
    return searchResults
  }, [searchResults, browseResults, siteKey])

  const [favoriteBusy, setFavoriteBusy] = useState(false)

  const key = detailKey(siteKey, vodId)
  const detail = details[key]
  const site = sites.find((s) => s.key === siteKey)
  const favorited = favorites.some((f) => libraryKey(f.siteKey, f.vodId) === libraryKey(siteKey, vodId))

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lineIndex, setLineIndex] = useState(0)
  const [descOpen, setDescOpen] = useState(false)
  const [reversed, setReversed] = useState(false)

  /**
   * 点进来的那张卡上其实已经有片名、海报、备注了 —— 先拿它把详情页画出来。
   *
   * 详情要等一到三秒（一个站点一次请求），以前这段时间只有一个转圈，
   * 页面看上去像卡住了。搜索/分类的结果、收藏、观看历史都留着这些字段，
   * 按优先级找一遍；都没有（比如直接刷新详情页）才回退到骨架屏。
   */
  const preview = useMemo<PreviewInfo | null>(() => {
    for (const r of crossResults) {
      if (r.siteKey !== siteKey) continue
      const hit = r.list.find((v) => v.vod_id === vodId)
      if (hit) {
        return {
          name: hit.vod_name,
          pic: hit.vod_pic,
          remarks: hit.vod_remarks,
          score: hit.vod_score
        }
      }
    }
    const fav = favorites.find((f) => f.siteKey === siteKey && f.vodId === vodId)
    if (fav) return { name: fav.name, pic: fav.pic, remarks: fav.remarks, score: fav.score }
    for (const g of history) {
      const h = g.items.find((i) => i.siteKey === siteKey && i.vodId === vodId)
      if (h) return { name: h.name, pic: h.pic }
    }
    return null
  }, [crossResults, favorites, history, siteKey, vodId])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    setLineIndex(0)
    setDescOpen(false)
    loadDetail(siteKey, vodId)
      .then((d) => {
        if (!alive) return
        // 默认选中第一条「地址看起来能直接播」的线路，避免落到分享页上黑屏
        setLineIndex(pickPlayableLine(d.lines))
        setLoading(false)
      })
      .catch((err: Error) => {
        if (alive) {
          setError(err.message)
          setLoading(false)
        }
      })
    return () => {
      alive = false
    }
  }, [siteKey, vodId, loadDetail])

  const line = detail?.lines[lineIndex]
  const episodes = useMemo(
    () => (line ? (reversed ? [...line.episodes].reverse() : line.episodes) : []),
    [line, reversed]
  )

  /**
   * 同一部影片的全部片源。搜索结果里归一化片名相同的就是同一部，
   * 当前这条永远排在第一个（即使它没出现在搜索结果里）。
   */
  const sources = useMemo(() => {
    if (!detail) return []
    const siteNames = new Map(sites.map((s) => [s.key, s.name]))
    return findSourceGroup(
      crossResults,
      { siteKey, vodId, vodName: detail.vod_name },
      siteNames,
      filterCommentary
    )
  }, [crossResults, detail, siteKey, vodId, sites, filterCommentary])

  if (loading && !detail) {
    return (
      <div className="page">
        <div className="detail-head">
          <button type="button" className="btn btn-sm" onClick={() => navigate(-1)}>
            <Icon name="chevron-left" size={14} /> 返回
          </button>
          <span className="text-3 fs-12">
            {site?.name ?? siteKey}
            {site?.sourceName ? ` · ${site.sourceName}` : ''}
          </span>
        </div>

        <div className="detail-hero">
          <Poster src={preview?.pic} name={preview?.name ?? ''} className="poster-detail" />
          <div className="detail-info">
            <h1 className="detail-title">
              {preview?.name ?? <span className="skeleton sk-title" />}
            </h1>
            <div className="detail-meta">
              {preview?.score && Number(preview.score) > 0 ? (
                <span className="detail-score">{Number(preview.score).toFixed(1)}</span>
              ) : null}
              {preview?.remarks ? <span className="tag tag-outline">{preview.remarks}</span> : null}
            </div>
            <div className="detail-pending">
              <span className="spin" /> 正在获取线路与剧集…
            </div>
          </div>
        </div>

        <div className="section">
          <div className="section-head">
            <div className="section-title">选集</div>
            <span className="text-3 fs-12">正在获取剧集列表…</span>
          </div>
          <div className="episode-grid">
            {Array.from({ length: 24 }, (_, i) => (
              <span key={i} className="skeleton sk-ep" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (error && !detail) {
    return (
      <div className="page">
        <div className="page-head">
          <div>
            <div className="page-title">影片详情</div>
            <div className="page-sub">{site?.name ?? siteKey}</div>
          </div>
        </div>
        <EmptyState
          icon={<Icon name="alert" size={26} />}
          title="获取详情失败"
          desc={error}
          actions={
            <>
              <button type="button" className="btn" onClick={() => navigate(-1)}>
                返回
              </button>
              <Link className="btn" to="/sites">
                检查影视源
              </Link>
            </>
          }
        />
      </div>
    )
  }

  if (!detail) return <div className="page" />

  const meta = [
    detail.vod_year,
    detail.vod_area,
    detail.type_name,
    detail.vod_remarks
  ].filter(Boolean)

  return (
    <div className="page">
      <div className="detail-head">
        <button type="button" className="btn btn-sm" onClick={() => navigate(-1)}>
          <Icon name="chevron-left" size={14} /> 返回
        </button>
        <span className="text-3 fs-12">
          {detail.siteName}
          {site?.sourceName ? ` · ${site.sourceName}` : ''}
        </span>
      </div>

      <div className="detail-hero">
        <Poster src={detail.vod_pic} name={detail.vod_name} className="poster-detail" />
        <div className="detail-info">
          <h1 className="detail-title">{detail.vod_name}</h1>
          <div className="detail-meta">
            {detail.vod_score && Number(detail.vod_score) > 0 ? (
              <span className="detail-score">{Number(detail.vod_score).toFixed(1)}</span>
            ) : null}
            {meta.map((m) => (
              <span key={m} className="tag tag-outline">
                {m}
              </span>
            ))}
          </div>

          {detail.vod_director || detail.vod_actor ? (
            <div className="detail-crew">
              {detail.vod_director ? (
                <div>
                  <span className="text-3">导演</span> {detail.vod_director}
                </div>
              ) : null}
              {detail.vod_actor ? (
                <div>
                  <span className="text-3">主演</span> {detail.vod_actor}
                </div>
              ) : null}
            </div>
          ) : null}

          {detail.vod_content ? (
            <div className={`detail-desc ${descOpen ? 'open' : ''}`}>
              {detail.vod_content}
              <button type="button" className="detail-desc-toggle" onClick={() => setDescOpen((v) => !v)}>
                {descOpen ? '收起' : '展开'}
              </button>
            </div>
          ) : null}

          {detail.lines.length ? (
            <div className="detail-actions">
              <Link
                className="btn btn-primary"
                to={`/play/${encodeURIComponent(siteKey)}/${encodeURIComponent(vodId)}/${lineIndex}/0`}
              >
                <Icon name="play" size={15} /> 立即播放
              </Link>
              <button
                type="button"
                className={`btn${favorited ? ' btn-ghost' : ''}`}
                disabled={favoriteBusy}
                onClick={() => {
                  setFavoriteBusy(true)
                  void toggleFavorite(toFavoriteInput(detail)).finally(() => setFavoriteBusy(false))
                }}
              >
                <Icon name="star" size={15} />
                {favorited ? '已收藏' : '收藏'}
              </button>
              <span className="text-3 fs-12">
                共 {detail.lines.length} 条线路，{detail.lines.reduce((n, l) => n + l.episodes.length, 0)} 个剧集
              </span>
            </div>
          ) : (
            <div className="banner banner-warn" style={{ marginTop: 8 }}>
              这个站点没有返回可播放的剧集地址，换一个来源试试。
            </div>
          )}

          {sources.length > 1 ? (
            <div className="detail-alts">
              <span className="text-3 fs-12">还有 {sources.length - 1} 个片源</span>
              <Link className="detail-alts-jump" to="#source-picker" onClick={(e) => {
                e.preventDefault()
                document.getElementById('source-picker')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }}>
                在下面选一个片源
              </Link>
            </div>
          ) : null}
        </div>
      </div>

      {sources.length > 1 ? (
        <div className="section" id="source-picker">
          <div className="section-head">
            <div className="section-title">选择片源</div>
            <span className="text-3 fs-12">
              同一部影片在 {sources.length} 个站点上都有，点一下换源，选集进度会重新加载
            </span>
          </div>
          <div className="source-list">
            {sources.map((v) => {
              const active = v.siteKey === siteKey && v.vod_id === vodId
              const body = (
                <>
                  <span className={`source-icon ${active ? 'on' : ''}`}>
                    <Icon name={active ? 'check' : 'play'} size={14} />
                  </span>
                  <div className="source-main">
                    <div className="source-name">
                      {v.siteName}
                      {active ? <span className="tag tag-accent">正在看</span> : null}
                    </div>
                    <div className="source-sub">
                      {v.vod_remarks || (active ? '当前来源' : '点一下切到这个来源')}
                      {v.vod_name && v.vod_name !== detail.vod_name ? (
                        <span className="source-alias">该源片名：{v.vod_name}</span>
                      ) : null}
                    </div>
                  </div>
                  {active ? null : (
                    <span className="source-go">
                      切换 <Icon name="chevron-right" size={13} />
                    </span>
                  )}
                </>
              )
              return active ? (
                <div key={`${v.siteKey}::${v.vod_id}`} className="source-item active">
                  {body}
                </div>
              ) : (
                <Link
                  key={`${v.siteKey}::${v.vod_id}`}
                  className="source-item"
                  to={`/detail/${encodeURIComponent(v.siteKey)}/${encodeURIComponent(v.vod_id)}`}
                >
                  {body}
                </Link>
              )
            })}
          </div>
        </div>
      ) : null}

      {detail.lines.length ? (
        <div className="section">
          <div className="section-head">
            <div className="section-title">选集</div>
            <button type="button" className="btn btn-sm" onClick={() => setReversed((v) => !v)}>
              <Icon name="filter" size={13} /> {reversed ? '正序' : '倒序'}
            </button>
          </div>

          {detail.lines.length > 1 ? (
            <div className="chips">
              {detail.lines.map((l, i) => (
                <button
                  key={`${l.name}-${i}`}
                  type="button"
                  className={`chip ${i === lineIndex ? 'active' : ''}`}
                  onClick={() => setLineIndex(i)}
                >
                  {l.name}
                  <span className="chip-count">{l.episodes.length}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="episode-grid">
            {episodes.map((ep) => (
              <Link
                key={`${ep.index}-${ep.url}`}
                className="episode"
                to={`/play/${encodeURIComponent(siteKey)}/${encodeURIComponent(vodId)}/${lineIndex}/${ep.index}`}
                title={ep.name}
              >
                {ep.name}
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
