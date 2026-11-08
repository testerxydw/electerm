/**
 * N3b 受限表设计器（草稿模型 + 候选 DDL 预览）
 *
 * 设计文档 §7 N3 的验收原文就是这里的第一组用例：删一列 + 加一索引 + 改注释
 * → 生成 3 条语句，勾选 2 条得 2 条；MySQL 与 PG 各测；对不存在表不产生半截脚本。
 * 其余用例钉的是"这个设计器最容易被做坏"的几件事：
 * - 没动过的草稿必须比出 0 项 —— 一打开就冒假变更，用户就不敢勾
 * - 改名（界面已禁，纯模块再拦一道）不能比成"删一列 + 加一列"，那落库是整列数据没了
 * - DEFAULT '' 与"没有默认值"是两个事实，塌成一个就等于悄悄改了库
 * - 生成口径只有能力位闸，不给引擎名写 if（SQLite 走 alterDdl=false 降级）
 * 组件侧只做源码级断言：不拼 SQL、不碰 IPC、入口与弹层接线、词条与样式齐全。
 */
const { describe, test, before } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const DESIGN = path.join(ROOT, 'src/client/common/db-table-design.js')
const GEN = path.join(ROOT, 'src/client/common/db-ddl-generate.js')
const REASON = path.join(ROOT, 'src/client/common/db-ddl-reason.js')
const VIEW = path.join(ROOT, 'src/client/components/database/db-table-design.jsx')
const AREA = path.join(ROOT, 'src/client/components/database/db-structure-area.jsx')
const SESSION = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const HOOK = path.join(ROOT, 'src/client/components/database/use-db-redis-instance.js')
const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

const read = p => fs.readFileSync(p, 'utf8')

let P
let G
before(async () => {
  P = await import('file://' + DESIGN)
  G = await import('file://' + GEN)
})

const COL = (name, extra = {}) => ({
  name,
  columnType: 'int(11)',
  dataType: 'int',
  nullable: false,
  defaultValue: null,
  comment: null,
  isPrimaryKey: false,
  ordinal: 1,
  maxLength: null,
  ...extra
})

const IDX = (name, columns, extra = {}) => ({
  name,
  unique: false,
  primary: false,
  columns,
  method: 'BTREE',
  ...extra
})

// 当前库里的表：id 主键 + legacy + email，一条 PRIMARY 索引，表注释"老表"
const CURRENT = (over = {}) => ({
  type: 'table',
  comment: '老表',
  columns: [
    COL('id', { isPrimaryKey: true }),
    COL('legacy'),
    COL('email', { columnType: 'varchar(64)', dataType: 'varchar', maxLength: 64 })
  ],
  indexes: [IDX('PRIMARY', ['id'], { primary: true, unique: true })],
  foreignKeys: [],
  ...over
})

const LOC = { database: 'app', schema: 'public', table: 'users' }
const ids = items => items.map(i => i.id)
const linesOf = script => script ? script.split('\n').length : 0

