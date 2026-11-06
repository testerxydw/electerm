import { useEffect, useMemo, useRef } from 'react'
import { registerSqlTarget, unregisterSqlTarget } from '../../common/db-sql-ai-target'

// N11a-12（#10）：把本 tab 的 SQL 编辑器登记给 AI 侧。
// 句柄归属见 AGENTS.md §5.2.4：sqlAiCtxRef 是页面级共享 ref（会话页的 AI 弹层与
// 解释入口也要读），由 owner 创建并注入；本 hook 只负责刷新上下文、维护只读快照、
// 构造稳定的目标对象，并把 sqlAiTarget 回流给 owner 的 insertAiSql 使用。

export function useDbAiRegister ({
  tabId,
  isRedis,
  tab,
  sel,
  structureV2,
  isReadonly,
  sqlResult,
  grid,
  sqlEditorRef,
  setSqlText,
  sqlAiCtxRef
}) {
  // ---- AI 第一批：把本 tab 的 SQL 编辑器登记给 AI 侧 ----
  // 上下文（当前表 / 列缓存 / 只读）每次渲染刷进 ref，登记出去的对象保持稳定：
  // 依赖变化来回注销重登，在严格模式/热更下会把刚登记的新句柄删掉
  sqlAiCtxRef.current = {
    dbType: tab.dbType,
    database: (sel && sel.database) || '',
    schema: (sel && sel.schema) || '',
    table: (sel && sel.table) || '',
    columns: structureV2.columns || [],
    readOnly: !!isReadonly
  }

  // AI agent 的只读快照（S2-1）：把"屏幕上现在是什么"交出去——人刚跑出来的结果集，
  // 或数据网格当前页。同样按渲染刷进 ref，登记出去的对象保持稳定。
  // 这里没有任何执行能力，交出去的也只是已有 state。
  const sqlAiLiveRef = useRef(null)
  sqlAiLiveRef.current = { sqlResult, grid, sel }

  // 契约只暴露"写编辑器"的能力（没有 runSql）——AI 拿不到任何执行路径，
  // 危险语句仍由用户按执行时的 confirmSqlRisk 拦
  const sqlAiTarget = useMemo(() => ({
    // 编辑器是懒挂载的：句柄没就绪时 AI 侧的动作要禁用而不是静默改 state
    isAvailable: () => !!sqlEditorRef.current,
    getDocText: () => (sqlEditorRef.current
      ? sqlEditorRef.current.getValue()
      : ''),
    getSelection: () => {
      const editor = sqlEditorRef.current
      if (!editor) {
        return { text: '', range: null }
      }
      return {
        text: editor.getSelectionText(),
        range: editor.getSelectionRange ? editor.getSelectionRange() : null
      }
    },
    getContext: () => sqlAiCtxRef.current,
    // 只读快照：优先人刚执行出来的结果集，其次数据网格当前页；两者都没有回 null
    // （agent 侧据此报错并给出下一步，而不是返回一张空表让模型编数据）
    getResultSnapshot () {
      const live = sqlAiLiveRef.current || {}
      const sql = live.sqlResult || {}
      const gridState = live.grid || {}
      const selected = live.sel || {}
      if (Array.isArray(sql.results) && sql.results.length) {
        return {
          source: 'sql-result',
          results: sql.results,
          elapsedMs: sql.elapsedMs,
          error: sql.error || ''
        }
      }
      if (sql.error || gridState.error) {
        return {
          source: 'sql-result',
          results: [],
          error: sql.error || gridState.error
        }
      }
      if (Array.isArray(gridState.rows) && gridState.rows.length) {
        return {
          source: 'grid',
          results: [{ rows: gridState.rows }],
          table: (selected.database ? selected.database + '.' : '') + (selected.table || ''),
          page: gridState.page,
          hasMore: gridState.hasMore,
          totalRows: gridState.totalRows
        }
      }
      return null
    },
    insertSql (text, plan) {
      const editor = sqlEditorRef.current
      const p = plan || {}
      const docLen = editor ? editor.getValue().length : 0
      const start = Number.isFinite(p.start) ? p.start : 0
      const end = Number.isFinite(p.end) ? p.end : docLen
      // 首选：按 planSqlInsertion 给的精确区间替换（保留撤销栈）
      if (editor && editor.replaceRange && editor.replaceRange(text, start, end)) {
        return true
      }
      if (p.kind === 'replace-all') {
        setSqlText(text)
        return true
      }
      const ok = editor && editor.insertText(text)
      if (!ok) {
        setSqlText(t => (t ? t + '\n' + text : text))
      }
      return true
    }
  }), [])

  useEffect(() => {
    // redis 没有 SQL 编辑器，不登记（AI 侧按"活动 tab 有没有目标"判定）
    if (isRedis) {
      return undefined
    }
    registerSqlTarget(tabId, sqlAiTarget)
    return () => unregisterSqlTarget(tabId, sqlAiTarget)
  }, [tabId, isRedis, sqlAiTarget])

  return { sqlAiTarget }
}
