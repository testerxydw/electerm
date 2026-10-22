const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const SRC = path.join(ROOT, 'src/client/common/db-csv.js')

// S3-B CSV 导出（doc/设计-数据库阶段3-2026-10-22.md §1）：
// RFC 4180 转义 + BOM 头 + \r\n 行间。vm 跑真实源码（strip ESM export），
// 防测试拷贝与实现漂移。downloadCsv 为 DOM 逻辑不在单测覆盖内。

const loadFns = () => {
  const code = fs.readFileSync(SRC, 'utf8').replace(/^export /gm, '')
  const ctx = {}
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  assert.equal(typeof ctx.csvEscape, 'function', 'csvEscape missing')
  assert.equal(typeof ctx.toCsv, 'function', 'toCsv missing')
  return ctx
}

describe('db-csv csvEscape', () => {
  const { csvEscape } = loadFns()

  test('null/undefined 输出空串', () => {
    assert.equal(csvEscape(null), '')
    assert.equal(csvEscape(undefined), '')
  })

  test('普通值原样输出', () => {
    assert.equal(csvEscape('abc'), 'abc')
    assert.equal(csvEscape(123), '123')
    assert.equal(csvEscape(0), '0')
    assert.equal(csvEscape(true), 'true')
  })

  test('含逗号字段双引号包裹', () => {
    assert.equal(csvEscape('a,b'), '"a,b"')
  })

  test('含引号字段包裹且内部引号翻倍', () => {
    assert.equal(csvEscape('say "hi"'), '"say ""hi"""')
  })

  test('含换行/回车字段包裹', () => {
    assert.equal(csvEscape('a\nb'), '"a\nb"')
    assert.equal(csvEscape('a\rb'), '"a\rb"')
    assert.equal(csvEscape('a\r\nb'), '"a\r\nb"')
  })

  test('普通字符串不额外包裹', () => {
    assert.equal(csvEscape('plain'), 'plain')
  })

  test('bigint/Date 走 String 化不丢精度', () => {
    assert.equal(csvEscape(12345678901234567890n), '12345678901234567890')
    assert.equal(csvEscape(new Date('2026-01-02T03:04:05Z')), String(new Date('2026-01-02T03:04:05Z')))
  })
})

describe('db-csv toCsv', () => {
  const { toCsv } = loadFns()

  test('文件头 BOM + 表头行 + \r\n 行间', () => {
    const csv = toCsv(['a', 'b'], [{ a: 1, b: 2 }])
    assert.ok(csv.startsWith('\uFEFF'), 'missing BOM')
    assert.ok(csv.startsWith('\uFEFFa,b\r\n'), 'header row wrong')
    assert.ok(csv.endsWith('1,2\r\n'), 'data row wrong')
  })

  test('列顺序跟随 headers，行缺列补空', () => {
    const csv = toCsv(['x', 'y'], [{ y: 2 }, { x: 1 }])
    assert.equal(csv, '\uFEFFx,y\r\n,2\r\n1,\r\n')
  })

  test('特殊字符行整体转义正确', () => {
    const csv = toCsv(['c'], [{ c: 'a,"b"\nc' }])
    assert.equal(csv, '\uFEFFc\r\n"a,""b""\nc"\r\n')
  })

  test('空行集只剩表头', () => {
    assert.equal(toCsv(['h'], []), '\uFEFFh\r\n')
  })

  test('rows 非数组容错', () => {
    assert.equal(toCsv(['h'], null), '\uFEFFh\r\n')
  })

  test('Excel 中文兼容：BOM 在最前', () => {
    const csv = toCsv(['名称'], [{ 名称: '值' }])
    assert.equal(csv.charCodeAt(0), 0xFEFF)
    assert.ok(csv.includes('名称\r\n'), 'header row missing')
    assert.ok(csv.includes('值\r\n'), 'data row missing')
  })
})
