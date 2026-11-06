/**
 * H3a 数据字典导出：纯函数 + 接线契约
 *
 * 纯函数跑真代码（.js 模块，node 可直接 import）；接线部分钉"有没有真接上"：
 * v2 契约在 state 里留全、入口按钮、两种格式的分发与文件名、词条。
 *
 * 时间戳用固定 Date 传入，输出才算得出确定值（buildDataDictionary 不接受
 * 假时钟依赖，只接受 now 参数）。
 */

const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const SESSION = 'src/client/components/database/db-session.jsx'
// N11a 簇 C：loadStructure（setStructureV2 整份 v2 契约）已迁到 use-db-tree.js，
// 契约组合读取已接线的发布源码（白名单不含未接线的渲染面板）。
const USE_DB_TREE = 'src/client/components/database/use-db-tree.js'
const LOCALES = 'src/app/common/locales-extra.js'

const load = () => import('../../client/common/db-dictionary.js')

const codeOf = src => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

// 固定导出时间：2026-10-29 08:07:06（本地时区语义，逐位钉死）
const NOW = new Date(2026, 9, 29, 8, 7, 6)

const STRUCT = {
  type: 'table',
  comment: '订单表',
  estimatedRows: 12345,
  columns: [
    {
      name: 'id',
      dataType: 'bigint',
      columnType: 'bigint unsigned',
      nullable: false,
      defaultValue: null,
      isPrimaryKey: true,
      ordinal: 1,
      comment: '主键'
    },
    {
      name: 'note',
      dataType: 'varchar',
      columnType: 'varchar(255)',
      nullable: true,
      defaultValue: "''",
      isPrimaryKey: false,
      ordinal: 2,
      comment: '备注'
    }
  ],
  indexes: [
    { name: 'PRIMARY', unique: true, primary: true, columns: ['id'], method: 'BTREE' }
  ],
  foreignKeys: [
    {
      name: 'fk_user',
      columns: ['user_id'],
      refSchema: null,
      refTable: 'users',
      refColumns: ['id'],
      onDelete: 'CASCADE',
      onUpdate: 'RESTRICT'
    }
  ]
}

const MYSQL_TABLE = { database: 'shop', schema: '', table: 'orders' }

describe('H3a 数据字典：单元格转义', () => {
  test('Markdown：竖线 / 反斜杠 / 换行都转义，null 留空', async () => {
    const { escapeMdCell } = await load()
    assert.equal(escapeMdCell(null), '')
    assert.equal(escapeMdCell(undefined), '')
    assert.equal(escapeMdCell('a|b'), 'a\\|b')
    assert.equal(escapeMdCell('a\\b'), 'a\\\\b')
    assert.equal(escapeMdCell('a\nb'), 'a<br>b')
    assert.equal(escapeMdCell('a\r\nb'), 'a<br>b')
  })

  test('引用名：MySQL 用库名，PG 用 schema，缺前缀时裸表名', async () => {
    const { qualifyTable } = await load()
    assert.equal(qualifyTable(MYSQL_TABLE, 'mysql'), 'shop.orders')
    assert.equal(qualifyTable({ database: 'app', schema: 'public', table: 'orders' }, 'postgres'), 'public.orders')
    assert.equal(qualifyTable({ table: 'orders' }, 'mysql'), 'orders')
    assert.equal(qualifyTable({ name: 'orders' }, 'mysql'), 'orders')
    assert.equal(qualifyTable(null, 'mysql'), '')
  })
})

