// H7a-3 键树视图接线契约
//
// 实机判据在 self-test/db-key-tree-demo.js（假键空间 21 条断言全绿），这里钉的是
// "源码形状"——那些一旦改错、实机不一定立刻看得出来，但语义已经坏掉的点：
//   · 抓取必须走 keysOnly（一键盘发 TYPE+TTL 就是 2 万次往返）
//   · 取消/换库靠令牌丢弃在途响应，不是"祈祷请求快点结束"
//   · 分隔符只重分层，绝不重扫
//   · 大键库不自动摊目录（antd Tree 非虚拟，摊开 = 上万 DOM）
//   · 目录不可选、选中态按"键名"而不是行下标（列表/树共用一个 redisKey）
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const JSX = 'src/client/components/database/db-session.jsx'
// N11a：REDIS_TREE_* 常量与 buildKeyPathIndex 搬到了会话页纯常量段
const SESSION_CONST = 'src/client/common/db-session-const.js'
const STYL = 'src/client/components/database/db-session.styl'
const TREE = 'src/client/common/db-key-tree.js'

// 注释不参与匹配：契约钉的是代码，不是"某句话里提到了某个词"
const codeOf = src => src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')

const block = (src, start, endRe) => {
  const at = src.indexOf(start)
  assert.notEqual(at, -1, '未找到片段：' + start.slice(0, 40))
  const rest = src.slice(at)
  const m = endRe.exec(rest)
  return rest.slice(0, m ? m.index + m[0].length : rest.length)
}

describe('H7a-3 键树抓取', () => {
  const src = codeOf(read(JSX))
  const constSrc = codeOf(read(SESSION_CONST))
  const loader = block(src, 'const loadRedisKeyTree =', /\n {2}\}\n/)

  test('抓取只发 keysOnly，且每轮 COUNT 用常量（不是一页 50 地磨）', () => {
    assert.match(loader, /keysOnly: true/)
    assert.match(loader, /pageSize: REDIS_TREE_SCAN_COUNT/)
    assert.match(constSrc, /const REDIS_TREE_SCAN_COUNT = 1000/, '后端 COUNT 上限就是 1000，别写小')
  })

  test('撞上限停手并标 truncated（不设上限会把渲染进程整死）', () => {
    assert.match(constSrc, /const REDIS_TREE_MAX_KEYS = 10000/)
    assert.match(loader, /names\.length >= REDIS_TREE_MAX_KEYS/)
    assert.match(loader, /truncated = true/)
  })

  test('SCAN 至少一次：按名字去重后才计数', () => {
    assert.match(loader, /seen\.has\(name\)/)
    assert.match(loader, /seen\.add\(name\)/)
  })

  test('取消/换库 = 令牌 +1，且 then 与 catch 两侧都比对令牌', () => {
    assert.match(loader, /keyTreeTokenRef\.current\+\+/)
    assert.match(loader, /token !== keyTreeTokenRef\.current/, '不比对令牌的在途响应会把旧库的键混进来')
    assert.equal((loader.match(/token !== keyTreeTokenRef\.current/g) || []).length >= 3, true,
      'then/catch 每条出口都要比对')
    assert.match(src, /const cancelKeyTree = \(\) => \{\n {4}keyTreeTokenRef\.current\+\+/,
      '取消按钮必须真的把令牌推走')
    assert.match(src, /const resetKeyTree = \(\) => \{\n {4}keyTreeTokenRef\.current\+\+/)
  })

  test('进度是"已收唯一数"，不是转圈动画', () => {
    assert.match(loader, /setKeyTree\(s => \(\{ \.\.\.s, scanned: names\.length \}\)\)/)
    assert.match(src, /e\('dbKeyTreeScanning'\)\.replace\('\{n\}', keyTree\.scanned\)/)
  })
})

describe('H7a-3 视图切换与过滤', () => {
  const src = codeOf(read(JSX))
  const sw = block(src, 'const switchRedisView =', /\n {2}\}\n/)
  const filter = block(src, 'const applyRedisFilter =', /\n {2}\}\n/)

  test('切回键树复用已抓键名：只有 match 变了或还没抓到才重扫', () => {
    assert.match(sw, /keyTree\.match !== pattern \|\| !keyTree\.names\.length/)
    assert.match(sw, /!keyTree\.loading/, '扫描中切回来不该再起一轮')
  })

  test('过滤条件两视图共用（输入框只有一个，切视图不能各用各的）', () => {
    assert.match(filter, /loadRedisKeys\(redisDb, '0', matchInput\)/)
    assert.match(filter, /if \(redisView === 'tree'\) \{\n {6}loadRedisKeyTree\(redisDb, matchInput\)/)
  })

  test('换 db 时两视图一起重来，树缓存作废', () => {
    const sel = block(src, 'const wasTree = redisView', /\n {6}\}\n/)
    assert.match(sel, /resetKeyTree\(\)/, '不清缓存 = 旧库的键名挂在新库的树上')
    assert.match(sel, /if \(wasTree\) \{\n {8}loadRedisKeyTree\(dbIndex, matchInput\)\n {6}\}/)
    assert.equal(/loadRedisKeyTree/.test(sel.replace(/if \(wasTree\) \{[\s\S]*?\n {6}\}/, '')),
      false, '列表视图下换 db 不该起树抓取')
  })

  test('树与列表在同一块区域互斥渲染（不是叠两层）', () => {
    const at = src.indexOf("<div className='db-redis-tree'>")
    assert.notEqual(at, -1)
    // 树分支由三元选中：整块区域只有一个出口
    assert.match(src.slice(at - 140, at), /redisView === 'tree'\n {20}\? \(\n/)
    const area = src.slice(at, at + 4000)
    assert.match(area, /: \(\n {22}<DbGridTable\n {24}className='db-redis-keys'/,
      '列表分支必须还是那张网格')
  })
})

describe('H7a-3 分层与展开', () => {
  const src = codeOf(read(JSX))
  const constSrc = codeOf(read(SESSION_CONST))
  const effect = block(src, 'if (redisView !== \'tree\')', /\n {2}\}, \[redisView, keyTreeBuilt\]\n/)

  test('树只在 names/分隔符变化时重算（改分隔符不重扫）', () => {
    assert.match(src, /buildRedisKeyTree\(keyTree\.names, \{ separator: treeSep \}\)/)
    assert.match(src, /\[keyTree\.names, treeSep\]/)
    const sepInput = block(src, "className='db-redis-tree-sep-input'", /onChange=\{[^}]*\}\n/)
    assert.match(sepInput, /setTreeSep\(ev\.target\.value\)/)
    assert.equal(/loadRedisKeyTree/.test(sepInput), false, '分隔符 onChange 里不许出现抓取')
  })

  test('大键库一个目录都不自动摊（antd Tree 非虚拟，摊开就是上万 DOM）', () => {
    assert.match(constSrc, /const REDIS_TREE_AUTO_EXPAND_KEYS = 500/)
    assert.match(effect, /if \(redisView !== 'tree'\) \{\n {6}return\n {4}\}/)
    assert.match(effect, /keyTreeBuilt\.total <= REDIS_TREE_AUTO_EXPAND_KEYS/)
    assert.match(effect, /collectFolderKeys\(keyTreeBuilt\.nodes, 1\)/)
    assert.match(effect, /:\s*\[\]/, '超过阈值时展开集必须是空')
  })

  test('选中键那一支例外展开（走 ancestorKeys，不遍历整棵树）', () => {
    assert.match(effect, /ancestorKeys\(path, treeSep\)/)
    assert.match(effect, /keyPathIndex\.get\(redisKey\)/)
    assert.match(constSrc, /const buildKeyPathIndex = \(nodes\) => \{/)
  })

  test('纯目录不可选，选中态按键名索引（列表/树共用同一个 redisKey）', () => {
    assert.match(src, /selectable: !!n\.keyName/)
    assert.match(src, /const redisTreeSelected = redisKey && keyPathIndex\.has\(redisKey\)/)
    const onSel = block(src, 'const onRedisTreeSelect =', /\n {2}\}\n/)
    assert.match(onSel, /if \(!node \|\| !node\.keyName\) \{\n {6}return\n {4}\}/)
    assert.match(onSel, /selectRedisKey\(node\.keyName\)/)
  })

  test('分层仍由纯函数负责，组件里不写 split 逻辑', () => {
    assert.match(read(TREE), /export function buildRedisKeyTree/)
    assert.match(read(TREE), /export function ancestorKeys/)
    assert.equal(/names\.split/.test(src), false, 'split 只应出现在 db-key-tree.js')
  })
})

