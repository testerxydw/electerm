// tab 右键「重新打开已关闭的页签」与批量关闭的接线契约（源码正则）。
//
// 判定逻辑和关闭快照都在 tab.js：关 tab 的每条路径都把可重建连接的快照压栈，
// 右键"重新打开"从栈顶弹一条走 addTab 补新 id/status 重开。这里钉的是组件侧
// 和 store 侧不能悄悄退化：
// - 关闭都收口到 removeTabs（资源释放、压栈、活动指针修正都在里面），
//   四条批量关闭路径不再自己 splice，而是走 closeTabsBatch 这套统一收尾；
// - 批量关闭要过未提交事务守卫、要接 autoCloseEmptyPane、空窗格指针要置空；
// - 只压能重建连接的字段（id/status/pane/batch/tabCount 等运行时字段剪掉）；
// - 栈有封顶，连关/批量关不会无限膨胀；
// - 右键菜单在"关闭右侧"后挂"重新打开"，且只在栈非空时可点；
// - 重开走 addTab（补新 id/status/batch/tabCount 并置活动页签），不留旧状态；
// - 页签选色复用书签创建时那张色卡（components/common/color-card.jsx），
//   设过色后有"清除页签颜色"；卡片里的 hex 输入要跟住外部换色（书签那张卡不重挂）；
// - 菜单派发 this[key] 有兜底，没有同名方法的项不会抛未捕获异常；
// - 中英词条都在（来源是 locales-extra，上游语言包没有这些 key）。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const STORE = read('src/client/store/tab.js')
const MENU = read('src/client/components/tabs/tab.jsx')
const STATE = read('src/client/store/init-state.js')
const LOCALES = read('src/app/common/locales-extra.js')
const CARD = read('src/client/components/common/color-card.jsx')
const PICKER = read('src/client/components/bookmark-form/common/color-picker.jsx')
const PALETTE = read('src/client/common/rand-hex-color.js')
const HEX_INPUT = read('src/client/components/common/hex-input.jsx')
const TABS_STYL = read('src/client/components/tabs/tabs.styl')
const SYS_MENU_STYL = read('src/client/components/sys-menu/sys-menu.styl')

