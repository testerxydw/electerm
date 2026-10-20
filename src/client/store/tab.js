/**
 * tabs related functions
 */

import { debounce, isEqual } from 'lodash-es'
import {
  splitConfig,
  splitLayoutMap,
  statusMap,
  paneMap,
  maxHistory,
  isShellSessionTab
} from '../common/constants'
import { clearSessionInfo } from '../common/session-bar-data'
import { refs, refsTabs } from '../components/common/ref'
import message from '../components/common/message'
import * as ls from '../common/safe-local-storage'
import deepCopy from 'json-deep-copy'
import generate from '../common/id-with-stamp'
import uid from '../common/uid'
import newTerm, { updateCount } from '../common/new-terminal.js'
import { action } from 'manate'
import { shouldCaptureTerminalReloadState } from '../components/terminal/ssh-reload-state.js'
import dangerousSessionFields from '../common/dangerous-session-fields'
import { distributeTabsEvenly } from '../common/distribute-tabs'

const e = window.translate

// 批量输入目标兜底：优先当前 tab（须为 shell 会话 tab），否则取第一个 shell
// tab；无 shell tab 返回空串（选中集允许为空，执行端遍历为 no-op）
function pickBatchInputFallbackId (tabs, activeTabId) {
  const active = tabs.find(t => t.id === activeTabId)
  if (active && isShellSessionTab(active)) {
    return activeTabId
  }
  return tabs.find(t => isShellSessionTab(t))?.id || ''
}

function captureSshSessionState (tab, config) {
  return shouldCaptureTerminalReloadState(tab, config)
    ? refs.get(`term-${tab.id}`)?.getReloadState?.()
    : undefined
}

