/**
 * G1 广播输入（设计 §14.2）的 store 侧状态与生命周期。
 *
 * 状态 shape：
 *   broadcast = { on, sourceTabId, targets: [{tabId,title,host,isProduction}], blocked }
 * 镜像是"当前主控这一份输入扇出到 N 个目标"，所以同一时刻只有一个主控；
 * 目标集合在开启时快照，终止/断连时增删。
 */
import message from '../components/common/message'
import { refs } from '../components/common/ref'
import { isShellSessionTab } from '../common/constants'
import {
  resolveBroadcastTargets,
  productionTargets
} from '../common/term-broadcast'

const e = window.translate

const emptyBroadcast = () => ({
  on: false,
  sourceTabId: '',
  targets: [],
  blocked: null
})

function setBroadcast (next) {
  const { store } = window
  store.broadcast = next
}

function focusSource (tabId) {
  refs.get('term-' + tabId)?.term?.focus?.()
}

export default Store => {
  // 右键/顶栏/快捷键的统一入口：广播中 → 退出；未开启 → 打开目标选择
  Store.prototype.toggleBroadcast = function () {
    const { store } = window
    if (store.broadcast.on) {
      return store.stopBroadcast()
    }
    store.openBroadcastPicker()
  }

  Store.prototype.openBroadcastPicker = function () {
    const { store } = window
    const tab = store.currentTab
    if (!tab || !isShellSessionTab(tab)) {
      return message.warning(e('broadcastNoSession'))
    }
    store.broadcastPickerOpen = true
  }

  Store.prototype.closeBroadcastPicker = function () {
    window.store.broadcastPickerOpen = false
  }

  // targetIds 来自弹层多选；生产机确认由弹层在调用前完成
  Store.prototype.startBroadcast = function (targetIds) {
    const { store } = window
    const sourceTabId = store.activeTabId
    const targets = resolveBroadcastTargets(
      store.tabs,
      targetIds,
      sourceTabId,
      isShellSessionTab
    )
    if (!targets.length) {
      return message.warning(e('broadcastNoTarget'))
    }
    store.broadcastPickerOpen = false
    setBroadcast({ on: true, sourceTabId, targets, blocked: null })
    message.success(
      e('broadcastStarted').replace('{n}', String(targets.length))
    )
    focusSource(sourceTabId)
  }

  Store.prototype.stopBroadcast = function (silent) {
    const { store } = window
    const wasOn = store.broadcast.on
    setBroadcast(emptyBroadcast())
    store.broadcastPickerOpen = false
    if (wasOn && !silent) {
      message.info(e('broadcastStopped'))
    }
  }

  // 主控进入密码提示时由 addon 上报，红条改文案并暂停镜像
  Store.prototype.setBroadcastBlocked = function (kind) {
    const { store } = window
    const cur = store.broadcast
    if (!cur.on || !kind || cur.blocked === kind) {
      return
    }
    setBroadcast({ ...cur, blocked: kind })
  }

  Store.prototype.clearBroadcastBlocked = function () {
    const { store } = window
    const cur = store.broadcast
    if (!cur.blocked) {
      return
    }
    setBroadcast({ ...cur, blocked: null })
  }

  // 目标连接断开（addon dispose）：移出目标集并提示；主控断开则整场结束。
  // tab 已被关闭（store.tabs 里不存在）时视为用户主动关页，不报断连提示。
  Store.prototype.onBroadcastAddonClosed = function (tabId) {
    const { store } = window
    const cur = store.broadcast
    if (!cur.on || !tabId) {
      return false
    }
    const tabAlive = store.tabs.some(t => t.id === tabId)
    if (cur.sourceTabId === tabId) {
      store.stopBroadcast(true)
      if (tabAlive) {
        message.warning(e('broadcastSourceLost'))
      }
      return true
    }
    const target = cur.targets.find(t => t.tabId === tabId)
    if (!target) {
      return false
    }
    const targets = cur.targets.filter(t => t.tabId !== tabId)
    setBroadcast({ ...cur, targets })
    if (!targets.length) {
      store.stopBroadcast(true)
      message.warning(e('broadcastNoTargetsLeft'))
      return true
    }
    if (tabAlive) {
      message.info(
        e('broadcastTargetLost').replace('{title}', target.title || target.tabId)
      )
    }
    return true
  }

  // 关闭 tab（store.delTab）时同步收敛广播态；与 addon dispose 幂等
  Store.prototype.onBroadcastTabClosed = function (tabId) {
    const { store } = window
    const cur = store.broadcast
    if (!cur.on || !tabId) {
      return false
    }
    if (cur.sourceTabId === tabId) {
      store.stopBroadcast(true)
      message.warning(e('broadcastSourceClosed'))
      return true
    }
    if (!cur.targets.some(t => t.tabId === tabId)) {
      return false
    }
    store.onBroadcastAddonClosed(tabId)
    return true
  }

  // 弹层默认目标：全部非生产 shell 会话（排除主控）
  Store.prototype.defaultBroadcastTargetIds = function () {
    const { store } = window
    return store.tabs
      .filter(t => isShellSessionTab(t) && t.id !== store.activeTabId)
      .filter(t => t.production !== true)
      .map(t => t.id)
  }

  // 供弹层展示：当前可选目标（shell 会话，排除主控）
  Store.prototype.getBroadcastCandidates = function () {
    const { store } = window
    return store.tabs.filter(
      t => isShellSessionTab(t) && t.id !== store.activeTabId
    )
  }

  Store.prototype.broadcastHasProduction = function (tabIds) {
    const { store } = window
    return productionTargets(
      resolveBroadcastTargets(
        store.tabs,
        tabIds,
        store.activeTabId,
        isShellSessionTab
      )
    )
  }
}
