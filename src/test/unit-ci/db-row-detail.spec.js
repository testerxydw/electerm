/**
 * H1 行详情：纯函数 + 接线契约
 *
 * 纯函数跑真代码（db-row-detail-utils.js 与渲染体分开正是为了这个 —— .jsx 在
 * node 里载不进来）；接线部分钉"有没有真接上"：右键菜单项、Modal 挂载、
 * 列序/类型来源、重新执行后的清理、折叠与复制入口、词条。
 */

const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const VIEW = 'src/client/components/database/db-row-detail.jsx'
const SESSION = 'src/client/components/database/db-session.jsx'
const LOCALES = 'src/app/common/locales-extra.js'

const load = () => import('../../client/components/database/db-row-detail-utils.js')

const codeOf = src => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const bin = (b64, size, truncated = false) => ({ __bin: { b64, size, truncated } })

describe('H1 行详情：字段展示文本', () => {
  test('NULL 与空串区分', async () => {
    const { rowDetailText } = await load()
    assert.equal(rowDetailText(null), 'NULL')
    assert.equal(rowDetailText(undefined), 'NULL')
    assert.equal(rowDetailText(''), '')
  })

  test('对象按 2 空格缩进重排（网格里的单行 JSON 读不了）', async () => {
    const { rowDetailText } = await load()
    assert.equal(rowDetailText({ a: 1, b: [1] }), '{\n  "a": 1,\n  "b": [\n    1\n  ]\n}')
  })

  test('序列化失败不抛（循环引用回落 String）', async () => {
    const { rowDetailText } = await load()
    const cyc = { a: 1 }
    cyc.self = cyc
    assert.equal(typeof rowDetailText(cyc), 'string')
  })

  test('二进制只给信封占位符，不做文本化', async () => {
    const { rowDetailText } = await load()
    assert.equal(rowDetailText(bin('AAAA', 4)), '<binary 4 bytes>')
  })

  test('复制口径：二进制复制 base64 原文，其余与展示同源', async () => {
    const { rowDetailCopyText } = await load()
    assert.equal(rowDetailCopyText(bin('QUJD', 3)), 'QUJD')
    assert.equal(rowDetailCopyText('hi'), 'hi')
    assert.equal(rowDetailCopyText({ a: 1 }), '{\n  "a": 1\n}')
  })

  test('折叠判定：字符数或行数任一超限都收', async () => {
    const { isLongRowValue, ROW_DETAIL_INLINE_MAX } = await load()
    assert.equal(ROW_DETAIL_INLINE_MAX, 500)
    assert.equal(isLongRowValue('x'.repeat(500)), false)
    assert.equal(isLongRowValue('x'.repeat(501)), true)
    // 300 字符但 13 行：字符数没超，缩进 JSON 一样占满屏
    assert.equal(isLongRowValue(Array(13).fill('x'.repeat(20)).join('\n')), true)
    assert.equal(isLongRowValue(Array(12).fill('x').join('\n')), false)
    assert.equal(isLongRowValue(null), false)
  })

  test('整行对象只取给定列（__rowKey 不进复制结果）', async () => {
    const { rowDetailObject } = await load()
    assert.deepEqual(
      rowDetailObject(['a', 'b'], { a: 1, b: 2, __rowKey: 7 }),
      { a: 1, b: 2 }
    )
    assert.deepEqual(rowDetailObject([], null), {})
  })
})

describe('H1 行详情：渲染体', () => {
  test('逐字段渲染：字段名 + 类型 + 值 + 复制', () => {
    const src = codeOf(read(VIEW))
    assert.match(src, /export function DbRowDetail \(props\)/)
    assert.match(src, /columns\.map\(k =>/)
    assert.match(src, /types\[String\(k\)\.toLowerCase\(\)\]/)
    assert.match(src, /copy\(rowDetailCopyText\(value\)\)/)
  })

  test('长值折叠：默认只显示前 500 字符，展开/收起切换', () => {
    const src = codeOf(read(VIEW))
    assert.match(src, /text\.slice\(0, ROW_DETAIL_INLINE_MAX\)/)
    assert.match(src, /dbRowDetailExpand/)
    assert.match(src, /dbRowDetailCollapse/)
    // 值变了要收回折叠态，否则上一行的展开状态会带过来
    assert.match(src, /useEffect\(\(\) => \{\n\s*setExpanded\(false\)\n\s*\}, \[text\]\)/)
  })

  test('Modal 宽 720、底部有复制整行与关闭', () => {
    const src = codeOf(read(VIEW))
    assert.match(src, /export function DbRowDetailModal \(props\)/)
    assert.match(src, /width=\{720\}/)
    assert.match(src, /rowDetailObject\(columns, row\)/)
    assert.match(src, /dbRowDetailCopyRow/)
  })

  test('不注入原始 HTML', () => {
    const raw = new RegExp('dangerously' + 'SetInnerHTML')
    assert.equal(raw.test(read(VIEW)), false)
  })
})

describe('H1 行详情：会话接线', () => {
  test('右键菜单追加"查看行详情"，写的是行对象快照', () => {
    const src = codeOf(read(SESSION))
    assert.match(src, /key: 'rowDetail'/)
    assert.match(src, /text: e\('dbCellRowDetail'\)/)
    assert.match(src, /setSqlRowDetail\(\{ rs, row \}\)/)
  })

  test('Modal 已挂载，列序与导出同源、类型表按结果集取', () => {
    const src = codeOf(read(SESSION))
    assert.match(src, /<DbRowDetailModal/)
    assert.match(src, /open=\{!!sqlRowDetail\}/)
    assert.match(src, /sqlExportHeaders\(sqlResult\.results\[sqlRowDetail\.rs\]\)/)
    assert.match(src, /types=\{sqlRowDetail \? \(sqlColTypeMaps\[sqlRowDetail\.rs\]/)
  })

  test('重新执行（新结果到位）收掉行详情', () => {
    const src = codeOf(read(SESSION))
    assert.match(src, /setSqlCellMenu\(null\)\n\s*setSqlRowDetail\(null\)/)
  })

  test('词条：en + zhCn 各六条且都被引用', () => {
    const src = read(LOCALES)
    const keys = [
      'dbCellRowDetail',
      'dbRowDetailTitle',
      'dbRowDetailCopyRow',
      'dbRowDetailExpand',
      'dbRowDetailCollapse'
    ]
    for (const k of keys) {
      const hits = src.split('\n').filter(l => l.trim().startsWith(k + ':'))
      assert.equal(hits.length, 2, k + ' 应 en/zhCn 各一条')
    }
    const used = codeOf(read(VIEW)) + codeOf(read(SESSION))
    for (const k of keys) {
      assert.ok(used.includes("e('" + k + "')"), k + ' 未被引用')
    }
  })
})
