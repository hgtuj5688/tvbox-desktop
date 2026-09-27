import { useEffect, useState } from 'react'
import { NavLink, Route, Routes } from 'react-router-dom'
import { Sidebar } from '@/components/Sidebar'
import { TopBar } from '@/components/TopBar'
import { Toasts } from '@/components/Toasts'
import { Icon } from '@/components/icons'
import { useApp } from '@/store/useApp'
import { Home } from '@/pages/Home'
import { Search } from '@/pages/Search'
import { Detail } from '@/pages/Detail'
import { Player } from '@/pages/Player'
import { Live } from '@/pages/Live'
import { Library } from '@/pages/Library'
import { Sites } from '@/pages/Sites'
import { Settings } from '@/pages/Settings'
import '@/styles/pages.css'

export default function App(): JSX.Element {
  const ready = useApp((s) => s.ready)
  const init = useApp((s) => s.init)
  const sources = useApp((s) => s.sources)

  useEffect(() => {
    void init()
  }, [init])

  if (!ready) {
    return (
      <div className="boot">
        <div className="boot-logo">T</div>
        <div className="boot-text">正在加载本地配置…</div>
      </div>
    )
  }

  const noSources = sources.length === 0

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <TopBar />
        <main className="app-content">
          <Routes>
            <Route path="/" element={noSources ? <FirstRun /> : <Home />} />
            <Route path="/search" element={<Search />} />
            <Route path="/detail/:siteKey/:vodId" element={<Detail />} />
            <Route path="/play/:siteKey/:vodId/:lineIndex/:epIndex" element={<Player />} />
            <Route path="/live" element={<Live />} />
            <Route path="/library" element={<Library />} />
            <Route path="/sites" element={<Sites />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={noSources ? <FirstRun /> : <Home />} />
          </Routes>
        </main>
      </div>
      <Toasts />
    </div>
  )
}

/** 首次启动：还没有任何配置源，直接引导到配置页而不是给一个空壳 */
function FirstRun(): JSX.Element {
  const presets = useApp((s) => s.presets)
  const addPreset = useApp((s) => s.addPreset)
  const [busy, setBusy] = useState('')

  return (
    <div className="page">
      <div className="first-run">
        <div className="first-run-logo">T</div>
        <h1 className="first-run-title">欢迎使用 TVBox Desktop</h1>
        <p className="first-run-desc">
          这是一个纯白极简的 Windows 影视聚合客户端。软件本身不提供任何内容，
          请先添加一个 JSON 配置源（订阅地址或本地配置文件），之后即可聚合搜索、多线路选集播放。
        </p>
        <div className="first-run-actions">
          <NavLink to="/settings" className="btn btn-primary">
            前往添加配置源
          </NavLink>
          <NavLink to="/sites" className="btn">
            查看影视源
          </NavLink>
        </div>

        {presets.length ? (
          <div className="first-run-presets">
            <div className="first-run-presets-title">或者一键添加内置推荐订阅</div>
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
                  className="btn btn-sm btn-primary"
                  disabled={busy === preset.id}
                  onClick={async () => {
                    setBusy(preset.id)
                    await addPreset(preset.id)
                    setBusy('')
                  }}
                >
                  {busy === preset.id ? <span className="spin" /> : <Icon name="plus" size={13} />}
                  添加
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div className="first-run-steps">
          <div className="first-run-step">
            <span className="first-run-num">1</span>
            <div>
              <b>添加配置源</b>
              <div className="text-3 fs-12">填入订阅 URL，或选择一个本地 .json 配置文件</div>
            </div>
          </div>
          <div className="first-run-step">
            <span className="first-run-num">2</span>
            <div>
              <b>启用影视源</b>
              <div className="text-3 fs-12">在「影视源」页测试连通性，关掉速度慢或失效的站点</div>
            </div>
          </div>
          <div className="first-run-step">
            <span className="first-run-num">3</span>
            <div>
              <b>搜索并播放</b>
              <div className="text-3 fs-12">顶部搜索框回车即可同时查询全部站点</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
