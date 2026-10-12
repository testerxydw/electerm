/**
 * workspace related functions
 */

import {
  settingMap,
  lastWorkspaceKey
} from '../common/constants'
import getInitItem from '../common/init-setting-item'
import generate from '../common/uid'

export default Store => {
  /**
   * Get current workspace state (layout + tabs for each batch)
   */
  Store.prototype.getCurrentWorkspaceState = function () {
    const { store } = window
    const { layout, tabs } = store
    // Group tabs by batch and get bookmark srcIds
    const tabsByBatch = {}
    for (const tab of tabs) {
      const batch = tab.batch || 0
      if (!tabsByBatch[batch]) {
        tabsByBatch[batch] = []
      }
      // Store srcId (bookmark id) if available; local shell tabs (no host,
      // no bookmark) are recorded by type so they can be reopened with the
      // default shell. Temp ssh tabs (host but no srcId) need full connection
      // params + credentials and stay out of the snapshot.
      if (tab.srcId) {
        tabsByBatch[batch].push({
          srcId: tab.srcId,
          sshSftpSplitView: tab.sshSftpSplitView
        })
      } else if (!tab.host && (!tab.type || tab.type === 'local')) {
        tabsByBatch[batch].push({
          type: 'local'
        })
      }
    }
    return {
      layout,
      tabsByBatch
    }
  }

  /**
   * Save current workspace
   */
  Store.prototype.saveWorkspace = function (name, id = null) {
    const { store } = window
    const state = store.getCurrentWorkspaceState()
    const workspace = {
      id: id || generate(),
      name,
      ...state,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    if (id) {
      // Update existing
      store.editItem(id, workspace, settingMap.workspaces)
    } else {
      // Add new
      store.addItem(workspace, settingMap.workspaces)
    }
    return workspace
  }

  /**
   * Load a workspace - set layout and open tabs
   */
  Store.prototype.loadWorkspace = function (workspaceId) {
    const { store } = window
    const workspace = store.workspaces.find(w => w.id === workspaceId)
    if (!workspace) {
      return
    }
    store.openWorkspaceState(workspace)
  }

  /**
   * Open tabs from a workspace state object ({ layout, tabsByBatch }).
   * Shared by loadWorkspace and the last-session auto-restore.
   */
  Store.prototype.openWorkspaceState = function ({ layout, tabsByBatch }) {
    const { store } = window
    // Close all existing tabs first
    store.removeTabs(() => true)

    // Set layout
    store.setLayout(layout)
    // Open tabs for each batch
    for (const [batchStr, tabInfos] of Object.entries(tabsByBatch)) {
      const batch = parseInt(batchStr, 10)
      for (const tabInfo of tabInfos) {
        if (tabInfo.srcId) {
          // Open from bookmark
          window.openTabBatch = batch
          store.onSelectBookmark(tabInfo.srcId)
          // Apply saved sshSftpSplitView state to the newly created tab
          if (tabInfo.sshSftpSplitView !== undefined) {
            store.updateTab(store.activeTabId, {
              sshSftpSplitView: tabInfo.sshSftpSplitView
            })
          }
        } else if (tabInfo.type === 'local') {
          // Local shell tab: reopen with the default shell in its batch
          store.addTab(undefined, undefined, batch)
        }
      }
    }
  }

  /**
   * 自动保存当前会话快照 (layout + tabs: 书签来源按 srcId、本地 shell 按类型)
   * 到 localStorage, 退出前由 beforeExit 调用, 供下次启动恢复
   * (restoreLastWorkspace)。临时 ssh tab (host 无书签) 需完整连接参数,
   * 不在快照内。
   */
  Store.prototype.saveLastWorkspace = function () {
    const { store } = window
    try {
      window.localStorage.setItem(lastWorkspaceKey, JSON.stringify(store.getCurrentWorkspaceState()))
    } catch (e) {
      // localStorage 不可用/序列化失败时静默跳过, 不阻塞退出
    }
  }

  /**
   * 恢复上次会话快照, 成功返回 true (无快照/损坏返回 false)
   */
  Store.prototype.restoreLastWorkspace = function () {
    const { store } = window
    try {
      const raw = window.localStorage.getItem(lastWorkspaceKey)
      if (!raw) {
        return false
      }
      const state = JSON.parse(raw)
      // 空快照 (无可恢复的书签 tab) 走默认启动逻辑, 避免恢复后零 tab
      const hasTabs = !!state.tabsByBatch &&
        Object.values(state.tabsByBatch).some(list => list.length)
      if (!hasTabs) {
        return false
      }
      store.openWorkspaceState(state)
      return true
    } catch (e) {
      return false
    }
  }

  /**
   * Delete a workspace
   */
  Store.prototype.deleteWorkspace = function (id) {
    window.store.delItem({ id }, settingMap.workspaces)
  }

  /**
   * Open workspace settings
   */
  Store.prototype.openWorkspaceSettings = function () {
    const { store } = window
    store.storeAssign({
      settingTab: settingMap.workspaces
    })
    store.setSettingItem(getInitItem([], settingMap.workspaces))
    store.openSettingModal()
  }
}
