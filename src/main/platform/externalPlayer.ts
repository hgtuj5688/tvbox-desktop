import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { PlayerInfo } from '@shared/types'

export type PlayerKind = NonNullable<PlayerInfo['kind']>

interface Candidate {
  name: string
  paths: string[]
  kind: PlayerKind
  bundleId?: string
}

export function defaultPlayerPreference(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') return ['IINA', 'mpv', 'VLC']
  if (platform === 'win32') {
    return ['PotPlayer', 'mpv', 'VLC', 'MPC-HC', 'MPC-BE', 'KMPlayer', 'SMPlayer']
  }
  return ['mpv', 'VLC']
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function pathDirs(): string[] {
  return (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)
}

function addIfNew(out: PlayerInfo[], seen: Set<string>, info: PlayerInfo): void {
  const key = pathKey(info.path)
  if (seen.has(key) || !existsSync(info.path)) return
  seen.add(key)
  out.push(info)
}

function firstExisting(candidate: Candidate): PlayerInfo | null {
  const path = candidate.paths.find((item) => existsSync(item))
  if (!path) return null
  return {
    name: candidate.name,
    path,
    kind: candidate.kind,
    bundleId: candidate.bundleId,
    source: 'scan'
  }
}

function windowsProgramFiles(): string[] {
  const out: string[] = []
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'LOCALAPPDATA']) {
    const dir = process.env[key]
    if (dir) out.push(dir)
  }
  const local = process.env['LOCALAPPDATA']
  if (local) out.push(join(local, 'Programs'))
  return out
}

function windowsCandidates(): Candidate[] {
  const roots = windowsProgramFiles()
  const under = (...parts: string[]): string[] => roots.map((root) => join(root, ...parts))
  const onPath = (exe: string): string[] => pathDirs().map((dir) => join(dir, exe))

  return [
    {
      name: 'PotPlayer',
      kind: 'binary',
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
      kind: 'binary',
      paths: [
        ...under('mpv', 'mpv.exe'),
        ...under('mpv-player', 'mpv.exe'),
        ...under('mpv.net', 'mpvnet.exe'),
        ...onPath('mpv.exe')
      ]
    },
    {
      name: 'VLC',
      kind: 'binary',
      paths: [...under('VideoLAN', 'VLC', 'vlc.exe'), ...onPath('vlc.exe')]
    },
    {
      name: 'MPC-HC',
      kind: 'binary',
      paths: [
        ...under('MPC-HC', 'mpc-hc64.exe'),
        ...under('MPC-HC64', 'mpc-hc64.exe'),
        ...under('K-Lite Codec Pack', 'MPC-HC64', 'mpc-hc64.exe'),
        ...onPath('mpc-hc64.exe')
      ]
    },
    {
      name: 'MPC-BE',
      kind: 'binary',
      paths: [...under('MPC-BE x64', 'mpc-be64.exe'), ...onPath('mpc-be64.exe')]
    },
    {
      name: 'KMPlayer',
      kind: 'binary',
      paths: [
        ...under('The KMPlayer', 'KMPlayer64.exe'),
        ...under('KMPlayer', 'KMPlayer.exe'),
        ...onPath('KMPlayer64.exe')
      ]
    },
    {
      name: 'SMPlayer',
      kind: 'binary',
      paths: [...under('SMPlayer', 'smplayer.exe'), ...onPath('smplayer.exe')]
    }
  ]
}

function queryMacApplications(query: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/mdfind',
      [query],
      { timeout: 4000, maxBuffer: 512 * 1024 },
      (err, stdout) => {
        if (err) return resolve([])
        resolve(
          String(stdout ?? '')
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean)
        )
      }
    )
  })
}

