/**
 * Redis 服务器信息弹层（H7a-4 + H7b-2 慢日志页签）
 *
 * 只做"把取回来的事实摆出来"：取数在 db-session（INFO 打开时拉一次、慢日志切到该页签
 * 才拉，都不轮询），解析在 common/db-redis-info.js 与 common/db-redis-slowlog.js，
 * 组件本身不碰 IPC。
 *
 * 界面口径只有一条要紧的：null 一律出「—」而不是 0。INFO 里 0 是合法值
 * （命中率 0%、maxmemory 0 = 不限），慢日志里 0 μs 也是合法值，
 * 把"没拿到"显示成 0 就等于替用户下了一个结论。
 */

import { useEffect, useState } from 'react'
import { Modal, Tabs, Table, Spin, Alert, Button } from 'antd'
import { parseRedisInfo, redisOverview, keyspaceRows, formatPercent } from '../../common/db-redis-info'
import { parseRedisSlowlog, slowlogStats, slowlogTsv, formatSlowDuration, formatSlowTime } from '../../common/db-redis-slowlog'
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

const slowlogColumns = [
  {
    title: e('dbRedisSlowlogColId'),
    dataIndex: 'id',
    key: 'id',
    width: 60,
    render: show
  },
  {
    title: e('dbRedisSlowlogColTime'),
    dataIndex: 'atMs',
    key: 'atMs',
    width: 160,
    render: v => formatSlowTime(v)
  },
  {
    title: e('dbRedisSlowlogColDuration'),
    dataIndex: 'durationUs',
    key: 'durationUs',
    width: 95,
    className: 'db-redis-slowlog-num',
    render: v => formatSlowDuration(v)
  },
  {
    // 命令名按服务端存的原样显示（Redis 不统一大小写），这里不做"看起来更整齐"的改写：
    // 弹层显示的与复制出去的、与客户端当初发出的必须是同一个串
    title: e('dbRedisSlowlogColCommand'),
    dataIndex: 'command',
    key: 'command',
    width: 100,
    render: show
  },
  {
    // 参数列必须给固定宽度 + ellipsis：单元格不回卷，没有宽度就会把整张表顶宽，
    // 横向滚动条一出现，右边的客户端列就永远看不着（原文要看就复制走 TSV）
    title: e('dbRedisSlowlogColArgs'),
    dataIndex: 'argText',
    key: 'argText',
    width: 160,
    ellipsis: true,
    className: 'db-redis-slowlog-args',
    render: a => (a === null || a === undefined || a === '' ? NA : a)
  },
  {
    title: e('dbRedisSlowlogColClient'),
    key: 'client',
    width: 150,
    ellipsis: true,
    render: (_, r) => [r.clientAddr, r.clientName].filter(Boolean).join(' · ') || NA
  }
]

/**
 * INFO 的三页（概览 / Keyspace / 原文）。
 * 单独成函数不只是嫌 render 太长：慢日志页签和它们同处一个 `items` 数组，
 * 内联三层三元 + 条件展开之后这段 JSX 的缩进已经没人看得懂了。
 */
function infoTabItems (ov, rows, text) {
  return [
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
  ]
}

