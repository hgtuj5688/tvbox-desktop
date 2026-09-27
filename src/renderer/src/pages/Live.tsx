import type { LiveChannelEntry, LiveHealth } from '@shared/types'
import { isRoomUrl, roomPlatform } from '@shared/liveUrl'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { EmptyState } from '@/components/EmptyState'
import { Icon } from '@/components/icons'
import { useApp } from '@/store/useApp'
import { createArt } from '@/utils/artplayer'

type HealthMap = Record<string, LiveHealth>

/** 只有 http(s) 能提前体检；huya:// 这类房间号要现场换地址，算「还不知道」 */
function probeable(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** 一个频道整体的线路状态 */
interface ChannelHealth {
  ok: number
  dead: number
  unknown: number
}

function healthOf(urls: string[], table: HealthMap): ChannelHealth {
  let ok = 0
  let dead = 0
  let unknown = 0
  for (const u of urls) {
    if (!probeable(u)) {
      unknown++
      continue
    }
    const h = table[u]
    if (!h) unknown++
    else if (h.ok) ok++
    else dead++
  }
  return { ok, dead, unknown }
}

export function Live(): JSX.Element {
  const live = useApp((s) => s.live)
  const liveLoading = useApp((s) => s.liveLoading)
  const loadLive = useApp((s) => s.loadLive)
  const settings = useApp((s) => s.settings)
  const sources = useApp((s) => s.sources)
  const notify = useApp((s) => s.notify)

  const [group, setGroup] = useState<string>('')
  const [kw, setKw] = useState('')
  const [picked, setPicked] = useState<LiveChannelEntry | null>(null)
  const [lineIndex, setLineIndex] = useState(0)
  // 每点一次频道就加一，用来触发「把播放器拉回视野」那个 effect。
  // 不能拿 picked 当依赖：重复点同一个频道时 picked 的引用没变，effect 不会再跑。
  const [pickSeq, setPickSeq] = useState(0)

  // 线路体检表：url -> 结果。用来优先播活的线路、把死频道藏起来
  const [health, setHealth] = useState<HealthMap>({})
  const [showDead, setShowDead] = useState(false)
  const [probing, setProbing] = useState(false)
  const [picking, setPicking] = useState(false)
  /** 已经交给主进程探过的地址，避免每次切分组都重探一遍 */
  const warmedRef = useRef<Set<string>>(new Set())

  const stageWrapRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const artRef = useRef<ReturnType<typeof createArt> | null>(null)

  const liveSourceCount = sources.reduce((sum, s) => sum + s.liveCount, 0)

  useEffect(() => {
    void loadLive()
  }, [loadLive])

  const groups = live?.groups ?? []

  // 频道列表换了（重新拉取过）就把「探过」的记录清掉，并把上次的体检结果读回来
  useEffect(() => {
    warmedRef.current = new Set()
    void window.api.live
      .health()
      .then(setHealth)
      .catch(() => undefined)
  }, [live])

  // 分组默认落在第一个（频道最多的那个）
  useEffect(() => {
    if (!groups.length) return
    if (group && groups.some((g) => g.name === group)) return
    setGroup(groups[0].name)
  }, [groups, group])

  const channels = useMemo(() => {
    const word = kw.trim().toLowerCase()
    const all = groups.flatMap((g) => g.channels)
    if (word) return all.filter((c) => c.name.toLowerCase().includes(word))
    if (!group) return all
    return groups.find((g) => g.name === group)?.channels ?? []
  }, [groups, group, kw])

  /** 某条线路的体检结果，用来在切线路的 chip 上打点 */
  const urlHealth = useCallback(
    (target: string): LiveHealth | undefined => (probeable(target) ? health[target] : undefined),
    [health]
  )

  const probe = useCallback(
    async (urls: string[], options?: { force?: boolean }): Promise<HealthMap | null> => {
      if (!urls.length) return null
      try {
        const next = await window.api.live.probe(urls, options)
        setHealth(next)
        return next
      } catch (err) {
        notify(`线路体检失败：${(err as Error).message}`, 'danger')
        return null
      }
    },
    [notify]
  )

  /**
   * 后台预热：公开直播源里死链很多，与其等用户一条条点，不如一进分组就悄悄
   * 把它们试出来 —— 死频道自动沉下去，能播的线路在点开前就标好。
   * 只预热前 60 个频道，否则「地方频道」一个分组 247 个会探很久。
   */
  const warm = useCallback(
    async (list: LiveChannelEntry[]): Promise<void> => {
      const urls = [...new Set(list.flatMap((c) => c.urls.map((u) => u.url)))]
        .filter(probeable)
        .filter((u) => !warmedRef.current.has(u))
      if (!urls.length) return
      for (const u of urls) warmedRef.current.add(u)
      setProbing(true)
      try {
        // 主进程单次上限 60 条，这里再分小批，避免把同一条 CDN 打限速
        for (let i = 0; i < urls.length; i += 30) {
          const next = await probe(urls.slice(i, i + 30))
          if (!next) break
        }
      } finally {
        setProbing(false)
      }
    },
    [probe]
  )

  useEffect(() => {
    if (!channels.length) return
    const timer = setTimeout(() => void warm(channels.slice(0, 60)), 400)
    return () => clearTimeout(timer)
  }, [channels, warm])

  const rawUrl = picked?.urls[lineIndex]?.url ?? ''

  const [resolved, setResolved] = useState<{ url: string; referer: string; line?: string } | null>(null)
  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState('')
  const [retrySeq, setRetrySeq] = useState(0)

  // 房间号频道（huya:// / douyin://）没有现成地址，点开时才去平台换。
  // 换出来的地址带防盗链参数，只能当场用，所以不做任何缓存。
  useEffect(() => {
    if (!rawUrl) {
      setResolved(null)
      setResolveError('')
      setResolving(false)
      return
    }
    if (!isRoomUrl(rawUrl)) {
      setResolved({ url: rawUrl, referer: '' })
      setResolveError('')
      setResolving(false)
      return
    }
    let cancelled = false
    setResolving(true)
    setResolved(null)
    setResolveError('')
    void window.api.live
      .resolve(rawUrl)
      .then((r) => {
        if (!cancelled) setResolved(r)
      })
      .catch((err: Error) => {
        if (!cancelled) setResolveError(err.message)
      })
      .finally(() => {
        if (!cancelled) setResolving(false)
      })
    return () => {
      cancelled = true
    }
  }, [rawUrl, retrySeq])

  const url = resolved?.url ?? ''

  // 播放器事件处理里要读到「最新一次选择」，而播放器实例只在 url 变化时重建，
  // 用 ref 兜住，免得同一条地址被两条线路共用时拿到过期的 lineIndex。
  const latestRef = useRef({ picked, lineIndex })
  useEffect(() => {
    latestRef.current = { picked, lineIndex }
  }, [picked, lineIndex])

  // 换频道/换线路时重建播放器实例 —— Artplayer 的 url 不支持热切换 hls 流
  useEffect(() => {
    const el = stageRef.current
    if (!el || !url) return
    el.innerHTML = ''
    const art = createArt(el, {
      url,
      referer: resolved?.referer || undefined,
      accent: settings?.accent,
      live: true
    })
    artRef.current = art
    art.on('video:error', () => {
      const { picked: cur, lineIndex: idx } = latestRef.current
      const total = cur?.urls.length ?? 0
      // 这条拉不起来就自己换下一条 —— 这正是「很多都不能观看」的地方，
      // 不该让人一条条手动试
      if (cur && idx + 1 < total) {
        setLineIndex(idx + 1)
        notify(`这条线路拉不起来，已自动换到第 ${idx + 2} / ${total} 条`, 'warn')
        return
      }
      art.notice.show = '这个频道拉流失败，换一条线路试试'
    })
    return () => {
      artRef.current = null
      art.destroy(false)
    }
  }, [url, resolved?.referer, settings?.accent, notify])

  /** 点频道：先挑一条体检通过的线路，没有就当场探一遍 */
  const play = useCallback(
    async (channel: LiveChannelEntry): Promise<void> => {
      setPicked(channel)
      setPickSeq((n) => n + 1)

      const known = channel.urls.findIndex((u) => probeable(u.url) && health[u.url]?.ok)
      if (known >= 0) {
        setLineIndex(known)
        return
      }
      setLineIndex(0)

      const urls = channel.urls.map((u) => u.url).filter(probeable)
      if (!urls.length) return
      setPicking(true)
      try {
        const next = await probe(urls)
        const hit = next ? channel.urls.findIndex((u) => next[u.url]?.ok) : -1
        if (hit > 0) setLineIndex(hit)
        else if (next && hit < 0) {
          notify(`${channel.name}：${urls.length} 条线路都没拉起来，可以换一个频道试试`, 'warn')
        }
      } finally {
        setPicking(false)
      }
    },
    [health, notify, probe]
  )

  // 把播放器拉回视野。频道多的时候（「地方频道」一个分组就有 247 个），
  // 点列表靠下的频道时播放器早就滚出屏幕了，不拉回来就只看得到声音。
  // block:'nearest' 在播放器本来就在视野里时不做任何滚动，所以不用自己算可见性。
  useEffect(() => {
    if (!pickSeq) return
    stageWrapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [pickSeq])

  const openExternal = useCallback(async (): Promise<void> => {
    if (!picked || !url) return
    try {
      await window.api.player.open(url, picked.name)
    } catch (err) {
      notify(`打开外部播放器失败：${(err as Error).message}`, 'danger')
    }
  }, [picked, url, notify])

  const copyUrl = useCallback(async (): Promise<void> => {
    if (!url) return
    await navigator.clipboard.writeText(url)
    notify('播放地址已复制', 'success')
  }, [url, notify])

  const recheck = useCallback(async (): Promise<void> => {
    await window.api.live.clearHealth()
    warmedRef.current = new Set()
    setHealth({})
    const list = channels.slice(0, 60)
    notify(`正在重新体检 ${list.length} 个频道…`, 'info')
    await warm(list)
    notify('体检完成', 'success')
  }, [channels, warm, notify])

  /**
   * 判定不可用 = 所有能探的线路都探过且全挂、又没有房间号线路可试。
   * 还没探过的频道一律照常显示 —— 体检是后台慢慢做的，不能让界面闪来闪去。
   */
  const { visible, hidden } = useMemo(() => {
    const alive: LiveChannelEntry[] = []
    const dead: LiveChannelEntry[] = []
    for (const c of channels) {
      const h = healthOf(
        c.urls.map((u) => u.url),
        health
      )
      if (h.ok === 0 && h.unknown === 0) dead.push(c)
      else alive.push(c)
    }
    return { visible: alive, hidden: dead }
  }, [channels, health])

  const shown = showDead ? channels : visible

  if (!liveSourceCount && !live?.total) {
    return (
      <div className="page">
        <div className="page-head">
          <div>
            <div className="page-title">电视直播</div>
            <div className="page-sub">来自配置源 lives 字段的直播频道</div>
          </div>
        </div>
        <EmptyState
          icon={<Icon name="live" size={26} />}
          title="当前配置里没有直播源"
          desc="你添加的配置文件中 lives 字段为空。换一个包含直播的配置源，或在配置文件里补上 lives 后再同步。"
          actions={
            <NavLink to="/settings" className="btn btn-primary">
              管理配置源
            </NavLink>
          }
        />
      </div>
    )
  }

  const failed = live?.sources.filter((s) => s.error) ?? []
  const channelCount = groups.reduce((n, g) => n + g.channels.length, 0)

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">电视直播</div>
          <div className="page-sub">
            {liveLoading
              ? '正在拉取频道列表…'
              : `${groups.length} 个分组 · ${channelCount} 个频道 · 来自 ${live?.sources.length ?? 0} 个直播源`}
          </div>
        </div>
        <div className="page-actions">
          {probing ? (
            <span className="page-actions-note">
              <span className="spin" />
              正在体检线路…
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost"
            disabled={probing || liveLoading}
            onClick={() => void recheck()}
          >
            <Icon name="check" size={14} />
            体检线路
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={liveLoading}
            onClick={() => void loadLive(true)}
          >
            {liveLoading ? <span className="spin" /> : <Icon name="refresh" size={14} />}
            重新拉取
          </button>
        </div>
      </div>

      {failed.length ? (
        <div className="banner banner-warn">
          {failed.length} 个直播源没拉到频道：{failed.map((s) => s.name).join('、')}
          <br />
          <span className="text-3 fs-12">{failed[0].error}</span>
        </div>
      ) : null}

      {live && !live.total ? (
        <EmptyState
          icon={<Icon name="live" size={26} />}
          title="直播源里没有解析出频道"
          desc="可能是源已失效，或者用的是本站还不支持的格式。点右上角「重新拉取」再试一次。"
        />
      ) : null}

      {live?.total ? (
        <div className="live-layout">
          <aside className="live-groups">
            <div className="live-search">
              <Icon name="search" size={14} />
              <input
                className="input"
                placeholder="搜频道名"
                value={kw}
                onChange={(e) => setKw(e.target.value)}
              />
            </div>
            <div className="live-group-list">
              {groups.map((g) => (
                <button
                  type="button"
                  key={g.name}
                  className={`live-group${!kw && g.name === group ? ' active' : ''}`}
                  onClick={() => {
                    setKw('')
                    setGroup(g.name)
                  }}
                >
                  <span className="grow truncate">{g.name}</span>
                  <span className="live-group-count">{g.channels.length}</span>
                </button>
              ))}
            </div>
          </aside>

          <div className="live-main">
            {picked ? (
              <div className="live-stage-wrap" ref={stageWrapRef}>
                <div className="live-stage-head">
                  <span className="live-stage-name">{picked.name}</span>
                  <span className="tag tag-outline">{picked.group}</span>
                  {picked.urls.length > 1 ? (
                    <span className="source-chips">
                      {picked.urls.map((u, i) => {
                        const h = urlHealth(u.url)
                        return (
                          <button
                            type="button"
                            key={u.url}
                            className={`chip chip-source${i === lineIndex ? ' active' : ''}`}
                            title={h ? `${u.url}（${h.ok ? `正常 ${h.ms}ms` : h.error}）` : u.url}
                            onClick={() => setLineIndex(i)}
                          >
                            {i === lineIndex ? <Icon name="check" size={12} /> : null}
                            {h ? <span className={`dot ${h.ok ? 'ok' : 'bad'}`} /> : null}
                            {u.source}
                          </button>
                        )
                      })}
                    </span>
                  ) : null}
                  <span className="grow" />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={!url}
                    onClick={() => void openExternal()}
                  >
                    <Icon name="external" size={13} />
                    外部播放器
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={!url}
                    onClick={() => void copyUrl()}
                  >
                    <Icon name="link" size={13} />
                    复制地址
                  </button>
                </div>
                {resolveError ? (
                  <div className="live-stage live-stage-msg">
                    <Icon name="alert" size={22} />
                    <div className="live-stage-msg-title">换不到播放地址</div>
                    <div className="live-stage-msg-desc">{resolveError}</div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setRetrySeq((n) => n + 1)}
                    >
                      <Icon name="refresh" size={13} />
                      重试
                    </button>
                  </div>
                ) : resolving ? (
                  <div className="live-stage live-stage-msg">
                    <span className="spin" />
                    <div className="live-stage-msg-desc">
                      正在向{roomPlatform(rawUrl) ?? '平台'}换播放地址…
                    </div>
                  </div>
                ) : picking ? (
                  <div className="live-stage live-stage-msg">
                    <span className="spin" />
                    <div className="live-stage-msg-desc">正在挑一条能用的线路…</div>
                  </div>
                ) : (
                  <div className="live-stage" ref={stageRef} />
                )}
                <div className="player-url mono" title={url || rawUrl}>
                  <span className="player-url-text">{url || rawUrl}</span>
                </div>
              </div>
            ) : null}

            <div className="live-channels-head">
              <span>
                共 {channels.length} 个频道
                {hidden.length ? ` · 其中 ${hidden.length} 个没探到可用线路` : ''}
              </span>
              <span className="grow" />
              {hidden.length || showDead ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowDead((v) => !v)}
                >
                  {showDead ? `隐藏这 ${hidden.length} 个不可用` : `显示 ${hidden.length} 个不可用`}
                </button>
              ) : null}
            </div>

            <div className="live-channels">
              {shown.map((c) => {
                const h = healthOf(
                  c.urls.map((u) => u.url),
                  health
                )
                const dead = h.ok === 0 && h.unknown === 0
                return (
                  <button
                    type="button"
                    key={`${c.group}::${c.name}`}
                    className={`live-channel${picked?.name === c.name ? ' active' : ''}${dead ? ' is-dead' : ''}`}
                    title={h.ok ? `${h.ok} 条线路已确认可用` : undefined}
                    onClick={() => void play(c)}
                  >
                    <span className="live-channel-name truncate">{c.name}</span>
                    {dead ? (
                      <span className="live-channel-lines live-channel-dead">不可用</span>
                    ) : c.urls.length > 1 ? (
                      <span className="live-channel-lines">
                        {h.ok ? `${h.ok}/${c.urls.length} 线` : `${c.urls.length} 线`}
                      </span>
                    ) : null}
                  </button>
                )
              })}
              {!shown.length ? (
                <div className="field-hint">
                  {kw
                    ? '没有匹配的频道。'
                    : hidden.length
                      ? `这个分组下 ${hidden.length} 个频道都没探到可用线路，可以点上面的「显示」看看。`
                      : '这个分组下没有频道。'}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
