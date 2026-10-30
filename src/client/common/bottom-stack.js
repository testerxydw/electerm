/**
 * 底栏避让的唯一和式（doc/分析-顶栏高度与底栏避让统一-2026-10-30.md §4.4）。
 *
 * 底部常显栈有四个可选层（footer / 监控条 / 钉住快捷命令带 / 快捷键条+软键盘），
 * 以前 JS 布局扣一次、6 个绝对定位浮层各自再手写一次子集，于是出现
 * ".sidebar-panel 只避让 footer，被快捷键条压住"这类漏项。
 *
 * 这里只做一次加法，派生值语义：
 *   belowFooter   .main-footer 的 bottom      —— 它上面的快捷键条 + 软键盘
 *   belowMonitor  .remote-monitor-bar 的 bottom —— 它上面的 footer + 快捷键条 + 软键盘
 *   reserved      侧栏 / 右面板 / 快捷命令带 / 全屏内容避让 —— 除快捷命令带外的全部常显层
 *   session       会话内容高（layout.jsx 唯一消费）—— reserved + 快捷命令带
 *
 * 纯函数、无副作用、默认值集中，可被 unit-ci 直接覆盖（同 remote-adapt.js 范式）。
 */
export function resolveBottomStack ({
  footer = 0,
  monitor = 0,
  qm = 0,
  shortcut = 0,
  kbOffset = 0
} = {}) {
  const belowFooter = shortcut + kbOffset
  const belowMonitor = footer + shortcut + kbOffset
  const reserved = footer + monitor + shortcut + kbOffset
  return { belowFooter, belowMonitor, reserved, session: reserved + qm }
}
