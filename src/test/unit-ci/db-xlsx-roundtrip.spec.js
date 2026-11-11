/**
 * xlsx 导出/导入往返与护栏单测（N4b）
 *
 * 判据钉在这里：
 * 1. 格式坑 —— xlsx 尾部空单元格不落盘（解析 [null,2,null] 回来是 [null,2]），
 *    xlsxSheetRows 必须按表头长度把尾部补回 null；这是格式特性不是库 bug，
 *    用 node-xlsx 真实 build → 落盘 → parse 的往返钉住，不 mock。
 * 2. 类型保持 —— number/boolean/中文/长字符串/`__bin` 截断标记文本往返逐值相等。
 * 3. 护栏 —— 大小与单元格数两道护栏是纯函数（assertXlsxSize / assertXlsxCells），
 *    直接测消息内容；parseXlsxSheets 内部调用它们（超限文件这里不构造，
 *    纯函数即护栏契约）。
 * 4. 注册一致 —— 'xlsx' 在导入注册表与导出 FORMATS 双侧在册，
 *    dialogFilters 的"全部支持"名字从注册表动态拼（含 XLSX）。
 *
 * 加载方式：主进程 CJS 直接 require 真实源码（electron / electron-log 桩，
 * 同 db-import-jsonl.spec.js）。
 */
process.env.NODE_ENV = 'development'

const { describe, test, before } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const electronStub = { app: { getPath: () => '/tmp', isPackaged: false }, dialog: {} }
const electronLogStub = {
  transports: { console: {}, file: {} },
  info: () => {},
  error: () => {},
  warn: () => {},
  log: () => {},
  debug: () => {}
}
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return electronStub
  }
  if (request === 'electron-log') {
    return electronLogStub
  }
  return originalLoad.call(this, request, parent, isMain)
}

const xlsx = require('node-xlsx')
const P = require('../../app/lib/db-import/parsers')
const {
  IMPORT_FORMAT_IDS,
  dialogFilters,
  resolveFormat,
  XLSX_MAX_BYTES,
  XLSX_MAX_CELLS,
  assertXlsxSize,
  assertXlsxCells,
  parseXlsxSheets,
  xlsxSheetRows,
  xlsxIsEmptyRow,
  previewXlsx
} = P
const exporter = require('../../app/lib/db-exporter')

// 临时目录：每个用例独立文件，结束时统一清理
let tmpDir = ''
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-xlsx-'))
})

const writeWorkbook = (sheets, name) => {
  const p = path.join(tmpDir, name || 'wb.xlsx')
  fs.writeFileSync(p, xlsx.build(sheets, { writeOptions: { compression: true } }))
  return p
}

