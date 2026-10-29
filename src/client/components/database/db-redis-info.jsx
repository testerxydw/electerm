/**
 * Redis 服务器信息弹层（H7a-4）
 *
 * 只做"把 INFO 原文摆出来"：取数在 db-session（打开时拉一次 + 手动刷新，不轮询），
 * 解析在 common/db-redis-info.js，这里只负责把事实排成两页 —— 组件本身不碰 IPC。
 *
 * 界面口径只有一条要紧的：null 一律出「—」而不是 0。INFO 里 0 是合法值
 * （命中率 0%、maxmemory 0 = 不限），把"没拿到"显示成 0 就等于替用户下了一个结论。
 */

import { Modal, Tabs, Table, Spin, Alert, Button } from 'antd'
import { parseRedisInfo, redisOverview, keyspaceRows, formatPercent } from '../../common/db-redis-info'
import { formatBytes, formatDuration } from '../remote-monitor/monitor-model'
import { copy } from '../../common/clipboard'
import { CopyOutlined } from '@ant-design/icons'

const e = window.translate

const NA = '—'

/** null/undefined 出占位；数字 0 是值，照原样显示（交给调用方决定要不要格式化） */
function show (v) {
  if (v === null || v === undefined || v === '') {
    return NA
  }
  return String(v)
}

/**
 * 概览分组。写死字段而不是"把小节全列出来"：INFO 有 10+ 小节、上百个键，
 * 全摊开等于没摘要；剩下的原文在"原始文本"页里看得到。
 */
function overviewGroups (ov) {
  const hitRate = formatPercent(ov.hitRate)
  // maxmemory 0 是"不限制"的意思，不是"上限 0 字节"
  const maxMemory = ov.maxMemory === 0 ? e('dbRedisInfoNoLimit') : formatBytes(ov.maxMemory)
  return [
    {
      title: e('dbRedisInfoServer'),
      rows: [
        [e('dbRedisInfoVersion'), show(ov.version)],
        [e('dbRedisInfoMode'), show(ov.mode)],
        [e('os'), show(ov.os)],
        [e('dbRedisInfoConfig'), show(ov.config)],
        [e('uptime'), formatDuration(ov.uptimeSeconds)]
      ]
    },
    {
      title: e('dbRedisInfoClients'),
      rows: [
        [e('dbRedisInfoConnected'), show(ov.connectedClients)],
        [e('dbRedisInfoBlocked'), show(ov.blockedClients)],
        [e('dbRedisInfoMaxClients'), show(ov.maxClients)]
      ]
    },
    {
      title: e('memory'),
      rows: [
        [e('dbRedisInfoUsed'), formatBytes(ov.usedMemory)],
        [e('dbRedisInfoRss'), formatBytes(ov.usedMemoryRss)],
        [e('dbRedisInfoMax'), maxMemory],
        [e('dbRedisInfoPolicy'), show(ov.maxMemoryPolicy)],
        [e('dbRedisInfoFrag'), ov.fragmentation === null ? NA : ov.fragmentation.toFixed(2)]
      ]
    },
    {
      title: e('dbRedisInfoStats'),
      rows: [
        [e('dbRedisInfoHitRate'), hitRate === null ? NA : hitRate],
        [e('dbRedisInfoHits'), show(ov.hits)],
        [e('dbRedisInfoMisses'), show(ov.misses)],
        [e('dbRedisInfoOps'), show(ov.instantaneousOpsPerSec)],
        [e('dbRedisInfoEvicted'), show(ov.evictedKeys)],
        [e('dbRedisInfoExpired'), show(ov.expiredKeys)],
        [e('dbRedisInfoRejected'), show(ov.rejectedConnections)]
      ]
    },
    {
      title: e('dbRedisInfoKeyspace'),
      rows: [
        [e('dbRedisInfoTotalKeys'), show(ov.totalKeys)],
        [e('dbRedisInfoTotalExpires'), show(ov.totalExpires)],
        [e('dbRedisInfoRole'), show(ov.role)],
        [e('dbRedisInfoReplicas'), show(ov.connectedReplicas)]
      ]
    }
  ]
}

