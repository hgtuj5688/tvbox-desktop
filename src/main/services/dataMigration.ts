import { app } from 'electron'
import { zipSync, strToU8, strFromU8, unzipSync } from 'fflate'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { DataTransferResult } from '@shared/types'
import { defaultPlayerPreference } from '../platform/externalPlayer'
import { flushStore, resetStoreCache, STORE_NAMES } from './store'

const BUNDLE_VERSION = 1
const MANIFEST = 'manifest.json'
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024

interface BundleFile {
  name: string
  size: number
  sha256: string
}

interface BundleManifest {
  format: 'tvbox-desktop-data'
  version: number
  appVersion: string
  sourcePlatform: string
  exportedAt: string
  includesSecrets: boolean
  files: BundleFile[]
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function looksLikeForeignPlayerCommand(command: string): boolean {
  if (process.platform === 'darwin') return /^[a-z]:[\\/]/i.test(command) || /\.exe(?:$|[\\/])/i.test(command)
  if (process.platform === 'win32') return command.startsWith('/') || /\.app(?:$|[\\/])/i.test(command)
  return false
}

/** 导入跨平台设置时，不能把另一套系统的播放器路径和偏好静默带过来。 */
function normalizeImportedBytes(name: string, bytes: Uint8Array, sourcePlatform: string): Uint8Array {
  if (name !== 'settings.json') return bytes
  const settings = JSON.parse(strFromU8(bytes)) as Record<string, unknown>
  const external = settings.externalPlayer
  if (!external || typeof external !== 'object') return bytes

  const player = external as Record<string, unknown>
  const command = typeof player.command === 'string' ? player.command.trim() : ''
  const sourceOs = sourcePlatform.split(/\s+/, 1)[0]
  const platformChanged = sourceOs !== process.platform
  const next = { ...player }
  if (platformChanged || looksLikeForeignPlayerCommand(command)) {
    next.command = ''
    next.prefer = defaultPlayerPreference()
  }
  if (next.command === player.command && next.prefer === player.prefer) return bytes
  settings.externalPlayer = next
  return strToU8(JSON.stringify(settings, null, 2))
}

function isAllowedBundleName(name: string): boolean {
  if (STORE_NAMES.some((store) => name === `${store}.json`)) return true
  return /^presets\/[^/]+\.json$/i.test(name)
}

function safeTarget(root: string, name: string): string {
  if (!isAllowedBundleName(name)) throw new Error(`数据包包含不允许的文件：${name}`)
  const target = resolve(root, ...name.split('/'))
  const prefix = `${resolve(root)}${sep}`
  if (!target.startsWith(prefix)) throw new Error(`数据包路径越界：${name}`)
  return target
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

async function readJsonFile(path: string): Promise<Uint8Array | null> {
  if (!existsSync(path)) return null
  const bytes = await fs.readFile(path)
  JSON.parse(bytes.toString('utf8'))
  return bytes
}

async function collectPresetFiles(root: string): Promise<Array<{ name: string; bytes: Uint8Array }>> {
  const presetRoot = join(root, 'presets')
  if (!(await exists(presetRoot))) return []

  const out: Array<{ name: string; bytes: Uint8Array }> = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const bytes = await readJsonFile(path)
      if (!bytes) continue
      const name = relative(root, path).split(sep).join('/')
      if (!isAllowedBundleName(name)) continue
      out.push({ name, bytes })
    }
  }
  await walk(presetRoot)
  return out
}

async function collectPresetNames(root: string): Promise<string[]> {
  const presetRoot = join(root, 'presets')
  if (!(await exists(presetRoot))) return []
  const entries = await fs.readdir(presetRoot, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => `presets/${entry.name}`)
    .filter(isAllowedBundleName)
}

async function currentTransferNames(root: string): Promise<string[]> {
  const presetNames = await collectPresetNames(root)
  return [...new Set([...STORE_NAMES.map((store) => `${store}.json`), ...presetNames])]
}

async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const temp = `${path}.import-${process.pid}-${Date.now()}.tmp`
  await fs.writeFile(temp, bytes)
  await fs.rename(temp, path)
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
}

export async function exportDataBundle(destination: string): Promise<DataTransferResult> {
  await flushStore()
  const root = app.getPath('userData')
  const entries: Record<string, Uint8Array> = {}
  const files: BundleFile[] = []

  for (const store of STORE_NAMES) {
    const name = `${store}.json`
    const bytes = await readJsonFile(join(root, name))
    if (!bytes) continue
    entries[name] = bytes
    files.push({ name, size: bytes.byteLength, sha256: hash(bytes) })
  }
  for (const item of await collectPresetFiles(root)) {
    entries[item.name] = item.bytes
    files.push({ name: item.name, size: item.bytes.byteLength, sha256: hash(item.bytes) })
  }

  const manifest: BundleManifest = {
    format: 'tvbox-desktop-data',
    version: BUNDLE_VERSION,
    appVersion: app.getVersion(),
    sourcePlatform: `${process.platform} ${process.arch}`,
    exportedAt: new Date().toISOString(),
    includesSecrets: true,
    files: files.sort((a, b) => a.name.localeCompare(b.name))
  }
  entries[MANIFEST] = strToU8(JSON.stringify(manifest, null, 2))

  const zipped = zipSync(entries, { level: 6 })
  await writeAtomic(destination, zipped)
  return {
    path: destination,
    files: files.map((file) => file.name),
    bytes: zipped.byteLength,
    sourcePlatform: manifest.sourcePlatform
  }
}

