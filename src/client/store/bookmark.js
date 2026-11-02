/**
 * bookmark
 */

import uid from '../common/uid'
import clone from '../common/to-simple-obj'
import message from '../components/common/message'
import { settingMap } from '../common/constants'
import {
  changesBookmarkIdentity,
  findDuplicateBookmarks,
  pickNewBookmarks
} from '../common/bookmark-dedup'
import {
  mergeBookmarkIds,
  pickNewSshConfigItems,
  sourceField,
  sshConfigGroupId,
  sshConfigSource
} from '../common/ssh-config-import'

const e = window.translate

export default Store => {
  /**
   * 只读判重（界面上的 inline 提示要在写之前就说话，不能等写完才报错）。
   * `selfId` 是给改名用的：把自己排除掉，否则把书签 a 改回它自己的名字会被 a 拦住。
   * @returns {{ok: boolean, duplicates: Array}} duplicates 只回答"撞在哪几条"，
   *          怎么跟用户说由界面决定 —— 判据只活在 bookmark-dedup.js 一处。
   */
  Store.prototype.checkBookmark = function (item, { selfId } = {}) {
    const { store } = window
    const duplicates = findDuplicateBookmarks(item, store.bookmarks, selfId)
    return { ok: !duplicates.length, duplicates }
  }

  /**
   * 新建书签的唯一入口（查重口径见 bookmark-dedup.js：同名 + 同连接）。
   * 撞了就不写库，把结果原样回给调用方。`force` 是"我就要再来一条"的出口
   * （表单的「仍然创建」、右键复制）—— 复制的语义本来就是同一条连接的副本。
   */
  Store.prototype.addBookmark = function (item, { force = false } = {}) {
    const { store } = window
    if (!force) {
      const res = store.checkBookmark(item)
      if (!res.ok) {
        return res
      }
    }
    store.addItem(item, settingMap.bookmarks)
    return { ok: true, duplicates: [] }
  }

  /**
   * 改书签（改名也算）：判据要用**改完之后的形状** —— 只动标题时主机/端口还是原值，
   * 拿 updates 单独去比会把"改个名"当成"换了台机器"。
   */
  Store.prototype.editBookmark = function (id, updates, { force = false } = {}) {
    const { store } = window
    if (!force) {
      const current = store.bookmarks.find(b => b.id === id) || {}
      const after = { ...current, ...updates }
      if (changesBookmarkIdentity(current, after)) {
        const res = store.checkBookmark(after, { selfId: id })
        if (!res.ok) {
          return res
        }
      }
    }
    store.editItem(id, updates, settingMap.bookmarks)
    return { ok: true, duplicates: [] }
  }

  /**
   * 批量落库（文件导入这类）：默认跳过重复，把跳过的原样回给调用方报数。
   * 一条导入里逐条弹窗问"是否仍然创建"是没完的，所以这里只有"跳"和"不跳"，
   * 想全要就传 force（那就不判）。
   * @returns {{added: number, skipped: Array}}
   */
  Store.prototype.addBookmarks = function (items, { force = false } = {}) {
    const { store } = window
    if (force) {
      store.addItems(items, settingMap.bookmarks)
      return { added: items.length, skipped: [] }
    }
    const { fresh, skipped } = pickNewBookmarks(items, store.bookmarks)
    if (fresh.length) {
      store.addItems(fresh, settingMap.bookmarks)
    }
    return { added: fresh.length, skipped }
  }

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
