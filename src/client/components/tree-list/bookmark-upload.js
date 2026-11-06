/**
 * bookmark import/upload logic
 */

import copy from 'json-deep-copy'
import { uniq, isPlainObject } from 'lodash-es'
import { action } from 'manate'
import uid from '../../common/uid'
import time from '../../common/time'
import { fixBookmarks } from '../../common/db-fix'
import { findDuplicateBookmarks } from '../../common/bookmark-dedup'
import { runImportTask } from '../../common/import-task'
import { parseNcx } from '../../common/navicat-ncx'
import message from '../common/message'
import { collectUncategorizedBookmarks } from '../../common/bookmark-uncategorized'

const e = window.translate

function fixBookmarksId (bookmarks) {
  return bookmarks.map(item => {
    if (!isPlainObject(item)) {
      return null
    }
    if (!item.id) {
      item.id = uid()
    }
    return item
  }).filter(Boolean)
}

export const bookmarkUpload = action(async (file) => {
  const { store } = window
  const { bookmarks, bookmarkGroups } = store

  const txt = file.fileContent !== undefined
    ? file.fileContent
    : await window.fs.readFile(file.filePath)

  // Navicat .ncx 导出文件: 解析成 database bookmark 数组,
  // 之后复用下方 JSON 数组导入流程 (自动建 imported_ 分组)
  const isNcxFile = /\.ncx$/i.test(file.filePath || file.fileName || file.name || '')
  const content = isNcxFile ? await parseNcx(txt) : JSON.parse(txt)
  let bookmarkGroups1 = []
  let bookmarks1 = []
  if (Array.isArray(content)) {
    bookmarks1 = fixBookmarksId(content)
    bookmarkGroups1 = [{
      id: uid(),
      title: 'imported_' + time(),
      color: '#0088cc',
      bookmarkGroupIds: [],
      bookmarkIds: bookmarks1.map(b => b.id)
    }]
    // 与 UI 创建行为一致 (getColorFromCategory): 无色书签取所属分组颜色,
    // 否则列表里没有色点、与既有书签视觉不一致
    bookmarks1.forEach(b => {
      if (!b.color) {
        b.color = bookmarkGroups1[0].color
      }
    })
  } else {
    bookmarkGroups1 = content.bookmarkGroups || []
    bookmarks1 = fixBookmarksId(content.bookmarks || [])
  }

  const bookmarkGroups0 = copy(bookmarkGroups)
  const bookmarks0 = copy(bookmarks)

  const bmTree = new Map(
    bookmarks0.map(bookmark => [bookmark.id, bookmark])
  )
  const bmgTree = new Map(
    bookmarkGroups0.map(group => [group.id, group])
  )

  const fixed = fixBookmarks(bookmarks1)

  // 按块直推 store.bookmarks 是为了进度条（addBookmarks 一次性写完没有过程），
  // 但判重口径必须是同一个：id 相同只是"同一份数据再导一次"，
  // 同名同连接才是侧栏堆重复的来源（换台机器导出，id 就全变了）。
  const pool = [...bookmarks0]
  let skipped = 0

  const task = await runImportTask({
    title: e('import'),
    batch: 200,
    stopWatchers: ['bookmarks', 'bookmarkGroups'],
    steps: [
      {
        label: e('bookmarks'),
        items: fixed,
        process: (chunk) => {
          chunk.forEach(bg => {
            if (bmTree.has(bg.id)) {
              return
            }
            if (findDuplicateBookmarks(bg, pool).length) {
              skipped++
              return
            }
            pool.push(bg)
            store.bookmarks.push(bg)
          })
        }
      },
      {
        label: e('bookmarkCategory'),
        items: bookmarkGroups1,
        process: (chunk) => {
          chunk.forEach(bg => {
            if (!bmgTree.has(bg.id)) {
              store.bookmarkGroups.push(bg)
            } else {
              const bg1 = store.bookmarkGroups.find(
                b => b.id === bg.id
              )
              // a category is named by `title`; an imported file that names it
              // (and a category already in the store without one, e.g. written
              // by a widget that used `name`) leaves a blank node in the tree
              if (!bg1.title && bg.title) {
                bg1.title = bg.title
              }
              bg1.bookmarkIds = uniq(
                [
                  ...(bg1.bookmarkIds || []),
                  ...(bg.bookmarkIds || [])
                ]
              )
              bg1.bookmarkGroupIds = uniq(
                [
                  ...(bg1.bookmarkGroupIds || []),
                  ...(bg.bookmarkGroupIds || [])
                ]
              )
            }
          })
        }
      },
      {
        label: e('bookmarks'),
        weight: 1,
        run: () => {
          // bookmarks the file left uncategorized (all of them, for a bare
          // array) would be invisible in the sidebar: the tree is built from
          // the category references, so they need a category of their own
          action(() => {
            collectUncategorizedBookmarks(store.bookmarks, store.bookmarkGroups)
            store.fixBookmarkGroups()
          })()
        }
      }
    ]
  })

  // 一句汇总，不搞"每条一次弹窗"：导几百条时被问几百次和没提示一样难受
  if (skipped) {
    message.warning(skipped + ' ' + e('bookmarkDuplicatesSkipped'))
  }

  // callers that show the outcome (a widget offering bookmarks) need to know
  // whether anything was imported: a cancelled task and "another import is
  // already running" both end here without an exception
  return {
    ok: !task.cancelled && !task.error,
    cancelled: !!task.cancelled,
    error: task.error || null
  }
})

export async function beforeBookmarkUpload (file) {
  await bookmarkUpload(file)
  // antd Upload takes `false` as "do not send the file anywhere"; the import
  // itself already ran above
  return false
}