describe('xlsx 往返：build → parseXlsxSheets → xlsxSheetRows', () => {
  test('尾部空单元格不落盘是格式特性：解析回来长度变短，补 null 后与表头对齐', () => {
    const p = writeWorkbook([{
      name: 'T',
      data: [['a', 'b', 'c'], [null, 2, null], [1, 2, 3]]
    }])
    const sheets = parseXlsxSheets(p)
    assert.equal(sheets.length, 1)
    assert.equal(sheets[0].name, 'T')
    // 格式坑的直接证据：第二行解析回来只有 2 个单元格（尾部 null 没落盘）
    assert.equal(sheets[0].data[1].length, 2)
    const rows = xlsxSheetRows(sheets[0])
    // 补齐后每行长度都与表头一致，缺失的尾部是 null（不是 undefined）
    rows.forEach((r, i) => {
      assert.equal(r.length, 3, `第 ${i + 1} 行长度`)
    })
    assert.deepEqual(rows[1], [null, 2, null])
    assert.deepEqual(rows[2], [1, 2, 3])
  })

  test('行内 undefined 补 null；非数组行按整行 null 处理', () => {
    const rows = xlsxSheetRows({
      data: [['h1', 'h2'], ['x', undefined], []]
    })
    assert.deepEqual(rows[1], ['x', null])
    assert.deepEqual(rows[2], [null, null])
  })

  test('行短于表头时 pad、行长于表头时截断（列宽只由表头定义）', () => {
    // 长出的列没有映射依据（映射按表头下标取值），截断不是丢数据；
    // 截断行为由本用例钉住，防止将来有人改成"保留长行"造成参差列
    const rows = xlsxSheetRows({
      data: [['h1', 'h2', 'h3'], ['x'], ['a', 'b', 'c', 'd', 'e']]
    })
    assert.deepEqual(rows[1], ['x', null, null], '短行补到表头长度')
    assert.deepEqual(rows[2], ['a', 'b', 'c'], '长行截到表头长度')
  })

  test('类型保持：number/boolean/中文/日期串/超长字符串往返逐值相等', () => {
    const longStr = 'x'.repeat(5000) + '中文√√'
    const p = writeWorkbook([{
      name: 'T',
      data: [
        ['n', 'b', 's', 'd', 'long'],
        [1.5, true, '张三', '2024-01-15', longStr],
        [0, false, '', '2024-12-31', ''],
        [-7, true, 'emoji✓', null, null]
      ]
    }])
    const rows = xlsxSheetRows(parseXlsxSheets(p)[0])
    assert.equal(rows[1][0], 1.5)
    assert.equal(rows[1][1], true)
    assert.equal(rows[1][2], '张三')
    assert.equal(rows[1][3], '2024-01-15')
    assert.equal(rows[1][4], longStr)
    assert.equal(rows[2][0], 0)
    assert.equal(rows[2][1], false)
    assert.equal(rows[2][2], '')
    assert.equal(rows[3][3], null)
  })

  test('真实日期单元格（cellDates）：date-only → YYYY-MM-DD，带时刻 → YYYY-MM-DD HH:mm:ss', () => {
    // node-xlsx build 写 Date 值会带日期格式（numFmtId=14），parse 侧必须开
    // cellDates 才还原成 Date（缺省是 Excel 序列号裸数字 45306.33 —— QA 实测的坑）
    const p = writeWorkbook([{
      name: 'T',
      data: [
        ['d', 'dt'],
        [new Date(Date.UTC(2024, 0, 15)), new Date(Date.UTC(2024, 0, 15, 8, 30, 5))]
      ]
    }])
    const raw = parseXlsxSheets(p)[0].data[1]
    // 双重确认：进来的是 Date 不是序列号（护栏回归，防止有人删掉 cellDates: true）
    assert.ok(raw[0] instanceof Date, 'date-only 单元格应还原为 Date')
    const rows = xlsxSheetRows(parseXlsxSheets(p)[0])
    assert.equal(rows[1][0], '2024-01-15', '纯日期折成 YYYY-MM-DD')
    assert.equal(rows[1][1], '2024-01-15 08:30:05', '带时刻折成 YYYY-MM-DD HH:mm:ss')
    // 序列号浮点漂移（.999s）就近取整到秒，不得差 1 秒
  })

  test('日期字符串单元格不受 cellDates 影响（文本就是文本）', () => {
    const p = writeWorkbook([{ name: 'T', data: [['s'], ['2024-01-15']] }])
    const rows = xlsxSheetRows(parseXlsxSheets(p)[0])
    assert.equal(rows[1][0], '2024-01-15')
    assert.equal(typeof rows[1][0], 'string')
  })

  test('__bin 截断标记文本往返不变（导出侧写成显式字符串，导入侧原样收下）', () => {
    const marker = '<binary 9 bytes, truncated>'
    const p = writeWorkbook([{
      name: 'T',
      data: [['blob'], [marker]]
    }])
    const rows = xlsxSheetRows(parseXlsxSheets(p)[0])
    assert.equal(rows[1][0], marker)
  })

  test('空行（全 null）解析回来仍可被 xlsxIsEmptyRow 命中；中间空行保留', () => {
    const p = writeWorkbook([{
      name: 'T',
      data: [['a', 'b'], ['x', 'y'], [null, null], ['z', null]]
    }])
    const rows = xlsxSheetRows(parseXlsxSheets(p)[0])
    assert.equal(rows.length, 4, '解析层不丢行')
    assert.equal(xlsxIsEmptyRow(rows[2]), true, '全 null 行判空')
    assert.equal(xlsxIsEmptyRow(rows[3]), false, '有数据的行不判空')
    // 执行层喂入前用 xlsxIsEmptyRow 过滤（takeRows 的"单个空字段"判定对补 null 的行永远不成立）
    const fed = rows.filter(r => !xlsxIsEmptyRow(r))
    assert.deepEqual(fed.map(r => r[0]), ['a', 'x', 'z'])
  })

  test('多 sheet：名字与顺序都保留', () => {
    const p = writeWorkbook([
      { name: 'first', data: [['a'], [1]] },
      { name: 'second', data: [['b'], [2]] }
    ])
    const sheets = parseXlsxSheets(p)
    assert.deepEqual(sheets.map(s => s.name), ['first', 'second'])
    assert.deepEqual(xlsxSheetRows(sheets[1])[1], [2])
  })

  test('data 为 []（无行）与 [[]]（一行空表头）都不炸', () => {
    assert.deepEqual(xlsxSheetRows({ data: [] }), [], '无行 → 空数组')
    assert.deepEqual(xlsxSheetRows({ data: [[]] }), [[]], '一行空表头 → 原样保留（列宽 0）')
  })
})

