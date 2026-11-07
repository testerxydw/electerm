// #31b SQL 收藏面板（cluster #31 of 设计-db-session拆分方案-N11b）。
//
// 「收藏 / 历史」双 tab 里的收藏那一半：工具条（新建 / 导入 / 导出当前范围）+ 搜索 +
// 分组条（全部 / 默认 / 各分组）+ 折叠分组列表 + 条目操作（插光标 / 复制 / 编辑 / 删除 / 移动分组）。
//
// 纯展示：没有 state、没有 effect、不发请求。20 个入参全是 owner 的派生值或既有 handler。
// 与历史面板（db-sql-history-panel）的 props 交集只有 favGroups —— 两块互不引用，
// 所以是两次独立提交，不是一次大搬。
//
// 行为零变更：JSX 整段逐字搬迁（原 3417–3696 共 280 行）。
import { Button, Input, Popconfirm, Dropdown } from 'antd'
import {
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  ExportOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  RightOutlined,
  UploadOutlined,
  DownOutlined as DownOutlinedIcon
} from '@ant-design/icons'
import { copy } from '../../common/clipboard'
import { previewText } from '../../common/db-sql-history-panel'
import { dbTypeLabelMap } from '../../common/constants'

const e = window.translate

export default function DbSqlFavPanel ({
  newFavorite,
  importFav,
  favList,
  exportFavScoped,
  setExportMulti,
  favGroups,
  setGroupInput,
  setGroupDialog,
  favFilter,
  setFavFilter,
  favGroupView,
  setFavGroupView,
  favVisible,
  favBuckets,
  favFolded,
  toggleFavFold,
  pickFavorite,
  moveFavoriteGroup,
  editFavorite,
  removeOneFavorite
}) {
  return (
    <div className='db-fav-body'>
      <div className='db-fav-toolbar'>
        <Button size='small' icon={<PlusOutlined />} onClick={newFavorite}>
          {e('dbFavNew')}
        </Button>
        <Button size='small' icon={<UploadOutlined />} onClick={importFav}>
          {e('dbFavImport')}
        </Button>
        {
          // 导出三粒度：单组 / 多组 / 全选。菜单项动态来自 favGroups
          favList.length
            ? (
              <Dropdown
                menu={{
                  items: [
                    // 全选（含所有分组）
                    {
                      key: '__all',
                      icon: <ExportOutlined />,
                      label: e('dbFavExportAll'),
                      onClick: () => exportFavScoped(null)
                    },
                    // 多选分组：弹勾选框，按所选分组的并集导出
                    {
                      key: '__multi',
                      icon: <FolderOpenOutlined />,
                      label: e('dbFavExportMulti'),
                      onClick: () => setExportMulti(Object.keys(favGroups))
                    },
                    { type: 'divider' },
                    // 每个分组单独导出
                    ...Object.keys(favGroups)
                      .sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
                      .map(g => ({
                        key: 'g:' + g,
                        label: (
                          <span>
                            {g || e('dbFavGroupDefault')}
                            <span className='db-fav-groupcount'>（{favGroups[g]}）</span>
                          </span>
                        ),
                        onClick: () => exportFavScoped(g)
                      }))
                  ]
                }}
                trigger={['click']}
                placement='bottomLeft'
              >
                <Button size='small' icon={<DownloadOutlined />} disabled={!favList.length}>
                  {e('dbFavExport')}
                </Button>
              </Dropdown>
              )
            : (
              <Button size='small' icon={<DownloadOutlined />} disabled>
                {e('dbFavExport')}
              </Button>
              )
        }
        {
          // 分组管理：新建 / 重命名 / 删除
          <Dropdown
            menu={{
              items: [
                {
                  key: 'new',
                  icon: <FolderAddOutlined />,
                  label: e('dbFavGroupNew'),
                  onClick: () => { setGroupInput(''); setGroupDialog({ mode: 'new' }) }
                },
                { type: 'divider' },
                ...Object.keys(favGroups)
                  .filter(g => g !== '')
                  .sort((a, b) => a.localeCompare(b))
                  .map(g => ({
                    key: 'g:' + g,
                    label: g,
                    children: [
                      {
                        key: 'rename:' + g,
                        label: e('dbFavGroupRename'),
                        onClick: () => { setGroupInput(g); setGroupDialog({ mode: 'rename', name: g }) }
                      },
                      {
                        key: 'del:' + g,
                        label: e('dbFavGroupDel'),
                        danger: true,
                        onClick: () => setGroupDialog({ mode: 'del', name: g })
                      }
                    ]
                  }))
              ]
            }}
            trigger={['click']}
            placement='bottomLeft'
          >
            <Button size='small' icon={<FolderOpenOutlined />} title={e('dbFavGroupManage')}>
              {e('dbFavGroupManage')}
            </Button>
          </Dropdown>
        }
      </div>
      {
        favList.length
          ? (
            <Input
              className='db-history-filter'
              size='small'
              allowClear
              value={favFilter}
              placeholder={e('dbFavFilter')}
              onChange={ev => setFavFilter(ev.target.value)}
            />
            )
          : null
      }
      {
        // 分组 chips：全部 / 默认分组 / 各分组。点选切换视图，再次点击已选的分组回到全部
        Object.keys(favGroups).length
          ? (
            <div className='db-fav-grouprow'>
              <Button
                className='db-fav-groupchip'
                size='small'
                type={favGroupView === null ? 'primary' : 'text'}
                onClick={() => setFavGroupView(null)}
              >
                {e('dbFavGroupAll')}
              </Button>
              <Button
                className='db-fav-groupchip'
                size='small'
                type={favGroupView === '' ? 'primary' : 'text'}
                onClick={() => setFavGroupView(favGroupView === '' ? null : '')}
              >
                {e('dbFavGroupDefault')}（{favGroups[''] || 0}）
              </Button>
              {
                Object.keys(favGroups)
                  .filter(g => g !== '')
                  .sort((a, b) => a.localeCompare(b))
                  .map(g => (
                    <Button
                      key={g}
                      className='db-fav-groupchip'
                      size='small'
                      type={favGroupView === g ? 'primary' : 'text'}
                      onClick={() => setFavGroupView(favGroupView === g ? null : g)}
                    >
                      {g}（{favGroups[g]}）
                    </Button>
                  ))
              }
            </div>
            )
          : null
      }
      {
        favVisible.length
          ? (
            <div className='db-fav-list'>
              {
                // 按分组分桶渲染：每个非折叠分组一个标题 + 组内条目
                favBuckets.map(([g, items]) => {
                  const folded = favFolded.has(g)
                  return (
                    <div key={g}>
                      {
                        // 有多个分组时才显示分组标题（只有一个分组/未分组时保持简洁）
                        Object.keys(favGroups).length > 1
                          ? (
                            <div
                              className='db-fav-grouptitle'
                              onClick={() => toggleFavFold(g)}
                            >
                              {folded ? <RightOutlined /> : <DownOutlinedIcon />}
                              {g || e('dbFavGroupDefault')}
                              <span className='db-fav-groupcount'>{items.length}</span>
                            </div>
                            )
                          : null
                      }
                      {
                        folded
                          ? null
                          : items.map(item => (
                            <div key={item.id} className='db-fav-item'>
                              <div
                                className='db-fav-main'
                                title={previewText(item.sql)}
                                onClick={() => pickFavorite(item)}
                              >
                                <div className='db-fav-title'>{item.title || previewText(item.sql)}</div>
                                <div className='db-fav-meta'>
                                  <span>{dbTypeLabelMap[item.dbType] || item.dbType}</span>
                                  <span>{new Date(item.ts).toLocaleString()}</span>
                                  {
                                    g
                                      ? <span className='db-fav-groupcount'>{g}</span>
                                      : null
                                  }
                                </div>
                              </div>
                              <div className='db-fav-ops'>
                                {
                                  // 一键收藏（此处为"移入分组"）：点击弹分组下拉
                                  <Dropdown
                                    menu={{
                                      items: [
                                        {
                                          key: 'move-default',
                                          label: e('dbFavGroupDefault'),
                                          onClick: () => moveFavoriteGroup(item, '')
                                        },
                                        ...Object.keys(favGroups)
                                          .filter(x => x !== '' && x !== item.group)
                                          .sort((a, b) => a.localeCompare(b))
                                          .map(x => ({
                                            key: 'move:' + x,
                                            label: x,
                                            onClick: () => moveFavoriteGroup(item, x)
                                          }))
                                      ]
                                    }}
                                    trigger={['click']}
                                    placement='bottomRight'
                                  >
                                    <Button
                                      className='db-fav-star'
                                      type='text'
                                      size='small'
                                      icon={<FolderOpenOutlined />}
                                      title={e('dbFavMoveGroup')}
                                    />
                                  </Dropdown>
                                }
                                <Button
                                  type='text'
                                  size='small'
                                  icon={<CopyOutlined />}
                                  title={e('dbFavCopy')}
                                  onClick={() => copy(item.sql)}
                                />
                                <Button
                                  type='text'
                                  size='small'
                                  icon={<EditOutlined />}
                                  title={e('dbFavEdit')}
                                  onClick={() => editFavorite(item)}
                                />
                                <Popconfirm
                                  title={e('dbFavDelConfirm')}
                                  onConfirm={() => removeOneFavorite(item)}
                                >
                                  <Button
                                    type='text'
                                    size='small'
                                    danger
                                    icon={<DeleteOutlined />}
                                    title={e('dbFavDelete')}
                                    aria-label={e('dbFavDelete')}
                                  />
                                </Popconfirm>
                              </div>
                            </div>
                          ))
                      }
                    </div>
                  )
                })
              }
            </div>
            )
          : (
            <div className='db-history-note'>
              {favList.length ? e('dbFavNoMatch') : e('dbFavEmpty')}
            </div>
            )
      }
    </div>
  )
}
