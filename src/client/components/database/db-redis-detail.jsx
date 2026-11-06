/**
 * Redis 值详情面板（cluster #15，从 db-session.jsx 行为零变更抽出）
 *
 * 单一职责：按键类型渲染 Redis 值详情（string 文本框 / hash·list·set·zset 网格 /
 * stream 只读预览），并承载行内编辑、添加控件、TTL、删除、重命名等交互。
 *
 * 句柄归属：本组件不自建任何状态/ref——所有来自 DbSession 作用域的值、回调、
 * store getter、确认助手一律由 owner 通过 props 注入（见底部导出的组件 API）。
 * 仅 renderRedisEditable / renderMoreBtn / renderScanMore / editRedisCell /
 * redisRowOps 属于本聚类内部私有辅助，随本文件一起搬入。
 */

import React from 'react'
import {
  Button,
  Input,
  InputNumber,
  Popconfirm,
  Spin
} from 'antd'
import {
  ReloadOutlined,
  DeleteOutlined,
  PlusOutlined,
  CheckOutlined,
  CloseOutlined
} from '@ant-design/icons'
import DbValuePane from './db-value-pane'
import DbSplitPane from './db-split-pane'
import DbGridTable from './db-grid-table'
import { ColHead } from './db-col-resize'
import { CELL_ELLIPSIS } from './db-grid-columns'
import { wideColumnWidth } from '../../common/db-column-width'
import { dash, REDIS_VALUE_SPLIT_KEY } from '../../common/db-session-const'
import message from '../common/message'

const e = window.translate