describe('N3b 验收：删一列 + 加一索引 + 改注释', () => {
  const build = () => {
    const current = CURRENT()
    const draft = P.createDraft(current)
    // 删掉 legacy
    draft.columns = draft.columns.filter(c => c.name !== 'legacy')
    // 加一条 ix_email
    const ix = P.newIndex()
    ix.name = 'ix_email'
    ix.columns = ['email']
    draft.indexes = draft.indexes.concat(ix)
    // 改表注释
    draft.comment = '新表'
    return { current, draft }
  }

  for (const dialect of ['mysql', 'postgres']) {
    test(dialect + '：出 3 条，勾 2 条得 2 条', () => {
      const { current, draft } = build()
      const r = P.designPreview({ current, draft, dialect, loc: LOC })
      assert.deepEqual(r.issues, [], '草稿本身不该有硬错误')
      assert.equal(r.items.length, 3,
        '删列 + 加索引 + 改注释应各出 1 项：' + JSON.stringify(ids(r.items)))
      assert.ok(r.items.every(i => i.supported === true),
        '这三类都在能力范围内：' + JSON.stringify(r.items.map(i => i.reason)))
      // 表注释排在最前（它是唯一不在 diff 三段里的东西，单独补进来）
      assert.equal(r.items[0].id, 'table:comment')
      assert.equal(G.buildScript(r.items, ids(r.items).slice(0, 2)).split('\n').length, 2,
        '勾 2 条就该只有 2 条语句')
      const all = G.buildScript(r.items, ids(r.items))
      assert.equal(linesOf(all), 3)
      assert.equal(all.split('\n').every(l => /;$/.test(l)), true, '每条语句都要以分号结尾')
    })
  }

  test('mysql 写 ALTER TABLE，postgres 写 COMMENT ON TABLE', () => {
    const { current, draft } = build()
    const my = G.buildScript(P.designPreview({
      current, draft, dialect: 'mysql', loc: LOC
    }).items, ['table:comment'])
    assert.match(my, /^ALTER TABLE `app`\.`users` COMMENT '新表';$/)
    const pg = G.buildScript(P.designPreview({
      current, draft, dialect: 'postgres', loc: LOC
    }).items, ['table:comment'])
    assert.match(pg, /^COMMENT ON TABLE "public"\."users" IS '新表';$/)
  })

  test('清掉表注释：MySQL 写 COMMENT \'\'，PG 写 IS NULL（都是"没有注释"）', () => {
    const current = CURRENT()
    const draft = P.createDraft(current)
    draft.comment = ''
    for (const [dialect, expect] of [['mysql', /COMMENT ''/], ['postgres', /IS NULL/]]) {
      const r = P.designPreview({ current, draft, dialect, loc: LOC })
      assert.equal(r.items.length, 1, JSON.stringify(ids(r.items)))
      assert.match(G.buildScript(r.items, ['table:comment']), expect)
    }
  })

  test('草稿没动 → 0 项：一打开就冒假变更的话没人敢勾', () => {
    for (const dialect of ['mysql', 'postgres']) {
      const current = CURRENT()
      const r = P.designPreview({
        current,
        draft: P.createDraft(current),
        dialect,
        loc: LOC
      })
      assert.deepEqual(r.items.map(i => i.id), [], dialect + ' 未改动却有差异')
      assert.equal(G.buildScript(r.items, []), '')
    }
  })

  test('同一份草稿再算一次得到同一串语句（预览可反复看）', () => {
    const current = CURRENT()
    const draft = P.createDraft(current)
    draft.columns = draft.columns.filter(c => c.name !== 'legacy')
    const a = G.buildScript(P.designPreview({
      current, draft, dialect: 'mysql', loc: LOC
    }).items, ['column:legacy'])
    const b = G.buildScript(P.designPreview({
      current, draft, dialect: 'mysql', loc: LOC
    }).items, ['column:legacy'])
    assert.equal(a, b)
    assert.match(a, /DROP COLUMN/)
  })
})

