import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { fileUrlFromPath, localPathFromUrl } from '../src/main/platform/fileUrls.ts'
import { resolveDataDir, resolveSessionDir } from '../src/main/platform/paths.ts'
import { describeRuntime, platformId } from '../src/main/platform/runtime.ts'

test('开发模式使用项目根 data，TVBOX_DATA_DIR 可以覆盖', () => {
  assert.equal(
    resolveDataDir({
      platform: 'darwin',
      isPackaged: false,
      appPath: '/workspace/tvbox',
      executablePath: '/Applications/TVBox.app/Contents/MacOS/TVBox',
      userDataPath: '/Users/test/Library/Application Support/TVBox Desktop'
    }),
    resolve('/workspace/tvbox/data')
  )
  assert.equal(
    resolveDataDir({
      platform: 'darwin',
      isPackaged: true,
      appPath: '/Applications/TVBox.app/Contents/Resources/app.asar',
      executablePath: '/Applications/TVBox.app/Contents/MacOS/TVBox',
      userDataPath: '/Users/test/Library/Application Support/TVBox Desktop',
      overridePath: '/private/tmp/tvbox-data'
    }),
    resolve('/private/tmp/tvbox-data')
  )
})

test('打包 Windows 与 macOS 使用各自正确的数据根目录', () => {
  assert.equal(
    resolveDataDir({
      platform: 'win32',
      isPackaged: true,
      appPath: '/opt/TVBox/resources/app.asar',
      executablePath: '/opt/TVBox/TVBox Desktop.exe',
      userDataPath: '/Users/test/AppData/Roaming/tvbox-desktop'
    }),
    resolve('/opt/TVBox/data')
  )
  assert.equal(
    resolveDataDir({
      platform: 'darwin',
      isPackaged: true,
      appPath: '/Applications/TVBox.app/Contents/Resources/app.asar',
      executablePath: '/Applications/TVBox.app/Contents/MacOS/TVBox',
      userDataPath: '/Users/test/Library/Application Support/TVBox Desktop'
    }),
    resolve('/Users/test/Library/Application Support/TVBox Desktop')
  )
  const userData = resolve('/Users/test/Library/Application Support/TVBox Desktop')
  assert.equal(resolveSessionDir(userData), resolve(userData, 'session'))
})

test('file URL 往返保留中文、空格、# 和 %', () => {
  const path = resolve('tmp', 'TVBox 数据 #1 100%.m3u8')
  const url = fileUrlFromPath(path)
  assert.match(url, /^file:\/\//)
  assert.equal(localPathFromUrl(url), path)
  assert.throws(() => localPathFromUrl('https://example.com/live.m3u8'), /不是本地文件地址/)
})

test('运行时平台标识与 arm64 能力可判定', () => {
  assert.equal(platformId('darwin'), 'macos')
  assert.equal(platformId('win32'), 'windows')
  assert.equal(describeRuntime('darwin', 'arm64').nativeArm64, true)
  assert.equal(describeRuntime('darwin', 'x64').nativeArm64, false)
})
