import type { PlayerInfo } from '@shared/types'
import {
  defaultPlayerPreference,
  detectPlatformPlayers,
  isPlayerPathAvailable,
  openPlatformPlayer,
  playerInfoForPath
} from '../platform/externalPlayer'
import { getSettings } from './settings'

/**
 * 外部播放器业务编排。
 *
 * 操作系统差异全部放在 platform/externalPlayer.ts；这里仅负责设置读取、偏好排序、
 * 播放地址校验和 IPC 返回结果，确保 Windows 与 macOS 共享同一套业务语义。
 */

export const DEFAULT_PREFER = defaultPlayerPreference()

function rankPlayers(players: PlayerInfo[], prefer: string[]): PlayerInfo[] {
  const rank = (info: PlayerInfo): number => {
    const index = prefer.indexOf(info.name)
    return index < 0 ? prefer.length : index
  }
  return [...players].sort((a, b) => rank(a) - rank(b))
}

export async function detectPlayers(): Promise<PlayerInfo[]> {
  const settings = await getSettings()
  const prefer = settings.externalPlayer.prefer?.length
    ? settings.externalPlayer.prefer
    : defaultPlayerPreference()
  const found = rankPlayers(await detectPlatformPlayers(), prefer)

  const manual = settings.externalPlayer.command?.trim()
  if (manual && isPlayerPathAvailable(manual) && !found.some((item) => item.path === manual)) {
    const info = playerInfoForPath(manual)
    if (info) found.unshift(info)
  }
  return found
}

async function resolvePlayer(): Promise<PlayerInfo | null> {
  const settings = await getSettings()
  const manual = settings.externalPlayer.command?.trim()
  if (manual) {
    const info = playerInfoForPath(manual)
    if (info) return info
    throw new Error(`设置里指定的播放器不存在：${manual}`)
  }
  return (await detectPlayers())[0] ?? null
}

export interface OpenPlayerResult {
  player: string
  args: string[]
}

/** 调用外部播放器打开一个地址。 */
export async function openInPlayer(rawUrl: string, title = ''): Promise<OpenPlayerResult> {
  const url = (rawUrl ?? '').trim()
  if (!/^(https?|rtmp|rtsp|file):/i.test(url)) {
    throw new Error('播放地址不是受支持的协议')
  }
  const player = await resolvePlayer()
  if (!player) {
    throw new Error('没有找到可用的外部播放器，请在「设置」里手动指定播放器路径')
  }

  const settings = await getSettings()
  const template = settings.externalPlayer.args?.length
    ? settings.externalPlayer.args
    : ['{url}']
  const args = template.map((arg) =>
    arg.replace(/\{url\}/gi, url).replace(/\{title\}/gi, title || '')
  )

  openPlatformPlayer(player.path, args, player.kind)
  return { player: player.path, args }
}
