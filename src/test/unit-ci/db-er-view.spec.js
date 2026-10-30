// H3b-3 ER 图视图：入口接线 + 只读边界 + 交互契约（源码级）
//
// 布局/归一的数学部分由 db-er-layout.spec.js、db-er-graph.spec.js 钉死；这里只钉
// "接到一起之后容易悄悄坏掉"的几件事：
//   · 图是整库快照，打开拉一次就够 —— 组件里出现 setInterval 就是给每台连着的库挂定时任务
//   · 只读：渲染层只画，不碰 IPC，也不出现任何写命令词（ER 图看着像编辑器，最容易长歪）
//   · antd 6 把 .ant-modal-content 改成了 .ant-modal-container：85vh 挂错 class
//     弹层高度就回落到"随内容"，图会被页脚挤扁（实测过一次）
//   · 缩放必须自己挂非 passive 的 wheel：React 的 onWheel 是 passive 的，preventDefault 失效
//   · 拖拽用 mouse 事件：pointer capture 会把随后的 click 重定向，节点单击/双击收不到
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const VIEW = path.join(ROOT, 'src/client/components/database/db-er-view.jsx')
const SESSION = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

const read = p => fs.readFileSync(p, 'utf8')

// 取一个代码块：从 anchor 起，到第一个同缩进的收尾大括号（含）
function blockOf (src, anchor) {
  const at = src.indexOf(anchor)
  assert.notEqual(at, -1, `anchor not found: ${anchor}`)
  const end = src.indexOf('\n  }\n', at)
  assert.notEqual(end, -1, `block end not found for: ${anchor}`)
  return src.slice(at, end + 4)
}

