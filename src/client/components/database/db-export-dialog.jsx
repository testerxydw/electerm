/**
 * C 批「导出到文件」对话框（设计 §10.3）
 *
 * 四步向导：格式 → 列 → 输出 → 执行，可回退且参数不丢（各步状态独立存，
 * 回退只改 step 不清值）。目标路径经主进程 showSaveDialog（window.api.saveDialog，
 * 渲染层不碰 fs）；执行走 dbExportOp start/status/cancel 轮询。
 *
 * C-12 所见即所导：db-session 发起时把 viewParts(viewRef.current) 的
 * where/whereParams/orderClauses 一起传入（与网格同源），有条件时显式提示。
 *
 * 组件只管收集与展示：格式/列的合法性由主进程 db-exporter 兜底（列白名单、
 * 路径非空），这里不做第二套判定。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Steps, Radio, Checkbox, Button, Alert, Input } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'

const e = window.translate

const FORMATS = ['csv', 'tsv', 'json', 'jsonl', 'sql', 'markdown']

// 格式 → 保存对话框元信息（扩展名/过滤器名；markdown 落盘用 .md 更通用）
const FORMAT_META = {
  csv: { ext: 'csv', label: 'CSV' },
  tsv: { ext: 'tsv', label: 'TSV' },
  json: { ext: 'json', label: 'JSON' },
  jsonl: { ext: 'jsonl', label: 'JSONL' },
  sql: { ext: 'sql', label: 'SQL' },
  markdown: { ext: 'md', label: 'Markdown' }
}

function formatBytes (n) {
  const v = Number(n) || 0
  if (v < 1024) {
    return v + ' B'
  }
  if (v < 1024 * 1024) {
    return (v / 1024).toFixed(1) + ' KB'
  }
  return (v / 1024 / 1024).toFixed(1) + ' MB'
}

export default function DbExportDialog (props) {
  const {
    open = false,
    onClose = () => {},
    tabId = '',
    database = '',
    schema = '',
    table = '',
    columns = [],
    where = '',
    whereParams = [],
    orderClauses = []
  } = props
  const [step, setStep] = useState(0)
  const [format, setFormat] = useState('csv')
  const [picked, setPicked] = useState([])
  const [targetPath, setTargetPath] = useState('')
  // run: { exportId, status, rowsWritten, bytes, error }；null = 未发起
  const [run, setRun] = useState(null)
  const runIdRef = useRef('')

  const colNames = useMemo(
    () => (columns || []).map(c => c && c.name).filter(n => typeof n === 'string' && n),
    [columns]
  )
  const colKey = colNames.join('\u0000')
  // 有主键判定放调用方（db-session），这里只负责展示提示
  const hasPk = (columns || []).some(c => c && c.isPrimaryKey === true)
  // C-12：与网格同源的过滤条件
  const hasFilter = String(where || '').trim() !== ''

  // 打开即重置四步状态（列默认全选）；结构列异步到达时补齐全选，
  // colKey 不变（用户已在步骤 1 改选）时不会被打回
  useEffect(() => {
    if (open) {
      setStep(0)
      setFormat('csv')
      setPicked(colNames)
      setTargetPath('')
      setRun(null)
      runIdRef.current = ''
    }
  }, [open, colKey])

  // 轮询执行状态：500ms 一次，非 running 即停
  useEffect(() => {
    const exportId = run && run.exportId
    const status = run && run.status
    if (!exportId || status !== 'running') {
      return undefined
    }
    const timer = setInterval(async () => {
      // 只轮询仍属于本次执行的 id：取消/重开后旧定时器不再回写
      if (runIdRef.current !== exportId) {
        return
      }
      try {
        const st = await window.pre.runGlobalAsync('dbExportOp', 'status', { exportId })
        if (runIdRef.current !== exportId) {
          return
        }
        setRun(prev => ({ ...(prev || {}), ...st }))
      } catch (err) {
        if (runIdRef.current === exportId) {
          setRun(prev => ({ ...(prev || {}), status: 'failed', error: err.message }))
        }
      }
    }, 500)
    return () => clearInterval(timer)
  }, [run && run.exportId, run && run.status])

  // 卸载兜底：任务在主进程侧继续跑完没关系，前端不再轮询
  useEffect(() => () => {
    runIdRef.current = ''
  }, [])

  const pickPath = async () => {
    const meta = FORMAT_META[format] || FORMAT_META.csv
    const res = await window.api.saveDialog({
      title: e('dbExportOutput'),
      defaultPath: `db-${database || 'table'}-${table}.${meta.ext}`,
      filters: [{ name: meta.label, extensions: [meta.ext] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    if (res && !res.canceled && res.filePath) {
      setTargetPath(res.filePath)
    }
  }

  const start = async () => {
    // 全选不传 columns（后端默认结构列序全导）；部分选择才传子集
    const args = {
      tabId,
      database,
      schema,
      table,
      format,
      targetPath,
      columns: picked.length && picked.length < colNames.length ? picked : undefined,
      where: hasFilter ? where : undefined,
      whereParams: hasFilter && (whereParams || []).length ? whereParams : undefined,
      orderClauses: (orderClauses || []).length ? orderClauses : undefined
    }
    try {
      const res = await window.pre.runGlobalAsync('dbExportOp', 'start', args)
      const exportId = res && res.exportId
      runIdRef.current = exportId
      setRun({ exportId, status: 'running', rowsWritten: 0, bytes: 0, error: null })
    } catch (err) {
      runIdRef.current = ''
      setRun({ exportId: null, status: 'failed', rowsWritten: 0, bytes: 0, error: err.message })
    }
  }

  const cancelRun = () => {
    if (run && run.exportId) {
      window.pre.runGlobalAsync('dbExportOp', 'cancel', { exportId: run.exportId }).catch(() => {})
    }
  }

  const canNext = step === 0 || (step === 1 ? picked.length > 0 : !!targetPath)
  const running = run && run.status === 'running'
  const finished = run && (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled')

  const next = () => {
    if (step < 2) {
      setStep(step + 1)
      return
    }
    // 步骤 2 → 3：发起导出
    start()
  }

  const renderBody = () => {
    if (step === 0) {
      return (
        <div className='db-export-step'>
          <div className='db-export-step-title'>{e('dbExportFormat')}</div>
          <Radio.Group value={format} onChange={ev => setFormat(ev.target.value)}>
            {FORMATS.map(f => (
              <Radio key={f} value={f} className='db-export-format-item'>
                {FORMAT_META[f].label}
              </Radio>
            ))}
          </Radio.Group>
          {
            hasFilter
              ? <Alert className='db-export-note' type='info' showIcon description={e('dbExportFilterNote')} />
              : null
          }
        </div>
      )
    }
    if (step === 1) {
      return (
        <div className='db-export-step'>
          <div className='db-export-step-title'>{e('dbExportColumns')}</div>
          <Checkbox.Group
            className='db-export-cols'
            value={picked}
            onChange={setPicked}
          >
            {colNames.map(n => (
              <Checkbox key={n} value={n} className='db-export-col-item'>{n}</Checkbox>
            ))}
          </Checkbox.Group>
          {
            !hasPk
              ? <Alert className='db-export-note' type='warning' showIcon description={e('dbExportNoPk')} />
              : null
          }
        </div>
      )
    }
    if (step === 2) {
      return (
        <div className='db-export-step'>
          <div className='db-export-step-title'>{e('dbExportOutput')}</div>
          <div className='db-export-path-row'>
            <Input value={targetPath} readOnly placeholder={e('dbImportNoFile')} />
            <Button icon={<FolderOpenOutlined />} onClick={pickPath}>
              {e('dbExportPickFile')}
            </Button>
          </div>
          <div className='db-export-summary'>
            {`${database ? database + '.' : ''}${table} · ${(FORMAT_META[format] || {}).label || format}`}
          </div>
        </div>
      )
    }
    // 步骤 3：执行态
    return (
      <div className='db-export-step'>
        <div className='db-export-step-title'>{e('dbExportRun')}</div>
        {
          running
            ? (
              <div className='db-export-progress'>
                <div className='db-export-progress-line'>
                  {e('dbExportProgress').replace('{n}', String((run && run.rowsWritten) || 0))}
                </div>
                <div className='db-export-progress-sub'>
                  {formatBytes(run && run.bytes)}
                </div>
              </div>
              )
            : null
        }
        {
          run && run.status === 'done'
            ? (
              <Alert
                type='success'
                showIcon
                description={e('dbExportDone').replace('{n}', String(run.rowsWritten))}
              />
              )
            : null
        }
        {
          run && run.status === 'cancelled'
            ? (
              <Alert
                type='warning'
                showIcon
                description={e('dbExportCancelled').replace('{n}', String(run.rowsWritten))}
              />
              )
            : null
        }
        {
          run && run.status === 'failed'
            ? (
              <Alert
                type='error'
                showIcon
                description={run.error || e('dbExportFailed')}
              />
              )
            : null
        }
      </div>
    )
  }

  const footer = []
  if (!finished) {
    footer.push(
      step > 0 && !running
        ? (
          <Button key='prev' onClick={() => setStep(step - 1)}>
            {e('dbWizardPrev')}
          </Button>
          )
        : null
    )
    if (running) {
      footer.push(
        <Button key='cancel' onClick={cancelRun}>{e('dbExportCancel')}</Button>
      )
    } else if (!finished) {
      footer.push(
        <Button key='next' type='primary' disabled={!canNext} onClick={next}>
          {step === 2 ? e('dbExportStart') : e('dbWizardNext')}
        </Button>
      )
    }
  }
  footer.push(
    <Button key='close' onClick={onClose}>
      {finished || running ? e('close') : e('cancel')}
    </Button>
  )

  return (
    <Modal
      open={open}
      className='db-export-modal'
      width={560}
      title={e('dbExportTitle')}
      footer={footer}
      maskClosable={false}
      onCancel={onClose}
    >
      <Steps
        size='small'
        current={step}
        items={[
          { title: e('dbExportFormat') },
          { title: e('dbExportColumns') },
          { title: e('dbExportOutput') },
          { title: e('dbExportRun') }
        ]}
      />
      <div className='db-export-body'>{renderBody()}</div>
    </Modal>
  )
}
