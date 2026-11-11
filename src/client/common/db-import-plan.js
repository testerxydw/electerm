/**
 * 导入向导的纯逻辑层（N4a，设计 §N4）
 *
 * 职责单一：把向导 UI 状态折算成"发往主进程的载荷"，并决定该走哪几条步骤。
 * 不引 React、不碰 IPC，UI 层只消费。
 *
 * 三条口径写在这里而不是散在组件里：
 * 1. 格式候选（IMPORT_FORMAT_IDS）—— 主进程 db-import/parsers.js 的注册表是权威，
 *    这里只是展示层需要的同一张表；两者由契约测试（db-import-plan.spec.js）钉成
 *    同集同序，改一处必改另一处，避免"界面能选 JSONL、主进程不认"。
 * 2. 走哪条通道由主进程预览响应的 `kind` 决定（'rows' | 'script'）—— 组件不自评
 *    格式，否则界面判定与主进程判定可能给出两个答案（旧版正是两处各猜一次定界符）。
 * 3. SQL 脚本的切分必须用 `db-sql-risk.classifySql`：它内部就是 splitStatements，
 *    风险弹窗列出的语句与实际下发的语句因此是同一批（判定与执行同一口径）。
 */

import { classifySql } from './db-sql-risk.js'
import { buildImportMapping } from './db-import-mapping.js'

// 与 src/app/lib/db-import/parsers.js 的 IMPORT_FORMAT_IDS 同集同序
export const IMPORT_FORMAT_IDS = ['csv', 'tsv', 'jsonl', 'xlsx', 'sql']

// '' = 不指定，让主进程按扩展名推断
export const FORMAT_AUTO = ''

export const ROWS_STEPS = ['file', 'mapping', 'mode', 'run']
export const SCRIPT_STEPS = ['file', 'statements', 'run']

const STEP_LABEL_KEY = {
  file: 'dbImportFile',
  mapping: 'dbImportMapping',
  mode: 'dbImportMode',
  statements: 'dbImportStatements',
  run: 'dbImportRun'
}

export function stepsOf (kind) {
  return kind === 'script' ? SCRIPT_STEPS : ROWS_STEPS
}

export function stepTitles (kind, t) {
  return stepsOf(kind).map(id => ({ title: t(STEP_LABEL_KEY[id]) }))
}

// 预览响应的 kind（主进程给的）；没选文件时按行通道走（步骤条不会闪）
export function kindOfFile (file) {
  if (!file) {
    return 'rows'
  }
  return file.kind === 'script' ? 'script' : 'rows'
}

/**
 * SQL 脚本 → 待执行语句清单（含风险分级）。
 * classifySql 一次调用同时给出"切分结果"和"最高风险级"，弹窗按这份清单确认、
 * 按同一份清单下发，两者不可能错位。
 */
export function statementPlan (scriptText, dbType) {
  const r = classifySql(String(scriptText || ''), dbType)
  return {
    level: r.level,
    reasons: r.reasons || [],
    statements: (r.statements || []).map(s => ({
      text: s.text,
      level: s.level,
      firstKeyword: s.firstKeyword,
      reasons: s.reasons
    }))
  }
}

/**
 * 折算 start 载荷。行通道需要映射与写入模式；脚本通道需要语句清单，
 * 不接受 table/mode/batchSize（表名写在语句里，模式与分批对它没有意义）。
 * 缺件即抛错（消息是文案 key），UI 据此禁用"开始导入"。
 */
export function buildStartPayload (state = {}) {
  const {
    file,
    kind,
    tabId = '',
    database = '',
    schema = '',
    table = '',
    rows = [],
    mode = 'append',
    batchSize = 500,
    statements = []
  } = state
  if (!file || !file.filePath) {
    throw new Error('dbImportNoFile')
  }
  const base = {
    tabId,
    database,
    schema,
    filePath: file.filePath,
    // 格式一并回传：主进程按注册表判定，与预览时同一口径
    format: file.format
  }
  if (kind === 'script') {
    const list = (Array.isArray(statements) ? statements : []).map(s => String(s || '').trim())
    if (!list.length) {
      throw new Error('dbImportNoStatements')
    }
    if (list.some(s => !s)) {
      throw new Error('dbImportEmptyStatement')
    }
    return { ...base, statements: list }
  }
  if (!table) {
    throw new Error('dbImportNoTable')
  }
  return {
    ...base,
    table,
    // xlsx 多 sheet：只在该格式下回传选中的 sheet（主进程按名匹配，匹配不到回落第一个）
    ...(file.format === 'xlsx' && file.sheetName ? { sheetName: file.sheetName } : {}),
    mapping: buildImportMapping(rows),
    mode,
    batchSize
  }
}

// 载荷折算失败的文案 key，成功返回 null —— UI 据此禁用"开始导入"
export function payloadProblem (state) {
  try {
    buildStartPayload(state)
    return null
  } catch (err) {
    return err.message
  }
}

// 脚本条数护栏（与主进程 MAX_IMPORT_STATEMENTS 同口径的 UI 提示）
export const MAX_UI_STATEMENTS = 20000

export function statementsProblem (count) {
  if (!count) {
    return 'dbImportNoStatements'
  }
  if (count > MAX_UI_STATEMENTS) {
    return 'dbImportTooManyStatements'
  }
  return null
}
