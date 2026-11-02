/**
 * setting modal
 */

import message from '../components/common/message'
import copy from 'json-deep-copy'
import {
  settingMap,
  settingCommonId,
  settingSyncId,
  modals
} from '../common/constants'
import { buildNewTheme } from '../common/terminal-theme'
import getInitItem from '../common/init-setting-item'
import newTerm from '../common/new-terminal'
import settingList from '../common/setting-list'
import { requireTermOfUse } from '../common/term-of-use'
import { requestUnlock } from '../common/vault-unlock'
import { vaultErrorText } from '../common/vault-ui'

const e = window.translate

const vaultOp = (action, arg) => window.pre.runGlobalAsync('vaultOp', action, arg)

export default Store => {
  Store.prototype.setConfig = function (conf) {
    const { store } = window
    Object.assign(
      store._config,
      copy(conf)
    )
    // 配置快照按版本缓存；写入后失效，auto 组件读版本即可重新渲染
    store._configVersion += 1
  }
  Store.prototype.setSftpSortSetting = function (conf) {
    Object.assign(
      window.store.sftpSortSetting,
      conf
    )
  }

  Store.prototype.openBookmarkEdit = function (item) {
    const { store } = window
    store.storeAssign({
      settingTab: settingMap.bookmarks
    })
    store.setSettingItem(item)
    store.openSettingModal()
    store.settingMobileView = 'content'
  }

  Store.prototype.handleOpenQuickCommandsSetting = function () {
    const { store } = window
    store.storeAssign({
      settingTab: settingMap.quickCommands
    })
    store.setSettingItem(getInitItem([], settingMap.quickCommands))
    store.openSettingModal()
  }

  Store.prototype.onSelectHistory = function (tab) {
    const { store } = window
    store.addTab({
      ...copy(tab),
      ...newTerm(true, true),
      batch: window.openTabBatch ?? store.currentLayoutBatch
    })
    delete window.openTabBatch
  }

  Store.prototype.onSelectBookmark = async function (id) {
    const { store } = window
    const bookmarks = store.bookmarks
    const item = copy(
      bookmarks.find(it => it.id === id)
    )
    if (!item) {
      return
    }
    // 锁定态下书签行里没有明文凭据（主进程只回 _sealed），所以所有连接入口先过这道门禁
    const status = await vaultOp('status').catch(() => null)
    if (status && status.ok !== false && status.enabled && !status.unlocked) {
      const ok = await requestUnlock()
      if (!ok) {
        message.warning(e('vaultNeedUnlockToConnect'))
        return
      }
    }
    if (item._sealed) {
      const r = await vaultOp('revealBookmark', { id }).catch(() => null)
      if (!r || !r.ok) {
        message.warning(vaultErrorText(r, e) || e('vaultNeedUnlockToConnect'))
        return
      }
      const secrets = r.secrets || {}
      Object.assign(item, secrets.top || {})
      // 跳板数组按 index 对齐：只合并两边都是对象的项，别把空位填成 null
      const hoppings = Array.isArray(secrets.hoppings) ? secrets.hoppings : []
      for (let i = 0; i < hoppings.length; i++) {
        const hop = hoppings[i]
        const target = item.connectionHoppings && item.connectionHoppings[i]
        if (hop && typeof hop === 'object' && target && typeof target === 'object') {
          Object.assign(target, hop)
        }
      }
    }
    // 内部标记不能带进 tab
    delete item._sealed
    store.addTab({
      ...item,
      from: 'bookmarks',
      srcId: item.id,
      ...newTerm(true, true),
      batch: window.openTabBatch ?? store.currentLayoutBatch
    })

    delete window.openTabBatch
  }

  Store.prototype.openSetting = function () {
    const { store } = window
    if (
      store.settingTab === settingMap.setting &&
      store.settingItem.id === settingCommonId &&
      store.showModal === modals.setting
    ) {
      return store.hideSettingModal()
    }
    store.settingTab = settingMap.setting
    store.setSettingItem(getInitItem([], settingMap.setting))
    store.openSettingModal()
  }

  Store.prototype.openSettingSync = function () {
    const { store } = window
    if (
      store.settingTab === settingMap.setting &&
      store.settingItem.id === settingList()[0].id &&
      store.showModal === modals.setting
    ) {
      return store.hideSettingModal()
    }
    requireTermOfUse('sync', () => {
      store.storeAssign({
        settingTab: settingMap.setting
      })
      store.setSettingItem(settingList().find(d => d.id === settingSyncId))
      store.openSettingModal()
      // on mobile, jump straight to the sync form instead of the menu list
      if (store.isMobile) {
        store.settingMobileView = 'content'
      }
    })
  }

  Store.prototype.openTerminalThemes = function () {
    const { store } = window
    if (
      store.settingTab === settingMap.terminalThemes &&
      store.settingItem.id === ''
    ) {
      return store.hideSettingModal()
    }
    store.storeAssign({
      settingTab: settingMap.terminalThemes
    })
    store.setSettingItem(buildNewTheme())
    store.openSettingModal()
  }

  Store.prototype.openTriggers = function () {
    const { store } = window
    store.storeAssign({
      settingTab: settingMap.triggers
    })
    store.setSettingItem({ id: '', name: settingMap.triggers })
    store.openSettingModal()
  }

  Store.prototype.openSettingModal = function () {
    const { store } = window
    if (store.isSecondInstance) {
      return message.warning(
        e('sencondInstanceTip')
      )
    }
    store.showModal = modals.setting
    // mobile always lands on the left col menu first
    store.settingMobileView = 'menu'
  }

  Store.prototype.backToSettingMenu = function () {
    window.store.settingMobileView = 'menu'
  }

  Store.prototype.hideSettingModal = function () {
    const { store } = window
    store.showModal = modals.hide
    store.setSettingItem({})
    // reset so a later open starts from the menu on mobile
    store.settingMobileView = 'menu'
  }

  Store.prototype.loadFontList = async function () {
    const fonts = await window.pre.runGlobalAsync('loadFontList')
      .catch(err => {
        console.log('loadFontList error', err)
        return []
      })
    window.et.fonts = fonts
  }

  Store.prototype.handleChangeSettingTab = function (settingTab) {
    const { store } = window
    const arr = store.getItems(settingTab)
    const item = getInitItem(arr, settingTab)
    store.storeAssign({
      settingTab
    })
    store.setSettingItem(item)
    // a new tab means a new menu to pick from on mobile
    store.settingMobileView = 'menu'
  }
}