describe('H3a 数据字典：Markdown 内容', () => {
  test('表信息 / 列 / 索引 / 外键四节齐全且顺序固定', async () => {
    const { buildDataDictionary } = await load()
    const { markdown } = buildDataDictionary({
      table: MYSQL_TABLE,
      structure: STRUCT,
      dialect: 'mysql',
      now: NOW
    })
    const heads = ['# 数据字典：shop.orders', '## 表信息', '## 列（2）', '## 索引（1）', '## 外键（1）']
    let at = -1
    for (const h of heads) {
      const idx = markdown.indexOf(h)
      assert.ok(idx > at, '小节顺序/标题缺失：' + h)
      at = idx
    }
    assert.match(markdown, /\| 表 \| shop\.orders \|/)
    assert.match(markdown, /\| 类型 \| 表 \|/)
    assert.match(markdown, /\| 注释 \| 订单表 \|/)
    assert.match(markdown, /\| 估算行数 \| 12345 \|/)
    assert.match(markdown, /\| 导出时间 \| 2026-10-29 08:07:06 \|/)
    assert.match(markdown, /\| 1 \| id \| bigint unsigned \| 否 \| {2}\| 是 \| 主键 \|/)
    assert.match(markdown, /\| 2 \| note \| varchar\(255\) \| 是 \| '' \| 否 \| 备注 \|/)
    assert.match(markdown, /\| PRIMARY \| 是 \| 是 \| BTREE \| id \|/)
    assert.match(markdown, /\| fk_user \| user_id \| users\.id \| CASCADE \| RESTRICT \|/)
  })

  test('注释里的竖线与换行不会撑破表格', async () => {
    const { buildDataDictionary } = await load()
    const structure = {
      columns: [{
        name: 'c',
        dataType: 'text',
        nullable: true,
        isPrimaryKey: false,
        comment: 'a|b\nc'
      }]
    }
    const { markdown } = buildDataDictionary({
      table: { table: 't' }, structure, dialect: 'mysql', now: NOW
    })
    assert.match(markdown, /\| 1 \| c \| text \| 是 \| {2}\| 否 \| a\\\|b<br>c \|/)
  })

  test('PG：schema 限定 + 多列外键写成 table(col1, col2)', async () => {
    const { buildDataDictionary } = await load()
    const structure = {
      columns: [],
      indexes: [],
      foreignKeys: [{
        name: 'fk_multi',
        columns: ['a', 'b'],
        refSchema: 'auth',
        refTable: 'users',
        refColumns: ['x', 'y'],
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION'
      }]
    }
    const { markdown } = buildDataDictionary({
      table: { database: 'app', schema: 'public', table: 'orders' },
      structure,
      dialect: 'postgres',
      now: NOW
    })
    assert.match(markdown, /# 数据字典：public\.orders/)
    assert.match(markdown, /\| fk_multi \| a, b \| auth\.users\(x, y\) \| NO ACTION \| NO ACTION \|/)
  })

  test('视图类型与缺失字段：空结构不抛、节数写 0', async () => {
    const { buildDataDictionary } = await load()
    const { markdown } = buildDataDictionary({
      table: { table: 'v1' }, structure: { type: 'view' }, dialect: 'mysql', now: NOW
    })
    assert.match(markdown, /\| 类型 \| 视图 \|/)
    assert.match(markdown, /## 列（0）/)
    assert.match(markdown, /## 索引（0）/)
    assert.match(markdown, /## 外键（0）/)
    assert.match(markdown, /\| 估算行数 \| {2}\|/)
  })

  test('估算行数 0 不被当成"无"（0 行是有效统计）', async () => {
    const { buildDataDictionary } = await load()
    const { markdown } = buildDataDictionary({
      table: { table: 'empty' }, structure: { estimatedRows: 0 }, dialect: 'mysql', now: NOW
    })
    assert.match(markdown, /\| 估算行数 \| 0 \|/)
  })

  test('同一份输入 + 固定时间 → 输出逐字节相同', async () => {
    const { buildDataDictionary } = await load()
    const a = buildDataDictionary({ table: MYSQL_TABLE, structure: STRUCT, dialect: 'mysql', now: NOW })
    const b = buildDataDictionary({ table: MYSQL_TABLE, structure: STRUCT, dialect: 'mysql', now: NOW })
    assert.equal(a.markdown, b.markdown)
    assert.equal(a.csv, b.csv)
  })
})

describe('H3a 数据字典：CSV 内容', () => {
  test('BOM + CRLF + # 分节 + 表头', async () => {
    const { buildDataDictionary } = await load()
    const { csv } = buildDataDictionary({
      table: MYSQL_TABLE, structure: STRUCT, dialect: 'mysql', now: NOW
    })
    assert.equal(csv.charCodeAt(0), 0xfeff)
    assert.ok(csv.startsWith('\uFEFF# 表信息\r\n属性,值\r\n'))
    assert.ok(csv.includes('\r\n# 列\r\n序号,列名,类型,可空,默认值,主键,注释\r\n'))
    assert.ok(csv.includes('\r\n# 索引\r\n索引名,唯一,主键,方法,列\r\n'))
    assert.ok(csv.includes('\r\n# 外键\r\n外键名,列,引用,删除动作,更新动作\r\n'))
    // 行间只允许 CRLF：任何 \n 前面必须紧跟 \r
    assert.ok(!/[^\r]\n/.test(csv))
    assert.ok(csv.includes('1,id,bigint unsigned,否,,是,主键'))
    assert.ok(csv.includes('PRIMARY,是,是,BTREE,id'))
    assert.ok(csv.includes('fk_user,user_id,users.id,CASCADE,RESTRICT'))
  })

  test('含逗号 / 双引号 / 换行的字段按 RFC 4180 加引号', async () => {
    const { buildDataDictionary } = await load()
    const structure = {
      columns: [{
        name: 'c',
        dataType: 'text',
        nullable: true,
        isPrimaryKey: false,
        comment: 'a,b"c\nd'
      }]
    }
    const { csv } = buildDataDictionary({
      table: { table: 't' }, structure, dialect: 'mysql', now: NOW
    })
    assert.ok(csv.includes('1,c,text,是,,否,"a,b""c\nd"'))
  })
})

describe('H3a 数据字典：接线', () => {
  test('结构页工具行有导出入口（Markdown / CSV，未取到列时禁用）', () => {
    const src = codeOf(read(SESSION) + '\n' + read(USE_DB_TREE))
    assert.match(src, /import \{ buildDataDictionary \} from '\.\.\/\.\.\/common\/db-dictionary'/)
    const tools = src.slice(src.indexOf('db-struct-tools'), src.indexOf('DbGridTable', src.indexOf('db-struct-tools')))
    assert.match(tools, /disabled=\{!structureV2\.columns\.length\}/)
    assert.match(tools, /key: 'md'/)
    assert.match(tools, /key: 'csv'/)
    assert.match(tools, /e\('dbDictExport'\)/)
  })

  test('导出用的是 structureV2 整份契约（索引/注释/行数不进回收站）', () => {
    const src = codeOf(read(SESSION) + '\n' + read(USE_DB_TREE))
    const setter = src.slice(src.indexOf('setStructureV2({') - 400, src.indexOf('setStructureV2({') + 500)
    assert.match(setter, /indexes:/)
    assert.match(setter, /type:/)
    assert.match(setter, /comment:/)
    assert.match(setter, /estimatedRows:/)
    assert.match(src, /structure: structureV2,/)
    assert.match(src, /dialect: tab\.dbType/)
    assert.match(src, /dictionary-\$\{sel\.database\}-\$\{sel\.table\}-\$\{tsName\(\)\}/)
  })

  test('词条：中英各一份', () => {
    const src = read(LOCALES)
    assert.match(src, /dbDictExport: 'Export dictionary'/)
    assert.match(src, /dbDictExport: '导出数据字典'/)
  })
})
