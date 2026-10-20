// T5-5b 会话树状态点契约守护
// 拦截：数据链断裂(srcId 派生丢失)、memo 穿透缺失(绿点不亮/不灭)、
//       组行/设置页误渲染、token 丢失、reduced-motion 降级回退
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const clientRoot = path.resolve(__dirname, '../../client')
const read = p => fs.readFileSync(path.join(clientRoot, p), 'utf8')

const listJsx = read('components/tree-list/tree-list.jsx')
const rowJsx = read('components/tree-list/tree-list-row.jsx')
const itemJsx = read('components/tree-list/tree-list-item.jsx')
const listStyl = read('components/tree-list/tree-list.styl')

describe('tree-session-dot: 数据链契约', () => {
  it('tree-list.jsx render 内派生 activeBookmarkIds (tab.srcId 集合)', () => {
    assert.match(listJsx, /this\.activeBookmarkIds = staticList\s*\n\s*\?\s*null\s*\n\s*:\s*new Set\(window\.store\.tabs\.filter\(t => t\.srcId\)\.map\(t => t\.srcId\)\)/,
      'activeBookmarkIds 派生逻辑缺失或被改写')
    assert.match(listJsx, /hasActiveSession=\{\s*\n?\s*this\.activeBookmarkIds\s*\n?\s*\?\s*this\.activeBookmarkIds\.has\(row\.item\.id\)\s*\n?\s*:\s*false\s*\n?\s*\}/,
      'renderVirtualRow 未传 hasActiveSession')
  })

  it('设置页(staticList)不计算状态点数据', () => {
    // 反向: staticList 分支必须是 null (设置页列表无会话语义)
    const seg = listJsx.slice(listJsx.indexOf('this.activeBookmarkIds = staticList'), listJsx.indexOf('new Set'))
    assert.match(seg, /\?\s*null/, 'staticList 必须置 null')
  })

  it('tree-list-row.jsx: 仅书签行透传, 组行不传', () => {
    assert.match(rowJsx, /hasActiveSession,\s*\n\s*handleExpand/, 'props 解构缺失')
    // 非组分支透传, 组分支的 TreeListItem 不得出现 hasActiveSession
    // (组分支 return 行首缩进 2 空格, 非组分支 4 空格, 用 ^ 锚定取组分支)
    const tail = rowJsx.slice(rowJsx.indexOf('if (!isGroup)'))
    const groupReturn = tail.slice(tail.search(/^ {2}return \(/m))
    assert.ok(!groupReturn.includes('hasActiveSession'), '组行不得渲染状态点')
    const itemCalls = rowJsx.match(/<TreeListItem[\s\S]*?\/>/g) || []
    assert.match(itemCalls[0], /hasActiveSession=\{hasActiveSession\}/,
      '书签行必须透传 hasActiveSession')
    assert.ok(!itemCalls[1].includes('hasActiveSession'), '组行 TreeListItem 不得传 hasActiveSession')
  })
})

describe('tree-session-dot: 渲染与 memo 契约', () => {
  it('tree-list-item.jsx: 带非组守卫渲染状态点', () => {
    assert.match(itemJsx, /\{!isGroup && props\.hasActiveSession && <span className='tree-session-dot' \/>\}/,
      '状态点渲染缺失或守卫不全')
  })

  it('areEqual 必须比较 hasActiveSession (memo 穿透)', () => {
    assert.match(itemJsx, /prevProps\.hasActiveSession === nextProps\.hasActiveSession/,
      'memo 比较缺 hasActiveSession, 活跃态变化不会刷新绿点')
  })
})

describe('tree-session-dot: styl 契约', () => {
  it('绿点用 --success token + pill 圆角, 无裸色值', () => {
    assert.match(listStyl, /^\.tree-session-dot$/m)
    const seg = listStyl.slice(listStyl.indexOf('.tree-session-dot'), listStyl.indexOf('@keyframes'))
    assert.match(seg, /background var\(--success\)/, '必须用 --success token')
    assert.match(seg, /border-radius var\(--radius-pill\)/)
    assert.doesNotMatch(seg, /#[0-9a-fA-F]{3,8}/, '不得有裸 hex')
    assert.match(seg, /animation tree-dot-breathe 2s var\(--ease\) infinite/, '呼吸动画缺失')
  })

  it('呼吸用 opacity (box-shadow 光晕会被守护测试拦截), keyframes 两帧', () => {
    const kf = listStyl.slice(listStyl.indexOf('@keyframes tree-dot-breathe'))
    assert.match(kf, /opacity 1/)
    assert.match(kf, /opacity \.35/)
    assert.doesNotMatch(kf, /box-shadow/, 'keyframes 内不得用 box-shadow')
  })

  it('prefers-reduced-motion 降级为静态', () => {
    assert.match(listStyl, /@media \(prefers-reduced-motion: reduce\)\s*\n\s*\.tree-session-dot\s*\n\s*animation none/)
  })
})
