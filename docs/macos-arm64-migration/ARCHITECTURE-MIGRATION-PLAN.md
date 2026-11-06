# TVBox Desktop macOS Apple Silicon（arm64）架构迁移规划

> 状态：规划稿（本阶段只建立迁移边界与实施方案，不修改业务实现）
> 基线：`main` / `04274df`
> 目标：在保留 Windows x64 可用性的前提下，增加 macOS Apple Silicon 原生 arm64 版本

## 1. 目标与结论先行

本次迁移不是把 Windows 的路径和安装包名称替换成 macOS，而是把当前项目中散落的操作系统假设收敛到一层明确的 Platform Adapter，再让 Electron 主进程、业务服务和渲染进程通过稳定接口工作。

最终交付应包含：

1. macOS arm64 开发、构建、打包、签名和验证链路。
2. macOS 原生应用包（`.dmg` + `.zip`），不依赖 Rosetta 运行。
3. macOS 标准数据目录，不能把配置写进只读的 `.app` 包。
4. macOS 外部播放器探测与唤起，支持应用包、命令行播放器和用户手动指定路径。
5. Windows x64 原有功能和安装包不回归。
6. Windows 数据可以通过导出/导入迁移到 macOS，收藏、历史、订阅和设置不丢失。
7. 现有自检、类型检查和构建脚本在 macOS 上可重复执行。

### 推荐的首个发布策略

| 项目 | 首个 macOS 版本的决定 |
|---|---|
| CPU 架构 | 只发布原生 `arm64`，暂不做 Universal 2 |
| 安装格式 | `.dmg` 拖拽安装 + `.zip` 便携分发 |
| Windows | 继续保留 `x64` NSIS + zip |
| 数据目录 | macOS 使用 `app.getPath('userData')`；Windows 保留当前便携 `data` 目录策略 |
| 外部播放器 | 首批支持 IINA、mpv、VLC；保留手动指定播放器路径 |
| 数据迁移 | 新增显式导出/导入，不尝试把 Windows 绝对路径直接当成 macOS 路径 |
| 自动更新 | 不作为本次迁移前置条件，先保证签名包和手动升级可靠 |

## 2. 当前代码基线审计

### 2.1 技术栈与构建现状

- Electron `44.4.5`。
- React `19.3.0`、TypeScript `7.0.2`、Vite `7.3.6`、electron-vite `5.0.0`。
- electron-builder `26.15.3`。
- 主进程、preload、renderer 已有明确分层，IPC 通道集中在 `src/shared/ipc.ts`。
- 业务服务主要使用 Node 标准库、JSON 文件存储和 HTTP 请求，没有必须重编译的数据库或原生 Node addon，这是迁移的有利条件。
- 当前 `electron-builder.yml` 只有 Windows NSIS 与 zip，且只声明 `x64`。
- 当前启动脚本是 `TVBox.cmd`、`TVBox-dev.cmd`、`TVBox-built.cmd`，只能直接在 Windows 命令解释器中使用。

### 2.2 已经具备的跨平台基础

- `app.on('window-all-closed')` 已保留 macOS 的常规行为：`darwin` 不自动退出。
- 窗口创建、IPC、网络、JSON 存储、播放器内嵌播放等大部分逻辑不直接依赖 Windows API。
- `AppInfo` 已输出 `process.platform` 与 `process.arch`，可作为迁移后的诊断信息基础。
- `shell.openExternal()`、`dialog.showOpenDialog()`、Electron session 代理接口理论上可在 macOS 复用，但必须做真机验收。

### 2.3 已确认的 Windows 假设

