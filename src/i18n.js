/**
 * Shell localization.
 *
 * A module-level singleton rather than a value threaded through every call:
 * the shell is one process with one active language, and the alternative is
 * passing a translator into runtime and toolchain code whose errors surface in
 * dialogs.
 *
 * Deliberately imports nothing from Electron. `scripts/prepare-seed.mjs` loads
 * `runtime.js` under plain Node, so anything reachable from there must stay
 * free of Electron imports or packaging breaks.
 */

/** Selectable languages, in menu order. */
export const LOCALES = [
  { id: 'zh-CN', label: '中文' },
  { id: 'en', label: 'English' },
]

const MESSAGES = {
  'zh-CN': {
    // Menus and tray
    'menu.plugins': '插件管理…',
    'menu.settings': '设置',
    'menu.language': '语言',
    'menu.dataDir': '数据目录…',
    'menu.logDir': '日志目录…',
    'dialog.pickDataDir': '选择数据目录',
    'dialog.pickLogDir': '选择日志目录',
    'dialog.dataDirChanged': '数据目录已改为:\n{dir}',
    'dialog.dataDirDetail': '当前目录 {current} 里的运行时、会话与设置**不会**被自动搬移。若要保留它们,请退出应用后手动复制过去。\n\n新目录为空时,应用会像全新安装一样重新部署运行时。\n\n需要重启应用才能生效。',
    'dialog.logDirChanged': '日志目录已改为:\n{dir}',
    'dialog.logDirDetail': '旧日志文件保留在原处。新的日志立即写入新位置。',
    'button.restartApp': '重启应用',
    'button.restartLater': '稍后手动重启',
    'menu.checkUpdate': '检查更新',
    'menu.restartService': '重启服务',
    'menu.openDataDir': '打开数据目录',
    'menu.openLog': '打开日志',
    'menu.showWindow': '显示窗口',
    'menu.quit': '退出',
    'menu.main': '菜单',
    'menu.edit': '编辑',
    'menu.undo': '撤销',
    'menu.redo': '重做',
    'menu.cut': '剪切',
    'menu.copy': '复制',
    'menu.paste': '粘贴',
    'menu.selectAll': '全选',
    'tray.tooltip': 'DeepSeek Harness(dsh {version})',
    'tray.checking': '正在检查更新…',
    'tray.installing': '正在下载安装 dsh {version} · 已用 {elapsed}',
    'tray.verifying': '新版本启动自检中 · 已用 {elapsed}',
    'tray.title': '更新中 {elapsed}',
    'menu.updating': '更新进行中…',
    'window.plugins': '插件管理',

    // Buttons
    'button.retry': '重试',
    'button.quit': '退出',
    'button.restartService': '重启服务',
    'button.ignore': '忽略',
    'button.update': '更新',
    'button.cancel': '取消',
    'button.later': '稍后',

    // Dialogs
    'dialog.startFailed': '启动失败',
    'dialog.startFailedDetail': '服务可能只是启动较慢(首次安装或磁盘繁忙时)。',
    'dialog.serverExited': 'dsh 服务已退出({cause})',
    'dialog.gaveUp': '已连续自动重启 {count} 次仍未稳定。',
    'dialog.autoRestartFailed': '自动重启失败:{message}',
    'dialog.restartFailed': '重启失败',
    'dialog.updateFailed': '更新失败',
    'dialog.settingFailed': '设置失败',
    'dialog.upToDate': '已是最新版本({version})。',
    'dialog.updateAvailable': '发现新版本 dsh {latest}',
    'dialog.updateAvailableDetail': '当前版本 {current}。下载并安装需要几分钟;新版本通过启动自检后才会切换,失败则保留当前版本。',
    'dialog.updateBusy': '更新已在进行中,请等待完成。',
    'dialog.updated': '已更新到 dsh {version}',
    'dialog.updatedDetail': '重启服务以使用新版本?未完成的对话会被中断。',
    'dialog.logPath': '日志:{path}',

    // Errors that reach the user through a dialog
    'error.notReady': '服务在超时时间内未就绪(端口 {port})。',
    'error.selfTestFailed': '新版本 {version} 启动自检失败,保留当前版本。',
    'error.checkFailed': '无法查询最新版本:{message}',
    'error.pluginBusy': '另一个插件操作正在进行,请稍候',
    'error.pnpmMissing': '未找到 pnpm。dsh 通过 pnpm 管理 profile 插件,请先安装(npm i -g pnpm)再重试。',
    'error.pluginExit': 'dsh plugin 退出码 {code}\n{tail}',
    'error.noNode': '未找到 Node.js >= {major}。请安装 Node.js(https://nodejs.org)后重新启动本应用。',
    'error.npmExit': 'npm install 退出码 {code}',
    'error.npmNoPackage': 'npm install 完成但未找到已安装的 dsh 包',
    'error.seedExit': '种子解包退出码 {code}',
    'error.seedIncomplete': '内置运行时种子不完整,无法部署',
    'error.configProbeTimeout': '读取插件配置项超时',
    'error.configProbeOutput': '无法读取 {name} 的配置描述(探针输出异常)',

    // Plugin manager window
    'plugins.title': '插件管理',
    'plugins.heading': '插件管理',
    'plugins.specPlaceholder': 'npm 包名 / github:user/repo#commit / 本地绝对路径',
    'plugins.install': '安装',
    'plugins.hint': 'Web UI 皮肤、面板等也是插件,同样方式安装。git 直装若被 pnpm 拦下,按日志提示在 profile 的 pnpm-workspace.yaml 里放行后重试。',
    'plugins.restartNotice': '配置已变更,重启服务后生效(未完成的对话会中断)',
    'plugins.loading': '加载中…',
    'plugins.empty': '还没有安装插件',
    'plugins.badgeActive': '已启用',
    'plugins.badgeInactive': '仅依赖',
    'plugins.settings': '设置',
    'plugins.remove': '卸载',
    'plugins.cancel': '取消',
    'plugins.save': '保存配置',
    'plugins.configTitle': '{name} 配置',
    'plugins.default': '默认: {value}',
    'plugins.done': '{label} 完成',
    'plugins.failed': '{label} 失败: {message}',
    'plugins.pageError': '页面错误: {message}',
    'plugins.actionFailed': '操作失败: {message}',
    'plugins.noChannel': '当前运行的应用还没有配置通道:请从托盘菜单退出应用后重新打开(仅重启服务不够)',
    'plugins.readConfigFailed': '读取 {name} 配置项失败: {message}',
    'plugins.noFields': '{name} 没有可配置项',
    'plugins.noRow': '{name} 的 bundle patch 未插入与包同名的插件行,无法定位配置目标',
    'plugins.saveConfig': '保存 {name} 配置',
    'plugins.installing': '安装 {spec}',
    'plugins.hasConfig': '{name} 提供配置项,请填写',
    'plugins.newConfigFailed': '读取新插件配置项失败: {message}',
    'plugins.restarting': '重启服务…',
    'plugins.restarted': '服务已重启,插件已生效',
    'plugins.restartFailed': '重启失败: {message}',
    'plugins.removing': '卸载 {name}',

    // Loading window
    'loading.starting': '正在启动 DeepSeek Harness…',
    'loading.hint': '首次启动会下载并安装 dsh 运行时,可能需要几分钟',
  },

  en: {
    'menu.plugins': 'Plugins…',
    'menu.settings': 'Settings',
    'menu.language': 'Language',
    'menu.dataDir': 'Data Directory…',
    'menu.logDir': 'Log Directory…',
    'dialog.pickDataDir': 'Choose a data directory',
    'dialog.pickLogDir': 'Choose a log directory',
    'dialog.dataDirChanged': 'Data directory changed to:\n{dir}',
    'dialog.dataDirDetail': 'The runtime, sessions and settings in {current} are **not** moved for you. To keep them, quit the app and copy them across yourself.\n\nIf the new directory is empty, the app redeploys the runtime as it would on a fresh install.\n\nThe app must restart for this to take effect.',
    'dialog.logDirChanged': 'Log directory changed to:\n{dir}',
    'dialog.logDirDetail': 'Existing log files stay where they are. New lines go to the new location immediately.',
    'button.restartApp': 'Restart Now',
    'button.restartLater': 'Restart Later',
    'menu.checkUpdate': 'Check for Updates',
    'menu.restartService': 'Restart Service',
    'menu.openDataDir': 'Open Data Directory',
    'menu.openLog': 'Open Log',
    'menu.showWindow': 'Show Window',
    'menu.quit': 'Quit',
    'menu.main': 'Menu',
    'menu.edit': 'Edit',
    'menu.undo': 'Undo',
    'menu.redo': 'Redo',
    'menu.cut': 'Cut',
    'menu.copy': 'Copy',
    'menu.paste': 'Paste',
    'menu.selectAll': 'Select All',
    'tray.tooltip': 'DeepSeek Harness (dsh {version})',
    'tray.checking': 'Checking for updates…',
    'tray.installing': 'Downloading dsh {version} · {elapsed} elapsed',
    'tray.verifying': 'Verifying the new version starts · {elapsed} elapsed',
    'tray.title': 'Updating {elapsed}',
    'menu.updating': 'Update in progress…',
    'window.plugins': 'Plugins',

    'button.retry': 'Retry',
    'button.quit': 'Quit',
    'button.restartService': 'Restart Service',
    'button.ignore': 'Ignore',
    'button.update': 'Update',
    'button.cancel': 'Cancel',
    'button.later': 'Later',

    'dialog.startFailed': 'Startup failed',
    'dialog.startFailedDetail': 'The server may simply be slow to start — a first install, or a busy disk.',
    'dialog.serverExited': 'The dsh server exited ({cause})',
    'dialog.gaveUp': 'Still failing after {count} automatic restarts.',
    'dialog.autoRestartFailed': 'Automatic restart failed: {message}',
    'dialog.restartFailed': 'Restart failed',
    'dialog.updateFailed': 'Update failed',
    'dialog.settingFailed': 'Setting failed',
    'dialog.upToDate': 'Already up to date ({version}).',
    'dialog.updateAvailable': 'dsh {latest} is available',
    'dialog.updateAvailableDetail': 'You have {current}. Downloading and installing takes a few minutes; the new version is switched to only after it passes a startup self-test, and a failure keeps the current one.',
    'dialog.updateBusy': 'An update is already running; wait for it to finish.',
    'dialog.updated': 'Updated to dsh {version}',
    'dialog.updatedDetail': 'Restart the server to use the new version? Conversations in progress will be interrupted.',
    'dialog.logPath': 'Log: {path}',

    'error.notReady': 'The server did not become ready in time (port {port}).',
    'error.selfTestFailed': 'Version {version} failed its startup self-test; keeping the current version.',
    'error.checkFailed': 'Could not look up the latest version: {message}',
    'error.pluginBusy': 'Another plugin operation is running; please wait',
    'error.pnpmMissing': 'No pnpm found. dsh manages profile plugins through pnpm — install it (npm i -g pnpm) and try again.',
    'error.pluginExit': 'dsh plugin exited with code {code}\n{tail}',
    'error.noNode': 'No Node.js >= {major} found. Install Node.js (https://nodejs.org) and start this app again.',
    'error.npmExit': 'npm install exited with code {code}',
    'error.npmNoPackage': 'npm install finished but the dsh package is not there',
    'error.seedExit': 'seed extraction exited with code {code}',
    'error.seedIncomplete': 'the bundled runtime seed is incomplete and cannot be deployed',
    'error.configProbeTimeout': 'timed out reading the plugin config schema',
    'error.configProbeOutput': 'could not read the config schema for {name} (unexpected probe output)',

    'plugins.title': 'Plugins',
    'plugins.heading': 'Plugins',
    'plugins.specPlaceholder': 'npm package / github:user/repo#commit / absolute local path',
    'plugins.install': 'Install',
    'plugins.hint': 'Web UI themes and panels are plugins too, installed the same way. If a direct git install is refused by pnpm, allow it in the profile\'s pnpm-workspace.yaml as the log says, then retry.',
    'plugins.restartNotice': 'Configuration changed; restart the server to apply it (conversations in progress will be interrupted)',
    'plugins.loading': 'Loading…',
    'plugins.empty': 'No plugins installed yet',
    'plugins.badgeActive': 'active',
    'plugins.badgeInactive': 'dependency only',
    'plugins.settings': 'Settings',
    'plugins.remove': 'Remove',
    'plugins.cancel': 'Cancel',
    'plugins.save': 'Save',
    'plugins.configTitle': '{name} configuration',
    'plugins.default': 'default: {value}',
    'plugins.done': '{label} done',
    'plugins.failed': '{label} failed: {message}',
    'plugins.pageError': 'page error: {message}',
    'plugins.actionFailed': 'action failed: {message}',
    'plugins.noChannel': 'The running app has no config channel yet: quit it from the tray menu and open it again (restarting the server is not enough)',
    'plugins.readConfigFailed': 'could not read the config schema for {name}: {message}',
    'plugins.noFields': '{name} has nothing to configure',
    'plugins.noRow': '{name}\'s bundle patch inserts no plugin row named after the package, so there is no config target',
    'plugins.saveConfig': 'saving {name} configuration',
    'plugins.installing': 'installing {spec}',
    'plugins.hasConfig': '{name} has configuration options to fill in',
    'plugins.newConfigFailed': 'could not read the new plugin\'s config schema: {message}',
    'plugins.restarting': 'restarting the server…',
    'plugins.restarted': 'server restarted; plugins are live',
    'plugins.restartFailed': 'restart failed: {message}',
    'plugins.removing': 'removing {name}',

    'loading.starting': 'Starting DeepSeek Harness…',
    'loading.hint': 'The first launch downloads and installs the dsh runtime, which can take a few minutes',
  },
}

