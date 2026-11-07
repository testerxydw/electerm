/**
 * 导入向导的列映射步（C 批 §10 的映射行 UI，N4a 拆出独立组件）
 *
 * 只管"一行一个源列 → 选目标形态"的呈现与回写；折算成后端 mapping、
 * 校验完整性都在 ../../common/db-import-mapping.js（纯函数层）。
 *
 * 行形态（rows 元素）与 db-import-mapping.js 头注释一致：
 *   { fileCol, mode, target, objCol, constVal, exprSql }
 * fileCol 的语义随格式变化（csv/tsv = 表头列名，jsonl = JSON 键名），
 * 组件不关心 —— 它只把主进程预览给出的列名列出来。
 */

import { Select, Input, Tooltip } from 'antd'

const e = window.translate

// 模式选项值（Select value）：column: 前缀 = field 映射到该列，其余是特殊形态
const OPT_IGNORE = 'ignore'
const OPT_CONSTANT = 'constant'
const OPT_EXPRESSION = 'expression'
const OPT_NULL = 'null'

function optValueOf (r) {
  if (!r || r.mode === 'ignore' || r.mode === undefined) {
    return OPT_IGNORE
  }
  if (r.mode === 'field') {
    return 'column:' + String(r.target || '')
  }
  return r.mode
}

export default function DbImportMapping (props) {
  const { rows = [], targetNames = [], onChange = () => {} } = props
  const setRow = (idx, patch) => onChange(idx, patch)

  // 切形态时只改 mode，各形态的输入留在行上：来回切不丢已填的参数
  const onRowOpt = (idx, val) => {
    if (val.startsWith('column:')) {
      setRow(idx, { mode: 'field', target: val.slice(7) })
      return
    }
    if (val === OPT_IGNORE) {
      setRow(idx, { mode: 'ignore' })
      return
    }
    setRow(idx, { mode: val })
  }

  const colOptions = targetNames.map(n => ({ value: n, label: n }))

  return (
    <div className='db-import-mapping'>
      <div className='db-import-mapping-head'>
        <span>{e('dbImportFileCol')}</span>
        <span>{e('dbImportTarget')}</span>
      </div>
      {rows.map((r, i) => (
        <div className='db-import-mapping-row' key={i}>
          <span className='db-import-file-col'>{r.fileCol}</span>
          <span className='db-import-mapping-ctl'>
            <Select
              size='small'
              value={optValueOf(r)}
              onChange={v => onRowOpt(i, v)}
              options={[
                ...targetNames.map(n => ({ value: 'column:' + n, label: n })),
                { value: OPT_IGNORE, label: e('dbImportIgnore') },
                { value: OPT_CONSTANT, label: e('dbImportConstant') },
                { value: OPT_EXPRESSION, label: e('dbImportExpression') },
                { value: OPT_NULL, label: e('dbImportNull') }
              ]}
            />
            {
              r.mode === 'constant'
                ? (
                  <span className='db-import-extra'>
                    <Select
                      size='small'
                      value={r.objCol || undefined}
                      placeholder={e('dbImportTarget')}
                      onChange={v => setRow(i, { objCol: v })}
                      options={colOptions}
                    />
                    <Input
                      size='small'
                      value={r.constVal}
                      placeholder={e('dbImportConstant')}
                      onChange={ev => setRow(i, { constVal: ev.target.value })}
                    />
                  </span>
                  )
                : null
            }
            {
              r.mode === 'expression'
                ? (
                  <span className='db-import-extra'>
                    <Select
                      size='small'
                      value={r.objCol || undefined}
                      placeholder={e('dbImportTarget')}
                      onChange={v => setRow(i, { objCol: v })}
                      options={colOptions}
                    />
                    <Tooltip title={e('dbImportExpressionHint')}>
                      <Input
                        size='small'
                        className='db-import-expr'
                        status='warning'
                        value={r.exprSql}
                        placeholder={e('dbImportExpressionHint')}
                        onChange={ev => setRow(i, { exprSql: ev.target.value })}
                      />
                    </Tooltip>
                  </span>
                  )
                : null
            }
            {
              r.mode === 'null'
                ? (
                  <span className='db-import-extra'>
                    <Select
                      size='small'
                      value={r.objCol || undefined}
                      placeholder={e('dbImportTarget')}
                      onChange={v => setRow(i, { objCol: v })}
                      options={colOptions}
                    />
                  </span>
                  )
                : null
            }
          </span>
        </div>
      ))}
    </div>
  )
}
