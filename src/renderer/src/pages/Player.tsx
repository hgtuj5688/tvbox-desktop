import Artplayer from 'artplayer'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { EmptyState } from '@/components/EmptyState'
import { AiSummary } from '@/components/AiSummary'
import { Poster } from '@/components/Poster'
import { Icon } from '@/components/icons'
import { detailKey, findSourceGroup, useApp } from '@/store/useApp'
import { createArt } from '@/utils/artplayer'
import { isDirectMedia, isHls, pickPlayableLine } from '@/utils/media'

export function Player(): JSX.Element {
  const params = useParams()
  const siteKey = params.siteKey ?? ''
  const vodId = params.vodId ?? ''
  const lineIndex = Number(params.lineIndex ?? 0) || 0
  const epIndex = Number(params.epIndex ?? 0) || 0

  const navigate = useNavigate()
  const sites = useApp((s) => s.sites)
  const details = useApp((s) => s.details)
  const loadDetail = useApp((s) => s.loadDetail)
  const settings = useApp((s) => s.settings)
  const notify = useApp((s) => s.notify)
  const searchResults = useApp((s) => s.search.results)
  const runSearch = useApp((s) => s.runSearch)
  const recordHistory = useApp((s) => s.recordHistory)
  const filterCommentary = settings?.filterCommentary ?? true

  const containerRef = useRef<HTMLDivElement>(null)
  const artRef = useRef<Artplayer | null>(null)

  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [hint, setHint] = useState('')
  const [finding, setFinding] = useState(false)
  /** 正在向解析接口换地址 */
  const [resolving, setResolving] = useState(false)
  /** 这一次是靠哪条路换出的地址，或者为什么没换出来 */
  const [resolveNote, setResolveNote] = useState('')

  const detail = details[detailKey(siteKey, vodId)]
  const site = sites.find((s) => s.key === siteKey)
  const line = detail?.lines[lineIndex]
  const episode = line?.episodes[epIndex]

  const referer = useMemo(() => {
    const api = site?.api ?? ''
    if (!/^https?:\/\//i.test(api)) return undefined
    try {
      return `${new URL(api).origin}/`
    } catch {
      return undefined
    }
  }, [site?.api])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    loadDetail(siteKey, vodId)
      .then(() => {
        if (alive) setLoading(false)
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

  // 换集时重建播放器实例：Artplayer 的 url 不支持热切换 hls 流。
  //
  // 很多采集站的线路给的不是直链，而是一个分享页地址（素博的 subyun 线路就是
  // https://play.xluuss.com/play/nelOoxJd 这种）。这种地址直接丢给 Artplayer 只会报错，
  // 所以先让主进程解析一遍：它通常自己读一遍那个页面就能拿到 m3u8，读不出来才问解析接口。
  useEffect(() => {
    const el = containerRef.current
    if (!el || !episode) return
    el.innerHTML = ''
    setHint('')
    setError('')
    setResolving(false)
    setResolveNote('')

    let alive = true
    let art: Artplayer | null = null
    let lastSaved = 0
    const raw = episode.url

    // 观看记录：进播放页就先记一条（position 0），之后由 timeupdate 定时刷新进度。
    // 用 5 秒节流，否则 timeupdate 每 250ms 触发一次会把 store 和磁盘写爆。
    const save = (force = false): void => {
      if (!art) return
      const now = Date.now()
      if (!force && now - lastSaved < 5000) return
      lastSaved = now
      void recordHistory({
        siteKey,
        siteName: site?.name ?? siteKey,
        vodId,
        name: detail?.vod_name ?? siteKey,
        pic: detail?.vod_pic,
        lineIndex,
        epIndex,
        epName: episode.name,
        position: Math.floor(art.currentTime || 0),
        duration: Number.isFinite(art.duration) ? Math.floor(art.duration) : 0
      })
    }

    const mount = (url: string): void => {
      art = createArt(el, { url, referer, accent: settings?.accent })
      artRef.current = art
      art.on('video:error', () => {
        setError('视频加载失败，可能是地址已失效、需要 Referer，或者需要解析接口。')
      })
      save(true)
      art.on('video:timeupdate', () => save())
      art.on('video:pause', () => save(true))
      art.on('video:ended', () => save(true))
    }

    const boot = async (): Promise<void> => {
      if (isDirectMedia(raw)) {
        mount(raw)
        return
      }
      setResolving(true)
      try {
        const r = await window.api.parse.resolve(raw)
        if (!alive) return
        if (r.ok) {
          setResolveNote(
            r.direct
              ? '这个地址本来就是直链'
              : `「${r.parseName ?? '解析接口'}」换出了播放地址 · ${r.ms}ms`
          )
          mount(r.url)
        } else {
          setResolveNote(r.error ?? '没能换出播放地址')
          setError(`这条线路给的不是直链，也没能解析出播放地址：${r.error ?? ''}`)
        }
      } catch (err) {
        if (alive) setError((err as Error).message)
      } finally {
        if (alive) setResolving(false)
      }
    }
    void boot()

    return () => {
      alive = false
      artRef.current = null
      art?.destroy(false)
    }
    // 依赖只留 url / referer / accent：把 detail 的字段放进依赖会让详情加载完成后
    // 重建播放器实例，正在播的流会被打断。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episode?.url, referer, settings?.accent])

  const openExternal = useCallback(async (): Promise<void> => {
    if (!episode) return
    try {
      const result = await window.api.player.open(
        episode.url,
        `${detail?.vod_name ?? ''} ${episode.name}`.trim()
      )
      notify(`已交给外部播放器：${result.player.split(/[\\/]/).pop()}`, 'success')
    } catch (err) {
      notify((err as Error).message, 'danger')
    }
  }, [episode, detail?.vod_name, notify])

  /** 把地址丢给系统默认浏览器 / 下载器 */
  const openInBrowser = useCallback(async (): Promise<void> => {
    if (!episode) return
    try {
      await window.api.openExternal(episode.url)
      notify('已用系统默认浏览器打开这个地址', 'success')
    } catch (err) {
      notify((err as Error).message, 'danger')
    }
  }, [episode, notify])

  /**
   * 同一部影片的全部片源，用来在播放页直接换源。
   * 当前这条永远排第一个（即使它没出现在搜索结果里）。
   */
  const sources = useMemo(() => {
    if (!detail) return []
    const siteNames = new Map(sites.map((s) => [s.key, s.name]))
    return findSourceGroup(
      searchResults,
      { siteKey, vodId, vodName: detail.vod_name },
      siteNames,
      filterCommentary
    )
  }, [searchResults, detail, siteKey, vodId, sites, filterCommentary])

  /** 直接打开播放页（没走过搜索）时，按片名现搜一次来找其它片源 */
  const findSources = useCallback(async (): Promise<void> => {
    if (!detail?.vod_name) return
    setFinding(true)
    try {
      await runSearch(detail.vod_name)
    } finally {
      setFinding(false)
    }
  }, [detail?.vod_name, runSearch])

  // 从别的片源切过来时链接只带 /0/0，而第 0 条线路常常是网页分享页。
  // 只在「第 0 线路 + 第 0 集 + 当前地址不是直链」时自动纠一次，
  // 用户自己选的线路不会被改掉。
  const autoFixed = useRef('')
  useEffect(() => {
    if (!detail || lineIndex !== 0 || epIndex !== 0) return
    const key = detailKey(siteKey, vodId)
    if (autoFixed.current === key) return
    if (isDirectMedia(detail.lines[0]?.episodes[0]?.url ?? '')) return
    const better = pickPlayableLine(detail.lines)
    if (better === 0) return
    autoFixed.current = key
    navigate(`/play/${encodeURIComponent(siteKey)}/${encodeURIComponent(vodId)}/${better}/0`, {
      replace: true
    })
  }, [detail, lineIndex, epIndex, siteKey, vodId, navigate])

  // 当前线路放不了、但另一条线路看起来是直链时，给一个一键切换的入口。
  // 这个 useMemo 必须在下面任何提前 return 之前，否则会打乱 hooks 顺序。
  const direct = isDirectMedia(episode?.url ?? '')
  const betterLine = useMemo(() => {
    if (direct || !detail) return -1
    const i = pickPlayableLine(detail.lines)
    return i !== lineIndex && isDirectMedia(detail.lines[i]?.episodes[0]?.url ?? '') ? i : -1
  }, [direct, detail, lineIndex])

  if (loading && !detail) {
    return (
      <div className="page">
        <div className="detail-loading">
          <span className="spin" />
          正在准备播放…
        </div>
      </div>
    )
  }

  if (error && !detail) {
    return (
      <div className="page">
        <EmptyState
          icon={<Icon name="alert" size={26} />}
          title="无法播放"
          desc={error}
          actions={
            <button type="button" className="btn" onClick={() => navigate(-1)}>
              返回
            </button>
          }
        />
      </div>
    )
  }

  if (!detail || !episode) {
    return (
      <div className="page">
        <EmptyState
          icon={<Icon name="screen-off" size={26} />}
          title="找不到这一集"
          desc="线路或剧集可能已经变更，回到详情页重新选择。"
          actions={
            <Link
              className="btn btn-primary"
              to={`/detail/${encodeURIComponent(siteKey)}/${encodeURIComponent(vodId)}`}
            >
              回到详情页
            </Link>
          }
        />
      </div>
    )
  }

  const episodes = line?.episodes ?? []
  const prev = epIndex > 0 ? epIndex - 1 : -1
  const next = epIndex < episodes.length - 1 ? epIndex + 1 : -1
  const goTo = (index: number): void => {
    navigate(
      `/play/${encodeURIComponent(siteKey)}/${encodeURIComponent(vodId)}/${lineIndex}/${index}`
    )
  }

  return (
    <div className="page page-player">
      <div className="detail-head">
        <button type="button" className="btn btn-sm" onClick={() => navigate(-1)}>
          <Icon name="chevron-left" size={14} /> 返回
        </button>
        <span className="detail-title-inline" title={detail.vod_name}>
          {detail.vod_name}
        </span>
        <span className="text-3 fs-12">
          {line?.name} · {episode.name}
        </span>
      </div>

      <div className="player-layout">
        <div className="player-main">
          <div className="player-stage">
            <div ref={containerRef} className="player-stage-inner" />
            {resolving ? (
              <div className="player-stage-note">
                <span className="spin" />
                这条线路给的不是直链，正在换播放地址…
              </div>
            ) : null}
          </div>

          {!resolving && resolveNote ? (
            <div className="player-note">
              <Icon name="info" size={13} />
              {resolveNote}
            </div>
          ) : null}

          <div className="player-bar">
            <button
              type="button"
              className="btn btn-sm"
              disabled={prev < 0}
              onClick={() => goTo(prev)}
            >
              <Icon name="chevron-left" size={13} /> 上一集
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={next < 0}
              onClick={() => goTo(next)}
            >
              下一集 <Icon name="chevron-right" size={13} />
            </button>
            <span className="grow" />
            <button type="button" className="btn btn-sm" onClick={() => void openExternal()}>
              <Icon name="external" size={13} /> 外部播放器
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                void navigator.clipboard.writeText(episode.url).then(
                  () => setHint('地址已复制到剪贴板'),
                  () => setHint('复制失败，可以手动选中下面的地址')
                )
              }}
            >
              <Icon name="link" size={13} /> 复制地址
            </button>
          </div>

          {error ? <div className="banner banner-danger">{error}</div> : null}

          {!direct && betterLine >= 0 ? (
            <div className="banner banner-info">
              这条线路放不出来时，可以试试
              <Link
                to={`/play/${encodeURIComponent(siteKey)}/${encodeURIComponent(vodId)}/${betterLine}/0`}
              >
                「{detail.lines[betterLine].name}」
              </Link>
            </div>
          ) : null}

          {hint ? <div className="banner banner-info">{hint}</div> : null}

          <button
            type="button"
            className="player-url mono"
            title={`点击用系统默认浏览器打开：\n${episode.url}`}
            onClick={() => void openInBrowser()}
          >
            <span className="player-url-text">{episode.url}</span>
            <span className="player-url-go">
              <Icon name="external" size={12} />
              浏览器打开
            </span>
          </button>

          {/* key 带上集号：换集时直接重建组件，总结结果不会串到下一集 */}
          <AiSummary
            key={`${siteKey}/${vodId}/${lineIndex}/${epIndex}`}
            hasKey={(settings?.ai?.apiKey ?? '').trim().length > 0}
            getVideo={() => artRef.current?.video ?? null}
            input={{
              vodName: detail.vod_name,
              typeName: detail.type_name,
              year: detail.vod_year,
              area: detail.vod_area,
              actor: detail.vod_actor,
              director: detail.vod_director,
              score: detail.vod_score,
              remarks: detail.vod_remarks,
              content: detail.vod_content,
              epName: episode.name,
              epIndex,
              epTotal: episodes.length,
              lineName: line?.name
            }}
          />
        </div>

        <aside className="player-side">
          <div className="player-side-head">
            <Poster src={detail.vod_pic} name={detail.vod_name} className="poster-side" />
            <div>
              <div className="player-side-title">{detail.vod_name}</div>
              <div className="text-3 fs-12">{line?.name}</div>
              <div className="text-3 fs-12">
                第 {epIndex + 1} / {episodes.length} 集
              </div>
            </div>
          </div>

          <div className="player-sources">
            <div className="player-side-label">
              <span>片源</span>
              {sources.length > 1 ? (
                <span className="text-3 fs-12">{sources.length} 个</span>
              ) : null}
            </div>
            {sources.length > 1 ? (
              <div className="source-chips">
                {sources.map((v) => {
                  const active = v.siteKey === siteKey && v.vod_id === vodId
                  const title = v.vod_name && v.vod_name !== detail.vod_name
                    ? `${v.siteName}（该源片名：${v.vod_name}）`
                    : v.siteName
                  return active ? (
                    <span
                      key={`${v.siteKey}/${v.vod_id}`}
                      className="chip chip-source active"
                      title={`${title} · 正在看`}
                    >
                      <Icon name="check" size={12} />
                      {v.siteName}
                    </span>
                  ) : (
                    <Link
                      key={`${v.siteKey}/${v.vod_id}`}
                      className="chip chip-source"
                      title={`${title} · 点一下换到这个源`}
                      to={`/play/${encodeURIComponent(v.siteKey)}/${encodeURIComponent(v.vod_id)}/0/0`}
                    >
                      {v.siteName}
                    </Link>
                  )
                })}
              </div>
            ) : (
              <div className="player-sources-empty">
                <span className="text-3 fs-12">只找到这一个片源</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={finding}
                  onClick={() => void findSources()}
                >
                  {finding ? <span className="spin" /> : <Icon name="search" size={13} />} 找其它片源
                </button>
              </div>
            )}
          </div>

          <div className="player-episodes">
            {episodes.map((ep) => (
              <button
                key={`${ep.index}-${ep.url}`}
                type="button"
                className={`episode episode-sm ${ep.index === epIndex ? 'active' : ''}`}
                onClick={() => goTo(ep.index)}
                title={ep.name}
              >
                {ep.name}
              </button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  )
}
