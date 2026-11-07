/**
 * 导入向导的语句清单步（N4a，设计 §N4）
 *
 * 只负责"把 classifySql 切出来的语句列表给人看"：条数、逐条序号与风险级、
 * 超出上限的提示。不切分、不判风险、不发 IPC —— 那些在 db-import-plan.js /
 * db-sql-risk.js。风险级沿用 E1 弹窗的同一套词条与配色类（LEVEL_LABEL_KEY +
 * .db-risk-stmt-lv），不再抄一份等级映射。
 */

import { LEVEL_LABEL_KEY } from './db-danger-confirm'

const e = window.translate

// 列表只渲染前 N 条：几万条 INSERT 全渲染会把弹窗 DOM 撑死，
// 条数与"还有多少条"照常给出，用户要核对的是形状而不是每一行
const MAX_SHOWN = 200

export default function DbImportStatements (props) {
  const {
    plan = { statements: [], reasons: [] },
    perStatement = false
  } = props
  const list = plan.statements || []
  const hidden = list.length - MAX_SHOWN

  return (
    <div className='db-import-step'>
      <div className='db-import-step-title'>
        {e('dbImportStatementsCount').replace('{n}', String(list.length))}
      </div>
      {
        perStatement
          ? (
            <div className='db-import-stmt-note'>{e('dbImportPerStatementNote')}</div>
            )
          : null
      }
      <div className='db-import-stmt-list'>
        {list.slice(0, MAX_SHOWN).map((s, i) => (
          <div className='db-import-stmt' key={i}>
            <span className='db-import-stmt-no'>{i + 1}</span>
            <span className={'db-risk-stmt-lv db-risk-lv-' + ((s && s.level) || 'unknown')}>
              {e(LEVEL_LABEL_KEY[s && s.level] || 'dbRiskUnknown')}
            </span>
            <span className='db-import-stmt-text'>{s && s.text}</span>
          </div>
        ))}
        {
          hidden > 0
            ? (
              <div className='db-import-stmt-more'>
                {e('dbImportMoreStatements').replace('{n}', String(hidden))}
              </div>
              )
            : null
        }
      </div>
    </div>
  )
}
