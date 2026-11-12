/**
 * N3b 受限表设计器（列 / 索引 / 表注释 → 候选 DDL，全程不执行）
 *
 * 职责边界：本组件只管"草稿怎么改、怎么呈现"。比较与语句生成一律下沉到
 * `common/db-table-design.js` + `common/db-ddl-generate.js`，这里**不拼一句 SQL** ——
 * 设计文档 §7 N3 要点 5 要的就是这个：方言写法只在一处，改口径不会这儿改完那儿忘。
 *
 * 三条不能松的口径：
 * - **只生成不执行**：勾选后的脚本整段交给 `props.onApplySql` 落 SQL 编辑器，
 *   执行仍由用户按运行触发、过危险分级与生产确认。本组件不碰 IPC 的写通道。
 * - **能力位降级**：`alterDdl` 没声明成 true 的方言（SQLite 是主要用户）顶部挂
 *   只读预览横幅。判据走声明，不认引擎名。
 * - **改的是当前表**：基准是当前库结构、目标是草稿，方向在纯模块里定死了；
 *   这里只负责把当前结构取回来一次。
 *
 * 取数沿用结构对比的做法：`refresh: true` 跳过 60s 结构缓存 —— 刚 ALTER 过的表
 * 要是拿旧结构当基准，改同一列会比对出"没变化"，那种错看不出来。
 *
 * 已有列/索引的名字栏是只读的：改名在按名字配对的比较里等于"删一列 + 加一列"，
 * 落库就是整列数据没了。纯模块那边也拦了一道，两边不靠彼此兜底。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Button, Input, Checkbox, Select, Alert, Spin, Tag } from 'antd'
import { PlusOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons'
import {
  createDraft,
  newColumn,
  newIndex,
  designPreview
} from '../../common/db-table-design'
import { buildScript, createTableDdl } from '../../common/db-ddl-generate'
import { ddlReasonKey } from '../../common/db-ddl-reason'
import { capabilityOf } from '../../common/sql-dialects'
import { cleanDbError } from './db-conn-error'

const e = window.translate

const locKey = loc => JSON.stringify([
  (loc && loc.database) || '',
  (loc && loc.schema) || '',
  (loc && loc.table) || ''
])

const locLabel = loc => [loc && loc.database, loc && loc.schema, loc && loc.table]
  .filter(Boolean).join('.')

// 草稿自身的硬错误：机器码 → 人话。这些是"草稿不能拿去比"，
// 跟下面 item.reason 的"这条差异不给语句"是两回事，分开展示。
const ISSUE_KEY = {
  'unnamed-column': 'dbDesignIssueColName',
  'duplicate-column': 'dbDesignIssueColDup',
  'renamed-column': 'dbDesignIssueRenamedCol',
  'unnamed-index': 'dbDesignIssueIxName',
  'duplicate-index': 'dbDesignIssueIxDup',
  'renamed-index': 'dbDesignIssueRenamedIx',
  'empty-index-columns': 'dbDesignIssueIxColumns'
}

export default function DbTableDesign (props) {
  const { open, loc, dialect, loadStructure, onApplySql, onClose, createMode } = props
  const [current, setCurrent] = useState(null)
  const [loadedKey, setLoadedKey] = useState('')
  const [draft, setDraft] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState([])
  // N7 新建表：表名由本弹层收（只在 create 模式出现）
  const [newTableName, setNewTableName] = useState('')
  const tokenRef = useRef(0)

  const key = locKey(loc)

  // N7 新建表：没有"当前结构"可取 —— 基准就是一张空表，草稿从空白开始
  // （预置一个空列行，让用户看到编辑行的形状而不是对着空屏猜）
  const emptyDraft = useCallback(() => ({
    comment: '',
    columns: [newColumn()],
    indexes: []
  }), [])

  // 关掉就作废在途请求：再打开时先看到上一张表的结果，用户会当成就长这样
  const load = useCallback(() => {
    if (createMode) {
      return
    }
    if (!loc || !loc.table) {
      return
    }
    const target = locKey(loc)
    tokenRef.current++
    const token = tokenRef.current
    setLoading(true)
    setError('')
    Promise.resolve(loadStructure(loc)).then(structure => {
      if (token !== tokenRef.current) {
        return
      }
      setLoading(false)
      const s = structure || null
      setCurrent(s)
      setDraft(s ? createDraft(s) : null)
      setLoadedKey(target)
    }).catch(err => {
      if (token !== tokenRef.current) {
        return
      }
      setLoading(false)
      setError(cleanDbError(err && err.message ? err.message : err))
    })
  }, [loc, loadStructure, createMode])

  useEffect(() => {
    if (!open) {
      return
    }
    setCurrent(null)
    setLoadedKey('')
    setError('')
    if (createMode) {
      setDraft(emptyDraft())
      setNewTableName('')
      setPicked([])
    } else {
      setDraft(null)
      load()
    }
  }, [open, key, load, createMode, emptyDraft])

  const close = useCallback(() => {
    tokenRef.current++
    setLoading(false)
    onClose()
  }, [onClose])

  const readonlyDialect = !capabilityOf(dialect, 'alterDdl')

  const patch = (set) => {
    setDraft(d => (d ? { ...d, ...set } : d))
  }

  const patchColumn = (k, set) => {
    setDraft(d => ({
      ...d,
      columns: d.columns.map(c => (c.key === k ? { ...c, ...set } : c))
    }))
  }

  const patchIndex = (k, set) => {
    setDraft(d => ({
      ...d,
      indexes: d.indexes.map(ix => (ix.key === k ? { ...ix, ...set } : ix))
    }))
  }

  const columnOptions = useMemo(() => ((draft && draft.columns) || [])
    .filter(c => String(c.name || '').trim())
    .map(c => ({ value: c.name.trim(), label: c.name.trim() })), [draft])

  const preview = useMemo(() => {
    if (createMode) {
      // N7 新建表：不走差异比较，一条 CREATE TABLE 就是全部条目；
      // supported=false 时 reason 走 ddlReasonKey 出人话
      if (!draft || loadedKey !== '') {
        return null
      }
      const res = createTableDdl(draft, dialect, {
        database: (loc && loc.database) || '',
        table: newTableName.trim()
      })
      return {
        items: [{
          id: 'create-table',
          entry: null,
          sqls: res.sqls,
          supported: res.supported,
          reason: res.reason
        }],
        issues: []
      }
    }
    if (!draft || loadedKey !== key || !current) {
      return null
    }
    return designPreview({ current, draft, dialect, loc })
  }, [draft, loadedKey, key, current, dialect, loc, createMode, newTableName])

  const items = preview ? preview.items : []
  const issues = preview ? preview.issues : []
  const generatable = useMemo(() => items.filter(i => i.supported).map(i => i.id), [items])
  // 新建表没有"勾选差异"语义：整张表就是一条语句，直接全量生成
  const script = useMemo(() => buildScript(items, createMode ? generatable : picked), [items, picked, generatable, createMode])
  const statementCount = script ? script.split('\n').length : 0

  // 草稿一改，勾选就可能对不上号（原来那条差异没了 / id 变了），整体清空比留着安全：
  // 留着的话用户点"写入"落进去的可能是上一版勾选出来的语句
  useEffect(() => {
    setPicked([])
  }, [preview])

  const togglePick = id => setPicked(list => (
    list.includes(id) ? list.filter(x => x !== id) : list.concat(id)
  ))

  const applyScript = () => {
    if (!script || !onApplySql) {
      return
    }
    onApplySql(script)
  }

  const renderColumn = c => {
    const isNew = !c.origName
    return (
      <div key={c.key} className='db-design-row'>
        <Input
          size='small'
          className='db-design-cell is-name'
          value={c.name}
          disabled={!isNew}
          placeholder={e('dbDesignColName')}
          onChange={v => patchColumn(c.key, { name: v.target.value })}
        />
        <Input
          size='small'
          className='db-design-cell is-type'
          value={c.type}
          placeholder={e('dbStructDiffFieldType')}
          onChange={v => patchColumn(c.key, { type: v.target.value })}
        />
        <Checkbox
          className='db-design-cell is-bool'
          checked={c.nullable !== false}
          onChange={v => patchColumn(c.key, { nullable: v.target.checked })}
        />
        <Checkbox
          className='db-design-cell is-bool'
          checked={!!c.hasDefault}
          onChange={v => patchColumn(c.key, { hasDefault: v.target.checked })}
        />
        <Input
          size='small'
          className='db-design-cell is-default'
          value={c.defaultValue}
          disabled={!c.hasDefault}
          onChange={v => patchColumn(c.key, { defaultValue: v.target.value })}
        />
        <Input
          size='small'
          className='db-design-cell is-comment'
          value={c.comment}
          onChange={v => patchColumn(c.key, { comment: v.target.value })}
        />
        <Button
          size='small'
          type='text'
          danger
          className='db-design-cell is-del'
          icon={<DeleteOutlined />}
          onClick={() => patch({ columns: draft.columns.filter(x => x.key !== c.key) })}
        />
      </div>
    )
  }

  const renderIndex = ix => (
    <div key={ix.key} className='db-design-row'>
      <Input
        size='small'
        className='db-design-cell is-name'
        value={ix.name}
        disabled={!!ix.origName}
        placeholder={e('dbDesignIxName')}
        onChange={v => patchIndex(ix.key, { name: v.target.value })}
      />
      <Select
        size='small'
        mode='multiple'
        className='db-design-cell is-cols'
        value={ix.columns}
        options={columnOptions}
        placeholder={e('dbStructDiffFieldColumns')}
        onChange={v => patchIndex(ix.key, { columns: v })}
      />
      <Checkbox
        className='db-design-cell is-bool'
        checked={!!ix.unique}
        disabled={!!ix.primary}
        onChange={v => patchIndex(ix.key, { unique: v.target.checked })}
      />
      {
        ix.primary
          ? <Tag className='db-design-cell is-del is-pk'>{e('dbStructDiffPrimary')}</Tag>
          : (
            <Button
              size='small'
              type='text'
              danger
              className='db-design-cell is-del'
              icon={<DeleteOutlined />}
              onClick={() => patch({ indexes: draft.indexes.filter(x => x.key !== ix.key) })}
            />
            )
      }
    </div>
  )

  return (
    <Modal
      className='db-table-design-modal'
      open={open}
      width={1040}
      style={{ top: 32 }}
      title={createMode ? e('dbCreateTable') : e('dbDesign') + (loc ? ' — ' + locLabel(loc) : '')}
      // 草稿是编辑到一半的东西：点遮罩就丢掉比多一步确认更伤人
      maskClosable={false}
      onCancel={close}
      footer={[
        ...(createMode
          ? []
          : [
            <Button
              key='reload'
              size='small'
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={load}
            >
              {e('refresh')}
            </Button>
            ]),
        <Button key='close' size='small' onClick={close}>
          {e('close')}
        </Button>,
        <Button
          key='apply'
          size='small'
          type='primary'
          disabled={!script || !onApplySql}
          onClick={applyScript}
        >
          {e('dbStructDiffDdlApply')} {statementCount}
        </Button>
      ]}
    >
      <div className='db-design'>
        {
          createMode
            ? (
              <div className='db-design-comment'>
                <span className='db-design-label'>{e('dbCreateTableName')}</span>
                <Input
                  size='small'
                  className='db-design-table-name'
                  value={newTableName}
                  placeholder='new_table'
                  onChange={v => setNewTableName(v.target.value)}
                />
              </div>
              )
            : null
        }
        {
          readonlyDialect && !createMode
            ? (
              <Alert
                className='db-design-alert'
                type='warning'
                showIcon
                message={e('dbDesignReadonly')}
              />
              )
            : null
        }
        {
          error
            ? (
              <Alert
                className='db-design-alert'
                type='error'
                showIcon
                message={e('dbStructDiffFailed')}
                description={error}
              />
              )
            : null
        }
        {
          loading && !draft
            ? <div className='db-design-hint'><Spin size='small' /></div>
            : null
        }
        {
          draft
            ? (
              <div className='db-design-comment'>
                <span className='db-design-label'>{e('dbDesignComment')}</span>
                <Input
                  size='small'
                  value={draft.comment}
                  onChange={v => patch({ comment: v.target.value })}
                />
              </div>
              )
            : null
        }
        {
          draft
            ? (
              <div className='db-design-block'>
                <div className='db-design-block-head'>
                  <span className='db-design-block-title'>{e('dbStructDiffColumns')}</span>
                  <Button
                    size='small'
                    icon={<PlusOutlined />}
                    onClick={() => patch({ columns: draft.columns.concat(newColumn()) })}
                  >
                    {e('dbDesignAddColumn')}
                  </Button>
                </div>
                <div className='db-design-head db-design-row'>
                  <span className='db-design-cell is-name'>{e('dbDesignColName')}</span>
                  <span className='db-design-cell is-type'>{e('dbStructDiffFieldType')}</span>
                  <span className='db-design-cell is-bool'>{e('dbStructDiffFieldNullable')}</span>
                  <span className='db-design-cell is-bool'>{e('dbDesignHasDefault')}</span>
                  <span className='db-design-cell is-default'>{e('dbStructDiffFieldDefault')}</span>
                  <span className='db-design-cell is-comment'>{e('dbStructDiffFieldComment')}</span>
                  <span className='db-design-cell is-del' />
                </div>
                {draft.columns.map(renderColumn)}
              </div>
              )
            : null
        }
        {
          draft
            ? (
              <div className='db-design-block'>
                <div className='db-design-block-head'>
                  <span className='db-design-block-title'>{e('dbStructDiffIndexes')}</span>
                  <Button
                    size='small'
                    icon={<PlusOutlined />}
                    onClick={() => patch({ indexes: draft.indexes.concat(newIndex()) })}
                  >
                    {e('dbDesignAddIndex')}
                  </Button>
                </div>
                <div className='db-design-head db-design-row'>
                  <span className='db-design-cell is-name'>{e('dbDesignIxName')}</span>
                  <span className='db-design-cell is-cols'>{e('dbStructDiffFieldColumns')}</span>
                  <span className='db-design-cell is-bool'>{e('dbStructDiffFieldUnique')}</span>
                  <span className='db-design-cell is-del' />
                </div>
                {draft.indexes.map(renderIndex)}
              </div>
              )
            : null
        }
        {
          // 外键在这里只读：设计器不做外键编辑（§7 要点 3），但必须让人看见它存在，
          // 否则改被引用的那一列时没有任何地方提示"下面挂着外键"
          draft && draft.foreignKeys.length
            ? (
              <div className='db-design-fks'>
                <span className='db-design-block-title'>{e('dbStructDiffFks')}</span>
                {
                  draft.foreignKeys.map((fk, i) => (
                    <div key={String(fk.name || i)} className='db-design-fk-line'>
                      {String(fk.name || '') + ': ' +
                        (Array.isArray(fk.columns) ? fk.columns.join(', ') : '') +
                        ' → ' + String(fk.refTable || '') +
                        ' (' + (Array.isArray(fk.refColumns) ? fk.refColumns.join(', ') : '') + ')'}
                    </div>
                  ))
                }
              </div>
              )
            : null
        }
        {
          issues.length
            ? (
              <Alert
                className='db-design-alert'
                type='error'
                showIcon
                message={e('dbDesignIssues')}
                description={issues.map(x => e(ISSUE_KEY[x.code] || 'dbDesignIssueOther') +
                  (x.name ? ' — ' + x.name : '')).join('\n')}
              />
              )
            : null
        }
        {
          preview && !issues.length
            ? (
              <div className='db-design-block'>
                <div className='db-design-block-head'>
                  <span className='db-design-block-title'>
                    {e('dbDesignPreview')} ({items.length})
                  </span>
                  {
                    generatable.length
                      ? (
                        <Checkbox
                          checked={picked.length === generatable.length}
                          indeterminate={picked.length > 0 && picked.length < generatable.length}
                          onChange={v => setPicked(v.target.checked ? generatable.slice() : [])}
                        >
                          {e('dbStructDiffDdlAll')}
                        </Checkbox>
                        )
                      : null
                  }
                </div>
                {
                  items.length
                    ? items.map(item => (
                      <div key={item.id} className='db-design-change'>
                        <Checkbox
                          checked={picked.includes(item.id)}
                          disabled={!item.supported}
                          onChange={() => togglePick(item.id)}
                        />
                        <div className='db-design-change-main'>
                          <div className='db-design-change-name'>{item.id}</div>
                          {
                            item.supported
                              ? item.sqls.map(sql => <div key={sql} className='db-design-sql'>{sql}</div>)
                              : <div className='db-design-reason'>{e(ddlReasonKey(item.reason))}</div>
                          }
                        </div>
                      </div>
                    ))
                    : <div className='db-design-hint'>{e('dbDesignNone')}</div>
                }
                {
                  items.length && !generatable.length
                    ? <div className='db-design-hint'>{e('dbStructDiffDdlNone')}</div>
                    : null
                }
              </div>
              )
            : null
        }
        {
          draft && !readonlyDialect
            ? (
              <div className='db-design-hint'>
                <div>{e('dbDesignHint')}</div>
                <div>{e('dbStructDiffDdlHint')}</div>
              </div>
              )
            : null
        }
      </div>
    </Modal>
  )
}