describe('N3b 边界：宁可不给语句', () => {
  test('表定位缺失 → 每项 supported=false，勾不出半截脚本', () => {
    const current = CURRENT()
    const draft = P.createDraft(current)
    draft.columns = draft.columns.filter(c => c.name !== 'legacy')
    draft.comment = '新表'
    for (const loc of [null, {}, { database: 'app', table: '' }]) {
      const r = P.designPreview({ current, draft, dialect: 'mysql', loc })
      assert.equal(r.items.length > 0, true, '差异还是得报出来')
      assert.equal(r.items.every(i => i.supported === false), true,
        JSON.stringify(r.items.map(i => i.reason)))
      assert.equal(r.items.every(i => i.reason === 'missing-target-loc'), true)
      assert.equal(G.buildScript(r.items, ids(r.items)), '',
        '没有作用对象时一条都不能拼出去')
    }
  })

  test('改已有列/索引的名 = 草稿硬错误，不给任何语句', () => {
    const current = CURRENT()
    const renamed = P.createDraft(current)
    renamed.columns[1].name = 'legacy2'
    const r1 = P.designPreview({
      current, draft: renamed, dialect: 'mysql', loc: LOC
    })
    assert.deepEqual(r1.issues.map(x => x.code), ['renamed-column'])
    assert.equal(r1.diff, null, '草稿不合法时不该算出比较结果')
    assert.deepEqual(r1.items, [])

    const ixRenamed = P.createDraft(current)
    ixRenamed.indexes[0].name = 'PRIMARY2'
    const r2 = P.designPreview({
      current, draft: ixRenamed, dialect: 'mysql', loc: LOC
    })
    assert.deepEqual(r2.issues.map(x => x.code), ['renamed-index'])
  })

  test('其余草稿硬错误：空名 / 重名 / 索引没列', () => {
    const cases = [
      [d => { d.columns.push(Object.assign(P.newColumn(), { name: '' })) }, 'unnamed-column'],
      [d => { d.columns[1].name = 'ID' }, 'duplicate-column'],
      [d => { d.indexes.push(Object.assign(P.newIndex(), { name: 'a', columns: [] })) }, 'empty-index-columns'],
      [d => {
        d.indexes.push(Object.assign(P.newIndex(), { name: 'x', columns: ['id'] }))
        d.indexes.push(Object.assign(P.newIndex(), { name: 'x', columns: ['email'] }))
      }, 'duplicate-index']
    ]
    for (const [mutate, code] of cases) {
      const current = CURRENT()
      const draft = P.createDraft(current)
      mutate(draft)
      const issues = P.designIssues(draft)
      assert.ok(issues.some(x => x.code === code), code + ' 没被拦住：' +
        JSON.stringify(issues))
      const r = P.designPreview({ current, draft, dialect: 'mysql', loc: LOC })
      assert.deepEqual(r.items, [], code + ' 时不该给语句')
    }
  })

  test('删主键索引不生成 DROP —— 那是把整张表的主键拆了', () => {
    const current = CURRENT()
    const draft = P.createDraft(current)
    draft.indexes = draft.indexes.filter(ix => !ix.primary)
    const r = P.designPreview({ current, draft, dialect: 'mysql', loc: LOC })
    const ix = r.items.filter(i => i.id.indexOf('index:') === 0)
    assert.equal(ix.length, 1, JSON.stringify(ids(r.items)))
    assert.equal(ix[0].supported, false)
    assert.equal(ix[0].reason, 'primary-index')
    assert.equal(G.buildScript(r.items, ids(r.items)).indexOf('DROP INDEX'), -1)
  })

  test('SQLite 靠能力位降级（不是因为认得这个名字）', () => {
    const current = CURRENT()
    const draft = P.createDraft(current)
    draft.columns = draft.columns.filter(c => c.name !== 'legacy')
    draft.comment = '新表'
    const r = P.designPreview({ current, draft, dialect: 'sqlite', loc: LOC })
    assert.equal(r.items.length > 0, true)
    assert.equal(r.items.every(i => i.supported === false), true)
    assert.equal(r.items.every(i => i.reason === 'alter-unsupported'), true,
      JSON.stringify(ids(r.items)))
    assert.equal(G.buildScript(r.items, ids(r.items)), '')
    // 组件侧的只读横幅走同一条能力位，两边判据一致
    const view = read(VIEW)
    assert.match(view, /capabilityOf\(dialect, 'alterDdl'\)/)
  })

  test('非 SQL 引擎（redis）：unknown-dialect 优先，不谎报成"能力不支持"', () => {
    const out = G.tableCommentDdl('新表', '老表', 'redis', LOC)
    assert.deepEqual(out, { sqls: [], supported: false, reason: 'unknown-dialect' })
  })
})

