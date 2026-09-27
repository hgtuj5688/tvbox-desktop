import { useEffect, useMemo } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { SITE_TYPE_LABEL } from '@shared/siteLabels'
import { Poster } from '@/components/Poster'
import { VodCard } from '@/components/VodCard'
import { useApp } from '@/store/useApp'
import { relativeTime, watchPercent } from '@/utils/format'
import { Icon } from '@/components/icons'

export function Home(): JSX.Element {
  const sources = useApp((s) => s.sources)
  const sites = useApp((s) => s.sites)
  const history = useApp((s) => s.history)
  const home = useApp((s) => s.home)
  const homeLoading = useApp((s) => s.homeLoading)
  const homeLoaded = useApp((s) => s.homeLoaded)
  const loadHome = useApp((s) => s.loadHome)
  const syncAll = useApp((s) => s.syncAll)
  const syncing = useApp((s) => s.syncing)

  // 内容位要等站点列表就绪，所以不放进 init() 跟首屏一起等：
  // 先把统计和「继续观看」画出来，内容位在后台拉，回来了再补上。
  useEffect(() => {
    if (!homeLoaded && !homeLoading) void loadHome()
  }, [homeLoaded, homeLoading, loadHome])

  const stats = useMemo(() => {
    const usable = sites.filter((s) => s.enabled && !s.unsupported)
    const searchable = usable.filter((s) => s.searchable)
    const tested = sites.filter((s) => typeof s.health === 'number' && s.health >= 0)
    const avg = tested.length
      ? Math.round(tested.reduce((sum, s) => sum + (s.health ?? 0), 0) / tested.length)
      : 0
    return { usable: usable.length, searchable: searchable.length, avg, tested: tested.length }
  }, [sites])

  const lastSync = sources.reduce((max, s) => Math.max(max, s.lastSync), 0)
  const busy = Object.keys(syncing).length > 0

  return (
    <div className="page">
      <div className="hero">
        <h1 className="hero-title">TVBox Desktop</h1>
        <p className="hero-sub">
          纯白极简的 Windows 影视聚合客户端 · 配置订阅 · 分类浏览 · 多线路选集播放 · 电视直播。
          当前 <b>M1 到 M4 都已完成</b>：配置源与影视源管理、聚合搜索与分类浏览、详情选集、
          内嵌播放器与一键转外部播放器（会自动检测本机装了哪个）、m3u/txt 直播、收藏与观看历史、
          网页线路自动换出真播放地址，以及下面这几行「最近更新」内容位都能用了。
        </p>
        <div className="hero-actions">
          <NavLink to="/settings" className="btn btn-primary">
            管理配置源
          </NavLink>
          <NavLink to="/sites" className="btn">
            管理影视源（{stats.usable}）
          </NavLink>
          <button type="button" className="btn" disabled={busy} onClick={() => void syncAll()}>
            {busy ? <span className="spin" /> : <Icon name="refresh" size={15} />} 同步全部配置
          </button>
          <button type="button" className="btn" disabled={homeLoading} onClick={() => void loadHome(true)}>
            {homeLoading ? <span className="spin" /> : <Icon name="refresh" size={15} />} 刷新内容位
          </button>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <div className="stat-label">配置源</div>
          <div className="stat-value">
            {sources.length}
            <small>个 / 启用 {sources.filter((s) => s.enabled).length}</small>
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">影视源总数</div>
          <div className="stat-value">
            {sites.length}
            <small>个</small>
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">可用影视源</div>
          <div className="stat-value">
            {stats.usable}
            <small>其中可搜索 {stats.searchable}</small>
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">平均响应</div>
          <div className="stat-value" style={{ color: stats.avg ? 'var(--success)' : undefined }}>
            {stats.avg || '—'}
            <small>{stats.avg ? 'ms' : `已测 ${stats.tested} 个`}</small>
          </div>
        </div>
      </div>

      {history.length ? (
        <div className="section">
          <div className="section-head">
            <div className="section-title">继续观看</div>
            <div className="section-more">
              <NavLink to="/library">全部记录 →</NavLink>
            </div>
          </div>
          <div className="continue-row">
            {history.slice(0, 6).map((group) => {
              const item = group.items[0]
              const pct = watchPercent(item)
              const to = `/play/${encodeURIComponent(item.siteKey)}/${encodeURIComponent(item.vodId)}/${item.lineIndex}/${item.epIndex}`
              return (
                <Link className="continue-card" key={group.key} to={to}>
                  <div className="continue-poster">
                    <Poster src={item.pic ?? group.pic} name={group.name} />
                    <span className="continue-play">
                      <Icon name="play" size={16} />
                    </span>
                  </div>
                  <div className="continue-body">
                    <div className="continue-title truncate" title={group.name}>
                      {group.name}
                    </div>
                    <div className="continue-sub truncate">
                      {item.epName || `第 ${item.epIndex + 1} 集`} · {relativeTime(item.updatedAt)}
                      {group.items.length > 1 ? ` · ${group.items.length} 个源` : ''}
                    </div>
                    {pct !== null ? (
                      <div className="continue-bar" title={`已看 ${pct}%`}>
                        <span style={{ width: `${pct}%` }} />
                      </div>
                    ) : null}
                  </div>
                </Link>
              )
            })}
          </div>
        </div>
      ) : null}

      {home.length
        ? home.map((section) => (
            <div className="section" key={section.key}>
              <div className="section-head">
                <div className="section-title">
                  {section.title}
                  {section.origin === 'default' ? (
                    <span className="tag tag-outline" style={{ marginLeft: 8 }}>
                      自动
                    </span>
                  ) : null}
                </div>
                <div className="section-more">
                  {section.error ? (
                    <span className="text-3" title={section.error}>
                      {section.error}
                    </span>
                  ) : (
                    <>
                      <span className="text-3">{section.items.length} 条</span>
                      <NavLink to="/search" style={{ marginLeft: 8 }}>
                        去分类浏览 →
                      </NavLink>
                    </>
                  )}
                </div>
              </div>
              {section.items.length ? (
                <div className="home-row">
                  {section.items.map((vod) => (
                    <VodCard key={`${vod.siteKey}-${vod.vod_id}`} vod={vod} />
                  ))}
                </div>
              ) : null}
            </div>
          ))
        : null}

      {homeLoading && !home.length ? (
        <div className="section">
          <div className="section-head">
            <div className="section-title">正在读取各站点的最近更新…</div>
            <div className="section-more">
              <span className="text-3">第一次会慢一点</span>
            </div>
          </div>
          <div className="home-row">
            {Array.from({ length: 6 }, (_, i) => (
              <div className="vod-card" key={i}>
                <span className="skeleton sk-poster" />
                <div className="vod-card-body">
                  <span className="skeleton sk-line" />
                  <span className="skeleton sk-line-short" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="section">
        <div className="section-head">
          <div className="section-title">配置源状态</div>
          <div className="section-more">
            最近同步：{relativeTime(lastSync)}
            <NavLink to="/settings" style={{ marginLeft: 8 }}>
              管理 →
            </NavLink>
          </div>
        </div>
        <div className="panel">
          <div className="list">
            {sources.map((source) => (
              <div className="list-row" key={source.id}>
                <span className={`dot ${source.error ? 'bad' : source.lastSync ? 'ok' : ''}`} />
                <div className="list-row-main">
                  <div className="list-row-title">{source.name}</div>
                  <div className="list-row-sub">
                    {source.kind === 'url' ? source.url : `本地文件 · ${source.url}`}
                  </div>
                </div>
                {source.error ? (
                  <span className="tag tag-danger" title={source.error}>
                    同步失败
                  </span>
                ) : null}
                <span className="tag tag-outline">{source.siteCount} 站</span>
                <span className="tag tag-outline">{source.liveCount} 直播</span>
                <span className="tag tag-outline">{source.parseCount} 解析</span>
                <span className="fs-12 text-3 nowrap">{relativeTime(source.lastSync)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title">影视源概览（按类型）</div>
          <div className="section-more">
            <NavLink to="/sites">全部影视源 →</NavLink>
          </div>
        </div>
        <div className="stat-grid">
          {([3, 1, 4, 0, 2] as const).map((type) => {
            const group = sites.filter((s) => s.type === type)
            if (!group.length) return null
            return (
              <div className="stat" key={type}>
                <div className="stat-label">{SITE_TYPE_LABEL[type]}</div>
                <div className="stat-value">
                  {group.length}
                  <small>启用 {group.filter((s) => s.enabled).length}</small>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <div className="section-title">开发里程碑</div>
          <div className="section-more">详见项目根目录「功能框架.txt」</div>
        </div>
        <div className="milestones">
          <div className="milestone done">
            <div className="milestone-head">
              <span className="milestone-code">M1</span>
              <span className="tag tag-success">已完成</span>
            </div>
            <div className="milestone-title">项目骨架 + 纯白 UI + 配置源管理</div>
            <div className="milestone-desc">
              Electron/React/TS 工程、设计变量体系、配置源增删同步、影视源列表与连通性测试。
            </div>
          </div>
          <div className="milestone done">
            <div className="milestone-head">
              <span className="milestone-code">M2</span>
              <span className="tag tag-success">已完成</span>
            </div>
            <div className="milestone-title">聚合搜索 + 详情选集 + 播放器</div>
            <div className="milestone-desc">
              多站点并发搜索与同名合并、线路与剧集解析、ArtPlayer + hls.js 播放、
              自动挑可播放线路、一键转外部播放器。
            </div>
          </div>
          <div className="milestone done">
            <div className="milestone-head">
              <span className="milestone-code">M3</span>
              <span className="tag tag-success">已完成</span>
            </div>
            <div className="milestone-title">直播 + 收藏 / 历史</div>
            <div className="milestone-desc">
              m3u 与 txt 分组直播源解析、频道分组与多线路、收藏夹、观看历史与首页继续观看。
            </div>
          </div>
          <div className="milestone done">
            <div className="milestone-head">
              <span className="milestone-code">M4</span>
              <span className="tag tag-success">已完成</span>
            </div>
            <div className="milestone-title">解析接口 + 首页内容位 + 外部播放器</div>
            <div className="milestone-desc">
              网页型地址自动换出真实播放地址（先自己读播放页，读不出来才按排行问解析接口）；
              首页内容位（读配置 home.sections，没配就每个源一条「最近更新」）；
              设置页一键检测本机播放器（扫常见路径 + 问系统默认打开方式）。
            </div>
          </div>
          <div className="milestone doing">
            <div className="milestone-head">
              <span className="milestone-code">M5</span>
              <span className="tag tag-accent">下一步</span>
            </div>
            <div className="milestone-title">打包发布</div>
            <div className="milestone-desc">
              electron-builder 产出 NSIS 安装包与免安装 zip。
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
