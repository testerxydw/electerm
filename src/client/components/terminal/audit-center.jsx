/**
 * G8 审计中心：连接历史 + 传输历史 + 会话日志目录 → 一条能筛、能看、能导的时间线。
 *
 * 三栏的分工是"筛 → 选 → 看"：
 * - 左：类型 / 主机 / 日期三组候选（都从真实行里统计，不是写死的枚举）；
 * - 中：时间线（时间 · 主机 · 用户 · 时长 · 类型 · 产物），点一行选中；
 * - 右：选中行的详情——录制走 G2 回放器，日志读尾部 500 行，都在这一栏落地。
 *
 * 三处刻意的口径：
 * - 只读。删文件另有 G2 的入口，这里连按钮都不给，审计视图不该成为回收站；
 * - 导出的是"当前筛出来看到的那些行"，不是全量——导出的东西要能对着屏幕核；
 * - 日期分桶复用 audit-model 的 groupByDay：选了哪天就直接取那一桶的行，
 *   不在组件里再算一遍本地日历，两处日历迟早漂移。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Modal, Table, Button, Input, Alert, Tooltip, message } from 'antd'
import {
  FolderOpenOutlined,
  ReloadOutlined,
  DownloadOutlined,
  SearchOutlined
} from '@ant-design/icons'
import classnames from 'classnames'
import CastPlayer from './cast-player'
import { castProbeSummary } from '../../common/cast-parser.js'
import { stripAnsi } from './automation/strip-ansi.js'
import download from '../../common/download.jsx'
import time from '../../common/time.js'
import { formatBytes, formatDuration } from '../remote-monitor/monitor-model'
import {
  KIND,
  buildAuditRows,
  filterAuditRows,
  facetCounts,
  groupByDay,
  auditToCsv,
  auditToMarkdown
} from '../../common/audit-model.js'
import './audit-center.styl'

const e = window.translate
const DASH = '—'
const CAST_EXT = '.cast'
const LOG_EXT = '.log'
// 与主进程 readLogTail 的默认窗口一致：界面不说"全部"，只说"尾部"
const TAIL_LINES = 500
const PAGE_SIZE = 40
const emptyTail = { loading: false, name: '', lines: [], omitted: 0, truncated: false, error: '' }

const kindLabel = kind => {
  if (kind === KIND.session) {
    return e('auditKindSession')
  }
  if (kind === KIND.transfer) {
    return e('auditKindTransfer')
  }
  if (kind === KIND.recording) {
    return e('auditKindRecording')
  }
  return e('auditKindLog')
}

const isCast = name => String(name || '').endsWith(CAST_EXT)
const isLog = name => String(name || '').endsWith(LOG_EXT)

export default function AuditCenter (props) {
  const { open, onClose, history, transferHistory } = props
  const [state, setState] = useState({
    loading: false,
    rows: [],
    dir: '',
    exists: true,
    total: 0,
    fileCount: 0,
    error: ''
  })
  const [kinds, setKinds] = useState([])
  const [hosts, setHosts] = useState([])
  const [day, setDay] = useState('')
  const [text, setText] = useState('')
  const [selectedKey, setSelectedKey] = useState('')
  const [tail, setTail] = useState(emptyTail)
  const [play, setPlay] = useState(null)
  const [exporting, setExporting] = useState('')

  const load = useCallback(() => {
    setState(s => ({ ...s, loading: true, error: '' }))
    window.pre.runGlobalAsync('auditOp', 'list')
      .then(res => {
        const files = (res && res.files) || []
        const next = {
          dir: (res && res.dir) || '',
          exists: res ? res.exists !== false : true,
          total: (res && res.total) || 0
        }
        const casts = files.filter(f => isCast(f.name)).map(f => f.name)
        if (!casts.length) {
          return { files, next, probes: {} }
        }
        // 首尾两段仍由 G2 的探测口给（主进程只搬字节），这里只把它读成时长/首条命令
        return window.pre.runGlobalAsync('probeRecordings', casts)
          .then(probes => ({ files, next, probes: probes || {} }))
      })
      .then(({ files, next, probes }) => {
        const withProbe = files.map(f => {
          if (!isCast(f.name)) {
            return { ...f }
          }
          const p = probes[f.name]
          if (!p || p.error !== undefined || p.head === undefined) {
            return { ...f }
          }
          const sum = castProbeSummary(p.head, p.tail || '')
          return {
            ...f,
            duration: sum.invalid ? null : sum.duration,
            firstCommand: sum.invalid ? null : sum.firstCommand
          }
        })
        setState({
          loading: false,
          rows: buildAuditRows({ history, transfers: transferHistory, files: withProbe }),
          error: '',
          fileCount: files.length,
          ...next
        })
      })
      .catch(err => {
        setState({
          loading: false,
          rows: [],
          dir: '',
          exists: true,
          total: 0,
          fileCount: 0,
          error: String((err && err.message) || err)
        })
      })
  }, [history, transferHistory])

  // 每次打开都重新取：历史与日志目录都是"上一眼之后还在长"的东西
  useEffect(() => {
    if (!open) {
      setPlay(null)
      setSelectedKey('')
      setTail(emptyTail)
      return undefined
    }
    load()
    return undefined
  }, [open, load])

  const kindFacets = useMemo(() => facetCounts(state.rows, 'kind'), [state.rows])
  const hostFacets = useMemo(() => facetCounts(state.rows, 'host'), [state.rows])
  // 先按类型/主机/关键字筛，再分桶：日期那栏显示的条数才是"其他筛选条件下每天的条数"
  const preDay = useMemo(
    () => filterAuditRows(state.rows, { kinds, hosts, text }),
    [state.rows, kinds, hosts, text]
  )
  const buckets = useMemo(() => groupByDay(preDay), [preDay])
  const visible = useMemo(() => {
    if (!day) {
      return preDay
    }
    const hit = buckets.find(b => b.day === day)
    return hit ? hit.rows : []
  }, [day, preDay, buckets])
  const selected = useMemo(
    () => visible.find(r => r.key === selectedKey) || null,
    [visible, selectedKey]
  )

  const artifact = selected && selected.artifact ? String(selected.artifact) : ''

  // 选中日志才读尾部；录制只看首尾探测，全文交给回放器（它自己会读）
  useEffect(() => {
    if (!artifact || !isLog(artifact)) {
      setTail(emptyTail)
      return undefined
    }
    let dead = false
    setTail({ ...emptyTail, loading: true, name: artifact })
    window.pre.runGlobalAsync('auditOp', 'readTail', { name: artifact, lines: TAIL_LINES })
      .then(res => {
        if (dead) {
          return
        }
        setTail({
          loading: false,
          name: artifact,
          lines: ((res && res.lines) || []).map(line => stripAnsi(line)),
          omitted: (res && res.omitted) || 0,
          truncated: !!(res && res.truncated),
          error: ''
        })
      })
      .catch(err => {
        if (dead) {
          return
        }
        setTail({
          ...emptyTail,
          name: artifact,
          error: String((err && err.message) || err)
        })
      })
    return () => {
      dead = true
    }
  }, [artifact])

  const toggle = (list, setList, value) => {
    setList(list.includes(value) ? list.filter(v => v !== value) : [...list, value])
  }

  const resetFilters = () => {
    setKinds([])
    setHosts([])
    setDay('')
    setText('')
  }

  const filtered = kinds.length || hosts.length || day || text

  const reveal = name => {
    window.pre.runGlobalAsync('auditOp', 'show', { name }).catch(err => {
      message.error(String((err && err.message) || err))
    })
  }

  const openDir = () => {
    window.pre.runGlobalAsync('openSessionLogDir').catch(err => {
      message.error(String((err && err.message) || err))
    })
  }

  const doExport = (fmt) => {
    if (!visible.length) {
      message.info(e('noData'))
      return
    }
    const labels = {
      time: e('auditTime'),
      kind: e('type'),
      host: e('host'),
      user: e('auditUser'),
      duration: e('recDuration'),
      artifact: e('auditArtifact'),
      size: e('size'),
      count: e('count'),
      detail: e('auditDetail')
    }
    // 导出时刻只取一次：表头的"导出于"与文件名必须同源，否则两份文件对不上
    const at = Date.now()
    const body = fmt === 'csv'
      ? auditToCsv(visible, { at, labels })
      : auditToMarkdown(visible, { at, labels, title: e('auditCenter') })
    setExporting(fmt)
    download(
      'electerm-audit-' + time(at, 'YYYY-MM-DD-HH-mm-ss') + (fmt === 'csv' ? '.csv' : '.md'),
      body
    )
      .then(() => setExporting(''))
      .catch(err => {
        setExporting('')
        message.error(String((err && err.message) || err))
      })
  }

  const columns = [
    {
      title: e('auditTime'),
      dataIndex: 'time',
      width: 152,
      render: v => <span className='audit-num'>{v === null ? DASH : time(v)}</span>
    },
    {
      title: e('host'),
      dataIndex: 'host',
      width: 150,
      ellipsis: true,
      render: v => (v
        ? <span className='audit-host' title={v}>{v}</span>
        : <span className='audit-dash'>{DASH}</span>)
    },
    {
      title: e('auditUser'),
      dataIndex: 'user',
      width: 100,
      ellipsis: true,
      render: v => (v ? <span className='audit-host' title={v}>{v}</span> : <span className='audit-dash'>{DASH}</span>)
    },
    {
      title: e('recDuration'),
      dataIndex: 'duration',
      width: 92,
      render: v => <span className='audit-num'>{v === null ? DASH : formatDuration(v / 1000)}</span>
    },
    {
      title: e('type'),
      dataIndex: 'kind',
      width: 118,
      render: (v, r) => (
        <span className='audit-kind'>
          {kindLabel(v)}
          {r.count > 1 ? <span className='audit-count'>×{r.count}</span> : null}
        </span>
      )
    },
    {
      title: e('auditArtifact'),
      dataIndex: 'artifact',
      ellipsis: true,
      render: (v, r) => (v
        ? <span className='audit-artifact' title={v}>{v}</span>
        : <span className='audit-dash' title={r.detail}>{DASH}</span>)
    }
  ]

  const renderFacet = (title, items, active, onToggle, extra) => (
    <div className='audit-facet'>
      <div className='audit-facet-title'>
        {title}
        {extra}
      </div>
      <div className='audit-facet-list'>
        {
          items.length
            ? items.map(it => (
              <div
                key={it.value}
                className={classnames('audit-facet-item', { on: active.includes(it.value) })}
                onClick={() => onToggle(it.value)}
                title={it.title || it.value}
              >
                <span className='audit-facet-label'>{it.label || it.value}</span>
                <span className='audit-facet-count'>{it.count}</span>
              </div>
            ))
            : <div className='audit-facet-empty'>{e('noData')}</div>
        }
      </div>
    </div>
  )

  // 目录列不出来不等于没有：主进程给了 total（真实文件数）才说"只列了前 N 个"
  const dirHint = state.dir
    ? state.dir + (state.total > state.fileCount
      ? ' · ' + e('auditShowFirst') + ' ' + state.fileCount
      : '')
    : ''

  return (
    <Modal
      className='audit-center-modal'
      open={open}
      width={1180}
      title={e('auditCenter')}
      onCancel={onClose}
      footer={[
        <Button
          key='csv'
          size='small'
          icon={<DownloadOutlined />}
          loading={exporting === 'csv'}
          onClick={() => doExport('csv')}
        >
          {e('auditExportCsv')}
        </Button>,
        <Button
          key='md'
          size='small'
          icon={<DownloadOutlined />}
          loading={exporting === 'md'}
          onClick={() => doExport('md')}
        >
          {e('auditExportMarkdown')}
        </Button>,
        <Button key='dir' size='small' icon={<FolderOpenOutlined />} onClick={openDir}>
          {e('auditOpenLogDir')}
        </Button>,
        <Button key='refresh' size='small' icon={<ReloadOutlined />} onClick={load} loading={state.loading}>
          {e('refresh')}
        </Button>,
        <Button key='close' size='small' onClick={onClose}>{e('close')}</Button>
      ]}
    >
      <div
        className='audit-center'
        data-audit-rows={visible.length}
        data-audit-total={state.rows.length}
        data-audit-day={day}
      >
        <div className='audit-col audit-col-filters'>
          <div className='audit-search'>
            <Input
              size='small'
              allowClear
              prefix={<SearchOutlined />}
              placeholder={e('search')}
              value={text}
              onChange={ev => setText(ev.target.value)}
            />
          </div>
          {
            renderFacet(
              e('type'),
              kindFacets.map(f => ({ ...f, label: kindLabel(f.value) })),
              kinds,
              v => toggle(kinds, setKinds, v)
            )
          }
          {
            renderFacet(
              e('host'),
              hostFacets,
              hosts,
              v => toggle(hosts, setHosts, v),
              <Tooltip title={e('auditHostFilterNote')}>
                <span className='audit-facet-mark'>?</span>
              </Tooltip>
            )
          }
          {
            renderFacet(
              e('auditDays'),
              buckets.map(b => ({ value: b.day, count: b.rows.length, label: b.day || e('auditNoTime') })),
              day ? [day] : [],
              v => setDay(day === v ? '' : v)
            )
          }
          <div className='audit-filter-foot'>
            <span className='audit-count-summary'>
              {visible.length} / {state.rows.length}
            </span>
            <Button size='small' type='text' onClick={resetFilters} disabled={!filtered}>
              {e('reset')}
            </Button>
          </div>
        </div>
        <div className='audit-col audit-col-timeline'>
          {
            state.error
              ? <Alert className='audit-alert' type='error' showIcon message={state.error} />
              : null
          }
          {
            !state.error && state.dir && !state.exists
              ? <Alert className='audit-alert' type='warning' showIcon message={e('auditDirMissing')} />
              : null
          }
          <Table
            size='small'
            rowKey='key'
            loading={state.loading}
            columns={columns}
            dataSource={visible}
            pagination={visible.length > PAGE_SIZE ? { pageSize: PAGE_SIZE, size: 'small' } : false}
            scroll={{ x: 742, y: '46vh' }}
            locale={{ emptyText: e('auditTimelineEmpty') }}
            rowClassName={r => (r.key === selectedKey ? 'audit-row audit-row-on' : 'audit-row')}
            onRow={r => ({ onClick: () => setSelectedKey(r.key) })}
          />
          <div className='audit-dir' title={dirHint}>{dirHint || DASH}</div>
        </div>
        <div className='audit-col audit-col-detail'>
          {
            selected
              ? (
                <div className='audit-detail'>
                  <div className='audit-detail-head'>
                    <span className='audit-detail-kind'>{kindLabel(selected.kind)}</span>
                    <span className='audit-detail-time'>
                      {selected.time === null ? DASH : time(selected.time)}
                    </span>
                  </div>
                  <div className='audit-kv'>
                    <div className='audit-kv-row'>
                      <span className='audit-kv-key'>{e('host')}</span>
                      <span className='audit-kv-val'>{selected.host || DASH}</span>
                    </div>
                    <div className='audit-kv-row'>
                      <span className='audit-kv-key'>{e('auditUser')}</span>
                      <span className='audit-kv-val'>{selected.user || DASH}</span>
                    </div>
                    <div className='audit-kv-row'>
                      <span className='audit-kv-key'>{e('auditConnType')}</span>
                      <span className='audit-kv-val'>
                        {selected.connType || DASH}
                        {selected.count > 1 ? ' ×' + selected.count : ''}
                      </span>
                    </div>
                    <div className='audit-kv-row'>
                      <span className='audit-kv-key'>{e('recDuration')}</span>
                      <span className='audit-kv-val'>
                        {selected.duration === null ? DASH : formatDuration(selected.duration / 1000)}
                      </span>
                    </div>
                    <div className='audit-kv-row'>
                      <span className='audit-kv-key'>{e('size')}</span>
                      <span className='audit-kv-val'>{formatBytes(selected.size)}</span>
                    </div>
                    <div className='audit-kv-row'>
                      <span className='audit-kv-key'>{e('auditArtifact')}</span>
                      <span className='audit-kv-val audit-kv-wrap'>{selected.artifact || DASH}</span>
                    </div>
                    <div className='audit-kv-row'>
                      <span className='audit-kv-key'>{e('auditDetail')}</span>
                      <span className='audit-kv-val audit-kv-wrap'>{selected.detail || DASH}</span>
                    </div>
                  </div>
                  <div className='audit-detail-ops'>
                    {
                      isCast(artifact)
                        ? (
                          <Button size='small' type='primary' onClick={() => setPlay({ name: artifact })}>
                            {e('castReplay')}
                          </Button>
                          )
                        : null
                    }
                    {
                      artifact
                        ? (
                          <Button size='small' icon={<FolderOpenOutlined />} onClick={() => reveal(artifact)}>
                            {e('recShowInFolder')}
                          </Button>
                          )
                        : null
                    }
                    {
                      !artifact
                        ? <span className='audit-detail-note'>{e('auditNoArtifact')}</span>
                        : null
                    }
                  </div>
                  <div className='audit-tail'>
                    <div className='audit-tail-title'>
                      {e('auditLogTail')}
                      {
                        tail.name && isLog(tail.name) && !tail.loading
                          ? (
                            <span className='audit-tail-meta'>
                              {tail.lines.length}
                              {tail.omitted > 0 ? ' · ' + tail.omitted + ' ' + e('auditOmitted') : ''}
                              {tail.truncated ? ' · ' + e('auditWindowOnly') : ''}
                            </span>
                            )
                          : null
                      }
                    </div>
                    {
                      !artifact || !isLog(artifact)
                        ? <div className='audit-tail-empty'>{e('auditTailOnlyLog')}</div>
                        : null
                    }
                    {tail.error ? <div className='audit-tail-error'>{tail.error}</div> : null}
                    {
                      artifact && isLog(artifact) && !tail.error
                        ? (
                            tail.lines.length
                              ? (
                                <pre className='audit-tail-pre'>
                                  {tail.lines.map((line, i) => <div key={i} className='audit-tail-line'>{line || ' '}</div>)}
                                </pre>
                                )
                              : (
                                <div className='audit-tail-empty'>
                                  {tail.loading ? e('loading') : e('auditTailEmpty')}
                                </div>
                                )
                          )
                        : null
                    }
                  </div>
                </div>
                )
              : <div className='audit-detail-empty'>{e('auditDetailEmpty')}</div>
          }
        </div>
      </div>
      <CastPlayer open={!!play} rec={play} onClose={() => setPlay(null)} />
    </Modal>
  )
}
