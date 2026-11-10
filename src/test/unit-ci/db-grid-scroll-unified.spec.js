/**
 * 统一滚动通道契约（SSOT 护栏）：
 * ① 可虚拟化的大数据网格 → db-grid-table.jsx 的 DbGridTable（scroll.y + virtual + ResizeObserver）
 * ② 树形 / expandable 且外层已定高的非虚拟表格 → db-session.styl 的 .db-sticky-thead
 * 组件层（jsx）不得再手写 scroll.y / virtual / position:sticky，否则未来回退无人发现。
 *
 * 沿用 db-grid-scroll.spec.js 的「vm 抽真实源码求值」：跑发布代码而非拷贝；
 * 测试自身只依赖 fs / vm / path，不碰 DOM、ResizeObserver、Electron。
 */
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const DB_DIR = path.join(ROOT, 'src/client/components/database')
const GRID_TABLE = path.join(DB_DIR, 'db-grid-table.jsx')
const KEY_SPACE = path.join(DB_DIR, 'db-redis-key-space.jsx')
const INFO = path.join(DB_DIR, 'db-redis-info.jsx')
const EXPLAIN = path.join(DB_DIR, 'db-explain-tree.jsx')
const STYL = path.join(DB_DIR, 'db-session.styl')

const read = (f) => fs.readFileSync(f, 'utf8')

// 抽 DbGridTable 函数体（顶层、零外部闭包依赖），与 db-grid-scroll.spec.js 同口径
const fnBody = () => {
  const src = read(GRID_TABLE)
  const m = src.match(/function DbGridTable \([\s\S]*?\n\}/)
  assert.ok(m, 'DbGridTable definition not found in db-grid-table.jsx')
  return m[0]
}

// 跑真实源码的 y 推导表达式
const calcY = () => {
  const m = fnBody().match(/const y = (wrapH[^\n]+)$/m)
  assert.ok(m, 'y derivation not found inside DbGridTable')
  return vm.runInNewContext('(function (wrapH, headH, pagerH) { return ' + m[1] + ' })', {})
}

// 跑真实源码的 wrap style 三元表达式
const evalWrapStyle = () => {
  const m = fnBody().match(/ref=\{wrapRef\} style=\{([^\n]+)\}/)
  assert.ok(m, 'wrap style expression not found inside DbGridTable')
  return vm.runInNewContext('(function (style, height) { return ' + m[1] + ' })', {})
}

// 剥掉注释：契约统计的是"代码里手写的滚动逻辑"，不能把注释措辞算进去
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

describe('统一滚动通道：DbGridTable 是唯一 JS 实现（真实源码）', () => {
  test('解构含 height 且 <Table {...rest} 不泄漏 height', () => {
    const body = fnBody()
    assert.match(body, /const \{ className = '', style, height, \.\.\.rest \} = props/)
    assert.match(body, /<Table\s*\n\s*\{\.\.\.rest\}/)
    const tableTag = body.match(/<Table[\s\S]*?\/>/)
    assert.ok(tableTag, 'antd <Table> tag not found inside DbGridTable')
    assert.doesNotMatch(tableTag[0], /\bheight=/, 'height must not leak to antd Table')
  })

  test('wrap style 三元逐字保留（弹层定高 / 普通页面走原 style）', () => {
    const src = read(GRID_TABLE)
    assert.ok(
      src.includes('style={height != null ? { ...style, height } : style}'),
      'wrap style drifted'
    )
  })

  test('const y 推导表达式逐字保留', () => {
    const src = read(GRID_TABLE)
    assert.ok(
      src.includes('const y = wrapH > 0 && headH > 0 && wrapH > headH + pagerH ? wrapH - headH - pagerH : 0'),
      'y derivation drifted'
    )
  })

  test('virtual / scroll 仍由 DbGridTable 统一提供', () => {
    const src = read(GRID_TABLE)
    assert.ok(src.includes('virtual={y > 0}'), 'virtual switch drifted')
    assert.ok(src.includes("scroll={{ x: 'max-content', ...(y > 0 ? { y } : {}) }}"), 'scroll prop drifted')
  })
})

