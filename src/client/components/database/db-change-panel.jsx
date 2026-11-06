/**
 * N2 变更面板：暂存下来的改动清单（逐条预览 SQL + 撤销 + 丢弃 + 应用）。
 *
 * 组件只管渲染与回抛意图，**不碰 IPC、不碰变更集构造**：
 * groups 来自 db-change-set.listChanges（顺序就是将要执行的顺序），
 * 应用/撤销/丢弃都由 use-db-changes 注入。
 *
 * 为什么这里只读 SQL 文本、不给编辑：能编辑预览就等于"执行的是另一套语句"，
 * 与"提交仍走同一批 op"直接冲突（设计 N2 要点 1）。要手写 SQL 请去 SQL 页签。
 */
import { Button, Switch, Tag, Tooltip, Empty } from 'antd'
import { InfoCircleOutlined, CloseOutlined } from '@ant-design/icons'

const e = window.translate

const KIND_LABEL = {
  insert: 'dbChangesKindInsert',
  cell: 'dbChangesKindUpdate',
  delete: 'dbChangesKindDelete'
}

const tableLabel = (target) => {
  if (!target) {
    return ''
  }
  const db = target.database ? target.database + '.' : ''
  return db + (target.schema ? target.schema + '.' : '') + target.table
}

export default function DbChangePanel (props) {
  const {
    groups,
    count,
    stageOn,
    applying,
    inTx,
    onToggleStage,
    onRevert,
    onDropTable,
    onDiscardAll,
    onApply
  } = props
  return (
    <div className='db-changes'>
      <div className='db-changes-bar'>
        <Tooltip title={e('dbStageHint')}>
          <span className='db-changes-switch'>
            <Switch size='small' checked={stageOn} onChange={onToggleStage} />
            <span className='db-changes-switch-label'>{e('dbStageSwitch')}</span>
            <InfoCircleOutlined className='db-changes-info' />
          </span>
        </Tooltip>
        {
          count
            ? <span className='db-changes-count'>{e('dbChangesCount').replace('{n}', String(count))}</span>
            : null
        }
        <span className='db-changes-bar-tail'>
          {
            count
              ? (
                <Button size='small' onClick={onDiscardAll} disabled={applying}>
                  {e('dbChangesDiscardAll')}
                </Button>
                )
              : null
          }
          <Button
            size='small'
            type='primary'
            className='db-changes-apply'
            loading={applying}
            disabled={!count || applying}
            title={count ? undefined : e('dbChangesNothing')}
            onClick={onApply}
          >
            {e('dbChangesApply').replace('{n}', String(count))}
          </Button>
        </span>
      </div>
      {
        // 与 F2 手动事务的关系必须在这里说一次：两道清单不是一回事，
        // 开着事务时"应用"= 把语句发进事务，谁了结谁
        stageOn && inTx
          ? <div className='db-changes-tx'>{e('dbChangesTxNote')}</div>
          : null
      }
      {
        count
          ? groups.map(g => (
            <div className='db-changes-group' key={g.key}>
              <div className='db-changes-group-head'>
                <span className='db-changes-table' title={g.key}>{tableLabel(g.target)}</span>
                <span className='db-changes-group-count'>{g.count}</span>
                <Button
                  size='small'
                  type='text'
                  icon={<CloseOutlined />}
                  title={e('dbChangesDropTable')}
                  disabled={applying}
                  onClick={() => onDropTable(g.key)}
                />
              </div>
              {
                g.items.map(it => (
                  <div className='db-changes-row' key={it.id}>
                    <Tag className='db-changes-kind'>{e(KIND_LABEL[it.kind] || 'dbChangesKindUpdate')}</Tag>
                    <span className='db-changes-sql' title={it.sql}>{it.sql}</span>
                    <Button
                      size='small'
                      type='text'
                      icon={<CloseOutlined />}
                      title={e('dbChangesRevert')}
                      disabled={applying}
                      onClick={() => onRevert(it.id)}
                    />
                  </div>
                ))
              }
            </div>
          ))
          : (
            <div className='db-changes-empty'>
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={e(stageOn ? 'dbChangesNone' : 'dbChangesStagingOff')}
              />
            </div>
            )
      }
    </div>
  )
}
