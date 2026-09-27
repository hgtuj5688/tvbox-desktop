import { NavLink } from 'react-router-dom'
import { useApp } from '@/store/useApp'
import { Icon, type IconName } from './icons'

interface NavDef {
  to: string
  label: string
  icon: IconName
  count?: number
}

export function Sidebar(): JSX.Element {
  const collapsed = useApp((s) => s.settings?.sidebarCollapsed ?? false)
  const sites = useApp((s) => s.sites)
  const sources = useApp((s) => s.sources)
  const updateSettings = useApp((s) => s.updateSettings)

  const enabledSites = sites.filter((s) => s.enabled && !s.unsupported).length

  const nav: NavDef[] = [
    { to: '/', label: '首页', icon: 'home' },
    { to: '/search', label: '分类浏览', icon: 'grid' },
    { to: '/live', label: '电视直播', icon: 'live' },
    { to: '/library', label: '收藏与历史', icon: 'star' },
    { to: '/sites', label: '影视源', icon: 'layers', count: enabledSites },
    { to: '/settings', label: '设置', icon: 'settings', count: sources.length || undefined }
  ]

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-brand">
        <div className="sidebar-logo">T</div>
        <div className="sidebar-name">TVBox Desktop</div>
      </div>

      <nav className="sidebar-nav">
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            title={item.label}
          >
            <span className="nav-icon">
              <Icon name={item.icon} />
            </span>
            <span className="nav-label">{item.label}</span>
            {item.count ? <span className="nav-count">{item.count}</span> : null}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-foot">
        <button
          type="button"
          className="nav-item"
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          onClick={() => void updateSettings({ sidebarCollapsed: !collapsed })}
        >
          <span className="nav-icon">
            <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} />
          </span>
          <span className="nav-label">收起侧栏</span>
        </button>
      </div>
    </aside>
  )
}
