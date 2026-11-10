// S2-1：AI Agent 的数据库只读工具集（设计 §5.5）
// 纯函数层脱浏览器脱数据库全覆盖 + 源码契约钉住"只有看，没有执行"
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

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

describe('db-agent-tools：结构差异整形（N10b）', () => {
  test('真实 diff 保留新增/删除定义，过滤 equal，changed 保持 base → target 方向', async () => {
    const { summarizeStructureDiff } = await load()
    const { diffTableStructure } = await import('../../client/common/db-structure-diff.js')
    const id = { name: 'id', columnType: 'int', nullable: false }
    const primary = { name: 'PRIMARY', columns: ['id'], unique: true, primary: true, method: 'BTREE' }
    const accountFk = { name: 'fk_account', columns: ['id'], refTable: 'accounts', refColumns: ['id'] }
    const base = {
      columns: [id,
        { name: 'email', columnType: 'varchar(64)', nullable: false },
        { name: 'legacy_flag', dataType: 'boolean', nullable: true, defaultValue: false }
      ],
      indexes: [primary, { name: 'old_login', columns: ['legacy_flag', 'email'], unique: false, method: 'BTREE' }],
      foreignKeys: [accountFk, {
        name: 'old_role', columns: ['legacy_flag'], refTable: 'legacy_roles', refColumns: ['enabled'], onDelete: 'restrict', onUpdate: 'no_action'
      }]
    }
    const target = {
      columns: [id,
        { name: 'email', columnType: 'varchar(255)', nullable: false },
        { name: 'nick', columnType: 'varchar(64)', maxLength: 64, nullable: false, defaultValue: '', comment: 'display name' }
      ],
      indexes: [primary, { name: 'new_login', columns: ['email', 'nick'], unique: true, method: 'BTREE' }],
      foreignKeys: [accountFk, {
        name: 'new_role', columns: ['nick'], refTable: 'roles', refColumns: ['code'], onDelete: 'set_null', onUpdate: 'cascade'
      }]
    }
    const diff = diffTableStructure(base, target, { dialect: 'mysql' })
    const before = structuredClone(diff)
    const r = summarizeStructureDiff(diff, { baseLabel: 'old.users', targetLabel: 'new.users', dialect: 'mysql' })
    assert.deepEqual(r.summary, { added: 3, removed: 3, changed: 1, equal: 3, total: 10 })
    for (const section of ['columns', 'indexes', 'foreignKeys']) {
      const expected = diff[section].filter(e => e.status !== 'equal')
      assert.deepEqual(r[section].changes.map(e => e.name), expected.map(e => e.name))
      assert.equal(r[section].totalChanges, expected.length)
      assert.equal(r[section].truncated, false)
      for (const key of ['added', 'removed', 'changed', 'equal', 'total']) {
        assert.equal(r[section][key], diff.sections[section][key])
      }
      for (const entry of expected.filter(e => e.status !== 'changed')) {
        assert.deepEqual(r[section].changes.find(e => e.name === entry.name), {
          name: entry.name, status: entry.status, fields: [], base: entry.base, target: entry.target
        })
      }
    }
    assert.deepEqual(r.columns.changes[0].target, {
      name: 'nick', type: 'varchar(64)', maxLength: 64, nullable: false, defaultValue: '', comment: 'display name'
    })
    assert.deepEqual(r.columns.changes[1].base, {
      name: 'legacy_flag', type: 'boolean', maxLength: null, nullable: true, defaultValue: false, comment: null
    })
    assert.deepEqual(r.columns.changes[2], {
      name: 'email', status: 'changed', fields: [{ key: 'type', base: 'varchar(64)', target: 'varchar(255)' }]
    })
    assert.deepEqual(r.indexes.changes[0].target, {
      name: 'new_login', columns: ['email', 'nick'], unique: true, primary: false, method: 'BTREE'
    })
    assert.deepEqual(r.foreignKeys.changes[0].target, {
      name: 'new_role', columns: ['nick'], refTable: 'roles', refColumns: ['code'], onDelete: 'SET NULL', onUpdate: 'CASCADE'
    })
    assert.deepEqual(r.foreignKeys.changes[1].base, {
      name: 'old_role', columns: ['legacy_flag'], refTable: 'legacy_roles', refColumns: ['enabled'], onDelete: 'RESTRICT', onUpdate: 'NO ACTION'
    })
    assert.equal(r.truncatedCells, 0)
    assert.deepEqual(diff, before, '整形不得修改真实 diff 的定义')
  })

  test('真实 diff 的定义递归限制数组/映射和长字符串，保留原生值及原有截断语义', async () => {
    const { summarizeStructureDiff, DB_AGENT_COLUMN_LIMIT: max, DB_AGENT_CELL_MAX_CHARS: chars } = await load()
    const { diffTableStructure } = await import('../../client/common/db-structure-diff.js')
    const long = 'x'.repeat(chars + 50)
    const clipped = 'x'.repeat(chars) + '…'
    const columns = Array.from({ length: max + 3 }, (_, i) => i === 0 ? long : 'c' + i)
    const values = [0, false, null, '', long, ...Array(max).fill('value')]
    const defaults = Object.fromEntries(Array.from({ length: max + 3 }, (_, i) => ['k' + i, i]))
    defaults.k0 = { [long]: values }
    const table = {
      columns: [{ name: long, dataType: 'jsonb', nullable: true, defaultValue: defaults, comment: long }],
      indexes: [{ name: long, columns, unique: true }],
      foreignKeys: [{ name: long, columns, refTable: long, refColumns: columns, onDelete: 'CASCADE' }]
    }
    for (const removed of [false, true]) {
      const diff = diffTableStructure(removed ? table : {}, removed ? {} : table, { dialect: 'postgres' })
      const before = structuredClone(diff)
      const r = summarizeStructureDiff(diff, { baseLabel: long, targetLabel: long, dialect: 'postgres', limit: 1 })
      const side = removed ? 'base' : 'target'
      const absent = removed ? 'target' : 'base'
      assert.equal(r.base, clipped)
      assert.equal(r.target, clipped)
      for (const section of ['columns', 'indexes', 'foreignKeys']) {
        const entry = r[section].changes[0]
        assert.equal(entry.name, clipped)
        assert.equal(entry[side].name, clipped)
        assert.equal(entry[absent], null)
        assert.deepEqual(entry.fields, [])
        assert.equal(r[section].totalChanges, 1)
        assert.equal(r[section].truncated, false, '定义内部截断不改变条目计数语义')
      }
      const column = r.columns.changes[0][side]
      assert.equal(column.type, 'jsonb')
      assert.equal(column.comment, clipped)
      assert.equal(column.nullable, true)
      assert.equal(column.maxLength, null)
      assert.equal(Object.keys(column.defaultValue).length, max)
      assert.equal(column.defaultValue.k119, 119)
      assert.equal('k120' in column.defaultValue, false)
      assert.deepEqual(Object.keys(column.defaultValue.k0), [clipped])
      const boundedValues = column.defaultValue.k0[clipped]
      assert.equal(boundedValues.length, max)
      assert.deepEqual(boundedValues.slice(0, 5), [0, false, null, '', clipped])
      const index = r.indexes.changes[0][side]
      assert.equal(index.unique, true)
      assert.equal(index.primary, false)
      assert.deepEqual(index.columns, [clipped, ...columns.slice(1, max)])
      const fk = r.foreignKeys.changes[0][side]
      assert.deepEqual(fk.columns, index.columns)
      assert.deepEqual(fk.refColumns, index.columns)
      assert.equal(fk.refTable, clipped)
      assert.equal(fk.onDelete, 'CASCADE')
      assert.equal(fk.onUpdate, null)
      assert.equal(r.truncatedCells, 20)
      assert.deepEqual(r.summary, diff.summary)
      assert.deepEqual(diff, before)
    }
  })

  test('只留"有变化"的条目：equal 不占上下文，但计数仍在 tally 里', async () => {
    const { summarizeStructureDiff } = await load()
    const diff = {
      columns: [
        { kind: 'column', name: 'same', status: 'equal', fields: [] },
        { kind: 'column', name: 'addme', status: 'added', fields: [] },
        { kind: 'column', name: 'gone', status: 'removed', fields: [] }
      ],
      indexes: [],
      foreignKeys: [],
      sections: {
        columns: { added: 1, removed: 1, changed: 0, equal: 120, total: 122 },
        indexes: { added: 0, removed: 0, changed: 0, equal: 0, total: 0 },
        foreignKeys: { added: 0, removed: 0, changed: 0, equal: 0, total: 0 }
      },
      summary: { added: 1, removed: 1, changed: 0, equal: 120, total: 122 }
    }
    const r = summarizeStructureDiff(diff, { baseLabel: 'a.t', targetLabel: 'b.t', dialect: 'mysql' })
    assert.equal(r.base, 'a.t')
    assert.equal(r.target, 'b.t')
    assert.equal(r.dialect, 'mysql')
    assert.deepEqual(r.columns.changes.map(c => c.name), ['addme', 'gone'])
    assert.equal(r.columns.totalChanges, 2)
    assert.equal(r.columns.equal, 120, 'tally 里的 equal 不能丢：模型据此判断两表大体相同')
    assert.equal(r.columns.total, 122)
    assert.deepEqual(r.summary, diff.summary)
  })

  test('字段级 base/target 走 toCell：超长截断并计数，二进制只报长度', async () => {
    const { summarizeStructureDiff } = await load()
    const diff = {
      columns: [{
        kind: 'column',
        name: 'c1',
        status: 'changed',
        fields: [
          { key: 'comment', base: 'x'.repeat(500), target: 'y' },
          { key: 'default', base: new Uint8Array(8), target: null }
        ]
      }],
      indexes: [],
      foreignKeys: [],
      sections: {},
      summary: { added: 0, removed: 0, changed: 1, equal: 0, total: 1 }
    }
    const r = summarizeStructureDiff(diff, {})
    const f = r.columns.changes[0].fields
    assert.equal(f[0].key, 'comment')
    assert.equal(f[0].base.length, 201, '200 字 + 省略号')
    assert.equal(f[1].base, '<binary 8 bytes>')
    assert.equal(r.truncatedCells, 1)
  })

  test('每段封顶并标 truncated；空/缺省 diff 回 0 结构，不抛', async () => {
    const { summarizeStructureDiff } = await load()
    const many = Array.from({ length: 200 }, (_, i) => ({
      kind: 'column', name: 'c' + i, status: 'added', fields: []
    }))
    const r = summarizeStructureDiff({
      columns: many, indexes: [], foreignKeys: [], sections: {}, summary: {}
    })
    assert.equal(r.columns.changes.length, 120, '默认上限 120')
    assert.equal(r.columns.totalChanges, 200)
    assert.equal(r.columns.truncated, true)
    // 注记要讲清"这里只比元数据、不生成不执行 DDL"
    assert.match(r.note, /No DDL is generated or run/)

    for (const bad of [undefined, null, {}]) {
      const empty = summarizeStructureDiff(bad)
      assert.equal(empty.columns.changes.length, 0)
      assert.equal(empty.columns.totalChanges, 0)
      assert.equal(empty.columns.truncated, false)
      assert.deepEqual(empty.summary, { added: 0, removed: 0, changed: 0, equal: 0, total: 0 })
    }
  })
})

