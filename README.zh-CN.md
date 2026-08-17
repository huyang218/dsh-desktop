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
| **双槽位更新** | 运行时由 npm 装进 `runtime/slot-a` 或 `slot-b`,`current.json` 指向活跃槽。更新先装进闲置槽,起一个探针服务做启动自检,通过后才切换指针——升级失败不会动到正在用的版本。 |
| **进程归属** | 服务随窗口启动,占用随机空闲端口,应答 HTTP 200 后才加载页面。它运行在独立的进程组(POSIX)或进程树(Windows)中,应用退出时整树终止,不留孤儿。 |
| **进程守护** | 非计划退出——包括 OOM abort 这种以信号而非退出码到达的情况——会自动重启,退避 1s/3s/8s。连续三次失败才弹窗,而不是无限重试。稳定运行满一分钟即重置预算,所以偶发崩溃永远有完整的三次机会。 |
| **启动可恢复** | 服务未在就绪时限内应答时提供重试,而不是直接结束应用:磁盘繁忙时它通常只是慢,并没有坏。 |
| **存储** | `DSH_HOME` 指向应用数据目录内部,profiles、会话与设置全部归应用管理。菜单可直接打开数据目录与日志。 |
| **内置工具链** | 打包版自带 Node 运行时,目标机器无需预装任何东西。源码运行时回退为在本机查找 Node ≥ 22(PATH、nvm、Homebrew、`%ProgramFiles%`),这也顺带绕开了 GUI 应用不继承 shell `PATH` 的问题。 |
| **插件管理** | 在窗口里安装、卸载 `dsh` 插件。插件若导出配置 schema,会自动生成表单;填写的值写入 profile 的 `plugin-config.json`,并镜像进 `cordis.patch.yml` 中带标记的托管块。 |

## 从源码运行

```sh
npm install
npm start
```

首次启动会从 npm 安装 `@deepseek-ai/dsh@latest`(需要网络,耗时几分钟)。数据与日志见[数据位置](#数据位置)。

## 打包

打包是**对打包机的快照**。每个 `dist` 脚本都会先执行 `npm run seed`,在项目根目录生成两个归档:

- `seed.tar` —— 本机数据目录中当前安装的 `dsh` 运行时
- `node-runtime.tgz` —— 本机的 Node 二进制与 npm,使装好的应用无需预装 Node

由此有两条约束。**打包前必须先跑一次应用**,否则没有运行时可快照,构建会以 `No active local dsh runtime` 中止。以及**每个平台的包必须在该平台上打**——在 macOS 上打出的 Windows 安装包里装的是 macOS 的 Node 二进制。要交叉编译,只能放弃离线种子、改为按目标平台下载 Node。

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

## 菜单

| 项 | 作用 |
|---|---|
| 插件管理… | 安装、卸载、配置 `dsh` 插件 |
| 检查更新 | 双槽位更新,自检通过后询问是否重启 |
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
└── dsh-desktop.log     应用与服务日志
```

## 平台支持

| | 状态 |
|---|---|
| **macOS**(Apple Silicon) | 已完整验证 |
| **Windows** | 代码已适配,**尚未在真机验证** |
| Linux | 未尝试 |

`dsh` 本身是跨平台的(无 `os` 限制,且自带 pwsh 与 Windows ACL 沙箱后端),所以平台工作全部集中在本壳。每一处 POSIX 假设都有对应的 Windows 实现:进程树终止用 `taskkill /T` 而非负 PID,`tar` 按名字调用,Node 查找取 `node.exe` 并搜索 `%ProgramFiles%\nodejs` 与 nvm-windows,托盘使用真实图标而非 macOS 模板图,数据目录经 `%APPDATA%` 解析。

唯一必须真机验证的是**进程树终止**。杀进程组与 `taskkill /T` 是两种不同机制,做错的表现是:应用看起来正常退出,却留下孤儿 `dsh` 进程——这种问题在代码审查里看不出来。退出应用后,下面这条命令应无输出:

```powershell
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*dsh-desktop*' }
```

## 已知边界

- `dsh` 处于 rc 阶段。本应用依赖的契约刻意最小化:`dsh web --port N`,以及根路径返回 HTTP 200 即视为就绪。上游变更导致异常时,优先检查这两点。
- 本地端口对本机任意进程可见(`dsh` 目前无鉴权 token)。随机端口只是收窄窗口,并未关闭它。
- 对话依赖 `DEEPSEEK_API_KEY`,可在 `dsh` Web UI 的设置中配置,或在启动前导出到环境变量。
- macOS 构建为 ad-hoc 签名且未公证:首次打开需在「系统设置 → 隐私与安全性」中放行。

## 参与贡献

欢迎提交 issue 与 PR。

改动如果触及进程生命周期(启动、守护、退出),请在真实机器上验证"退出应用后不留孤儿进程"。这类缺陷在代码审查中不可见,单元测试也复现不出来。

**贡献者**

- **Hu Yang**([@huyang218](https://github.com/huyang218))—— 作者、维护者

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

## 从 `dsh-shell` 升级

本项目原名 `dsh-shell`,数据目录同名。新版本首次启动会把 `dsh-shell` 重命名为 `dsh-desktop`,已安装的运行时、会话与设置原样保留。若两个目录同时存在,则既不合并也不覆盖:使用新目录,并在日志中记录旧目录位置。若重命名失败,则继续使用旧目录,而不是在旁边以空目录起步。

改名同时变更了 `appId`,macOS 会将其视为另一个应用:**此前授予的系统权限(如辅助功能)需要重新授予。**