| 位置 | 当前假设 | 迁移影响 | 优先级 |
|---|---|---|---|
| `electron-builder.yml` | 只有 `win.nsis` / `win.zip`，架构为 `x64` | 无法生成 macOS 包 | P0 |
| `TVBox*.cmd` | 使用 `cmd.exe`、`call`、`%~dp0` | macOS 无法启动 | P0 |
| `src/main/index.ts` | 打包后将数据放到 exe 同级 `data/` | `.app` 内部只读且会破坏签名/升级 | P0 |
| `src/main/services/player.ts` | `.exe`、Program Files、LOCALAPPDATA、注册表、`reg query` | macOS 播放器无法探测或启动 | P0 |
| `player.ts` | `PATH` 用 `;` 分割 | macOS 使用 `:`，会导致 PATH 扫描失败 | P0 |
| `src/main/services/live.ts` | 本地 `file://` 地址通过字符串删除前缀 | macOS 路径、空格、百分号和 file URL 可能解析错误 | P1 |
| `src/main/services/http.ts` | 默认 UA 固定为 Windows Chrome | 不一定阻塞 arm64，但平台语义和可诊断性不一致 | P1 |
| `streamResolve.ts` | 抖音请求参数包含 `browser_platform=Win32` | 这是上游协议兼容字段，不能盲改，需抽成 profile 并验证 | P1 |
| `src/renderer` 文案 | 首页和首次启动文案写死 Windows | macOS 版本体验不完整 | P1 |
| `README.md`、`功能框架.txt` | 安装、数据目录、代理和脚本说明大量写死 Windows | 用户无法按文档完成 macOS 安装/迁移 | P1 |
| `app.setAppUserModelId()` | Windows 应用标识调用未按平台收敛 | 应改为平台适配层或仅 Windows 调用 | P2 |
| `build/` | 只有 PNG 与 ICO | macOS 需要 ICNS 或可被 builder 转换的图标资产 | P0 |

## 3. 迁移边界

### 3.1 本次必须完成

- 平台识别、架构识别、应用路径和数据目录抽象。
- macOS arm64 构建、打包、安装、启动和签名验证。
- macOS 外部播放器检测/打开的实现。
- 本地文件 URL 与路径转换的跨平台实现。
- Windows/macOS 双平台脚本与 CI。
- 数据导出/导入及旧数据兼容策略。
- 文案、README、功能框架和发布说明的双平台更新。
- 现有主要功能在 macOS 上的回归：配置源、站点、搜索、分类、详情、内嵌播放、直播、收藏历史、解析接口和 AI 总结。

### 3.2 本次不做

- 不重写现有 TVBox 配置协议、CMS 解析、搜索合并或播放器业务规则。
- 不删除 Windows 支持，不把所有平台强行统一成 macOS 的目录规则。
- 不引入 SQLite、原生播放器内核或新的 Node 原生 addon。
- 不把第三方内容源、解析接口或平台反爬策略作为迁移范围。
- 不在没有真实 Apple Silicon 机器验证前承诺 Universal 2。
- 不在本阶段强行加入自动更新；如后续加入，另立发布/更新设计。

## 4. 目标架构

### 4.1 分层原则

```text
Renderer（React）
  └─ 只消费稳定的 preload API 与能力描述，不判断文件系统细节

Preload / IPC
  └─ 保持现有 IPC 语义；补充平台能力、数据导入导出和播放器能力字段

Main Services（业务层）
  └─ 搜索、CMS、直播、解析、收藏、AI 等逻辑不直接调用 Windows API

Platform Adapter（新增）
  ├─ app paths / data paths
  ├─ shell / external URL / reveal file
  ├─ external player detection and launch
  ├─ local file URL conversion
  └─ OS-specific lifecycle and release capabilities

Electron / Node Runtime
  └─ process.platform、process.arch、app.getPath、spawn、shell、session
```

### 4.2 建议新增的目录

建议新增以下目录，名称可以在实施时微调，但边界要保持不变：

```text
src/main/platform/
  types.ts              平台适配器、路径、播放器和能力的类型
  detect.ts             platform/arch/runtime 信息
  paths.ts              数据目录、session 目录、导入导出目录
  shell.ts              外部 URL、文件、应用唤起
  fileUrls.ts           file:// 与本地路径互转
  index.ts              根据 process.platform 选择适配器
  windows/
    paths.ts
    externalPlayer.ts
    shell.ts
  macos/
    paths.ts
    externalPlayer.ts
    shell.ts

src/main/services/
  player.ts             保留业务编排，改为调用 platform player adapter
  dataMigration.ts      新增数据导入、导出、版本校验和备份
```

### 4.3 统一的平台接口

建议由主进程持有一个只读的 `PlatformAdapter`：

```ts
interface PlatformAdapter {
  readonly id: 'windows' | 'macos' | 'linux' | 'unknown'
  readonly arch: string
  readonly paths: {
    dataDir: string
    sessionDir: string
    exportDir: string
  }
  readonly capabilities: {
    nativeArm64: boolean
    externalPlayers: boolean
    portableData: boolean
    signedDistribution: boolean
  }
  openExternal(url: string): Promise<void>
  openPath(path: string): Promise<void>
  detectPlayers(): Promise<PlayerInfo[]>
  openPlayer(command: string, args: string[]): Promise<void>
  toLocalPath(urlOrPath: string): string
  toFileUrl(path: string): string
}
```

