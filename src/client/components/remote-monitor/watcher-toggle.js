/**
 * Switching a watcher on or off from a filter control.
 *
 * The watcher belongs to the bookmark, and the open tab only holds a copy taken
 * when the session started, so both have to be written: the bookmark for the
 * next connection (and the bookmark form), the tab for what is on screen now.
 */
import { toggleWatcher } from '../../common/custom-watcher'

export function setWatcherEnabled (tab, id) {
  if (!tab) {
    return
  }
  const watchers = toggleWatcher(tab.watchers, id)
  tab.watchers = watchers
  // a tab opened from history or by MCP has no bookmark behind it
  if (!tab.srcId) {
    return
  }
  // 本地卡点契约：bookmarks 的写入一律走 editBookmark（判重 + 身份变更短路），
  // 不能直接用 editItem 绕过，见 bookmark-dedup.spec.js
  window.store.editBookmark(tab.srcId, { watchers })
}
