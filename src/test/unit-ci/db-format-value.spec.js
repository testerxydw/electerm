// E2-3b 单元格值展示层格式化（设计 §7.5「数值/日期 locale 格式化」）
//
// 测的是 src/client/common/db-format-value.js 的同一份源码（vm + strip export），
// 不许出现"测试拷贝实现"。
//
// 重点不在"能格式化"，而在三件容易悄悄坏掉的事：
// 1) 默认关（mode !== 'os' 一律原样）—— 关掉时行为必须与改造前逐字节一致；
// 2) 日期不猜 —— 长得像日期的普通字符串不得被改样子；
// 3) 纯日期不跨时区漂移 —— '2024-01-05' 在负偏移时区不能显示成 01-04。
//
// 判据一律只比"数字序列"，不写死分隔符：分组符/小数点由 locale 决定（de 是 1.234,5、
// en-IN 是 1,23,456），写死逗号等于把测试绑在跑它的那台机器的区域设置上。
const { describe, test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { execFileSync } = require('node:child_process')

const digits = s => String(s).replace(/[^0-9]/g, '')
// 分组生效 = 数字序列没变 + 确实多了非数字字符。符号留给 locale，判据不碰它。
const grouped = (text, wantDigits) => {
  assert.equal(digits(text), wantDigits, '数字序列不能变: ' + text)
  assert.notEqual(text, wantDigits, '要出现分组符: ' + text)
}

const ROOT = path.join(__dirname, '../../..')
const MOD = path.join(ROOT, 'src/client/common/db-format-value.js')

const EXPORTS = '({ FORMAT_LOCALE_KEY, readFormatLocale, isDateType, isNumberType, formatCellValue })'

function loadMod () {
  const src = fs.readFileSync(MOD, 'utf8').replace(/^export /gm, '')
  const sandbox = {
    Intl,
    Number,
    Date,
    String,
    console,
    module: { exports: {} }
  }
  sandbox.module.exports = {}
  sandbox.exports = sandbox.module.exports
  vm.createContext(sandbox)
  vm.runInContext(src + '\n;module.exports = ' + EXPORTS, sandbox, { filename: 'db-format-value.js' })
  return sandbox.module.exports
}

/**
 * 在指定时区里跑一次格式化（子进程）。
 * 时区是进程级、Intl 首用即定的东西：不另开进程就没法在同一份断言里同时覆盖
 * UTC+8 与负偏移 —— 而"纯日期少一天"只在负偏移里现形，本机测不到。
 * @param {string} tz IANA 时区名
 * @param {string} value 单元格值
 * @param {string} dataType 列类型
 * @returns {string} 展示文本
 */
function formatInTz (tz, value, dataType) {
  const script = `
    const fs = require('node:fs'), vm = require('node:vm')
    const src = fs.readFileSync(${JSON.stringify(MOD)}, 'utf8').replace(/^export /gm, '')
    const sandbox = { Intl, Number, Date, String, console, module: { exports: {} } }
    sandbox.module.exports = {}; sandbox.exports = sandbox.module.exports
    vm.createContext(sandbox)
    vm.runInContext(src + '\\n;module.exports = ({ formatCellValue })', sandbox)
    process.stdout.write(sandbox.module.exports.formatCellValue(${JSON.stringify(value)}, ${JSON.stringify(dataType)}, 'os'))
  `
  return execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TZ: tz }
  })
}

// 只比"这一串里出现了哪几个数字段"，不比顺序与分隔符：2-digit 月日 + numeric 年
// 在任何 locale 下都是这三段，顺序才是 locale 的事。
const groups = s => String(s).match(/\d+/g).sort().join('|')

describe('db-format-value: 默认关闭时行为与原样一致', () => {
  let m
  beforeEach(() => { m = loadMod() })

  test("mode 不是 'os' 时一律 String(value)，一个字符都不改", () => {
    const cases = [1234, 0, -5, '1234', 'abc', true, false, '2024-01-05', '2024-01-05 10:30:00']
    for (const v of cases) {
      assert.equal(m.formatCellValue(v, 'int', 'none'), String(v))
      assert.equal(m.formatCellValue(v, 'int', undefined), String(v))
      assert.equal(m.formatCellValue(v, 'int', 'OS'), String(v), '大小写不放开：只认严格 os')
      assert.equal(m.formatCellValue(v, 'int', ''), String(v))
    }
  })

  test('类型未知时：number 照格式（驱动已定型），字符串不猜', () => {
    // 驱动返回 JS number 本身就说明该列是数值型 —— 这不是猜；
    // 猜语义指的是"字符串长得像数字/日期"的那种。
    grouped(m.formatCellValue(1234, '', 'os'), '1234')
    // 字符串 "00123" 在类型未知时必须原样 —— 千分位会把前导零问题掩盖掉
    assert.equal(m.formatCellValue('00123', '', 'os'), '00123')
    assert.equal(m.formatCellValue('2024-01-05', '', 'os'), '2024-01-05', '纯字符串不按日期解释')
  })
})

