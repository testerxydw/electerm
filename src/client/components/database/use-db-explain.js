// D 批 EXPLAIN（只读计划分析）编排 handler（cluster #12 of 设计-db-session拆分方案-N11a）。
// 行为零变更搬移：openExplain 函数体逐字不改；页面级 state / ref 由 owner 注入（AGENTS.md §5.2.4）。
import message from '../common/message'

const e = window.translate

export function useDbExplain ({
  sqlEditorRef,
  sqlText,
  setExplainSql,
  setExplainOpen
}) {
  // ---- D 批：EXPLAIN（只读计划分析，设计 §12.1） ----

  // 「解释」入口：优先解释编辑器当前选区，无选区解释整段语句。
  // 库/schema 取当前树选中（与 runSql 同口径）；换行/分号的闸门在后端
  const openExplain = () => {
    const editor = sqlEditorRef.current
    const selected = editor && editor.getSelectionText
      ? editor.getSelectionText()
      : ''
    const text = (selected || sqlText).trim()
    if (!text) {
      message.warning(e('dbExplainEmptySql'))
      return
    }
    setExplainSql(text)
    setExplainOpen(true)
  }
  return { openExplain }
}