describe('previewXlsx：预览', () => {
  const sheets = [
    { name: 'S1', data: [['name', 'age'], ['张三', 20], ['李四', 30], ['王五', 40]] },
    { name: 'S2', data: [['k'], ['v']] }
  ]
  let p = ''
  before(() => {
    p = writeWorkbook(sheets, 'preview.xlsx')
  })

  test('默认选中第一个 sheet，返回 sheets 清单与数据行数', () => {
    const r = previewXlsx(p)
    assert.equal(r.format, 'xlsx')
    assert.deepEqual(r.sheets, ['S1', 'S2'])
    assert.equal(r.sheetName, 'S1')
    assert.deepEqual(r.columns, ['name', 'age'])
    assert.equal(r.totalRows, 3)
  })

  test('opts.sheetName 按名精确选中', () => {
    const r = previewXlsx(p, { sheetName: 'S2' })
    assert.equal(r.sheetName, 'S2')
    assert.deepEqual(r.columns, ['k'])
    assert.deepEqual(r.sampleRows, [['v']])
    assert.equal(r.totalRows, 1)
  })

  test('sheetName 匹配不到回落第一个（与执行层选中逻辑一致）', () => {
    const r = previewXlsx(p, { sheetName: 'nope' })
    assert.equal(r.sheetName, 'S1')
  })

  test('样例是展示文本：null/undefined → 空串，其余 String(v)；maxRows 截断', () => {
    const r = previewXlsx(p, { maxRows: 1 })
    assert.deepEqual(r.sampleRows, [['张三', '20']])
  })

  test('尾部缺失单元格在预览里也是空串（补 null 的下游效果）', () => {
    const p2 = writeWorkbook([{ name: 'T', data: [['a', 'b'], [1, null]] }])
    const r = previewXlsx(p2)
    assert.deepEqual(r.sampleRows, [['1', '']])
  })

  test('真实日期单元格在预览里也是折算后的字符串（与执行层同一折算点）', () => {
    const p2 = writeWorkbook([{ name: 'T', data: [['d'], [new Date(Date.UTC(2024, 0, 15))]] }])
    const r = previewXlsx(p2)
    assert.deepEqual(r.sampleRows, [['2024-01-15']])
  })

  test('一行空表头（[[]]）：columns/sampleRows/totalRows 全空，映射步骤被 UI 拦下', () => {
    const p2 = writeWorkbook([{ name: 'T', data: [[]] }])
    const r = previewXlsx(p2)
    assert.deepEqual(r.columns, [])
    assert.deepEqual(r.sampleRows, [])
    assert.equal(r.totalRows, 0)
  })
})

describe('xlsxSheetName：Excel 工作表名约束', () => {
  test('非法字符 []:*?/\\ 清洗为下划线', () => {
    assert.equal(exporter.xlsxSheetName('a[b]c:d*e?f/g\\h'), 'a_b_c_d_e_f_g_h')
  })

  test('超过 31 字符截断', () => {
    const s = exporter.xlsxSheetName('x'.repeat(40))
    assert.equal(s.length, 31)
    assert.equal(s, 'x'.repeat(31))
  })

  test('空表名回落 Sheet1（非法字符清洗后仍非空则保留清洗结果）', () => {
    assert.equal(exporter.xlsxSheetName(''), 'Sheet1')
    assert.equal(exporter.xlsxSheetName(null), 'Sheet1')
    assert.equal(exporter.xlsxSheetName(0), 'Sheet1')
    assert.equal(exporter.xlsxSheetName('/'), '_', '单个非法字符清洗为下划线，不算空')
  })

  test('合法表名原样保留', () => {
    assert.equal(exporter.xlsxSheetName('db-user_list 2024'), 'db-user_list 2024')
  })
})

