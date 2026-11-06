import { dirname, join, resolve } from 'node:path'

export interface DataDirOptions {
  platform: NodeJS.Platform
  isPackaged: boolean
  appPath: string
  executablePath: string
  userDataPath: string
  overridePath?: string
}

/**
 * 计算应用运行期数据根目录。
 *
 * Windows 继续保留便携版语义；macOS 打包后必须使用 userData，不能把 JSON
 * 写进 .app 包，否则拖拽安装后的应用包通常不可写且升级时会被整体替换。
 * TVBOX_DATA_DIR 只作为开发、测试和高级用户的显式覆盖入口。
 */
export function resolveDataDir(options: DataDirOptions): string {
  const override = options.overridePath?.trim()
  if (override) return resolve(override)

  if (!options.isPackaged) return resolve(join(options.appPath, 'data'))

  if (options.platform === 'darwin') return resolve(options.userDataPath)

  if (options.platform === 'win32') {
    return resolve(join(dirname(options.executablePath), 'data'))
  }

  return resolve(options.userDataPath)
}

export function resolveSessionDir(dataDir: string): string {
  return join(dataDir, 'session')
}
