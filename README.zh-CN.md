# dsh Desktop

[English](README.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)](#平台支持)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`dsh`)的桌面应用:负责安装与更新运行时、持有服务进程及其存储,并把 Web UI 收进窗口。

> **非官方项目**,与 DeepSeek 无隶属关系,也未获其背书。`dsh` 由其作者以 npm 包
> 形式发布,本项目只是它的外壳;两者独立迭代,应用不会把 `dsh` 的副本并入自己的
> 源码树。

仓库名为 `dsh-desktop`,打包出的应用名为 **DeepSeek Harness**(见[商标](#商标))。

## 为什么需要它

`npx dsh web` 本身就能跑。它留给你的是周边的一切:运行时装在哪、怎么升级、端口被占了用哪个、退出应用后子进程还在不在、`DSH_HOME` 指向何处、服务挂了谁负责拉起。这些由本应用接管。

## 它做什么

| | |
|---|---|
| **双槽位更新** | 运行时由 npm 装进 `runtime/slot-a` 或 `slot-b`,`current.json` 指向活跃槽。更新先装进闲置槽,起一个探针服务做启动自检,通过后才切换指针——升级失败不会动到正在用的版本。旧版本仍留在另一个槽位里,菜单里一步即可回退,不必联网、不必重装。 |
| **更新通道** | `dsh` 的新版本先发到 npm 的 `next` 标签,`latest` 要过些时候才跟上——于是一个明明已经发布的版本,对只盯着 `latest` 的人来说是不存在的。稳定版跟随 `latest`,预览版跟随 `next`;检查更新本就只发一次请求,两个标签一并读回,所以在稳定版上「已是最新」时也能顺带说出预览版有更新的版本,而不是把这件事留成一个谜。若通道指向的版本比已装的**更旧**,会如实说明这是往回切,启动自检与另一个槽位的回退对它同样有效。 |
| **应用自更新** | 与 GitHub Release 上的版本号对照,分两种更新。**热更新**:新版本若只改了外壳代码(JS 与页面),只下几百 KB 的包放进数据目录,重启即生效——`/Applications` 里的应用包不动,签名不变,系统隐私授权也不会因此失效。**整包更新**:改到 Electron 或内置运行时的版本走安装包,应用负责下载并打开它。启动后静默检查一次,菜单里也可随时手动检查。 |
| **进程归属** | 服务随窗口启动,占用随机空闲端口,应答 HTTP 200 后才加载页面。它运行在独立的进程组(POSIX)或进程树(Windows)中,应用退出时整树终止,不留孤儿。 |
| **进程守护** | 非计划退出——包括 OOM abort 这种以信号而非退出码到达的情况——会自动重启,退避 1s/3s/8s。连续三次失败才弹窗,而不是无限重试。稳定运行满一分钟即重置预算,所以偶发崩溃永远有完整的三次机会。 |
| **启动可恢复** | 服务未在就绪时限内应答时提供重试,而不是直接结束应用:磁盘繁忙时它通常只是慢,并没有坏。若刚做过插件操作,弹窗会直接指认那个插件,并给出「卸载/停用它并重启」——装坏一个插件不该需要用户自己去猜。 |
| **把文件发给对话** | 三个入口通向同一件事:macOS 上从访达「打开方式」选它、或把文件拖到程序坞图标;Windows 上加进右键「发送到」菜单(设置里一键开关);两个平台都支持直接把文件拖进窗口。文件路径会写进聊天输入框——dsh 是带文件系统工具的 agent,路径才是它能动手的东西,也不受文件大小限制。写入前会读回校验,写不进去(比如还没选工作区)就退回复制到剪贴板并提示粘贴,功能不会哑掉。拖拽先让页面自己处理,页面接手了就不插手。 |
| **常驻行为** | 它是个常驻服务,只是恰好带了个窗口:可设开机自启、启动后直接留在托盘不弹窗,窗口尺寸与位置也会记住(保存的矩形若落在已拔掉的显示器上会被丢弃,免得窗口开在看不见的地方)。 |
| **存储** | `DSH_HOME` 指向应用数据目录内部,profiles、会话与设置全部归应用管理。菜单可直接打开数据目录与日志,也可导出数据快照与从快照恢复——运行时能双槽回退、外壳能热更新回退、插件能停用,唯独会话没有退路,快照就是那条退路。恢复前会先校验压缩包确实是数据目录的快照,被替换的目录改名保留而不是删除。 |
| **代理设置** | 应用有两条互不相干的网络:窗口自身的请求走 Chromium,而 npm(装运行时)、pnpm(装插件)、以及真正调用模型 API 的 `dsh` 服务进程读的是环境变量。GUI 应用从启动台打开时两者都拿不到——终端里 `export` 的代理它看不见,系统代理开关又常常是关的。菜单「设置 → 代理…」一次配好两条,并能分别测通。 |
| **内置工具链** | 打包版自带 Node 运行时,目标机器无需预装任何东西。源码运行时回退为在本机查找 Node ≥ 22(PATH、nvm、Homebrew、`%ProgramFiles%`),这也顺带绕开了 GUI 应用不继承 shell `PATH` 的问题。这个继承问题的影响面更广:`dsh` 要在 `PATH` 上找装插件用的 pnpm,以及可委派的 Claude Code 与 Codex CLI,而 macOS 上双击启动的应用拿到的只有 `/usr/bin:/bin:/usr/sbin:/sbin`。所以每次运行会问一次用户自己的 shell 它的 `PATH` 是什么——这覆盖的是用户实际在用的版本管理器和安装位置,而不是我们想得到的那几种——再把答案追加进去;万一 shell 问不到,后面还垫着常见的包管理器目录。 |
| **插件管理** | 在窗口里安装、更新、卸载 `dsh` 插件:npm 包名、GitHub 网页链接(含插件集合仓库里指向某个子包的 `…/tree/main/packages/xxx` 链接)、`github:` spec、本地绝对路径,或直接选一个 zip 安装包——zip 会解压到 `<数据目录>/dsh-home/plugins/<包名>` 后按本地路径安装。已装插件会在后台按 npm 配置的注册表(尊重镜像)查一次新版本,有则标出。插件可随时停用/启用而不必卸载——停用写的是 loader 条目上的 `disabled: true`(运行时自带的机制),而不是 profile 的 bundle 列表,因为那个列表会被 `dsh plugin` 每次操作时按已安装状态重新对账。插件若导出配置 schema,会自动生成表单;填写的值写入 profile 的 `plugin-config.json`,并与停用状态一起镜像进 `cordis.patch.yml` 中带标记的托管块。 |
| **插件市场** | 独立窗口(菜单「插件 → 插件市场…」):读取 [DSH Market](https://dshplugin.market/) 的目录,可搜索、看星标与描述,一键安装。目录在本地缓存(6 小时内不再联网,可手动刷新),离线也能浏览。只有市场已核验、且从 npm 分发的条目提供一键安装;git 来源的条目只给出仓库链接,需要自行在「已安装」页手动安装。换源见[数据位置](#数据位置)中的 `marketCatalogUrl`。 |

## 从源码运行

```sh
npm install
npm start
```

首次启动会从 npm 安装 `@deepseek-ai/dsh@latest`(需要网络,耗时几分钟)。数据与日志见[数据位置](#数据位置)。

macOS 上,源码运行的进程住在 `node_modules` 里那个未品牌化的 Electron.app 中,所以程序坞悬停显示的名字是 **Electron**——这是正常的,不是装错了。图标已在运行时换成应用自己的;名字来自那个 bundle,只有安装包里的应用才是对的。

### 如果 `npm install` 卡在下载 Electron

electron 包的 postinstall 会从 GitHub Releases 拉取约 100MB 的运行时,**这一步不走 npm registry**——只改 registry 不解决问题。当网络无法访问 GitHub 或被重置时(表现为 `node_modules/electron` 下的 `RequestError: read ECONNRESET`),把两个下载器都指向镜像。

Windows(`cmd`,须与后续命令在同一个窗口):

```cmd
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

macOS / Linux:

```sh
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

要持久生效,把同名键以小写写进 `.npmrc`(`electron_mirror=…`),npm 会把它传给生命周期脚本。注意 `npm config set electron_mirror …` 会被 npm 9 及以上版本**拒绝**——它校验键名,而这些并非 npm 自身的选项。

第二个变量在打包阶段才起作用:`electron-builder` 同样会从 GitHub 下载它自己的辅助二进制(NSIS、winCodeSign),只设第一个的话,你会在 `npm run dist:win` 时撞上同样的失败。

安装失败会留下写了一半的 `node_modules`;Windows 上 npm 清理时报 `EPERM: operation not permitted, rmdir`,意味着有进程正占用这些文件(杀毒软件、编辑器、资源管理器)。关掉占用方,删除 `node_modules`,重新安装。

## 打包

打包是**对打包机的快照**。每个 `dist` 脚本都会先执行 `npm run seed`,在项目根目录生成两个归档:

- `seed.tar` —— 本机数据目录中当前安装的 `dsh` 运行时
- `node-runtime.tgz` —— 本机的 Node 二进制与 npm,使装好的应用无需预装 Node

由此有两条约束。**打包前必须先跑一次应用**,否则没有运行时可快照,构建会以 `No active local dsh runtime` 中止。以及**每个平台的包必须在该平台上打**——在 macOS 上打出的 Windows 安装包里装的是 macOS 的 Node 二进制。要交叉编译,只能放弃离线种子、改为按目标平台下载 Node。

第一条约束可以在构建机上放宽:`node scripts/prepare-seed.mjs --bootstrap`(或设 `DSH_SEED_BOOTSTRAP=1`,它能穿过 npm 的 pre 钩子)会在没有运行时的机器上先装一份再快照——CI 走的就是这条。第二条绕不开,所以有了下面的 Actions。

### GitHub Actions

`.github/workflows/build.yml` 在三台机器上各打一份:macOS Apple Silicon(`macos-14`)、macOS Intel(`macos-15-intel`)与 Windows(`windows-latest`)。触发方式是手动运行,或推一个 `v*` 标签。

三行,因为打包会快照宿主机:Intel 版的 dmg 必须在 Intel runner 上打。原先承担这件事的 `macos-13` 已经下架,`macos-15-intel` 接替了它,且属于标准 runner,公开仓库免费。两行 mac 的差别只在落到哪台宿主机上——electron-builder 按宿主机架构决定产物。

推标签时,产物直接传到对应的 Release(用 runner 自带的 `gh`,不引入第三方 action)。手动运行默认**不**上传安装包:免费账户的 artifact 存储只有 500MB,而一个 dmg 就 200MB 出头,三个平台会直接撑满;需要产物时在运行对话框里勾选 `upload`,用完记得删。

工作流里 `setup-node` 固定的 Node 版本不只是构建工具——`npm run seed` 会把它的二进制和 npm 打进应用,所以那就是打包版实际运行 `dsh` 用的 Node。

签名方面与本机打包一致:macOS 仍是 ad-hoc、Windows 未签名。工作流末尾留了一段注释,说明拿到 Apple Developer ID 之后要加哪些 secrets——除了过 Gatekeeper,更实际的收益是 macOS 把隐私授权(比如「文稿」目录)绑定在代码签名上,而 ad-hoc 签名每次构建都变,等于每次更新都悄悄吊销用户已经给过的授权;Developer ID 签名跨构建稳定,这个毛病随之消失。

### macOS

```sh
npm install
npm start          # 先跑一次,让 dsh 运行时装好
npm run dist       # dist/mac-arm64/DeepSeek Harness.app
npm run dist:mac   # dist/DeepSeek Harness-<版本>-arm64.dmg
```

构建由 `scripts/adhoc-sign.cjs`(`afterPack` 钩子)做 ad-hoc 签名,未做公证。缺少这一步的话,被改名的 Electron 二进制会带着失效的旧签名,Gatekeeper 会把带隔离属性的副本报成"已损坏",而不是给出正常的"未识别开发者"提示。

### Windows

环境要求:Windows 10 1803 及以上(System32 中要有 `tar.exe`)、[Node.js](https://nodejs.org) ≥ 22、Git。

```powershell
git clone https://github.com/huyang218/dsh-desktop.git
cd dsh-desktop
npm install
npm start          # 先跑一次,让 dsh 运行时装进 %APPDATA%
npm run dist:win   # NSIS 安装包
npm run dist       # 或:仅生成免安装目录
```

产物:

```
dist\
├── dsh-desktop Setup <版本>.exe   NSIS 安装包
└── win-unpacked\                  免安装目录(npm run dist)
```

安装包为当前用户安装、允许选择安装目录(`oneClick: false`、`perMachine: false`),因此不需要管理员权限。它未做代码签名:首次运行 SmartScreen 会告警,直到该可执行文件积累足够信誉,或你在 `build.win.certificateFile` 配置签名证书。

这里同样必须先执行 `npm start`。跳过会在 `predist` 阶段失败,报 `No active local dsh runtime under %APPDATA%\dsh-desktop\runtime`。

安装后请验证[平台支持](#平台支持)一节列出的三件事,尤其是**退出应用后不留孤儿 `node` 进程**。

新增功能在 Windows 上的几点差异,已在实现里处理:热更新包解压到数据目录内的临时目录再改名启用,不经系统临时目录——跨盘符改名会以 `EXDEV` 失败;zip 安装包里若含 Windows 无法安全落盘的条目名(带 `:` 会写成另一个文件的数据流、`CON`/`LPT1` 等设备名、结尾的点或空格会被静默吃掉),解压会直接拒绝;「开机时启动」写的是当前用户的启动项,`openAsHidden` 是 macOS 专有的,Windows 上由应用自己的「启动后留在托盘」设置决定。整包更新下载的是 `.exe` 安装包,安装前需要先退出应用。

## 菜单

| 项 | 作用 |
|---|---|
| 插件 → 插件市场… | 浏览目录、搜索、一键安装 |
| 插件 → 插件管理… | 安装、更新、配置、卸载已安装的插件 |
| 设置 → 代理… | 配置网络代理,一次同时作用于窗口请求与所有子进程 |
| 设置 → 运行时更新通道 | 稳定版或预览版:检查运行时更新时跟随哪个 npm 标签,默认稳定版 |
| 检查应用更新 | 与 Release 对照;能热更新就热更新,否则下载安装包 |
| 检查运行时更新 | 在所选通道上做 `dsh` 运行时的双槽位更新,自检通过后询问是否重启 |
| 回退到 dsh &lt;版本&gt; | 切回另一个槽位里的上一个版本;另一槽位为空或同版本时不出现 |
| 设置 → 开机时启动 / 启动后留在托盘 | 常驻行为的两个开关 |
| 重启服务 | 停掉当前服务进程树,以同一版本重新启动 |
| 打开数据目录 / 打开日志 | |

## 数据位置

| 平台 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/dsh-desktop/` |
| Windows | `%APPDATA%\dsh-desktop\` |

```
dsh-desktop/
├── runtime/            已安装的 dsh:slot-a | slot-b、current.json
├── node-runtime/       内置 Node(仅打包版)
├── dsh-home/           DSH_HOME:profiles、会话、设置
│   └── plugins/        zip 安装的插件解压于此(profile 以 link: 指向)
├── shell/              热更新下来的外壳:current.json 指向正在用的那份
├── updates/            整包更新下载的安装包
├── market-catalog.json 插件市场目录缓存,删掉只会多刷新一次
├── settings.json       语言、插件市场源等外壳设置
└── dsh-desktop.log     应用与服务日志
```

`settings.json` 里可选的键:

| 键 | 作用 |
|---|---|
| `locale` | 界面语言,菜单里切换时写入 |
| `startHidden` | 启动后不弹窗,直接留在托盘 |
| `windowBounds` / `windowMaximized` | 窗口尺寸、位置与最大化状态,退出时记住 |
| `proxy` | `{ mode, url, bypass }`,`mode` 为 `system`(默认)/`direct`/`manual`。在「设置 → 代理…」里改;`localhost`、`127.0.0.1`、`::1` 恒定直连,不必写进 `bypass`。 |
| `marketCatalogUrl` | 插件市场目录地址,默认 `https://dshplugin.market/plugins.json`。换成自建或其他目录(例如 `https://awesome-dsh-plugin.com/plugins.json`)即可,改完在市场页点「刷新」。 |

## 应用更新

版本号来自 `package.json`,线上版本来自本仓库 Release 的最新 tag。每个 tag 构建除了 dmg 与安装包,还会发布两个小文件:

- `shell-<版本>.zip` —— 外壳自身的代码(`src/` 与 `assets/`,不含 Electron 与运行时),约 170KB
- `shell-update.json` —— `{ version, electron, sha256, asset }`

应用据此决定走哪条路:清单里的 Electron 大版本与正在运行的一致,就是**热更新**;否则说明这次改动落在应用包里(Electron 本身、内置 Node、运行时种子),只能走**整包更新**。

热更新落在 `<数据目录>/shell/<版本>/`,由 `src/boot.js` 在启动时选择加载哪一份:

```
<数据目录>/shell/
├── current.json     { version, confirmed, attempts }
└── 0.1.2/           src/、assets/、shell.json
```

规则与 `dsh` 运行时的双槽位一致,只是换成了启动应用的代码本身:新包在**证明自己能启动之前**只有两次机会,加载即抛错、清单缺失、Electron 大版本不符、目录不见了——任何一种情况都回退到安装包里的那份并丢弃下载。换句话说,热更新最坏的结果不会差于用户当初装的版本,因为那份始终原封不动躺在原地。包在窗口与服务都起来后被标记为已确认(`boot.js` 另有一分钟兜底),之后不再计次。

下载的包按 `shell-update.json` 里的 SHA-256 校验,不匹配直接丢弃;信任根与下载安装包时相同,即 GitHub 的 TLS。

整包更新只负责把安装包下下来并在访达/资源管理器中打开,替换由平台自己的安装流程完成——应用在运行时替换自己,是同时失去两个版本的经典方式。

## 平台支持

| | 状态 |
|---|---|
| **macOS**(Apple Silicon) | 已完整验证 |
| **Windows**(10 1803 及以上) | 已完整验证:NSIS 安装包、首次启动、干净退出 |
| Linux | 未尝试 |

`dsh` 本身是跨平台的(无 `os` 限制,且自带 pwsh 与 Windows ACL 沙箱后端),所以平台工作全部集中在本壳。每一处 POSIX 假设都有对应的 Windows 实现:进程树终止用 `taskkill /T` 而非负 PID,`tar` 按名字调用,Node 查找取 `node.exe` 并搜索 `%ProgramFiles%\nodejs` 与 nvm-windows,托盘使用真实图标而非 macOS 模板图,数据目录经 `%APPDATA%` 解析。

**进程树终止**是唯一只能靠真机确认的部分,现已确认:杀进程组与 `taskkill /T` 是两种不同机制,做错的表现是应用看起来正常退出、却留下孤儿 `dsh` 进程——这种问题在代码审查里看不出来。改动退出逻辑后值得重新验一次;退出应用后,下面这条命令应无输出:

```powershell
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*dsh-desktop*' }
```

## 已知边界

- `dsh` 处于 rc 阶段。本应用依赖的契约刻意最小化:`dsh web --port N`,以及根路径返回 HTTP 200 即视为就绪。上游变更导致异常时,优先检查这两点。
- 本地端口对本机任意进程可见(`dsh` 目前无鉴权 token)。随机端口只是收窄窗口,并未关闭它。
- 对话依赖 `DEEPSEEK_API_KEY`,可在 `dsh` Web UI 的设置中配置,或在启动前导出到环境变量。
- macOS 构建为 ad-hoc 签名且未公证:首次打开需在「系统设置 → 隐私与安全性」中放行。
- macOS 的受保护目录(文稿、桌面、下载、外置卷)对本应用是隔离的:插件若以本地路径安装在这些位置,读取时会得到 `EPERM`。插件管理器会在报错后附上处置步骤。授权是绑定代码签名的,而 ad-hoc 签名每次重装都会变,所以更新应用后需要重新授权;用 zip 安装可以把插件放进应用数据目录,完全避开这一层。

## 参与贡献

欢迎提交 issue 与 PR。

改动如果触及进程生命周期(启动、守护、退出),请在真实机器上验证"退出应用后不留孤儿进程"。这类缺陷在代码审查中不可见,单元测试也复现不出来。

**贡献者**

- **Hu Yang**([@huyang218](https://github.com/huyang218),guxinglei218@qq.com)—— 作者、维护者

## 许可

以 [MIT 许可证](LICENSE)发布。

打包产物会再分发下列组件,各自遵循其原许可,声明随包保留:

| 组件 | 许可 | 包内位置 |
|---|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`@deepseek-ai/dsh` 及插件) | MIT | `Resources/runtime-seed.tar` |
| [Node.js](https://nodejs.org) | MIT | `Resources/node-runtime.tgz` → `LICENSE-node` |
| [npm](https://github.com/npm/cli) | Artistic-2.0 | 同一归档 → `lib/node_modules/npm/LICENSE` |
| [Electron](https://www.electronjs.org) | MIT | 应用框架 |

### 商标

"DeepSeek" 是其所有者的商标。**本项目为非官方项目,与其无隶属关系,也未获背书。** 打包出的应用沿用 DeepSeek Harness 名称与鲸鱼图标,用以指明它所承载的上游软件;这些标识的权利属于其所有者,不在本项目的 MIT 授权范围内。