function parseManifest(bytes: Uint8Array): BundleManifest {
  let raw: unknown
  try {
    raw = JSON.parse(strFromU8(bytes))
  } catch {
    throw new Error('数据包 manifest.json 不是合法 JSON')
  }
  if (!raw || typeof raw !== 'object') throw new Error('数据包 manifest.json 格式不正确')
  const value = raw as Partial<BundleManifest>
  if (value.format !== 'tvbox-desktop-data' || value.version !== BUNDLE_VERSION) {
    throw new Error(`不支持的数据包格式：${String(value.format ?? '未知')} v${String(value.version ?? '?')}`)
  }
  if (typeof value.appVersion !== 'string' || typeof value.sourcePlatform !== 'string') {
    throw new Error('数据包 manifest.json 缺少来源信息')
  }
  if (!Array.isArray(value.files)) throw new Error('数据包缺少文件清单')
  const files = value.files.filter(
    (file): file is BundleFile =>
      Boolean(
        file &&
          typeof file === 'object' &&
          typeof file.name === 'string' &&
          Number.isInteger(file.size) &&
          file.size >= 0 &&
          file.size <= MAX_FILE_BYTES &&
          typeof file.sha256 === 'string' &&
          /^[a-f0-9]{64}$/i.test(file.sha256)
      )
  )
  if (files.length !== value.files.length) throw new Error('数据包文件清单格式不正确')
  return { ...value, files } as BundleManifest
}

async function backupDataRoot(root: string): Promise<string | undefined> {
  if (!(await exists(root))) return undefined
  const backup = `${root}.backup-${stamp()}`
  await fs.cp(root, backup, { recursive: true })
  return backup
}

async function restoreWrittenFiles(root: string, backup: string | undefined, names: string[]): Promise<void> {
  for (const name of names) {
    const target = safeTarget(root, name)
    const old = backup ? safeTarget(backup, name) : ''
    if (old && (await exists(old))) {
      await writeAtomic(target, await fs.readFile(old))
    } else {
      await fs.rm(target, { force: true })
    }
  }
}

export async function importDataBundle(source: string): Promise<DataTransferResult> {
  await flushStore()
  const root = app.getPath('userData')
  const sourceBytes = new Uint8Array(await fs.readFile(source))
  if (sourceBytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error('数据包过大，拒绝导入')
  const archive = unzipSync(sourceBytes)
  const manifestBytes = archive[MANIFEST]
  if (!manifestBytes) throw new Error('数据包缺少 manifest.json')
  const manifest = parseManifest(manifestBytes)
  const listed = new Set<string>()
  const validated = new Map<string, Uint8Array>()
  let uncompressedBytes = manifestBytes.byteLength

  for (const file of manifest.files) {
    if (listed.has(file.name)) throw new Error(`数据包存在重复文件：${file.name}`)
    listed.add(file.name)
    const bytes = archive[file.name]
    if (!bytes) throw new Error(`数据包缺少文件：${file.name}`)
    if (!isAllowedBundleName(file.name)) throw new Error(`数据包包含不允许的文件：${file.name}`)
    if (bytes.byteLength !== file.size || hash(bytes) !== file.sha256.toLowerCase()) {
      throw new Error(`数据包校验失败：${file.name}`)
    }
    JSON.parse(strFromU8(bytes))
    uncompressedBytes += bytes.byteLength
    if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) throw new Error('数据包解压后过大，拒绝导入')
    validated.set(file.name, bytes)
  }

  for (const name of Object.keys(archive)) {
    if (name !== MANIFEST && !listed.has(name)) throw new Error(`数据包包含未列出的文件：${name}`)
  }

  const backupPath = await backupDataRoot(root)
  const existing = await currentTransferNames(root)
  const touched = [...new Set([...existing, ...manifest.files.map((file) => file.name)])]
  try {
    for (const name of existing) {
      if (!listed.has(name)) await fs.rm(safeTarget(root, name), { force: true })
    }
    for (const file of manifest.files) {
      const target = safeTarget(root, file.name)
      await writeAtomic(
        target,
        normalizeImportedBytes(file.name, validated.get(file.name) as Uint8Array, manifest.sourcePlatform)
      )
    }
  } catch (err) {
    await restoreWrittenFiles(root, backupPath, touched)
    resetStoreCache()
    throw new Error(`导入失败，已恢复原数据：${(err as Error).message}`)
  }

  resetStoreCache()
  return {
    path: source,
    files: manifest.files.map((file) => file.name),
    bytes: sourceBytes.byteLength,
    backupPath,
    sourcePlatform: manifest.sourcePlatform
  }
}