describe('db-format-value: 数值', () => {
  let m
  beforeEach(() => { m = loadMod() })

  test('number 类型 + os → 分组', () => {
    grouped(m.formatCellValue(1234567, 'int', 'os'), '1234567')
    assert.equal(digits(m.formatCellValue(-42, 'bigint', 'os')), '42')
    assert.equal(digits(m.formatCellValue(3.5, 'decimal', 'os')), '35')
  })

  test('非有限数原样（Infinity/NaN 不该被格式化成 "∞"/"NaN" 之外的东西）', () => {
    assert.equal(m.formatCellValue(Infinity, 'int', 'os'), String(Infinity))
    assert.equal(m.formatCellValue(NaN, 'float', 'os'), String(NaN))
  })

  test('数值列里的数字字符串才格式化；非数字串原样', () => {
    grouped(m.formatCellValue('1234', 'int', 'os'), '1234')
    assert.equal(m.formatCellValue('abc', 'int', 'os'), 'abc')
    assert.equal(m.formatCellValue('', 'int', 'os'), '')
    assert.equal(m.formatCellValue('  ', 'int', 'os'), '  ', '纯空白不是数字，原样')
  })

  test('isNumberType 覆盖两端常见类型，且大小写不敏感', () => {
    for (const t of ['int', 'INT', 'bigint', 'decimal', 'numeric', 'float', 'double', 'money', 'year', 'serial']) {
      assert.equal(m.isNumberType(t), true, t)
    }
    for (const t of ['varchar', 'text', 'date', 'json', 'bool', '']) {
      assert.equal(m.isNumberType(t), false, t)
    }
  })
})

// H1a-3 实测（SQL 结果右对齐 + 本地化开关打开）暴露出来的缺陷：`Intl.NumberFormat()` 默认
// 最大 3 位小数，且 format() 会把入参过一遍 Number。这两件事叠在一起，"打开本地化"就等于
// 让网格里显示的 BIGINT 主键、DECIMAL 金额变成另一个数。
describe('db-format-value: 分组不得动精度（H1a-3 实测发现）', () => {
  let m
  beforeEach(() => { m = loadMod() })

  test('19 位 BIGINT 主键不得被 Number 四舍五入到最近的偶数', () => {
    const raw = '9007199254740993'
    const out = m.formatCellValue(raw, 'bigint', 'os')
    assert.equal(digits(out), raw, '逐位保留: ' + out)
    assert.notEqual(digits(out), digits(String(Number(raw))), 'Number 会把它变成 ...992')
  })

  test('超过 Number 安全整数范围的位数原样保留', () => {
    const raw = '99999999999999999999'
    assert.equal(digits(m.formatCellValue(raw, 'bigint', 'os')), raw)
  })

  test('DECIMAL 的有效位（含小数尾零）逐位保留', () => {
    assert.equal(digits(m.formatCellValue('1234567.8901', 'decimal', 'os')), '12345678901')
    assert.equal(digits(m.formatCellValue('0.10', 'decimal', 'os')), '010', '尾零是 DECIMAL 的 scale，不能被吃掉')
    assert.equal(digits(m.formatCellValue('-0.75', 'numeric', 'os')), '075')
  })

  test('驱动直接给 JS number 时不再截到 3 位小数', () => {
    for (const v of [0.123456, 1234567.8901, 3.14159265]) {
      assert.equal(digits(m.formatCellValue(v, 'double', 'os')), digits(String(v)), String(v))
    }
  })

  test('分组仍然生效（精度修了别把千分位一起修没）', () => {
    grouped(m.formatCellValue('1234567', 'bigint', 'os'), '1234567')
  })

  test('非普通十进制形态回落 Number 分组', () => {
    for (const v of ['1e5', '.5', ' 42 ', '+1000', '1E+3']) {
      assert.equal(digits(m.formatCellValue(v, 'double', 'os')), digits(String(Number(v))), v)
    }
  })

  test('极小值不能被显示成 0：宁可原样', () => {
    const out = m.formatCellValue(1e-25, 'double', 'os')
    assert.notEqual(digits(out), '0', '非零值显示成 0 比不打千分位更糟')
    assert.equal(out, String(1e-25))
  })

  test('前导零归一是既有行为（数值列按数字看）', () => {
    assert.equal(m.formatCellValue('007', 'year', 'os'), '7')
  })

  test('非数字串、空串、纯空白仍然一律原样', () => {
    for (const v of ['abc', '', '  ', '12a34', 'NaN', 'Infinity', '1,234']) {
      assert.equal(m.formatCellValue(v, 'decimal', 'os'), v, JSON.stringify(v))
    }
  })

  test('关掉本地化时逐字节不变（精度修差不影响这条契约）', () => {
    for (const v of ['9007199254740993', '0.10', 0.123456, 1e-25, '1234567.8901']) {
      assert.equal(m.formatCellValue(v, 'decimal', 'none'), String(v))
    }
  })
})

