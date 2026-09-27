import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PlayerInfo } from '@shared/types'
import { getSettings } from './settings'

/**
 * 外部播放器接入。
 * 桌面端不内置解码器，遇到浏览器播不了的格式（mkv/ts/HEVC）时，
 * 把地址交给本机已安装的播放器是最省事也最稳的做法。
 */

interface Candidate {
  name: string
  paths: string[]
}

function programFiles(): string[] {
  const out: string[] = []
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'LOCALAPPDATA']) {
    const dir = process.env[key]
    if (dir) out.push(dir)
  }
  const local = process.env['LOCALAPPDATA']
  if (local) out.push(join(local, 'Programs'))
  return out
}

/** PATH 里能直接找到的（绿色版 mpv / VLC 常常是这么装的） */
function pathDirs(): string[] {
  return (process.env['PATH'] ?? '').split(';').filter(Boolean)
}

function candidates(): Candidate[] {
  const roots = programFiles()
  const under = (...parts: string[]): string[] =>
    roots.map((root) => join(root, ...parts))
  const onPath = (exe: string): string[] => pathDirs().map((dir) => join(dir, exe))

  return [
    {
      name: 'PotPlayer',
      paths: [
        ...under('DAUM', 'PotPlayer', 'PotPlayerMini64.exe'),
        ...under('DAUM', 'PotPlayer', 'PotPlayerMini.exe'),
        ...under('PotPlayer', 'PotPlayerMini64.exe'),
        ...under('PotPlayer', 'PotPlayerMini.exe'),
        ...onPath('PotPlayerMini64.exe')
      ]
    },
    {
      name: 'mpv',
      paths: [
        ...under('mpv', 'mpv.exe'),
        ...under('mpv-player', 'mpv.exe'),
        ...under('mpv.net', 'mpvnet.exe'),
        ...onPath('mpv.exe')
      ]
    },
    {
      name: 'VLC',
      paths: [...under('VideoLAN', 'VLC', 'vlc.exe'), ...onPath('vlc.exe')]
    },
    {
      name: 'MPC-HC',
      paths: [
        ...under('MPC-HC', 'mpc-hc64.exe'),
        ...under('MPC-HC64', 'mpc-hc64.exe'),
        ...under('K-Lite Codec Pack', 'MPC-HC64', 'mpc-hc64.exe'),
        ...onPath('mpc-hc64.exe')
      ]
    },
    {
      name: 'MPC-BE',
      paths: [...under('MPC-BE x64', 'mpc-be64.exe'), ...onPath('mpc-be64.exe')]
    },
    {
      name: 'KMPlayer',
      paths: [
        ...under('The KMPlayer', 'KMPlayer64.exe'),
        ...under('KMPlayer', 'KMPlayer.exe'),
        ...onPath('KMPlayer64.exe')
      ]
    },
    {
      name: 'SMPlayer',
      paths: [...under('SMPlayer', 'smplayer.exe'), ...onPath('smplayer.exe')]
    }
  ]
}

/** 默认偏好顺序。用户没在设置里写 prefer 时用它 */
export const DEFAULT_PREFER = [
  'PotPlayer',
  'mpv',
  'VLC',
  'MPC-HC',
  'MPC-BE',
  'KMPlayer',
  'SMPlayer'
]

/* ------------------------------------------------------------------ *
 * 系统文件关联：绿色版 / 装在奇怪目录里的播放器扫不到，但用户多半把它
 * 设成了 .mkv / .mp4 的默认打开方式，问一下注册表就能知道。
 * ------------------------------------------------------------------ */

const ASSOC_EXTS = ['.mkv', '.mp4', '.ts', '.flv']

/** 这些 ProgId 就算被设成默认也不是「播放器」，别往列表里塞 */
const NOT_A_PLAYER =
  /^(mse?edge|chrome|chromium|firefox|brave|opera|quark|vivaldi|360|sogou|qqbrowser|notepad|code|explorer|photos|mspaint|acdsee|wmp11\.assocfile)/i

function regQuery(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'reg',
      args,
      { windowsHide: true, timeout: 4000, maxBuffer: 512 * 1024 },
      (err, stdout) => resolve(err ? '' : String(stdout ?? ''))
    )
  })
}

/** 从 `reg query` 的输出里取第一个 REG_SZ / REG_EXPAND_SZ 的值 */
function regValue(out: string): string {
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/)
    if (m) return m[1].trim()
  }
  return ''
}

