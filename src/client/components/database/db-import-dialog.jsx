/**
 * C 批「导入 CSV/TSV」向导（设计 §10）
 *
 * 四步：选文件 → 列映射 → 写入模式 → 执行。文件选择与解析都在主进程
 * （dbImportOp openFile 返回表头 + 样例行，渲染层不读文件）；映射折算与
 * upsert 主键覆盖判断走纯函数层（../../common/db-import-mapping）。
 *
 * 危险模式（overwrite/upsert）在 production 连接上先过 E1 闸门
 * （props.confirmRisk 由 db-session 提供，复用 riskGate 弹窗）；
 * 前端取消 = 零调用。
 *
 * 取消语义必须明示：主进程在批次边界止步，已提交批次保留、不回滚
 * （dbImportCancelNote）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Steps, Button, Select, Input, InputNumber, Radio, Checkbox, Alert, Tooltip } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'
import message from '../common/message'
import {
  buildImportMapping,
  mappingProblem,
  pkCovered
} from '../../common/db-import-mapping'

const e = window.translate

// 模式选项值（Select value）：column: 前缀 = field 映射到该列，其余是特殊形态
const OPT_IGNORE = 'ignore'
const OPT_CONSTANT = 'constant'
const OPT_EXPRESSION = 'expression'
const OPT_NULL = 'null'

function optValueOf (r) {
  if (!r || r.mode === 'ignore' || r.mode === undefined) {
    return OPT_IGNORE
  }
  if (r.mode === 'field') {
    return 'column:' + String(r.target || '')
  }
  return r.mode
}

export default function DbImportDialog (props) {
  const {
    open = false,
    onClose = () => {},
    tabId = '',
    database = '',
    schema = '',
    table = '',
    columns = [],
    confirmRisk = async () => true
  } = props
  const [step, setStep] = useState(0)
  const [fileLoading, setFileLoading] = useState(false)
  // file: { filePath, columns, sampleRows, delimiter, totalBytes }
  const [file, setFile] = useState(null)
  // 映射行（UI 形态），见 db-import-mapping.js 头注释
  const [rows, setRows] = useState([])
  const [mode, setMode] = useState('append')
  const [dangerConfirmed, setDangerConfirmed] = useState(false)
  const [batchSize, setBatchSize] = useState(500)
  // run: { importId, status, committedRows, failedBatches, errors, error }
  const [run, setRun] = useState(null)
  const runIdRef = useRef('')

  const targetNames = useMemo(
    () => (columns || []).map(c => c && c.name).filter(n => typeof n === 'string' && n),
    [columns]
  )
  const pkNames = useMemo(
    () => (columns || [])
      .filter(c => c && c.isPrimaryKey === true)
      .map(c => c.name),
    [columns]
  )
  const fileCols = (file && file.columns) || []

  // 打开即重置
  useEffect(() => {
    if (open) {
      setStep(0)
      setFile(null)
      setRows([])
      setMode('append')
      setDangerConfirmed(false)
      setBatchSize(500)
      setRun(null)
      runIdRef.current = ''
    }
  }, [open])

  // 文件就绪后构建初始映射行：同名目标列默认 field，其余默认忽略
  useEffect(() => {
    if (!file) {
      setRows([])
      return
    }
    setRows(fileCols.map(col => {
      const name = String(col)
      const same = targetNames.find(n => n.toLowerCase() === name.toLowerCase())
      return {
        fileCol: name,
        mode: same ? 'field' : 'ignore',
        target: same || '',
        objCol: same || '',
        constVal: '',
        exprSql: ''
      }
    }))
  }, [file])

  // 轮询导入状态：500ms 一次，done/cancelled/failed 即停
  useEffect(() => {
    const importId = run && run.importId
    const status = run && run.status
    if (!importId || status !== 'running') {
      return undefined
    }
    const timer = setInterval(async () => {
      if (runIdRef.current !== importId) {
        return
      }
      try {
        const st = await window.pre.runGlobalAsync('dbImportOp', 'status', { importId })
        if (runIdRef.current !== importId) {
          return
        }
        setRun(prev => ({ ...(prev || {}), ...st }))
      } catch (err) {
        if (runIdRef.current === importId) {
          setRun(prev => ({ ...(prev || {}), status: 'failed', error: err.message }))
        }
      }
    }, 500)
    return () => clearInterval(timer)
  }, [run && run.importId, run && run.status])

  useEffect(() => () => {
    runIdRef.current = ''
  }, [])

  const pickFile = async () => {
    setFileLoading(true)
    try {
      const res = await window.pre.runGlobalAsync('dbImportOp', 'openFile', {})
      if (res && res.filePath) {
        if (!res.columns || !res.columns.length) {
          message.error(e('dbImportNoFile'))
          return
        }
        setFile(res)
      }
    } catch (err) {
      message.error(err.message)
    } finally {
      setFileLoading(false)
    }
  }

  const setRow = (idx, patch) => {
    setRows(prev => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }

  // 模式下拉：目标列名 + 特殊形态。切形态时保留各形态的输入（回退不丢参数）
  const onRowOpt = (idx, val) => {
    if (val.startsWith('column:')) {
      setRow(idx, { mode: 'field', target: val.slice(7) })
      return
    }
    if (val === OPT_IGNORE) {
      setRow(idx, { mode: 'ignore' })
      return
    }
    setRow(idx, { mode: val })
  }

  const canNextMapping = rows.some(r => r && r.mode !== 'ignore' && r.mode !== undefined) &&
    mappingProblem(rows) === null

  const upsertOk = pkCovered(pkNames, rows)
  const dangerMode = mode === 'overwrite' || mode === 'upsert'
  const canNextMode = !dangerMode || dangerConfirmed

  const start = async () => {
    let mapping = null
    try {
      mapping = buildImportMapping(rows)
    } catch (err) {
      message.error(e(err.message))
      return
    }
    // 危险模式 production 闸门（E1 同款）：取消 = 零调用
    if (dangerMode) {
      const ok = await confirmRisk(mode)
      if (!ok) {
        return
      }
    }
    try {
      const res = await window.pre.runGlobalAsync('dbImportOp', 'start', {
        tabId,
        database,
        schema,
        table,
        mapping,
        mode,
        batchSize
      })
      const importId = res && res.importId
      runIdRef.current = importId
      setRun({ importId, status: 'running', committedRows: 0, failedBatches: 0, errors: [], error: null })
      setStep(3)
    } catch (err) {
      message.error(err.message)
    }
  }

  const cancelRun = () => {
    if (run && run.importId) {
      window.pre.runGlobalAsync('dbImportOp', 'cancel', { importId: run.importId }).catch(() => {})
    }
  }

  const running = run && run.status === 'running'
  const finished = run && (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled')

  const renderBody = () => {
    if (step === 0) {
      return (
        <div className='db-import-step'>
          <div className='db-import-path-row'>
            <Button
              loading={fileLoading}
              icon={<FolderOpenOutlined />}
              onClick={pickFile}
            >
              {e('dbImportPickFile')}
            </Button>
          </div>
          {
            file
              ? (
                <div className='db-import-file-info'>
                  <div className='db-import-file-path'>{file.filePath}</div>
                  <div className='db-import-sample'>
                    {(file.sampleRows || []).slice(0, 3).map((r, i) => (
                      <div key={i} className='db-import-sample-row'>
                        {r.map((c, j) => <span key={j}>{c}</span>)}
                      </div>
                    ))}
                  </div>
                </div>
                )
              : null
          }
        </div>
      )
    }
    if (step === 1) {
      return (
        <div className='db-import-step'>
          <div className='db-import-step-title'>{e('dbImportMapping')}</div>
          <div className='db-import-mapping'>
            <div className='db-import-mapping-head'>
              <span>{e('dbImportFileCol')}</span>
              <span>{e('dbImportTarget')}</span>
            </div>
            {rows.map((r, i) => (
              <div className='db-import-mapping-row' key={i}>
                <span className='db-import-file-col'>{r.fileCol}</span>
                <span className='db-import-mapping-ctl'>
                  <Select
                    size='small'
                    value={optValueOf(r)}
                    onChange={v => onRowOpt(i, v)}
                    options={[
                      ...targetNames.map(n => ({ value: 'column:' + n, label: n })),
                      { value: OPT_IGNORE, label: e('dbImportIgnore') },
                      { value: OPT_CONSTANT, label: e('dbImportConstant') },
                      { value: OPT_EXPRESSION, label: e('dbImportExpression') },
                      { value: OPT_NULL, label: e('dbImportNull') }
                    ]}
                  />
                  {
                    r.mode === 'constant'
                      ? (
                        <span className='db-import-extra'>
                          <Select
                            size='small'
                            value={r.objCol || undefined}
                            placeholder={e('dbImportTarget')}
                            onChange={v => setRow(i, { objCol: v })}
                            options={targetNames.map(n => ({ value: n, label: n }))}
                          />
                          <Input
                            size='small'
                            value={r.constVal}
                            placeholder={e('dbImportConstant')}
                            onChange={ev => setRow(i, { constVal: ev.target.value })}
                          />
                        </span>
                        )
                      : null
                  }
                  {
                    r.mode === 'expression'
                      ? (
                        <span className='db-import-extra'>
                          <Select
                            size='small'
                            value={r.objCol || undefined}
                            placeholder={e('dbImportTarget')}
                            onChange={v => setRow(i, { objCol: v })}
                            options={targetNames.map(n => ({ value: n, label: n }))}
                          />
                          <Tooltip title={e('dbImportExpressionHint')}>
                            <Input
                              size='small'
                              className='db-import-expr'
                              status='warning'
                              value={r.exprSql}
                              placeholder={e('dbImportExpressionHint')}
                              onChange={ev => setRow(i, { exprSql: ev.target.value })}
                            />
                          </Tooltip>
                        </span>
                        )
                      : null
                  }
                  {
                    r.mode === 'null'
                      ? (
                        <span className='db-import-extra'>
                          <Select
                            size='small'
                            value={r.objCol || undefined}
                            placeholder={e('dbImportTarget')}
                            onChange={v => setRow(i, { objCol: v })}
                            options={targetNames.map(n => ({ value: n, label: n }))}
                          />
                        </span>
                        )
                      : null
                  }
                </span>
              </div>
            ))}
          </div>
        </div>
      )
    }
    if (step === 2) {
      return (
        <div className='db-import-step'>
          <div className='db-import-step-title'>{e('dbImportMode')}</div>
          <Radio.Group value={mode} onChange={ev => setMode(ev.target.value)}>
            <Radio value='append'>{e('dbImportModeAppend')}</Radio>
            <Radio value='overwrite'>{e('dbImportModeOverwrite')}</Radio>
            <Radio
              value='upsert'
              disabled={!upsertOk}
            >
              <Tooltip title={upsertOk ? undefined : e('dbImportUpsertNeedPk')}>
                <span>{e('dbImportModeUpsert')}</span>
              </Tooltip>
            </Radio>
          </Radio.Group>
          {
            dangerMode
              ? (
                <Checkbox
                  className='db-import-confirm'
                  checked={dangerConfirmed}
                  onChange={ev => setDangerConfirmed(ev.target.checked === true)}
                >
                  {e('dbImportConfirmOverwrite')}
                </Checkbox>
                )
              : null
          }
          <div className='db-import-batch'>
            <span>{e('dbImportBatchSize')}</span>
            <InputNumber
              size='small'
              min={1}
              max={5000}
              value={batchSize}
              onChange={v => setBatchSize(Number(v) || 500)}
            />
          </div>
        </div>
      )
    }
    // 步骤 3：执行态
    return (
      <div className='db-import-step'>
        <div className='db-import-step-title'>{e('dbImportRun')}</div>
        {
          running
            ? (
              <div className='db-import-progress'>
                {e('dbImportCommitted').replace('{n}', String((run && run.committedRows) || 0))}
              </div>
              )
            : null
        }
        {
          run && run.status === 'done'
            ? (
              <Alert
                type={run.failedBatches ? 'warning' : 'success'}
                showIcon
                description={
                  e('dbImportCommitted').replace('{n}', String(run.committedRows)) +
                  (run.failedBatches
                    ? ' · ' + e('dbImportFailedBatches').replace('{n}', String(run.failedBatches))
                    : '')
                }
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
                description={
                  e('dbImportCancelNote').replace('{n}', String(run.committedRows))
                }
              />
              )
            : null
        }
        {
          run && run.status === 'failed'
            ? (
              <Alert type='error' showIcon description={run.error || e('dbExportFailed')} />
              )
            : null
        }
        {
          run && run.errors && run.errors.length
            ? (
              <div className='db-import-errors'>
                {run.errors.slice(0, 20).map((er, i) => (
                  <div key={i} className='db-import-error-item'>
                    {`#${er.batchNo} · ${e('dbImportRow')} ${er.firstRow}: ${er.message}`}
                  </div>
                ))}
              </div>
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
        <Button key='cancel' onClick={cancelRun}>{e('dbImportCancel')}</Button>
      )
    } else if (step === 2) {
      footer.push(
        <Button key='start' type='primary' disabled={!canNextMode} onClick={start}>
          {e('dbImportStart')}
        </Button>
      )
    } else {
      footer.push(
        <Button
          key='next'
          type='primary'
          disabled={(step === 0 && !file) || (step === 1 && !canNextMapping)}
          onClick={() => setStep(step + 1)}
        >
          {e('dbWizardNext')}
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
      className='db-import-modal'
      width={620}
      title={e('dbImportTitle')}
      footer={footer}
      maskClosable={false}
      onCancel={onClose}
    >
      <Steps
        size='small'
        current={step}
        items={[
          { title: e('dbImportFile') },
          { title: e('dbImportMapping') },
          { title: e('dbImportMode') },
          { title: e('dbImportRun') }
        ]}
      />
      <div className='db-import-body'>{renderBody()}</div>
    </Modal>
  )
}