describe('db-format-value: 日期', () => {
  let m
  beforeEach(() => { m = loadMod() })

  test('isDateType 覆盖两端，含 PG 全称', () => {
    for (const t of ['date', 'datetime', 'timestamp', 'timestamptz', 'timestamp with time zone', 'DATETIME']) {
      assert.equal(m.isDateType(t), true, t)
    }
    for (const t of ['varchar', 'int', 'json', '']) {
      assert.equal(m.isDateType(t), false, t)
    }
  })

  test('纯日期按 UTC 取日期部分，不因本地时区漂移', () => {
    // 关键：'2024-01-05' 若被 new Date() 直接解析会得到 UTC 午夜，
    // 在负偏移时区里 toLocaleString 会变成 01-04。这里必须显示 01-05。
    const out = m.formatCellValue('2024-01-05', 'date', 'os')
    assert.ok(/2024/.test(out) && /01/.test(out) && /05/.test(out), '纯日期必须原样落到 01-05: ' + out)
    assert.ok(!/04/.test(out), '不得因时区少一天: ' + out)
  })

  test('纯日期在负偏移时区不得少一天（子进程钉 TZ 才真跑到那条分支）', () => {
    // 本机 UTC+8：UTC 午夜与本地午夜同一天，这条判据在进程内永远是绿的 ——
    // 少一天只在负偏移里现形，所以必须另开进程把时区钉住。
    for (const tz of ['America/New_York', 'Pacific/Midway', 'Etc/GMT+11']) {
      assert.equal(groups(formatInTz(tz, '2024-01-05', 'date')), '01|05|2024', tz)
    }
    assert.equal(groups(formatInTz('Asia/Shanghai', '2024-01-05', 'date')), '01|05|2024')
  })

  test('无时区的 datetime 在负偏移时区既不漂移时刻也不跨天', () => {
    const out = formatInTz('Pacific/Midway', '2024-01-05 10:30:00', 'datetime')
    const g = groups(out).split('|')
    assert.ok(g.includes('2024') && g.includes('05'), '日期不得少一天: ' + out)
    assert.ok(/10/.test(out) && /30/.test(out), '时刻必须还是 10:30: ' + out)
  })

  test('无时区的 datetime 按本地解释，不漂移', () => {
    const out = m.formatCellValue('2024-01-05 10:30:00', 'datetime', 'os')
    assert.ok(/2024/.test(out), out)
    assert.ok(!/2023|2025/.test(out), '不得跨年: ' + out)
  })

  test('带时区的串与 Date 对象都能格式化', () => {
    const a = m.formatCellValue('2024-01-05T10:30:00Z', 'timestamptz', 'os')
    assert.ok(/2024/.test(a), a)
    const b = m.formatCellValue(new Date(2024, 0, 5, 10, 30, 0), 'timestamptz', 'os')
    assert.ok(/2024/.test(b), b)
  })

  test('不可解析的日期串原样返回，不抛', () => {
    assert.equal(m.formatCellValue('not-a-date', 'date', 'os'), 'not-a-date')
    assert.equal(m.formatCellValue('2024-13-45', 'date', 'os'), '2024-13-45')
  })

  test('time 类型按时刻格式化，不套日期', () => {
    const out = m.formatCellValue('10:30:00', 'time', 'os')
    assert.ok(/10/.test(out) && /30/.test(out), out)
    assert.ok(!/1970|01\/01/.test(out), '不得出现日期部分: ' + out)
    assert.equal(m.formatCellValue('garbage', 'time', 'os'), 'garbage')
  })

  test('长得像日期的普通字符串不得被改样子', () => {
    for (const t of ['varchar', 'text', 'char', '']) {
      assert.equal(m.formatCellValue('2024-01-05', t, 'os'), '2024-01-05', t)
      assert.equal(m.formatCellValue('2024-01-05 10:30:00', t, 'os'), '2024-01-05 10:30:00', t)
    }
  })
})

describe('db-format-value: 配置读取', () => {
  let m
  beforeEach(() => { m = loadMod() })

  test('只认严格 os，其余回落 none（配置文件可手改）', () => {
    // key 名与读取逻辑相邻：store 词条/sync 白名单改坏了这里会红
    assert.equal(m.FORMAT_LOCALE_KEY, 'dbFormatLocale')
    assert.equal(m.readFormatLocale({ dbFormatLocale: 'os' }), 'os')
    assert.equal(m.readFormatLocale({ [m.FORMAT_LOCALE_KEY]: 'os' }), 'os')
    assert.equal(m.readFormatLocale({ dbFormatLocale: 'none' }), 'none')
    assert.equal(m.readFormatLocale({}), 'none')
    assert.equal(m.readFormatLocale(null), 'none')
    assert.equal(m.readFormatLocale({ dbFormatLocale: 'OS' }), 'none')
    assert.equal(m.readFormatLocale({ dbFormatLocale: 1 }), 'none')
  })
})
