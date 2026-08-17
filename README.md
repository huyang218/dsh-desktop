# dsh Desktop

把 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)(dsh)装进一个桌面应用:**装环境、管进程、管存储**,并把它的 Web UI 收进窗口。

> An unofficial desktop app for DeepSeek Harness — installs and updates the
> runtime, owns the server process and storage, and wraps the web UI in a
> window.

**非官方项目**,与 DeepSeek 无隶属关系。dsh 本体由官方以 npm 包形式发布,本项目只是它的桌面外壳:壳不打包 dsh,dsh 通过 npm 独立安装与更新,两者的迭代完全解耦。

> 仓库名为 `dsh-desktop`,打包出的应用显示为 **DeepSeek Harness**(见文末[许可](#许可)一节的商标说明)。

## 它解决什么

直接用 `npx dsh web` 也能跑,但你要自己管:装到哪、怎么升级、端口被占了怎么办、退出时子进程有没有留下、`DSH_HOME` 放哪、崩了谁把它拉起来。这个壳把这些收进一个应用里。

- **环境(双槽位更新)**:dsh 由 npm 安装到数据目录的 `runtime/slot-a|slot-b`,`current.json` 指向活跃槽。更新时装进闲置槽 → 起一个探针服务做启动自检 → 通过才切换指针;自检失败保留旧版可用,不存在"升级到一半用不了"的状态。
- **进程**:启动窗口的同时 spawn `dsh web --port <随机空闲端口>`,轮询 HTTP 200 就绪后加载。子进程以独立进程组运行,退出应用时对整组发 SIGTERM(超时升级 SIGKILL),不留孤儿。
- **进程守护**:服务意外退出(含 OOM 导致的 SIGABRT)会自动重启,退避 1s/3s/8s,连续 3 次失败才弹窗询问。稳定运行满 60 秒重置重启预算,偶发崩溃永远有完整的三次机会。
- **存储**:`DSH_HOME` 指向数据目录下的 `dsh-home`,profiles、会话、设置全部收归应用管理,菜单可直接打开数据目录与日志。
- **工具链**:打包版内置 Node 运行时,目标机器无需自行安装 Node;开发模式回退到查找本机 Node ≥ 22(PATH、nvm、Homebrew),npm 以 `node npm-cli.js` 方式调用,绕开 macOS GUI 应用不继承 shell PATH 的问题。
- **插件管理**:内置 dsh 插件的安装/卸载界面,并能读取插件的配置描述、以表单方式填写,写回 profile 的 `cordis.patch.yml`。

## 运行

```sh
npm install
npm start
```

开发模式首次启动会自动安装 `@deepseek-ai/dsh@latest`(需要网络,几分钟)。数据与日志在 `~/Library/Application Support/dsh-desktop/`。

## 打包

```sh
npm run dist      # .app 目录
npm run dist:dmg  # dmg 安装包
```

打包前会把当前活跃槽的 dsh 快照成 `seed.tar`、把本机 Node 快照成 `node-runtime.tgz` 一并打进应用,所以**打包机上要先跑过一次**,让运行时存在。安装后首次启动直接解包,无需联网下载。

## 菜单

- **插件管理…**:安装/卸载 dsh 插件,填写插件配置。
- **检查更新**:双槽位更新流程,自检通过后询问是否重启服务。
- **重启服务**:停掉当前服务进程组并以当前版本重启。
- **打开数据目录 / 打开日志**。

## 已知边界

- dsh 处于 rc 阶段,壳依赖的契约刻意最小化:`dsh web --port N` + 根路径 200 即就绪。dsh 侧发生破坏性变更时优先检查这两点。
- 本地端口对本机进程可见(dsh 目前无鉴权 token);随机端口是缓解,不是根治。
- 对话依赖 `DEEPSEEK_API_KEY`;可在 dsh Web UI 的设置里配置,或于启动前导出该环境变量。
- 仅在 macOS(Apple Silicon)上验证过。打包配置目前只有 mac 目标,Windows 见下节。
- 应用为 ad-hoc 签名、未公证:首次打开需在"系统设置 → 隐私与安全性"里放行。

## Windows 支持(尚未实现)

上游 dsh **本身支持 Windows**(`@deepseek-ai/dsh` 无 `os` 限制,运行时自带
`dsh-pwsh-local`、`dsh-tool-pwsh`、`dsh-sandbox-windows-acl`)。障碍全在本壳:
整个代码库只有一处 `process.platform` 分支(`src/main.js` 的 macOS 应用菜单),
其余默认 POSIX。

### 现在在 Windows 上会怎样

`npm run dist` 会在 **predist 阶段就停住**,拿不到任何产物:

1. `scripts/prepare-seed.mjs` 的运行时路径写死为 `~/Library/Application Support/…`,
   在 Windows 上不存在 → 报 "No active local dsh runtime" 并 `exit 1`。
2. 即便跳过它,`scripts/prepare-node.mjs` 里 `findToolchain()` 找的是 `node`
   而非 `node.exe`,在 Windows 上找不到 Node。
3. 两个脚本都调 `/usr/bin/tar`(Win10 1803+ 的 `tar.exe` 在 System32,
   按名字调用即可,不能用绝对路径)。

绕过 `predist` 直接跑 `npx electron-builder --win dir` **能**打出一个 exe,
但那是拿 macOS 的 `seed.tar` 和 macOS 的 node 二进制打出来的包,装上去必然跑不起来。
`scripts/adhoc-sign.cjs` 已有平台守卫,不是障碍。

### 移植清单

| 位置 | 问题 | 需要的改动 |
|---|---|---|
| `src/server.js`(`detached` / `process.kill(-pid)`) | 负 PID 杀进程组是 POSIX 语义 | Windows 用 `taskkill /PID <pid> /T /F` 或 Job Object,否则退出后 dsh 及其子进程全成孤儿 |
| `src/runtime.js`、`src/toolchain.js` | `spawn('/usr/bin/tar', …)` | 改为按名字调用 `tar` |
| `src/toolchain.js` | 只找 `node`,只搜 homebrew / `/usr/local/bin` / `~/.nvm` | 加 `node.exe`、`%ProgramFiles%\nodejs`、nvm-windows |
| `scripts/prepare-node.mjs` | 复制 `bin/node` + `lib/node_modules/npm` | Windows 是根目录 `node.exe` + `node_modules\npm` |
| `scripts/prepare-seed.mjs` | 写死 macOS 数据目录 | 按平台取 `%APPDATA%` |
| `package.json` `build` | 只有 `mac` 目标 | 加 `win`(nsis/portable)与 `.ico` 图标 |
| `assets/trayTemplate*.png` | macOS 模板图(黑+alpha,由系统着色) | Windows 托盘需要彩色 `.ico` |

### 打包必须在 Windows 上做

本项目的打包模型是**快照打包机**:`seed.tar` 是本机装好的 dsh 运行时,
`node-runtime.tgz` 是本机的 Node 二进制。因此 Windows 包只能在 Windows 上打,
不能交叉打包——除非改成按目标平台下载官方 Node、并放弃离线种子(首启动联网装 dsh)。

**最需要真机验证的是进程组终止**:它属于"看起来能跑、实际留孤儿进程"那类问题,
只有在 Windows 上真正走一遍"退出应用 → 检查 dsh 及其子进程是否全部消失"才算数。

## 许可

本项目以 [MIT](LICENSE) 发布。

打包产物会再分发下列第三方组件,各自遵循其原许可,声明随包保留:

| 组件 | 许可 | 随包位置 |
|---|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`@deepseek-ai/dsh` 及其插件) | MIT | `Resources/runtime-seed.tar` |
| [Node.js](https://nodejs.org) | MIT | `Resources/node-runtime.tgz` → `LICENSE-node` |
| [npm](https://github.com/npm/cli) | Artistic-2.0 | 同上 → `lib/node_modules/npm/LICENSE` |
| [Electron](https://www.electronjs.org) | MIT | 应用框架 |

"DeepSeek" 是深度求索的商标。**本项目为非官方项目,与深度求索无隶属关系,也未获其背书。** 打包出的应用沿用 "DeepSeek Harness" 名称与鲸鱼图标以指明它承载的上游软件;这些标识的权利属于其所有者,不在本项目的 MIT 许可范围内。

## 从旧版本升级

项目原名 `dsh-shell`,数据目录也叫 `dsh-shell`。新版本首次启动会自动把
`~/Library/Application Support/dsh-shell` 改名为 `dsh-desktop`,已安装的运行时、
会话和设置原样保留。若目标目录已存在,则不合并、不覆盖,继续使用新目录并在日志里
记录旧目录位置。

应用的 `appId` 也随之改变,macOS 会将其视为另一个应用,**此前授予的系统权限
(如辅助功能)需要重新授予**。
