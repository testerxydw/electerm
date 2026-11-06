// S2-1：AI Agent 的数据库只读工具集（设计 §5.5）
// 纯函数层脱浏览器脱数据库全覆盖 + 源码契约钉住"只有看，没有执行"
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const load = () => import('../../client/common/db-agent-tools.js')

const ROOT = path.join(__dirname, '../../..')
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const AGENT_TOOLS = 'src/client/components/ai/agent-tools.js'
const MCP_HANDLER = 'src/client/store/mcp-handler.js'
const AGENT = 'src/client/components/ai/agent.js'
const SESSION = 'src/client/components/database/db-session.jsx'
const AI_REGISTER = 'src/client/components/database/use-db-ai-register.js'

const DB_TAB = {
  id: 'db-1',
  type: 'database',
  dbType: 'mysql',
  dbHost: '127.0.0.1',
  dbPort: 3306,
  dbUser: 'root',
  dbName: 'shop',
  title: 'shop@local',
  readOnly: false,
  production: true
}

// MySQL 的 getMetadata：库 → 表/视图（部分驱动再套一层 table/view 分组）
const MYSQL_METADATA = [
  {
    name: 'shop',
    type: 'database',
    children: [
      { name: 'users', type: 'table' },
      { name: 'Orders', type: 'table' },
      { name: 'v_active', type: 'view' },
      { name: 'users', type: 'table' }
    ]
  },
  { name: 'information_schema', type: 'database', children: [{ name: 'columns', type: 'table' }] }
]

// PostgreSQL：库 → schema → 表
const PG_METADATA = [
  {
    name: 'app',
    type: 'database',
    children: [
      { name: 'public', type: 'schema', children: [{ name: 'users', type: 'table' }] },
      { name: 'report', type: 'schema', children: [{ name: 'users', type: 'table' }, { name: 'daily', type: 'view' }] }
    ]
  }
]

const STRUCTURE = {
  type: 'table',
  comment: '下单用户',
  estimatedRows: 1234,
  columns: [
    { name: 'id', dataType: 'int', columnType: 'int(11)', nullable: false, isPrimaryKey: true, ordinal: 1 },
    { name: 'email', dataType: 'varchar', columnType: 'varchar(64)', nullable: false, defaultValue: '', comment: '登录名', ordinal: 2 },
    { name: 'nick', dataType: 'varchar', columnType: 'varchar(32)', nullable: true, ordinal: 3 }
  ],
  indexes: [{ name: 'PRIMARY', unique: true, primary: true, columns: ['id'], method: 'BTREE' }],
  foreignKeys: [{
    name: 'fk_addr',
    columns: ['addr_id'],
    refSchema: 'shop',
    refTable: 'address',
    refColumns: ['id'],
    onDelete: 'CASCADE',
    onUpdate: 'NO ACTION'
  }]
}

describe('db-agent-tools：页签解析', () => {
  test('没有开着的数据库页签：报错要说清下一步，而不是抛空列表', async () => {
    const { resolveDbTab } = await load()
    assert.throws(
      () => resolveDbTab({ tabs: [{ id: 't1', type: 'local' }], activeTabId: 't1' }),
      /No database tab is open.*open_tab/
    )
    assert.throws(() => resolveDbTab({ tabs: undefined }), /No database tab is open/)
  })

  test('显式 tabId：认不到就报错，非数据库页签要把真实 type 报出来', async () => {
    const { resolveDbTab } = await load()
    const tabs = [DB_TAB, { id: 'ssh-1', type: 'ssh' }]
    assert.equal(resolveDbTab({ tabs, requested: 'db-1' }).tabId, 'db-1')
    assert.throws(() => resolveDbTab({ tabs, requested: 'nope' }), /Database tab not found: nope/)
    assert.throws(() => resolveDbTab({ tabs, requested: 'ssh-1' }), /not a database tab \(type: ssh\)/)
  })

  test('活动页签优先；活动页签不是数据库时，只有一个就直接用它', async () => {
    const { resolveDbTab } = await load()
    const other = { ...DB_TAB, id: 'db-2', dbName: 'other' }
    assert.equal(
      resolveDbTab({ tabs: [other, DB_TAB], activeTabId: 'db-1' }).tabId,
      'db-1',
      '活动页签应当盖过"第一个数据库页签"'
    )
    assert.equal(
      resolveDbTab({ tabs: [{ id: 't', type: 'local' }, DB_TAB], activeTabId: 't' }).tabId,
      'db-1'
    )
  })

  test('多个数据库页签且活动页签不在其中：报错要列出候选，让模型改口而不是我们猜', async () => {
    const { resolveDbTab } = await load()
    const other = { ...DB_TAB, id: 'db-2', title: 'other@local' }
    assert.throws(
      () => resolveDbTab({ tabs: [DB_TAB, other], activeTabId: 'nope' }),
      /2 database tabs are open.*db-1 \(shop@local\).*db-2 \(other@local\)/s
    )
  })
})

