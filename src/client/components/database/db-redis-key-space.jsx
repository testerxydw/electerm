/**
 * Redis 键空间面板（独立组件，设计 §6.2 聚类 #11 配套渲染）
 *
 * 与 db-session.jsx 里的 `redisArea` 内联渲染一一对应，仅把"键空间"这一职责收拢到此处。
 * 行为零变更：JSX 结构与 db-session.jsx 原 `redisArea` 一致。
 *
 * 句柄归属（AGENTS.md §5.2.4）：本组件不拥有任何键空间之外的状态。
 *   - 键空间状态 / 操作来自 useDbRedisKeys 的返回值（keys.*）
 *   - 输入框 / 树展开的 setter、网格列定义、详情渲染、分页尺寸选择、列宽工具、
 *     只读判定、总页数换算等属于其它聚类或会话页，一律由 owner 注入：
 *       setMatchInput / setTreeSep / setRedisKeySel / setTreeExpanded / treeSep
 *       redisKeyColumns / redisKeyRows / redisKeyRowSelection / selectRedisKey
 *       renderDetail / renderPageSizeSelect / colFitAllBtn / redisKeysWidths
 *       isReadonly / redisKeyTotal / redisKeyPagesShow / redisPageNoText / redisDb / redisKey
 *
 * 已接线：db-session.jsx 的 const redisArea = (...) 改为渲染本组件，21 个顶层 props 由 owner 注入。
 * keys 是 useDbRedisKeys 返回值与 7 个 owner state 的合成对象（直传返回值会白屏）。
 * 详情渲染走 renderDetail() 回调；JSX 与原内联块逐字等价（仅此一处差异）。
 */
import React from 'react'
import { Segmented, Input, Button, Tooltip, Tree, Empty } from 'antd'
import { DeleteOutlined, ReloadOutlined } from '@ant-design/icons'
import DbGridTable from './db-grid-table'
import DbSplitPane from './db-split-pane'
import { DbGridPager } from './db-grid-pager'
import { REDIS_SPLIT_KEY, REDIS_TREE_MAX_KEYS } from '../../common/db-session-const'

const e = window.translate