describe('xlsxCell：单元格值折算', () => {
  const env = (truncated) => ({
    __bin: { size: 9, b64: 'YWJj', truncated }
  })

  test('null / undefined → null', () => {
    assert.equal(exporter.xlsxCell(null), null)
    assert.equal(exporter.xlsxCell(undefined), null)
  })

  test('number 原样；NaN/Infinity → 字符串（xlsx 无这两种数值）', () => {
    assert.equal(exporter.xlsxCell(1.5), 1.5)
    assert.equal(exporter.xlsxCell(0), 0)
    assert.equal(exporter.xlsxCell(NaN), 'NaN')
    assert.equal(exporter.xlsxCell(Infinity), 'Infinity')
  })

  test('boolean 原样；bigint → 字符串（xlsx 数值是 double，防精度丢失）', () => {
    assert.equal(exporter.xlsxCell(true), true)
    assert.equal(exporter.xlsxCell(false), false)
    assert.equal(exporter.xlsxCell(9007199254740993n), '9007199254740993')
  })

  test('Date 保留对象（输入直通；xlsx 层面由 build/parse 往返验证）', () => {
    const d = new Date(Date.UTC(2024, 0, 15, 8, 30, 5))
    assert.equal(exporter.xlsxCell(d), d)
    // 强往返：xlsxCell 的产物喂给 node-xlsx build，再经 parseXlsxSheets
    // （cellDates:true）读回 Date —— 验证 Date 输入在 xlsx 链路上是可逆的，
    // 而不是"=== d"这类恒真断言。序列号是浮点秒，读回可能有毫秒漂移，
    // 按秒级分量断言
    const p = writeWorkbook([{ name: 'T', data: [['d'], [exporter.xlsxCell(d)]] }])
    const back = parseXlsxSheets(p)[0].data[1][0]
    assert.ok(back instanceof Date, '读回应为 Date（cellDates 生效）')
    assert.equal(Math.round(back.getTime() / 1000) * 1000, d.getTime(), '秒级时间分量一致')
  })

  test('信封 → binCell 文本：完整给 base64，截断给显式标记', () => {
    assert.equal(exporter.xlsxCell(env(false)), 'YWJj')
    assert.equal(exporter.xlsxCell(env(true)), '<binary 9 bytes, truncated>')
  })

  test('其余 → String(v)', () => {
    assert.equal(exporter.xlsxCell('x'), 'x')
    assert.equal(exporter.xlsxCell(['a']), 'a')
  })
})

describe('护栏：大小与单元格数（纯函数契约）', () => {
  test('常量口径：32MB / 2000 万单元格', () => {
    assert.equal(XLSX_MAX_BYTES, 32 * 1024 * 1024)
    assert.equal(XLSX_MAX_CELLS, 20 * 1000 * 1000)
  })

  test('assertXlsxSize：≤上限通过，超限抛出上限与当前值', () => {
    assertXlsxSize(0)
    assertXlsxSize(XLSX_MAX_BYTES)
    assert.throws(() => assertXlsxSize(XLSX_MAX_BYTES + 1), e => {
      assert.match(e.message, /32MB/)
      assert.match(e.message, /CSV/)
      return true
    })
  })

  test('assertXlsxCells：≤上限通过，超限提示改用 CSV', () => {
    assertXlsxCells(0)
    assertXlsxCells(XLSX_MAX_CELLS)
    assert.throws(() => assertXlsxCells(XLSX_MAX_CELLS + 1), /改用 CSV/)
  })

  test('parseXlsxSheets：文件不存在报错透传（statSync 的原始语义）', () => {
    assert.throws(() => parseXlsxSheets(path.join(tmpDir, 'no-such-file.xlsx')))
  })
})

describe('注册一致性：xlsx 双侧在册', () => {
  test('导入注册表含 xlsx（array 行、rows 通道）', () => {
    assert.ok(IMPORT_FORMAT_IDS.includes('xlsx'))
    assert.equal(resolveFormat('a.xlsx').id, 'xlsx')
    assert.equal(resolveFormat('a.xlsx').rowShape, 'array')
    assert.equal(resolveFormat('a.xlsx').kind, 'rows')
    assert.equal(resolveFormat('A.XLSX').id, 'xlsx')
  })

  test('导出 FORMATS 含 xlsx，且导入注册表同一格式集合（csv/tsv/jsonl/xlsx/sql）', () => {
    assert.ok(exporter.FORMATS.includes('xlsx'))
    assert.ok(exporter.FORMATS.includes('csv'))
    for (const id of ['csv', 'tsv', 'jsonl', 'xlsx']) {
      assert.ok(IMPORT_FORMAT_IDS.includes(id), `导入注册表应有 ${id}`)
    }
    // 导出独有：json/markdown（不是导入源）；导入独有：sql（走脚本通道）
    assert.ok(!IMPORT_FORMAT_IDS.includes('json'))
    assert.ok(!IMPORT_FORMAT_IDS.includes('markdown'))
  })

  test('dialogFilters 动态拼名：xlsx 在列，硬编码字符串不复存在', () => {
    const f = dialogFilters()
    assert.equal(f[0].name, 'CSV/TSV/JSONL/XLSX/SQL')
    assert.ok(f[0].extensions.includes('xlsx'))
    assert.deepEqual(f.map(x => x.name),
      ['CSV/TSV/JSONL/XLSX/SQL', 'CSV', 'TSV', 'JSONL', 'XLSX', 'SQL'])
  })
})