describe('db-agent-tools：上下文归一', () => {
  test('会话页的运行时选择盖过页签默认值', async () => {
    const { buildDbContext } = await load()
    const ctx = buildDbContext({
      tab: DB_TAB,
      tabId: 'db-1',
      context: { dbType: 'MySQL', database: 'cart', schema: '', table: 'users', columns: [1, 2, 3], readOnly: true },
      hasSqlEditor: true
    })
    assert.equal(ctx.database, 'cart', '当前库应取会话页选中的，不是书签上那个')
    assert.equal(ctx.dbType, 'mysql', '引擎名统一小写')
    assert.equal(ctx.table, 'users')
    assert.equal(ctx.loadedColumns, 3)
    assert.equal(ctx.readOnly, true, '会话页的只读开关盖过页签字段')
    assert.equal(ctx.production, true, '生产标记来自页签，必须透出给模型')
    assert.equal(ctx.supportsSql, true)
    assert.equal(ctx.hasSqlEditor, true)
    assert.equal(ctx.port, 3306)
  })

  test('编辑器还没挂载（例如 redis 页签）：loadedColumns 有兜底、redis 标出不支持 SQL', async () => {
    const { buildDbContext } = await load()
    const ctx = buildDbContext({
      tab: { ...DB_TAB, dbType: 'Redis', dbName: '', dbUser: 'cache' },
      tabId: 'db-1',
      context: null
    })
    assert.equal(ctx.supportsSql, false)
    assert.equal(ctx.hasSqlEditor, false)
    assert.equal(ctx.loadedColumns, 0)
    // 没选库时退回连接用户名（与会话页 currentDbName 同一口径）
    assert.equal(ctx.database, 'cache')
    assert.equal(ctx.readOnly, false)
  })
})

describe('db-agent-tools：表清单', () => {
  test('MySQL：只取指定库、视图一起收、同名去重、库名大小写不敏感', async () => {
    const { collectTables } = await load()
    const r = collectTables(MYSQL_METADATA, 'SHOP')
    assert.deepEqual(r.tables, [
      { name: 'Orders', kind: 'table', schema: '' },
      { name: 'users', kind: 'table', schema: '' },
      { name: 'v_active', kind: 'view', schema: '' }
    ])
    assert.equal(r.totalTables, 3)
    assert.equal(r.truncated, false)
    assert.deepEqual(r.databases, ['shop', 'information_schema'])
  })

  test('PG：schema 归属要带出来，不同 schema 的同名表是两张表', async () => {
    const { collectTables } = await load()
    const r = collectTables(PG_METADATA, 'app')
    assert.deepEqual(r.tables.map(t => `${t.schema}.${t.name}/${t.kind}`), [
      'public.users/table',
      'report.daily/view',
      'report.users/table'
    ])
  })

  test('limit 截断如实标注，不静默丢表', async () => {
    const { collectTables } = await load()
    const r = collectTables(MYSQL_METADATA, '', { limit: 2 })
    assert.equal(r.tables.length, 2)
    assert.equal(r.totalTables, 4)
    assert.equal(r.truncated, true)
  })

  test('指定的库不存在 / 该库元数据抓取失败：都报错并给出可见的库', async () => {
    const { collectTables } = await load()
    assert.throws(() => collectTables(MYSQL_METADATA, 'nope'), /not visible on this connection.*shop, information_schema/s)
    assert.throws(
      () => collectTables([{ name: 'shop', type: 'database', error: 'boom' }], 'shop'),
      /Metadata for database "shop" failed: boom/
    )
  })
})

