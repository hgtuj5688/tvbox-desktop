import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { FavoriteItem, HistoryGroup, HistoryItem } from '@shared/types'
import { EmptyState } from '@/components/EmptyState'
import { Poster } from '@/components/Poster'
import { Icon } from '@/components/icons'
import { libraryKey, useApp } from '@/store/useApp'
import { formatClock, relativeTime, watchPercent } from '@/utils/format'

type Tab = 'favorites' | 'history'

export function Library(): JSX.Element {
  const favorites = useApp((s) => s.favorites)
  const history = useApp((s) => s.history)
  const loadLibrary = useApp((s) => s.loadLibrary)
  const clearFavorites = useApp((s) => s.clearFavorites)
  const clearHistory = useApp((s) => s.clearHistory)
  const removeFavorite = useApp((s) => s.removeFavorite)
  const removeHistory = useApp((s) => s.removeHistory)
  const [tab, setTab] = useState<Tab>('favorites')
  // 同一部剧在多个源上看过时，记住用户在每一组里手动选了哪个源
  const [pick, setPick] = useState<Record<string, string>>({})

  /** 这一组当前要展示哪一条：默认是最近看过的那条，用户点过就以点过的为准 */
  const shownOf = (group: HistoryGroup): HistoryItem => {
    const want = pick[group.key]
    if (want) {
      const hit = group.items.find((i) => libraryKey(i.siteKey, i.vodId) === want)
      if (hit) return hit
    }
    return group.items[0]
  }

  useEffect(() => {
    void loadLibrary()
  }, [loadLibrary])

  // 没有收藏但有历史时，默认落到历史那一栏，否则用户会看到一个空页面
  useEffect(() => {
    if (!favorites.length && history.length) setTab('history')
  }, [favorites.length, history.length])

  const body = useMemo(() => {
    if (tab === 'favorites') {
      if (!favorites.length) {
        return (
          <EmptyState
            icon={<Icon name="star" size={26} />}
            title="还没有收藏"
            desc="在详情页点「收藏」，影片就会出现在这里，方便下次直接找到。"
          />
        )
      }
      return (
        <div className="poster-grid">
          {favorites.map((item: FavoriteItem) => (
            <div className="vod-card" key={libraryKey(item.siteKey, item.vodId)}>
              <Link to={`/detail/${encodeURIComponent(item.siteKey)}/${encodeURIComponent(item.vodId)}`}>
                <Poster src={item.pic} name={item.name} />
              </Link>
              <div className="vod-card-body">
                <Link
                  className="vod-card-title truncate"
                  to={`/detail/${encodeURIComponent(item.siteKey)}/${encodeURIComponent(item.vodId)}`}
                  title={item.name}
                >
                  {item.name}
                </Link>
                <div className="vod-card-meta">
                  {item.remarks ? <span className="truncate">{item.remarks}</span> : null}
                  {item.score ? <span className="vod-card-score">{item.score}</span> : null}
                </div>
                <div className="vod-card-tags">
                  <span className="tag tag-outline truncate">{item.siteName}</span>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    title="取消收藏"
                    onClick={() => void removeFavorite(libraryKey(item.siteKey, item.vodId))}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )
    }

    if (!history.length) {
      return (
        <EmptyState
          icon={<Icon name="clock" size={26} />}
          title="还没有观看记录"
          desc="开始播放之后，这里会记下看到第几集、看到哪儿了，方便接着看。"
        />
      )
    }
    return (
      <div className="library-history">
        {history.map((group) => {
          const item = shownOf(group)
          const pct = watchPercent(item)
          const altKey = libraryKey(item.siteKey, item.vodId)
          const playTo = `/play/${encodeURIComponent(item.siteKey)}/${encodeURIComponent(item.vodId)}/${item.lineIndex}/${item.epIndex}`
          return (
            <div className="history-row" key={group.key}>
              <Link className="history-poster" to={playTo}>
                <Poster src={item.pic ?? group.pic} name={group.name} />
              </Link>
              <div className="history-main">
                <div className="history-title">
                  <Link to={`/detail/${encodeURIComponent(item.siteKey)}/${encodeURIComponent(item.vodId)}`}>
                    {group.name}
                  </Link>
                </div>
                <div className="history-sub">
                  {item.epName ? <span>看到 {item.epName}</span> : <span>第 {item.epIndex + 1} 集</span>}
                  <span className="text-3">·</span>
                  <span className="text-3">{item.siteName}</span>
                  <span className="text-3">·</span>
                  <span className="text-3">{relativeTime(item.updatedAt)}</span>
                </div>
                {pct !== null ? (
                  <div className="history-progress" title={`已看 ${pct}%`}>
                    <span className="history-progress-track">
                      <span className="history-progress-fill" style={{ width: `${pct}%` }} />
                    </span>
                    <span className="history-progress-text">
                      看到 {formatClock(item.position)} / {formatClock(item.duration)}
                    </span>
                  </div>
                ) : null}
                {group.items.length > 1 ? (
                  <div className="history-sources">
                    <span className="text-3 fs-12">{group.items.length} 个源</span>
                    {group.items.map((alt) => {
                      const key = libraryKey(alt.siteKey, alt.vodId)
                      return (
                        <button
                          type="button"
                          key={key}
                          className={`chip${key === altKey ? ' active' : ''}`}
                          title={`${alt.siteName} · 看到 ${alt.epName || `第 ${alt.epIndex + 1} 集`} · ${relativeTime(alt.updatedAt)}`}
                          onClick={() => setPick((p) => ({ ...p, [group.key]: key }))}
                        >
                          {alt.siteName}
                        </button>
                      )
                    })}
                  </div>
                ) : null}
              </div>
              <div className="history-actions">
                <Link className="btn btn-sm btn-primary" to={playTo}>
                  <Icon name="play" size={13} />
                  继续观看
                </Link>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  title={group.items.length > 1 ? '删除这部片在所有源上的记录' : '从历史里删除'}
                  onClick={() => {
                    if (
                      group.items.length > 1 &&
                      !window.confirm(`删除「${group.name}」在 ${group.items.length} 个源上的观看记录？`)
                    ) {
                      return
                    }
                    void removeHistory(group.key)
                  }}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    )
  }, [tab, favorites, history, removeFavorite, removeHistory, pick, shownOf])

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">收藏与历史</div>
          <div className="page-sub">
            收藏 {favorites.length} 部 · 观看记录 {history.length} 条
          </div>
        </div>
        <div className="page-actions">
          <div className="chips">
            <button
              type="button"
              className={`chip${tab === 'favorites' ? ' active' : ''}`}
              onClick={() => setTab('favorites')}
            >
              收藏
              <span className="chip-count">{favorites.length}</span>
            </button>
            <button
              type="button"
              className={`chip${tab === 'history' ? ' active' : ''}`}
              onClick={() => setTab('history')}
            >
              观看历史
              <span className="chip-count">{history.length}</span>
            </button>
          </div>
          {tab === 'favorites' && favorites.length ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                if (window.confirm('清空全部收藏？')) void clearFavorites()
              }}
            >
              <Icon name="trash" size={13} />
              清空收藏
            </button>
          ) : null}
          {tab === 'history' && history.length ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                if (window.confirm('清空全部观看记录？')) void clearHistory()
              }}
            >
              <Icon name="trash" size={13} />
              清空记录
            </button>
          ) : null}
        </div>
      </div>

      {body}
    </div>
  )
}
