/**
 * N6：会话与状态查看（只读，最小版）
 *
 * MySQL：information_schema.PROCESSLIST；PG：pg_stat_activity（当前库）。
 * 边界（对标文档 §N6 / §10）：只展示，绝不 kill —— 本组件没有任何操作列、
 * 没有任何 KILL/pg_terminate 的调用路径；自动刷新默认关，开关交给用户。
 * 列名直接用引擎原词（DBA 工具惯例），只对需要解释的词条做本地化。
 */

import { useMemo } from 'react'
import { Alert, Button, Space, Spin, Switch, Table, Tag, Tooltip } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { isPgFamily } from '../../common/db-engine-family'
import { useDbSessions } from './use-db-sessions'

const e = window.translate
// 自动刷新开关两端的小字（ON/OFF 通用记号，不进词条表）
const AUTO_ON = 'ON'
const AUTO_OFF = 'OFF'

export default function DbSessions (props) {
  const { tabId, dbType } = props
  const isPg = isPgFamily(dbType)
  const { sessions, auto, setAuto, load } = useDbSessions({ tabId })

  const columns = useMemo(() => {
    if (isPg) {
      return [
        { dataIndex: 'pid', title: 'pid', width: 90 },
        { dataIndex: 'usename', title: 'usename', width: 130 },
        { dataIndex: 'application_name', title: 'application_name', width: 150, ellipsis: true },
        { dataIndex: 'client_addr', title: 'client_addr', width: 140, ellipsis: true },
        { dataIndex: 'state', title: 'state', width: 110 },
        { dataIndex: 'running_seconds', title: e('dbSessionsTimeSecs'), width: 110 },
        { dataIndex: 'wait_event_type', title: 'wait_event_type', width: 130 },
        { dataIndex: 'wait_event', title: 'wait_event', width: 150, ellipsis: true },
        { dataIndex: 'query', title: 'query', ellipsis: true }
      ]
    }
    return [
      { dataIndex: 'id', title: 'id', width: 90 },
      { dataIndex: 'user', title: 'user', width: 130 },
      { dataIndex: 'host', title: 'host', width: 170, ellipsis: true },
      { dataIndex: 'db', title: 'db', width: 140, ellipsis: true },
      { dataIndex: 'command', title: 'command', width: 110 },
      { dataIndex: 'time', title: e('dbSessionsTimeSecs'), width: 110 },
      { dataIndex: 'state', title: 'state', width: 140, ellipsis: true },
      { dataIndex: 'info', title: 'info', ellipsis: true }
    ]
  }, [isPg])

  const st = sessions.status || {}
  const statusEntries = Object.entries(st.status || {})

  return (
    <div className='db-sessions-wrap'>
      <div className='pd1x'>
        <Space>
          <Tooltip title={e('dbSessionsRefresh')}>
            <Button
              icon={<ReloadOutlined />}
              onClick={load}
              loading={sessions.loading}
              disabled={auto}
            />
          </Tooltip>
          <span>{e('dbSessionsAutoRefresh')}</span>
          {/* 默认关；开着时手动刷新按钮禁用，节拍交给轮询（刷新可关是验收项） */}
          <Switch
            checked={auto}
            checkedChildren={AUTO_ON}
            unCheckedChildren={AUTO_OFF}
            onChange={setAuto}
          />
          {st.version ? <Tag color='blue'>{st.version}</Tag> : null}
          {statusEntries.map(([k, v]) => (
            <Tag key={k}>{k + ': ' + v}</Tag>
          ))}
        </Space>
      </div>
      {
        sessions.error
          ? (
            <Alert
              type='error'
              showIcon
              message={sessions.error}
              className='mg1b'
            />
            )
          : null
      }
      <Spin spinning={sessions.loading && !sessions.rows.length}>
        <Table
          size='small'
          rowKey={r => String(isPg ? r.pid : r.id) + ':' + String(r.query || r.info || '')}
          columns={columns}
          dataSource={sessions.rows || []}
          pagination={{ pageSize: 50, hideOnSinglePage: true, showSizeChanger: false }}
        />
      </Spin>
    </div>
  )
}