业务服务只调用这个接口，不在业务代码里继续出现 `ProgramFiles`、`reg query`、`.exe` 或手工拼文件 URL。只有平台适配器内部可以读取 `process.platform`。

## 5. 关键迁移设计

### 5.1 应用数据与可写目录

这是本次迁移的硬性边界。macOS 的应用通常位于 `TVBox Desktop.app`，应用包可能只读、受签名保护，并且升级时会整体替换；任何运行期 JSON 或缓存都不能写进 `.app`。

#### 目标规则

| 运行场景 | Windows | macOS |
|---|---|---|
| 开发模式 | 保留项目根 `data/`，便于调试 | 保留项目根 `data/`，或由 `TVBOX_DATA_DIR` 显式覆盖 |
| 打包运行 | 保留当前 exe 同级 `data/` 的便携策略，失败时回退 `app.getPath('userData')` | 默认使用 `app.getPath('userData')`，不写 `.app` 包 |
| Chromium session | `<dataDir>/session/` | `<dataDir>/session/` |
| 预置文件 | `<dataDir>/presets/` | `<dataDir>/presets/` |
| 临时导入/导出 | 用户选定目录 | 用户选定目录 |

建议把当前 `src/main/index.ts` 顶部的 `DATA_DIR` 和 `redirectUserData()` 收敛为 `resolveDataPaths()`，并在应用 ready 前完成 `app.setPath('userData')` / `app.setPath('sessionData')`。路径决策要有单元测试，不能靠字符串判断操作系统。

#### macOS 数据目录验收

- 启动后 `AppInfo.userData` 指向 macOS 用户可写目录，而不是 `/Applications/TVBox Desktop.app/...`。
- 关闭并重启后，设置、源、站点覆盖、收藏、历史、解析接口和直播体检数据仍然存在。
- 以只读方式放置/运行应用包时，程序仍能启动并写入用户数据目录。
- 迁移或升级不覆盖已有 JSON；写入仍采用现有临时文件 + rename 的原子策略。

### 5.2 Windows → macOS 数据迁移

仅改变运行平台不会让 Windows 的 `data` 自动出现在 Mac 上，因此需要一个显式、可恢复的数据迁移流程。

#### 导出格式

新增一个版本化的导出包，例如 `tvbox-data-YYYYMMDD.zip`，包含：

```text
manifest.json
settings.json
sources.json
sites.json
favorites.json
history.json
parses.json
parse-stats.json
live-health.json
bundled-sources.json
presets/*.json
```

`manifest.json` 至少包含：导出版本、应用版本、源平台、源架构、导出时间和文件清单哈希。不得导出 session 缓存、Electron cookie、临时日志或 API 响应缓存。

#### 导入规则

1. 用户通过设置页选择导出 zip 或数据目录。
2. 先解压到临时目录，校验 manifest 和 JSON 格式。
3. 导入前自动备份当前数据目录。
4. 只允许导入白名单文件，拒绝路径穿越和未知覆盖目标。
5. 以临时文件 + rename 写入目标目录。
6. 对 `externalPlayer.command` 做平台校验：Windows `.exe` 路径在 macOS 上标记为失效，不静默执行。
7. 对本地媒体路径和 `file://` 地址做可识别性检查；路径不存在时保留记录但提示用户重新选择。
8. 导入完成后清理直播体检缓存和与旧平台相关的播放器检测结果，避免把 Windows 结果当成 Mac 结果。
9. 失败时恢复备份，界面显示可定位的错误原因。

#### 存储版本

为 store 增加统一 `schemaVersion` 或在 manifest 中记录版本。旧的裸 JSON 仍要兼容读取，迁移应幂等执行，不能因为启动两次而重复添加源或重复覆盖收藏。

### 5.3 外部播放器抽象

当前 `src/main/services/player.ts` 是 Windows 专用实现，包含：

- `ProgramFiles` / `ProgramFiles(x86)` / `ProgramW6432` / `LOCALAPPDATA`。
- Windows `PATH` 分隔符 `;`。
- `.exe` 文件扫描。
- `reg query` 和 Windows 文件关联注册表。
- PotPlayer、MPC-HC、MPC-BE、KMPlayer、SMPlayer 等 Windows 播放器候选。