describe('P-8a 接线：三条关闭路径都压栈，右键弹栈重开', () => {
  test('init-state 有 closedTabs 栈', () => {
    assert.match(STATE, /closedTabs:\s*\[\]/, '没有已关闭页签栈')
  })

  test('快照只剪运行时字段，保留可重建连接的字段', () => {
    assert.match(STORE, /const closedTabsPrune = \[/, '没有剪字段清单')
    for (const f of ['id', 'status', 'pane', 'batch', 'tabCount']) {
      assert.ok(closedTabsPruneHas(STORE, f), `快照没剪 ${f}`)
    }
    assert.ok(closedTabsPruneHas(STORE, '_reloadState'), '快照没剪重连状态')
    assert.ok(closedTabsPruneHas(STORE, 'isPinned'), '快照没剪置顶标记')
  })

  test('栈有封顶，连关/批量关不膨胀', () => {
    assert.match(STORE, /const closedTabsCap = /, '没有封顶常量')
    assert.match(STORE, /\.length = closedTabsCap/, '没有超出截断')
  })

  test('批量关闭都走统一收尾，压栈由 removeTabs 负责', () => {
    assert.match(STORE, /async function closeTabsBatch/, '没有批量关闭的统一收尾')
    const body = closeTabsBatchBody()
    assert.match(body, /store\.removeTabs\(/, '批量关闭没把删除交给 removeTabs')
    assert.match(STORE, /pushClosedTab\(tab\)/, 'removeTabs 里没有压栈')
  })

  test('removeTabs 走统一压栈（delTab 与批量关都收口在这里）', () => {
    const body = STORE.slice(STORE.indexOf('Store.prototype.removeTabs'), STORE.indexOf('Store.prototype.fixCurrentTabIds'))
    assert.match(body, /pushClosedTab\(tab\)/, 'removeTabs 内没压栈')
    assert.ok(body.match(/pushClosedTab\(tab\)/g)?.length >= 1, 'removeTabs 至少一处压栈')
  })

  test('只有带连接可重建的 tab 才压栈', () => {
    assert.match(STORE, /if \(!tab \|\| !tab\.host\)/, '空/无 host 的快照没被拦下')
  })

  test('重开走 addTab（补新 id/status，不留旧状态）', () => {
    assert.match(STORE, /Store\.prototype\.reopenClosedTab = function \(\)/, '没有重开入口')
    assert.match(STORE, /store\.addTab\(stack\.shift\(\)\)/, '重开没走 addTab')
  })

  test('右键菜单在"关闭右侧"后挂"重新打开"，栈空时不可点', () => {
    assert.match(MENU, /reopenClosedTab/, '菜单里没有"重新打开"项')
    assert.match(MENU, /\(window\.store\.closedTabs \|\| \[\]\)\.length > 0/, '没有"栈非空才可点"的门')
    assert.match(MENU, /window\.store\.reopenClosedTab\(\)/, '菜单 handler 没接到 store')
  })

  test('两条词条中英文都在（来源标题）', () => {
    const count = (key) => (LOCALES.match(new RegExp(key + '\\s*:', 'g')) || []).length
    assert.equal(count('reopenClosedTab'), 2, 'reopenClosedTab 应中英各一条')
  })
})

function closedTabsPruneHas (src, field) {
  const start = src.indexOf('const closedTabsPrune = [')
  const end = src.indexOf(']', start)
  return src.slice(start, end).includes(`'${field}'`)
}

function closeTabsBatchBody () {
  const start = STORE.indexOf('async function closeTabsBatch')
  const end = STORE.indexOf('export default Store', start)
  return STORE.slice(start, end)
}

function prototypeBody (name) {
  const start = STORE.indexOf(`Store.prototype.${name} = function`)
  const end = STORE.indexOf('Store.prototype.', start + 1)
  return STORE.slice(start, end < 0 ? STORE.length : end)
}

describe('P-8 收口：批量关闭复用 delTab 的收尾，色卡复用创建时那一张', () => {
  test('四条批量关闭路径都在，只按 batch 过滤且都走统一收尾', () => {
    for (const name of ['closeTabsRight', 'closeTabsLeft', 'closeAllTabs', 'closeOtherTabs']) {
      const body = prototypeBody(name)
      assert.ok(body, `缺 ${name}`)
      assert.match(body, /batch === targetBatch|batch === currentBatch/, `${name} 应按 batch 过滤，不越窗格`)
      assert.match(body, /closeTabsBatch\(/, `${name} 没走统一收尾`)
      assert.doesNotMatch(body, /tabs\.splice/, `${name} 还在自己 splice，收尾会漏`)
    }
  })

  test('closeTabsLeft 在非首 tab 才出现（index > 0 门）', () => {
    assert.match(MENU, /index > 0 && \{/, 'closeTabsLeft 应按 index>0 门控')
    assert.match(MENU, /key: 'closeTabsLeft'/, '菜单缺 closeTabsLeft')
    assert.match(MENU, /key: 'closeAllTabs'/, '菜单缺 closeAllTabs')
    assert.match(MENU, /store\.closeTabsLeft/, 'closeTabsLeft 没接 store')
    assert.match(MENU, /store\.closeAllTabs/, 'closeAllTabs 没接 store')
  })

  test('缺口②：统一收尾逐条过 txCloseGuards，某条取消就停止后续', () => {
    const body = closeTabsBatchBody()
    assert.match(body, /store\.txCloseGuards/, '批量关闭没读事务守卫')
    assert.match(body, /if \(!ok\) \{/, '守卫返回值没判')
    assert.match(body, /break/, '取消后没停止后续')
    assert.match(body, /store\.tabs\.some\(t => t\.id === tab\.id\)/, '守卫弹窗期间被别的路径关掉的条没复查')
  })

  test('缺口③：关完按 batch 收空窗格，并收敛广播态', () => {
    const body = closeTabsBatchBody()
    assert.match(body, /autoClosePaneIfEmpty/, '批量关闭没接 autoCloseEmptyPane')
    assert.match(body, /onBroadcastTabClosed/, '批量关闭没收敛广播态')
  })

  test('缺口④：空窗格的活动指针置空，不留悬空 id', () => {
    const body = prototypeBody('fixCurrentTabIds')
    assert.match(body, /liveBatches/, '没有按窗格统计剩余页签')
    assert.match(body, /store\['activeTabId' \+ batch\] = ''/, '空窗格指针没置空')
  })

  test('缺口⑤：菜单派发有 this[key] 兜底，没有同名方法不再抛 TypeError', () => {
    assert.match(MENU, /const handler = this\[key\]/, 'onContextMenu 没取 handler')
    assert.match(MENU, /typeof handler !== 'function'/, 'onContextMenu 没兜底')
    assert.match(MENU, /handler\.call\(this\)/, 'onContextMenu 没走兜底调用')
  })

  test('色卡复用创建时那一张：菜单项只负责弹出，卡片本体在 components/common', () => {
    assert.match(MENU, /import \{ ColorCard \} from '\.\.\/common\/color-card\.jsx'/, '页签没用公共色卡')
    assert.match(MENU, /key: 'setColor'/, '菜单缺 setColor')
    assert.match(MENU, /setColor = \(\) => \{/, 'setColor 没有对应方法')
    assert.match(MENU, /renderColorCard/, '色卡没挂到页签上')
    assert.match(MENU, /tab-color-anchor/, '色卡锚点没留')
    // 拖动取色器不再塞在菜单项里（菜单一点就关，卡片必须活在菜单之外）
    assert.doesNotMatch(MENU, /ColorPicker/, 'tab.jsx 还在直接用 antd ColorPicker')
    // 行尾色块是卡片的落点（setColor 量它的矩形），样式只在 tabs.styl 定义一次；
    // 上一版在 sys-menu.styl 里还有一份同名旧定义（那时候色块真是内嵌取色器），已删
    assert.match(TABS_STYL, /\.tab-context-color-swatch/, '菜单行尾色块没样式，锚点量不到矩形')
    assert.doesNotMatch(SYS_MENU_STYL, /\.tab-context-color-item/, 'sys-menu.styl 里不该再有一份同名定义')
    assert.match(CARD, /export function ColorCard/, '公共色卡没导出')
    assert.match(CARD, /defaultColors/, '色卡没用公共色值表')
    assert.match(PICKER, /import \{ ColorCard \} from '\.\.\/\.\.\/common\/color-card\.jsx'/, '书签表单没用同一张色卡')
  })

  test('缺口①：设过色才有"清除页签颜色"，清除是删字段', () => {
    assert.match(MENU, /tab\.color && \{/, '清除项没按已设色门控')
    assert.match(MENU, /key: 'clearTabColor'/, '菜单缺 clearTabColor')
    assert.match(MENU, /delete this\.props\.tab\.color/, '清除没删字段（删字段才回到默认色）')
  })

  test('hex 输入跟着外部换色刷新草稿（书签那张卡不销毁重挂，不能显示上一个色）', () => {
    assert.match(HEX_INPUT, /useEffect\(/, 'HexInput 不再同步外部 value')
    // 只在"value 真的变过"时覆盖：否则用户打到一半会被自己没提交的输入顶回去
    assert.match(HEX_INPUT, /if \(nv !== seen\)/, 'HexInput 无条件覆盖草稿')
    assert.match(HEX_INPUT, /const \[seen, setSeen\]/, 'HexInput 没有记住上次见过的 value')
  })

  test('色卡 24 色、不重复，random 仍在', () => {
    const hexes = (PALETTE.match(/'#[0-9a-f]{6}'/g) || [])
    assert.equal(hexes.length, 24, `色卡应是 24 色，实际 ${hexes.length}`)
    assert.equal(new Set(hexes).size, 24, '色卡有重复色值')
    assert.match(CARD, /\[\.\.\.defaultColors, 'random'\]/, '色卡少了 random')
  })

  test('词条中英各一条', () => {
    for (const key of ['closeTabLeft', 'closeAllTabs', 'setTabColor', 'clearTabColor']) {
      const count = (LOCALES.match(new RegExp(key + '\\s*:', 'g')) || []).length
      assert.equal(count, 2, `${key} 应中英各一条，实际 ${count}`)
    }
  })
})
