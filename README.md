# dsh-shell

DeepSeek Harness 的桌面壳。壳本身不打包 dsh:它负责**环境安装、进程控制、存储控制**,并把 Web UI 装进一个窗口;dsh 本体通过 npm 独立安装与更新,壳与 dsh 的迭代完全解耦。

## 职责与设计

- **环境(双槽位更新)**:dsh 由 npm 安装到应用数据目录的 `runtime/slot-a|slot-b`,`current.json` 指向活跃槽。更新时装进闲置槽 → 起一个探针服务做启动自检 → 通过才切换指针,失败保留旧版可用。
- **进程**:启动窗口的同时 spawn `dsh web --port <随机空闲端口>`,轮询 HTTP 200 就绪后加载;子进程以独立进程组运行,退出应用时对整组发 SIGTERM(超时升级 SIGKILL),不留孤儿进程。关闭窗口即退出并停服(含 macOS)。
- **存储**:`DSH_HOME` 指向应用数据目录下的 `dsh-home`,profiles、会话、设置全部收归壳管理;菜单可直接打开数据目录与日志。
- **工具链**:壳查找用户机器上的 Node ≥ 22(PATH、nvm、Homebrew 常见路径),npm 以 `node npm-cli.js` 方式调用,避开 macOS GUI 应用不继承 shell PATH 的问题。

## 运行

```sh
npm install
npm start
```

首次启动会自动安装 `@deepseek-ai/dsh@latest`(需要网络,几分钟)。日志与数据在 `~/Library/Application Support/dsh-shell/`。

## 菜单

- **dsh → 检查更新**:双槽位更新流程,自检通过后询问是否重启服务。
- **dsh → 重启服务**:停掉当前服务进程组并以当前版本重启。
- **dsh → 打开数据目录 / 打开日志**。

## 已知边界

- dsh 处于 rc 阶段,壳依赖的契约刻意最小化:`dsh web --port N` + 根路径 200 即就绪。dsh 侧破坏性变更时优先检查这两点。
- 本地端口对本机进程可见(dsh 目前无鉴权 token);随机端口是缓解,不是根治。
- 对话依赖 `DEEPSEEK_API_KEY`;可在 dsh Web UI 的设置里配置,或于启动壳前导出该环境变量。