describe('db-agent-tools：表结构', () => {
  test('列压到模型需要的字段，类型优先取带长度的 columnType', async () => {
    const { summarizeStructure } = await load()
    const r = summarizeStructure(STRUCTURE, { table: 'users', database: 'shop' })
    assert.equal(r.objectType, 'table')
    assert.equal(r.comment, '下单用户')
    assert.equal(r.estimatedRows, 1234)
    assert.deepEqual(r.columns[1], {
      name: 'email',
      type: 'varchar(64)',
      nullable: false,
      primaryKey: false,
      defaultValue: '',
      comment: '登录名'
    })
    // 空 defaultValue 与"没有默认值"是两件事，前者要留
    assert.equal('defaultValue' in r.columns[1], true)
    assert.equal('defaultValue' in r.columns[0], false)
    assert.deepEqual(r.foreignKeys, [{
      name: 'fk_addr',
      columns: ['addr_id'],
      references: 'shop.address(id)',
      onDelete: 'CASCADE',
      onUpdate: 'NO ACTION'
    }])
    assert.deepEqual(r.indexes, [{ name: 'PRIMARY', unique: true, primary: true, columns: ['id'] }])
    assert.equal(r.totalColumns, 3)
    assert.equal(r.truncatedColumns, false)
  })

  test('列超上限时截断并标记；没统计行数不能报成 0', async () => {
    const { summarizeStructure } = await load()
    const wide = { ...STRUCTURE, estimatedRows: null, columns: Array.from({ length: 130 }, (_, i) => ({ name: 'c' + i })) }
    const r = summarizeStructure(wide, { table: 'wide' })
    assert.equal(r.columns.length, 120)
    assert.equal(r.truncatedColumns, true)
    assert.equal(r.totalColumns, 130)
    assert.equal(r.estimatedRows, null, '未统计（null）不能变成"0 行"')
    // 截断只作用于列：索引与外键是写 SQL 真正依赖的信息，全量给
    assert.equal(r.foreignKeys.length, 1)
    assert.equal(r.indexes.length, 1)
  })
})

describe('db-agent-tools：结果集快照', () => {
  const snapshot = {
    source: 'sql-result',
    elapsedMs: 42,
    error: '',
    results: [
      {
        fields: ['id', 'nick', 'bio'],
        columns: [{ name: 'id', type: 'int' }, { name: 'nick', type: 'varchar' }, { name: 'bio', type: 'text' }],
        rows: [
          { id: 1, nick: null, bio: 'a'.repeat(500) },
          { id: 2, nick: '', bio: 'ok' }
        ]
      },
      { rows: [{ x: 1 }], fields: ['x'], columns: [] }
    ]
  }

  test('列名取结果集自己的，NULL 与空串区分，超长单元格截断并计数', async () => {
    const { summarizeResultSnapshot } = await load()
    const r = summarizeResultSnapshot(snapshot, {})
    assert.equal(r.source, 'sql-result')
    assert.deepEqual(r.columns, ['id', 'nick', 'bio'])
    assert.equal(r.resultCount, 2)
    assert.equal(r.totalRows, 2)
    assert.equal(r.rows[0].nick, null, 'NULL 必须是 null')
    assert.equal(r.rows[1].nick, '', '空串必须还是空串')
    assert.equal(r.rows[0].bio.length, 201, '200 字 + 省略号')
    assert.equal(r.truncatedCells, 1)
    assert.equal(r.elapsedMs, 42)
    assert.equal(r.hasMoreRows, false)
  })

  test('offset/limit 切片、resultIndex 越界夹回、写语句的 affected 透出', async () => {
    const { summarizeResultSnapshot } = await load()
    const many = { source: 'sql-result', results: [{ rows: Array.from({ length: 60 }, (_, i) => ({ n: i })) }] }
    const r = summarizeResultSnapshot(many, { offset: 55, limit: 100 })
    assert.equal(r.returnedRows, 5)
    assert.equal(r.offset, 55)
    assert.equal(r.hasMoreRows, false)
    // 上限之外要如实标出来，否则模型以为这就是全部
    assert.equal(summarizeResultSnapshot(many, { limit: 5 }).hasMoreRows, true)
    assert.equal(summarizeResultSnapshot(many, { limit: 5 }).returnedRows, 5)
    assert.equal(summarizeResultSnapshot(many, { resultIndex: 9 }).resultIndex, 0)
    assert.equal(summarizeResultSnapshot(many, { resultIndex: 9 }).columns.join(), 'n')
    const write = { source: 'sql-result', results: [{ rows: [], fields: [], affected: 7 }] }
    assert.equal(summarizeResultSnapshot(write, {}).affected, 7)
  })

  test('二进制只报长度；后端没回耗时时不能编成 0ms', async () => {
    const { summarizeResultSnapshot } = await load()
    const bin = {
      source: 'sql-result',
      results: [{ rows: [{ blob: new Uint8Array(3000), at: new Date('2026-11-03T00:00:00Z') }] }]
    }
    const r = summarizeResultSnapshot(bin, {})
    assert.equal(r.rows[0].blob, '<binary 3000 bytes>')
    assert.equal(r.binaryCells, 1)
    assert.equal(r.elapsedMs, null)
    // Date 是对象：落成可读字符串，别给模型一个 JSON 里的时间戳数字
    assert.equal(typeof r.rows[0].at, 'string')
  })

  test('网格当前页：列名从首行键取，页数与估算行数是另一回事', async () => {
    const { summarizeResultSnapshot } = await load()
    const grid = {
      source: 'grid',
      table: 'shop.users',
      page: 3,
      hasMore: true,
      totalRows: 98000,
      results: [{ rows: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] }]
    }
    const r = summarizeResultSnapshot(grid, { limit: 1 })
    assert.deepEqual(r.columns, ['id', 'name'])
    assert.equal(r.returnedRows, 1)
    assert.equal(r.hasMoreRows, true, '本页还有没给出去的行')
    assert.equal(r.hasMorePages, true, '网格还有下一页')
    assert.equal(r.page, 3)
    assert.equal(r.totalRowsEstimate, 98000)
    assert.equal(r.table, 'shop.users')
  })

  test('没有快照返回 null（调用方据此报错，而不是回一张空表）', async () => {
    const { summarizeResultSnapshot } = await load()
    assert.equal(summarizeResultSnapshot(null, {}), null)
  })
})