const keyspaceColumns = [
  { title: e('dbRedisInfoColDb'), dataIndex: 'db', key: 'db', width: 90 },
  {
    title: e('dbRedisInfoKeys'),
    dataIndex: 'keys',
    key: 'keys',
    render: v => (v === null || v === undefined ? NA : String(v))
  },
  {
    title: e('dbRedisInfoExpires'),
    dataIndex: 'expires',
    key: 'expires',
    render: v => (v === null || v === undefined ? NA : String(v))
  },
  {
    // INFO 的 avg_ttl 单位是毫秒，formatDuration 收的是秒
    title: e('dbRedisInfoAvgTtl'),
    dataIndex: 'avgTtlMs',
    key: 'avgTtlMs',
    render: v => (typeof v === 'number' ? formatDuration(v / 1000) : NA)
  }
]

export default function DbRedisInfoModal (props) {
  const { open, loading, error, text, onClose, onRefresh } = props
  const parsed = parseRedisInfo(text)
  const ov = redisOverview(parsed)
  const rows = keyspaceRows(parsed)
  const hasText = !!String(text || '').trim()
  // 首帧（还没有任何一份 INFO）才整块转圈；带旧数据刷新时继续显示旧内容，
  // 否则每次点"刷新"弹层都会闪成一张空板，看起来像信息丢了。
  // 刷新按钮自己的 loading 态就是"正在更新"的提示。
  const firstLoading = loading && !hasText
  return (
    <Modal
      open={open}
      title={e('dbRedisInfo')}
      width={720}
      onCancel={onClose}
      footer={[
        <Button
          key='copy'
          size='small'
          icon={<CopyOutlined />}
          disabled={!String(text || '').trim()}
          onClick={() => copy(String(text || ''))}
        >
          {e('copy')}
        </Button>,
        <Button key='refresh' size='small' loading={loading} onClick={onRefresh}>
          {e('refresh')}
        </Button>,
        <Button key='close' size='small' type='primary' onClick={onClose}>
          {e('close')}
        </Button>
      ]}
    >
      <div className='db-redis-info'>
        {
          error && !firstLoading
            ? (
              <Alert
                className='db-redis-info-err'
                type='error'
                showIcon
                message={e('dbRedisInfoFailed')}
                description={error}
              />
              )
            : null
        }
        {
          firstLoading
            ? (
              <div className='db-redis-info-loading'>
                <Spin size='small' />
              </div>
              )
            : null
        }
        {
          !loading && !hasText && !error
            ? <div className='db-redis-info-empty'>{e('dbRedisInfoEmpty')}</div>
            : null
        }
        {
          hasText
            ? (
              <Tabs
                size='small'
                items={[
                  {
                    key: 'overview',
                    label: e('dbRedisInfoOverview'),
                    children: (
                      <div className='db-redis-info-groups'>
                        {
                          overviewGroups(ov).map(g => (
                            <div className='db-redis-info-group' key={g.title}>
                              <div className='db-redis-info-group-title'>{g.title}</div>
                              {
                                g.rows.map(([k, v], i) => (
                                  <div
                                    className='db-redis-info-row'
                                    key={`${k}-${i}`}
                                  >
                                    <span className='db-redis-info-k'>{k}</span>
                                    <span
                                      className='db-redis-info-v elli'
                                      // 值可能被 ellipsis 截断（os、config_file 都是长串）
                                      title={typeof v === 'string' ? v : undefined}
                                    >
                                      {v}
                                    </span>
                                  </div>
                                ))
                              }
                            </div>
                          ))
                        }
                      </div>
                    )
                  },
                  {
                    key: 'keyspace',
                    label: e('dbRedisInfoKeyspace'),
                    children: (
                      <Table
                        size='small'
                        rowKey='db'
                        columns={keyspaceColumns}
                        dataSource={rows}
                        pagination={false}
                        locale={{ emptyText: e('dbRedisInfoNoKeyspace') }}
                      />
                    )
                  },
                  {
                    key: 'raw',
                    label: e('dbRedisInfoRaw'),
                    children: (
                      <pre className='db-redis-info-raw'>{String(text || '')}</pre>
                    )
                  }
                ]}
              />
              )
            : null
        }
      </div>
    </Modal>
  )
}
