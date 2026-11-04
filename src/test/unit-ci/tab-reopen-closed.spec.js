// tab 右键「重新打开已关闭的页签」（P-8a）接线契约（源码正则）。
//
// 判定逻辑和关闭快照都在 tab.js：关 tab 的每条路径都把可重建连接的快照压栈，
// 右键"重新打开"从栈顶弹一条走 addTab 补新 id/status 重开。这里钉的是组件侧
// 和 store 侧不能悄悄退化：
// - 三条关闭路径（关闭右侧/关闭其他/removeTabs）都压栈；
// - 只压能重建连接的字段（id/status/pane/batch/tabCount 等运行时字段剪掉）；
// - 栈有封顶，连关/批量关不会无限膨胀；
// - 右键菜单在"关闭右侧"后挂"重新打开"，且只在栈非空时可点；
// - 重开走 addTab（补新 id/status/batch/tabCount 并置活动页签），不留旧状态；
// - 中英词条都在（来源是 locales-extra，上游语言包没有这个 key）。
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

  test('关闭右侧 / 关闭其他都压栈', () => {
    assert.match(STORE, /pushClosedTab\(closingTab\)/, '关闭右侧没压栈')
    assert.match(STORE, /pushClosedTab\(tab\)/, '关闭其他/removeTabs 没压栈')
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