export default function DbRedisDetail (props) {
  const {
    redisDetail,
    detailLoading,
    redisKey,
    stringValue,
    stringTruncated,
    keywordPatterns,
    themeConfig,
    isReadonly,
    ttlInput,
    setTtlInput,
    applyTtl,
    delSelectedKey,
    confirmRedisWrite,
    tabId,
    redisDb,
    onOpError,
    selectRedisKey,
    RedisTypeChip,
    RedisTtlChip,
    renderCell,
    redisDetailWidths,
    colMenu,
    redisCellProps,
    redisHashRows,
    redisListRows,
    redisSetRows,
    redisZsetRows,
    redisStreamInfo,
    redisStreamGroups,
    redisStreamEntries,
    redisCellInfo,
    detailLimit,
    setDetailLimit,
    redisEdit,
    setRedisEdit,
    redisAdd,
    setRedisAdd,
    addHashField,
    addMember,
    pushList,
    setRenameInput,
    setRenameOpen,
    runRedisWrite,
    editSetMember,
    saveHashValue,
    saveListValue,
    saveZsetScore
  } = props

  // 详情列定义是渲染里就地重建的（列随键类型换），live 宽由 widthOf 直接读到
  const redisDetailWidthOf = redisDetailWidths.widthOf
  // 选中格的完整值面板数据（与 DbSession 中的别名保持一致）
  const redisValuePane = redisCellInfo

  // 行尾删除按钮（Popconfirm 包裹）：hash 删 field / set/zset 删 member / list 删下标
  const redisRowOps = (onConfirm) => (
    <Popconfirm title={e('dbRedisDelRowConfirm')} onConfirm={onConfirm}>
      <Button
        size='small'
        type='text'
        danger
        icon={<DeleteOutlined />}
        disabled={isReadonly}
        title={isReadonly ? e('dbErrReadOnly') : e('dbRedisDelRowConfirm')}
      />
    </Popconfirm>
  )

  // 行内可编辑单元格渲染：redisEdit 命中当前格 → Input(数字格用 InputNumber) + 确认/取消；
  // 否则走普通高亮渲染
  const renderRedisEditable = (record, col, value, onSave, numeric = false) => {
    const editing = redisEdit && redisEdit.rowKey === record.__rowKey && redisEdit.col === col
    if (!editing) {
      return renderCell(value)
    }
    const editor = numeric
      ? (
        <InputNumber
          size='small'
          autoFocus
          value={redisEdit.value === '' ? undefined : Number(redisEdit.value)}
          onChange={v => setRedisEdit(s => ({ ...s, value: v === undefined ? '' : String(v) }))}
        />
        )
      : (
        <Input
          size='small'
          autoFocus
          value={redisEdit.value}
          onChange={ev => setRedisEdit(s => ({ ...s, value: ev.target.value }))}
          onPressEnter={onSave}
        />
        )
    return (
      <span className='db-redis-cell-edit'>
        {editor}
        <Button size='small' type='text' icon={<CheckOutlined />} onClick={onSave} />
        <Button size='small' type='text' icon={<CloseOutlined />} onClick={() => setRedisEdit(null)} />
      </span>
    )
  }

  // 行内编辑入口（双击触发）；readOnly 时不进编辑态
  const editRedisCell = (record, col, value) => {
    if (!isReadonly) {
      setRedisEdit({ rowKey: record.__rowKey, col, value: String(value ?? '') })
    }
  }

  // 详情页「加载更多」：list/zset 按当前已渲染行数判断是否还有下一页
  const renderMoreBtn = (total) => {
    if (!total || total <= detailLimit) {
      return null
    }
    return (
      <Button
        size='small'
        className='db-redis-more'
        onClick={() => setDetailLimit(l => l + 200)}
      >
        {e('dbLoadMore')} ({e('dbLeft').replace('{n}', total - detailLimit)})
      </Button>
    )
  }

  // hash/set 详情「加载更多」：走服务端 HSCAN/SSCAN 游标，只拉下一页
  const renderScanMore = (d) => {
    if (!d || !d.nextCursor || d.nextCursor === '0') {
      return null
    }
    const loaded = d.type === 'hash' ? (d.fields || []).length : (d.rows || []).length
    const left = typeof d.total === 'number' ? Math.max(0, d.total - loaded) : null
    return (
      <Button
        size='small'
        className='db-redis-more'
        loading={detailLoading}
        onClick={() => selectRedisKey(redisKey, d.nextCursor, true)}
      >
        {e('dbLoadMore')}
        {left === null ? '' : ` (${e('dbLeft').replace('{n}', left)})`}
      </Button>
    )
  }

  // 键详情：按类型渲染（string 文本框；hash/list/set/zset 网格）
  const renderRedisDetail = () => {
    const d = redisDetail
    let body = null
    if (!d) {
      body = detailLoading ? <Spin size='small' /> : null
    } else if (d.type === 'string') {
      // 统一值面板：键信息（type/ttl/删除）与高亮/格式化/复制/编辑全部收进 DbValuePane
      // 单栏展示（编辑保存走 redis setKey，只读模式被主进程拦截）
      body = (
        <DbValuePane
          title={redisKey}
          meta={(
            <span className='db-redis-meta'>
              <RedisTypeChip type={d.type} />
              <RedisTtlChip ttl={d.ttl} />
              <span>{e('dbChars').replace('{n}', stringValue.length)}</span>
              {
                stringTruncated
                  ? <span>{`(preview truncated, ${d.total} bytes total)`}</span>
                  : null
              }
            </span>
          )}
          value={stringValue}
          patterns={keywordPatterns}
          themeConfig={themeConfig}
          editable={!isReadonly && !stringTruncated}
          editDisabledTitle={stringTruncated
            ? 'value too large, preview only (truncated)'
            : e('dbErrReadOnly')}
          extra={(
            <>
              <InputNumber
                size='small'
                min={0}
                placeholder={e('dbSeconds')}
                value={ttlInput}
                onChange={setTtlInput}
              />
              <Button size='small' disabled={isReadonly} onClick={applyTtl}>{e('dbSetTtl')}</Button>
              <Popconfirm title={e('dbDeleteKey')} onConfirm={delSelectedKey}>
                <Button size='small' danger disabled={isReadonly}>{e('dbDelete')}</Button>
              </Popconfirm>
            </>
          )}
          onSave={async v => {
            const ok = await confirmRedisWrite({
              level: 'write',
              text: 'SET ' + redisKey,
              note: e('saved')
            })
            if (!ok) {
              return
            }
            window.pre.runGlobalAsync('dbClientOp', tabId, 'setKey', {
              dbIndex: redisDb,
              key: redisKey,
              value: v
            }).then(() => {
              message.success(e('saved'))
              selectRedisKey(redisKey)
            }).catch(err => onOpError(err))
          }}
        />
      )
    } else if (d.type === 'hash') {
      body = (
        <>
          <DbGridTable
            size='small'
            pagination={false}
            columns={[
              {
                title: (
                  <ColHead
                    label={e('dbField')}
                    colKey='field'
                    wg={redisDetailWidths}
                    hint={e('dbColResizeHint')}
                  />
                ),
                dataIndex: 'field',
                key: 'field',
                width: redisDetailWidthOf('field'),
                ellipsis: CELL_ELLIPSIS,
                onHeaderCell: () => ({
                  onContextMenu: ev => colMenu.openColMenu(ev, {
                    wg: redisDetailWidths,
                    key: 'field',
                    head: e('dbField'),
                    wide: wideColumnWidth(redisHashRows, 'field')
                  })
                }),
                onCell: redisCellProps('field', e('dbField')),
                render: v => renderCell(v)
              },
              {
                title: (
                  <ColHead
                    label={e('dbValue')}
                    colKey='value'
                    wg={redisDetailWidths}
                    hint={e('dbColResizeHint')}
                  />
                ),
                dataIndex: 'value',
                key: 'value',
                width: redisDetailWidthOf('value'),
                ellipsis: CELL_ELLIPSIS,
                // D 批：双击 value 行内编辑（HSET 覆盖同字段）；单击 = 展开完整值面板
                onCell: (r, i) => ({
                  ...redisCellProps('value', e('dbValue'))(r, i),
                  onDoubleClick: () => editRedisCell(r, 'value', r.value)
                }),
                onHeaderCell: () => ({
                  onContextMenu: ev => colMenu.openColMenu(ev, {
                    wg: redisDetailWidths,
                    key: 'value',
                    head: e('dbValue'),
                    wide: wideColumnWidth(redisHashRows, 'value')
                  })
                }),
                render: (v, r) => renderRedisEditable(r, 'value', v, () => saveHashValue(r))
              },
              {
                title: '',
                key: 'ops',
                width: 60,
                render: (_, r) => redisRowOps(() => runRedisWrite('hashDelField', {
                  dbIndex: redisDb, key: redisKey, fields: [r.field]
                }, e('dbDeleted'), {
                  level: 'dangerous',
                  text: 'HDEL ' + redisKey + ' ' + r.field,
                  note: e('dbDeleted')
                }))
              }
            ]}
            dataSource={redisHashRows}
            rowKey='__rowKey'
          />
          {renderScanMore(d)}
        </>
      )
    } else if (d.type === 'list') {
      body = (
        <>
          <DbGridTable
            size='small'
            pagination={false}
            columns={[
              { title: '#', dataIndex: 'index', key: 'index', width: 80, render: v => renderCell(v) },
              {
                title: (
                  <ColHead
                    label={e('dbValue')}
                    colKey='value'
                    wg={redisDetailWidths}
                    hint={e('dbColResizeHint')}
                  />
                ),
                dataIndex: 'value',
                key: 'value',
                width: redisDetailWidthOf('value'),
                ellipsis: CELL_ELLIPSIS,
                // D 批：双击 value 行内编辑（LSET 按下标）；单击 = 展开完整值面板
                onCell: (r, i) => ({
                  ...redisCellProps('value', e('dbValue'))(r, i),
                  onDoubleClick: () => editRedisCell(r, 'value', r.value)
                }),
                onHeaderCell: () => ({
                  onContextMenu: ev => colMenu.openColMenu(ev, {
                    wg: redisDetailWidths,
                    key: 'value',
                    head: e('dbValue'),
                    wide: wideColumnWidth(redisListRows, 'value')
                  })
                }),
                render: (v, r) => renderRedisEditable(r, 'value', v, () => saveListValue(r))
              },
              {
                title: '',
                key: 'ops',
                width: 60,
                render: (_, r) => redisRowOps(() => runRedisWrite('listRemAt', {
                  dbIndex: redisDb, key: redisKey, index: r.index
                }, e('dbDeleted'), {
                  level: 'dangerous',
                  text: '删除 ' + redisKey + '[' + r.index + ']',
                  note: e('dbDeleted')
                }))
              }
            ]}
            dataSource={redisListRows}
            rowKey='__rowKey'
          />
          {renderMoreBtn((d.rows || []).length)}
        </>
      )
    } else if (d.type === 'set') {
      body = (
        <>
          <DbGridTable
            size='small'
            pagination={false}
            columns={[
              {
                title: (
                  <ColHead
                    label={e('dbMember')}
                    colKey='member'
                    wg={redisDetailWidths}
                    hint={e('dbColResizeHint')}
                  />
                ),
                dataIndex: 'member',
                key: 'member',
                width: redisDetailWidthOf('member'),
                ellipsis: CELL_ELLIPSIS,
                // D 批：双击成员 = 删旧加新（成员是身份标识，不支持原地改）；
                // 单击 = 展开完整值面板
                onCell: (r, i) => ({
                  ...redisCellProps('member', e('dbMember'))(r, i),
                  onDoubleClick: () => editRedisCell(r, 'member', r.member)
                }),
                onHeaderCell: () => ({
                  onContextMenu: ev => colMenu.openColMenu(ev, {
                    wg: redisDetailWidths,
                    key: 'member',
                    head: e('dbMember'),
                    wide: wideColumnWidth(redisSetRows, 'member')
                  })
                }),
                render: (v, r) => renderRedisEditable(r, 'member', v, () => editSetMember(r.member, redisEdit ? redisEdit.value : ''))
              },
              {
                title: '',
                key: 'ops',
                width: 60,
                render: (_, r) => redisRowOps(() => runRedisWrite('setRem', {
                  dbIndex: redisDb, key: redisKey, members: [r.member]
                }, e('dbDeleted'), {
                  level: 'dangerous',
                  text: 'SREM ' + redisKey + ' ' + r.member,
                  note: e('dbDeleted')
                }))
              }
            ]}
            dataSource={redisSetRows}
            rowKey='__rowKey'
          />
          {renderScanMore(d)}
        </>
      )
    } else if (d.type === 'zset') {
      // zrange WITHSCORES 返回 [member, score, ...] 扁平数组，行键数组见顶层 redisZsetRows
      body = (
        <>
          <DbGridTable
            size='small'
            pagination={false}
            columns={[
              {
                title: (
                  <ColHead
                    label={e('dbMember')}
                    colKey='member'
                    wg={redisDetailWidths}
                    hint={e('dbColResizeHint')}
                  />
                ),
                dataIndex: 'member',
                key: 'member',
                width: redisDetailWidthOf('member'),
                ellipsis: CELL_ELLIPSIS,
                // 成员是身份标识：双击提示不可编辑（改分值请双击 score 列）；
                // 单击 = 展开完整值面板
                onCell: (r, i) => ({
                  ...redisCellProps('member', e('dbMember'))(r, i),
                  onDoubleClick: () => message.info(e('dbRedisMemberImmutable'))
                }),
                onHeaderCell: () => ({
                  onContextMenu: ev => colMenu.openColMenu(ev, {
                    wg: redisDetailWidths,
                    key: 'member',
                    head: e('dbMember'),
                    wide: wideColumnWidth(redisZsetRows, 'member')
                  })
                }),
                render: v => renderCell(v)
              },
              {
                title: (
                  <ColHead
                    label={e('dbScore')}
                    colKey='score'
                    wg={redisDetailWidths}
                    hint={e('dbColResizeHint')}
                  />
                ),
                dataIndex: 'score',
                key: 'score',
                // 分数列原来写死 150：数字列占 150，成员列（真正会长的那一列）反而没宽
                width: redisDetailWidthOf('score'),
                ellipsis: CELL_ELLIPSIS,
                // D 批：双击 score 行内编辑（ZADD 同 member 覆盖）；单击 = 展开值面板
                onCell: (r, i) => ({
                  ...redisCellProps('score', e('dbScore'))(r, i),
                  onDoubleClick: () => editRedisCell(r, 'score', r.score)
                }),
                onHeaderCell: () => ({
                  onContextMenu: ev => colMenu.openColMenu(ev, {
                    wg: redisDetailWidths,
                    key: 'score',
                    head: e('dbScore'),
                    wide: wideColumnWidth(redisZsetRows, 'score')
                  })
                }),
                render: (v, r) => renderRedisEditable(r, 'score', v, () => saveZsetScore(r), true)
              },
              {
                title: '',
                key: 'ops',
                width: 60,
                render: (_, r) => redisRowOps(() => runRedisWrite('zsetRem', {
                  dbIndex: redisDb, key: redisKey, members: [r.member]
                }, e('dbDeleted'), {
                  level: 'dangerous',
                  text: 'ZREM ' + redisKey + ' ' + r.member,
                  note: e('dbDeleted')
                }))
              }
            ]}
            dataSource={redisZsetRows}
            rowKey='__rowKey'
          />
          {renderMoreBtn(Math.ceil((d.rows || []).length / 2))}
        </>
      )
    } else if (d.type === 'stream') {
      // H7b-4：只读 —— XINFO 给元信息与消费组，XRANGE 给条目。
      // 不提供 XADD/XDEL/XACK：stream 的写入语义（上游生产者、消费组 ack）
      // 不是"双击改一格"能表达的东西，给个半吊子入口比没有更糟。
      const info = redisStreamInfo || {}
      const groups = redisStreamGroups
      const groupCount = groups === null ? info.groups : groups.length
      const entriesTotal = typeof d.total === 'number' ? d.total : null
      body = (
        // 值面板打开时收起消费组：上下分区只剩一半高度，元信息 + 组表就能
        // 把条目表挤成 0 —— 组数是次要信息（元信息条里仍有"消费组 N"），
        // 正在看的条目才是主体
        <div className={'db-redis-stream' + (redisCellInfo ? ' db-redis-stream-compact' : '')}>
          <div className='db-redis-stream-meta'>
            <span className='db-redis-stream-stat'>
              <span className='db-redis-stream-k'>{e('dbRedisStreamStatLength')}</span>
              <span className='db-redis-stream-v'>{dash(info.length)}</span>
            </span>
            <span className='db-redis-stream-stat'>
              <span className='db-redis-stream-k'>{e('dbRedisStreamStatFirst')}</span>
              <span className='db-redis-stream-v db-redis-stream-mono'>{dash(info.firstId)}</span>
            </span>
            <span className='db-redis-stream-stat'>
              <span className='db-redis-stream-k'>{e('dbRedisStreamStatLast')}</span>
              <span className='db-redis-stream-v db-redis-stream-mono'>{dash(info.lastId)}</span>
            </span>
            <span className='db-redis-stream-stat'>
              <span className='db-redis-stream-k'>{e('dbRedisStreamStatGroups')}</span>
              <span className='db-redis-stream-v'>{dash(groupCount)}</span>
            </span>
            <span className='db-redis-stream-stat'>
              <span className='db-redis-stream-k'>{e('dbRedisStreamStatAdded')}</span>
              <span className='db-redis-stream-v'>{dash(info.entriesAdded)}</span>
            </span>
            <Button
              size='small'
              className='db-redis-stream-refresh'
              icon={<ReloadOutlined />}
              loading={detailLoading}
              onClick={() => selectRedisKey(redisKey)}
            >
              {e('dbRedisStreamRefresh')}
            </Button>
          </div>
          <div className='db-redis-stream-head db-redis-stream-groups-head'>
            <span className='db-redis-stream-title'>{e('dbRedisStreamGroupsTitle')}</span>
            {
              groups === null
                ? <span className='db-redis-stream-note'>{e('dbRedisStreamGroupsUnknown')}</span>
                : groups.length === 0
                  ? <span className='db-redis-stream-note'>{e('dbRedisStreamNoGroups')}</span>
                  : null
            }
          </div>
          {
            groups && groups.length
              ? (
                <DbGridTable
                  size='small'
                  pagination={false}
                  columns={[
                    {
                      title: e('dbRedisStreamGroupName'),
                      dataIndex: 'name',
                      key: 'name',
                      ellipsis: CELL_ELLIPSIS,
                      className: 'db-redis-stream-mono',
                      render: v => renderCell(v)
                    },
                    {
                      title: e('dbRedisStreamConsumers'),
                      dataIndex: 'consumers',
                      key: 'consumers',
                      width: 90,
                      render: v => dash(v)
                    },
                    {
                      title: e('dbRedisStreamPending'),
                      dataIndex: 'pending',
                      key: 'pending',
                      width: 90,
                      render: v => dash(v)
                    },
                    {
                      title: e('dbRedisStreamLastDelivered'),
                      dataIndex: 'lastDeliveredId',
                      key: 'lastDeliveredId',
                      width: 180,
                      className: 'db-redis-stream-mono',
                      ellipsis: CELL_ELLIPSIS,
                      render: v => renderCell(v)
                    },
                    {
                      title: e('dbRedisStreamLag'),
                      dataIndex: 'lag',
                      key: 'lag',
                      width: 80,
                      render: v => dash(v)
                    }
                  ]}
                  dataSource={groups}
                  rowKey='name'
                  className='db-redis-stream-groups-table'
                />
                )
              : null
          }
          <div className='db-redis-stream-head'>
            <span className='db-redis-stream-title'>{e('dbRedisStreamEntries')}</span>
            <span className='db-redis-stream-note'>
              {dash(redisStreamEntries.length) + (entriesTotal === null ? '' : ' / ' + entriesTotal)}
            </span>
          </div>
          <DbGridTable
            size='small'
            pagination={false}
            columns={[
              {
                title: (
                  <ColHead
                    label={e('dbRedisStreamId')}
                    colKey='id'
                    wg={redisDetailWidths}
                    hint={e('dbColResizeHint')}
                  />
                ),
                dataIndex: 'id',
                key: 'id',
                width: redisDetailWidthOf('id'),
                ellipsis: CELL_ELLIPSIS,
                className: 'db-redis-stream-mono',
                onHeaderCell: () => ({
                  onContextMenu: ev => colMenu.openColMenu(ev, {
                    wg: redisDetailWidths,
                    key: 'id',
                    head: e('dbRedisStreamId'),
                    wide: wideColumnWidth(redisStreamEntries, 'id')
                  })
                }),
                render: v => renderCell(v)
              },
              {
                title: (
                  <ColHead
                    label={e('dbRedisStreamFields')}
                    colKey='preview'
                    wg={redisDetailWidths}
                    hint={e('dbColResizeHint')}
                  />
                ),
                dataIndex: 'preview',
                key: 'preview',
                width: redisDetailWidthOf('preview'),
                ellipsis: CELL_ELLIPSIS,
                // 单击 = 完整字段（多行原文），网格里只放单行摘要
                onCell: redisCellProps('text', e('dbRedisStreamFields')),
                onHeaderCell: () => ({
                  onContextMenu: ev => colMenu.openColMenu(ev, {
                    wg: redisDetailWidths,
                    key: 'preview',
                    head: e('dbRedisStreamFields'),
                    wide: wideColumnWidth(redisStreamEntries, 'preview')
                  })
                }),
                render: v => renderCell(v)
              },
              {
                title: e('dbRedisStreamFieldCount'),
                dataIndex: 'fieldCount',
                key: 'fieldCount',
                width: 90,
                render: v => dash(v)
              }
            ]}
            dataSource={redisStreamEntries}
            rowKey='__rowKey'
            className='db-redis-stream-entries-table'
          />
          {renderScanMore(d)}
        </div>
      )
    } else {
      body = <span className='db-cell-null'>{e('dbUnsupportedType').replace('{type}', d.type)}</span>
    }
    return (
      <div className='db-redis-detail'>
        {
          // string 键的信息栏已并入 DbValuePane 头部（extra），避免出现两条重复栏
          // d 可能为 null（详情加载中），沿用原空值守卫
          d && d.type !== 'string'
            ? (
              <div className='db-redis-detail-bar'>
                <span className='db-grid-title db-redis-key-name'>{redisKey}</span>
                <RedisTypeChip type={d.type} />
                <RedisTtlChip ttl={d.ttl} />
                {
                  // D 批 T12：按类型显隐的添加控件（只读全部禁用）
                  d.type === 'hash'
                    ? (
                      <>
                        <Input
                          size='small'
                          className='db-redis-add-input'
                          placeholder={e('dbField')}
                          value={redisAdd.field}
                          disabled={isReadonly}
                          onChange={ev => setRedisAdd(s => ({ ...s, field: ev.target.value }))}
                          onPressEnter={addHashField}
                        />
                        <Input
                          size='small'
                          className='db-redis-add-input'
                          placeholder={e('dbValue')}
                          value={redisAdd.value}
                          disabled={isReadonly}
                          onChange={ev => setRedisAdd(s => ({ ...s, value: ev.target.value }))}
                          onPressEnter={addHashField}
                        />
                        <Button
                          size='small'
                          icon={<PlusOutlined />}
                          title={isReadonly ? e('dbErrReadOnly') : e('dbRedisAddField')}
                          disabled={isReadonly}
                          onClick={addHashField}
                        />
                      </>
                      )
                    : null
                }
                {
                  d.type === 'set' || d.type === 'zset'
                    ? (
                      <>
                        <Input
                          size='small'
                          className='db-redis-add-input'
                          placeholder={e('dbMember')}
                          value={redisAdd.member}
                          disabled={isReadonly}
                          onChange={ev => setRedisAdd(s => ({ ...s, member: ev.target.value }))}
                          onPressEnter={addMember}
                        />
                        {
                          d.type === 'zset'
                            ? (
                              <InputNumber
                                size='small'
                                className='db-redis-add-input'
                                placeholder={e('dbScore')}
                                value={redisAdd.score === '' ? undefined : Number(redisAdd.score)}
                                disabled={isReadonly}
                                onChange={v => setRedisAdd(s => ({ ...s, score: v === undefined ? '' : String(v) }))}
                              />
                              )
                            : null
                        }
                        <Button
                          size='small'
                          icon={<PlusOutlined />}
                          title={isReadonly ? e('dbErrReadOnly') : e('dbRedisAddMember')}
                          disabled={isReadonly}
                          onClick={addMember}
                        />
                      </>
                      )
                    : null
                }
                {
                  d.type === 'list'
                    ? (
                      <>
                        <Input
                          size='small'
                          className='db-redis-add-input'
                          placeholder={e('dbValue')}
                          value={redisAdd.listValue}
                          disabled={isReadonly}
                          onChange={ev => setRedisAdd(s => ({ ...s, listValue: ev.target.value }))}
                        />
                        <Button
                          size='small'
                          title={isReadonly ? e('dbErrReadOnly') : e('dbRedisInsertHead')}
                          disabled={isReadonly}
                          onClick={() => pushList('left')}
                        >
                          {e('dbRedisInsertHead')}
                        </Button>
                        <Button
                          size='small'
                          title={isReadonly ? e('dbErrReadOnly') : e('dbRedisInsertTail')}
                          disabled={isReadonly}
                          onClick={() => pushList('right')}
                        >
                          {e('dbRedisInsertTail')}
                        </Button>
                      </>
                      )
                    : null
                }
                <InputNumber
                  size='small'
                  min={0}
                  placeholder={e('dbSeconds')}
                  value={ttlInput}
                  onChange={setTtlInput}
                />
                <Button size='small' disabled={isReadonly} onClick={applyTtl}>{e('dbSetTtl')}</Button>
                <Button
                  size='small'
                  disabled={isReadonly}
                  title={isReadonly ? e('dbErrReadOnly') : e('dbRedisRenameKey')}
                  onClick={() => {
                    setRenameInput('')
                    setRenameOpen(true)
                  }}
                >
                  {e('dbRedisRenameKey')}
                </Button>
                <Popconfirm title={e('dbDeleteKey')} onConfirm={delSelectedKey}>
                  <Button size='small' danger disabled={isReadonly}>{e('dbDelete')}</Button>
                </Popconfirm>
              </div>
              )
            : null
        }
        {
          // 详情四张表的"单击一格 → 底部值面板"：没选中时折叠（bottom 按内容高 = 0，
          // 不给拖拽手柄），选中才把表格压出一截 —— 与数据页/SQL 结果同一交互。
          // string 键的 body 本身就是那只面板，不再套一层分区容器
          d && d.type !== 'string'
            ? (
              <DbSplitPane
                storageKey={REDIS_VALUE_SPLIT_KEY}
                collapsed={!redisCellInfo}
                top={body}
                bottom={redisValuePane}
              />
              )
            : body
        }
      </div>
    )
  }

  return renderRedisDetail()
}