export function DbRedisKeySpace ({
  redisDb,
  redisKey,
  treeSep,
  setMatchInput,
  setTreeSep,
  setRedisKeySel,
  treeExpanded,
  setTreeExpanded,
  redisKeyColumns,
  redisKeyRows,
  redisKeyRowSelection,
  selectRedisKey,
  renderDetail,
  renderPageSizeSelect,
  colFitAllBtn,
  redisKeysWidths,
  isReadonly,
  redisKeyTotal,
  redisKeyPagesShow,
  redisPageNoText,
  // 来自 useDbRedisKeys 的返回值
  keys
}) {
  const {
    redisView,
    keyList,
    keyTree,
    matchInput,
    keyJumpInput,
    setKeyJumpInput,
    redisKeySel,
    redisTreeNodes,
    redisTreeStatus,
    redisTreeSelected,
    onRedisTreeSelect,
    switchRedisView,
    applyRedisFilter,
    cancelKeyTree,
    loadRedisKeys,
    jumpRedisKeysPage,
    refreshRedisView,
    openRedisDel
  } = keys
  return (
    <div className='db-redis-area'>
      {
        redisDb < 0
          ? <Empty description={e('dbSelectDb')} />
          : (
            <>
              <div className='db-redis-bar'>
                {/* H7a：同一份键空间两种看法。列表 = 游标分页（一页一次 IPC），
                    键树 = 全量抓取后分层；切换只换视图，不改任何数据写路径 */}
                <Segmented
                  size='small'
                  value={redisView}
                  onChange={switchRedisView}
                  options={[
                    { label: e('dbRedisViewList'), value: 'list' },
                    { label: e('dbRedisViewTree'), value: 'tree' }
                  ]}
                />
                <Input
                  size='small'
                  placeholder={e('dbMatchPlaceholder')}
                  value={matchInput}
                  onChange={ev => setMatchInput(ev.target.value)}
                  onPressEnter={applyRedisFilter}
                  className='db-redis-match'
                  allowClear
                />
                <Button
                  size='small'
                  onClick={applyRedisFilter}
                >
                  {e('filter')}
                </Button>
                {
                  redisView === 'tree'
                    ? (
                      <>
                        {/* 分隔符可配：改一下只重分层，不会重扫上万键（树在 useMemo 里算） */}
                        <span className='db-redis-tree-sep'>
                          <span className='db-redis-tree-sep-label'>{e('dbKeyTreeSep')}</span>
                          <Input
                            size='small'
                            className='db-redis-tree-sep-input'
                            value={treeSep}
                            maxLength={8}
                            onChange={ev => setTreeSep(ev.target.value)}
                          />
                        </span>
                        <span
                          className={'db-redis-tree-status' + (keyTree.truncated ? ' is-truncated' : '')}
                        >
                          {redisTreeStatus}
                          {
                            keyTree.truncated
                              ? ' · ' + e('dbKeyTreeTruncated').replace('{n}', REDIS_TREE_MAX_KEYS)
                              : ''
                          }
                        </span>
                        {
                          keyTree.loading
                            ? (
                              <Button size='small' onClick={cancelKeyTree}>
                                {e('cancel')}
                              </Button>
                              )
                            : null
                        }
                      </>
                      )
                    : (
                      <>
                        {/* H1a-4：分页条与数据页 / SQL 结果统一走 DbGridPager
                            （SCAN 无 offset：上一页走游标栈回退，下一页前向步进） */}
                        <DbGridPager
                          prevDisabled={keyList.stack.length === 0 || keyList.loading}
                          onPrev={() => {
                            const stack = keyList.stack
                            loadRedisKeys(
                              redisDb,
                              stack[stack.length - 1],
                              keyList.match,
                              stack.slice(0, -1)
                            )
                          }}
                          nextDisabled={!keyList.hasMore || keyList.loading}
                          onNext={() => loadRedisKeys(
                            redisDb,
                            keyList.nextCursor,
                            keyList.match,
                            [...keyList.stack, keyList.cursor]
                          )}
                          pageNoText={redisPageNoText}
                          // 页数是按键数换算的，把键数挂上去说明依据（键会随并发写入变化）
                          pageNoTitle={typeof redisKeyTotal === 'number'
                            ? e('dbKeysTotal').replace('{n}', redisKeyTotal)
                            : undefined}
                          // R1：键列表任意跳页（SCAN 无 offset，后端前向步进到目标页）
                          jump={{
                            numeric: false,
                            value: keyJumpInput,
                            onChange: ev => setKeyJumpInput(ev.target.value),
                            onPressEnter: () => jumpRedisKeysPage(keyJumpInput),
                            disabled: keyList.loading,
                            placeholder: redisKeyPagesShow ? '1-' + redisKeyPagesShow : e('dbPagePlaceholder')
                          }}
                          goDisabled={keyList.loading || !String(keyJumpInput).trim()}
                          onGo={() => jumpRedisKeysPage(keyJumpInput)}
                        />
                        {renderPageSizeSelect()}
                        {/* H1a-2：键名列宽工具（长键名加宽后一键回到按内容自适应） */}
                        {colFitAllBtn(redisKeysWidths)}
                        {/* H7b-3：跨页勾选后当前页可能一个都没选，需要常驻的"已选 N"提示
                            （否则翻一页就看不见自己选了什么，只剩按钮上的数字） */}
                        {
                          redisKeySel.length
                            ? (
                              <span className='db-redis-sel-chip'>
                                {e('dbRedisSelCount').replace('{n}', String(redisKeySel.length))}
                                <Button
                                  type='link'
                                  size='small'
                                  className='db-redis-sel-clear'
                                  onClick={() => setRedisKeySel([])}
                                >
                                  {e('dbRedisSelClear')}
                                </Button>
                              </span>
                              )
                            : null
                        }
                        {/* H7b-3：批量删键入口。只读时禁用并说明原因（主进程还会再拦一道） */}
                        <Tooltip title={isReadonly ? e('dbRedisDelKeysReadonly') : ''}>
                          <Button
                            size='small'
                            danger
                            icon={<DeleteOutlined />}
                            disabled={!redisKeySel.length || isReadonly || keyList.loading}
                            onClick={openRedisDel}
                          >
                            {e('dbRedisDelKeys')}{redisKeySel.length ? `(${redisKeySel.length})` : ''}
                          </Button>
                        </Tooltip>
                      </>
                      )
                }
                {/* 刷新放在翻页之后，与 MySQL 网格头一致；两种视图共用这一个入口 */}
                <Button
                  size='small'
                  icon={<ReloadOutlined />}
                  loading={redisView === 'tree' ? keyTree.loading : keyList.loading}
                  title={e('refresh')}
                  onClick={refreshRedisView}
                />
              </div>
              <DbSplitPane
                storageKey={REDIS_SPLIT_KEY}
                top={
                  redisView === 'tree'
                    ? (
                      <div className='db-redis-tree'>
                        {
                          redisTreeNodes.length
                            ? (
                              <Tree
                                blockNode
                                selectable
                                treeData={redisTreeNodes}
                                expandedKeys={treeExpanded}
                                onExpand={ks => setTreeExpanded(ks)}
                                selectedKeys={redisTreeSelected}
                                onSelect={onRedisTreeSelect}
                                titleRender={node => (
                                  <span
                                    className='db-redis-tree-node'
                                    title={node.keyName || node.title}
                                  >
                                    <span className='db-redis-tree-title'>{node.title}</span>
                                    <span className='db-redis-tree-count'>{node.count}</span>
                                  </span>
                                )}
                              />
                              )
                            : (
                              <div className='db-redis-tree-empty'>
                                <Empty description={keyTree.loading ? e('dbLoading') : e('noData')} />
                              </div>
                              )
                        }
                      </div>
                      )
                    : (
                      <DbGridTable
                        className='db-redis-keys'
                        size='small'
                        loading={keyList.loading}
                        columns={redisKeyColumns}
                        dataSource={redisKeyRows}
                        rowKey='name'
                        pagination={false}
                        rowSelection={redisKeyRowSelection}
                        onRow={r => ({ onClick: () => selectRedisKey(r.name) })}
                        rowClassName={r => (r.name === redisKey ? 'db-row-selected' : '')}
                      />
                      )
                }
                bottom={
                  redisKey
                    ? renderDetail()
                    : (
                      <div className='db-redis-detail db-redis-detail-empty'>
                        <Empty description={e('dbSelectKey')} />
                      </div>
                      )
                }
              />
            </>
            )
      }
    </div>
  )
}
