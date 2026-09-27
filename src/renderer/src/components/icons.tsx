/**
 * 单色线性图标集。
 *
 * 全部用 currentColor 描边，因此跟随所在容器的文字颜色走——侧栏激活项会自动变成强调色，
 * 不需要为每个状态各准备一套图标。统一 24×24 视窗、1.6 线宽、圆头圆角。
 */

export type IconName =
  | 'home'
  | 'search'
  | 'live'
  | 'star'
  | 'layers'
  | 'settings'
  | 'chevron-left'
  | 'chevron-right'
  | 'refresh'
  | 'plus'
  | 'trash'
  | 'pencil'
  | 'check'
  | 'close'
  | 'play'
  | 'external'
  | 'link'
  | 'file'
  | 'folder'
  | 'alert'
  | 'info'
  | 'clock'
  | 'download'
  | 'filter'
  | 'screen-off'
  | 'monitor'
  | 'grid'
  | 'sparkle'

const PATHS: Record<IconName, JSX.Element> = {
  home: (
    <>
      <path d="m3 9.5 9-7 9 7V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9.5 22v-9h5v9" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20.5 20.5-4.2-4.2" />
    </>
  ),
  live: (
    <>
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="m16.5 2.5-4.5 4.5-4.5-4.5" />
    </>
  ),
  star: <path d="m12 2.8 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.6l-5.8 3.1 1.1-6.5L2.6 9.6l6.5-.9z" />,
  layers: (
    <>
      <path d="m12 2.5 9.5 5-9.5 5-9.5-5z" />
      <path d="m2.5 12.5 9.5 5 9.5-5" />
      <path d="m2.5 17 9.5 5 9.5-5" />
    </>
  ),
  settings: (
    <>
      <path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3" />
      <path d="M14 2v4M8 10v4M16 18v4" />
    </>
  ),
  'chevron-left': <path d="m15 18-6-6 6-6" />,
  'chevron-right': <path d="m9 18 6-6-6-6" />,
  refresh: (
    <>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" />
      <path d="M20.5 3.5V10h-6.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  trash: (
    <>
      <path d="M3.5 6h17" />
      <path d="M8.5 6V3.5h7V6" />
      <path d="M5.5 6l1 15h11l1-15" />
      <path d="M10 10.5v6M14 10.5v6" />
    </>
  ),
  pencil: (
    <>
      <path d="M20.6 7.4a2.6 2.6 0 0 0-3.7-3.7L3.5 17v3.5H7z" />
      <path d="m16 4.5 3.5 3.5" />
    </>
  ),
  check: <path d="m4.5 12.5 5 5 10-11" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  play: <path d="M6.5 3.5 20 12 6.5 20.5z" />,
  external: (
    <>
      <path d="M14 3.5h6.5V10" />
      <path d="M20.5 3.5 11 13" />
      <path d="M18.5 14v4.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4.5" />
    </>
  ),
  link: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z" />
    </>
  ),
  file: (
    <>
      <path d="M14 2.5H7a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5z" />
      <path d="M14 2.5v5h5" />
    </>
  ),
  folder: (
    <>
      <path d="M3 6.5a2 2 0 0 1 2-2h3.5l2 2.5H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3 2.5 20h19z" />
      <path d="M12 9.5v4.5M12 17.5v.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.5v.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6.5V12l3.5 2" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4.5 20.5h15" />
    </>
  ),
  filter: <path d="M3 5h18l-7 8v6l-4-2v-4z" />,
  grid: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </>
  ),
  'screen-off': (
    <>
      <path d="M3.5 4.5h17v12h-17z" />
      <path d="M8 20.5h8M12 16.5v4" />
      <path d="m3 2 18 18" />
    </>
  ),
  monitor: (
    <>
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path d="M8.5 21h7M12 17v4" />
    </>
  ),
  // AI 相关：一颗四角星，和别的线性图标一个粗细
  sparkle: (
    <>
      <path d="M11 3.2 12.8 8.7 18.3 10.5 12.8 12.3 11 17.8 9.2 12.3 3.7 10.5 9.2 8.7z" />
      <path d="M17.6 14.6 18.5 17.2 21.1 18.1 18.5 19 17.6 21.6 16.7 19 14.1 18.1 16.7 17.2z" />
    </>
  )
}

interface IconProps {
  name: IconName
  /** 边长，默认 18px（侧栏与按钮的常见尺寸） */
  size?: number
  className?: string
  strokeWidth?: number
}

export function Icon({ name, size = 18, className, strokeWidth = 1.6 }: IconProps): JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flex: '0 0 auto' }}
    >
      {PATHS[name]}
    </svg>
  )
}