describe('db-agent-tools：接线与边界（源码契约）', () => {
  const names = ['db_get_context', 'db_list_tables', 'db_describe_table', 'db_read_result', 'db_insert_sql']

  test('五个工具都进了发给模型的 schema，且每个都有分发分支', () => {
    const src = read(AGENT_TOOLS)
    for (const n of names) {
      assert.match(src, new RegExp(`name: '${n}'`), `schema 里没有 ${n}`)
      assert.match(src, new RegExp(`case '${n}':`), `executeToolCall 里没有 ${n}`)
    }
    // schema 与分发成对出现，漏一边就是"模型看得见、调不动"或反之
    assert.equal(
      (src.match(/name: 'db_/g) || []).length,
      (src.match(/case 'db_/g) || []).length
    )
  })

  test('没有执行入口：agent 侧不存在 executeSql，也没有写库工具', () => {
    const src = read(AGENT_TOOLS)
    assert.ok(!/executeSql/.test(src), 'agent 工具不得直接执行 SQL')
    assert.ok(!/name: 'db_(execute|run|write)/.test(src), '不得出现执行/写库的 db 工具')
    const db = src.slice(src.indexOf("name: 'db_get_context'"))
    assert.ok(!/updateCell|insertRow|deleteRows|beginDbTx/.test(db), 'db 工具不得触达写操作')
  })

  test('store 侧：五个方法齐全，且只碰只读 op', () => {
    const src = read(MCP_HANDLER)
    for (const m of ['mcpDbGetContext', 'mcpDbListTables', 'mcpDbDescribeTable', 'mcpDbReadResult', 'mcpDbInsertSql']) {
      assert.match(src, new RegExp(`Store\\.prototype\\.${m} = (async )?function`), `缺 ${m}`)
    }
    const section = src.slice(src.indexOf('// ==================== Database (read-only) APIs'))
    assert.ok(section.length > 500, '没找到数据库工具段')
    for (const forbidden of ['executeSql', 'updateCell', 'insertRow', 'deleteRows', 'updateCells', 'beginDbTx', 'commitDbTx', 'delKey']) {
      assert.ok(!new RegExp(`'${forbidden}'`).test(section), `只读段里出现了写 op：${forbidden}`)
    }
    assert.match(section, /'getMetadata'/)
    assert.match(section, /'getTableStructure'/)
    // 插入走登记目标 + 固定 cursor 策略：AI 不该有吃掉用户选区或整篇替换的入口
    assert.match(section, /strategy: 'cursor'/)
    assert.ok(!/strategy: 'replace'/.test(section), '不得允许整篇替换用户手写 SQL')
    assert.match(section, /isSqlTargetReady\(tabId\)/)
  })

  test('会话页交出只读快照，契约里仍然没有执行入口', () => {
    // N11a-12（#10）：登记段已拆出，组合读取已接线 shipped 文件，断言语义不变
    const src = read(SESSION) + '\n' + read(AI_REGISTER)
    assert.match(src, /getResultSnapshot \(\)/, '会话页没登记结果集快照')
    assert.match(src, /sqlAiLiveRef\.current = \{ sqlResult, grid, sel \}/, '快照没有跟着渲染刷新')
    const body = src.slice(src.indexOf('const sqlAiTarget = useMemo'), src.indexOf('const sqlAiTarget = useMemo') + 3000)
    assert.ok(!/runSql/.test(body), '登记给 AI 的对象不得暴露执行入口')
  })

  test('系统提示词把"只读、由人执行"的边界写给模型', () => {
    const src = read(AGENT)
    assert.match(src, /db_insert_sql/, '提示词没提数据库写编辑器这条路')
    assert.match(src, /no tool that runs SQL/, '提示词没说清没有执行工具')
    assert.match(src, /db_get_context first/, '提示词没要求先取上下文')
  })
})
