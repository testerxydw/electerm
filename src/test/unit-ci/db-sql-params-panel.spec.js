// H6a 参数化查询：面板接线（源码级）
//
// 取值/转换的数学部分由 db-sql-params.spec.js 钉死，后端只吃数组由
// db-sql-params-adapter.spec.js 钉死。这里钉"接到一起之后容易悄悄坏掉"的几件事：
//   · 只有参数开关打开、且不是 Redis 时才会去抽取 :name
//   · 多语句在打开面板之前就被挡掉（占位符归属无法确定）
//   · 面板只收值，转换交给 toPositional；转换失败不发请求
//   · 历史存原文（含 :name），参数值不进历史、不落盘
//   · 面板每次打开都从 memo 灌初值，打开期间重新渲染不冲掉半截输入
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const SESSION = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const MODAL = path.join(ROOT, 'src/client/components/database/db-sql-params-modal.jsx')
const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

const read = p => fs.readFileSync(p, 'utf8')

function blockOf (src, anchor) {
  const at = src.indexOf(anchor)
  assert.notEqual(at, -1, `anchor not found: ${anchor}`)
  const end = src.indexOf('\n  }\n', at)
  assert.notEqual(end, -1, `block end not found for: ${anchor}`)
  return src.slice(at, end + 4)
}

