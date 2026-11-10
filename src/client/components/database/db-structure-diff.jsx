/**
 * H4：属性级结构对比（同连接、同库两张表）+ N3a 候选 DDL 生成
 *
 * 取数走 props.loadStructure（db-session 里的一次 getTableStructure，带 refresh），
 * 比对在 common/db-structure-diff.js（纯函数），语句生成在 common/db-ddl-generate.js
 * （也是纯函数）。本组件只负责选择、状态、勾选与呈现。
 *
 * 几条口径：
 * - 差异只描述事实；勾选后生成的语句**只交给 props.onApplySql 落 SQL 编辑器**，
 *   本组件不碰 IPC、不执行任何东西（执行仍由用户按运行、过危险分级）；
 * - 两边的结构各自只拉一次：换选择才拉，刷新是显式动作；失败保留上一次成功的
 *   那一对（key 对得上才画），换过选择后失败就只剩报错条 —— 拿旧结构配新选择
 *   会得出看不出来的错误结论；
 * - 方向固定：A 是基准、B 是对比，生成的语句作用在 A 上把 A 对齐成 B，
 *   不随选择顺序漂。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Button, Select, Alert, Spin, Tag, Checkbox } from 'antd'
import { SwapOutlined, CopyOutlined, ReloadOutlined } from '@ant-design/icons'
import { diffTableStructure, diffToMarkdown } from '../../common/db-structure-diff'
import { diffToDdl, buildScript } from '../../common/db-ddl-generate'
import { ddlReasonKey } from '../../common/db-ddl-reason'
import { copy } from '../../common/clipboard'
import { cleanDbError } from './db-conn-error'

const e = window.translate

const tableKey = t => JSON.stringify([
  (t && t.database) || '',
  (t && t.schema) || '',
  (t && t.table) || ''
])

const tableLabel = t => [t && t.database, t && t.schema, t && t.table].filter(Boolean).join('.')

// 字段名走 i18n（模块里的报告文案是中文，界面不能跟着只有中文）
const FIELD_KEY = {
  type: 'dbStructDiffFieldType',
  length: 'dbStructDiffFieldLength',
  nullable: 'dbStructDiffFieldNullable',
  default: 'dbStructDiffFieldDefault',
  comment: 'dbStructDiffFieldComment',
  unique: 'dbStructDiffFieldUnique',
  primary: 'dbStructDiffFieldPrimary',
  columns: 'dbStructDiffFieldColumns',
  method: 'dbStructDiffFieldMethod',
  refTable: 'dbStructDiffFieldRefTable',
  refColumns: 'dbStructDiffFieldRefColumns',
  onDelete: 'dbStructDiffFieldOnDelete',
  onUpdate: 'dbStructDiffFieldOnUpdate'
}

// 不生成语句的原因（生成器的机器码 → 人话）：映射表在 common/db-ddl-reason.js，
// 与表设计器共用一份。宁可写明"为什么这条没有勾可选"，也不要让用户以为功能坏了
const reasonText = reason => e(ddlReasonKey(reason))

function fmt (v) {
  if (v === null || v === undefined) {
    // 不能印成 'NULL'：MariaDB 的 DEFAULT NULL 本身就是字符串 'NULL'，
    // 两边同形等于没说（真库实测撞到的，见设计文档 H4 核验记录）
    return e('dbStructDiffNoValue')
  }
  if (typeof v === 'boolean') {
    return e(v ? 'dbStructDiffYes' : 'dbStructDiffNo')
  }
  if (Array.isArray(v)) {
    return v.length ? '(' + v.join(', ') + ')' : ''
  }
  return String(v)
}

// 只在一边出现的条目：把"它长什么样"压成一行，够判断要不要跟进就行
function brief (kind, it) {
  if (!it) {
    return ''
  }
  if (kind === 'column') {
    return [
      it.type,
      it.nullable ? 'NULL' : 'NOT NULL',
      it.defaultValue === null || it.defaultValue === undefined
        ? ''
        : e('dbStructDiffDefaultPrefix') + fmt(it.defaultValue),
      it.comment || ''
    ].filter(Boolean).join(' · ')
  }
  if (kind === 'index') {
    return [
      fmt(it.columns),
      it.unique ? e('dbStructDiffUnique') : '',
      it.primary ? e('dbStructDiffPrimary') : '',
      it.method || ''
    ].filter(Boolean).join(' · ')
  }
  return [
    fmt(it.columns),
    '→ ' + [it.refTable, fmt(it.refColumns)].filter(Boolean).join(' '),
    it.onDelete ? 'ON DELETE ' + it.onDelete : ''
  ].filter(Boolean).join(' · ')
}

export default function DbStructureDiff (props) {
  const { open, base: defaultBase, tables, dialect, loadStructure, onApplySql, onClose } = props
  const [base, setBase] = useState(null)
  const [target, setTarget] = useState(null)
  // loaded 带着"是哪一对表"的 key：换过选择但加载失败时，旧结构不能拿来配新选择
  const [loaded, setLoaded] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // 勾选以"差异条目"为单位（一条差异可能出多句，拆开勾会生成半截脚本）
  const [picked, setPicked] = useState([])
  const tokenRef = useRef(0)

  useEffect(() => {
    if (!open) {
      return
    }
    // 每次打开从当前表重新开始：上一轮选的 B 多半是别的目的
    setBase(defaultBase ? { ...defaultBase } : null)
    setTarget(null)
    setLoaded(null)
    setError('')
    setLoading(false)
    tokenRef.current++
  }, [open, defaultBase])

  const pairKey = base && target ? tableKey(base) + '|' + tableKey(target) : ''

  const load = useCallback(() => {
    if (!base || !target) {
      return
    }
    const key = tableKey(base) + '|' + tableKey(target)
    tokenRef.current++
    const token = tokenRef.current
    setLoading(true)
    setError('')
    Promise.all([loadStructure(base), loadStructure(target)])
      .then(([a, b]) => {
        if (token !== tokenRef.current) {
          return
        }
        setLoading(false)
        setLoaded({ key, base: a || null, target: b || null })
      })
      .catch(err => {
        if (token !== tokenRef.current) {
          return
        }
        setLoading(false)
        setError(cleanDbError(err && err.message ? err.message : err))
      })
  }, [base, target, loadStructure])

  useEffect(() => {
    if (!open || !pairKey) {
      return
    }
    load()
  }, [open, pairKey, load])

  // 关闭即作废在途请求：否则关掉再打开会先看到上一轮的结果
  const close = useCallback(() => {
    tokenRef.current++
    setLoading(false)
    onClose()
  }, [onClose])

  const options = useMemo(() => (tables || []).map(t => ({
    value: tableKey(t),
    label: tableLabel(t)
  })), [tables])

  const pick = (v, set) => {
    const hit = (tables || []).find(t => tableKey(t) === v)
    set(hit ? { ...hit } : null)
  }

  const diff = useMemo(() => {
    if (!loaded || loaded.key !== pairKey || !loaded.base || !loaded.target) {
      return null
    }
    return diffTableStructure(loaded.base, loaded.target, { dialect })
  }, [loaded, pairKey, dialect])

  const sections = useMemo(() => ([
    { key: 'columns', title: e('dbStructDiffColumns'), kind: 'column', list: diff ? diff.columns : [] },
    { key: 'indexes', title: e('dbStructDiffIndexes'), kind: 'index', list: diff ? diff.indexes : [] },
    { key: 'foreignKeys', title: e('dbStructDiffFks'), kind: 'foreignKey', list: diff ? diff.foreignKeys : [] }
  ]), [diff])

  const changedCount = s => s.list.filter(x => x.status !== 'equal').length

  // 候选语句：生成的脚本作用在 A（基准表）上，所以定位传 base 而不是 target
  const ddl = useMemo(() => {
    if (!diff || !base) {
      return []
    }
    return diffToDdl(diff, dialect, base)
  }, [diff, dialect, base])

  const ddlById = useMemo(() => {
    const m = new Map()
    for (const item of ddl) {
      m.set(item.id, item)
    }
    return m
  }, [ddl])

  const generatable = useMemo(() => ddl.filter(i => i.supported).map(i => i.id), [ddl])

  const script = useMemo(() => buildScript(ddl, picked), [ddl, picked])

  const statementCount = script ? script.split('\n').length : 0

  const togglePick = id => setPicked(list => (
    list.includes(id) ? list.filter(x => x !== id) : list.concat(id)
  ))

  // 换过一次对比就清空勾选：上一对的语句留着会落进这一对的表
  useEffect(() => {
    setPicked([])
  }, [diff])

  const applyScript = () => {
    if (!script || !onApplySql) {
      return
    }
    onApplySql(script)
  }

  const copyReport = () => {
    if (!diff) {
      return
    }
    copy(diffToMarkdown({
      baseLabel: tableLabel(base),
      targetLabel: tableLabel(target),
      diff,
      base: loaded && loaded.base,
      target: loaded && loaded.target
    }))
  }

  const statusText = status => {
    if (status === 'added') {
      return e('dbStructDiffOnlyB')
    }
    if (status === 'removed') {
      return e('dbStructDiffOnlyA')
    }
    return e('dbStructDiffChanged')
  }

  const renderEntry = (kind, entry) => {
    const item = ddlById.get(kind + ':' + entry.name)
    return (
      <div key={entry.name} className={'db-diff-row is-' + entry.status}>
        <Checkbox
          className='db-diff-checkbox'
          checked={!!item && picked.includes(item.id)}
          disabled={!item || !item.supported}
          onChange={() => item && togglePick(item.id)}
        />
        <div className='db-diff-main'>
          <div className='db-diff-line'>
            <Tag className='db-diff-tag'>{statusText(entry.status)}</Tag>
            <span className='db-diff-name'>{entry.name}</span>
            <span className='db-diff-values'>
              {
                entry.status === 'changed'
                  ? entry.fields.map(f => (
                    <span key={f.key} className='db-diff-field'>
                      <span className='db-diff-field-key'>{e(FIELD_KEY[f.key] || f.key)}</span>
                      <span className='db-diff-old'>{fmt(f.base)}</span>
                      <span className='db-diff-arrow'>→</span>
                      <span className='db-diff-new'>{fmt(f.target)}</span>
                    </span>
                  ))
                  : <span className='db-diff-brief'>{brief(kind, entry.status === 'added' ? entry.target : entry.base)}</span>
              }
            </span>
          </div>
          {
            !item
              ? null
              : (
                <div className={'db-diff-ddl' + (item.supported ? '' : ' is-blocked')}>
                  {
                    item.supported
                      ? item.sqls.map(sql => <div key={sql} className='db-diff-ddl-sql'>{sql}</div>)
                      : <span className='db-diff-ddl-reason'>{reasonText(item.reason)}</span>
                  }
                </div>
                )
          }
        </div>
      </div>
    )
  }

  return (
    <Modal
      className='db-struct-diff-modal'
      open={open}
      width={1000}
      style={{ top: 40 }}
      title={e('dbStructDiff')}
      onCancel={close}
      footer={[
        <Button
          key='copy'
          size='small'
          icon={<CopyOutlined />}
          disabled={!diff}
          onClick={copyReport}
        >
          {e('dbStructDiffCopy')}
        </Button>,
        <Button
          key='refresh'
          size='small'
          icon={<ReloadOutlined />}
          disabled={!pairKey}
          loading={loading}
          onClick={load}
        >
          {e('refresh')}
        </Button>,
        <Button key='close' size='small' type='primary' onClick={close}>
          {e('close')}
        </Button>
      ]}
    >
      <div className='db-diff'>
        <div className='db-diff-head'>
          <div className='db-diff-pick'>
            <span className='db-diff-pick-label'>{e('dbStructDiffBase')}</span>
            <Select
              size='small'
              className='db-diff-select'
              value={base ? tableKey(base) : undefined}
              options={options}
              showSearch
              optionFilterProp='label'
              placeholder={e('dbStructDiffPickTable')}
              onChange={v => pick(v, setBase)}
            />
            <SwapOutlined className='db-diff-swap' />
            <span className='db-diff-pick-label'>{e('dbStructDiffTarget')}</span>
            <Select
              size='small'
              className='db-diff-select'
              value={target ? tableKey(target) : undefined}
              options={options}
              showSearch
              optionFilterProp='label'
              placeholder={e('dbStructDiffPickTable')}
              onChange={v => pick(v, setTarget)}
            />
          </div>
          {
            error
              ? (
                <Alert
                  className='db-diff-err'
                  type='error'
                  showIcon
                  message={e('dbStructDiffFailed')}
                  description={error}
                />
                )
              : null
          }
          {
            !pairKey
              ? <div className='db-diff-hint'>{e('dbStructDiffPick')}</div>
              : null
          }
          {
            pairKey && loading
              ? (
                <div className='db-diff-hint'>
                  <Spin size='small' />
                </div>
                )
              : null
          }
          {
            diff
              ? (
                <div className='db-diff-summary'>
                  <Tag className='db-diff-count is-removed'>
                    {e('dbStructDiffOnlyA')} {diff.summary.removed}
                  </Tag>
                  <Tag className='db-diff-count is-added'>
                    {e('dbStructDiffOnlyB')} {diff.summary.added}
                  </Tag>
                  <Tag className='db-diff-count is-changed'>
                    {e('dbStructDiffChanged')} {diff.summary.changed}
                  </Tag>
                  <Tag className='db-diff-count is-equal'>
                    {e('dbStructDiffEqual')} {diff.summary.equal}
                  </Tag>
                </div>
                )
              : null
          }
          {
            diff && !diff.summary.added && !diff.summary.removed && !diff.summary.changed
              ? <div className='db-diff-hint'>{e('dbStructDiffSame')}</div>
              : null
          }
          {
            diff && ddl.length
              ? (
                <div className='db-diff-ddl-bar'>
                  <span className='db-diff-ddl-tip'>
                    {generatable.length ? e('dbStructDiffDdlHint') : e('dbStructDiffDdlNone')}
                  </span>
                  {
                    generatable.length
                      ? (
                        <Checkbox
                          className='db-diff-ddl-all'
                          checked={picked.length === generatable.length}
                          indeterminate={picked.length > 0 && picked.length < generatable.length}
                          onChange={v => setPicked(v.target.checked ? generatable.slice() : [])}
                        >
                          {e('dbStructDiffDdlAll')}
                        </Checkbox>
                        )
                      : (
                        <span className='db-diff-ddl-why'>{reasonText((ddl[0] || {}).reason)}</span>
                        )
                  }
                  <Button
                    size='small'
                    type='primary'
                    disabled={!script || !onApplySql}
                    onClick={applyScript}
                  >
                    {e('dbStructDiffDdlApply')} {statementCount}
                  </Button>
                </div>
                )
              : null
          }
        </div>
        <div className='db-diff-body'>
          {
            sections.map(s => {
              const n = changedCount(s)
              if (!n) {
                return null
              }
              return (
                <div key={s.key} className='db-diff-section'>
                  <div className='db-diff-section-title'>{s.title} ({n})</div>
                  {
                    s.list
                      .filter(x => x.status !== 'equal')
                      .map(x => renderEntry(s.kind, x))
                  }
                </div>
              )
            })
          }
        </div>
      </div>
    </Modal>
  )
}
