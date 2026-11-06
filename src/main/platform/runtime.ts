export type DesktopPlatform = 'windows' | 'macos' | 'linux' | 'unknown'

export interface RuntimeDescriptor {
  platform: NodeJS.Platform
  platformId: DesktopPlatform
  arch: string
  nativeArm64: boolean
}

export function platformId(platform: NodeJS.Platform = process.platform): DesktopPlatform {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  if (platform === 'linux') return 'linux'
  return 'unknown'
}

export function describeRuntime(
  platform: NodeJS.Platform = process.platform,
  arch = process.arch
): RuntimeDescriptor {
  return {
    platform,
    platformId: platformId(platform),
    arch,
    nativeArm64: platform === 'darwin' && arch === 'arm64'
  }
}

/** 应用身份由各平台的安装/签名机制管理；只有 Windows 需要显式设置 AppUserModelId。 */
export function configureApplicationIdentity(setAppUserModelId: (id: string) => void): void {
  if (process.platform === 'win32') setAppUserModelId('com.tvbox.desktop')
}
