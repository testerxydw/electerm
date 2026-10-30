// H4 结构对比弹层：入口接线 + 取数口径 + 只读边界 + 样式/词条（源码级）
//
// 对比算法的数学部分由 db-structure-diff.spec.js 钉死；这里钉"接到一起之后
// 容易悄悄坏掉"的几件事：
//   · 打开时只拉两边结构，refresh:true 绕过 60s 结构缓存（刚改过的表不能被旧缓存比）
//   · 换过选择后加载失败，不能拿上一对表的结构配新选择 —— 结论错得看不出来
//   · 只读：弹层不碰 IPC、不出现任何写命令词（"对比"最容易被顺手加成"同步"）
//   · 报告来自纯函数，复制按钮只是把 Markdown 交给 clipboard
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const VIEW = path.join(ROOT, 'src/client/components/database/db-structure-diff.jsx')
const SESSION = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

const read = p => fs.readFileSync(p, 'utf8')

function blockOf (src, anchor) {
  const at = src.indexOf(anchor)
  assert.notEqual(at, -1, `anchor not found: ${anchor}`)
  const end = src.indexOf('\n  }\n', at)
  assert.notEqual(end, -1, `block end not found for: ${anchor}`)
  return src.slice(at, end + 4)
}

describe('H4 结构对比：入口与表清单', () => {
  test('结构页工具条有「结构对比」入口，弹层由 db-session 挂载（Redis 不挂）', () => {
    const s = read(SESSION)
    assert.match(s, /e\('dbStructDiff'\)/, '工具条按钮文案缺失')
    assert.match(s, /onClick=\{openStructureDiff\}/, '工具条按钮没接到 openStructureDiff')
    assert.match(s, /<DbStructureDiff[\s\S]{0,500}tables=\{diffTables\}/, '弹层没接表清单')
    assert.match(s, /<DbStructureDiff[\s\S]{0,500}loadStructure=\{loadDiffStructure\}/, '弹层没接取数通道')
    assert.match(s, /!isRedis\s*\?\s*\(\s*<DbStructureDiff/, 'DbStructureDiff 没有 isRedis 守卫')
  })

  test('候选表来自已加载 metadata：只收当前库的表，不收视图与分组', () => {
    const s = read(SESSION)
    const memo = blockOf(s, 'const diffTables = useMemo(() => {')
    assert.match(memo, /metadata/, '必须走已加载的 metadata（零请求）')
    assert.match(memo, /node\.type === 'table' \|\| !node\.type/, '只收表')
    assert.ok(!/node\.type === 'view'/.test(memo), '视图没有索引/外键，比出来全是噪声')
    assert.match(memo, /node\.type === 'group'\)\s*\{/, '对象分组要跳过')
    assert.match(memo, /sqlDbName/, '限定当前库（v1 不比跨库）')
    assert.ok(!/runGlobalAsync/.test(memo), '候选表不该发请求')
  })

  test('打开时以当前表为 A，关闭即复位', () => {
    const s = read(SESSION)
    const open = blockOf(s, 'const openStructureDiff = () => {')
    assert.match(open, /base: sel \?/, '当前选中的表应作为 A（基准）')
    assert.match(open, /table: sel\.table/, 'A 的取数目标缺表名')
    const close = blockOf(s, 'const closeStructureDiff = () => {')
    assert.match(close, /open: false, base: null/, '关闭要复位')
  })
})

describe('H4 结构对比：取数口径', () => {
  test('两边结构走 getTableStructure + refresh（绕过 60s 缓存）', () => {
    const s = read(SESSION)
    const fn = blockOf(s, 'const loadDiffStructure = useCallback(target => window.pre.runGlobalAsync(')
    assert.match(fn, /'dbClientOp', tabId, 'getTableStructure'/)
    assert.match(fn, /refresh: true/, '对比必须取当下这一版结构')
    assert.match(fn, /schema: target\.schema \|\| ''/, 'schema 缺省要补空串')
    // 主进程侧确实认这个开关
    const main = read(path.join(ROOT, 'src/app/lib/db-client/index.js'))
    assert.match(main, /const refresh = args && args\.refresh === true/)
    assert.match(main, /if \(!refresh && cache\.values\.has\(key\)\)/)
  })

  test('选择齐了才加载；两边并发取；过期响应丢弃', () => {
    const view = read(VIEW)
    assert.match(view, /Promise\.all\(\[loadStructure\(base\), loadStructure\(target\)\]\)/,
      '两边结构应并发取')
    assert.match(view, /token !== tokenRef\.current/, '过期响应必须丢弃')
    assert.match(view, /if \(!open \|\| !pairKey\) \{\s*\n\s*return/, '两张表都选好之前不该发请求')
  })

  test('换过选择后失败：旧结构不能配新选择画出来', () => {
    const view = read(VIEW)
    assert.match(view, /loaded\.key !== pairKey/, '差异只在"加载时的那一对表"仍然成立时才画')
    const load = blockOf(view, 'const load = useCallback(() => {')
    assert.match(load, /setLoaded\(\{ key, base: a \|\| null, target: b \|\| null \}\)/, '成功后要记下这对表的 key')
    const close = blockOf(view, 'const close = useCallback(() => {')
    assert.match(close, /tokenRef\.current\+\+/, '关弹层要作废在途请求')
  })
})

describe('H4 结构对比：只读边界与报告', () => {
  test('弹层不碰 IPC、不出现写命令词', () => {
    const view = read(VIEW)
    assert.ok(!/runGlobalAsync|dbClientOp/.test(view), '取数归 db-session，弹层只做呈现')
    // 外键的 ON DELETE / ON UPDATE 是结构属性的名字，不是写命令，先摘掉再查
    const bare = view.replace(/ON (DELETE|UPDATE)/g, '')
    assert.ok(!/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT)\b/.test(bare),
      '对比弹层不该出现任何写/DDL 关键字')
  })

  test('差异与报告都来自纯函数，复制按钮只交付文本', () => {
    const view = read(VIEW)
    assert.match(view, /import \{ diffTableStructure, diffToMarkdown \} from '\.\.\/\.\.\/common\/db-structure-diff'/)
    assert.match(view, /diffTableStructure\(loaded\.base, loaded\.target, \{ dialect \}\)/, '对比必须带方言')
    const copyFn = blockOf(view, 'const copyReport = () => {')
    assert.match(copyFn, /diffToMarkdown\(\{/, '报告由纯函数生成')
    assert.match(copyFn, /copy\(/, '复制走 clipboard 通道')
    assert.match(view, /disabled=\{!diff\}/, '没有结果时复制按钮要禁用')
  })

  test('方向固定：A 基准、B 对比，状态标签不随选择漂', () => {
    const view = read(VIEW)
    assert.match(view, /status === 'added'[\s\S]{0,120}e\('dbStructDiffOnlyB'\)/, 'added = 只在 B')
    assert.match(view, /status === 'removed'[\s\S]{0,120}e\('dbStructDiffOnlyA'\)/, 'removed = 只在 A')
    assert.match(view, /entry\.status === 'added' \? entry\.target : entry\.base/, '只在一边的条目要显示那一边的原值')
  })

  test('三种状态各有话说：没选齐 / 一致 / 加载失败', () => {
    const view = read(VIEW)
    assert.match(view, /e\('dbStructDiffPick'\)/, '没选齐时要有引导')
    assert.match(view, /e\('dbStructDiffSame'\)/, '没有差异要明说，不是空白')
    assert.match(view, /e\('dbStructDiffFailed'\)/, '失败要有报错条')
    assert.match(view, /e\('dbStructDiffColumns'\)[\s\S]{0,200}e\('dbStructDiffIndexes'\)[\s\S]{0,200}e\('dbStructDiffFks'\)/,
      '列/索引/外键三节都在')
  })
})

describe('H4 结构对比：样式与词条', () => {
  test('差异列表单独滚动，颜色全走 token', () => {
    const styl = read(STYL)
    const at = styl.indexOf('.db-diff\n')
    assert.notEqual(at, -1, '对比弹层样式块缺失')
    const b = styl.slice(at, styl.indexOf('.db-ddl-pre', at))
    assert.match(b, /\.db-diff-body\n\s+max-height 56vh\n\s+overflow auto/, '差异列表要自己滚，不撑爆弹层')
    assert.match(b, /color var\(--error\)/, '仅在 A 用错误色')
    assert.match(b, /color var\(--success\)/, '仅在 B 用成功色')
    assert.match(b, /color var\(--warn\)/, '有差异用警示色')
    assert.match(b, /font-family var\(--db-code-font, var\(--font-mono\)\)/, '表名/值走数据面字体链')
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(b), '样式块里不该出现写死的十六进制颜色')
  })

  test('弹层用到的每个 dbStructDiff* 词条都有中英两份，键集合一致', () => {
    const view = read(VIEW) + read(SESSION)
    const keys = [...new Set([...view.matchAll(/e\('(dbStructDiff[A-Za-z]+)'\)/g)].map(m => m[1]))]
    // 字段名那批（dbStructDiffField*）走 FIELD_KEY 映射，不经 e() 字面量，单独核对
    const fieldKeys = [...new Set([...view.matchAll(/'(dbStructDiffField[A-Za-z]+)'/g)].map(m => m[1]))]
    assert.ok(fieldKeys.length >= 13, `字段名词条应有 13+ 个，实际 ${fieldKeys.length} 个`)
    assert.ok(keys.length >= 17, `dbStructDiff* 文案词条应有 17+ 个，实际 ${keys.length} 个`)
    const extra = require(LOCALES)
    for (const k of new Set([...keys, ...fieldKeys])) {
      assert.equal(typeof extra.en[k], 'string', `${k} 缺英文词条`)
      assert.equal(typeof extra.zh_cn[k], 'string', `${k} 缺中文词条`)
    }
    const pick = obj => Object.keys(obj).filter(k => /^dbStructDiff/.test(k)).sort()
    assert.deepEqual(pick(extra.zh_cn), pick(extra.en))
  })
})