describe('统一滚动通道：边界求值（vm 跑真实源码）', () => {
  const calc = calcY()
  const wrapStyle = evalWrapStyle()

  test('height 不传 → wrap style 原样返回调用者的 style 引用（普通页面行为零变更）', () => {
    const s = { color: 'red' }
    assert.equal(wrapStyle(s, undefined), s)
    assert.equal(wrapStyle(undefined, undefined), undefined)
  })

  test('height 传入 → 合并出确定高度，供弹层 ResizeObserver 实测', () => {
    // vm.runInNewContext 是另一个 realm：跨 realm 对象不能 deepStrictEqual
    // （原型链不同，AGENTS.md §5.2.7 的既有教训），故逐属性断言
    const merged = wrapStyle({ color: 'red' }, 460)
    assert.equal(merged.color, 'red')
    assert.equal(merged.height, 460)
    assert.equal(Object.keys(merged).length, 2)
    // style 缺省时对象展开 undefined 得到空对象，不炸
    const bare = wrapStyle(undefined, 400)
    assert.equal(bare.height, 400)
    assert.equal(Object.keys(bare).length, 1)
  })

  test('wrapH=0 / headH=0 / wrapH <= headH+pagerH → y=0（保留外层滚动降级）', () => {
    assert.equal(calc(0, 0, 0), 0)
    assert.equal(calc(0, 38, 0), 0)
    assert.equal(calc(702, 0, 0), 0)
    assert.equal(calc(30, 38, 0), 0)
    assert.equal(calc(702, 38, 702), 0)
  })

  test('弹层定高 460/400/380 + headH=38 + pagerH=0 → y=422/362/342', () => {
    assert.equal(calc(460, 38, 0), 422)
    assert.equal(calc(400, 38, 0), 362)
    assert.equal(calc(380, 38, 0), 342)
  })
})

