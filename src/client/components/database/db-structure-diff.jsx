/**
 * H4：属性级结构对比（同连接、同库两张表）
 *
 * 取数走 props.loadStructure（db-session 里的一次 getTableStructure，带 refresh），
 * 比对与报告全在 common/db-structure-diff.js（纯函数）。本组件只负责选择、状态与呈现。
 *
 * 几条口径：
 * - 只描述差异，不生成任何 DDL —— 没有"同步"按钮，也不给可执行的语句；
 * - 两边的结构各自只拉一次：换选择才拉，刷新是显式动作；失败保留上一次成功的
 *   那一对（key 对得上才画），换过选择后失败就只剩报错条 —— 拿旧结构配新选择
 *   会得出看不出来的错误结论；
 * - 方向固定：A 是基准、B 是对比，"仅在 A"就是 B 里没有（B 侧删除），不随选择顺序漂。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Button, Select, Alert, Spin, Tag } from 'antd'
import { SwapOutlined, CopyOutlined, ReloadOutlined } from '@ant-design/icons'
import { diffTableStructure, diffToMarkdown } from '../../common/db-structure-diff'
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
  const { open, base: defaultBase, tables, dialect, loadStructure, onClose } = props
  const [base, setBase] = useState(null)
  const [target, setTarget] = useState(null)
  // loaded 带着"是哪一对表"的 key：换过选择但加载失败时，旧结构不能拿来配新选择
  const [loaded, setLoaded] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
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

  const renderEntry = (kind, entry) => (
    <div key={entry.name} className={'db-diff-row is-' + entry.status}>
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
  )

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