迁移后保留 `detectPlayers()` / `openInPlayer()` 的业务语义，但把检测和启动实现下沉到平台适配器。

#### macOS 首批候选

| 播放器 | 检测方式 | 启动方式 |
|---|---|---|
| IINA | `/Applications/IINA.app`、`~/Applications/IINA.app`、bundle id、`PATH` 中 CLI | 优先 `open -b com.colliderli.iina --args ...` 或 IINA CLI |
| VLC | `/Applications/VLC.app`、`~/Applications/VLC.app`、CLI | `open -a VLC --args ...` 或可执行文件 |
| mpv | `PATH` 中 `mpv`、常见 Homebrew 路径、应用包内可执行文件 | 直接 `spawn` 可执行文件，参数数组传递 |
| 系统默认播放器 | 仅作为显式 fallback，不承诺完整媒体格式能力 | `open <url>` 或 `open -a <app> <url>` |

具体 bundle id 和 CLI 路径在实施阶段以真机安装结果为准；不可把 Finder 全盘扫描作为正常路径。

#### 实现要求

- 用 `path.delimiter` 处理 PATH，不再写死 `;`。
- 用 `path.join()` 和 `fileURLToPath()` 处理路径，不手工拼 `/` 或 `\\`。
- 使用 `spawn(command, args, { detached: true, stdio: 'ignore' })`，禁止拼接 shell 命令字符串。
- `.app` 包和 CLI 可执行文件统一转换为 `PlayerInfo`，增加 `kind: 'app' | 'binary'` 或等价字段。
- 将当前 `source: 'registry'` 改成跨平台名称，例如 `source: 'scan' | 'launch-services' | 'manual'`；旧设置读取时兼容 `registry`，但 macOS 不生成该值。
- 手动路径既可指向 `.app` 也可指向可执行文件；保存后立即验证存在性，打开时再次验证。
- Windows 仍使用现有注册表探测，但必须由 `windows/externalPlayer.ts` 独占。
- UI 不再展示“注册表”字样，改为“系统默认关联”或按 `source` 显示平台中性标签。
- 首次 macOS 安装默认偏好改为 `IINA → mpv → VLC`；从旧设置读取时保留用户手动选择。

### 5.4 应用生命周期、Shell 和权限

- `app.setAppUserModelId('com.tvbox.desktop')` 只在 Windows 分支执行；macOS 使用 bundle identifier 和签名配置作为应用身份。
- 保留 macOS 的 `activate` 与 `window-all-closed` 行为，并增加“关闭窗口后从 Dock 恢复窗口”的人工验收。
- `shell.openExternal()` 继续作为 HTTP/HTTPS 外链入口，所有 URL 进入主进程前保持协议白名单。
- 如需“在 Finder 中显示文件”，使用 macOS 的 `shell.showItemInFolder()` 或平台适配器，不向 renderer 暴露任意 shell 执行能力。
- 不开启 App Sandbox 作为本次迁移的隐含前提；若发布策略要求沙盒，则必须单独设计文件选择、网络、播放器唤起和 entitlement，并重新做完整验收。
- 主进程、preload 的 `contextIsolation: true`、`nodeIntegration: false` 继续保持。

### 5.5 本地文件 URL、直播源和媒体地址

当前 `live.ts` 使用正则删除 `file://` 前缀，这对 Windows 盘符、macOS 空格、URL 编码和 UNC 路径都不够可靠。

统一改为：

- 识别 `file:` 时使用 Node `fileURLToPath(new URL(value))`。
- 普通本地路径使用 `path.resolve()`，不要假设盘符或分隔符。
- 输出给 Chromium 时使用 `pathToFileURL(path).toString()`。
- 对不存在的本地文件返回明确错误，不把路径当成远程 URL 请求。
- 保留 `http(s)://`、`rtmp://`、`rtsp://`、`udp://` 等直播地址的现有语义。
- 为包含空格、中文、`#`、`%` 和 macOS `/Volumes/...` 路径的文件增加测试。

### 5.6 网络、User-Agent、代理和播放兼容性

#### User-Agent

`DEFAULT_UA` 当前是 Windows Chrome UA；`streamResolve.ts` 中的 `browser_platform=Win32` 还可能是上游接口需要的兼容字段。两者不能简单一起替换。

