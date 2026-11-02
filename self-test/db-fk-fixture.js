/**
 * 外键夹具：一个真带外键的 SQLite 库文件（H3b / H3a / H4 的外键分支补测用）
 *
 * 为什么需要它：真库那边能读的库（MariaDB `tgfsom`）全库 0 外键，且生产库禁止 DDL，
 * 所以"数据字典的外键节""结构对比的外键差异""ER 图的真取数""关联侧栏"四条
 * 靠外键才有意义的分支，此前只有单测与桩证据。这里给一个本机文件、真引擎、
 * 真外键的库，把这几条分支跑到有实证为止。
 *
 * 三层对账（防止"自己对自己"）：
 *   1. DECLARED —— 本模块里按 DDL 字面写下来的期望（我声明了什么）；
 *   2. readForeignKeys —— 宿主侧自己解析 `PRAGMA foreign_key_list` 的原始行（引擎说了什么）；
 *   3. 界面读数 —— 产品经自己的适配器 + IPC + 渲染层给出来的东西（用户看到什么）。
 * 判据拿 3 对 1，2 只用来钉"夹具本身是不是我以为的形状"。
 * 这样当 PRAGMA 的实况和直觉不一致时（例：省略 ON 子句时 SQLite 报的是 `NO ACTION`
 * 而不是空串），第 2 层会先红，而不是让界面判据跟着一起错。
 */
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const FIXTURE_DIR = '/tmp/electerm-h8a/fk'
const FIXTURE_FILE = path.join(FIXTURE_DIR, 'fk.db')

const DDL = [
  // 父表：三张单列主键/复合主键的参照目标，列名刻意和子表的不完全同名，
  // 免得"引用列"读错时被同名掩盖
  'CREATE TABLE dim_single (id INTEGER PRIMARY KEY, code TEXT)',
  'CREATE TABLE dim_second (id INTEGER PRIMARY KEY, tag TEXT)',
  'CREATE TABLE dim_pair (pa TEXT NOT NULL, pb INTEGER NOT NULL, label TEXT, PRIMARY KEY (pa, pb))',

  // 单列外键 + 两个动作都显式写
  `CREATE TABLE fk_explicit (
    id INTEGER PRIMARY KEY,
    ref INTEGER REFERENCES dim_single (id) ON DELETE CASCADE ON UPDATE RESTRICT)`,

  // 省略 ON 子句：SQLite 的 PRAGMA 给的是 NO ACTION（不是空串），
  // 这条决定字典里"删除动作"列在 SQLite 上永远不为空
  `CREATE TABLE fk_defaults (
    id INTEGER PRIMARY KEY,
    ref INTEGER REFERENCES dim_single (id))`,

  // 复合外键，列序 (pa, pb) 与引用列序一一对应
  `CREATE TABLE fk_composite (
    id INTEGER PRIMARY KEY,
    pa TEXT NOT NULL,
    pb INTEGER NOT NULL,
    FOREIGN KEY (pa, pb) REFERENCES dim_pair (pa, pb) ON DELETE CASCADE)`,

  // 复合外键但省略引用列：PRAGMA 每列的 to 是 NULL，
  // 产品必须回落到目标表主键 (pa, pb) —— 回落错就成了字典/ER 里一条不存在的外键
  `CREATE TABLE fk_implicit_cols (
    id INTEGER PRIMARY KEY,
    pa TEXT NOT NULL,
    pb INTEGER NOT NULL,
    FOREIGN KEY (pa, pb) REFERENCES dim_pair)`,

  // 自引用：ER 图要成环不破图，侧栏要同时给"父行"和"子记录"
  `CREATE TABLE fk_self (
    id INTEGER PRIMARY KEY,
    up INTEGER REFERENCES fk_self (id) ON DELETE SET NULL)`,

  // 对照：一张没有任何外键的表（空态与"外键节该不该出现"都靠它）
  'CREATE TABLE fk_none (id INTEGER PRIMARY KEY, note TEXT)',

  // 两条外键：SQLite 不给约束名，产品按 PRAGMA 的 id 合成 fk_<id>。
  // two_fks 与 two_fks_rev 的外键集合、列集、动作完全相同，只换了 FOREIGN KEY
  // 子句的声明顺序 —— 用来把"合成名到底稳不稳"这件事钉成看得见的证据
  `CREATE TABLE two_fks (
    id INTEGER PRIMARY KEY,
    a INTEGER,
    b INTEGER,
    FOREIGN KEY (a) REFERENCES dim_single (id),
    FOREIGN KEY (b) REFERENCES dim_second (id))`,
  `CREATE TABLE two_fks_rev (
    id INTEGER PRIMARY KEY,
    a INTEGER,
    b INTEGER,
    FOREIGN KEY (b) REFERENCES dim_second (id),
    FOREIGN KEY (a) REFERENCES dim_single (id))`,

  // 结构对比三兄弟：列集完全一致，只在外键上有差别（无 / 动作不同 / 只有一边有）
  `CREATE TABLE ord_a (
    id INTEGER PRIMARY KEY,
    pa TEXT,
    pb INTEGER,
    FOREIGN KEY (pa, pb) REFERENCES dim_pair (pa, pb) ON DELETE CASCADE)`,
  `CREATE TABLE ord_b (
    id INTEGER PRIMARY KEY,
    pa TEXT,
    pb INTEGER,
    FOREIGN KEY (pa, pb) REFERENCES dim_pair (pa, pb) ON DELETE SET NULL ON UPDATE CASCADE)`,
  'CREATE TABLE ord_c (id INTEGER PRIMARY KEY, pa TEXT, pb INTEGER)',

  // 视图：结构对比的候选要排除它（视图没有索引/外键），ER 图的节点也不该有它
  'CREATE TABLE plain_seed (id INTEGER PRIMARY KEY, note TEXT)',
  'CREATE VIEW v_child AS SELECT id, ref FROM fk_explicit'
]

