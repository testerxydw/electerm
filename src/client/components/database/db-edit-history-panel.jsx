/**
 * N12c 数据修改历史面板：每次表数据修改（即时写 / 变更集应用）落库后的本地留痕列表。
 *
 * 组件只管渲染与回抛意图，不碰 IPC：items / 删除 / 清空 / 导出 / 筛选都由
 * use-db-edit-history 注入。行内不展示绑定值原文以外的内容——sql 是确认弹窗
 * 同源的预览摘要（参数化 op 不生成可执行 SQL），所以这里是"回溯发生了什么"，
 * 不是"重放脚本"；要重放请去 SQL 页签。
 */
import { Button, Empty, Input, Modal, Popconfirm, Tag, Tooltip } from 'antd'
import { CloseOutlined, DownloadOutlined, SearchOutlined } from '@ant-design/icons'

const e = window.translate

const KIND_LABEL = {
  cell: 'dbChangesKindUpdate',
  cells: 'dbChangesKindUpdate',
  insert: 'dbChangesKindInsert',
  delete: 'dbChangesKindDelete',
  changes: 'dbEditHistoryKindChanges'
}

// 时间显示用本地格式（回溯场景对时区敏感，不落 ISO 串）
const fmtTime = (ts) => {
  const d = new Date(Number(ts) || 0)
  return isNaN(d.getTime()) ? '' : d.toLocaleString()
}

const targetLabel = (it) => {
  const db = it.database ? it.database + '.' : ''
  return db + (it.schema ? it.schema + '.' : '') + (it.table || '')
}

export default function DbEditHistoryPanel (props) {
  const {
    open,
    items,
    filter,
    onFilterChange,
    max,
    onClose,
    onRemove,
    onClearAll,
    onExport
  } = props
  return (
    <Modal
      title={e('dbEditHistory')}
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
      className='db-edit-history-modal'
    >
      <div className='db-edit-history-bar'>
        <Input
          size='small'
          className='db-edit-history-filter'
          allowClear
          prefix={<SearchOutlined />}
          placeholder={e('dbEditHistoryFilterTip')}
          value={filter}
          onChange={ev => onFilterChange(ev.target.value)}
        />
        <Popconfirm
          title={e('dbEditHistoryClearConfirm')}
          okText={e('dbEditHistoryClear')}
          cancelText={e('cancel')}
          okButtonProps={{ danger: true }}
          onConfirm={onClearAll}
        >
          <Button size='small' danger>{e('dbEditHistoryClear')}</Button>
        </Popconfirm>
        <Tooltip title={e('dbHistExport')}>
          <Button size='small' icon={<DownloadOutlined />} onClick={onExport} />
        </Tooltip>
      </div>
      <div className='db-edit-history-count'>
        {e('dbEditHistoryCount').replace('{n}', String(items.length)).replace('{max}', String(max))}
      </div>
      {
        items.length
          ? (
            <div className='db-edit-history-list'>
              {
                items.map((it, i) => (
                  <div className='db-edit-history-item' key={(it.ts || 0) + '-' + i}>
                    <div className='db-edit-history-item-head'>
                      <span className='db-edit-history-time'>{fmtTime(it.ts)}</span>
                      <Tag className='db-edit-history-kind'>{e(KIND_LABEL[it.kind] || 'dbChangesKindUpdate')}</Tag>
                      <span className='db-edit-history-table' title={targetLabel(it)}>{targetLabel(it)}</span>
                      <span className={'db-edit-history-n' + (it.fail ? ' has-fail' : '')}>
                        {it.fail
                          ? e('dbEditHistoryPartial').replace('{ok}', String(it.n)).replace('{fail}', String(it.fail))
                          : e('dbAffected').replace('{n}', String(it.n))}
                      </span>
                      <Button
                        size='small'
                        type='text'
                        icon={<CloseOutlined />}
                        title={e('dbEditHistoryRemove')}
                        onClick={() => onRemove(it)}
                      />
                    </div>
                    <div className='db-edit-history-sql' title={it.sql}>{it.sql}</div>
                  </div>
                ))
              }
            </div>
            )
          : (
            <div className='db-edit-history-empty'>
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={e('dbEditHistoryEmpty')}
              />
            </div>
            )
      }
    </Modal>
  )
}
