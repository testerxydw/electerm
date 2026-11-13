/**
 * N3b 受限表设计器 / N7 新建表与复制表（列 / 索引 / 表注释 → 候选 DDL，全程不执行）
 *
 * 方案 B「双入口、单实现」：三条路只是**基准不同**，不是三套功能。
 *   alter  基准 = 当前表结构，目标 = 当前表       → 逐条 ALTER（差异）
 *   create 基准 = 空结构，目标 = 新表             → 一条 CREATE（全量）
 *   copy   基准 = 别的表结构（本库/外库），目标 = 新表 → 一条 CREATE（全量）
 * 三者共用同一个草稿编辑 UI、同一套 designIssues 校验、同一个 draftToStructure
 * 归一化出口，以及 designPreview → buildScript → onApplySql 一条通道。这里
 * **不拼一句 SQL**，也不再为 create 模式另算一套预览。
 *
 * 三条不能松的口径：
 * - **只生成不执行**：勾选后的脚本整段交给 `props.onApplySql` 落 SQL 编辑器，
 *   执行仍由用户按运行触发、过危险分级与生产确认。本组件不碰 IPC 的写通道。
 *   复制表因此只复制**结构**（列/索引/表注释），不含数据；外键只读展示，
 *   不进 CREATE（设计器本就没有外键编辑入口）。
 * - **能力位降级**：能力没声明成 true 的方言挂只读预览横幅 / 只报 reason，
 *   判据走 capabilityOf 声明，不认引擎名（与生成器同源）。
 * - **改的是当前表**：alter 的基准是当前库结构、目标是草稿，方向在纯模块里
 *   定死；取数沿用结构对比的 `refresh: true` 通道，跳过 60s 结构缓存。
 *
 * 已有列/索引的名字栏在 alter 模式只读：改名在按名字配对的比较里等于
 * "删一列 + 加一列"，落库就是整列数据没了。create/copy 模式全部可编辑
 * （draftAsNew 已把 origName / src 清空，每行都是新行）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Button, Input, Checkbox, Select, Alert, Spin, Tag } from 'antd'
import { PlusOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons'
import {
  createDraft,
  newColumn,
  newIndex,
  emptyDraft,
  draftAsNew,
  designPreview
} from '../../common/db-table-design'
import { buildScript } from '../../common/db-ddl-generate'
import { ddlReasonKey } from '../../common/db-ddl-reason'
import { capabilityOf } from '../../common/sql-dialects'
import { cleanDbError } from './db-conn-error'
// 切换复制来源要确认：走项目统一弹层（Esc 捕获阶段、滚动 SSOT 都在里面），
// 不直接调 antd 的 Modal.confirm
import ConfirmModal from '../common/modal'

const e = window.translate
// 库名/表名都可能含点号，用 NUL 分隔才不会解析歧义（标识符里不会出现 NUL）
const SOURCE_SEP = '\u0000'

const locKey = loc => JSON.stringify([
  (loc && loc.database) || '',
  (loc && loc.schema) || '',
  (loc && loc.table) || ''
])

const locLabel = loc => [loc && loc.database, loc && loc.schema, loc && loc.table]
  .filter(Boolean).join('.')

// 草稿自身的硬错误：机器码 → 人话。create/copy 与 alter 共用这一套，
// 生成器给出的拒绝理由另走 item.reason → ddlReasonKey，两者分开展示。
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
  const {
    open, mode, target, databases, sourceTables,
    dialect, loadStructure, onApplySql, onClose
  } = props
  const isCreate = mode === 'create'
  const [current, setCurrent] = useState(null)
  const [loadedKey, setLoadedKey] = useState('')
  const [draft, setDraft] = useState(null)
  const [loading, setLoading] = useState(false)
  const [copying, setCopying] = useState(false)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState([])
  // 目标（create/copy 专属）：库可下拉换，表名由输入收。都由 props.target 初始化
  const [targetDb, setTargetDb] = useState('')
  const [targetTable, setTargetTable] = useState('')
  // 复制来源：'' = 空白表，其余 = 'db\u0000table'（本库/外库一视同仁）
  const [source, setSource] = useState('')
  // 草稿被用户改过：切换复制来源会重建草稿，得先问一句，不能静默丢改动
  const [draftDirty, setDraftDirty] = useState(false)
  const tokenRef = useRef(0)
  const copyTokenRef = useRef(0)

  const key = locKey(target)

  // alter 的基准结构取数；create/copy 没有"当前表"，复制源由 pickSource 单独取
  const load = useCallback(() => {
    if (isCreate) {
      return
    }
    if (!target || !target.table) {
      return
    }
    const at = locKey(target)
    tokenRef.current++
    const token = tokenRef.current
    setLoading(true)
    setError('')
    Promise.resolve(loadStructure(target)).then(structure => {
      if (token !== tokenRef.current) {
        return
      }
      setLoading(false)
      const s = structure || null
      setCurrent(s)
      setDraft(s ? createDraft(s) : null)
      setLoadedKey(at)
    }).catch(err => {
      if (token !== tokenRef.current) {
        return
      }
      setLoading(false)
      setError(cleanDbError(err && err.message ? err.message : err))
    })
  }, [target, loadStructure, isCreate])

  useEffect(() => {
    if (!open) {
      return
    }
    // 关掉/重开都作废在途请求：先看到上一张表的结果，用户会当成就长这样
    tokenRef.current++
    copyTokenRef.current++
    setCurrent(null)
    setLoadedKey('')
    setError('')
    setPicked([])
    setCopying(false)
    setSource('')
    setDraftDirty(false)
    if (isCreate) {
      // 空基准草稿由纯模块产出，形状与 createDraft(真实结构) 完全一致
      setDraft(emptyDraft())
      setTargetDb((target && target.database) || '')
      setTargetTable('')
    } else {
      setDraft(null)
      load()
    }
  }, [open, key, load, isCreate, target])

  const close = useCallback(() => {
    tokenRef.current++
    copyTokenRef.current++
    setLoading(false)
    setCopying(false)
    onClose()
  }, [onClose])

  const readonlyDialect = !capabilityOf(dialect, isCreate ? 'createTableDdl' : 'alterDdl')

  const patch = (set) => {
    setDraftDirty(true)
    setDraft(d => (d ? { ...d, ...set } : d))
  }

  const patchColumn = (k, set) => {
    setDraftDirty(true)
    setDraft(d => ({
      ...d,
      columns: d.columns.map(c => (c.key === k ? { ...c, ...set } : c))
    }))
  }

  const patchIndex = (k, set) => {
    setDraftDirty(true)
    setDraft(d => ({
      ...d,
      indexes: d.indexes.map(ix => (ix.key === k ? { ...ix, ...set } : ix))
    }))
  }

  const columnOptions = useMemo(() => ((draft && draft.columns) || [])
    .filter(c => String(c.name || '').trim())
    .map(c => ({ value: c.name.trim(), label: c.name.trim() })), [draft])

  // 唯一的预览入口：mode 决定基准与产物形状，组件里没有第二套预览逻辑
  const preview = useMemo(() => {
    if (!draft || copying) {
      return null
    }
    if (!isCreate && (loadedKey !== key || !current)) {
      return null
    }
    return designPreview({
      mode: isCreate ? 'create' : 'alter',
      current,
      draft,
      dialect,
      loc: target,
      target: {
        database: targetDb || (target && target.database) || '',
        schema: (target && target.schema) || '',
        table: targetTable.trim()
      }
    })
  }, [draft, copying, loadedKey, key, current, dialect, target, isCreate, targetDb, targetTable])

  // 目标库候选：owner 打开弹层时拉好的库列表；没拉到就退化为当前库一项
  const dbOptions = useMemo(() => ((databases && databases.length
    ? databases
    : [targetDb || (target && target.database) || '']
  ).filter(Boolean).map(n => ({ value: n, label: n }))), [databases, targetDb, target])

  // 复制源清单：空白选项 + 全部非系统库的 BASE TABLE（本库与外库同一份清单）
  const sourceOptions = useMemo(() => [
    { value: '', label: e('dbCreateTableSourceBlank') },
    ...((sourceTables || []).map(t => ({
      value: t.database + SOURCE_SEP + t.table,
      label: t.database + '.' + t.table
    })))
  ], [sourceTables])

  // 选一张已有表当草稿基准：复用 alter 的 getTableStructure 通道（按库读结构，
  // 跨库天然可用），再 draftAsNew 重基线 —— 清掉 origName/src，让所有行可编辑。
  // 取数期间草稿仍是旧的，预览用 copying 挡住，避免闪一下旧表的 CREATE。
  const applySource = async (v) => {
    setSource(v)
    setPicked([])
    setDraftDirty(false)
    copyTokenRef.current++
    const token = copyTokenRef.current
    setError('')
    if (!v) {
      setCopying(false)
      setDraft(emptyDraft())
      return
    }
    const [database, table] = String(v).split(SOURCE_SEP)
    setCopying(true)
    try {
      const structure = await Promise.resolve(loadStructure({ database, schema: '', table }))
      if (token !== copyTokenRef.current) {
        return
      }
      setDraft(draftAsNew(createDraft(structure || {})))
      // 目标表名为空时给个可编辑的默认值，不覆盖用户已经输入的名字
      setTargetTable(t => t.trim() ? t : table + '_copy')
    } catch (err) {
      if (token !== copyTokenRef.current) {
        return
      }
      setError(cleanDbError(err && err.message ? err.message : err))
    } finally {
      if (token === copyTokenRef.current) {
        setCopying(false)
      }
    }
  }

  // 换源 = 换一份草稿基准，已编辑的列/索引会被替换。改过就先问一句，
  // 免得切一下下拉把刚填的十几列静默丢掉（确认弹层走统一 Modal.confirm）
  const pickSource = (v) => {
    if (v === source) {
      return
    }
    if (!draftDirty) {
      return applySource(v)
    }
    ConfirmModal.confirm({
      title: e('dbCreateTableSwitchSource'),
      content: e('dbCreateTableSwitchSourceHint'),
      okText: e('confirm'),
      cancelText: e('cancel'),
      onOk: () => applySource(v)
    })
  }

  const items = preview ? preview.items : []
  const issues = preview ? preview.issues : []
  const generatable = useMemo(() => items.filter(i => i.supported).map(i => i.id), [items])
  // create/copy 没有"勾选差异"语义：整张表就是一条语句，直接全量生成
  const script = useMemo(
    () => buildScript(items, isCreate ? generatable : picked),
    [items, picked, generatable, isCreate]
  )
  // 语句数按 item.sqls 计，不按脚本行数 —— CREATE 是一条多行语句，
  // PG 的一条差异又可能产两条语句，按 \n 数两头都不准
  const statementCount = useMemo(() => items
    .filter(i => i.supported && (isCreate ? generatable : picked).includes(i.id))
    .reduce((n, i) => n + (i.sqls || []).length, 0),
  [items, generatable, picked, isCreate])

  // 草稿一改，勾选就可能对不上号（原来那条差异没了 / id 变了），整体清空比留着安全
  useEffect(() => {
    setPicked([])
  }, [preview])

  const togglePick = id => setPicked(list => (
    list.includes(id) ? list.filter(x => x !== id) : list.concat(id)
  ))

  const applyScript = () => {
    if (!script || !onApplySql || copying) {
      return
    }
    onApplySql(script)
  }

  const renderColumn = c => {
    // alter 的已有列禁止改名；create/copy 每行都是新行，全部可编辑
    const isNew = isCreate || !c.origName
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
        disabled={!isCreate && !!ix.origName}
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
      title={isCreate ? e('dbCreateTable') : e('dbDesign') + (target ? ' — ' + locLabel(target) : '')}
      // 草稿是编辑到一半的东西：点遮罩就丢掉比多一步确认更伤人
      maskClosable={false}
      onCancel={close}
      footer={[
        ...(isCreate
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
          disabled={!script || !onApplySql || copying}
          onClick={applyScript}
        >
          {e('dbStructDiffDdlApply')} {statementCount}
        </Button>
      ]}
    >
      <div className='db-design'>
        {
          isCreate
            ? (
              <div className='db-design-comment'>
                <span className='db-design-label'>{e('dbCreateTableDb')}</span>
                <Select
                  size='small'
                  className='db-design-db-select'
                  value={targetDb}
                  options={dbOptions}
                  onChange={v => setTargetDb(v)}
                  showSearch
                  optionFilterProp='label'
                />
                <span className='db-design-label'>{e('dbCreateTableName')}</span>
                <Input
                  size='small'
                  className='db-design-table-name'
                  value={targetTable}
                  placeholder='new_table'
                  onChange={v => setTargetTable(v.target.value)}
                />
              </div>
              )
            : null
        }
        {
          isCreate
            ? (
              <div className='db-design-comment'>
                <span className='db-design-label'>{e('dbCreateTableSource')}</span>
                <Select
                  size='small'
                  className='db-design-source-select'
                  value={source}
                  options={sourceOptions}
                  onChange={pickSource}
                  disabled={copying}
                  showSearch
                  optionFilterProp='label'
                />
                {copying ? <Spin size='small' /> : null}
                <span className='db-design-source-hint'>{e('dbCreateTableSourceHint')}</span>
              </div>
              )
            : null
        }
        {
          readonlyDialect && !isCreate
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
          // 外键只读：设计器不做外键编辑，但必须让人看见它存在。
          // create/copy 额外说明外键不进 CREATE，免得用户以为复制了完整约束
          draft && draft.foreignKeys && draft.foreignKeys.length
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
                {
                  isCreate
                    ? <div className='db-design-hint'>{e('dbCreateTableFkHint')}</div>
                    : null
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
                    !isCreate && generatable.length
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
                        {
                          !isCreate
                            ? (
                              <Checkbox
                                checked={picked.includes(item.id)}
                                disabled={!item.supported}
                                onChange={() => togglePick(item.id)}
                              />
                              )
                            : null
                        }
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