describe('db-agent-tools：N10b Store IPC boundary', () => {
  const createStore = async () => {
    const redis = await import('../../client/common/db-agent-redis.js')
    const diff = await import('../../client/common/db-structure-diff.js')
    const dialects = await import('../../client/common/sql-dialects.js')
    const dependencies = { ...await load(), ...redis, ...diff, ...dialects, getSqlTarget: () => null }
    const calls = []
    const window = {
      pre: {
        runGlobalAsync: async (channel, tabId, op, args) => {
          assert.equal(channel, 'dbClientOp')
          assert.ok(['getPageData', 'getKeyDetail', 'getRedisInfo', 'getRedisSlowlog', 'getTableStructure'].includes(op))
          calls.push({ tabId, op, args: structuredClone(args) })
          if (op === 'getKeyDetail') return { type: 'string', value: args.key, ttl: -1 }
          return op === 'getTableStructure' ? { columns: [], indexes: [], foreignKeys: [] } : null
        }
      }
    }
    function Store () {}
    const source = read(MCP_HANDLER)
    const start = source.indexOf('  const requireSqlDbTab =')
    assert.ok(start > 0)
    const body = source.slice(start, source.lastIndexOf('\n}'))
    vm.runInNewContext(body, { Store, window, ...dependencies })
    const store = new Store()
    store.tabs = [DB_TAB, { id: 'redis-1', type: 'database', dbType: 'redis' }]
    store.activeTabId = 'redis-1'
    window.store = store
    return { store, calls, window }
  }

  test('limits normalized before IPC, including fractions and invalid values', async () => {
    const { store, calls } = await createStore()
    for (const [fn, field, fallback, maximum] of [
      ['mcpRedisScanKeys', 'pageSize', 50, 200],
      ['mcpRedisGetKey', 'pageSize', 50, 200],
      ['mcpRedisSlowlog', 'count', 20, 100]
    ]) {
      for (const [limit, expected] of [[undefined, fallback], [0, fallback], [-2, fallback], [Infinity, fallback], [0.5, 1], [2.9, 2], [999999, maximum]]) {
        await store[fn]({ key: 'k', limit })
        assert.equal(calls.at(-1).args[field], expected, fn + ':' + limit)
      }
    }
  })

  test('key names are exact, including empty and whitespace-only keys', async () => {
    const { store, calls } = await createStore()
    for (const key of ['', ' ', ' k ', '键\u0000名']) {
      const result = await store.mcpRedisGetKey({ key })
      assert.equal(calls.at(-1).args.key, key)
      assert.equal(result.value, key)
    }
  })

  test('invalid input and wrong engine are rejected before IPC', async () => {
    const { store, calls } = await createStore()
    for (const args of [{ dbIndex: -1 }, { dbIndex: NaN }, { dbIndex: 1.5 }, { cursor: 'bad' }, { cursor: '1-0' }, { match: {} }, { match: 'x'.repeat(8193) }]) {
      await assert.rejects(store.mcpRedisScanKeys(args))
    }
    for (const key of [undefined, null, 0, {}, 'x'.repeat(8193)]) {
      await assert.rejects(store.mcpRedisGetKey({ key }))
    }
    await assert.rejects(store.mcpRedisInfo({ section: 'x'.repeat(201) }))
    await assert.rejects(store.mcpRedisScanKeys({ tabId: 'db-1' }), /not a Redis tab/)
    await assert.rejects(store.mcpDbStructureDiff({ baseTable: 'a', targetTable: 'b' }), /Redis tab/)
    assert.equal(calls.length, 0)
  })

  test('stream cursor and DB index pass unchanged; errors are not empty success', async () => {
    const { store, calls, window } = await createStore()
    await store.mcpRedisGetKey({ key: 'stream', cursor: '18446744073709551615-10', dbIndex: 2 })
    assert.equal(calls[0].args.cursor, '18446744073709551615-10')
    assert.equal(calls[0].args.dbIndex, 2)
    window.pre.runGlobalAsync = async () => { throw new Error('connection lost') }
    await assert.rejects(store.mcpRedisGetKey({ key: 'k' }), /connection lost/)
  })

  test('structure diff refreshes both sides using explicit database and schema', async () => {
    const { store, calls } = await createStore()
    const result = await store.mcpDbStructureDiff({ tabId: 'db-1', baseTable: 'a', targetTable: 'b', baseDatabase: 'left', baseSchema: 's1', targetDatabase: 'right', targetSchema: 's2' })
    assert.deepEqual(calls.map(c => c.args), [
      { database: 'left', schema: 's1', table: 'a', refresh: true },
      { database: 'right', schema: 's2', table: 'b', refresh: true }
    ])
    assert.equal(result.base, 'left.s1.a')
    assert.equal(result.target, 'right.s2.b')
  })
})