describe('N3b 草稿保真：改一处不能顺带动别处', () => {
  test("DEFAULT '' 与\"没有默认值\"是两回事", () => {
    const current = CURRENT({
      comment: null,
      columns: [COL('code', { defaultValue: '' }), COL('name', { defaultValue: null })]
    })
    const draft = P.createDraft(current)
    assert.equal(draft.columns[0].hasDefault, true, "有 DEFAULT '' 的列要认出来")
    assert.equal(draft.columns[0].defaultValue, '')
    assert.equal(draft.columns[1].hasDefault, false)
    // 原样回写 → 零差异（没塌成同一个）
    assert.deepEqual(P.designPreview({
      current, draft, dialect: 'mysql', loc: LOC
    }).items.map(i => i.id), [])
    // 关掉那个勾 → 只报 code 列的 default 变化
    draft.columns[0].hasDefault = false
    const r = P.designPreview({ current, draft, dialect: 'mysql', loc: LOC })
    assert.deepEqual(ids(r.items), ['column:code'])
    assert.match(G.buildScript(r.items, ['column:code']), /MODIFY COLUMN|CHANGE COLUMN|ALTER COLUMN/)
  })

  test('没改过的行带着全部契约字段：maxLength / ordinal / isPrimaryKey 不会弄没', () => {
    const current = CURRENT()
    const structure = P.draftToStructure(P.createDraft(current))
    const email = structure.columns.find(c => c.name === 'email')
    assert.equal(email.maxLength, 64, 'maxLength 是生成类型时的依据，丢了会改坏列')
    assert.equal(email.ordinal, 1)
    const id = structure.columns.find(c => c.name === 'id')
    assert.equal(id.isPrimaryKey, true)
    assert.equal(id.columnType, 'int(11)')
  })

  test('只改注释：目标结构里只有注释这一处不同', () => {
    const current = CURRENT()
    const draft = P.createDraft(current)
    draft.columns[2].comment = '邮箱'
    const structure = P.draftToStructure(draft)
    assert.equal(structure.columns[2].comment, '邮箱')
    assert.equal(structure.columns[1].comment, null)
    const r = P.designPreview({ current, draft, dialect: 'mysql', loc: LOC })
    assert.deepEqual(ids(r.items), ['column:email'])
    // 注释框里只剩空格 = 没填，不能比成一次真变更
    const spaces = P.createDraft(CURRENT())
    spaces.columns[1].comment = '   '
    assert.deepEqual(P.designPreview({
      current: CURRENT(), draft: spaces, dialect: 'mysql', loc: LOC
    }).items.map(i => i.id), [], '注释框里只剩空格不该比成真变更')
  })

  test('外键只透传展示：草稿改不了，也比不出外键差异', () => {
    const current = CURRENT({
      foreignKeys: [{
        name: 'fk_org',
        columns: ['id'],
        refSchema: null,
        refTable: 'org',
        refColumns: ['id'],
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION'
      }]
    })
    const draft = P.createDraft(current)
    assert.equal(draft.foreignKeys.length, 1, '组件要能列出外键')
    // 原样透传当目标：设计器没有改外键的入口，比出"外键被删了"是凭空多出来的噪声
    assert.deepEqual(P.draftToStructure(draft).foreignKeys, current.foreignKeys)
    assert.deepEqual(P.designPreview({
      current, draft, dialect: 'mysql', loc: LOC
    }).items.map(i => i.id), [], '带着外键也不该冒假差异')
  })

  test('主键索引之外还能加唯一索引，且新列走 ADD COLUMN', () => {
    const current = CURRENT({ comment: null })
    const draft = P.createDraft(current)
    const col = P.newColumn()
    col.name = 'nickname'
    col.type = 'varchar(32)'
    draft.columns = draft.columns.concat(col)
    const ix = P.newIndex()
    ix.name = 'ux_nickname'
    ix.columns = ['nickname']
    ix.unique = true
    draft.indexes = draft.indexes.concat(ix)
    const r = P.designPreview({ current, draft, dialect: 'mysql', loc: LOC })
    assert.deepEqual(ids(r.items), ['column:nickname', 'index:ux_nickname'],
      JSON.stringify(ids(r.items)))
    const script = G.buildScript(r.items, ids(r.items))
    assert.match(script, /ADD COLUMN|`nickname` varchar\(32\)/)
    assert.match(script, /UNIQUE INDEX|UNIQUE KEY/)
  })
})

