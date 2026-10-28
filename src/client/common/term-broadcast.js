/**
 * G1 广播输入（设计 §14.2）：把主控终端的按键镜像到多个目标终端。
 *
 * 纯逻辑（可被 vm 单测直接执行）+ attach addon 注册表。终端类型白名单由
 * 调用方注入（store 侧传 constants.js 的 isShellSessionTab），本文件不 import
 * 任何依赖 window 的模块，保证 node 单测里可直接加载。
 */

// OSC 应答（`ESC ]` 开头，含 OSC 52 剪贴板、终端标题查询回复）只对本地有意义，
// 广播到别的机器轻则被当成垃圾输出、重则触发对方程序误动作。
const OSC_PREFIX = '\x1b]'
// DCS（`ESC P`，zmodem/kitty 图形协议）同理：应答属于本地终端。
const DCS_PREFIX = '\x1bP'

export function isOscResponse (data) {
  return typeof data === 'string' && (
    data.startsWith(OSC_PREFIX) || data.startsWith(DCS_PREFIX)
  )
}

// 只有可读文本输入参与镜像：onBinary 的鼠标上报、粘贴的二进制块没有跨机意义。
export function isMirrorableData (data) {
  return typeof data === 'string' && data.length > 0 && !isOscResponse(data)
}

export function isBroadcastSource (state, tabId) {
  return !!state && state.on === true && !!tabId && state.sourceTabId === tabId
}

/**
 * 是否允许本次输入扇出。三个闸门 + 防环：
 *  - 广播未开启 / 当前 tab 不是主控 / 没有目标
 *  - blocked（密码期暂停，store 侧置位）
 *  - 主控正处于密码提示（复用 addon 的 _passwordPromptDetected）
 *  - 本次调用是镜像转发（_broadcastDepth > 0）
 *  - 数据是 OSC/DCS 应答或非文本
 */
export function canMirror ({
  state,
  sourceTabId,
  data,
  passwordPrompt = false,
  depth = 0
} = {}) {
  if (!isBroadcastSource(state, sourceTabId)) {
    return false
  }
  if (state.blocked) {
    return false
  }
  if (depth > 0 || passwordPrompt) {
    return false
  }
  if (!Array.isArray(state.targets) || !state.targets.length) {
    return false
  }
  return isMirrorableData(data)
}

/**
 * 目标解析：只保留真实终端实例（shell 会话）的 tab，排除主控自身。
 * 结果对象带 title/host/isProduction，UI 与生产确认弹窗直接用。
 * isShellTab 由调用方注入（避免本模块依赖 constants.js 的 window 引用）。
 */
export function resolveBroadcastTargets (tabs, targetIds, sourceTabId, isShellTab) {
  const ids = new Set(Array.isArray(targetIds) ? targetIds : [])
  const out = []
  for (const tab of tabs || []) {
    if (!tab || !tab.id || tab.id === sourceTabId) {
      continue
    }
    if (!ids.has(tab.id)) {
      continue
    }
    if (typeof isShellTab === 'function' && !isShellTab(tab)) {
      continue
    }
    out.push({
      tabId: tab.id,
      title: tab.title || tab.host || tab.id,
      host: tab.host || '',
      isProduction: tab.production === true
    })
  }
  return out
}

export function productionTargets (targets) {
  return (targets || []).filter(d => d && d.isProduction)
}

// ---- addon 注册表 ----
// key = tab id；attach-addon-custom 在 activate 注册、dispose 注销。
// 镜像只走注册表里的真实连接，拿不到 addon 就等于目标没连上。
const addons = new Map()

export function registerBroadcastAddon (tabId, addon) {
  if (!tabId || !addon) {
    return
  }
  addons.set(tabId, addon)
}

export function unregisterBroadcastAddon (tabId, addon) {
  if (!tabId) {
    return
  }
  if (!addon || addons.get(tabId) === addon) {
    addons.delete(tabId)
  }
}

export function getBroadcastAddon (tabId) {
  return addons.get(tabId) || null
}

export function resetBroadcastAddons () {
  addons.clear()
}

/**
 * 扇出：对每个目标调用它自己的 sendToServer（保留其录制/密码/台头流量记账），
 * 用 _broadcastDepth 标记“这次是镜像”，目标侧因此不会再自行扇出（防环）。
 * 目标正处于密码提示时跳过：否则密码会打进对方机器的提示符。
 * 返回实际收到的 tab id 列表（单测/演示据此断言）。
 */
export function mirrorInput ({
  state,
  sourceTabId,
  data,
  passwordPrompt = false,
  depth = 0,
  getAddon = getBroadcastAddon
} = {}) {
  if (!canMirror({ state, sourceTabId, data, passwordPrompt, depth })) {
    return []
  }
  const sent = []
  for (const target of state.targets) {
    const addon = getAddon(target.tabId)
    if (!addon || addon.disposed) {
      continue
    }
    if (addon._passwordPromptDetected) {
      continue
    }
    addon._broadcastDepth = (addon._broadcastDepth || 0) + 1
    try {
      addon.sendToServer(data)
      sent.push(target.tabId)
    } finally {
      addon._broadcastDepth -= 1
    }
  }
  return sent
}
