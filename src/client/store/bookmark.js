/**
 * bookmark
 */

import uid from '../common/uid'
import clone from '../common/to-simple-obj'
import message from '../components/common/message'
import {
  mergeBookmarkIds,
  pickNewSshConfigItems,
  sourceField,
  sshConfigGroupId,
  sshConfigSource
} from '../common/ssh-config-import'

const e = window.translate

export default Store => {
  Store.prototype.handleGetSerials = async function () {
    const { store } = window
    store.loaddingSerials = true
    const res = await window.pre.runGlobalAsync('listSerialPorts')
      .catch(store.onError)
    if (res) {
      store.serials = res
    }
    store.loaddingSerials = false
  }
  Store.prototype.setBookmarks = function (items) {
    return window.store.setItems('bookmarks', items)
  }

  Store.prototype.openBookmarks = function (ids) {
    const { store } = window
    ids.forEach(id => {
      store.onSelectBookmark(id)
    })
  }

  // 数据库书签：测试连接并 toast，不打开终端 tab
  Store.prototype.testDbConnection = async function (bookmark) {
    const { store } = window
    const sshBookmark = bookmark.sshTunnelBookmarkId
      ? (store.bookmarks || []).find(d => d.id === bookmark.sshTunnelBookmarkId)
      : null
    // 主进程签名 testDbConnection(dbBookmark, sshBookmark)，多参数直传。
    // store.bookmarks 是 mobx observable，直接过 IPC 会触发结构化克隆失败
    // （"An object could not be cloned"），必须先转普通对象 —— 与 openDbTab 同法。
    const res = await window.pre.runGlobalAsync(
      'testDbConnection',
      clone(bookmark),
      clone(sshBookmark)
    )
      .catch(err => {
        message.error(err.message)
        return null
      })
    if (res && res.ok) {
      message.success(res.message)
    }
  }

  /**
   * 导入本地 ssh 配置。点一次导入会新建一批 uid，所以先按
   * "host + port + user" 把重复的挡掉（见 ssh-config-import.js）：
   * 只挡 ssh 配置这条路，手工建的书签一律不动。
   * @returns {number} 真正新增的书签数
   */
  Store.prototype.addSshConfigs = function (items) {
    const { store } = window
    const sshConfigGroup = store.bookmarkGroups.find(d => d.id === sshConfigGroupId)
    const fresh = pickNewSshConfigItems(items, store.bookmarks, sshConfigGroup)
    if (!fresh.length) {
      message.info(e('sshConfigNothingNew'))
      return 0
    }
    const bookmarksToAdd = fresh.map(t => {
      return {
        term: 'xterm-256color',
        id: uid(),
        type: 'ssh',
        color: '#0088cc',
        ...t,
        [sourceField]: sshConfigSource
      }
    })
    const ids = bookmarksToAdd.map(d => d.id)
    if (!sshConfigGroup) {
      store.addBookmarkGroup({
        id: sshConfigGroupId,
        title: 'ssh configs',
        bookmarkIds: ids
      })
    } else {
      store.editItem(sshConfigGroupId, {
        bookmarkIds: mergeBookmarkIds(ids, sshConfigGroup.bookmarkIds)
      }, 'bookmarkGroups')
    }
    store.addItems(bookmarksToAdd, 'bookmarks')
    return bookmarksToAdd.length
  }
}
