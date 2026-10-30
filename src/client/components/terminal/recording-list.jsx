/**
 * G2：录制文件列表
 *
 * 数据全从主进程来（listRecordings 给名字/大小/时间，probeRecordings 给首尾两段），
 * 这里只做"把首尾两段读成一行的时长和首条命令"——格式解析仍然只在 cast-parser 一处。
 *
 * 两条刻意的口径：
 * - 探测失败/未探测只影响那一行的两列，不挡回放、删除、定位；
 * - 删除是唯一不可逆操作，所以走 Popconfirm 且删后立刻重取列表（不本地摘行，
 *   免得界面上的文件和磁盘对不上还被当成"删除失败"）。
 */

import { useCallback, useEffect, useState } from 'react'
import { Modal, Table, Button, Popconfirm, Tooltip, Alert, message } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'
import CastPlayer from './cast-player'
import { castProbeSummary } from '../../common/cast-parser.js'
import { formatBytes, formatDuration } from '../remote-monitor/monitor-model'
import './recording-list.styl'

const e = window.translate
const DASH = '—'
const PAD = n => String(n).padStart(2, '0')

// 列表按"哪天录的"看，跨年才带年份
const fmtMtime = ms => {
  if (!Number.isFinite(ms)) {
    return DASH
  }
  const d = new Date(ms)
  const now = new Date()
  const ymd = d.getFullYear() + '-' + PAD(d.getMonth() + 1) + '-' + PAD(d.getDate())
  const hms = PAD(d.getHours()) + ':' + PAD(d.getMinutes()) + ':' + PAD(d.getSeconds())
  const sameYear = d.getFullYear() === now.getFullYear()
  return (sameYear ? ymd.slice(5) : ymd) + ' ' + hms
}

export default function RecordingList (props) {
  const { open, onClose } = props
  const [list, setList] = useState({ loading: false, rows: [], dir: '', total: 0, error: '' })
  const [play, setPlay] = useState(null)
  const [deleting, setDeleting] = useState('')

  const refresh = useCallback(() => {
    setList(s => ({ ...s, loading: true, error: '' }))
    window.pre.runGlobalAsync('listRecordings')
      .then(res => {
        const files = (res && res.files) || []
        const names = files.map(f => f.name)
        if (!names.length) {
          setList({ loading: false, rows: [], dir: (res && res.dir) || '', total: 0, error: '' })
          return null
        }
        return window.pre.runGlobalAsync('probeRecordings', names)
          .then(probes => {
            const map = probes || {}
            const rows = files.map(f => {
              const p = map[f.name] || {}
              const sum = p.error === undefined && p.head !== undefined
                ? castProbeSummary(p.head, p.tail || '')
                : null
              return {
                key: f.name,
                name: f.name,
                size: f.size,
                mtimeMs: f.mtimeMs,
                probeError: p.error || '',
                invalid: !!(sum && sum.invalid),
                duration: sum && !sum.invalid ? sum.duration : null,
                firstCommand: sum && !sum.invalid ? sum.firstCommand : null
              }
            })
            setList({
              loading: false,
              rows,
              dir: (res && res.dir) || '',
              total: (res && res.total) || rows.length,
              error: ''
            })
          })
      })
      .catch(err => {
        setList({ loading: false, rows: [], dir: '', total: 0, error: String((err && err.message) || err) })
      })
  }, [])

  useEffect(() => {
    if (!open) {
      setPlay(null)
      return undefined
    }
    refresh()
    return undefined
  }, [open, refresh])

  const reveal = name => {
    window.pre.runGlobalAsync('showRecordingInFolder', name).catch(err => {
      message.error(String((err && err.message) || err))
    })
  }

  const del = name => {
    setDeleting(name)
    window.pre.runGlobalAsync('deleteRecording', name)
      .then(() => {
        setDeleting('')
        if (play && play.name === name) {
          setPlay(null)
        }
        refresh()
      })
      .catch(err => {
        setDeleting('')
        message.error(String((err && err.message) || err))
      })
  }

  const columns = [
    {
      title: e('name'),
      dataIndex: 'name',
      ellipsis: true,
      render: (v, r) => (
        <Tooltip title={v}>
          <span className='rec-name'>
            {v}
            {r.invalid ? <span className='rec-invalid-tag'>{e('castInvalidFile')}</span> : null}
          </span>
        </Tooltip>
      )
    },
    {
      title: e('size'),
      dataIndex: 'size',
      width: 92,
      render: v => <span className='rec-num'>{formatBytes(v)}</span>
    },
    {
      title: e('recDuration'),
      dataIndex: 'duration',
      width: 96,
      render: (v, r) => (
        <span className='rec-num' title={r.probeError ? r.probeError : undefined}>
          {v === null || v === undefined ? DASH : formatDuration(v)}
        </span>
      )
    },
    {
      title: e('recFirstCommand'),
      dataIndex: 'firstCommand',
      ellipsis: true,
      render: v => (v ? <span className='rec-cmd'>{v}</span> : <span className='rec-dash'>{DASH}</span>)
    },
    {
      title: e('recModified'),
      dataIndex: 'mtimeMs',
      width: 128,
      render: v => <span className='rec-num'>{fmtMtime(v)}</span>
    },
    {
      title: e('recAction'),
      key: 'op',
      width: 190,
      render: (_, r) => (
        <span className='rec-ops'>
          <Button
            size='small'
            type='primary'
            onClick={() => setPlay({ name: r.name })}
          >
            {e('castReplay')}
          </Button>
          <Button size='small' onClick={() => reveal(r.name)} title={e('recShowInFolder')}>
            <FolderOpenOutlined />
          </Button>
          <Popconfirm
            title={e('recDeleteConfirm')}
            okText={e('del')}
            cancelText={e('cancel')}
            onConfirm={() => del(r.name)}
          >
            <Button size='small' danger loading={deleting === r.name}>
              {e('del')}
            </Button>
          </Popconfirm>
        </span>
      )
    }
  ]

  const hint = list.dir
    ? list.dir + (list.total > list.rows.length ? ' · ' + e('recShowFirst') + ' ' + list.rows.length : '')
    : ''

  return (
    <Modal
      className='rec-list-modal'
      open={open}
      width={900}
      title={e('recordingFiles')}
      onCancel={onClose}
      footer={[
        <Button key='close' size='small' onClick={onClose}>{e('close')}</Button>
      ]}
    >
      <div className='rec-list' data-rec-count={list.rows.length} data-rec-total={list.total}>
        <div className='rec-list-head'>
          <span className='rec-list-dir' title={list.dir}>{hint || DASH}</span>
          <Button size='small' onClick={refresh} loading={list.loading}>{e('refresh')}</Button>
        </div>
        {
          list.error
            ? <Alert className='rec-list-error' type='error' showIcon message={list.error} />
            : null
        }
        <Table
          size='small'
          rowKey='key'
          loading={list.loading}
          columns={columns}
          dataSource={list.rows}
          pagination={list.rows.length > 30 ? { pageSize: 30, size: 'small' } : false}
          scroll={{ x: 760, y: '52vh' }}
          locale={{ emptyText: e('recEmptyHint') }}
        />
      </div>
      <CastPlayer
        open={!!play}
        rec={play}
        onClose={() => setPlay(null)}
      />
    </Modal>
  )
}
