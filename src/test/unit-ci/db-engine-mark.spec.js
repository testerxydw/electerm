// 数据库引擎标识（圆柱 + 引擎色 + 徽标）契约守护
// 拦截：token 丢失/错位、isDbSession 守卫缺失（非 db 类型误渲染）、徽标让位规则回退
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const clientRoot = path.resolve(__dirname, '../../client')
const read = p => fs.readFileSync(path.join(clientRoot, p), 'utf8')

const tokensStyl = read('css/includes/tokens.styl')
const markJsx = read('common/db-engine-mark.jsx')
const tabJsx = read('components/tabs/tab.jsx')
const treeItemJsx = read('components/tree-list/tree-list-item.jsx')
const treeStyl = read('components/tree-list/tree-list.styl')
const tabsStyl = read('components/tabs/tabs.styl')

// 5 引擎枚举（与 bookmark-schemas.js dbType 枚举一致）
const engines = ['mysql', 'redis', 'postgres', 'tidb', 'oceanbase']

describe('db-engine: tokens 定义', () => {
  it(':root 五引擎 token 齐全（tidb/oceanbase 继承 mysql）', () => {
    for (const en of engines) {
      assert.match(tokensStyl, new RegExp('^ {2}--db-engine-' + en + ' ', 'm'),
        '缺少 --db-engine-' + en)
    }
    assert.match(tokensStyl, /^ {2}--db-engine-tidb var\(--db-engine-mysql\)$/m,
      'tidb 应引用 mysql 色（协议同源）')
    assert.match(tokensStyl, /^ {2}--db-engine-oceanbase var\(--db-engine-mysql\)$/m,
      'oceanbase 应引用 mysql 色（协议同源）')
  })

  it('深色提亮值 = 官方色 mix 30% white（防误改回原色导致对比度不足）', () => {
    // mysql #4479A1 / redis #DC382D / postgres #336791 的 30% 提亮近似
    assert.match(tokensStyl, /^ {2}--db-engine-mysql #7CA1BD$/m)
    assert.match(tokensStyl, /^ {2}--db-engine-redis #E7746C$/m)
    assert.match(tokensStyl, /^ {2}--db-engine-postgres #7095B2$/m)
  })

  it('.theme-light 覆盖为官方原色（浅色主题用原品牌色）', () => {
    assert.match(tokensStyl, /^ {2}--db-engine-mysql #4479A1$/m)
    assert.match(tokensStyl, /^ {2}--db-engine-redis #DC382D$/m)
    assert.match(tokensStyl, /^ {2}--db-engine-postgres #336791$/m)
  })

  it('反向：tokens 不得出现重复定义（css-tokens 规则一致）', () => {
    const names = tokensStyl.split('\n')
      .filter(l => /^--[a-z0-9-]+\s/.test(l))
      .map(l => (l.match(/^--(db-engine-[a-z]+)\s/) || [])[1])
      .filter(Boolean)
    const dup = names.filter((n, i) => names.indexOf(n) !== i)
    assert.deepEqual(dup, [])
  })
})

describe('db-engine: 组件与接线契约', () => {
  it('db-engine-mark.jsx：isDbSession 守卫 + 引擎色拼接 + 缺省回落 mysql', () => {
    assert.match(markJsx, /export function isDbSession \(item\)/)
    assert.match(markJsx, /item\.type === terminalDatabaseType/)
    assert.match(markJsx, /var\(--db-engine-' \+ \(dbType \|\| 'mysql'\)/,
      '引擎色必须拼 token 且缺省回落 mysql')
    // 反向：Mark/Badge 都不得硬编码具体引擎色
    assert.doesNotMatch(markJsx, /#[0-9a-fA-F]{6}/, '组件内不得有裸色值')
  })

  it('tab.jsx：圆柱与徽标均带 isDbSession 守卫（非 db tab 不渲染）', () => {
    assert.match(tabJsx, /isDbSession\(tab\) && <DbEngineMark dbType=\{tab\.dbType\} \/>/)
    assert.match(tabJsx, /isDbSession\(tab\) && <DbEngineBadge dbType=\{tab\.dbType\}/)
    // 反向：守卫次数必须 ≥ 渲染次数（无裸 <DbEngineMark 直渲染）
    const guards = (tabJsx.match(/isDbSession\(tab\)/g) || []).length
    const marks = (tabJsx.match(/<DbEngineMark/g) || []).length
    const badges = (tabJsx.match(/<DbEngineBadge/g) || []).length
    assert.ok(guards >= marks + badges, `守卫 ${guards} 次须覆盖 Mark ${marks} + Badge ${badges}`)
  })

  it('tree-list-item.jsx：图标入标题行、徽标在行尾，均带守卫；areEqual 比对 dbType', () => {
    assert.match(treeItemJsx, /isDbSession\(item\) && <DbEngineMark dbType=\{item\.dbType\} \/>/)
    assert.match(treeItemJsx, /isDbSession\(item\) && <DbEngineBadge dbType=\{item\.dbType\} \/>/)
    assert.match(treeItemJsx, /prevProps\.item\.dbType === nextProps\.item\.dbType/,
      'memo 比较须含 dbType，否则改引擎后图标色不更新')
  })
})

describe('db-engine: 形态 styl 契约', () => {
  it('树徽标=描边形态 + hover/touch 让位隐藏', () => {
    assert.match(treeStyl, /\.db-engine-badge[\s\S]*?border 1px solid currentColor/)
    // hover 时操作按钮接管行尾，徽标必须隐藏（三处：标准行/sidebar/add-menu、touch）
    const hoverBlocks = treeStyl.match(/&:hover[\s\S]{0,260}?\.db-engine-badge\s*\n\s*opacity 0/g) || []
    assert.ok(hoverBlocks.length >= 2, 'hover 让位隐藏规则缺失')
    assert.match(treeStyl, /\.is-touch-device[\s\S]*?\.db-engine-badge\s*\n\s*opacity 0/,
      'touch 设备徽标须让位')
  })

  it('tab 徽标=淡底 + 可收缩（宽不足先缩徽标）', () => {
    const block = tabsStyl.match(/\.db-engine-mark[\s\S]*?\.db-engine-badge[\s\S]*?white-space nowrap/)
    assert.ok(block, 'tabs.styl 缺 db 引擎标识形态段')
    assert.match(block[0], /background var\(--hover-bg\)/)
    assert.match(block[0], /flex 0 1 auto/)
    assert.match(block[0], /text-overflow ellipsis/)
  })
})