计划：

1. 将“桌面浏览器请求 UA”和“上游平台兼容 profile”分开命名。
2. 默认请求 UA 优先使用稳定的桌面 Chrome profile；是否随 OS 变更要通过真实源兼容性测试决定。
3. 对抖音等上游接口保留独立参数 profile，并在注释中说明这是协议兼容值，不代表本机架构。
4. 将 UA/profile 的选择记录在诊断信息中，但不暴露 API Key 或完整请求地址。

#### 系统代理

现有 `proxy.ts` 通过 Electron `session.resolveProxy()` 探测代理端口，再在不可达时设置 `direct`。这部分不应重写成 Windows 或 macOS 专用代码，但要在 macOS 上验证：

- 系统代理开启且端口可用时，图片、HLS、分片和主进程请求行为正常。
- 系统代理配置指向失效端口时，应用仍能启动，并给出诊断日志。
- 用户中途修改系统代理后的行为符合当前“重启应用重新探测”的约定。
- 不把 macOS `networksetup` 作为运行期硬依赖，除非 Electron API 在真机上证实不足。

#### Chromium / HLS

macOS arm64 上需要验证 Chromium 对 H.264/AAC、HLS、M3U8、MSE、Canvas 抽帧和硬件解码的实际表现。若某些 HEVC/TS/MKV 仍无法内嵌播放，继续走外部播放器能力，不在本次迁移中引入新的解码器。

`webSecurity: false` 是现有跨域播放策略，迁移时不因“能启动”就跳过安全评估；至少要确认：外链打开、IPC 输入校验、远程内容注入和播放器地址传递没有新增风险。

### 5.7 Renderer 与文档

- 首次启动、首页、设置页中所有“Windows”描述改为“桌面端”，平台特有内容移到平台说明。
- 设置页外部播放器区域改成“检测本机播放器”，不展示 Windows 注册表概念。
- 数据目录和平台/架构信息继续显示，方便用户提交诊断信息。
- 增加 macOS 的快捷键、安装、首次启动 Gatekeeper 提示、卸载和数据备份说明。
- README 的安装表、命令、镜像环境变量、数据路径、外部播放器、已知限制拆成 Windows/macOS 两个平台段。
- `功能框架.txt` 中的目标平台、路径示例、播放器探测和打包说明同步更新，避免规划与实现文档冲突。

## 6. 构建与发布方案

### 6.1 electron-builder 配置目标

在 `electron-builder.yml` 中增加 macOS 配置，保留现有 Windows 配置：

```yaml
mac:
  target:
    - target: dmg
      arch: [arm64]
    - target: zip
      arch: [arm64]
  category: public.app-category.entertainment
  artifactName: ${productName}-${version}-${arch}.${ext}
```

实际字段以当前 electron-builder 版本校验结果为准。需要补齐：

- `build/icon.icns`。
- macOS bundle identifier 与现有 `appId` 一致性检查。
- `hardenedRuntime`、签名身份、entitlements 和 notarization 参数。
- DMG 的卷标、背景、应用拖拽入口和产物命名。
- 不把 `data/`、源码、测试截图或 node_modules 打进最终安装包，继续只打包 `out/**/*` 和运行时所需 `package.json`。

### 6.2 图标资产

- 保留 `build/icon.png` 作为源图。
- 生成 `build/icon.icns`，至少包含 16、32、128、256、512、1024 的 Retina 对应尺寸。
- 在 macOS 构建机上用系统工具或受控的图标生成脚本产出 ICNS，生成过程可重复，不提交一次性手工文件。
- 校验 Dock、Finder、DMG、系统“关于本机”应用列表中的图标一致。

### 6.3 npm 脚本

建议增加而不删除现有脚本：

```json
{
  "build:mac:arm64": "electron-vite build && electron-builder --mac dmg zip --arm64",
  "build:mac": "npm run build:mac:arm64",
  "package:win": "electron-vite build && electron-builder --win nsis zip --x64"
}
```

脚本最终名称以 `electron-builder --help` 和仓库实际版本验证为准。Windows 的 `.cmd` 包装脚本继续保留；macOS 直接通过 `npm run dev`、`npm run build:mac:arm64` 工作，不依赖 `.command` 文件。

### 6.4 签名、Notarization 与分发

macOS 发布包必须把签名和公证视为交付链的一部分：

