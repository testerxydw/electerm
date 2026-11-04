/**
 * P-3（2026-11-04 拍板"只做连接状态点"）：历史行的连接状态点
 *
 * 纯视觉，不动数据模型：
 * - 不往 `store.history` 的条目里写任何字段（history 条目本来就没有 id/srcId，
 *   `store/tab.js` 落历史时把 `tabPropertiesExcludes` 全删掉了）；
 * - 不给 tab 加状态；
 * - 每次渲染从 `store.tabs` 现算一张「连接键 → 状态」表，历史行按同一把键查。
 *
 * 连接键复用 `bookmark-dedup.bookmarkConnKey` —— 那是本仓"这条连接指向哪台机器"的
 * 既有权威口径（ssh/telnet/ftp/rdp/vnc/spice/serial/web + database 各有字段表，
 * 端口按协议补默认，ssh 空用户名按 root）。判不了的目标（本地终端、关键字段缺失）
 * 返回空串 → 那一行不画点：宁可不画，也不把"说不清"画成"没连"。
 */
import { bookmarkConnKey } from './bookmark-dedup.js'

/**
 * 会点亮的那几个状态，名字与 `common/constants.js` 里的 `statusMap` 同一批字符串
 * （页签条 `.tab-status` 也只在这三种状态下变色）。这里不 import constants：那个模块
 * 在 node 侧 import 不了（它带 .png 资源），而本模块要能在单测里直接跑。
 * 镜像由 history-conn-status.spec.js 的源码守卫钉住 —— 将来 statusMap 改名，红的是它。
 */
const LIT = {
  success: 3,
  processing: 2,
  error: 1
}

/**
 * 同一个连接目标上开着多个页签时，点只有一颗，取"最能说明它开着"的那条：
 * 已连上 > 正在连 > 连不上。
 */
function rank (status) {
  return LIT[status] || 0
}

/**
 * @param {Array} tabs store.tabs（含其它窗格/批次的页签，与书签树那颗点同一口径）
 * @returns {Map<string, string>} 连接键 → 该目标当前最"亮"的状态
 */
export function openStatusByConn (tabs) {
  const map = new Map()
  for (const tab of tabs || []) {
    if (!tab) continue
    const status = tab.status
    const r = rank(status)
    if (!r) continue
    const key = bookmarkConnKey(tab)
    if (!key) continue
    const held = map.get(key)
    if (!held || r > rank(held)) {
      map.set(key, status)
    }
  }
  return map
}

/**
 * 历史条目（`item.tab`，一份去掉 id/srcId 的连接快照）当前有没有开着的会话。
 * @returns {string} 状态名；'' = 没有开着的会话，或这条判不了连接键
 */
export function historyConnStatus (itemTab, openMap) {
  if (!itemTab || !openMap || !openMap.size) {
    return ''
  }
  const key = bookmarkConnKey(itemTab)
  return key ? openMap.get(key) || '' : ''
}
