import { useMemo, useState } from 'react'
import type { Site, SiteType } from '@shared/types'
import { SITE_TYPE_LABEL, SITE_TYPE_TAG } from '@shared/siteLabels'
import { Switch } from '@/components/Switch'
import { EmptyState } from '@/components/EmptyState'
import { Icon } from '@/components/icons'
import { useApp } from '@/store/useApp'

const TYPE_ORDER: SiteType[] = [3, 4, 1, 0, 2]

export function Sites(): JSX.Element {
  const sites = useApp((s) => s.sites)
  const setSiteEnabled = useApp((s) => s.setSiteEnabled)
  const setSitesEnabled = useApp((s) => s.setSitesEnabled)
  const refreshSites = useApp((s) => s.refreshSites)
  const notify = useApp((s) => s.notify)

  const [kw, setKw] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | SiteType>('all')
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  const [onlyEnabled, setOnlyEnabled] = useState(false)
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [health, setHealth] = useState<Record<string, { ok: boolean; text: string }>>({})

  const sourceNames = useMemo(
    () => Array.from(new Set(sites.map((s) => s.sourceName))).sort(),
    [sites]
  )

  const typeCounts = useMemo(() => {
    const map = new Map<SiteType, number>()
    for (const s of sites) map.set(s.type, (map.get(s.type) ?? 0) + 1)
    return map
  }, [sites])

  const filtered = useMemo(() => {
    const k = kw.trim().toLowerCase()
    return sites.filter((s) => {
      if (typeFilter !== 'all' && s.type !== typeFilter) return false
      if (sourceFilter !== 'all' && s.sourceName !== sourceFilter) return false
      if (onlyEnabled && !s.enabled) return false
      if (!k) return true
      return (
        s.name.toLowerCase().includes(k) ||
        s.key.toLowerCase().includes(k) ||
        s.api.toLowerCase().includes(k)
      )
    })
  }, [sites, kw, typeFilter, sourceFilter, onlyEnabled])

  async function test(site: Site): Promise<void> {
    setTesting((t) => ({ ...t, [site.key]: true }))
    try {
      const result = await window.api.sites.test(site.key)
      setHealth((h) => ({
        ...h,
        [site.key]: { ok: result.ok, text: result.ok ? `${result.ms}ms · ${result.message}` : result.message }
      }))
      if (!result.ok) notify(`${site.name}：${result.message}`, 'warn')
    } finally {
      setTesting((t) => {
        const next = { ...t }
        delete next[site.key]
        return next
      })
    }
  }

  async function testAllVisible(): Promise<void> {
    const targets = filtered.filter((s) => !s.unsupported && s.enabled)
    for (const site of targets) await test(site)
    notify(`已测试 ${targets.length} 个站点`, 'success')
  }

  const enabledKeys = filtered.filter((s) => s.enabled).map((s) => s.key)

  if (!sites.length) {
    return (
      <div className="page">
        <div className="page-head">
          <div>
            <div className="page-title">影视源</div>
            <div className="page-sub">配置源中解析出的全部站点</div>
          </div>
        </div>
        <EmptyState
          icon={<Icon name="layers" size={26} />}
          title="还没有任何影视源"
          desc="影视源来自你添加的 JSON 配置。到「设置」里添加一个订阅地址或本地配置文件，这里就会列出全部站点。"
        />
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">影视源</div>
          <div className="page-sub">
            共 {sites.length} 个站点 · 启用 {sites.filter((s) => s.enabled).length} 个 ·
            当前列表 {filtered.length} 个
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-sm" onClick={() => void refreshSites()}>
            <Icon name="refresh" size={14} /> 刷新列表
          </button>
          <button type="button" className="btn btn-sm" onClick={() => void testAllVisible()}>
            <Icon name="check" size={14} /> 测试当前列表
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void setSitesEnabled(enabledKeys, false)}
            disabled={!enabledKeys.length}
          >
            全部禁用
          </button>
        </div>
      </div>

      <div className="filter-bar">
        <div className="search-box" style={{ width: 260 }}>
          <span className="search-icon">
            <Icon name="search" size={15} />
          </span>
          <input value={kw} placeholder="搜索站点名称 / key / 接口" onChange={(e) => setKw(e.target.value)} />
        </div>

        <div className="chips">
          <button
            type="button"
            className={`chip${typeFilter === 'all' ? ' active' : ''}`}
            onClick={() => setTypeFilter('all')}
          >
            全部类型 <span className="chip-count">{sites.length}</span>
          </button>
          {TYPE_ORDER.filter((t) => typeCounts.has(t)).map((t) => (
            <button
              key={t}
              type="button"
              className={`chip${typeFilter === t ? ' active' : ''}`}
              onClick={() => setTypeFilter(t)}
            >
              {SITE_TYPE_LABEL[t]} <span className="chip-count">{typeCounts.get(t)}</span>
            </button>
          ))}
        </div>

        <div className="grow" />

        {sourceNames.length > 1 ? (
          <select
            className="input"
            style={{ width: 170 }}
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
          >
            <option value="all">全部配置源</option>
            {sourceNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        ) : null}

        <button
          type="button"
          className={`chip${onlyEnabled ? ' active' : ''}`}
          onClick={() => setOnlyEnabled((v) => !v)}
        >
          只看已启用
        </button>
      </div>

      <div className="panel">
        <div className="list">
          {filtered.map((site) => {
            const h = health[site.key]
            return (
              <div className="list-row" key={site.key}>
                <Switch
                  checked={site.enabled}
                  disabled={Boolean(site.unsupported)}
                  onChange={(v) => void setSiteEnabled(site.key, v)}
                  title={site.unsupported ?? '启用 / 停用该站点'}
                />

                <div className="list-row-main">
                  <div className="list-row-title site-name">
                    <span className="truncate">{site.name}</span>
                    <span className={`tag ${SITE_TYPE_TAG[site.type]}`}>{SITE_TYPE_LABEL[site.type]}</span>
                    {site.searchable ? <span className="tag tag-outline">可搜索</span> : null}
                    {!site.searchable && !site.unsupported ? (
                      <span className="tag tag-outline">仅浏览</span>
                    ) : null}
                  </div>
                  <div className="list-row-sub">
                    <span className="site-key">{site.key}</span>
                    <span style={{ margin: '0 8px' }}>·</span>
                    {site.unsupported ? (
                      <span style={{ color: 'var(--warn)' }}>{site.unsupported}</span>
                    ) : (
                      <span className="mono">{site.api || '未配置接口'}</span>
                    )}
                  </div>
                </div>

                {h ? (
                  <span className="health" title={h.text}>
                    <span className={`dot ${h.ok ? 'ok' : 'bad'}`} />
                    {h.text.length > 26 ? `${h.text.slice(0, 26)}…` : h.text}
                  </span>
                ) : typeof site.health === 'number' ? (
                  <span className="health">
                    <span className={`dot ${site.health >= 0 ? 'ok' : 'bad'}`} />
                    {site.health >= 0 ? `${site.health}ms` : '失败'}
                  </span>
                ) : (
                  <span className="health">未测试</span>
                )}

                <div className="list-row-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={Boolean(testing[site.key]) || Boolean(site.unsupported)}
                    onClick={() => void test(site)}
                  >
                    {testing[site.key] ? <span className="spin" /> : null} 测试
                  </button>
                </div>
              </div>
            )
          })}

          {!filtered.length ? (
            <EmptyState icon={<Icon name="search" size={26} />} title="没有匹配的站点" desc="换个关键词或清空筛选条件试试。" />
          ) : null}
        </div>
      </div>
    </div>
  )
}