1. 开发阶段允许未签名本地包，但文档明确这是开发包。
2. 发布阶段使用 Apple Developer 证书签名应用和 DMG/zip 中的应用。
3. 配置 hardened runtime 和最小 entitlement；不为了“先过公证”而默认放宽到全量权限。
4. 使用 Apple notarization 服务验证，检查 stapler 状态和 Gatekeeper 打开结果。
5. 在干净 Apple Silicon 机器上下载发布产物，验证未安装 Rosetta 也能启动。
6. 发布页面同时提供 SHA-256 校验值和版本变更说明。

签名凭据只能放在 CI secret 或本机钥匙串，不能写入仓库、`.env`、日志或构建产物。

## 7. 测试与验收矩阵

### 7.1 自动化检查

每个平台都必须通过：

```bash
npm ci
npm run typecheck
npm run build
npm run selftest
```

macOS arm64 额外通过：

```bash
npm run build:mac:arm64
file release/*.app/Contents/MacOS/*
```

`file` 输出应明确包含 `arm64`；不能只看到 `x86_64`，也不能通过 Rosetta 误把 x64 包当成 arm64 验证成功。

### 7.2 平台适配单元测试

为新增 adapter 加不依赖真机播放器的测试：

- Windows/macOS/Linux/unknown 的平台选择。
- `path.delimiter` 和路径拼接。
- `file://`、URL 编码、中文、空格、`#`、`%` 路径转换。
- macOS `.app` 与 CLI 播放器候选去重、排序和不存在路径过滤。
- `spawn` 参数数组中 URL、片名和空格不被 shell 二次解析。
- Windows 注册表代码在非 Windows 环境不被调用。
- 旧版 `PlayerInfo.source = 'registry'` 和旧的播放器偏好能安全读取。
- 导入 zip 的白名单、manifest 校验、路径穿越拒绝、备份与回滚。

### 7.3 macOS 真机验收

至少在一台 Apple Silicon 机器上完成：

1. 首次启动、重复启动、关闭窗口、Dock 恢复窗口、退出应用。
2. 应用位于 `/Applications` 时，数据不写入 `.app`。
3. 使用内置订阅完成同步、首页、搜索、分类、详情、选集和内嵌播放。
4. 播放 HLS、MP4、直播 M3U8；验证播放中换线路和错误提示。
5. 检测并打开 IINA、mpv、VLC 中至少两种；手动选择 `.app` 或 CLI 路径各测一次。
6. 导入 Windows 导出的数据包，验证源、设置、收藏和历史。
7. 选择包含中文、空格和特殊字符的本地直播文件。
8. 外部链接交给默认浏览器，非 HTTP/HTTPS 地址仍被拦截。
9. 代理正常、代理失效、无代理三种启动场景。
10. AI 文本总结、视频抽帧、多模态请求的 IPC 和错误路径。
11. Gatekeeper、签名、公证、卸载/删除应用后的数据保留策略。

### 7.4 Windows 回归

- Windows x64 的 NSIS 和 zip 仍可生成。
- 现有 `data/` 便携目录仍可写。
- PotPlayer/mpv/VLC 探测、注册表默认关联和 `.exe` 手动路径仍可用。
- `TVBox.cmd`、`TVBox-dev.cmd`、`TVBox-built.cmd` 仍可启动。
- 现有 177 项 selftest 结果不下降；若数量变化必须在变更记录中说明。

## 8. 实施阶段与交付物

### P0：基线锁定与平台边界

交付：

- 创建迁移分支，锁定当前基线和可回滚 tag。
- 新增 `platform/types.ts`、平台选择和运行时诊断类型。
- 清点所有 `process.platform`、路径分隔符、Windows 文案和外部命令调用。
- 增加 `TVBOX_DATA_DIR` 测试覆盖，保证本地测试不污染用户目录。

退出条件：没有新的 Windows API 出现在业务 service 中；`npm run typecheck` 和 `npm run build` 通过。

### P1：路径、存储与数据迁移

交付：

- `resolveDataPaths()` 与 Windows/macOS 两套规则。
- macOS 使用 userData，session 与 presets 路径统一。
- store schema/version、导入导出、备份和回滚。
- local file URL 转换模块。

退出条件：macOS 开发模式和打包模式都能写数据；导入一份 Windows 数据后重启数据仍完整。

### P2：外部播放器与系统集成

交付：