// 行数据：关联侧栏要真有父行/子行可显示，全是本机造的假名字，不含任何真实业务数据
const SEED = [
  "INSERT INTO dim_single (id, code) VALUES (1, 'alpha'), (2, 'bravo'), (3, 'charlie')",
  "INSERT INTO dim_second (id, tag) VALUES (10, 'x10'), (20, 'x20')",
  "INSERT INTO dim_pair (pa, pb, label) VALUES ('p1', 1, 'L1'), ('p2', 2, 'L2')",
  'INSERT INTO fk_explicit (id, ref) VALUES (101, 1), (102, 2), (103, NULL)',
  'INSERT INTO fk_defaults (id, ref) VALUES (201, 1), (202, 3)',
  "INSERT INTO fk_composite (id, pa, pb) VALUES (301, 'p1', 1), (302, 'p2', 2)",
  "INSERT INTO fk_implicit_cols (id, pa, pb) VALUES (401, 'p1', 1)",
  'INSERT INTO fk_self (id, up) VALUES (1, NULL), (2, 1), (3, 1)',
  "INSERT INTO fk_none (id, note) VALUES (1, 'no-fk'), (2, NULL)",
  'INSERT INTO two_fks (id, a, b) VALUES (1, 1, 10), (2, 2, 20)',
  'INSERT INTO two_fks_rev (id, a, b) VALUES (1, 1, 10)',
  "INSERT INTO ord_a (id, pa, pb) VALUES (1, 'p1', 1)",
  "INSERT INTO ord_b (id, pa, pb) VALUES (1, 'p2', 2)",
  "INSERT INTO ord_c (id, pa, pb) VALUES (1, 'p1', 1)",
  "INSERT INTO plain_seed (id, note) VALUES (1, 'plain')"
]

