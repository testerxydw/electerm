/**
 * 「查看重复书签」清单（B 批 B4）
 *
 * 判重口径与创建时完全同一个（bookmark-dedup.js：同名 + 同连接），
 * 这里只负责"把存量重复摊开给人看，删哪几条由人决定"：
 * 不自动合并、不自动删、不替用户挑哪条"更正确" —— 两条一模一样的书签，
 * 只有用户知道留哪条。默认勾选"除第一条外的其余条"，改勾选就是改主意。
 */
import React, { useState } from 'react'
import { Button, Checkbox, Empty, Modal, Tag, Tooltip } from 'antd'
import { settingMap } from '../../common/constants'
import { groupDuplicateBookmarks, describeBookmarkTarget } from '../../common/bookmark-dedup'

const e = window.translate

export default function DuplicateBookmarksModal ({
  open,
  bookmarks,
  bookmarkGroups,
  onClose
}) {
  // 只存"用户显式改过"的行；没改过的沿用默认（第一条留、其余勾），
  // 这样删完一轮或又新建了重复时，默认会自己跟上，不会把勾选状态冻在旧名单上
  const [picks, setPicks] = useState({})
  const groups = groupDuplicateBookmarks(bookmarks)
  // 书签自己不带分组信息（表单提交时 category 会被摘掉），分组只存在于
  // bookmarkGroups[].bookmarkIds 里 —— 要显示"这条挂在哪个分类下"就得反查
  const groupTitleOf = (id) => {
    const g = (bookmarkGroups || []).find(x => (x.bookmarkIds || []).includes(id))
    return g ? g.title : ''
  }
  const willDelete = (item, index) => {
    return item.id in picks ? picks[item.id] : index > 0
  }
  const selectedItems = groups.reduce((acc, g) => acc.concat(
    g.items.filter((it, i) => willDelete(it, i))
  ), [])
  const selected = selectedItems.map(it => it.id)
  const total = groups.reduce((n, g) => n + g.items.length, 0)

  const handleDelete = () => {
    if (!selected.length) {
      return
    }
    const { store } = window
    // 设置面板可能正开着其中一条：先走既有的"删完把选中项收回去"，
    // 否则左边没了、右边还在编辑一条已经不存在的书签
    selectedItems.forEach(it => store.onDelItem(it, settingMap.bookmarks))
    store.delItems(selected, settingMap.bookmarks)
    // 分组里残留的 id 交给既有的收口清（书签导入也走它），不在这里另写一份
    store.fixBookmarkGroups()
    setPicks({})
    onClose()
  }

  const handleEdit = (item) => {
    // "删一条"之外的另一条出路：同名同连接才算重复，改个名字就分开了
    onClose()
    window.store.openBookmarkEdit(item)
  }

  const footer = (
    <div className='dup-modal-foot'>
      <span className='dup-modal-foot-tip'>
        {e('dupBookmarkKeepTip')}
      </span>
      <span>
        <Button onClick={onClose}>{e('close')}</Button>
        <Button
          type='primary'
          danger
          disabled={!selected.length}
          onClick={handleDelete}
          className='mg1l dup-modal-del'
        >
          {e('deleteSelected')} ({selected.length})
        </Button>
      </span>
    </div>
  )

  return (
    <Modal
      open={open}
      title={`${e('dupBookmarks')} (${total})`}
      width={680}
      onCancel={onClose}
      footer={footer}
      className='dup-bookmarks-modal'
    >
      {
        groups.length
          ? groups.map(g => (
            <div className='dup-group' key={g.key}>
              <div className='dup-group-head'>
                <span className='dup-group-title'>{g.title}</span>
                <span className='dup-group-target'>{g.target}</span>
                <Tag>{g.items.length}</Tag>
              </div>
              {
                g.items.map((it, i) => {
                  const del = willDelete(it, i)
                  const group = groupTitleOf(it.id)
                  return (
                    <div
                      className={'dup-row' + (del ? ' dup-row-del' : '')}
                      key={it.id}
                      data-bk-id={it.id}
                    >
                      <Checkbox
                        checked={del}
                        onChange={ev => setPicks({ ...picks, [it.id]: ev.target.checked })}
                      />
                      <span className='dup-row-name'>{it.title}</span>
                      <span className='dup-row-meta'>{describeBookmarkTarget(it)}</span>
                      {
                        group
                          ? <span className='dup-row-group'>{group}</span>
                          : null
                      }
                      <Tooltip title={e('dupBookmarkEditTip')}>
                        <Button
                          size='small'
                          type='link'
                          className='dup-row-edit'
                          onClick={() => handleEdit(it)}
                        >
                          {e('edit')}
                        </Button>
                      </Tooltip>
                    </div>
                  )
                })
              }
            </div>
          ))
          : <Empty description={e('noDuplicateBookmarks')} />
      }
    </Modal>
  )
}