export default Store => {
  Store.prototype.nextTabCount = function () {
    return updateCount()
  }

  Store.prototype.getTabs = function () {
    return window.store.tabs
  }

  // 会话 socket 是否仍活着（WS OPEN 且组件未卸载）
  function isSessionAlive (tab) {
    const ref = refs.get(`term-${tab.id}`)
    return !!(ref && ref.socket && ref.socket.readyState === 1 && !ref.onClose)
  }

  Store.prototype.setOffline = function () {
    const { store } = window
    store.tabs.forEach(tab => {
      if (!tab.host || tab.status === statusMap.error) {
        return
      }
      // 浏览器 offline 事件存在误报（网卡抖动/网络饱和时的连通性探测失败），
      // 而 ssh/pty 会话走本地子进程不受其影响 —— 仅对 socket 已死的会话标记
      // 连接失败，活着的会话保持原状态
      if (!isSessionAlive(tab)) {
        tab.status = statusMap.error
      }
    })
  }

  // offline 误报恢复：网络回来后，socket 仍活着却被误标"连接失败"的会话复位
  Store.prototype.restoreOnline = function () {
    const { store } = window
    store.tabs.forEach(tab => {
      if (tab.host && tab.status === statusMap.error && isSessionAlive(tab)) {
        tab.status = statusMap.success
      }
    })
  }

  Store.prototype.updateTabsStatus = function () {
    const { store } = window
    const tabIdSet = new Set(
      store.fileTransfers.map(d => d.tabId)
    )
    store.tabs.forEach(tab => {
      const t = tabIdSet.has(tab.id)
      if (Boolean(tab.isTransporting) !== t) {
        tab.isTransporting = t
      }
    })
  }

  Store.prototype.setTabs = function (list) {
    window.store.tabs = list
  }

  Store.prototype.delTab = function (id) {
    const { store } = window
    const tab = store.tabs.find(t => t.id === id)
    const batch = tab ? Number(tab.batch) : undefined
    const res = store.removeTabs({ id })
    store.autoClosePaneIfEmpty(batch)
    // 顶栏会话数据随 tab 移除 (common/session-bar-data.js)
    clearSessionInfo(id)
    return res
  }

  Store.prototype.closeTabsRight = function (id) {
    const { store } = window
    const { tabs } = store
    const targetTab = tabs.find(t => t.id === id)
    if (!targetTab) {
      return
    }
    const targetBatch = targetTab.batch
    const targetIndex = tabs.findIndex(t => t.id === id)

    // Remove all tabs in the same batch that are to the right
    for (let i = tabs.length - 1; i > targetIndex; i--) {
      const closingTab = tabs[i]
      if (closingTab.batch === targetBatch) {
        // Handle current tab closure
        if (closingTab.id === store.activeTabId) {
          store.activeTabId = id
        } else if (closingTab.id === store[`activeTabId${targetBatch}`]) {
          store[`activeTabId${targetBatch}`] = id
        }

        tabs.splice(i, 1)
      }
    }
  }

  Store.prototype.reloadTab = function (tabId = window.store.activeTabId) {
    const { store } = window
    const { tabs } = store
    const index = tabs.findIndex(t => t.id === tabId)

    // If tab not found, do nothing
    if (index === -1) {
      return
    }

    const oldTab = tabs[index]
    const oldBatch = oldTab.batch

    // Reload state is captured only for a shell terminal refresh/reconnect
    // (ssh, local, telnet, serial). Closing a tab goes through removeTabs
    // and never reaches this code path.
    const reloadState = captureSshSessionState(oldTab, store.config)

    // Create copy of old tab with new ID
    const newTab = {
      ...oldTab,
      tabCount: store.nextTabCount(),
      id: generate(), // Need to create new ID
      status: statusMap.processing // Reset status
    }
    delete newTab._reloadState
    // Keepalive is per-session runtime state (the toolbar heartbeat icon /
    // MCP set_electerm_terminal_keepalive), not a connection property: a
    // reloaded session starts with a fresh terminal that is not sending
    // keepalives, so the flag must not be carried over.
    delete newTab.keepaliveEnabled
    if (reloadState) {
      newTab._reloadState = reloadState
    }

    // Add new tab at next index
    tabs.splice(index + 1, 0, newTab)
    store.updateHistory(newTab)

    // Remove old tab
    tabs.splice(index, 1)

    // Update active tab id synchronously (same as addTab) so the new tab's
    // container is already visible (display:block) by the time its Terminal
    // mounts. Deferring this via setTimeout(0) left the container hidden at
    // mount time, causing the initial fit()/createTerm() to use xterm's
    // default 80x24 size instead of the real fitted size - which then got
    // baked into the remote pty and only partially corrected later, leaving
    // full-screen apps like tmux/vim rendering at the wrong size.
    if (store.activeTabId === tabId) {
      store.activeTabId = newTab.id
    }

    // Update batch current tab ID if needed
    const batchProp = `activeTabId${oldBatch}`
    if (store[batchProp] === tabId) {
      store[batchProp] = newTab.id
    }

    return newTab
  }

  Store.prototype.reloadAllTabs = function () {
    const { store } = window
    const { tabs } = store
    // Reload all tabs with a small delay between each to avoid conflicts
    tabs.forEach((tab, index) => {
      setTimeout(() => {
        store.reloadTab(tab.id)
      }, index * 100) // 100ms delay between each reload
    })
  }

  Store.prototype.duplicateTab = function (tabId) {
    const { store } = window
    const { tabs } = store

    // Find the target tab and its index
    const targetIndex = tabs.findIndex(t => t.id === tabId)
    if (targetIndex === -1) {
      return
    }

    const sourceTab = tabs[targetIndex]
    const sessionState = captureSshSessionState(sourceTab, store.config)
    const duplicatedTab = {
      ...deepCopy(sourceTab),
      id: generate(),
      tabCount: store.nextTabCount(),
      status: statusMap.processing,
      isTransporting: undefined
    }
    delete duplicatedTab._reloadState
    // see reloadTab: keepalive is per-session runtime state, never inherited
    delete duplicatedTab.keepaliveEnabled
    if (sessionState) {
      duplicatedTab._reloadState = sessionState
    }

    // Insert the duplicated tab after the source tab
    tabs.splice(targetIndex + 1, 0, duplicatedTab)
    store.updateHistory(duplicatedTab)

    // Set the duplicated tab as current
    store.activeTabId = duplicatedTab.id
    store[`activeTabId${sourceTab.batch}`] = duplicatedTab.id
  }

  // only toggles the flag: the tabs bar renders pinned tabs first,
  // store.tabs order itself is never changed by pinning
  Store.prototype.pinTab = function (tabId, isPinned = true) {
    const { store } = window
    const tab = store.tabs.find(t => t.id === tabId)
    if (!tab || Boolean(tab.isPinned) === isPinned) {
      return
    }
    tab.isPinned = isPinned
  }

  Store.prototype.closeOtherTabs = function (id) {
    const { store } = window
    const { tabs } = store
    const targetTab = tabs.find(t => t.id === id)
    if (!targetTab) {
      return
    }
    const currentBatch = targetTab.batch

    for (let i = tabs.length - 1; i >= 0; i--) {
      const tab = tabs[i]
      if (tab.batch === currentBatch && tab.id !== id) {
        if (tab.id === store.activeTabId) {
          store.activeTabId = id
        }
        if (tab.id === store[`activeTabId${currentBatch}`]) {
          store[`activeTabId${currentBatch}`] = id
        }
        tabs.splice(i, 1)
      }
    }
  }

  Store.prototype.removeTabs = function (condition) {
    const { tabs } = window.store
    const removedIds = []

    // 关闭被移除的数据库连接（如有）
    const closeRemovedDb = (tab) => {
      if (tab.type === 'database') {
        window.pre.runGlobalAsync('closeDbTab', tab.id).catch(() => {})
      }
    }
    if (typeof condition === 'function') {
      for (let i = tabs.length - 1; i >= 0; i--) {
        const tab = tabs[i]
        if (condition(tab, i)) {
          closeRemovedDb(tab)
          removedIds.push(tab.id)
          tabs.splice(i, 1)
        }
      }
    } else {
      const keys = Object.keys(condition)
      if (keys.length === 1) {
        const key = keys[0]
        const value = condition[key]
        for (let i = tabs.length - 1; i >= 0; i--) {
          const tab = tabs[i]
          if (tab[key] === value) {
            closeRemovedDb(tab)
            removedIds.push(tab.id)
            tabs.splice(i, 1)
          }
        }
      } else {
        for (let i = tabs.length - 1; i >= 0; i--) {
          let match = true
          const tab = tabs[i]
          for (const key in condition) {
            if (tab[key] !== condition[key]) {
              match = false
              break
            }
          }
          if (match) {
            closeRemovedDb(tab)
            removedIds.push(tab.id)
            tabs.splice(i, 1)
          }
        }
      }
    }

    if (removedIds.length) {
      window.store.fixCurrentTabIds(tabs, removedIds)
    }
  }

  Store.prototype.fixCurrentTabIds = function (remainingTabs, removedIds) {
    const store = window.store
    const removedSet = new Set(removedIds)
    const batchFirstTabs = {}
    const currentIdNeedFix = removedSet.has(store.activeTabId)
    const copiedTabs = remainingTabs.map(t => ({
      id: t.id,
      batch: t.batch,
      tabCount: t.tabCount
    })).sort((a, b) => b.tabCount - a.tabCount)
    // Get first valid tab for each batch
    for (const tab of copiedTabs) {
      if (!batchFirstTabs[tab.batch]) {
        batchFirstTabs[tab.batch] = tab.id
      }
    }

    // If current tab was removed, we need to set a new one
    if (currentIdNeedFix) {
      // Try to find current batch's first tab
      const currentTab = remainingTabs.find(t => t.id === store.activeTabId)
      const currentBatch = currentTab ? currentTab.batch : store.currentLayoutBatch
      const newCurrentId = batchFirstTabs[currentBatch] || batchFirstTabs[0] || ''

      if (newCurrentId) {
        store.activeTabId = newCurrentId
        // Also update the batch-specific current tab id
        store[`activeTabId${currentBatch}`] = newCurrentId
      } else {
        // No tabs left in any batch
        store.activeTabId = ''
      }
    }

    // Fix batch-specific current tab IDs
    for (const batch in batchFirstTabs) {
      const batchTabId = `activeTabId${batch}`
      const currentBatchId = store[batchTabId]

      // If the batch's current tab was removed or doesn't exist
      if (removedSet.has(currentBatchId) || !currentBatchId) {
        store[batchTabId] = batchFirstTabs[batch]
      }
    }
    store.focus()
  }

  Store.prototype.initFirstTab = function (batch) {
    const { store } = window
    if (batch !== undefined) {
      const newTab = newTerm()
      newTab.batch = batch // Set batch number
      store.addTab(newTab)
      return
    }
    const { layout } = store
    const batchCount = splitConfig[layout].children || 1
    for (let i = 0; i < batchCount; i++) {
      const newTab = newTerm()
      newTab.batch = i // Set batch number
      store.addTab(newTab)
    }
  }

  Store.prototype.updateTab = function (id, update) {
    const { store } = window
    const { tabs } = store

    // Find the target tab
    const targetIndex = tabs.findIndex(t => t.id === id)
    if (targetIndex === -1) {
      return
    }
    // Directly update the tab properties
    Object.assign(tabs[targetIndex], update)
  }

  Store.prototype.clickTab = function (id, batch) {
    const { store } = window

    // Update current batch
    store.currentLayoutBatch = batch

    // Update current tab id
    store.activeTabId = id

    // Update batch-specific current tab id
    store[`activeTabId${batch}`] = id
  }

  Store.prototype.addTab = function (
    newTab = newTerm(),
    index,
    batch
  ) {
    if (
      (!newTab.type || newTab.type === 'local') &&
      !newTab.host &&
      !window.store.hasNodePty
    ) {
      if (window.et.isWebApp || window.et.hideLocalTerminal) {
        return
      }
      return message.warning(
        'local terminal is not supported, due to node-pty not working in this build'
      )
    }
    const { store } = window
    const { tabs } = store
    newTab.tabCount = store.nextTabCount()
    // Sanitize batch: MCP/AI callers may pass a missing, string, or
    // out-of-range batch which would crash Sessions (sizes[batch]
    // undefined). Clamp to a valid pane index for the current layout.
    let batchNum = batch ?? newTab.batch ?? window.openTabBatch ?? window.store.currentLayoutBatch
    batchNum = Number(batchNum)
    const maxBatch = (splitConfig[store.layout] && splitConfig[store.layout].children) || 1
    if (!Number.isInteger(batchNum) || batchNum < 0 || batchNum >= maxBatch) {
      batchNum = Number(window.store.currentLayoutBatch) || 0
      if (!Number.isInteger(batchNum) || batchNum < 0 || batchNum >= maxBatch) {
        batchNum = 0
      }
    }
    newTab.batch = batchNum
    // Keepalive is per-session runtime state set by the toolbar heartbeat
    // icon / MCP set_electerm_terminal_keepalive on an already-open tab.
    // Every path that creates a tab (history replay, bookmark open, MCP
    // open_tab, clone-to-layout) funnels through here, so strip it once:
    // a brand-new tab must not render as keepalive-on while its terminal
    // is not actually sending keepalives.
    delete newTab.keepaliveEnabled
    if (!newTab.id) {
      newTab.id = generate()
    }
    if (!newTab.status) {
      newTab.status = statusMap.processing
    }
    if (!newTab.pane) {
      newTab.pane = paneMap.terminal
    }
    if (typeof index === 'number' && index >= 0 && index <= tabs.length) {
      tabs.splice(index, 0, newTab)
    } else {
      tabs.push(newTab)
    }
    store[`activeTabId${batchNum}`] = newTab.id
    store.activeTabId = newTab.id
    store.currentLayoutBatch = batchNum
    store.updateHistory(newTab)
  }

  Store.prototype.ipcOpenTab = function (parsed) {
    const safeTab = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => !dangerousSessionFields.includes(key))
    )
    return window.store.addTab(safeTab)
  }

  Store.prototype.clickNextTab = debounce(function () {
    window.store.clickBioTab(1)
  }, 100)

  Store.prototype.clickPrevTab = debounce(function () {
    window.store.clickBioTab(-1)
  }, 100)

  Store.prototype.clickBioTab = function (diff) {
    const { store } = window
    const { tabs, activeTabId } = store

    // Find the current tab index and its batch
    const currentIndex = tabs.findIndex(t => t.id === activeTabId)

    if (currentIndex === -1) {
      return // Current tab not found, do nothing
    }

    const currentBatch = tabs[currentIndex].batch

    // Function to find the next valid tab index
    const findNextTabIndex = (startIndex, direction) => {
      let nextIndex = startIndex
      do {
        nextIndex = (nextIndex + direction + tabs.length) % tabs.length
        if (tabs[nextIndex].batch === currentBatch) {
          return nextIndex
        }
      } while (nextIndex !== startIndex)
      return -1 // No other tabs in the same batch
    }

    // Find the next tab index
    const nextIndex = findNextTabIndex(currentIndex, diff)

    // If a valid next tab is found, update the activeTabId
    if (nextIndex !== -1 && nextIndex !== currentIndex) {
      store.activeTabId = tabs[nextIndex].id
      store[`activeTabId${currentBatch}`] = tabs[nextIndex].id
    }
  }

  Store.prototype.cloneToNextLayout = function (tab = window.store.currentTab) {
    if (!tab) {
      return
    }
    const { store } = window
    const defaultStatus = statusMap.processing
    const { layout, currentLayoutBatch } = store
    const ntb = deepCopy(tab)
    const sessionState = captureSshSessionState(tab, store.config)
    Object.assign(ntb, {
      id: generate(),
      status: defaultStatus,
      isTransporting: undefined,
      pane: paneMap.terminal
    })
    delete ntb._reloadState
    if (sessionState) {
      ntb._reloadState = sessionState
    }
    let maxBatch = splitConfig[layout].children
    if (maxBatch < 2) {
      maxBatch = 2
    }
    ntb.batch = (currentLayoutBatch + 1) % maxBatch
    if (layout === 'c1') {
      store.setLayout('c2', false)
    }
    store.addTab(ntb)
  }

  // 拆分会话: 当前 tab 迁移到新 pane (同一个会话, 终端历史保留), 其余 tab 留在原 pane
  // direction: 'h'=水平分栏(左右), 'v'=垂直分行(上下)
  Store.prototype.splitTab = function (direction = 'h') {
    const { store } = window
    const tab = store.currentTab
    if (!tab) {
      return
    }
    const curLayout = store.layout
    const targetLayout = splitLayoutMap[curLayout]?.[direction]
    if (!targetLayout || targetLayout === curLayout) {
      return message.warning(e('cannotSplitFurther'))
    }
    const newBatch = splitConfig[targetLayout].children - 1
    // 切 layout, 禁止 distributeTabs 自动重分配, 我们自己放
    store.setLayout(targetLayout, false)
    // 只改 batch, tab 本体不动: 同一个 id/term 实例, 滚动历史跟着走
    tab.batch = newBatch
    store[`activeTabId${newBatch}`] = tab.id
    store.activeTabId = tab.id
    store.currentLayoutBatch = newBatch
    // 原 pane 失去 active tab, 修正各 pane 的 activeTabId
    store.fixActiveTabIds(splitConfig[targetLayout].children)
  }

  // 迁移 tab 到指定 pane (targetBatch 从 0 开始), 同 layout 内跨 pane 移动, 终端历史保留
  Store.prototype.moveTabToPane = function (tabId, targetBatch) {
    const { store } = window
    const tab = store.tabs.find(t => t.id === tabId)
    if (!tab || tab.batch === targetBatch) {
      return
    }
    const fromBatch = Number(tab.batch)
    tab.batch = targetBatch
    store[`activeTabId${targetBatch}`] = tab.id
    store.activeTabId = tab.id
    store.currentLayoutBatch = targetBatch
    // 原 pane 失去 active tab, 修正各 pane 的 activeTabId
    store.fixActiveTabIds(splitConfig[store.layout].children)
    // 原 pane 被搬空则自动收起（配置开关）
    store.autoClosePaneIfEmpty(fromBatch)
  }

  // Spread tabs over the panes of a layout with more panes.
  // Only used when leaving the single layout: once more than one pane is on
  // screen the arrangement is the user's, and is left alone.
  Store.prototype.distributeTabs = function (newCount) {
    const { store } = window
    const { tabs } = store
    if (tabs.length < 2) {
      return
    }
    // contiguous chunks keep the tab order: [A B C D E] -> [A B] [C D] [E]
    const batches = distributeTabsEvenly(tabs.length, newCount)
    tabs.forEach((t, i) => {
      t.batch = batches[i]
    })
  }

  // make sure every pane has a valid active tab
  Store.prototype.fixActiveTabIds = function (count) {
    const { store } = window
    for (let b = 0; b < count; b++) {
      const inBatch = store.tabs.filter(t => t.batch === b)
      const key = `activeTabId${b}`
      if (!inBatch.some(t => t.id === store[key])) {
        store[key] = inBatch.length ? inBatch[0].id : ''
      }
    }
    const active = store.tabs.find(t => t.id === store.activeTabId)
    if (active) {
      store[`activeTabId${active.batch}`] = active.id
      store.currentLayoutBatch = active.batch
    }
  }

  Store.prototype.setLayout = function (layout, redistribute = true) {
    const { store } = window
    const prevLayout = store.layout
    const { activeTabId } = store

    // If layout hasn't changed, do nothing
    if (prevLayout === layout) {
      return store.focus()
    }

    // Update layout related properties
    store.prevLayout = prevLayout
    ls.setItem('layout', layout)
    store.layout = layout

    // Get the number of batches in new and previous layouts
    const newBatchCount = splitConfig[layout].children
    const prevBatchCount = prevLayout ? splitConfig[prevLayout].children : 0

    // If new layout has fewer batches, we need to adjust tabs
    if (newBatchCount < prevBatchCount) {
      const nb = newBatchCount - 1
      // Directly modify tabs that exceed the new batch count
      for (let i = 0; i < store.tabs.length; i++) {
        const tab = store.tabs[i]
        if (tab.batch >= newBatchCount) {
          store.tabs[i].batch = nb
          if (tab.id === activeTabId) {
            store[`activeTabId${nb}`] = activeTabId
          }
        }
      }

      // Adjust currentLayoutBatch if needed
      if (store.currentLayoutBatch >= newBatchCount) {
        store.currentLayoutBatch = newBatchCount - 1
      }
    } else if (
      redistribute &&
      store.config.autoDistributeTabsWhenLayoutChange &&
      prevBatchCount === 1 &&
      newBatchCount > 1
    ) {
      // leaving the single layout: hand the tabs out evenly
      store.distributeTabs(newBatchCount)
      store.fixActiveTabIds(newBatchCount)
    }
    store.focus()
  }

  // 关闭一个「空窗格」：剩余窗格按序紧凑重排，并降级到与之匹配的布局。
  // 布局是固定枚举（common/constants.js 的 splitConfig），没有"缺角"形态，
  // 所以关掉任意一格后只能线性化重排（见 doc/设计-分屏空窗格关闭方案.md）
  Store.prototype.closePane = function (batchIndex) {
    const { store } = window
    const { tabs, layout } = store
    const total = (splitConfig[layout] && splitConfig[layout].children) || 1
    if (total <= 1) {
      return
    }
    // 防御：只允许关闭空窗格
    if (tabs.some(t => Number(t.batch) === batchIndex)) {
      return
    }
    // 1) 收集仍有 tab 的窗格（按序），把它们紧凑重排到 0..k-1。
    //    必须在 setLayout 之前完成：setLayout 会把越界 batch 收拢到最后一格，
    //    先调用会破坏这里的相对顺序
    const keep = []
    for (let b = 0; b < total; b++) {
      if (b !== batchIndex && tabs.some(t => Number(t.batch) === b)) {
        keep.push(b)
      }
    }
    keep.forEach((oldBatch, j) => {
      tabs.forEach(t => {
        if (Number(t.batch) === oldBatch) {
          t.batch = j
        }
      })
    })
    // 2) 目标布局 = 剩余窗格数 + 原布局方向（r 开头为上下，其余为左右）
    const k = keep.length
    const rowFirst = String(layout || '').startsWith('r')
    const targetMap = rowFirst
      ? { 1: 'c1', 2: 'r2', 3: 'r3' }
      : { 1: 'c1', 2: 'c2', 3: 'c3' }
    const target = targetMap[k] || (k >= 4 ? 'c2x2' : 'c1')
    // 3) 清掉高位窗格的 activeTabId，再按重排后的 batch 重新指派
    for (let i = 0; i < 3; i++) {
      store[`activeTabId${i}`] = ''
    }
    tabs.forEach(t => {
      const b = Number(t.batch)
      if (!store[`activeTabId${b}`]) {
        store[`activeTabId${b}`] = t.id
      }
    })
    store.currentLayoutBatch = Math.min(store.currentLayoutBatch, Math.max(0, k - 1))
    store.setLayout(target, false)
  }

  // 自动收起空窗格（配置开关 autoCloseEmptyPane，默认关）。
  // 窗格**失去最后一个 tab** 后调用（关闭、右键迁移、拖拽到别的窗格都算）：
  // 该窗格确实空了就收起它（等价于点「关闭此窗格」）；
  // 若全部 tab 都没了，则直接回到单窗格（多格只剩空占位没有意义）。
  // ⚠️ 拆分会话（splitTab）不要调用：它刻意把 tab 迁到新窗格、原窗格留空
  Store.prototype.autoClosePaneIfEmpty = function (batch) {
    const { store } = window
    if (
      !store.config.autoCloseEmptyPane ||
      batch === undefined ||
      batch === null
    ) {
      return
    }
    const total = (splitConfig[store.layout] && splitConfig[store.layout].children) || 1
    if (total <= 1 || store.tabs.some(t => Number(t.batch) === batch)) {
      return
    }
    if (store.tabs.length) {
      store.closePane(batch)
    } else {
      store.setLayout('c1', false)
    }
  }

  Store.prototype.changeActiveTabId = function (id) {
    const { store } = window
    const { tabs } = store
    const tab = tabs.find(t => t.id === id)
    if (!tab) {
      return
    }
    store.activeTabId = id
    store[`activeTabId${tab.batch}`] = id
    store.focus()
  }

  Store.prototype.updateHistory = function (tab) {
    if (
      !tab.type &&
      !tab.host
    ) {
      return
    }
    const { store } = window
    if (store.config.disableConnectionHistory) {
      return
    }
    const tabPropertiesExcludes = [
      'id',
      'from',
      'srcId',
      'status',
      'pane',
      'batch',
      'tabCount',
      'sftpCreated',
      'sshSftpSplitView',
      'sshTunnelResults',
      'displayRaw',
      'autoReConnect',
      '_reloadState',
      'isPinned'
    ]
    const { history } = store
    const index = history.filter(d => d.id && d.tab).findIndex(d => {
      for (const key in tab) {
        if (tabPropertiesExcludes.includes(key)) {
          continue
        }
        if (!isEqual(d.tab[key], tab[key])) {
          return false
        }
      }
      return true
    })
    if (index === -1) {
      const copiedTab = deepCopy(tab)
      tabPropertiesExcludes.forEach(d => {
        delete copiedTab[d]
      })
      return history.unshift({
        tab: copiedTab,
        time: Date.now(),
        count: 1,
        id: uid()
      })
    }
    const match = history[index]
    match.count = (match.count || 0) + 1
    match.time = Date.now()
    action(function () {
      const [m] = history.splice(index, 1)
      history.unshift(m)
      if (history.length > maxHistory) {
        history.pop()
      }
    })()
  }

  Store.prototype.updateBatchInputSelectedTabIds = function () {
    const { store } = window
    if (!store._batchInputSelectedTabIds.has(store.activeTabId)) {
      // 当前 tab 非 shell 会话（database/vnc 等，无终端实例）时保持原选中集，
      // 不得把无终端实例的 tab 设为批量输入目标
      if (isShellSessionTab(store.currentTab)) {
        store._batchInputSelectedTabIds = new Set([store.activeTabId])
      }
    }
  }

  Store.prototype.onSelectBatchInputSelectedTabId = action(function (id) {
    const { store } = window
    const { _batchInputSelectedTabIds } = store
    if (_batchInputSelectedTabIds.has(id)) {
      _batchInputSelectedTabIds.delete(id)
    } else {
      _batchInputSelectedTabIds.add(id)
    }
    if (_batchInputSelectedTabIds.size === 0) {
      const fallbackId = pickBatchInputFallbackId(store.tabs, store.activeTabId)
      if (fallbackId) {
        _batchInputSelectedTabIds.add(fallbackId)
      }
    }
  })

  Store.prototype.filterBatchInputSelectedTabIds = action(function () {
    const { store } = window
    const { _batchInputSelectedTabIds, tabs } = store
    // 只保留存在且支持批量输入的 tab（白名单口径见 constants.js
    // isShellSessionTab），database/rdp 等无终端实例的 tab 不得留在选中集
    const validTabIds = new Set(
      tabs.filter(isShellSessionTab).map(tab => tab.id)
    )

    // Filter out invalid tab IDs
    for (const id of _batchInputSelectedTabIds) {
      if (!validTabIds.has(id)) {
        _batchInputSelectedTabIds.delete(id)
      }
    }

    // If no valid tabs are selected, add the fallback shell tab
    if (_batchInputSelectedTabIds.size === 0) {
      const fallbackId = pickBatchInputFallbackId(tabs, store.activeTabId)
      if (fallbackId) {
        _batchInputSelectedTabIds.add(fallbackId)
      }
    }
  })

  Store.prototype.selectAllBatchInputTabs = function () {
    const { store } = window
    const { tabs } = store
    // 全选同样只圈 shell 会话 tab（database/rdp 等无终端实例，选了发不出去）
    store._batchInputSelectedTabIds = new Set(
      tabs.filter(isShellSessionTab).map(tab => tab.id)
    )
  }

  Store.prototype.selectNoneBatchInputTabs = action(function () {
    const { store } = window
    store._batchInputSelectedTabIds.clear()
    // Ensure at least the active tab is selected
    store._batchInputSelectedTabIds.add(store.activeTabId)
  })

  Store.prototype.notifyTabOnData = function (tabId) {
    const tab = refsTabs.get('tab-' + tabId)
    if (tab) {
      tab.notifyOnData()
    }
  }

  Store.prototype.notifyTabPasswordPrompt = function (tabId) {
    const tab = refsTabs.get('tab-' + tabId)
    if (tab) {
      tab.notifyPasswordPrompt()
    }
  }

  Store.prototype.clearTabPasswordPrompt = function (tabId) {
    const tab = refsTabs.get('tab-' + tabId)
    if (tab) {
      tab.clearPasswordPrompt()
    }
  }

  Store.prototype.remoteList = function (tabId) {
    const sftp = refs.get('sftp-' + tabId)
    if (sftp) {
      sftp.remoteListDebounce()
    }
  }

  Store.prototype.localList = function (tabId) {
    const sftp = refs.get('sftp-' + tabId)
    if (sftp) {
      sftp.localListDebounce()
    }
  }
}
