import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useApp } from '@/store/useApp'
import { Icon } from './icons'

export function TopBar(): JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const info = useApp((s) => s.info)
  const syncAll = useApp((s) => s.syncAll)
  const syncing = useApp((s) => s.syncing)

  const [keyword, setKeyword] = useState('')
  const busy = Object.keys(syncing).length > 0

  // 从搜索页返回时把关键词带回输入框
  useEffect(() => {
    if (location.pathname === '/search') {
      const wd = new URLSearchParams(location.search).get('wd') ?? ''
      setKeyword(wd)
    }
  }, [location])

  function submit(): void {
    const wd = keyword.trim()
    if (!wd) return
    navigate(`/search?wd=${encodeURIComponent(wd)}`)
  }

  return (
    <header className="topbar">
      <div className="search-box">
        <span className="search-icon">
          <Icon name="search" size={15} />
        </span>
        <input
          value={keyword}
          placeholder="搜索影片、剧集、动漫…（回车聚合全部站点）"
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
      </div>

      <div className="topbar-spacer" />

      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={busy}
        onClick={() => void syncAll()}
        title="重新拉取所有已启用的配置源"
      >
        {busy ? <span className="spin" /> : <Icon name="refresh" size={14} />} 同步配置
      </button>

      <span className="tag tag-outline mono" title={`用户数据目录：${info?.userData ?? ''}`}>
        v{info?.version ?? '0.1.0'}
      </span>
    </header>
  )
}