describe('H7a-3 键树样式契约', () => {
  const styl = codeOf(read(STYL))
  const tree = block(styl, '.db-redis-tree\n', /\n\.db-redis-tree-node/)

  test('树容器可滚、可收缩（不给 min-height 0 会在 flex 里撑破分区）', () => {
    assert.match(tree, /min-height 0/)
    assert.match(tree, /overflow auto/)
    assert.match(tree, /flex 1 1 0/)
  })

  test('省略号链条完整：从 antd 的格到我们的标题都允许收缩', () => {
    assert.match(tree, /\.ant-tree-node-content-wrapper[\s\S]{0,120}min-width 0/)
    assert.match(tree, /\.ant-tree-title[\s\S]{0,120}min-width 0/)
    const node = block(styl, '.db-redis-tree-node\n', /\n\.db-redis-tree-count/)
    assert.match(node, /min-width 0/)
    const title = block(styl, '.db-redis-tree-title\n', /\n\.db-redis-tree-count/)
    assert.match(title, /text-overflow ellipsis/)
    assert.match(title, /white-space nowrap/)
  })

  test('计数用 --text-muted 变色，不用 opacity 压暗（U2c 对比度契约）', () => {
    const count = block(styl, '.db-redis-tree-count\n', /\n\.db-redis-tree-empty/)
    assert.match(count, /color var\(--text-muted\)/)
    assert.equal(/opacity/.test(count), false, '变暗一律换色，不用透明度（会把对比度一起拉下去）')
  })

  test('截断态提示色吃 --warn token，不写死色值', () => {
    const status = block(styl, '.db-redis-tree-status\n', /\n\/\/ 上下可拖拽分区/)
    assert.match(status, /&\.is-truncated\n {4}color var\(--warn\)/)
    assert.equal(/#[0-9a-f]{3,8}/i.test(status), false)
    assert.equal(/rgba?\(/.test(status), false)
  })

  test('键树字体与键列表同源（都是代码面文本）', () => {
    assert.match(tree, /font-family var\(--db-code-font, var\(--font-mono\)\)/)
  })
})