describe('H6a 参数化：执行入口', () => {
  test('只有开关打开且非 Redis 才抽取 :name；没有参数走原路径', () => {
    const s = read(SESSION)
    const run = blockOf(s, 'const runSql = async () => {')
    assert.match(run, /const names = !isRedis && sqlParamMode \? extractSqlParams\(sql\) : \[\]/,
      '抽参必须同时受 isRedis 与开关约束')
    assert.match(run, /if \(!names\.length\) \{\s*\n\s*return runSqlNow\(sql, null, sql\)/,
      '没有参数时要原样执行（params 传 null）')
  })

  test('多语句在打开面板之前就被挡掉', () => {
    const s = read(SESSION)
    const run = blockOf(s, 'const runSql = async () => {')
    const guard = run.indexOf('countSqlStatements(sql) > 1')
    const open = run.indexOf('setSqlParams({ open: true')
    assert.notEqual(guard, -1, '缺多语句闸门')
    assert.ok(guard < open, '多语句判定必须在开面板之前')
    assert.match(run, /message\.error\(e\('dbSqlParamsSingle'\)\)/, '多语句要明说原因')
    const branch = run.slice(run.indexOf('if (countSqlStatements(sql) > 1)'), run.indexOf('const database'))
    assert.ok(!/runSqlNow/.test(branch), '多语句不能退回纯文本执行（那就绕过了参数化语义）')
  })

  test('转换失败不发请求；成功后先关面板再执行', () => {
    const s = read(SESSION)
    const submit = blockOf(s, 'const submitSqlParams = values => {')
    const tryCatch = submit.slice(submit.indexOf('try {'), submit.indexOf('setSqlParams'))
    assert.match(tryCatch, /toPositional\(sql, values, dialect\)/, '转换必须走纯函数并带方言')
    assert.match(tryCatch, /message\.error/, '转换失败要给出原因')
    assert.match(tryCatch, /return/, '转换失败必须中止（不能带着原文去执行）')
    const run = submit.indexOf('runSqlNow(built.sql, built.values, sql)')
    assert.ok(run > submit.indexOf('setSqlParams'), '先关面板再执行')
    assert.match(submit, /runSqlNow\(built\.sql, built\.values, sql\)/,
      '执行用占位符文本 + 值，历史用原文')
  })

  test('值记在 tab 内存里：memo 只存字符串与 NULL 标记', () => {
    const s = read(SESSION)
    const submit = blockOf(s, 'const submitSqlParams = values => {')
    assert.match(submit, /memo\[n\] = \{ value: values\[n\] === null \? '' : String\(values\[n\]\), isNull: values\[n\] === null \}/,
      'memo 里不能留原始值对象')
    assert.match(s, /const paramMemoRef = useRef\(\{\}\)/, 'memo 只活在当前 tab 内存')
    assert.ok(!/localStorage[\s\S]{0,80}paramMemo/.test(s), '参数值不落盘')
  })

  test('历史永远存用户原文，参数值不进历史', () => {
    const s = read(SESSION)
    const runs = [...s.matchAll(/appendSqlHistory\(\{\s*\n\s*sql: historySql \|\| sql,/g)]
    assert.equal(runs.length, 2, '成功/失败两条历史都要走原文')
    assert.ok(!/appendSqlHistory\(\{[\s\S]{0,200}params/.test(s), '历史条目里不该有 params 字段')
    assert.match(s, /const runSqlNow = async \(sql, params, historySql\)/, '执行入口要显式区分执行文本与原文')
  })
})

describe('H6a 参数化：面板组件', () => {
  test('初值只在"打开"这一下灌入', () => {
    const m = read(MODAL)
    assert.match(m, /\}, \[open\]\)/, '灌初值只依赖 open，不依赖 names/initial')
    assert.match(m, /if \(!open\) \{\s*\n\s*return\s*\n\s*\}/, '关闭状态不重置表单')
    assert.match(m, /seed && typeof seed\.value === 'string' \? seed\.value : ''/, '初值缺省是空串')
  })

  test('NULL 勾选即禁用输入框，提交时输出真正的 null', () => {
    const m = read(MODAL)
    assert.match(m, /disabled=\{!!\(rows\[n\] && rows\[n\]\.isNull\)\}/, 'NULL 时输入框要禁用')
    assert.match(m, /out\[n\] = r\.isNull \? null : r\.value/, 'NULL 要输出 null，不是空串')
    assert.match(m, /onPressEnter=\{submit\}/, '回车即提交')
  })

  test('面板不碰 IPC，也不碰转义', () => {
    const m = read(MODAL)
    assert.ok(!/runGlobalAsync|dbClientOp/.test(m), '执行归父组件')
    assert.ok(!/escape|replace\(/i.test(m), '面板不做任何拼接/转义')
  })
})

describe('H6a 参数化：入口与样式', () => {
  test('工具条开关有 isRedis 守卫，弹层同样不挂 Redis', () => {
    const s = read(SESSION)
    assert.match(s, /title=\{e\('dbSqlParamsHintShort'\)\}/, '开关要有说明')
    assert.match(s, /onClick=\{\(\) => setSqlParamMode\(v => !v\)\}/, '开关要能切换')
    const mounts = [...s.matchAll(/<DbSqlParamsModal/g)]
    assert.equal(mounts.length, 1, '弹层只挂一次')
    const at = s.lastIndexOf('<DbSqlParamsModal')
    const before = s.slice(Math.max(0, at - 900), at)
    assert.match(before, /!isRedis\s*\n?\s*\?/, '弹层要有 isRedis 守卫')
  })

  test('样式走 token，参数名与值用数据面字体链', () => {
    const styl = read(STYL)
    const at = styl.indexOf('.db-params\n')
    assert.notEqual(at, -1, '参数面板样式块缺失')
    const b = styl.slice(at, styl.indexOf('.db-ddl-pre', at))
    assert.match(b, /\.db-params-row\n\s+display flex/, '一行一个参数')
    assert.match(b, /font-family var\(--db-code-font, var\(--font-mono\)\)/, '参数名/值走数据面字体链')
    assert.match(b, /color var\(--text-muted\)/, '提示文案用弱化色')
    assert.match(b, /text-overflow ellipsis/, '长参数名要截断')
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(b), '样式块里不该出现写死的十六进制颜色')
  })

  test('dbSqlParams* 词条中英齐全且键集合一致', () => {
    const src = read(MODAL) + read(SESSION)
    const keys = [...new Set([...src.matchAll(/e\('(dbSqlParams[A-Za-z]*)'\)/g)].map(m => m[1]))]
    assert.ok(keys.length >= 6, `dbSqlParams* 词条应有 6+ 个，实际 ${keys.length} 个`)
    const extra = require(LOCALES)
    for (const k of keys) {
      assert.equal(typeof extra.en[k], 'string', `${k} 缺英文词条`)
      assert.equal(typeof extra.zh_cn[k], 'string', `${k} 缺中文词条`)
    }
    const pick = obj => Object.keys(obj).filter(k => /^dbSqlParams/.test(k)).sort()
    assert.deepEqual(pick(extra.zh_cn), pick(extra.en))
  })
})