describe('N3b 组件边界：只呈现，不生成、不执行', () => {
  test('组件里不拼一句 SQL，也不碰 IPC 写通道', () => {
    const view = read(VIEW)
    for (const kw of ['ALTER TABLE', 'CREATE INDEX', 'DROP COLUMN', 'DROP INDEX',
      'COMMENT ON', 'ADD COLUMN', 'MODIFY COLUMN']) {
      assert.equal(view.indexOf(kw), -1, '语句写法只能有一个出处：' + kw)
    }
    assert.equal(/window\.pre\./.test(view), false, '取数由 owner 注入的 loadStructure 承担')
    assert.equal(/runGlobalAsync/.test(view), false)
    assert.equal(/dbClientOp/.test(view), false)
    // 唯一的出口是父组件注入的回调
    const apply = view.slice(view.indexOf('const applyScript = () => {'))
    assert.match(apply, /onApplySql\(script\)/)
    assert.match(apply, /if \(!script \|\| !onApplySql\)/)
    assert.match(view, /disabled=\{!script \|\| !onApplySql\}/)
    assert.match(view, /disabled=\{!item\.supported\}/, '不支持的条目不给勾')
  })

  test('语句与差异都来自纯模块，reason 文案走共用映射', () => {
    const view = read(VIEW)
    assert.match(view, /from '\.\.\/\.\.\/common\/db-table-design'/)
    assert.match(view, /designPreview\(\{ current, draft, dialect, loc \}\)/)
    assert.match(view, /buildScript\(items, picked\)/)
    assert.match(view, /e\(ddlReasonKey\(item\.reason\)\)/,
      'reason→词条只能有 db-ddl-reason 一份')
    assert.equal(/const REASON_KEY = \{/.test(view), false, '组件里不得自带一份映射')
    assert.match(view, /setPicked\(\[\]\)\s*\n\s*\}, \[preview\]\)/, '草稿一改就作废勾选')
  })

  test('入口按钮在结构页工具行，视图没有入口（Redis 整个不挂）', () => {
    const area = read(AREA)
    assert.match(area, /\{e\('dbDesign'\)\}/, '工具条按钮文案缺失')
    assert.match(area, /onClick=\{openTableDesign\}/)
    assert.match(area, /structureV2\.type !== 'view'/, '视图没有可 ALTER 的列与索引')
    const s = read(SESSION)
    assert.match(s, /<DbTableDesign[\s\S]{0,600}open=\{structDesign\.open\}/)
    assert.match(s, /<DbTableDesign[\s\S]{0,600}loadStructure=\{loadFreshStructure\}/)
    assert.match(s, /<DbTableDesign[\s\S]{0,600}onApplySql=\{s => applyGeneratedSql\(s, closeTableDesign\)\}/)
    assert.match(s, /!isRedis\s*\?\s*\(\s*<DbTableDesign/, 'Redis 实例不该有表设计器')
    assert.match(s, /openTableDesign=\{openTableDesign\}/, '入口要接到 owner 的 handler')
  })

  test('取数与勾选落地都复用既有通道，不另起炉灶', () => {
    const hook = read(HOOK)
    assert.match(hook, /const \[structDesign, setStructDesign\] = useState\(\{ open: false, loc: null \}\)/)
    assert.match(hook, /const openTableDesign = \(\) => \{/, '入口状态归 owner')
    assert.match(hook, /const closeTableDesign = \(\) => \{/)
    // 两个弹层共用同一个"绕缓存取当下结构"的函数
    assert.match(hook, /const loadFreshStructure = useCallback\(target => window\.pre\.runGlobalAsync\(/)
    assert.equal(/loadDiffStructure/.test(read(SESSION) + hook), false,
      '旧名字残留说明还有一份没合并')
    const s = read(SESSION)
    assert.equal((s.match(/applyGeneratedSql\b/g) || []).length, 3,
      '定义 1 处 + 两个弹层各 1 处，多出来就是有人又写了一份落编辑器逻辑')
  })

  test('样式：布局走 flex，颜色全走 token', () => {
    const styl = read(STYL)
    const at = styl.indexOf('.db-design\n')
    assert.notEqual(at, -1, '设计器样式块缺失')
    const b = styl.slice(at, styl.indexOf('// AI 第一批', at))
    assert.match(b, /\.db-design-row\n\s+display flex/, '每行是弹性行')
    assert.match(b, /\.db-design-cell\n\s+min-width 0/, '控件都要能收缩，长名不撑破行')
    assert.match(b, /&\.is-name\n\s+flex none\n\s+width \d+px/, '名字列宽要定死')
    assert.match(b, /\.db-design-sql\n\s+font-family var\(--db-code-font, var\(--font-mono\)\)/)
    assert.match(b, /color var\(--warn\)/, '不给语句的原因用警示色')
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(b), '样式块里不该出现写死的十六进制颜色')
    assert.match(styl.slice(0, at), /\.db-table-design-modal[\s\S]{0,120}max-height/,
      '弹层主体要自己滚，别把页脚推出屏幕')
  })

  test('词条：组件用到的键与 reason 映射都中英齐备', () => {
    const view = read(VIEW)
    // 只核对数据面自己的词条；refresh/close 这类通用键归主词典，不在 locales-extra
    const keys = [...new Set([...view.matchAll(/e\('(db[A-Za-z0-9_]+)'\)/g)].map(m => m[1]))]
    assert.ok(keys.filter(k => /^dbDesign/.test(k)).length >= 8,
      `dbDesign* 文案词条应有 8+ 个，实际 ${keys.filter(k => /^dbDesign/.test(k)).length} 个`)
    const reasonModule = read(REASON)
    const mapped = [...new Set([...reasonModule.matchAll(/'(dbStructDiffDdl[A-Za-z]+)'/g)]
      .map(m => m[1]))]
    const extra = require(LOCALES)
    for (const k of [...keys, ...mapped]) {
      assert.equal(typeof extra.en[k], 'string', `${k} 缺英文词条`)
      assert.equal(typeof extra.zh_cn[k], 'string', `${k} 缺中文词条`)
    }
    // 能力位闸换了 reason 机器码，词条也得跟着换：不能留一条没人产生的旧文案
    assert.match(reasonModule, /'alter-unsupported': 'dbStructDiffDdlReasonAlter'/)
    assert.match(reasonModule, /'index-no-columns': 'dbStructDiffDdlReasonIndexCols'/)
    assert.equal(/dbStructDiffDdlReasonSqlite/.test(reasonModule + view), false,
      '旧的按引擎名写的文案键还在别处活着')
    const pick = obj => Object.keys(obj).filter(k => /^dbDesign/.test(k)).sort()
    assert.deepEqual(pick(extra.zh_cn), pick(extra.en), 'dbDesign* 中英键集合要一致')
  })
})
