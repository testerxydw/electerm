/**
 * bookmark
 */

import uid from '../common/uid'
import message from '../components/common/message'

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
    // 主进程签名 testDbConnection(dbBookmark, sshBookmark)，多参数直传
    const res = await window.pre.runGlobalAsync('testDbConnection', bookmark, sshBookmark)
      .catch(err => {
        message.error(err.message)
        return null
      })
    if (res && res.ok) {
      message.success(res.message)
    }
  }

  Store.prototype.addSshConfigs = function (items) {
    const { store } = window

    const bookmarksToAdd = items.map(t => {
      return {
        term: 'xterm-256color',
        id: uid(),
        type: 'ssh',
        color: '#0088cc',
        ...t
      }
    })
    const ids = bookmarksToAdd.map(d => d.id)
    let sshConfigGroup = store.bookmarkGroups.find(d => d.id === 'sshConfig')
    if (!sshConfigGroup) {
      sshConfigGroup = {
        id: 'sshConfig',
        title: 'ssh configs',
        bookmarkIds: ids
      }
      store.addBookmarkGroup(sshConfigGroup)
    } else {
      store.editItem('sshConfig', {
        bookmarkIds: [
          ...ids,
          ...(sshConfigGroup.bookmarkIds || [])
        ]
      }, 'bookmarkGroups')
    }
    return store.addItems(bookmarksToAdd, 'bookmarks')
  }
}
