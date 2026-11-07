const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// B2（树扩展：视图/过程/函数/触发器/事件）回归保护。
// 分三层：
//   1) 行为：把适配器丢进 vm 跑（stub 掉 log 与驱动），用假 pool 驱动分组构造，
//      断言"某类对象查询失败只少一组、不拖垮整棵树"
//   2) 契约：主进程 op 白名单必须登记 getObjectDdl（否则渲染层调用直接被拒）；
//      SQL 必须是参数化 + 标识符引用（对象名来自元数据，不能裸拼）
//   3) 前端：isLeafNode 必须认四类对象（否则会被画成 schema 节点且点不开），
//      树渲染/点击分支存在，分组文案中英齐全

const ROOT = path.join(__dirname, '../../..')
// 适配器顶部 require 的类型归一模块（纯函数、无依赖）。vm 里把未知 require 转交给宿主
// 时，`../../common/...` 会按**测试文件**的目录解析而找不到，所以显式给真实模块
const TYPE_NORM = require(path.join(ROOT, 'src/app/common/db-type-normalize.js'))
// N1：适配器新增依赖 './db-tls'（只依赖 fs/crypto），沙箱给真模块，顺带钉住委托关系
const DB_TLS = require(path.join(ROOT, 'src/app/lib/db-client/db-tls.js'))
const DB_CLIENT = path.join(ROOT, 'src/app/lib/db-client')
const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
// N11a 簇 C：onSelectTree 的 isDbObjectType 分支已迁到 use-db-tree.js（已接线）。
const USE_DB_TREE = path.join(ROOT, 'src/client/components/database/use-db-tree.js')
// N11a-#13：命令面板的对象 hint（DB_OBJECT_MARKS[node.type]）已迁到 use-db-quick-open.js
const USE_DB_QUICK_OPEN = path.join(ROOT, 'src/client/components/database/use-db-quick-open.js')
// N11a：纯常量/纯函数搬到了 common/db-session-const.js，声明级断言跟过去
const SESSION_CONST = path.join(ROOT, 'src/client/common/db-session-const.js')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

const read = p => fs.readFileSync(p, 'utf8')

const LOG_STUB = { debug () {}, info () {}, warn () {}, error () {} }

// 与 src/test/e2e-db/db-e2e.js 同一套加载方式：适配器依赖 electron 运行时的
// log 模块，纯 node 下 require 会失败，故用 vm + 桩注入
const loadAdapter = (name, stubs) => {
  const mod = { exports: {} }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: spec => {
      if (stubs[spec]) {
        return stubs[spec]
      }
      if (spec === '../../common/db-type-normalize') {
        return TYPE_NORM
      }
      // N1：适配器新增的 TLS 档位模块（纯 fs/crypto，用真模块，桩它等于没测到委托）
      if (spec === './db-tls') {
        return DB_TLS
      }
      return require(spec)
    },
    console,
    Promise,
    setTimeout,
    clearTimeout,
    Buffer,
    Date,
    Map,
    Set,
    Object,
    String,
    Number,
    Array,
    JSON,
    Error
  }
  vm.createContext(sandbox)
  vm.runInContext(
    fs.readFileSync(path.join(DB_CLIENT, name + '.js'), 'utf8'),
    sandbox,
    { filename: name + '.js' }
  )
  return mod.exports
}

const mysql = loadAdapter('mysql', {
  '../../common/log': LOG_STUB,
  'mysql2/promise': {}
})

// 假 pool：按 SQL 里的表名分派，未登记的类别抛错（模拟无权限 / 调度器关闭）
const fakePool = (handlers) => ({
  query: async sql => {
    for (const [needle, fn] of Object.entries(handlers)) {
      if (String(sql).includes(needle)) {
        const r = fn()
        if (r instanceof Error) {
          throw r
        }
        return [r]
      }
    }
    return [[]]
  }
})