- Windows 现有播放器逻辑下沉到 Windows adapter。
- macOS IINA/mpv/VLC 检测和启动。
- shell、默认浏览器、文件显示、应用生命周期适配。
- Renderer 中平台中性化的播放器设置 UI。

退出条件：macOS 真机至少两种播放器可检测、可启动；Windows 播放器功能无回归。

### P3：构建、图标与 macOS 包

交付：

- `icon.icns` 和可重复生成脚本。
- electron-builder 的 `dmg`/`zip` arm64 配置。
- `build:mac:arm64` 脚本。
- 本地 Apple Silicon 构建产物。

退出条件：产物架构为 arm64，安装后可启动，且不向 `.app` 写运行数据。

### P4：CI、签名与公证

交付：

- macOS arm64 构建 job。
- Windows x64 回归 job。
- 签名、notarization、产物 checksum 和 release artifact 上传。
- 构建日志脱敏和凭据检查。

退出条件：干净 Apple Silicon 机器可下载、安装、启动并通过 Gatekeeper；Windows 产物仍可下载。

### P5：完整回归、文档与发布

交付：

- macOS 真机验收报告。
- README、`CHANGELOG.md`、`功能框架.txt` 和发布说明。
- Windows → macOS 数据迁移说明。
- 已知限制和故障排查手册。

退出条件：Definition of Done 全部满足，主分支只合并经过验证的迁移提交。

## 9. 文件级变更清单

| 文件/目录 | 计划变更 |
|---|---|
| `electron-builder.yml` | 增加 macOS arm64 DMG/zip、图标、分类、签名/公证占位配置；保留 Windows |
| `package.json` | 增加 macOS 构建脚本；描述从 Windows-only 改为桌面端；必要时增加 zip/导入工具依赖 |
| `package-lock.json` | 仅在确实新增依赖后由 npm 重新生成，禁止手工改锁文件 |
| `src/main/index.ts` | 接入平台 adapter、重构数据目录、条件化 app identity、暴露能力信息 |
| `src/main/platform/**` | 新增平台路径、Shell、本地文件 URL、播放器和运行时适配层 |
| `src/main/services/player.ts` | 从 Windows 实现改为平台无关编排，保留 IPC 语义 |
| `src/main/services/store.ts` | 支持数据根目录注入、schema/迁移前置检查和更清晰的写入错误 |
| `src/main/services/dataMigration.ts` | 新增导出、导入、备份、校验、回滚 |
| `src/main/services/live.ts` | 使用统一 file URL/path adapter |
| `src/main/services/http.ts`、`streamResolve.ts` | 拆分桌面 UA 与上游兼容 profile，保留已验证的协议字段 |
| `src/shared/types.ts` | 扩展平台能力、播放器类型、导入导出结果和错误码 |
| `src/shared/ipc.ts`、`src/preload/index.ts` | 增加能力查询、数据导入导出通道；继续保持 renderer 无 Node 权限 |
| `src/renderer/src/pages/Settings.tsx` | macOS 播放器、数据导入导出、路径提示和平台中性文案 |
| `src/renderer/src/pages/Home.tsx`、`App.tsx` | 移除 Windows-only 文案 |
| `src/renderer/src/global.d.ts` | 同步新的 preload API 类型 |
| `scripts/` | 增加跨平台构建/图标/测试辅助脚本；保留 `.cmd` 包装脚本 |
| `build/icon.icns` 或其生成脚本 | 增加 macOS 图标 |
| `docs/macos-arm64-migration/` | 保留本规划、验收报告、迁移故障排查和发布记录 |
| `README.md`、`CHANGELOG.md`、`功能框架.txt` | 双平台安装、数据、播放器、构建和限制说明 |
| `.github/workflows/` | 增加 macOS arm64 构建/签名/公证与 Windows 回归流水线 |