describe('db-agent-tools：N10b Redis 只读 + 结构 diff（源码契约）', () => {
  const redisNames = ['redis_scan_keys', 'redis_get_key', 'redis_info', 'redis_slowlog']
  const newNames = [...redisNames, 'db_structure_diff']

  test('五个新工具都进了 schema，且每个都有分发分支', () => {
    const src = read(AGENT_TOOLS)
    for (const n of newNames) {
      assert.match(src, new RegExp(`name: '${n}'`), `schema 里没有 ${n}`)
      assert.match(src, new RegExp(`case '${n}':`), `executeToolCall 里没有 ${n}`)
    }
    // redis_* 的 schema 与分发成对出现，漏一边就是"看得见调不动"或反之
    assert.equal(
      (src.match(/name: 'redis_/g) || []).length,
      (src.match(/case 'redis_/g) || []).length
    )
  })

  test('redis_get_key 必填 key；db_structure_diff 必填 base/target', () => {
    const src = read(AGENT_TOOLS)
    assert.match(src, /required: \['key'\]/, 'redis_get_key 没把 key 设成必填')
    assert.match(src, /required: \['baseTable', 'targetTable'\]/, 'db_structure_diff 没把两张表设成必填')
  })

  test('store 侧：五个新方法齐全，只调只读 op，没有任何写 op', () => {
    const src = read(MCP_HANDLER)
    for (const m of ['mcpRedisScanKeys', 'mcpRedisGetKey', 'mcpRedisInfo', 'mcpRedisSlowlog', 'mcpDbStructureDiff']) {
      assert.match(src, new RegExp(`Store\\.prototype\\.${m} = (async )?function`), `缺 ${m}`)
    }
    const section = src.slice(src.indexOf('// ==================== Database (read-only) APIs'))
    for (const op of ['getPageData', 'getKeyDetail', 'getRedisInfo', 'getRedisSlowlog', 'getTableStructure']) {
      assert.match(section, new RegExp(`'${op}'`), `只读段缺 op ${op}`)
    }
    // 写 op 一个都不许出现：连命令控制台 runRedisCommand 也不给 agent（那是人用的受限通道）
    for (const forbidden of ['setKey', 'delKey', 'delKeys', 'expireKey', 'runRedisCommand', 'hashSetField', 'setAdd', 'zsetAdd', 'listPush', 'executeSql', 'updateCell', 'insertRow', 'deleteRows']) {
      assert.ok(!new RegExp(`'${forbidden}'`).test(section), `只读段里出现了写 op：${forbidden}`)
    }
    // redis 工具只认 redis 页签，SQL 页签调用要报错让模型改口
    assert.match(section, /requireRedisDbTab/)
    assert.match(section, /dbType !== 'redis'/)
  })

  test('结构 diff 走 refresh:true 绕缓存，且不生成/执行 DDL', () => {
    const src = read(MCP_HANDLER)
    const fn = src.slice(src.indexOf('Store.prototype.mcpDbStructureDiff'))
    assert.match(fn, /refresh: true/, '结构 diff 没绕开 60s 缓存，base 拿旧快照会静默错')
    assert.match(fn, /diffTableStructure/)
    assert.match(fn, /summarizeStructureDiff/)
    assert.ok(!/executeSql|generateDdl|alterTable/.test(fn), '结构 diff 不得生成/执行 DDL')
  })

  test('系统提示词把 Redis 只读与结构 diff 的边界写给模型', () => {
    const src = read(AGENT)
    assert.match(src, /redis_\* tools only read/, '提示词没说清 redis 工具只读')
    assert.match(src, /db_structure_diff only compares metadata/, '提示词没说清结构 diff 只比元数据')
    assert.match(src, /need a Redis tab/, '提示词没说清 redis 工具要 Redis 页签')
  })
})
