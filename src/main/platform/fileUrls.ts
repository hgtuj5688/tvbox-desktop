import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PROTOCOL_RE = /^[a-z][a-z\d+.-]*:\/\//i

export function isFileUrl(value: string): boolean {
  return /^file:/i.test(value.trim())
}

/** 把 file:// URL 或普通本地路径转换成当前平台可读的路径。 */
export function localPathFromUrl(input: string): string {
  const value = input.trim()
  if (!value) throw new Error('本地文件路径为空')

  if (isFileUrl(value)) {
    try {
      return fileURLToPath(new URL(value))
    } catch (err) {
      throw new Error(`无法解析本地文件 URL：${(err as Error).message}`)
    }
  }

  if (PROTOCOL_RE.test(value)) {
    throw new Error(`不是本地文件地址：${value}`)
  }

  return isAbsolute(value) ? value : resolve(value)
}

/** 把本地路径转换为可安全交给 Chromium / Electron 的 file:// URL。 */
export function fileUrlFromPath(input: string): string {
  const value = input.trim()
  if (!value) throw new Error('本地文件路径为空')
  return pathToFileURL(resolve(value)).toString()
}
