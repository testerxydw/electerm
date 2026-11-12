/**
 * 导入向导（C 批「导入 CSV/TSV」§10 + N4a「JSONL/SQL 导入闭环」§N4）
 *
 * 步骤按通道编排（stepsOf）：
 * - 行通道（csv/tsv/jsonl/xlsx）：选文件 → 列映射 → 写入模式 → 执行
 * - 脚本通道（sql）：选文件 → 语句清单 → 执行
 *
 * xlsx（N4b）的差异只有一处：预览响应带 sheets/sheetName/totalRows，选中
 * xlsx 后显示 sheet 下拉，切换 sheet 时带 sheetName 重新预览（列随 sheet 变化，
 * 主进程是唯一解析方，渲染层只回传选择）。列映射界面按 columns/sampleRows
 * 工作，与 csv/tsv 同构，无需第二套界面。
 *
 * 职责边界：文件选择在主进程（db-client-remote 的 openFile），源解析在
 * db-client 子进程（dbImportOp preview 返回
 * kind + 列/样例/脚本文本，渲染层不读文件）；映射折算、载荷折算、步骤编排、
 * 语句切分都在纯函数层（db-import-mapping / db-import-plan / db-sql-risk）；
 * 列映射与语句清单各自是独立组件。本组件只管编排与状态。
 *
 * 格式判定不写在渲染层：kind 来自预览响应，界面选的显式格式只是传给主进程
 * 注册表的入参 —— 两处各判一次是旧版定界符的老毛病。
 *
 * 两道闸门：
 * - 危险写入模式（overwrite/upsert）在 production 连接上过 E1（confirmRisk）；
 * - SQL 脚本导入把整段文本交 confirmSqlRisk（内部 classifySql 判定，与
 *   statementPlan 用的是同一个函数、同一批语句）。前端取消 = 零调用。
 *
 * 取消语义必须明示：主进程在批次/语句边界止步，已提交的保留、不回滚。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Steps, Button, Select, InputNumber, Radio, Checkbox, Alert } from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'
import message from '../common/message'
import { showErrorModal } from '../common/error-modal'
import { mappingProblem, pkCovered } from '../../common/db-import-mapping'
import {
  IMPORT_FORMAT_IDS,
  FORMAT_AUTO,
  stepsOf,
  stepTitles,
  kindOfFile,
  statementPlan,
  buildStartPayload,
  statementsProblem
} from '../../common/db-import-plan'
import { getCapabilities } from '../../common/sql-dialects'
import DbImportMapping from './db-import-mapping'
import DbImportStatements from './db-import-statements'

const e = window.translate

export default function DbImportDialog (props) {
  const {
    open = false,
    onClose = () => {},
    tabId = '',
    dbType = '',
    database = '',
    schema = '',
    table = '',
    columns = [],
    confirmRisk = async () => true,
    confirmSqlRisk = async () => true
  } = props
  const [step, setStep] = useState(0)
  // 界面显式选的格式（'' = 按扩展名推断）；判定权在主进程注册表
  const [formatChoice, setFormatChoice] = useState(FORMAT_AUTO)
  const [fileLoading, setFileLoading] = useState(false)
  // file: { filePath, format, kind, columns, sampleRows, scriptText, totalBytes }
  // xlsx 预览额外带 sheets / sheetName / totalRows（见文件头注释）
  const [file, setFile] = useState(null)
  // 映射行（UI 形态），见 db-import-mapping.js 头注释
  const [rows, setRows] = useState([])
  const [mode, setMode] = useState('append')
  const [dangerConfirmed, setDangerConfirmed] = useState(false)
  const [batchSize, setBatchSize] = useState(500)
  // run: { importId, status, format, committedRows, failedBatches, errors, ... }
  const [run, setRun] = useState(null)
  const runIdRef = useRef('')

  const kind = kindOfFile(file)
  const stepIds = stepsOf(kind)
  const stepId = stepIds[step] || 'file'
  const isScript = kind === 'script'
  const isXlsx = Boolean(file && file.format === 'xlsx')

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

  // SQL 脚本：切分 + 分级一次做完（classifySql），下发的就是这里看到的
  const plan = useMemo(
    () => (isScript && file ? statementPlan(file.scriptText, dbType) : { statements: [], reasons: [] }),
    [isScript, file, dbType]
  )
  // 本引擎能不能一次收多条语句 —— 能力位只用于解释"为什么逐条发"，
  // 不改变执行路径（逐条执行三家行为一致）
  const multiStatement = useMemo(() => getCapabilities(dbType).multiStatement, [dbType])

  // 打开即重置
  useEffect(() => {
    if (open) {
      setStep(0)
      setFormatChoice(FORMAT_AUTO)
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
    if (!file || file.kind === 'script') {
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

  // 预览结果的可用性检查：脚本要有语句，行数据要有列
  const applyPreview = res => {
    if (!res || !res.filePath) {
      return false
    }
    if (res.kind === 'script') {
      if (!statementPlan(res.scriptText, dbType).statements.length) {
        message.error(e('dbImportNoStatements'))
        return false
      }
    } else if (!res.columns || !res.columns.length) {
      message.error(e('dbImportNoFile'))
      return false
    }
    setFile(res)
    return true
  }

  const pickFile = async () => {
    setFileLoading(true)
    try {
      const res = await window.pre.runGlobalAsync('dbImportOp', 'openFile', {
        format: formatChoice || undefined
      })
      if (res && res.filePath) {
        applyPreview(res)
      }
    } catch (err) {
      showErrorModal({ error: err })
    } finally {
      setFileLoading(false)
    }
  }

  // 换格式 = 用同一个文件重新解析（.txt 里放 JSONL、扩展名大小写混杂都要能改判）
  const onFormatChange = async val => {
    setFormatChoice(val)
    setStep(0)
    if (!file || !file.filePath) {
      return
    }
    setFileLoading(true)
    try {
      const res = await window.pre.runGlobalAsync('dbImportOp', 'preview', {
        filePath: file.filePath,
        format: val || undefined
      })
      applyPreview(res)
    } catch (err) {
      showErrorModal({ error: err })
    } finally {
      setFileLoading(false)
    }
  }

  // xlsx 换 sheet = 带显式 format + sheetName 重新预览（选中 sheet 是预览入参，
  // 判定与解析仍在主进程，与 onFormatChange 同一个口径）
  const onSheetChange = async val => {
    if (!file || !file.filePath) {
      return
    }
    setFileLoading(true)
    try {
      const res = await window.pre.runGlobalAsync('dbImportOp', 'preview', {
        filePath: file.filePath,
        format: 'xlsx',
        sheetName: val
      })
      applyPreview(res)
    } catch (err) {
      showErrorModal({ error: err })
    } finally {
      setFileLoading(false)
    }
  }

  const setRow = (idx, patch) => {
    setRows(prev => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }

  const canNextMapping = rows.some(r => r && r.mode !== 'ignore' && r.mode !== undefined) &&
    mappingProblem(rows) === null

  const upsertOk = pkCovered(pkNames, rows)
  const dangerMode = mode === 'overwrite' || mode === 'upsert'
  const canNextMode = !dangerMode || dangerConfirmed
  const scriptProblem = isScript ? statementsProblem(plan.statements.length) : null

  const payloadState = {
    file,
    kind,
    tabId,
    database,
    schema,
    table,
    rows,
    mode,
    batchSize,
    statements: plan.statements.map(s => s.text)
  }
  const payloadProblemKey = () => {
    try {
      buildStartPayload(payloadState)
      return null
    } catch (err) {
      return err.message
    }
  }

  const start = async () => {
    let payload = null
    try {
      payload = buildStartPayload(payloadState)
    } catch (err) {
      message.error(e(err.message))
      return
    }
    // 脚本导入：整段交 E1 SQL 闸门（弹窗列出的语句 = classifySql 的语句 = 下发的语句）
    if (isScript) {
      const ok = await confirmSqlRisk(file.scriptText, database)
      if (!ok) {
        return
      }
    } else if (dangerMode) {
      // 危险写入模式 production 闸门（E1 同款）：取消 = 零调用
      const ok = await confirmRisk(mode)
      if (!ok) {
        return
      }
    }
    try {
      const res = await window.pre.runGlobalAsync('dbImportOp', 'start', payload)
      const importId = res && res.importId
      runIdRef.current = importId
      setRun({
        importId,
        status: 'running',
        format: isScript ? 'sql' : (file && file.format),
        committedRows: 0,
        failedBatches: 0,
        totalStatements: plan.statements.length,
        executedStatements: 0,
        statementNo: 0,
        errors: [],
        error: null
      })
      setStep(stepIds.indexOf('run'))
    } catch (err) {
      showErrorModal({ error: err })
    }
  }

  const cancelRun = () => {
    if (run && run.importId) {
      window.pre.runGlobalAsync('dbImportOp', 'cancel', { importId: run.importId }).catch(() => {})
    }
  }

  const running = run && run.status === 'running'
  const finished = run && (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled')
  const runIsScript = Boolean(run && run.format === 'sql')

  const renderFileStep = () => (
    <div className='db-import-step'>
      <div className='db-import-path-row'>
        <Select
          size='small'
          className='db-import-format'
          value={formatChoice}
          onChange={onFormatChange}
          options={[
            { value: FORMAT_AUTO, label: e('dbImportFormatAuto') },
            ...IMPORT_FORMAT_IDS.map(id => ({ value: id, label: id.toUpperCase() }))
          ]}
        />
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
              <div className='db-import-file-meta'>
                {String(file.format || '').toUpperCase()}
                {' · '}
                {e('dbImportSize').replace('{n}', String(Math.ceil((file.totalBytes || 0) / 1024)))}
              </div>
              {
                // xlsx 的 sheet 选择（单 sheet 也显示：选项即当前选中，向用户明示）
                isXlsx && (file.sheets || []).length
                  ? (
                    <div className='db-import-batch'>
                      <span>{e('dbImportSheet')}</span>
                      <Select
                        size='small'
                        value={file.sheetName}
                        onChange={onSheetChange}
                        options={(file.sheets || []).map(n => ({ value: n, label: n }))}
                      />
                    </div>
                    )
                  : null
              }
              {
                // xlsx 的数据规模提示（预览只解析选中的 sheet，这里的行数就是它）
                isXlsx
                  ? (
                    <div className='db-import-script-meta'>
                      {e('dbImportRowsTotal').replace('{n}', String(file.totalRows || 0))}
                    </div>
                    )
                  : null
              }
              {
                file.kind === 'script'
                  ? (
                    <div className='db-import-script-meta'>
                      {e('dbImportStatementsCount').replace('{n}', String(plan.statements.length))}
                    </div>
                    )
                  : (
                    <div className='db-import-sample'>
                      {(file.sampleRows || []).slice(0, 3).map((r, i) => (
                        <div key={i} className='db-import-sample-row'>
                          {r.map((c, j) => <span key={j}>{c}</span>)}
                        </div>
                      ))}
                    </div>
                    )
              }
            </div>
            )
          : null
      }
      {
        // 「下一步」灰掉时必须说原因（语句为空 / 超出上限），否则用户只看到按钮不动
        isScript && scriptProblem
          ? (
            <div className='db-import-hint'>{e(scriptProblem)}</div>
            )
          : null
      }
    </div>
  )

  const renderModeStep = () => (
    <div className='db-import-step'>
      <div className='db-import-step-title'>{e('dbImportMode')}</div>
      <Radio.Group value={mode} onChange={ev => setMode(ev.target.value)}>
        <Radio value='append'>{e('dbImportModeAppend')}</Radio>
        <Radio value='overwrite'>{e('dbImportModeOverwrite')}</Radio>
        <Radio
          value='upsert'
          disabled={!upsertOk}
        >
          {e('dbImportModeUpsert')}
        </Radio>
      </Radio.Group>
      {
        upsertOk
          ? null
          : <div className='db-import-hint'>{e('dbImportUpsertNeedPk')}</div>
      }
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

  const renderRunStep = () => {
    const n = run.committedRows || 0
    return (
      <div className='db-import-step'>
        <div className='db-import-step-title'>{e('dbImportRun')}</div>
        {
          running
            ? (
              <div className='db-import-progress'>
                {runIsScript
                  ? e('dbImportStatementsRunning')
                    .replace('{a}', String(run.executedStatements || 0))
                    .replace('{n}', String(run.totalStatements || 0))
                    .replace('{t}', String(run.statementNo || 0))
                  : e('dbImportCommitted').replace('{n}', String(n))}
              </div>
              )
            : null
        }
        {
          run.status === 'done'
            ? (
              <Alert
                type={run.failedBatches ? 'warning' : 'success'}
                showIcon
                description={
                  (runIsScript
                    ? e('dbImportStatementsDone')
                      .replace('{a}', String(run.executedStatements || 0))
                      .replace('{n}', String(run.totalStatements || 0))
                      .replace('{r}', String(n))
                    : e('dbImportCommitted').replace('{n}', String(n))) +
                  (run.failedBatches
                    ? ' · ' + e('dbImportFailedBatches').replace('{n}', String(run.failedBatches))
                    : '')
                }
              />
              )
            : null
        }
        {
          run.status === 'cancelled'
            ? (
              <Alert
                type='warning'
                showIcon
                description={
                  runIsScript
                    ? e('dbImportCancelNoteScript')
                      .replace('{a}', String(run.executedStatements || 0))
                      .replace('{r}', String(n))
                    : e('dbImportCancelNote').replace('{n}', String(n))
                }
              />
              )
            : null
        }
        {
          run.status === 'failed'
            ? (
              <Alert type='error' showIcon description={run.error || e('dbExportFailed')} />
              )
            : null
        }
        {
          run.errors && run.errors.length
            ? (
              <div className='db-import-errors'>
                {run.errors.slice(0, 20).map((er, i) => (
                  <div key={i} className='db-import-error-item'>
                    {runIsScript
                      ? `#${er.no}: ${er.message}`
                      : `#${er.batchNo} · ${e('dbImportRow')} ${er.firstRow}: ${er.message}`}
                  </div>
                ))}
              </div>
              )
            : null
        }
      </div>
    )
  }

  const renderBody = () => {
    if (stepId === 'file') {
      return renderFileStep()
    }
    if (stepId === 'mapping') {
      return (
        <div className='db-import-step'>
          <div className='db-import-step-title'>{e('dbImportMapping')}</div>
          <DbImportMapping
            rows={rows}
            targetNames={targetNames}
            onChange={setRow}
          />
        </div>
      )
    }
    if (stepId === 'mode') {
      return renderModeStep()
    }
    if (stepId === 'statements') {
      return <DbImportStatements plan={plan} perStatement={!multiStatement} />
    }
    return renderRunStep()
  }

  // 「下一步」在行通道要过映射/模式，在脚本通道只有语句清单；「开始导入」
  // 落在最后一个人工确认步（mode / statements）
  const isStartStep = stepId === 'mode' || stepId === 'statements'
  const nextDisabled = stepId === 'file'
    ? !file || (isScript && scriptProblem !== null)
    : stepId === 'mapping'
      ? !canNextMapping
      : true
  const startDisabled = stepId === 'mode'
    ? !canNextMode || payloadProblemKey() !== null
    : stepId === 'statements'
      ? scriptProblem !== null || payloadProblemKey() !== null
      : true

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
    } else if (isStartStep) {
      footer.push(
        <Button
          key='start'
          className='db-import-start'
          type='primary'
          disabled={startDisabled}
          onClick={start}
        >
          {e('dbImportStart')}
        </Button>
      )
    } else {
      footer.push(
        <Button
          key='next'
          type='primary'
          disabled={nextDisabled}
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
        items={stepTitles(kind, e)}
      />
      <div className='db-import-body'>{renderBody()}</div>
    </Modal>
  )
}
