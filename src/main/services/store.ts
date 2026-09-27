import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/**
 * 极简 JSON 文件存储：内存缓存 + 防抖落盘。
 * 不引入原生数据库模块，保证 clone 下来就能跑。
 */

const memory = new Map<string, unknown>()
const dirty = new Set<string>()
const timers = new Map<string, NodeJS.Timeout>()
const DEBOUNCE_MS = 200

function fileOf(name: string): string {
  return join(app.getPath('userData'), `${name}.json`)
}

export async function readStore<T>(name: string, fallback: T): Promise<T> {
  if (memory.has(name)) return memory.get(name) as T
  try {
    const text = await fs.readFile(fileOf(name), 'utf-8')
    const data = JSON.parse(text) as T
    memory.set(name, data)
    return data
  } catch {
    memory.set(name, fallback)
    return fallback
  }
}

export function writeStore<T>(name: string, data: T): void {
  memory.set(name, data)
  dirty.add(name)
  const old = timers.get(name)
  if (old) clearTimeout(old)
  timers.set(
    name,
    setTimeout(() => {
      void flushStore(name)
    }, DEBOUNCE_MS)
  )
}

export async function flushStore(name?: string): Promise<void> {
  const names = name ? [name] : [...dirty]
  await Promise.all(
    names.map(async (n) => {
      if (!dirty.has(n)) return
      dirty.delete(n)
      const t = timers.get(n)
      if (t) {
        clearTimeout(t)
        timers.delete(n)
      }
      try {
        await fs.mkdir(app.getPath('userData'), { recursive: true })
        const tmp = `${fileOf(n)}.tmp`
        await fs.writeFile(tmp, JSON.stringify(memory.get(n), null, 2), 'utf-8')
        await fs.rename(tmp, fileOf(n))
      } catch (err) {
        console.error(`[store] 写入 ${n}.json 失败`, err)
      }
    })
  )
}

/** 供调试与「打开数据目录」使用 */
export function storePath(name: string): string {
  return fileOf(name)
}
