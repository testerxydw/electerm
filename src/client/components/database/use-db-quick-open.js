// #13 命令面板（E2-3b，cluster #13 of 设计-db-session拆分方案-N11a）。
// 行为零变更搬移：Ctrl/Cmd+K 快捷键 effect + 打开时刷新历史 + 四类来源
// （动作/对象/历史前20/当前表列）的 memo 与 quickItems 汇总，全部 hooks、无 JSX，
// 逐字迁入本 hook；展示组件 DbQuickOpen（db-quick-open.jsx）本就独立。
// mainTab（U1c 主页签）不属本簇，留 owner。
// 页面级注入：动作依赖（runSql/formatSqlEditor/isReadonly/toggleReadonly/sel/grid/
// resetPageFilter/resetExactRows/countKeyRef/loadWithCount/exportGridCsv/exportGridAs）、
// 对象依赖（isRedis/metadata/onSelectTree）、历史（sqlHistory/setSqlHistory）、
// 列（structureV2/setSqlText）。
import { useEffect, useMemo, useState } from 'react'
import { listSqlHistory } from '../../common/db-sql-history'
import { previewText } from '../../common/db-sql-history-panel'
import {
  isLeafNode,
  nodeKey,
  DB_OBJECT_MARKS,
  isDbObjectType
} from '../../common/db-session-const'

const e = window.translate