describe('H3b-3 ER 图：入口与取数', () => {
  test('结构页工具条有「ER 图」入口，弹层由 db-session 挂载（Redis 不挂）', () => {
    const s = read(SESSION)
    assert.match(s, /e\('dbErGraph'\)/, '工具条按钮文案缺失')
    assert.match(s, /onClick=\{openErGraph\}/, '工具条按钮没接到 openErGraph')
    assert.match(s, /<DbErView[\s\S]{0,400}onOpenTable=\{openTable\}/, '弹层没接"打开表"')
    assert.match(s, /database=\{sel && sel\.database\}/, '打开表需要当前库名，没传')
    // Redis 没有外键这个概念：isRedis 时不该挂这个弹层
    const guard = /!isRedis\s*\?\s*\(\s*<DbErView/
    assert.match(s, guard, 'DbErView 没有 isRedis 守卫')
  })

  test('打开只拉一次 listForeignKeys（不轮询、带令牌丢弃过期响应）', () => {
    const s = read(SESSION)
    const hits = (s.match(/'listForeignKeys'/g) || []).length
    assert.equal(hits, 1, `listForeignKeys 应只有一处调用，实际 ${hits} 处`)
    const fn = blockOf(s, 'const loadErGraph = () => {')
    assert.match(fn, /runGlobalAsync\('dbClientOp', tabId, 'listForeignKeys', target\)/)
    assert.match(fn, /database: sel\.database, schema: sel\.schema \|\| ''/, '图的参数必须带当前库/schema')
    assert.match(fn, /erTokenRef\.current\+\+/, '连点刷新要作废旧响应')
    assert.match(fn, /token !== erTokenRef\.current/, '过期响应必须丢弃')
    const view = read(VIEW)
    assert.ok(!/setInterval/.test(view), '弹层里不该有轮询')
  })

  test('关闭即作废在途请求，重开不闪上一次的图', () => {
    const s = read(SESSION)
    const close = blockOf(s, 'const closeErGraph = () => {')
    assert.match(close, /erTokenRef\.current\+\+/, '关弹层要作废在途请求')
    const open = blockOf(s, 'const openErGraph = () => {')
    assert.match(open, /setEr\(\{ open: true, loading: true, error: '', graph: null \}\)/, '打开时先清掉旧图')
  })

  test('刷新失败保留旧图：catch 分支不把 graph 清空', () => {
    const s = read(SESSION)
    const fn = blockOf(s, 'const loadErGraph = () => {')
    const catchAt = fn.indexOf('}).catch(')
    assert.notEqual(catchAt, -1, 'loadErGraph 应有 catch')
    const tail = fn.slice(catchAt)
    assert.ok(!/graph: null/.test(tail), '失败时清空 graph 等于把还能看的图一起收走')
    assert.match(tail, /\.\.\.s/, '失败态应保留上一张图（spread 旧 state）')
  })
})

describe('H3b-3 ER 图：只读边界', () => {
  test('组件不碰 IPC，也不写库', () => {
    const view = read(VIEW)
    assert.ok(!/runGlobalAsync|dbClientOp/.test(view), '取数归 db-session，弹层只做呈现')
    assert.ok(!/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/.test(view), '渲染层不该出现写命令')
    const btns = [...view.matchAll(/<Button\b[\s\S]{0,260}?<\/Button>/g)].map(m => m[0])
    assert.ok(btns.length >= 4, `应有 重置/刷新/关闭/打开表 至少 4 个按钮，实际 ${btns.length}`)
  })

  test('双击与「打开表」按钮走同一条 openNode（开表 + 关弹层）', () => {
    const view = read(VIEW)
    const fn = blockOf(view, 'const openNode = node => {')
    assert.match(fn, /onOpenTable\(\{/, '没接到开表回调')
    assert.match(fn, /onClose\(\)/, '开表后要关掉弹层')
    assert.match(view, /onDoubleClick=\{\(\) => openNode\(n\)\}/, '双击节点要能开表')
    assert.match(view, /onClick=\{\(\) => openNode\(selectedNode\)\}/, '详情条的打开表按钮必须走同一路径')
  })
})

describe('H3b-3 ER 图：交互契约', () => {
  test('缩放：非 passive wheel + 20%~300% 钳制', () => {
    const view = read(VIEW)
    assert.match(view, /addEventListener\('wheel', onWheel, \{ passive: false \}\)/, 'React onWheel 是 passive 的，必须自己挂')
    assert.match(view, /const ZOOM_MIN = 0\.2/)
    assert.match(view, /const ZOOM_MAX = 3/)
    assert.match(view, /Math\.min\(ZOOM_MAX, Math\.max\(ZOOM_MIN, v\.k \* Math\.exp\(-ev\.deltaY \* 0\.0015\)\)\)/,
      '缩放必须两端钳制')
    // 以光标为不动点：缩放前后把光标下的世界坐标放回原处
    assert.match(view, /tx: mx - \(mx - v\.tx\) \* scale, ty: my - \(my - v\.ty\) \* scale/)
  })

  test('拖拽走 mouse 事件（pointer capture 会吃掉节点的 click/dblclick）', () => {
    const view = read(VIEW)
    assert.ok(!/setPointerCapture/.test(view), '不要用 pointer capture')
    assert.match(view, /window\.addEventListener\('mousemove', move\)/)
    assert.match(view, /window\.addEventListener\('mouseup', up\)/)
    // 位移按缩放折算，否则放大后拖动速度与手指不一致
    assert.match(view, /dx \/ d\.k/, '节点拖动要按当前缩放折算')
    // 拖完那一下 click 不能改选中
    assert.match(view, /draggedRef\.current = true/)
    assert.match(view, /if \(!draggedRef\.current\) setSelected\(n\.id\)/)
  })

  test('重置布局回到布局函数的确定位置（清掉本地偏移）', () => {
    const view = read(VIEW)
    const fit = blockOf(view, 'const fit = useCallback(() => {')
    assert.match(fit, /setOffsets\(\{\}\)/, '重置必须丢掉拖出来的偏移')
    assert.match(fit, /Math\.max\(ZOOM_MIN, Math\.min\(1, /, '铺满上限 100%，不放大')
    assert.match(view, /onClick=\{fit\}/, '重置按钮要接 fit')
  })

  test('三种空/异常状态各有话说，截断明写数字', () => {
    const view = read(VIEW)
    assert.match(view, /e\('dbErEmpty'\)/, '空库要说明')
    assert.match(view, /e\('dbErNoFk'\)/, '没有外键要说明（不是空白）')
    assert.match(view, /e\('dbErFailed'\)/, '失败要有报错条')
    assert.match(view, /e\('dbErTruncated'\)[\s\S]{0,120}replace\('\{total\}', String\(layout\.total\)\)[\s\S]{0,120}replace\('\{kept\}', String\(layout\.kept\)\)/,
      '截断提示必须写出 total / kept 两个数')
  })
})

describe('H3b-3 ER 图：样式与词条', () => {
  test('弹层高度挂在 antd 6 的 .ant-modal-container 上（85vh）', () => {
    const styl = read(STYL)
    const at = styl.indexOf('.db-er-modal\n')
    assert.notEqual(at, -1, '弹层样式块缺失')
    const b = styl.slice(at, at + 600)
    assert.match(b, /\.ant-modal-container\n\s+height 85vh/, 'antd 6 里 .ant-modal-content 已不存在')
    assert.match(b, /\.ant-modal-body\n\s+flex 1 1 auto/, 'body 要吃掉剩余高度')
    const view = read(VIEW)
    assert.match(view, /width='90%'/, '弹层宽度按设计稿 90%')
  })

  test('颜色全走 token：画布/节点/边不写死颜色', () => {
    const styl = read(STYL)
    const at = styl.indexOf('.db-er-canvas')
    assert.notEqual(at, -1, '画布样式缺失')
    const b = styl.slice(at, at + 2400)
    assert.match(b, /background var\(--surface-1\)/, '画布底要走 surface token')
    assert.match(b, /fill var\(--surface-2\)/, '节点底要与画布分开（同色只剩描边）')
    assert.match(b, /stroke var\(--primary\)/, '高亮要用主色')
    assert.match(b, /font-family var\(--db-code-font, var\(--font-mono\)\)/, '表名/列对走数据面字体链')
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(b), '样式块里不该出现写死的十六进制颜色')
  })

  test('弹层用到的每个 dbEr* 词条都有中英两份', () => {
    const view = read(VIEW) + read(SESSION)
    const keys = [...new Set([...view.matchAll(/e\('(dbEr[A-Za-z]+)'\)/g)].map(m => m[1]))]
    assert.ok(keys.length >= 10, `dbEr* 词条应有 10+ 个，实际 ${keys.length} 个`)
    const extra = require(LOCALES)
    for (const k of keys) {
      assert.equal(typeof extra.en[k], 'string', `${k} 缺英文词条`)
      assert.equal(typeof extra.zh_cn[k], 'string', `${k} 缺中文词条`)
    }
    // 两份语言包的 dbEr* 键集合必须一致：只加一边，另一种语言会掉出词条 key
    const pick = obj => Object.keys(obj).filter(k => /^dbEr/.test(k)).sort()
    assert.deepEqual(pick(extra.zh_cn), pick(extra.en))
  })
})
