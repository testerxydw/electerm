// #31a SQL 历史面板（cluster #31 of 设计-db-session拆分方案-N11b）。
//
// 「收藏 / 历史」双 tab 里的历史那一半：头部（标题 + 条数 + 导出 / 清空）+ 过滤框 +
// 列表（键盘上下选择、点击插回编辑器、单条删除）+ 悬浮预览栏 + 底部提示。
//
// 纯展示：没有 state、没有 effect、不发请求。19 个入参全是 owner 的派生值或既有 handler，
// 其中 histListRef / histIndex / histCur 是「键盘选中项」这一套交互的三件套，
// 由 owner 统一持有 —— 因为收藏 tab 与弹层外壳要共用同一个选中态。
//
// 行为零变更：JSX 整段逐字搬迁（原 3387–3606 共 220 行）。
import { Button, Input, Popconfirm, Dropdown } from 'antd'
import {
  CloseOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FolderAddOutlined,
  StarFilled,
  StarOutlined,
  DownOutlined as DownOutlinedIcon
} from '@ant-design/icons'
import { copy } from '../../common/clipboard'
import { SQL_HISTORY_MAX } from '../../common/db-sql-history'
import { previewText } from '../../common/db-sql-history-panel'
import { dbTypeLabelMap } from '../../common/constants'

const e = window.translate

