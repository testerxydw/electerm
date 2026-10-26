// E2-3b 单元格值展示层格式化（设计 §7.5「数值/日期 locale 格式化」）
//
// 测的是 src/client/common/db-format-value.js 的同一份源码（vm + strip export），
// 不许出现"测试拷贝实现"。
//
// 重点不在"能格式化"，而在三件容易悄悄坏掉的事：
// 1) 默认关（mode !== 'os' 一律原样）—— 关掉时行为必须与改造前逐字节一致；
// 2) 日期不猜 —— 长得像日期的普通字符串不得被改样子；
// 3) 纯日期不跨时区漂移 —— '2024-01-05' 在负偏移时区不能显示成 01-04。
const { describe, test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

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
    assert.equal(m.formatCellValue(1234, '', 'os'), '1,234')
    // 字符串 "00123" 在类型未知时必须原样 —— 千分位会把前导零问题掩盖掉
    assert.equal(m.formatCellValue('00123', '', 'os'), '00123')
    assert.equal(m.formatCellValue('2024-01-05', '', 'os'), '2024-01-05', '纯字符串不按日期解释')
  })
})

describe('db-format-value: 数值', () => {
  let m
  beforeEach(() => { m = loadMod() })

  test('number 类型 + os → 千分位', () => {
    assert.equal(m.formatCellValue(1234567, 'int', 'os'), '1,234,567')
    assert.equal(m.formatCellValue(-42, 'bigint', 'os'), '-42')
    assert.equal(m.formatCellValue(3.5, 'decimal', 'os'), '3.5')
  })

  test('非有限数原样（Infinity/NaN 不该被格式化成 "∞"/"NaN" 之外的东西）', () => {
    assert.equal(m.formatCellValue(Infinity, 'int', 'os'), String(Infinity))
    assert.equal(m.formatCellValue(NaN, 'float', 'os'), String(NaN))
  })

  test('数值列里的数字字符串才格式化；非数字串原样', () => {
    assert.equal(m.formatCellValue('1234', 'int', 'os'), '1,234')
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