describe('B2 MySQL 分组构造（getDbObjects）', () => {
  test('三类对象都取到时生成三个分组，类型/组名稳定', async () => {
    const pool = fakePool({
      'information_schema.ROUTINES': () => [
        { name: 'sp_a', kind: 'PROCEDURE' },
        { name: 'fn_b', kind: 'FUNCTION' }
      ],
      'information_schema.TRIGGERS': () => [{ name: 'tg_a', tbl: 'users' }],
      'information_schema.EVENTS': () => [{ name: 'ev_a' }]
    })
    const groups = await mysql.getDbObjects(pool, 'demo')
    assert.equal(groups.length, 3)
    const routine = groups.find(g => g.group === 'routine')
    assert.equal(routine.type, 'group')
    assert.deepEqual(
      routine.children.map(c => [c.name, c.type]),
      [['sp_a', 'procedure'], ['fn_b', 'function']]
    )
    assert.deepEqual(
      groups.find(g => g.group === 'trigger').children.map(c => [c.name, c.type, c.table]),
      [['tg_a', 'trigger', 'users']]
    )
    assert.deepEqual(
      groups.find(g => g.group === 'event').children.map(c => [c.name, c.type]),
      [['ev_a', 'event']]
    )
  })

  test('某类查询失败只少一组，不抛错（调度器关闭 / 无 EVENT 权限的真实形态）', async () => {
    const pool = fakePool({
      'information_schema.ROUTINES': () => [{ name: 'sp_a', kind: 'PROCEDURE' }],
      'information_schema.TRIGGERS': () => new Error('TRIGGER command denied'),
      'information_schema.EVENTS': () => new Error('Unknown table EVENTS')
    })
    const groups = await mysql.getDbObjects(pool, 'demo')
    assert.equal(groups.length, 1)
    assert.equal(groups[0].group, 'routine')
  })

  test('空库（三类都空）不产生任何分组节点', async () => {
    const groups = await mysql.getDbObjects(fakePool({}), 'demo')
    // 跨 realm 的空数组 deepStrictEqual 会因原型不同误报，只比长度
    assert.equal(groups.length, 0)
  })

  test('ROUTINE_TYPE 大小写/异常值不误判：非 PROCEDURE 一律按 function', () => {
    const groups = mysql.getDbObjects
    assert.equal(typeof groups, 'function')
    // 直接跑一次，确认 'procedure' 小写也能识别（MySQL 返回大写，MariaDB 有差异）
    return mysql.getDbObjects(fakePool({
      'information_schema.ROUTINES': () => [{ name: 'p', kind: 'procedure' }]
    }), 'demo').then(gs => {
      assert.equal(gs[0].children[0].type, 'procedure')
    })
  })
})

describe('B2 DDL 取值（pickDdlText）', () => {
  test('优先取含 CREATE 的列（不同版本列名不同）', () => {
    assert.match(
      mysql.pickDdlText({
        Procedure: 'sp_a',
        sql_mode: 'STRICT',
        'Create Procedure': 'CREATE PROCEDURE sp_a() BEGIN SELECT 1; END'
      }),
      /^CREATE PROCEDURE/
    )
  })

  test('没有 CREATE 字样时退回最长字符串（老版本裸定义）', () => {
    assert.equal(mysql.pickDdlText({ a: 'short', b: 'BEGIN SELECT 1; END' }), 'BEGIN SELECT 1; END')
  })

  test('空行/非字符串不炸', () => {
    assert.equal(mysql.pickDdlText(null), '')
    assert.equal(mysql.pickDdlText({}), '')
    assert.equal(mysql.pickDdlText({ n: 1, u: null }), '')
  })
})

