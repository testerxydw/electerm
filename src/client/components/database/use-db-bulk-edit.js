// #4b B3-2 批量同列改值 / B3-3 表内查找替换（cluster #4 of 设计-db-session拆分方案-N11a）。
// 行为零变更搬移：两条批量写路径共用一个 runUpdateCells（主进程 updateCells，
// 同列、按主键定位、值全部绑定；值一致走单条 IN，散值逐行以便失败行可报），
// 范围都限定"本页可见行"，与 deleteRows 同口径 —— 不碰全表。
// bulk / rep 两个弹窗 state 为簇私有（只有本簇 handler 与对应弹窗消费），
// 随簇搬入并按 use-db-tree 先例回流给 owner 渲染；
// 弹窗 JSX 仍在 owner（含 Select/Input/Checkbox 交互），故 setBulk/setRep 一并回流。
import { useMemo, useState } from 'react'
import message from '../common/message'
import {
  planSameValue,
  planReplace
} from '../../common/db-grid-replace'
import {
  bulkUpdatePreview,
  replacePreview
} from '../../common/db-change-preview'

const e = window.translate

export function useDbBulkEdit ({
  sel,
  pkColumn,
  tabId,
  setGrid,
  loadQuery,
  grid,
  onOpError,
  changes,
  confirmRowWrite,
  filteredRows,
  selectedCell,
  selectedRowKeys,
  setSelectedRowKeys,
  structureV2
}) {
  // ---- B3-2 批量同列改值 / B3-3 表内查找替换 ----
  // 两者共用主进程 updateCells（同列、按主键定位、值全部绑定），区别只在
  // updates 的 value 是否一致：一致走单条 IN（快、原子），散值逐行（失败行可报）。
  // 范围都限定"本页可见行"——不碰全表，避免一次误操作重写整张表（与 deleteRows 同口径）。
  const [bulk, setBulk] = useState({ open: false, col: '', text: '', isNull: false })
  const [rep, setRep] = useState({ open: false, col: '', find: '', text: '', matchCase: true, wholeCell: false })

  // 可写列（用于两个弹窗的列下拉）：来自表结构缓存，含列名与类型
  const writeColumns = useMemo(
    () => (structureV2.columns || [])
      .filter(c => c && typeof c.name === 'string' && c.name)
      .map(c => ({ name: c.name, type: String(c.dataType || '') })),
    [structureV2.columns]
  )

  // 下拉项标出类型（'id (int)'）：查找替换只作用于文本单元格，
  // 选列时就该看得出这一列会不会参与，而不是等预览报"没有可替换的内容"
  const columnOptions = useMemo(
    () => writeColumns.map(c => ({
      value: c.name,
      label: c.type ? `${c.name} (${c.type})` : c.name
    })),
    [writeColumns]
  )

  // 取出当前勾选的原始行（grid.rows 才含主键，filteredRows 是过滤后的展示副本）
  const selectedRows = useMemo(
    () => grid.rows.filter((_, i) => selectedRowKeys.includes(i)),
    [grid.rows, selectedRowKeys]
  )

  const openBulk = () => {
    const def = selectedCell && selectedCell.col
      ? selectedCell.col
      : (writeColumns[0] || {}).name || ''
    setBulk({ open: true, col: def, text: '', isNull: false })
  }

  // 共用：把一批 updates 发给主进程并刷新（B3-2/B3-3 都走这里）
  const runUpdateCells = async (column, updates) => {
    if (!sel || !pkColumn || !updates.length) {
      return
    }
    setGrid(g => ({ ...g, loading: true }))
    try {
      const res = await window.pre.runGlobalAsync('dbClientOp', tabId, 'updateCells', {
        database: sel.database,
        schema: sel.schema || '',
        table: sel.table,
        pkColumn,
        column,
        updates
      })
      message.success(e('dbAffected').replace('{n}', String((res && res.affected) ?? 0)))
      const failed = (res && res.failed) || []
      if (failed.length) {
        message.warning(
          e('dbUpdateCellsFailed').replace('{n}', String(failed.length)) +
          ' ' + failed.slice(0, 3).map(f => `${f.pk}: ${f.message}`).join('; ')
        )
      }
      setSelectedRowKeys([])
      loadQuery(sel, grid.page)
    } catch (err) {
      setGrid(g => ({ ...g, loading: false }))
      onOpError(err)
    }
  }

  const submitBulk = async () => {
    if (!sel || !pkColumn || !bulk.col) {
      return
    }
    if (!selectedRows.length) {
      message.info(e('dbNeedSelection'))
      return
    }
    const value = bulk.isNull ? null : bulk.text
    const plan = planSameValue(selectedRows, { column: bulk.col, pkColumn, value })
    if (!plan.updates.length) {
      message.info(e('dbBulkNoChange'))
      return
    }
    // N2：暂存开着时按"行主键 + 列"逐条进变更集（与逐格编辑同一粒度，
    // 所以之后重复改同一格会合并而不是堆两条）
    if (changes.stageUpdates({ column: bulk.col, updates: plan.updates })) {
      setBulk(b => ({ ...b, open: false }))
      return
    }
    const ok = await confirmRowWrite({
      level: 'write',
      text: bulkUpdatePreview({
        sel,
        column: bulk.col,
        value,
        pkColumn,
        pks: plan.updates.map(u => u.pk)
      }),
      note: e('dbAffectedRows').replace('{n}', String(plan.updates.length))
    })
    if (!ok) {
      return
    }
    setBulk(b => ({ ...b, open: false }))
    await runUpdateCells(bulk.col, plan.updates)
  }

  // 查找替换的实时预览：随输入变化，告诉用户"会改几行"（范围=当前页可见行）
  const repPreview = useMemo(
    () => planReplace(filteredRows, {
      column: rep.col,
      pkColumn,
      find: rep.find,
      replace: rep.text,
      matchCase: rep.matchCase,
      wholeCell: rep.wholeCell
    }),
    [rep, filteredRows, pkColumn]
  )

  const openReplace = () => {
    const def = selectedCell && selectedCell.col
      ? selectedCell.col
      : (writeColumns[0] || {}).name || ''
    setRep({ open: true, col: def, find: '', text: '', matchCase: true, wholeCell: false })
  }

  // 预览文案三分支：可改 → 报单元格数；整列没有文本值（数值/日期/JSON 对象等）→
  // 说清"这列不参与替换"并指向批量改值/双击编辑；否则才是真的没匹配到。
  // 判据用单元格实际类型而不是列声明类型：planReplace 就是按 typeof 跳过的，
  // 声明类型和实际值在 JSON/二进制信封这类列上并不一致，按实际值说才不会反过来误导。
  const repHint = useMemo(() => {
    if (repPreview.updates.length) {
      return {
        text: e('dbReplacePreview').replace('{n}', String(repPreview.updates.length)),
        warn: false
      }
    }
    if (filteredRows.length && !repPreview.textCells) {
      const t = (writeColumns.find(c => c.name === rep.col) || {}).type || rep.col
      return {
        text: e('dbReplaceNonTextColumn').replace('{type}', t),
        warn: true
      }
    }
    return { text: e('dbReplaceNone'), warn: false }
  }, [repPreview, filteredRows, writeColumns, rep.col])

  const submitReplace = async () => {
    if (!sel || !pkColumn || !rep.col || !repPreview.updates.length) {
      return
    }
    // N2：替换结果同样落成逐格改动（不是"一条 replace() 语句"）——
    // 预览显示的是每行替换后的最终值，与真正执行的绑定值一致
    if (changes.stageUpdates({ column: rep.col, updates: repPreview.updates })) {
      setRep(r => ({ ...r, open: false }))
      return
    }
    const ok = await confirmRowWrite({
      level: 'write',
      text: replacePreview({
        sel,
        column: rep.col,
        find: rep.find,
        replace: rep.text,
        pkColumn,
        pks: repPreview.updates.map(u => u.pk)
      }),
      note: e('dbAffectedRows').replace('{n}', String(repPreview.updates.length))
    })
    if (!ok) {
      return
    }
    setRep(r => ({ ...r, open: false }))
    await runUpdateCells(rep.col, repPreview.updates)
  }

  return {
    bulk,
    setBulk,
    rep,
    setRep,
    columnOptions,
    selectedRows,
    openBulk,
    submitBulk,
    openReplace,
    submitReplace,
    repPreview,
    repHint
  }
}
