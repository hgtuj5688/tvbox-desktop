import { useCallback, useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import type { AppSettings, ConfigSource, ParseInfo, ParseTestResult, PlayerInfo } from '@shared/types'
import { useApp } from '@/store/useApp'
import { Switch } from '@/components/Switch'
import { Icon } from '@/components/icons'
import { relativeTime } from '@/utils/format'

export function Settings(): JSX.Element {
  const sources = useApp((s) => s.sources)
  const settings = useApp((s) => s.settings)
  const info = useApp((s) => s.info)
  const syncing = useApp((s) => s.syncing)
  const syncSource = useApp((s) => s.syncSource)
  const refreshAll = useApp((s) => s.refreshAll)
  const updateSettings = useApp((s) => s.updateSettings)
  const notify = useApp((s) => s.notify)
  const presets = useApp((s) => s.presets)
  const addPreset = useApp((s) => s.addPreset)

  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [addingPreset, setAddingPreset] = useState('')
  const [editing, setEditing] = useState<{ id: string; name: string; url: string } | null>(null)

  async function add(): Promise<void> {
    const value = url.trim()
    if (!value) {
      notify('请先填写订阅地址或选择本地文件', 'warn')
      return
    }
    setAdding(true)
    try {
      const created = await window.api.sources.add({
        name: name.trim() || undefined,
        url: value,
        kind: /^https?:\/\//i.test(value) ? 'url' : 'file'
      })
      setName('')
      setUrl('')
      await refreshAll()
      notify(`已添加「${created.name}」，正在拉取配置…`, 'success')
      await syncSource(created.id)
    } catch (err) {
      notify((err as Error).message, 'danger')
    } finally {
      setAdding(false)
    }
  }

  async function pick(): Promise<void> {
    const picked = await window.api.sources.pickFile()
    if (!picked) return
    setUrl(picked)
    if (!name.trim()) setName(guessName(picked))
  }

  async function remove(source: ConfigSource): Promise<void> {
    if (!window.confirm(`确定要删除配置源「${source.name}」吗？该操作不影响磁盘上的原始文件。`)) return
    await window.api.sources.remove(source.id)
    await refreshAll()
    notify(`已删除「${source.name}」`, 'success')
  }

  async function saveEdit(): Promise<void> {
    if (!editing) return
    try {
      await window.api.sources.update(editing.id, { name: editing.name, url: editing.url })
      setEditing(null)
      await refreshAll()
      notify('已保存修改', 'success')
    } catch (err) {
      notify((err as Error).message, 'danger')
    }
  }

  async function toggle(source: ConfigSource, enabled: boolean): Promise<void> {
    await window.api.sources.update(source.id, { enabled })
    await refreshAll()
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">设置</div>
          <div className="page-sub">配置源、播放与界面偏好</div>
        </div>
      </div>

      <div className="settings-grid">
        <section className="section">
          <div className="section-head">
            <div className="section-title">配置源</div>
            <div className="section-more">
              支持 TVBox 标准 JSON 与本项目的 tvbox-desktop/1 简洁格式
            </div>
          </div>

          <div className="panel">
            <div className="form-row">
              <div className="field" style={{ flex: '0 0 180px' }}>
                <label>名称（可选）</label>
                <input
                  className="input"
                  value={name}
                  placeholder="留空则用配置里的 name"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="field grow">
                <label>订阅地址 / 本地文件路径</label>
                <input
                  className="input"
                  value={url}
                  placeholder="https://example.com/tvbox.json 或 D:\config\api.json"
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void add()
                  }}
                />
              </div>
              <button type="button" className="btn" onClick={() => void pick()}>
                选择文件…
              </button>
              <button type="button" className="btn btn-primary" disabled={adding} onClick={() => void add()}>
                {adding ? <span className="spin" /> : '+'} 添加
              </button>
            </div>
          </div>

          {presets.length ? (
            <div className="panel" style={{ marginTop: 12 }}>
              <div className="panel-body-pad">
                <div className="field-hint" style={{ marginBottom: 8 }}>
                  内置推荐订阅（默认不启用，点「添加」才会写进你的配置源）
                </div>
                {presets.map((preset) => (
                  <div className="preset-row" key={preset.id}>
                    <div className="grow">
                      <div className="list-row-title">{preset.name}</div>
                      <div className="list-row-sub">{preset.desc}</div>
                    </div>
                    <span className="tag tag-outline">
                      {preset.siteCount} 个站点
                      {preset.liveCount ? ` · ${preset.liveCount} 个直播源` : ''}
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={addingPreset === preset.id}
                      onClick={async () => {
                        setAddingPreset(preset.id)
                        await addPreset(preset.id)
                        setAddingPreset('')
                      }}
                    >
                      {addingPreset === preset.id ? <span className="spin" /> : <Icon name="plus" size={13} />}
                      添加
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="panel" style={{ marginTop: 12 }}>
            <div className="list">
              {sources.map((source) => (
                <div className="list-row" key={source.id}>
                  <Switch
                    checked={source.enabled}
                    onChange={(v) => void toggle(source, v)}
                    title="启用 / 停用该配置源"
                  />
                  {editing?.id === source.id ? (
                    <>
                      <div className="field grow">
                        <input
                          className="input"
                          value={editing.name}
                          placeholder="名称"
                          onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                        />
                      </div>
                      <div className="field grow" style={{ flex: 2 }}>
                        <input
                          className="input"
                          value={editing.url}
                          onChange={(e) => setEditing({ ...editing, url: e.target.value })}
                        />
                      </div>
                      <button type="button" className="btn btn-sm btn-primary" onClick={() => void saveEdit()}>
                        保存
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="list-row-main">
                        <div className="list-row-title">
                          <span className="truncate">{source.name}</span>
                          <span className="tag tag-outline">{source.kind === 'url' ? '订阅' : '本地'}</span>
                          {source.error ? <span className="tag tag-danger">异常</span> : null}
                        </div>
                        <div className="list-row-sub truncate" title={source.url}>
                          {source.url}
                        </div>
                      </div>
                      <span className="fs-12 text-3 nowrap">
                        站点 {source.siteCount} · 直播 {source.liveCount} · 解析 {source.parseCount}
                      </span>
                      <span className="fs-12 text-3 nowrap">{relativeTime(source.lastSync)}</span>
                      <div className="list-row-actions">
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={Boolean(syncing[source.id])}
                          onClick={() => void syncSource(source.id)}
                        >
                          {syncing[source.id] ? <span className="spin" /> : <Icon name="refresh" size={13} />} 同步
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setEditing({ id: source.id, name: source.name, url: source.url })}
                        >
                          编辑
                        </button>
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(source)}>
                          删除
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}

              {!sources.length ? (
                <div className="empty" style={{ padding: 24 }}>
                  <div className="empty-desc">还没有配置源，用上面的表单添加一个吧。</div>
                </div>
              ) : null}
            </div>
          </div>

          {sources.some((s) => s.error) ? (
            <div className="banner banner-warn" style={{ marginTop: 12 }}>
              <b>同步失败详情：</b>
              {sources
                .filter((s) => s.error)
                .map((s) => `${s.name}：${s.error}`)
                .join('　|　')}
            </div>
          ) : null}
        </section>

        <ParseSettingsSection />
        {settings ? <GeneralSettings settings={settings} onPatch={updateSettings} /> : null}
        {settings ? <AiSettingsSection settings={settings} onPatch={updateSettings} /> : null}

        <section className="section">
          <div className="section-head">
            <div className="section-title">配置格式</div>
            <div className="section-more">完整规范见项目根目录「功能框架.txt」第 5 章</div>
          </div>
          <div className="panel">
            <div className="code-block">{JSON_SAMPLE}</div>
            <div className="fs-12 text-3" style={{ marginTop: 10, lineHeight: 1.8 }}>
              <div>
                · <b>A 方言</b>：与安卓版 TVBox 相同的 <span className="mono">sites / lives / parses</span> 结构，
                可直接导入现成订阅。
              </div>
              <div>
                · <b>B 方言</b>：加上 <span className="mono">"format": "tvbox-desktop/1"</span>，
                站点可以只写 <span className="mono">"type": "cms"</span> 或 <span className="mono">"html"</span>，
                其余字段自动归一化。
              </div>
              <div>
                · 桌面端无法运行 Java jar / dex 形式的 spider，
                <span className="mono">type=0</span> 的站点会被标记「需 Spider」并跳过。
              </div>
            </div>
          </div>
        </section>

        <section className="section">
          <div className="section-head">
            <div className="section-title">关于</div>
            <div className="section-more">
              <NavLink to="/sites">查看影视源 →</NavLink>
            </div>
          </div>
          <div className="panel">
            <div className="kv">
              <div className="kv-key">版本</div>
              <div className="kv-value mono">v{info?.version ?? '—'}</div>
            </div>
            <div className="kv">
              <div className="kv-key">运行环境</div>
              <div className="kv-value mono">
                Electron {info?.electron ?? '—'} · Chromium {info?.chrome ?? '—'} · Node {info?.node ?? '—'}
              </div>
            </div>
            <div className="kv">
              <div className="kv-key">数据目录</div>
              <div className="kv-value mono truncate" title={info?.userData}>
                {info?.userData ?? '—'}
              </div>
            </div>
            <div className="kv">
              <div className="kv-key">开源组件</div>
              <div className="kv-value">
                Electron · React · ArtPlayer · hls.js · cheerio
              </div>
            </div>
          </div>
          <div className="banner banner-info" style={{ marginTop: 12 }}>
            本软件是纯粹的空壳播放器，不内置、不提供、不分发任何影视内容。请自行添加合法的配置源。
          </div>
        </section>
      </div>
    </div>
  )
}

const JSON_SAMPLE = `{
  "format": "tvbox-desktop/1",
  "name": "我的配置",
  "sites": [
    { "key": "demo", "name": "示例站", "type": "cms",
      "api": "https://demo.example.com/api.php/provide/vod" },
    { "key": "html", "name": "网页站", "type": "html",
      "api": "https://demo.example.com/search?wd={wd}",
      "rules": { "list": ".result li", "name": "a", "link": "a" } }
  ],
  "lives": [ { "name": "默认直播", "type": 0, "url": "https://example.com/live.txt" } ],
  "parses": [ { "name": "解析线路", "type": 1, "url": "https://example.com/jx?url=" } ]
}`

interface GeneralProps {
  settings: AppSettings
  onPatch: (patch: Partial<AppSettings>) => Promise<void>
}

/** 一条解析接口的战绩，写成人话 */
function statText(stat: ParseInfo['stat']): string {
  const total = stat.ok + stat.fail
  if (!total) return '还没测过'
  const parts = [`成功 ${stat.ok}`, `失败 ${stat.fail}`]
  if (stat.lastOk) parts.push(`最近 ${stat.lastMs}ms`)
  return parts.join(' · ')
}

/**
 * 解析接口管理。
 *
 * 这一块在界面上要讲清楚一件事：**大部分网页地址根本不需要解析接口**。
 * 采集站的分享页十有八九是个 DPlayer 壳，地址明文写在脚本里，应用自己读一遍就有了。
 * 解析接口是「读不出来时」的兜底，所以文案的顺序也是这么写的。
 */
function ParseSettingsSection(): JSX.Element {
  const notify = useApp((s) => s.notify)
  const sources = useApp((s) => s.sources)
  const [list, setList] = useState<ParseInfo[]>([])
  const [busy, setBusy] = useState('')
  const [results, setResults] = useState<Record<string, ParseTestResult>>({})
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [flags, setFlags] = useState('')
  const [adding, setAdding] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    setList(await window.api.parse.list())
  }, [])

  // sources 作为依赖：同步完配置源以后，配置里带的解析接口应该立刻出现在这里
  useEffect(() => {
    void reload()
  }, [reload, sources])

  const test = async (item: ParseInfo): Promise<void> => {
    setBusy(item.url)
    try {
      const r = await window.api.parse.test(item.url)
      setResults((prev) => ({ ...prev, [item.url]: r }))
      await reload()
    } catch (err) {
      notify((err as Error).message, 'danger')
    } finally {
      setBusy('')
    }
  }

  const testAll = async (): Promise<void> => {
    for (const item of list) await test(item)
    notify('全部测完了，排行已经按结果更新', 'success')
  }

  const add = async (): Promise<void> => {
    if (!url.trim()) return
    setAdding(true)
    try {
      setList(await window.api.parse.add({ name, url, flags: flags.split(/[\s,|]+/).filter(Boolean) }))
      setName('')
      setUrl('')
      setFlags('')
      notify('解析接口已添加', 'success')
    } catch (err) {
      notify((err as Error).message, 'danger')
    } finally {
      setAdding(false)
    }
  }

  const remove = async (item: ParseInfo): Promise<void> => {
    if (!window.confirm(`删除解析接口「${item.name}」？`)) return
    setList(await window.api.parse.remove(item.url))
    notify('已删除', 'success')
  }

  const custom = list.filter((p) => p.origin === 'custom').length

  return (
    <section className="section">
      <div className="section-head">
        <div className="section-title">解析接口</div>
        <div className="section-more">
          {list.length ? `${list.length} 条（配置里 ${list.length - custom} · 手动 ${custom}）` : '一条都没有'}
        </div>
      </div>
      <div className="panel panel-body-pad">
        <div className="fs-12 text-3" style={{ lineHeight: 1.8, marginBottom: 12 }}>
          有些采集站给的线路不是直链，而是一个分享页地址。播放时应用会
          <b>先自己去读一遍那个页面</b>（很多分享页就是个播放器壳，地址明文写在里面），
          读不出来才按下面的排行依次问解析接口。失败的接口会排到后面，越用越准。
        </div>

        {list.length ? (
          <div className="list">
            {list.map((item) => {
              const r = results[item.url]
              return (
                <div className="list-row" key={item.url}>
                  <div className="list-row-main">
                    <div className="list-row-title">
                      {item.name}
                      <span className={`tag ${item.origin === 'custom' ? 'tag-accent' : 'tag-outline'}`}>
                        {item.origin === 'custom' ? '手动添加' : '配置里带的'}
                      </span>
                      {item.type === 0 ? <span className="tag tag-warn">type=0 需浏览器嗅探</span> : null}
                    </div>
                    <div className="list-row-sub mono truncate">{item.url}</div>
                    <div className="list-row-sub">
                      {item.flags.length ? `只解析 ${item.flags.join(' / ')}` : '通配所有线路'}
                      {' · '}
                      {statText(item.stat)}
                    </div>
                    {r ? (
                      <div className={`list-row-sub ${r.ok ? '' : 'text-3'}`}>
                        {r.ok ? (
                          <span className="mono truncate">✓ {r.ms}ms 换到 {r.url}</span>
                        ) : (
                          <span>✗ {r.error}</span>
                        )}
                      </div>
                    ) : null}
                  </div>
                  <div className="list-row-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy === item.url}
                      onClick={() => void test(item)}
                    >
                      {busy === item.url ? <span className="spin" /> : <Icon name="check" size={13} />}
                      测一下
                    </button>
                    {item.origin === 'custom' ? (
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(item)}>
                        <Icon name="trash" size={13} />
                      </button>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="fs-13 text-3">
            还没解析接口。你的 TVBox 订阅里如果有 <span className="mono">parses</span> 字段，
            同步后会自动出现在这里；也可以手动加一条。
          </div>
        )}

        <div className="divider" />

        <div className="form-row">
          <div className="field" style={{ flex: '0 0 150px' }}>
            <label>名称</label>
            <input
              className="input"
              placeholder="例如 某解析"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field" style={{ flex: '1 1 260px' }}>
            <label>接口地址</label>
            <input
              className="input mono"
              placeholder="https://…/?url="
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div className="field" style={{ flex: '0 0 150px' }}>
            <label>只解析哪些线路</label>
            <input
              className="input mono"
              placeholder="留空 = 全部"
              value={flags}
              onChange={(e) => setFlags(e.target.value)}
            />
          </div>
          <button type="button" className="btn btn-primary" disabled={adding || !url.trim()} onClick={() => void add()}>
            <Icon name="plus" size={14} />
            添加
          </button>
        </div>

        {list.length ? (
          <div className="hstack" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void testAll()}>
              <Icon name="check" size={13} />
              逐个测一遍
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                setResults({})
                setList(await window.api.parse.resetStats())
                notify('排行已清空', 'success')
              }}
            >
              清空排行
            </button>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function GeneralSettings({ settings, onPatch }: GeneralProps): JSX.Element {
  const [draft, setDraft] = useState<AppSettings>(settings)
  useEffect(() => setDraft(settings), [settings])

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)

  // 点「检测本机播放器」之前不主动扫，因为这个动作要摸一遍磁盘上的常见安装路径
  const [players, setPlayers] = useState<PlayerInfo[] | null>(null)
  const [detecting, setDetecting] = useState(false)
  const detect = async (): Promise<void> => {
    setDetecting(true)
    try {
      setPlayers(await window.api.player.detect())
    } finally {
      setDetecting(false)
    }
  }

  return (
    <section className="section">
      <div className="section-head">
        <div className="section-title">通用</div>
        <div className="section-more">{dirty ? '有未保存的修改' : '已保存'}</div>
      </div>
      <div className="panel">
        <div className="form-row">
          <div className="field">
            <label>聚合搜索并发数</label>
            <input
              className="input"
              type="number"
              min={1}
              max={32}
              value={draft.concurrency}
              onChange={(e) => setDraft({ ...draft, concurrency: clampInt(e.target.value, 1, 32, 8) })}
            />
            <div className="field-hint">同时请求的站点数量，过大可能被部分站点限流（1–32）</div>
          </div>
          <div className="field">
            <label>请求超时（秒）</label>
            <input
              className="input"
              type="number"
              min={3}
              max={120}
              value={draft.timeout}
              onChange={(e) => setDraft({ ...draft, timeout: clampInt(e.target.value, 3, 120, 20) })}
            />
            <div className="field-hint">单个站点搜索与详情请求的最长等待时间</div>
          </div>
          <div className="field">
            <label>界面密度</label>
            <select
              className="input"
              value={draft.density}
              onChange={(e) => setDraft({ ...draft, density: e.target.value as AppSettings['density'] })}
            >
              <option value="compact">紧凑（推荐，信息更多）</option>
              <option value="comfortable">宽松</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 140px' }}>
            <label>强调色</label>
            <div className="hstack">
              <input
                className="input"
                type="color"
                style={{ width: 48, padding: 2 }}
                value={draft.accent}
                onChange={(e) => setDraft({ ...draft, accent: e.target.value })}
              />
              <span className="mono fs-12">{draft.accent}</span>
            </div>
          </div>
          <div className="field" style={{ flex: '1 1 260px' }}>
            <label>搜索结果过滤解说</label>
            <div className="hstack" style={{ paddingTop: 6, gap: 10 }}>
              <Switch
                checked={draft.filterCommentary}
                onChange={(next) => setDraft({ ...draft, filterCommentary: next })}
              />
              <span className="fs-13 text-2">
                {draft.filterCommentary ? '隐藏解说 / 速看 / 混剪' : '全部显示'}
              </span>
            </div>
            <div className="field-hint">采集站常把「XX解说」「一口气看完」和正片放一起，默认挡掉</div>
          </div>
        </div>

        <div className="field" style={{ marginTop: 8 }}>
          <label>User-Agent</label>
          <input
            className="input"
            value={draft.userAgent}
            onChange={(e) => setDraft({ ...draft, userAgent: e.target.value })}
          />
          <div className="field-hint">部分站点会校验 UA，异常时可以先恢复默认</div>
        </div>

        <div className="divider" />

        <div className="field">
          <label>外部播放器命令</label>
          <input
            className="input"
            placeholder="留空则自动探测 PotPlayer / mpv / VLC"
            value={draft.externalPlayer.command}
            onChange={(e) =>
              setDraft({ ...draft, externalPlayer: { ...draft.externalPlayer, command: e.target.value } })
            }
          />
          <div className="field-hint">
            参数模板用 <span className="mono">{'{url}'}</span> 代表播放地址，多个参数用空格分隔，例如{' '}
            <span className="mono">--fullscreen {'{url}'}</span>
          </div>
        </div>

        <div className="field">
          <label>本机播放器</label>
          <div className="hstack">
            <button type="button" className="btn btn-sm" disabled={detecting} onClick={() => void detect()}>
              {detecting ? <span className="spin" /> : <Icon name="search" size={14} />} 检测本机播放器
            </button>
            {players ? (
              players.length ? (
                <span className="fs-12 text-3">找到 {players.length} 个</span>
              ) : (
                <span className="fs-12 text-3">
                  一个都没找到（扫过 PotPlayer / mpv / VLC / MPC-HC / MPC-BE / KMPlayer / SMPlayer
                  的常见安装路径，也问过 .mkv / .mp4 的默认打开方式），装在别处的话请直接填上面的路径
                </span>
              )
            ) : (
              <span className="fs-12 text-3">留空时按 PotPlayer → mpv → VLC 的顺序自动找</span>
            )}
          </div>
        </div>
        {players?.length ? (
          <div className="list">
            {players.map((p) => (
              <div className="list-row" key={p.path}>
                <div className="list-row-main">
                  <div className="list-row-title">
                    {p.name}
                    {p.source === 'registry' ? (
                      <span className="tag tag-outline">系统默认打开方式</span>
                    ) : null}
                  </div>
                  <div className="list-row-sub mono truncate" title={p.path}>
                    {p.path}
                  </div>
                </div>
                {draft.externalPlayer.command === p.path ? (
                  <span className="tag tag-success">已选</span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        externalPlayer: { ...draft.externalPlayer, command: p.path }
                      })
                    }
                  >
                    用这个
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : null}

        <div className="field" style={{ maxWidth: 420 }}>
          <label>参数模板</label>
          <input
            className="input mono"
            value={(draft.externalPlayer.args ?? []).join(' ')}
            onChange={(e) =>
              setDraft({
                ...draft,
                externalPlayer: { ...draft.externalPlayer, args: e.target.value.split(/\s+/).filter(Boolean) }
              })
            }
          />
        </div>

        <div className="hstack" style={{ marginTop: 14 }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!dirty}
            onClick={() => void onPatch(draft)}
          >
            保存设置
          </button>
          <button type="button" className="btn" disabled={!dirty} onClick={() => setDraft(settings)}>
            放弃修改
          </button>
        </div>
      </div>
    </section>
  )
}

function AiSettingsSection({ settings, onPatch }: GeneralProps): JSX.Element {
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [showKey, setShowKey] = useState(false)
  useEffect(() => setDraft(settings), [settings])

  const dirty = JSON.stringify(draft.ai) !== JSON.stringify(settings.ai)
  const hasKey = (settings.ai?.apiKey ?? '').trim().length > 0

  const patchAi = (part: Partial<AppSettings['ai']>): void => {
    setDraft({ ...draft, ai: { ...draft.ai, ...part } })
  }

  return (
    <section className="section">
      <div className="section-head">
        <div className="section-title">AI 总结</div>
        <div className="section-more">
          {dirty ? '有未保存的修改' : hasKey ? '已配置' : '还没配置 API Key'}
        </div>
      </div>
      <div className="panel panel-body-pad">
        <div className="field">
          <label>DeepSeek API Key</label>
          <div className="hstack">
            <input
              className="input mono grow"
              type={showKey ? 'text' : 'password'}
              placeholder="sk-..."
              autoComplete="off"
              spellCheck={false}
              value={draft.ai.apiKey}
              onChange={(e) => patchAi({ apiKey: e.target.value })}
            />
            <button type="button" className="btn btn-sm" onClick={() => setShowKey((v) => !v)}>
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
          <div className="field-hint">
            在 <span className="mono">platform.deepseek.com</span> 的「API keys」里创建。只保存在本机{' '}
            <span className="mono">data/settings.json</span>，不会上传到任何地方。
          </div>
        </div>

        <div className="field" style={{ maxWidth: 260 }}>
          <label>模型</label>
          <input
            className="input mono"
            list="ai-models"
            value={draft.ai.model}
            onChange={(e) => patchAi({ model: e.target.value })}
          />
          <datalist id="ai-models">
            <option value="deepseek-flash" />
            <option value="deepseek-v4-pro" />
          </datalist>
          <div className="field-hint">deepseek-flash 最便宜也够用；deepseek-v4-pro 更准但贵几倍</div>
        </div>

        <div className="field">
          <label>接口地址</label>
          <input
            className="input mono"
            placeholder="留空 = https://api.deepseek.com"
            value={draft.ai.baseUrl}
            onChange={(e) => patchAi({ baseUrl: e.target.value })}
          />
          <div className="field-hint">换成任何 OpenAI 兼容的服务都可以，会自动拼 /chat/completions</div>
        </div>

        <div className="banner banner-info">
          点播放页的「AI 总结本集」时，会把片名、集名、类型、年份、演员和站点简介发给 DeepSeek，
          用来生成这一集的剧情。不会发送播放地址，也不会在后台自动调用。
        </div>

        <div className="hstack" style={{ marginTop: 14 }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!dirty}
            onClick={() => void onPatch({ ai: draft.ai })}
          >
            保存设置
          </button>
          <button type="button" className="btn" disabled={!dirty} onClick={() => setDraft(settings)}>
            放弃修改
          </button>
        </div>
      </div>
    </section>
  )
}

function clampInt(value: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/** 从文件路径猜一个名字，省得用户手打 */
function guessName(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? '配置'
  return base.replace(/\.(json|txt)$/i, '')
}