describe('B2 主进程契约', () => {
  const IDX = read(path.join(DB_CLIENT, 'index.js'))

  test('mysql/postgres 的 op 白名单都开放 getObjectDdl', () => {
    const blocks = IDX.split(/^\s{2}\w+: \{$/m)
    assert.ok(IDX.includes("getObjectDdl: 'getObjectDdl'"), 'OP_MAP 未登记 getObjectDdl')
    // redis 段不应有该 op（redis 没有过程/触发器概念）
    const redisBlock = IDX.slice(IDX.indexOf('redis: {'), IDX.indexOf('redis: {') + 900)
    assert.ok(!redisBlock.includes('getObjectDdl'), 'redis 不应开放 getObjectDdl')
    assert.ok(blocks.length > 1)
  })

  test('对象名参数化 / 标识符引用，不裸拼（注入面）', () => {
    const mysqlSrc = read(path.join(DB_CLIENT, 'mysql.js'))
    const pgSrc = read(path.join(DB_CLIENT, 'postgres.js'))
    // MySQL：SHOW CREATE 的库名/对象名必须过 quoteIdent，种类必须来自白名单
    assert.match(mysqlSrc, /DDL_KINDS = \{/)
    assert.match(mysqlSrc, /quoteIdent\(args\.database\).*quoteIdent\(name\)/s)
    assert.match(mysqlSrc, /SHOW CREATE \$\{kind\} \$\{full\}/)
    // PG：一律占位符
    assert.match(pgSrc, /pg_get_functiondef\(\$1\)/)
    assert.match(pgSrc, /pg_get_triggerdef\(t\.oid\)/)
  })

  test('元数据查询全部参数化（库名走 ? 绑定）', () => {
    const mysqlSrc = read(path.join(DB_CLIENT, 'mysql.js'))
    for (const t of ['ROUTINES', 'TRIGGERS', 'EVENTS']) {
      assert.match(
        mysqlSrc,
        new RegExp(`information_schema\\.${t}[\\s\\S]{0,120}WHERE [A-Z_]+ = \\?`),
        `${t} 查询未参数化`
      )
    }
  })
})

describe('B2 前端契约', () => {
  const jsx = read(JSX) + '\n' + read(USE_DB_TREE) + '\n' + read(USE_DB_QUICK_OPEN)
  const constSrc = read(SESSION_CONST)

  test('isLeafNode 认四类对象（跑真实源码行）', () => {
    const line = constSrc.match(/^const isLeafNode = .+$/m)
    assert.ok(line, 'isLeafNode not found in db-session-const.js')
    const fn = vm.runInNewContext('(' + line[0].replace(/^const isLeafNode = /, '') + ')', {})
    for (const t of ['table', 'view', 'procedure', 'function', 'trigger', 'event']) {
      assert.equal(fn({ type: t }), true, `${t} 必须是叶子，否则树里点不开`)
    }
    assert.equal(fn({ type: 'schema' }), false)
    assert.equal(fn({ type: 'group' }), false, '分组节点不是叶子')
  })

  test('树渲染有分组分支与对象标记，点击分支走 showObjectDdl', () => {
    assert.match(jsx, /node\.type === 'group'/)
    assert.match(jsx, /DB_OBJECT_MARKS\[node\.type\]/)
    assert.match(jsx, /isDbObjectType\(node\.nodeType\)/)
    assert.match(jsx, /'getObjectDdl'/)
  })

  test('U4：五类对象各有图标，分组图标与组内叶子同源', () => {
    const block = jsx.match(/const DB_OBJECT_ICONS = \{([\s\S]*?)\n\}/)
    assert.ok(block, 'DB_OBJECT_ICONS not found')
    for (const t of ['view', 'procedure', 'function', 'trigger', 'event']) {
      assert.match(block[1], new RegExp(t + ': <\\w+Outlined />'), `${t} 缺图标`)
    }
    const group = jsx.match(/const DB_GROUP_ICONS = \{([\s\S]*?)\n\}/)
    assert.ok(group, 'DB_GROUP_ICONS not found')
    for (const g of ['routine', 'trigger', 'event']) {
      assert.match(group[1], new RegExp(g + ': <\\w+Outlined />'), `${g} 分组缺图标`)
    }
  })

  test('U4：分组/schema 计数徽标，计数只数叶子对象', () => {
    assert.match(constSrc, /const countTreeLeaves = nodes =>/)
    // 分组节点用 children 长度；schema 用递归叶子数（分组容器自身不算）
    assert.match(jsx, /db-tree-count'>\{\(node\.children \|\| \[\]\)\.length\}/)
    assert.match(jsx, /db-tree-count'>\{countTreeLeaves\(node\.children\)\}/)
    // 递归体引用自身，必须连同 const 声明一起求值（只取箭头表达式会 ReferenceError）
    const src = constSrc.match(/^const countTreeLeaves = [\s\S]*?\n\)\n/m)[0]
    const fn = vm.runInNewContext(
      src + '; countTreeLeaves',
      { isLeafNode: n => ['table', 'view', 'procedure', 'function', 'trigger', 'event'].includes(n.type) }
    )
    assert.equal(fn([
      { type: 'table' },
      { type: 'view' },
      { type: 'group', children: [{ type: 'procedure' }, { type: 'function' }] }
    ]), 4)
  })

  test('U4：树的悬停/选中用数据网格同一套 token', () => {
    const styl = read(path.join(ROOT, 'src/client/components/database/db-session.styl'))
    assert.match(styl, /\.ant-tree-node-content-wrapper:hover\n\s+background var\(--hover-bg\)/)
    assert.match(styl, /\.ant-tree-node-content-wrapper\.ant-tree-node-selected\n\s+background var\(--active-bg\)/)
    // 图标颜色全部走 token；不允许出现裸色值
    const iconBlock = styl.slice(styl.indexOf('.db-tree-obj-icon\n'), styl.indexOf('.db-tree-count'))
    assert.ok(iconBlock.length > 0)
    for (const t of ['is-view', 'is-procedure', 'is-function', 'is-trigger', 'is-event']) {
      assert.ok(iconBlock.includes('&.' + t), `${t} 颜色未定义`)
    }
    assert.equal(/#[0-9a-fA-F]{3,8}|rgba?\(/.test(iconBlock), false, '图标颜色不得写裸色值')
  })

  test('分组文案中英齐全', () => {
    const loc = read(LOCALES)
    for (const k of ['dbRoutines', 'dbTriggers', 'dbEvents']) {
      const hits = loc.match(new RegExp('^\\s{2}' + k + ':', 'gm')) || []
      assert.equal(hits.length, 2, `${k} 需同时存在于 en 与 zhCn`)
    }
  })
})