const FALLBACK = 'en'
let current = FALLBACK

/** Whether a locale id is one this shell actually carries messages for. */
export function isSupported(id) {
  return Object.hasOwn(MESSAGES, id)
}

/**
 * Picks the closest supported locale for a system locale string, so a fresh
 * install opens in the user's own language rather than a default.
 * @param {string} [systemLocale] e.g. Electron's `app.getLocale()`
 */
export function resolveLocale(systemLocale) {
  const tag = String(systemLocale ?? '')
  if (isSupported(tag)) return tag
  if (tag.toLowerCase().startsWith('zh')) return 'zh-CN'
  return FALLBACK
}

/** @param {string} id one of {@link LOCALES} */
export function setLocale(id) {
  current = isSupported(id) ? id : FALLBACK
  return current
}

export function getLocale() {
  return current
}

/**
 * Translates a key, substituting `{name}` placeholders.
 *
 * An unknown key returns the key itself: a visible `menu.whatever` in the UI
 * is a bug report, where silently returning an empty string would just look
 * like a rendering glitch.
 *
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 */
export function t(key, params) {
  const template = MESSAGES[current]?.[key] ?? MESSAGES[FALLBACK][key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name) => (
    Object.hasOwn(params, name) ? String(params[name]) : whole
  ))
}

/** Every message for the active locale, for handing to a renderer in one go. */
export function messages() {
  return { ...MESSAGES[FALLBACK], ...MESSAGES[current] }
}