export default function DbSqlHistoryPanel ({
  sqlHistory,
  exportSqlHistory,
  clearAllSqlHistory,
  histFilter,
  setHistFilter,
  setHistIndex,
  onHistFilterKeyDown,
  histList,
  histListRef,
  onHistKeyDown,
  histIndex,
  pickSqlHistory,
  isRedis,
  isFaved,
  favoriteNow,
  favGroups,
  openQuickFav,
  removeOneSqlHistory,
  histCur
}) {
  return (
    <>
      <div className='db-history-head'>
        <span className='db-history-title'>
          {e('dbSqlHistory')}
          {sqlHistory.length ? <span className='db-history-count'>{sqlHistory.length}</span> : null}
        </span>
        {
          sqlHistory.length
            ? (
              <span className='db-history-headops'>
                {
                  // S3-D 历史导出：全部 / 当前筛选结果。悬浮才露（与条目操作一致）
                  <Button
                    className='db-history-star'
                    type='text'
                    size='small'
                    icon={<DownloadOutlined />}
                    title={e('dbHistExport')}
                    onClick={exportSqlHistory}
                  />
                }
                <Popconfirm
                  title={e('dbSqlHistoryClearConfirm')}
                  onConfirm={clearAllSqlHistory}
                >
                  <Button
                    type='text'
                    size='small'
                    icon={<DeleteOutlined />}
                    title={e('dbSqlHistoryClear')}
                  />
                </Popconfirm>
              </span>
              )
            : null
        }
      </div>
      {
        // 历史条数有环形上限（SQL_HISTORY_MAX），找旧语句靠滚动太费劲；只匹配语句文本，不匹配库名/时间
        sqlHistory.length
          ? (
            <Input
              className='db-history-filter'
              size='small'
              allowClear
              value={histFilter}
              placeholder={e('dbSqlHistoryFilter')}
              onChange={ev => {
                setHistFilter(ev.target.value)
                setHistIndex(0)
              }}
              onKeyDown={onHistFilterKeyDown}
            />
            )
          : null
      }
      {
        histList.length
          ? (
            <div className='db-history-body'>
              <div
                className='db-history-list'
                ref={histListRef}
                tabIndex={0}
                role='listbox'
                aria-label={e('dbSqlHistory')}
                onKeyDown={onHistKeyDown}
              >
                {
                  histList.map((item, i) => (
                    <div
                      key={i}
                      role='option'
                      aria-selected={i === histIndex}
                      className={
                        'db-history-item' +
                        (i === histIndex ? ' is-active' : '')
                      }
                      onClick={() => pickSqlHistory(item)}
                      onMouseEnter={() => setHistIndex(i)}
                    >
                      <div className='db-history-sql'>{previewText(item.sql)}</div>
                      <div className='db-history-meta'>
                        <span className='db-history-time'>
                          {new Date(item.ts).toLocaleString()}
                        </span>
                        <span className='db-history-src'>
                          {dbTypeLabelMap[item.dbType] || item.dbType}
                          {item.dbName ? ' · ' + item.dbName : ''}
                        </span>
                        {
                          item.ok === false
                            ? <span className='db-history-fail'>{e('dbSqlHistoryFailed')}</span>
                            : null
                        }
                        <span className='db-history-ops'>
                          {
                            // 一键收藏：星标 = 直接收藏到默认分组；右侧小箭头 = 选指定分组
                            !isRedis
                              ? (
                                <>
                                  <Button
                                    className='db-history-star'
                                    type='text'
                                    size='small'
                                    icon={<StarFilled />}
                                    // 已收藏态：金色实心星 + 文案切换；再点仍可收藏（合并刷新时间）
                                    style={isFaved(item.sql) ? { color: '#faad14' } : undefined}
                                    title={isFaved(item.sql) ? e('dbFavSaved') : e('dbSqlHistoryFav')}
                                    onClick={ev => {
                                      ev.stopPropagation()
                                      favoriteNow(item.sql, '')
                                    }}
                                  />
                                  <Dropdown
                                    menu={{
                                      items: [
                                        {
                                          key: 'fav-default',
                                          icon: <StarOutlined />,
                                          label: e('dbFavGroupDefault'),
                                          onClick: () => favoriteNow(item.sql, '')
                                        },
                                        ...Object.keys(favGroups)
                                          .filter(g => g !== '')
                                          .sort((a, b) => a.localeCompare(b))
                                          .map(g => ({
                                            key: 'fav:' + g,
                                            icon: <StarOutlined />,
                                            label: g,
                                            onClick: () => favoriteNow(item.sql, g)
                                          })),
                                        { type: 'divider' },
                                        {
                                          key: 'fav-new',
                                          icon: <FolderAddOutlined />,
                                          label: e('dbFavGroupNew'),
                                          onClick: () => openQuickFav(item.sql)
                                        }
                                      ]
                                    }}
                                    trigger={['click']}
                                    placement='bottomRight'
                                  >
                                    <Button
                                      className='db-history-star'
                                      type='text'
                                      size='small'
                                      icon={<DownOutlinedIcon />}
                                      title={e('dbFavMoveGroup')}
                                      onClick={ev => ev.stopPropagation()}
                                    />
                                  </Dropdown>
                                </>
                                )
                              : null
                            }
                          <Button
                            className='db-history-copy'
                            type='text'
                            size='small'
                            icon={<CopyOutlined />}
                            title={e('dbSqlHistoryCopy')}
                            onClick={ev => {
                              // 只复制，不插回编辑器：想复用长语句又不想动当前编辑内容
                              ev.stopPropagation()
                              copy(previewText(item.sql))
                            }}
                          />
                          <Button
                            className='db-history-del'
                            type='text'
                            danger
                            size='small'
                            icon={<CloseOutlined />}
                            title={e('dbSqlHistoryDelete')}
                            aria-label={e('dbSqlHistoryDelete')}
                            onClick={ev => {
                              // 必须挡住冒泡：不挡住会同时把这条语句插回编辑器
                              ev.stopPropagation()
                              removeOneSqlHistory(item)
                            }}
                          />
                        </span>
                      </div>
                    </div>
                  ))
                }
              </div>
              {
                // 预览栏：悬浮/键盘选中项的完整语句。列表里只给两行，
                // 因为一条语句可能几十行，全展开会把列表挤没
                histCur
                  ? (
                    <div className='db-history-preview'>
                      <div className='db-history-preview-head'>
                        <span>{e('dbSqlHistoryPreview')}</span>
                        <Button
                          type='text'
                          size='small'
                          icon={<CopyOutlined />}
                          title={e('dbSqlHistoryCopy')}
                          onClick={() => copy(previewText(histCur.sql))}
                        />
                      </div>
                      <pre className='db-history-preview-code'>{previewText(histCur.sql)}</pre>
                    </div>
                    )
                  : null
              }
            </div>
            )
          : (
            <div className='db-history-empty'>
              {sqlHistory.length ? e('dbSqlHistoryNoMatch') : e('dbSqlHistoryEmpty')}
            </div>
            )
      }
      <div className='db-history-note'>{e('dbSqlHistoryNote').replace('{n}', String(SQL_HISTORY_MAX))}</div>
    </>
  )
}