// 我声明了什么：与 DDL 字面一一对应（引用列省略处按"目标表主键"写，动作省略处按
// SQLite 实况写 NO ACTION）。省略引用列的外键，PRAGMA 的 to 给 null，
// 期望的引用列来自这里声明的主键，而不是产品自己的那次回落 —— 两条通道独立。
const DECLARED_PK = {
  dim_single: ['id'],
  dim_second: ['id'],
  dim_pair: ['pa', 'pb'],
  fk_self: ['id']
}

// 一条声明：引用表 / 子列 / 引用列（省略时传 null）/ 删除动作 / 更新动作
const d = (refTable, columns, refColumns, onDelete, onUpdate, implicit) => ({
  refTable, columns, refColumns, onDelete, onUpdate, implicitRef: !!implicit
})

const DECLARED = {
  dim_single: [],
  dim_second: [],
  dim_pair: [],
  fk_explicit: [d('dim_single', ['ref'], ['id'], 'CASCADE', 'RESTRICT')],
  fk_defaults: [d('dim_single', ['ref'], ['id'], 'NO ACTION', 'NO ACTION')],
  fk_composite: [d('dim_pair', ['pa', 'pb'], ['pa', 'pb'], 'CASCADE', 'NO ACTION')],
  // 引用列整体省略：PRAGMA 每列的 to 都是 NULL，界面要显示的是目标表主键 (pa, pb)
  fk_implicit_cols: [d('dim_pair', ['pa', 'pb'], null, 'NO ACTION', 'NO ACTION', true)],
  fk_self: [d('fk_self', ['up'], ['id'], 'SET NULL', 'NO ACTION')],
  fk_none: [],
  two_fks: [
    d('dim_single', ['a'], ['id'], 'NO ACTION', 'NO ACTION'),
    d('dim_second', ['b'], ['id'], 'NO ACTION', 'NO ACTION')
  ],
  // 外键集合与 two_fks 完全相同，只把两条 FOREIGN KEY 子句换了声明顺序。
  // 实测（node:sqlite / SQLite 3.46）：PRAGMA foreign_key_list 的 id 是声明顺序的倒序，
  // 于是同一条外键在这两张表里拿到不同的 id。产品没有约束名可用，只能合成 fk_<id>，
  // 这两张表的 fk_0 因此各自指向不同的外键 —— 这条夹具就是为了把这件事钉成证据。
  two_fks_rev: [
    d('dim_second', ['b'], ['id'], 'NO ACTION', 'NO ACTION'),
    d('dim_single', ['a'], ['id'], 'NO ACTION', 'NO ACTION')
  ],
  ord_a: [d('dim_pair', ['pa', 'pb'], ['pa', 'pb'], 'CASCADE', 'NO ACTION')],
  ord_b: [d('dim_pair', ['pa', 'pb'], ['pa', 'pb'], 'SET NULL', 'CASCADE')],
  ord_c: [],
  plain_seed: [],
  v_child: []
}

const TABLE_NAMES = Object.keys(DECLARED)

// 判据用的期望形状。约束**名**不在我的声明里（SQLite 的 DDL 根本不写名字，
// 也没地方可写），它由引擎的 id 决定，所以名字这一格只能取 PRAGMA 的读数；
// 其余每一格（列、引用表、引用列、两个动作）都取我声明的，两者按内容配对。
// 配不上就抛错：宁可脚本开跑就炸，也不要"少了一条外键"被当成界面渲染问题。
function expectedForeignKeys (name, pragma) {
  const want = DECLARED[name] || []
  const got = (pragma && pragma[name]) || []
  if (want.length !== got.length) {
    throw new Error('夹具与 PRAGMA 条数不符：' + name + ' 声明 ' + want.length + ' 引擎 ' + got.length)
  }
  return want.map(fk => {
    const key = fk.columns.join(',') + '→' + fk.refTable
    const hit = got.find(g => g.columns.join(',') + '→' + g.refTable === key)
    if (!hit) {
      throw new Error('声明的外键在 PRAGMA 里找不到：' + name + ' ' + key)
    }
    return {
      name: 'fk_' + hit.id,
      columns: fk.columns.slice(),
      refTable: fk.refTable,
      refColumns: (fk.implicitRef ? DECLARED_PK[fk.refTable] : fk.refColumns) || [],
      onDelete: fk.onDelete,
      onUpdate: fk.onUpdate,
      selfRef: fk.refTable === name
    }
  })
}