## 10. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 把数据写进 `.app` | 首次可能能用，升级或签名后丢数据/启动失败 | macOS 强制 userData；增加只读 `.app` 验收 |
| Electron 在 Rosetta 下运行 | 误判为 arm64 通过 | 产物 `file` 检查 + 原生 Apple Silicon 机器验收 |
| macOS `open` 与 CLI 参数行为不同 | 外部播放器打不开或参数丢失 | app/ binary 分型，所有参数数组化，真实播放器矩阵测试 |
| Windows 导出的播放器路径失效 | 导入后点击外部播放报错 | 导入时标记失效并提示重选，不静默执行 |
| macOS 本地文件 URL 编码错误 | 本地直播/媒体无法播放 | `fileURLToPath`/`pathToFileURL` 单元测试和真机测试 |
| 签名/公证失败 | 用户无法打开发布包 | 先做未签名开发包，再单独收敛 entitlement 和 CI 凭据 |
| `.icns` 缺失或尺寸不完整 | 安装包图标异常 | 可重复生成并检查 Finder/Dock/DMG |
| 系统代理行为差异 | 海报或 HLS 失败 | 三种代理场景验收，保留启动诊断日志 |
| 上游站点把 Windows UA 当兼容条件 | 搜索/直播解析回归 | UA 与上游 profile 分离，保留协议兼容参数并做真实源回归 |
| `webSecurity: false` 在新平台暴露风险 | 远程内容和 IPC 风险增大 | 维持现状但做安全审查；不新增任意 shell/文件执行入口 |
| macOS 机器缺少播放器 | 外部播放按钮不可用 | 内嵌播放器继续作为主路径，设置页支持手动选择和明确错误 |

## 11. Git 与协作策略

建议使用单独分支，不直接在 `main` 上堆叠跨平台迁移：

```text
codex/macos-arm64-migration
```

建议按可回滚边界拆提交：

1. `docs: add macOS arm64 migration plan`
2. `refactor(platform): introduce runtime and path adapter`
3. `feat(data): add macOS data path and import/export migration`
4. `feat(player): add macOS external player adapter`
5. `build(mac): package arm64 dmg and zip`
6. `test(mac): add Apple Silicon and platform adapter coverage`
7. `docs(release): document macOS install and troubleshooting`

每个提交都应保持类型检查或构建可运行；签名凭据、个人数据、`data/`、`release/` 和本地播放器路径不得提交。合并前至少保留：

- Windows x64 构建产物验证记录。
- macOS arm64 构建产物的 `file` 检查记录。
- macOS 真机回归结果。
- Windows → macOS 数据导入结果。
- 失败时的回滚 tag 和数据备份位置。

## 12. Definition of Done

只有以下条件全部满足，才认为“Windows → macOS ARM 完整迁移”完成：

- [ ] macOS arm64 可以从干净 checkout 执行 `npm ci`、`npm run dev`、`npm run typecheck`、`npm run build`。
- [ ] `npm run build:mac:arm64` 输出可安装 `.dmg` 和可分发 `.zip`。
- [ ] 产物经 `file` 检查为原生 `arm64`，在 Apple Silicon 机器上不依赖 Rosetta。
- [ ] 发布包签名和公证通过；Gatekeeper 首次打开可完成。
- [ ] 运行数据位于 macOS userData，不写入 `.app`，重启后数据保留。
- [ ] Windows x64 的 NSIS、zip、`.cmd` 脚本和便携 `data/` 仍可用。
- [ ] IINA、mpv、VLC 中至少两种播放器在 macOS 上可检测并打开播放地址。
- [ ] `file://`、中文、空格和特殊字符本地路径测试通过。
- [ ] Windows 导出包可在 macOS 导入，源、站点覆盖、设置、收藏和历史完整。
- [ ] 配置源、搜索、分类、详情、内嵌播放、直播、解析、收藏历史、AI 总结主链路在 macOS 真机通过。
- [ ] 代理正常/失效/无代理三种场景通过。
- [ ] `npm run selftest` 在 macOS 通过；Windows selftest 没有回归。
- [ ] README、CHANGELOG、`功能框架.txt` 和 macOS 故障排查文档已更新。
- [ ] 所有迁移提交可追溯、无敏感凭据、无本地数据和无未解释的二进制改动。

## 13. 推荐实施顺序

实际编码时按以下顺序推进，避免先做安装包后发现运行时路径错误：

1. 先完成平台 adapter 和数据路径测试。
2. 再完成 macOS 播放器、Shell 和本地文件 URL。
3. 再完成数据导入导出与旧数据兼容。
4. 在 macOS 真机先跑开发模式和 selftest。
5. 再接入 electron-builder、ICNS 和 arm64 产物。
6. 最后做签名、公证、CI、文档和发布验收。

这样可以把迁移拆成可独立回滚的边界：即使 macOS 签名或播放器发现仍有问题，也不会破坏已有 Windows 版本和用户数据。
