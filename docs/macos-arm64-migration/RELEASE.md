# macOS arm64 构建、签名与迁移验收

本文记录 macOS Apple Silicon 版本的可重复发布流程。仓库本身不保存证书、API Key、用户数据或 notarization 凭据。

## 本地开发与未签名验证

在 Apple Silicon macOS 上执行：

```bash
npm ci
npm run typecheck
npm run build
npm run build:mac:arm64
file "release/mac-arm64/TVBox Desktop.app/Contents/MacOS/TVBox Desktop"
```

最后一条必须包含 `arm64`。构建会产生：

- `release/TVBox Desktop-<version>-arm64.dmg`
- `release/TVBox Desktop-<version>-arm64-mac.zip`
- `release/mac-arm64/TVBox Desktop.app`

未配置 Developer ID 时，electron-builder 会生成未签名的开发包；这只能用于本机和测试分发，不能作为面向普通用户的正式发布包。

## 正式签名与公证

正式发布机器或 GitHub Actions runner 需要具备：

1. Apple Developer Program 团队资格。
2. `Developer ID Application` 证书及私钥，导入临时钥匙串。
3. App Store Connect API Key（推荐）或 Apple ID 应用专用密码。
4. 仅存放在 CI Secret / 临时钥匙串中的密码和凭据。

electron-builder 通过环境变量自动启用签名与公证。推荐使用 App Store Connect API Key：

```text
CSC_LINK                 # 证书文件或 base64 内容
CSC_KEY_PASSWORD         # 证书密码
APPLE_API_KEY            # .p8 文件路径或内容
APPLE_API_KEY_ID
APPLE_API_ISSUER
```

也可以使用 Apple ID 方式：

```text
APPLE_ID
APPLE_APP_SPECIFIC_PASSWORD
APPLE_TEAM_ID
```

签名发布前应移除 `CSC_IDENTITY_AUTO_DISCOVERY=false`，并在干净的 Apple Silicon 机器上执行：

```bash
npm run build:mac:arm64
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/TVBox Desktop.app"
spctl --assess --type execute --verbose=4 "release/mac-arm64/TVBox Desktop.app"
xcrun stapler validate "release/mac-arm64/TVBox Desktop.app"
shasum -a 256 release/* > release/SHA256SUMS.txt
```

没有签名身份时不要使用 `identity: "-"` 冒充正式签名；ad-hoc 签名和公证不等价，且 hardened runtime 还需要额外 entitlement。

## GitHub Actions

`.github/workflows/desktop-build.yml` 在 `macos-14` 上执行 arm64 类型检查、端到端自检、DMG/ZIP 构建和 SHA-256 产物校验，同时在 Windows runner 上执行 x64 构建回归。没有配置证书的 CI 产物明确标记为 unsigned artifact。

正式发布时，将上面的凭据配置为仓库或环境级 Secret，并只在受保护的 release/tag job 中注入；不要把 secret 写入 workflow 日志、`.env` 或构建产物。

## Windows → macOS 数据迁移验收

1. Windows 端在「设置 → 数据迁移」导出 ZIP。
2. macOS 端导入 ZIP，确认 manifest、白名单、JSON 和 SHA-256 校验通过。
3. 确认配置源、站点开关、设置、收藏、观看历史和解析接口数量一致。
4. 确认 Windows 的 `.exe` 播放器路径不会在 macOS 上执行，会恢复为 macOS 播放器探测；本地文件绝对路径只保留记录，不假设两台机器目录相同。
5. 确认导入前数据目录生成备份，应用重启后数据仍存在。

数据包包含设置里的 API Key，测试完成后应删除临时副本。导入不会携带 Chromium session、Cookie、缓存和日志。