describe('统一滚动通道：组件层零手写滚动逻辑', () => {
  test('db-redis-key-space.jsx：无裸 Table / scroll / virtual / antd Table import', () => {
    const src = stripComments(read(KEY_SPACE))
    assert.doesNotMatch(src, /<Table\b/, 'bare <Table would bypass the unified wrapper')
    assert.doesNotMatch(src, /scroll=\{\{/, 'no hand-written scroll in modal')
    assert.doesNotMatch(src, /\bvirtual\b/, 'no hand-written virtual in modal')
    assert.doesNotMatch(src, /import \{[^}]*\bTable\b[^}]*\} from 'antd'/)
  })

  test('db-redis-key-space.jsx：4 处表格走 DbGridTable，其中 3 处弹层定高', () => {
    const src = read(KEY_SPACE)
    assert.equal((src.match(/<DbGridTable\b/g) || []).length, 4, '键列表 + 大 Key + Profiler×2')
    assert.equal((src.match(/height=\{460\}/g) || []).length, 1, '大 Key 表格')
    assert.equal((src.match(/height=\{400\}/g) || []).length, 2, 'Profiler 两处')
  })

  test('db-redis-info.jsx：慢日志与键空间两表都收敛到 DbGridTable height={380}', () => {
    const src = read(INFO)
    assert.equal((src.match(/<DbGridTable\s*\n\s*height=\{380\}/g) || []).length, 2, '慢日志 + 键空间同款定高')
    assert.doesNotMatch(src, /scroll=\{\{ y: 340 \}\}/)
    // 整文件不得再裸用 antd Table（键空间曾是白名单小表，现与慢日志对齐）
    assert.doesNotMatch(src, /<Table\b/, 'info 弹层两表都必须走 DbGridTable')
    assert.doesNotMatch(src, /import \{[^}]*\bTable\b[^}]*\} from 'antd'/)
    // 整文件也不许再有任何手写滚动逻辑
    const code = stripComments(src)
    assert.doesNotMatch(code, /scroll=\{\{[^}]*\by\b/)
    assert.doesNotMatch(code, /\bvirtual\b/)
    assert.doesNotMatch(code, /position:?\s*sticky/)
  })

  test('db-explain-tree.jsx：挂共用 sticky class，组件层无滚动逻辑', () => {
    const src = read(EXPLAIN)
    assert.ok(src.includes("className='db-explain-tree db-sticky-thead'"), 'must reuse the shared sticky class')
    const code = stripComments(src)
    assert.doesNotMatch(code, /scroll=\{\{[^}]*\by\b/)
    assert.doesNotMatch(code, /\bvirtual\b/)
    assert.doesNotMatch(code, /position:?\s*sticky/, 'sticky belongs to db-session.styl only')
    assert.match(code, /defaultExpandAllRows/, '树展开交互必须零变更')
  })

  test('SSOT：仅白名单的吸顶定义（表头×2 + 控制台输入行），新增分叉必须显式登记', () => {
    const styl = read(STYL)
    assert.equal((styl.match(/^\.db-sticky-thead\b/gm) || []).length, 1, 'sticky class must be defined once')
    assert.match(styl, /\.db-sticky-thead[\s\S]{0,300}\.ant-table-thead th[\s\S]{0,200}position sticky/)
    // 既存的「自定义 div grid 表头行」吸顶（db-session.jsx:4430）是另一渲染结构，
    // 显式登记为白名单，避免被误判成新增分叉
    assert.match(styl, /\.db-tx-row-head[\s\S]{0,120}position sticky/)
    // Redis 控制台输入行 sticky 钉顶（db-session.styl:1601）：历史滚动时输入框不滚走，
    // 属于「输入行」而非「表头」吸顶，单独登记、不与表头 SSOT 混为一谈
    assert.match(styl, /\.db-redis-console-input[\s\S]{0,120}position sticky/)
    // 结构对比控制组 sticky 钉顶（db-session.styl .db-diff-head）：差异列表随弹层 body
    // 滚动时，选择/概览/落编辑器工具条常驻可见 —— 同样属于「控制条」吸顶，不是表头分叉
    assert.match(styl, /\.db-diff-head[\s\S]{0,120}position sticky/)
    // 放宽到 stylus 也允许的 `position: sticky`（带冒号）写法，避免同类分叉绕过计数。
    // 全仓 db-session.styl 的 position sticky 必须恰好落在白名单四处，
    // 任何第五处（例如新的表头吸顶分叉）都会让计数 != 4 而告警
    const stickyHits = styl.match(/^\s*position\s*:?\s*sticky\s*$/gm) || []
    const importantHits = styl.match(/^\s*position\s*:?\s*sticky\s+!important\s*$/gm) || []
    assert.equal(
      stickyHits.length + importantHits.length,
      4,
      'only .db-tx-row-head (legacy) + .db-sticky-thead (SSOT) + .db-redis-console-input (pinned input) + .db-diff-head (pinned diff controls) may exist'
    )
  })

  test('护栏：.db-sticky-thead 的 position sticky 必须带 !important 优先级保障', () => {
    const styl = read(STYL)
    // 与 SSOT test 同一抽取口径：从类定义起，.ant-table-thead th 的 position 声明必须带 !important。
    // 起因：antd CSS-in-JS 运行时注入 .ant-table-thead>tr>th{position:relative}，
    // 其选择器特异性 / 注入顺序压过静态 style-*.css 里的裸 position sticky，
    // QA 实机反证 th.style.setProperty('position','sticky','important') 后立即吸顶。
    assert.match(
      styl,
      /\.db-sticky-thead[\s\S]{0,300}\.ant-table-thead th[\s\S]{0,200}position\s*:?\s*sticky\s+!important/,
      'sticky 必须带 !important，否则运行时会被 antd CSS-in-JS 覆盖回 relative'
    )
    // 能力边界：静态字符串断言只能钉死「源码里写了 !important」，
    // 无法发现「CSS 已产出但运行时被更高优先级或更晚注入的规则覆盖」——
    // 这类回归只有实机 getComputedStyle + 真实滚轮能发现（本轮 QA 暴露的教训）。
  })

  test('SSOT：database 组件层（不含 db-grid-table.jsx）手写 scroll.y / virtual 计数为 0', () => {
    const files = fs.readdirSync(DB_DIR)
      .filter(f => /\.jsx?$/.test(f) && f !== 'db-grid-table.jsx')
    assert.ok(files.length > 10, 'component layer scan looks incomplete: ' + files.length)
    // 允许保留裸 <Table> 的白名单：这些表不在定高滚动容器内 / 走 CSS sticky 分支，
    // 但一律禁止组件里再写 scroll.y / virtual（这才是「各自为政」的根源）。
    const bareTableAllowlist = new Set([
      // 树形表：走 .db-sticky-thead
      'db-explain-tree.jsx'
    ])
    for (const f of files) {
      const code = stripComments(read(path.join(DB_DIR, f)))
      const scrollY = code.match(/scroll=\{\{[^}]*\by\b/g) || []
      // 不要求行首：<Table virtual ...> 同行简写也必须被拦住
      const virtual = code.match(/\bvirtual\b/g) || []
      assert.equal(scrollY.length, 0, f + ' 不得手写含 y 的 scroll')
      assert.equal(virtual.length, 0, f + ' 不得手写 virtual prop')
      if (!bareTableAllowlist.has(f)) {
        assert.doesNotMatch(code, /<Table\b/, f + ' 的表格必须走 DbGridTable')
      }
    }
    // 白名单本身不许悄悄扩张或指向不存在的文件
    assert.ok([...bareTableAllowlist].every(f => files.includes(f)), 'allowlist must reference real files')
  })
})
