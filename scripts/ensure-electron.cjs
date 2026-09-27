/**
 * 确保 Electron 二进制已下载。
 *
 * 背景：npm 默认从 GitHub Releases 拉取 Electron 二进制，国内网络极易中断
 * （表现为 `Error: Electron uninstall` 或 `TypeError: terminated`）。
 * 这里统一走 npmmirror 镜像，并且只在缺少二进制时才触发下载。
 *
 * 想换镜像：设置环境变量 ELECTRON_MIRROR 后再执行 npm install。
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const electronDir = path.join(root, 'node_modules', 'electron')
const marker = path.join(electronDir, 'path.txt')

if (!fs.existsSync(electronDir)) {
  // 还没装 electron（比如只装了运行依赖），什么都不用做
  process.exit(0)
}

if (fs.existsSync(marker)) {
  process.exit(0)
}

const mirror = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'
console.log(`[ensure-electron] 缺少 Electron 二进制，正在通过 ${mirror} 下载…`)

try {
  execFileSync(process.execPath, [path.join(electronDir, 'install.js')], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_MIRROR: mirror }
  })
  console.log('[ensure-electron] 完成')
} catch {
  console.error(
    '[ensure-electron] 下载失败。请设置 ELECTRON_MIRROR 指向可用镜像后重试，例如：\n' +
      '  $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; npm install'
  )
  process.exit(1)
}