export function useDbQuickOpen ({
  runSql,
  formatSqlEditor,
  isReadonly,
  toggleReadonly,
  sel,
  grid,
  resetPageFilter,
  resetExactRows,
  countKeyRef,
  loadWithCount,
  exportGridCsv,
  exportGridAs,
  isRedis,
  metadata,
  onSelectTree,
  sqlHistory,
  setSqlHistory,
  structureV2,
  setSqlText
}) {
  const [quickOpen, setQuickOpen] = useState(false)

  // 快捷键挂在 window 上：焦点在 SQL 编辑器（CM6）或网格里时按键也要生效。
  // Ctrl/Cmd+P 一律不拦（那是打印/其他面板的键）；带 shift/alt 的组合不是本
  // 功能的键位，放行不抢 —— 判据只有 metaKey/ctrlKey + 纯 'k'
  useEffect(() => {
    const onKey = (ev) => {
      if (!(ev.metaKey || ev.ctrlKey) || ev.shiftKey || ev.altKey) {
        return
      }
      if (String(ev.key).toLowerCase() !== 'k') {
        return
      }
      ev.preventDefault()
      setQuickOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 面板打开时顺手刷新历史：历史走 IPC 异步读，不刷新就只会看到上一次
  // 打开历史弹层时的快照，面板里的"最近 SQL"永远是旧的
  useEffect(() => {
    if (quickOpen) {
      listSqlHistory()
        .then(setSqlHistory)
        .catch(err => console.warn('load sql history failed:', err))
    }
  }, [quickOpen])

  // 来源一（动作）：只挂"已存在"的功能入口，run 直接复用本文件里既有按钮的
  // 同一条闭包 —— 报错通道也是现成的（这些函数自己会 onOpError /
  // message.error），面板层不重复弹错。不在这里发明新动作。
  const quickActions = useMemo(() => [
    {
      kind: 'action',
      id: 'runSql',
      title: e('dbRun'),
      subtitle: '',
      hint: 'Ctrl/Cmd+Enter',
      run: runSql
    },
    {
      kind: 'action',
      id: 'formatSql',
      title: e('dbFormatSql'),
      subtitle: '',
      hint: 'Ctrl/Cmd+Shift+F',
      run: formatSqlEditor
    },
    {
      kind: 'action',
      id: 'toggleReadonly',
      title: e('readOnly'),
      subtitle: '',
      hint: '',
      // 与只读开关同一入口：先同步主进程成功再改本地，顺序在 toggleReadonly 里
      run: () => toggleReadonly(!isReadonly)
    },
    {
      kind: 'action',
      id: 'refreshTable',
      title: e('refresh'),
      subtitle: '',
      hint: '',
      // 与网格头"刷新"按钮同一条链路：清过滤/选中、清 count 指纹再按当前
      // 页码重取 —— 只调 loadWithCount 会留下过期的总数
      run: () => {
        if (!sel) {
          return
        }
        resetPageFilter()
        resetExactRows()
        countKeyRef.current = ''
        loadWithCount(sel, grid.page)
      }
    },
    {
      kind: 'action',
      id: 'exportCsv',
      title: 'CSV',
      subtitle: '',
      hint: '',
      // 标题沿用导出菜单的裸格式名（那份菜单就没走词条），不加新文案
      run: exportGridCsv
    },
    {
      kind: 'action',
      id: 'exportJson',
      title: 'JSON',
      subtitle: '',
      hint: '',
      run: () => exportGridAs('json')
    }
  ], [runSql, formatSqlEditor, isReadonly, sel, grid.page, loadWithCount, exportGridCsv, exportGridAs])

  // 来源二（对象）：直接走 metadata（树的数据源）而不走 flattenTables ——
  // 那个只回表名，丢掉了"选表"要用的 库/schema 信息。run 复用树点击的
  // onSelectTree：选表 = 结构 → 视角 → 首页 的完整链路，竞态令牌、页面重置
  // 都在里面，面板自己再拼一遍必然漏。PG 同库可能有同名表（不同 schema），
  // subtitle 带上库名（或 schema）作定位
  const quickObjects = useMemo(() => {
    if (isRedis) {
      return []
    }
    const out = []
    for (const db of metadata || []) {
      if (!db || !db.name) {
        continue
      }
      const walk = (schema, nodes) => {
        for (const node of nodes || []) {
          if (isLeafNode(node)) {
            out.push({
              kind: 'object',
              id: nodeKey(db.name, schema, node.name),
              title: node.name,
              subtitle: schema ? `${db.name}.${schema}` : db.name,
              // 树里已改用形状图标；面板这一列窄，仍用单字母简称（不算文案，不进词条）
              hint: node.type === 'view' ? 'V' : (DB_OBJECT_MARKS[node.type] || ''),
              run: () => onSelectTree(null, {
                node: {
                  key: nodeKey(db.name, schema, node.name),
                  isLeaf: true,
                  nodeType: node.type,
                  objMeta: isDbObjectType(node.type)
                    ? { signature: node.signature || '', table: node.table || '' }
                    : undefined
                }
              })
            })
          } else if (Array.isArray(node.children)) {
            // B2：分组节点（routines/triggers/events）不改变 schema 归属，
            // 否则 subtitle 会变成 db.routines 这种假 schema
            walk(node.type === 'group' ? schema : node.name, node.children)
          }
        }
      }
      walk('', db.children)
    }
    return out
  }, [isRedis, metadata, onSelectTree])

  // 来源三（历史前 20）：title 取 SQL 首行截断 —— 多行语句在面板里放不下，
  // 完整语句选中后回填编辑器可见。run 与历史弹层的 pickSqlHistory 同一条
  // 回填路径（setSqlText(item.sql)）
  const quickHistory = useMemo(() => (sqlHistory || [])
    .slice(0, 20)
    .map((h, i) => {
      const firstLine = previewText(h && h.sql).split('\n')[0].slice(0, 80)
      if (!firstLine) {
        return null
      }
      return {
        kind: 'history',
        id: `hist:${h.ts}:${i}`,
        title: firstLine,
        subtitle: '',
        hint: '',
        run: () => setSqlText(h.sql)
      }
    })
    .filter(Boolean), [sqlHistory])

  // 来源四（当前表相关）：structureV2.columns 的列名。kind 归入 object ——
  // 打分/分组只有三类，列本来就是"对象"的子集；与表在视觉上靠 hint（类型）
  // 区分，subtitle 放注释。只挂当前选中表的列：没有选中表时面板少一组而已
  const quickColumns = useMemo(() => {
    if (!sel || isRedis) {
      return []
    }
    return (structureV2.columns || [])
      .filter(c => c && typeof c.name === 'string' && c.name)
      .map(c => ({
        kind: 'object',
        id: `col:${c.name}`,
        title: c.name,
        subtitle: typeof c.comment === 'string' ? c.comment.trim() : '',
        hint: String(c.dataType || ''),
        // 编辑器句柄（db-sql-editor 的 useImperativeHandle）没暴露光标处插入
        // 的 API；为不动编辑器文件，退化为把列名追加到当前语句末尾
        run: () => setSqlText(t => {
          const base = typeof t === 'string' ? t : ''
          return base && !/\s$/.test(base) ? base + ' ' + c.name : base + c.name
        })
      }))
  }, [sel, isRedis, structureV2.columns])

  const quickItems = useMemo(() => [
    ...quickActions,
    ...quickObjects,
    ...quickHistory,
    ...quickColumns
  ], [quickActions, quickObjects, quickHistory, quickColumns])

  return { quickOpen, setQuickOpen, quickItems }
}