// ER 图期望：节点 = 全部基表（视图不进图），边 = 每条外键一条，列对按 seq 对齐
function expectedGraph (pragma) {
  const tables = TABLE_NAMES.filter(n => n !== 'v_child')
  const edges = []
  for (const t of tables) {
    for (const fk of expectedForeignKeys(t, pragma)) {
      edges.push({
        name: fk.name,
        from: t,
        to: fk.refTable,
        columns: fk.columns.map((c, i) => ({ from: c, to: fk.refColumns[i] || '' }))
      })
    }
  }
  return { tables, edges }
}

// 引擎说了什么：宿主侧自己按 seq 聚合 PRAGMA 的行，不 require 产品实现
function readForeignKeys (file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const out = {}
    for (const name of TABLE_NAMES) {
      const rows = db.prepare('PRAGMA foreign_key_list(' + JSON.stringify(name) + ')').all()
      const byId = new Map()
      for (const r of rows) {
        const id = String(r.id)
        if (!byId.has(id)) {
          byId.set(id, { id, refTable: r.table, seq: [] })
        }
        byId.get(id).seq.push({
          seq: Number(r.seq) || 0,
          from: r.from,
          to: r.to,
          onDelete: r.on_delete,
          onUpdate: r.on_update
        })
      }
      out[name] = Array.from(byId.values()).map(g => {
        g.seq.sort((a, b) => a.seq - b.seq)
        return {
          id: g.id,
          refTable: g.refTable,
          columns: g.seq.map(p => p.from),
          refColumnsRaw: g.seq.map(p => p.to),
          onDelete: g.seq[0] ? g.seq[0].onDelete : null,
          onUpdate: g.seq[0] ? g.seq[0].onUpdate : null,
          selfRef: g.refTable === name
        }
      })
    }
    return out
  } finally {
    db.close()
  }
}

// 夹具生效性：外键不是装饰。开启 PRAGMA foreign_keys 后，违反引用的插入必须被拒。
function assertEnforced (file) {
  const db = new DatabaseSync(file)
  try {
    db.prepare('PRAGMA foreign_keys = ON').run()
    const ok = []
    try {
      db.prepare('INSERT INTO fk_explicit (id, ref) VALUES (9999, 7777)').run()
      ok.push(false)
    } catch (e) {
      ok.push(/FOREIGN KEY constraint failed/i.test(String(e.message)))
    }
    try {
      db.prepare("INSERT INTO fk_composite (id, pa, pb) VALUES (9998, 'nope', 1)").run()
      ok.push(false)
    } catch (e) {
      ok.push(/FOREIGN KEY constraint failed/i.test(String(e.message)))
    }
    return ok.every(Boolean)
  } finally {
    db.close()
  }
}

function buildFixture (dir = FIXTURE_DIR, file = FIXTURE_FILE) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(file)
  try {
    db.prepare('PRAGMA foreign_keys = ON').run()
    for (const sql of DDL) {
      db.exec(sql)
    }
    for (const sql of SEED) {
      db.exec(sql)
    }
  } finally {
    db.close()
  }
  return { dir, file, declared: DECLARED, expectedForeignKeys, expectedGraph, pragma: readForeignKeys(file), enforced: assertEnforced(file) }
}

module.exports = {
  FIXTURE_DIR,
  FIXTURE_FILE,
  DDL,
  DECLARED,
  DECLARED_PK,
  TABLE_NAMES,
  buildFixture,
  expectedForeignKeys,
  expectedGraph,
  readForeignKeys,
  assertEnforced
}
