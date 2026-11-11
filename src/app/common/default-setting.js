/**
 * default setting
 */

module.exports = exports.default = {
  hotkey: 'Control+2',
  sshReadyTimeout: 50000,
  scrollback: 3000,
  onStartSessions: [],
  fontSize: 16,
  fontFamily: 'Maple Mono, mono, courier-new, courier, monospace',
  execWindows: 'System32/WindowsPowerShell/v1.0/powershell.exe',
  execMac: 'zsh',
  execLinux: 'bash',
  execWindowsArgs: [],
  execMacArgs: [],
  execLinuxArgs: [],
  enableGlobalProxy: false,
  disableConnectionHistory: false,
  disableTransferHistory: false,
  terminalBackgroundImagePath: '',
  terminalBackgroundCoverMode: false,
  terminalBackgroundFilterOpacity: 1,
  terminalBackgroundFilterBlur: 0,
  terminalBackgroundFilterBrightness: 1,
  terminalBackgroundFilterGrayscale: 0,
  terminalBackgroundFilterContrast: 1,
  rendererType: 'dom',
  terminalType: 'xterm-256color',
  keepaliveCountMax: 10,
  saveTerminalLogToFile: false,
  checkUpdateOnStart: true,
  cursorBlink: false,
  cursorStyle: 'block',
  useSystemTitleBar: false,
  opacity: 1,
  defaultEditor: '',
  terminalWordSeparator: './\\()"\'-:,.;<>~!@#$%^&*|+=[]{}`~ ?',
  confirmBeforeExit: false,
  initDefaultTabOnStart: true,
  restoreLastSession: true,
  screenReaderMode: false,
  autoRefreshWhenSwitchToSftp: false,
  addTimeStampToTermLog: false,
  keepaliveInterval: 10000,
  backspaceMode: '^?',
  shiftEnterMode: '\\n',
  showHiddenFilesOnSftpStart: true,
  terminalInfos: [
    'uptime',
    'cpu',
    'mem',
    'activities',
    'network',
    'disks'
  ],
  remoteMonitorBarEnabled: false,
  remoteMonitorBarItems: [
    'hostname',
    'cpu',
    'cpuHistory',
    'memory',
    'upload',
    'download',
    'uptime',
    'users',
    'disks'
  ],
  filePropsEnabled: [
    'name',
    'size',
    'modifyTime'
  ],
  hideIP: false,
  dataSyncSelected: 'all',
  nameAI: 'Infistar',
  baseURLAI: 'https://infistar.cc/v1',
  modelAI: 'deepseek-v4-flash',
  roleAI: '终端专家,提供不同系统下命令,简要解释用法,用markdown格式',
  apiPathAI: '/chat/completions',
  authHeaderNameAI: 'Authorization: Bearer',
  proxyAI: '',
  // 模型能不能收图片：auto = 看预置标注和模型名猜；on/off = 用户显式覆盖。
  // 判定只影响输入侧提示与发送前闸门，不构成任何保证（中转站改名后名字读不出来）
  supportsImageAI: 'auto',
  // 外部 MCP server 列表（见 doc/已完成/设计-MCP-client-P0-1-*.md §1 S13/S15）。
  // 整行落在 data 表 userConfig 里，因此跟着该行一起走 enc:/safeEncrypt 加密，
  // 不新建表（决策 D2-A）；默认空数组 = 未接入任何外部工具。
  mcpServersAI: [],
  sessionLogPath: '',
  // 会话录制 (T5-4f): 输出+键盘输入 / 剥离 shell 集成序列 / 密码提示自动避录
  recordInput: false,
  recordStripOsc: true,
  recordAvoidPassword: true,
  sshSftpSplitView: false,
  // 终端顶栏会话信息三段 (ssh2 算法 / zsh 版本 / ↑↓ 速率) 显隐, 顶栏图标可切换
  sessionBarInfoVisible: true,
  showCmdSuggestions: false,
  restoreTerminalSessionOnReload: false,
  startDirectoryLocal: '',
  allowMultiInstance: false,
  disableDeveloperTool: false,
  dragDropBehavior: 'ask',
  switchTabOnHover: false,
  autoDistributeTabsWhenLayoutChange: false,
  disableShortcutBar: false,
  onlyShowTitleInTab: false,
  disableConfirmForLargeClipboardContent: false,
  doubleClickToOpenBookmark: false,
  // getConfig() 以本文件作为 config.leftSideBarIcons 的初值，新装用户读到的是
  // 这份列表（客户端 default-setting.js 只用于「恢复默认」和表单占位）。
  // 所以新增可定制图标时这里必须同步补 id，否则新装/未持久化该键的用户看不到；
  // 本文件是 CommonJS，无法直接 import 客户端的 left-sidebar-icon-defs.js。
  // 沿用 4b260935 的口径：默认隐藏 newBookmark。
  leftSideBarIcons: [
    'bookmarks',
    'quickConnect',
    'terminalThemes',
    'setting',
    'settingSync',
    'widgets',
    'auditCenter'
  ]
}
