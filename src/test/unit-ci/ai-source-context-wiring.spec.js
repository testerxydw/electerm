// AI 面板「会话来源上下文」提示的接线契约（P-4：只提示、不绑定）。
//
// 判定逻辑在 ai-source-context.spec.js；这里钉的是组件侧不能悄悄退化：
// - 数据库页"AI 解释"要带着那份来源快照走（setPendingAiPrompt 的第三参）；
// - 终端"解释这段输出"把来源标成那个终端页签；
// - store 对来源做归一化：认不出页签就不带，宁可不提示也不带半条；
// - 面板消费外部递交时把来源写进历史条目，手输不写；
// - 错位判定用的是"当前活动页签 id"，不是"当前 tab 对象"（页签关了照样比 id）；
// - 两条词条中英文都在（来源标题 + 错位提示）。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const SESSION = read('src/client/components/database/db-session.jsx')
const MENU = read('src/client/components/terminal/mixins/term-context-menu.jsx')
const STORE = read('src/client/store/common.js')
const CHAT = read('src/client/components/ai/ai-chat.jsx')
const LOCALES = read('src/app/common/locales-extra.js')
const STYL = read('src/client/components/ai/ai.styl')

describe('P-4 接线：来源快照从递交方进到历史条目', () => {
  test('数据库页"AI 解释"带着页签+库表快照走', () => {
    assert.match(SESSION, /buildDbAiSource\(tab, ctx\)/, '没有把库表上下文压成来源')
    assert.match(SESSION, /setPendingAiPrompt\(built\.prompt,\s*true,\s*buildDbAiSource\(tab, ctx\)\)/,
      '来源没作为第三参递进 setPendingAiPrompt')
  })

  test('终端"解释这段输出"把来源标成当前页签', () => {
    assert.match(MENU, /buildTermAiSource\(this\.props\.tab\)/, '终端来源没有用当前页签')
    assert.match(MENU, /explainWithAi\(/, '解释入口没接线')
  })

  test('store 归一化来源：认不出页签就不带', () => {
    assert.match(STORE, /source: source && source\.tabId \? source : null/,
      '来源没有做"认不出就不带"的归一化')
    assert.match(STORE, /explainWithAi\s*=\s*function \(txt, source\)/, 'explainWithAi 没接收来源')
    assert.match(STORE, /setPendingAiPrompt\('explain terminal output: ' \+ txt,\s*true,\s*source\)/,
      'explainWithAi 没把来源转发给 setPendingAiPrompt')
  })

  test('面板消费外部递交时把来源写进历史条目（手输不写）', () => {
    assert.match(CHAT, /function \(overridePrompt,\s*overrideSource\)/, 'handleSubmit 没接收来源')
    assert.match(CHAT, /source: isOverride && overrideSource && overrideSource\.tabId \? overrideSource : undefined/,
      '来源没在递交那一步落进条目（且只认带页签的）')
    assert.match(CHAT, /handleSubmit\(p\.text,\s*p\.source\)/, '消费外部递交时没把来源带上')
  })

  test('错位判定按当前活动页签 id，不是当前 tab 对象', () => {
    assert.match(CHAT, /isAiSourceStale\(aiSource,\s*props\.activeTabId\)/,
      '错位判定没用活动页签 id')
  })

  test('提示条只在有来源时渲染，且放在历史列表上方', () => {
    assert.match(CHAT, /function renderSourceBar \(\)/, '没有来源提示的渲染入口')
    assert.match(CHAT, /if \(!aiSourceView \|\| props\.showChatSessions\)/, '没按"有无来源"门')
    assert.match(STYL, /\.ai-source-bar\b/, '没有来源提示的样式')
  })

  test('两条词条中英文都有（来源标题 + 错位提示）', () => {
    const count = (key) => (LOCALES.match(new RegExp(key + '\\s*:', 'g')) || []).length
    assert.equal(count('aiSourceContext'), 2, 'aiSourceContext 应中英各一条')
    assert.equal(count('aiSourceStale'), 2, 'aiSourceStale 应中英各一条')
  })
})