export default function DbRedisInfoModal (props) {
  const { open, loading, error, text, onClose, onRefresh, slowlog, onLoadSlowlog, onRefreshSlowlog } = props
  const parsed = parseRedisInfo(text)
  const ov = redisOverview(parsed)
  const rows = keyspaceRows(parsed)
  const hasText = !!String(text || '').trim()
  // 首帧（还没有任何一份 INFO）才整块转圈；带旧数据刷新时继续显示旧内容，
  // 否则每次点"刷新"弹层都会闪成一张空板，看起来像信息丢了。
  // 刷新按钮自己的 loading 态就是"正在更新"的提示。
  const firstLoading = loading && !hasText
  const [tab, setTab] = useState('overview')
  const sl = slowlog || {}
  const slRows = parseRedisSlowlog(sl.entries)
  const slStats = slowlogStats(slRows)
  const slowlogOn = tab === 'slowlog'
  // 弹层不 destroyOnClose（保住 tab 索引不重建 DOM），所以每次打开都回到概览：
  // 停在慢日志页签重开，会先看到上一次的慢日志再被新数据顶掉，像闪了一份旧结果
  useEffect(() => {
    if (open) {
      setTab('overview')
    }
  }, [open])
  // 慢日志只在真正要看时拉一次：SLOWLOG GET 是把整段日志拷回来，
  // 只看概览的用户不该为它多付一次往返；已经在途/已经有数据就不再发
  const ensureSlowlog = () => {
    if (!Array.isArray(sl.entries) && !sl.loading && onLoadSlowlog) {
      onLoadSlowlog()
    }
  }
  const onTabChange = k => {
    setTab(k)
    if (k === 'slowlog') {
      ensureSlowlog()
    }
  }
  // INFO 没回原文时那三页压根不在 items 里，'overview' 就成了一个不存在的页签：
  // 顶着一张谁也选不中的页签，下面什么都没有。拨到唯一还在的慢日志页，并按"手动切进来"的规矩取数
  useEffect(() => {
    if (open && !loading && !hasText && tab === 'overview') {
      setTab('slowlog')
      ensureSlowlog()
    }
  }, [open, loading, hasText, tab])
  const refreshLoading = slowlogOn ? !!sl.loading : loading
  const onRefreshClick = () => {
    if (slowlogOn) {
      if (onRefreshSlowlog) onRefreshSlowlog()
      return
    }
    onRefresh()
  }
  const onCopyClick = () => {
    if (slowlogOn) {
      copy(slowlogTsv(slRows))
      return
    }
    copy(String(text || ''))
  }
  return (
    <Modal
      open={open}
      title={e('dbRedisInfo')}
      // 800 是六列慢日志不出现横向滚动条的下限（时间 19 字符 + 地址 · 客户端名）
      width={800}
      onCancel={onClose}
      footer={[
        <Button
          key='copy'
          size='small'
          icon={<CopyOutlined />}
          disabled={slowlogOn ? !slRows.length : !hasText}
          onClick={onCopyClick}
        >
          {e('copy')}
        </Button>,
        <Button key='refresh' size='small' loading={refreshLoading} onClick={onRefreshClick}>
          {e('refresh')}
        </Button>,
        <Button key='close' size='small' type='primary' onClick={onClose}>
          {e('close')}
        </Button>
      ]}
    >
      <div className='db-redis-info'>
        {
          // INFO 的报错条属于 INFO 那三页：三页还在时切到慢日志就藏起它，
          // 挂着它就像"慢日志也失败了"；但 INFO 没回原文时那三页根本不在，
          // 这条报错没有别处可去，藏掉就等于什么都不说
          error && !firstLoading && !(slowlogOn && hasText)
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
          !loading && !hasText && !error && !slowlogOn
            ? <div className='db-redis-info-empty'>{e('dbRedisInfoEmpty')}</div>
            : null
        }
        {
          firstLoading
            ? null
            : (
              <Tabs
                size='small'
                activeKey={tab}
                onChange={onTabChange}
                items={[
                  // INFO 那三页只在真拿到原文时出现：受管实例禁用 INFO 时，
                  // 弹层不该摆三张空页，但慢日志是另一条命令，不该被 INFO 的失败连坐
                  ...(hasText ? infoTabItems(ov, rows, text) : []),
                  {
                    key: 'slowlog',
                    label: e('dbRedisSlowlog'),
                    children: (
                      <div className='db-redis-slowlog'>
                        {
                          sl.error
                            ? (
                              <Alert
                                className='db-redis-info-err'
                                type='error'
                                showIcon
                                message={e('dbRedisSlowlogFailed')}
                                description={sl.error}
                              />
                              )
                            : null
                        }
                        {
                          // 首次进页签的取数在途：整块转圈；已有条目时刷新不闪空板
                          sl.loading && !Array.isArray(sl.entries)
                            ? (
                              <div className='db-redis-info-loading'>
                                <Spin size='small' />
                              </div>
                              )
                            : null
                        }
                        {
                          Array.isArray(sl.entries)
                            ? (
                              <>
                                <div className='db-redis-slowlog-status'>
                                  {
                                    slStats.count
                                      ? `${e('dbRedisSlowlogSummary')
                                        .replace('{n}', slStats.count)
                                        .replace('{max}', formatSlowDuration(slStats.maxUs))}`
                                      : e('dbRedisSlowlogEmpty')
                                  }
                                </div>
                                {
                                  // 没有条目就不摆表和表头：状态行已经把"没有"说清楚了，
                                  // 再让表格重复一遍只是让弹层多一块空白
                                  slStats.count
                                    ? (
                                      <Table
                                        size='small'
                                        rowKey={(r, i) => `${r.id}-${i}`}
                                        columns={slowlogColumns}
                                        dataSource={slRows}
                                        // 慢日志上限 512 条：一屏滚不到底，给个内部滚动而不是把弹层撑高
                                        scroll={{ y: 340 }}
                                        pagination={false}
                                      />
                                      )
                                    : null
                                }
                              </>
                              )
                            : null
                        }
                      </div>
                    )
                  }
                ]}
              />
              )
        }
      </div>
    </Modal>
  )
}