/** 命令行 `"C:\a\b.exe" "%1"` → `C:\a\b.exe`；解析不出来返回空串 */
function exeOf(command: string): string {
  const trimmed = command.trim()
  if (!trimmed) return ''
  const quoted = trimmed.match(/^"([^"]+)"/)
  const raw = quoted ? quoted[1] : trimmed.split(/\s+/)[0]
  return /\.exe$/i.test(raw) ? raw : ''
}

async function fromRegistry(): Promise<PlayerInfo[]> {
  const out: PlayerInfo[] = []
  const seen = new Set<string>()

  for (const ext of ASSOC_EXTS) {
    // 用户改过默认就用 UserChoice，没改过就退回 .ext 的默认值
    let progId = regValue(
      await regQuery([
        'query',
        `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\UserChoice`,
        '/v',
        'ProgId'
      ])
    )
    if (!progId) {
      progId =
        regValue(await regQuery(['query', `HKCU\\Software\\Classes\\${ext}`, '/ve'])) ||
        regValue(await regQuery(['query', `HKLM\\Software\\Classes\\${ext}`, '/ve']))
    }
    if (!progId || NOT_A_PLAYER.test(progId)) continue

    let command = await regQuery(['query', `HKCU\\Software\\Classes\\${progId}\\shell\\open\\command`, '/ve'])
    if (!regValue(command)) {
      command = await regQuery(['query', `HKLM\\Software\\Classes\\${progId}\\shell\\open\\command`, '/ve'])
    }
    const exe = exeOf(regValue(command))
    if (!exe || seen.has(exe.toLowerCase()) || !existsSync(exe)) continue
    seen.add(exe.toLowerCase())

    // ProgId 形如 `PotPlayer64.mkv`，去掉扩展名后缀当显示名
    const name = progId.replace(/\.[a-z0-9]+$/i, '').slice(0, 40) || '系统默认'
    out.push({ name, path: exe, source: 'registry' })
  }
  return out
}

/** 扫描本机常见安装路径，按用户设置的偏好排序 */
export async function detectPlayers(): Promise<PlayerInfo[]> {
  const settings = await getSettings()
  const prefer = settings.externalPlayer.prefer?.length
    ? settings.externalPlayer.prefer
    : DEFAULT_PREFER
  const found: PlayerInfo[] = []
  const seen = new Set<string>()

  for (const candidate of candidates()) {
    for (const path of candidate.paths) {
      if (seen.has(path) || !existsSync(path)) continue
      seen.add(path)
      found.push({ name: candidate.name, path, source: 'scan' })
      break
    }
  }

  const rank = (info: PlayerInfo): number => {
    const i = prefer.indexOf(info.name)
    return i < 0 ? prefer.length : i
  }
  found.sort((a, b) => rank(a) - rank(b))

  // 认识的播放器排前面，系统关联里翻出来的排后面
  try {
    const extra = (await fromRegistry()).filter((info) => !seen.has(info.path))
    for (const info of extra) seen.add(info.path)
    found.push(...extra)
  } catch {
    /* 注册表查不动就算了，扫描的结果照样能用 */
  }

  // 设置里手填的那条：扫不到也照样列出来，不然界面上会出现
  // 「一个都没找到」但上面明明配着一个能用的播放器这种别扭局面
  const manual = settings.externalPlayer.command?.trim()
  if (manual && existsSync(manual) && !seen.has(manual)) {
    found.unshift({ name: '设置里指定的', path: manual, source: 'manual' })
  }
  return found
}

/** 用户手动指定的播放器优先，其次按偏好列表在本机找一个 */
export async function resolvePlayer(): Promise<string | null> {
  const settings = await getSettings()
  const manual = settings.externalPlayer.command?.trim()
  if (manual) {
    if (existsSync(manual)) return manual
    throw new Error(`设置里指定的播放器不存在：${manual}`)
  }
  const found = await detectPlayers()
  return found[0]?.path ?? null
}

export interface OpenPlayerResult {
  player: string
  args: string[]
}

/** 调用外部播放器打开一个地址 */
export async function openInPlayer(rawUrl: string, title = ''): Promise<OpenPlayerResult> {
  const url = (rawUrl ?? '').trim()
  if (!/^(https?|rtmp|rtsp|file):/i.test(url)) {
    throw new Error('播放地址不是受支持的协议')
  }
  const command = await resolvePlayer()
  if (!command) {
    throw new Error('没有找到可用的外部播放器，请在「设置」里手动指定播放器路径')
  }

  const settings = await getSettings()
  const template = settings.externalPlayer.args?.length
    ? settings.externalPlayer.args
    : ['{url}']
  const args = template.map((arg) =>
    arg.replace(/\{url\}/gi, url).replace(/\{title\}/gi, title || '')
  )

  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
  return { player: command, args }
}
