// 会话录制快捷键 (T5-4a) 契约守护
// 反向验证: Windows/Linux 默认不占键位(Ctrl+R 是 shell 反向搜索), 仅 macOS meta+r
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const srcRoot = path.resolve(__dirname, '../..')
const read = p => fs.readFileSync(path.join(srcRoot, p), 'utf8')

// shortcuts-defaults.js 是 ESM(default export 工厂), 提取数组字面量求值
const defaultsJs = read('client/components/shortcuts/shortcuts-defaults.js')
const m = defaultsJs.match(/return (\[[\s\S]*\n {2}\])/)
assert.ok(m, 'shortcuts-defaults.js 必须返回数组字面量')
// eslint-disable-next-line no-new-func
const defs = new Function('return ' + m[1])()
const def = defs.find(d => d.name === 'terminal_toggleSessionRecord')
assert.ok(def, '缺少 terminal_toggleSessionRecord 定义')

const termMenuJsx = read('client/components/terminal/mixins/term-context-menu.jsx')

describe('session-record-shortcut: 默认键位', () => {
  it('defaults 存在 terminal_toggleSessionRecord 定义', () => {
    assert.ok(def)
  })

  it('反向: Windows/Linux 默认为空串, 不抢占 Ctrl+R 反向搜索', () => {
    assert.equal(def.shortcut, '', 'Win/Linux 默认必须为空')
  })

  it('macOS 默认 meta+r', () => {
    assert.equal(def.shortcutMac, 'meta+r')
  })

  it('反向: 不设 readonly (用户可在设置里改键)', () => {
    assert.notEqual(def.readonly, true)
  })
})

describe('session-record-shortcut: 分发与接线契约', () => {
  it('shortcut-handler 分发机制 func+Shortcut 拼出方法名存在', () => {
    const [, func] = def.name.split('_')
    const funcName = func + 'Shortcut'
    assert.equal(funcName, 'toggleSessionRecordShortcut')
    assert.match(termMenuJsx, new RegExp(' {2}' + funcName + ' \\(e\\) \\{'))
  })

  it('term-context-menu.jsx: toggleSessionRecordShortcut 调 store.toggleSessionRecord 并传 tab.id', () => {
    assert.match(termMenuJsx, /toggleSessionRecordShortcut \(e\) \{\s*\n\s*e\.stopPropagation\(\)\s*\n\s*window\.store\.toggleSessionRecord\(this\.props\.tab\.id\)/)
  })

  it('反向: mixins 内不得直接读写 recState (状态单源在 store/session.js)', () => {
    assert.doesNotMatch(termMenuJsx, /recState|appendRecFile|createRecordFile/)
  })
})
