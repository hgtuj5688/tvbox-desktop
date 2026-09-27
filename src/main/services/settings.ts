import type { AppSettings } from '@shared/types'
import { DEFAULT_UA } from './http'
import { readStore, writeStore } from './store'

const NAME = 'settings'

export const DEFAULT_SETTINGS: AppSettings = {
  concurrency: 8,
  timeout: 20,
  userAgent: DEFAULT_UA,
  accent: '#2563EB',
  density: 'compact',
  sidebarCollapsed: false,
  // 采集站里「XX解说 / 一口气看完」这类二创短片和正片同名同封面，默认挡掉
  filterCommentary: true,
  externalPlayer: { command: '', args: ['{url}'], prefer: ['PotPlayer', 'mpv', 'VLC'] },
  window: { width: 1440, height: 900 },
  // API Key 默认留空：没填之前「AI 总结本集」按钮会提示去设置页填
  ai: { apiKey: '', model: 'deepseek-flash', baseUrl: '' }
}

export async function getSettings(): Promise<AppSettings> {
  const stored = await readStore<Partial<AppSettings>>(NAME, {})
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    externalPlayer: { ...DEFAULT_SETTINGS.externalPlayer, ...(stored.externalPlayer ?? {}) },
    window: { ...DEFAULT_SETTINGS.window, ...(stored.window ?? {}) },
    ai: { ...DEFAULT_SETTINGS.ai, ...(stored.ai ?? {}) }
  }
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...(await getSettings()), ...patch }
  writeStore(NAME, next)
  return next
}