async function macCandidates(): Promise<Candidate[]> {
  const appRoots = ['/Applications', join(homedir(), 'Applications')]
  const definitions = [
    {
      name: 'IINA',
      bundleId: 'com.colliderli.iina',
      appName: 'IINA.app',
      binaries: ['iina-cli', 'iina']
    },
    {
      name: 'VLC',
      bundleId: 'org.videolan.vlc',
      appName: 'VLC.app',
      binaries: ['vlc']
    },
    {
      name: 'mpv',
      bundleId: 'io.mpv',
      appName: 'mpv.app',
      binaries: ['mpv']
    }
  ]

  const groups = await Promise.all(
    definitions.map(async (definition): Promise<Candidate[]> => {
      const indexed = await queryMacApplications(
        `kMDItemCFBundleIdentifier == "${definition.bundleId}"cd`
      )
      const apps = appRoots.map((root) => join(root, definition.appName))
      const binaries = definition.binaries.flatMap((binary) =>
        pathDirs().map((dir) => join(dir, binary))
      )
      return [
        {
          name: definition.name,
          kind: 'app',
          bundleId: definition.bundleId,
          paths: [...apps, ...indexed]
        },
        { name: definition.name, kind: 'binary', paths: binaries }
      ]
    })
  )
  return groups.flat()
}

async function detectWindowsPlayers(): Promise<PlayerInfo[]> {
  const found: PlayerInfo[] = []
  const seen = new Set<string>()
  for (const candidate of windowsCandidates()) {
    const info = firstExisting(candidate)
    if (info) addIfNew(found, seen, info)
  }

  // 系统文件关联只在 Windows adapter 内调用，macOS/Linux 不会触发 reg.exe。
  try {
    for (const info of await playersFromWindowsRegistry()) addIfNew(found, seen, info)
  } catch {
    // 注册表不可读时保留路径扫描结果
  }
  return found
}

async function detectMacPlayers(): Promise<PlayerInfo[]> {
  const found: PlayerInfo[] = []
  const seen = new Set<string>()
  for (const candidate of await macCandidates()) {
    // 同一播放器同时安装 App 和 CLI 时优先返回 App；用户仍可手动填写 CLI 路径。
    if (found.some((item) => item.name === candidate.name)) continue
    const info = firstExisting(candidate)
    if (info) addIfNew(found, seen, info)
  }
  return found
}

export async function detectPlatformPlayers(): Promise<PlayerInfo[]> {
  if (process.platform === 'win32') return detectWindowsPlayers()
  if (process.platform === 'darwin') return detectMacPlayers()
  return []
}

export function playerInfoForPath(path: string): PlayerInfo | null {
  const value = path.trim()
  if (!value || !existsSync(value)) return null
  const kind: PlayerKind = /\.app$/i.test(value) ? 'app' : 'binary'
  return { name: '设置里指定的', path: value, kind, source: 'manual' }
}

export function isPlayerPathAvailable(path: string): boolean {
  return Boolean(path.trim()) && existsSync(path.trim())
}

export function openPlatformPlayer(command: string, args: string[], kind?: PlayerKind): void {
  const isMacApp = process.platform === 'darwin' && (kind === 'app' || /\.app$/i.test(command))
  const executable = isMacApp ? '/usr/bin/open' : command
  const executableArgs = isMacApp ? ['-a', command, '--args', ...args] : args
  const child = spawn(executable, executableArgs, { detached: true, stdio: 'ignore' })
  child.unref()
}

/* ------------------------------------------------------------------ *
 * Windows 文件关联：绿色版 / 装在奇怪目录里的播放器扫不到，但用户多半把它
 * 设成了 .mkv / .mp4 的默认打开方式，问一下注册表就能知道。
 * ------------------------------------------------------------------ */

const ASSOC_EXTS = ['.mkv', '.mp4', '.ts', '.flv']
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

function regValue(out: string): string {
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/)
    if (m) return m[1].trim()
  }
  return ''
}

function exeOf(command: string): string {
  const trimmed = command.trim()
  if (!trimmed) return ''
  const quoted = trimmed.match(/^"([^"]+)"/)
  const raw = quoted ? quoted[1] : trimmed.split(/\s+/)[0]
  return /\.exe$/i.test(raw) ? raw : ''
}

async function playersFromWindowsRegistry(): Promise<PlayerInfo[]> {
  const out: PlayerInfo[] = []
  const seen = new Set<string>()

  for (const ext of ASSOC_EXTS) {
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
    const key = exe.toLowerCase()
    if (!exe || seen.has(key) || !existsSync(exe)) continue
    seen.add(key)

    const name = progId.replace(/\.[a-z0-9]+$/i, '').slice(0, 40) || '系统默认'
    out.push({ name, path: exe, kind: 'binary', source: 'registry' })
  }
  return out
}
