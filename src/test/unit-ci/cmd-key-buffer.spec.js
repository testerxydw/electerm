// manual 命令历史的键入缓冲守卫：SSH 回显延迟下读终端 buffer 会静默丢命令
// （本地能存、远程不能存, 2026-10-12 修复）。验证键入缓冲的累积/清除规则
// 与 Enter 记录路径, 以及 OSC shell 集成模式下不双记。
// 源码 import 链顶层触达 window(ref.js), 用 vm 沙箱 + mock 依赖加载。
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const src = fs.readFileSync(
  path.resolve(__dirname, '../../client/components/terminal/mixins/term-suggestions.js'),
  'utf8'
)
const patched = src
  .replace(/import \{ debounce \} from 'lodash-es'/, 'const { debounce } = { debounce: (fn) => fn }')
  .replace(/import \{ refsStatic \} from '[^']*ref\.js'/, 'const { refsStatic } = { refsStatic: { get: () => null } }')
  .replace('export const suggestionsMixin', 'const suggestionsMixin')

function makeCtx ({ oscActive = false, bufferInput = '' } = {}) {
  const recorded = []
  const ctx = {
    _keyBuf: '',
    _escSeq: false,
    term: null,
    userTypeExit: false,
    _oscActive: oscActive,
    _bufferInput: bufferInput,
    getCurrentInput () {
      return this._bufferInput
    },
    shouldUseManualHistory () {
      return !this._oscActive
    },
    closeSuggestions () {},
    addCmdHistory: (cmd) => recorded.push(cmd)
  }
  const sandbox = {
    window: { store: { addCmdHistory: (cmd) => recorded.push(cmd) } },
    console,
    setTimeout,
    clearTimeout
  }
  vm.createContext(sandbox)
  ctx.recorded = recorded
  // 把 mixin 方法挂到 ctx 上（绑定 ctx 为 this）
  const mixin = vm.runInNewContext(patched + '\nsuggestionsMixin', sandbox)
  for (const [k, v] of Object.entries(mixin)) {
    ctx[k] = typeof v === 'function' ? v.bind(ctx) : v
  }
  // mock 覆盖须在 mixin 绑定之后, 否则被 mixin 版本遮蔽
  ctx.getCurrentInput = function () {
    return this._bufferInput
  }
  ctx.shouldUseManualHistory = function () {
    return !this._oscActive
  }
  ctx.closeSuggestions = function () {}
  return ctx
}

describe('cmd-key-buffer: manual 历史的键入缓冲', () => {
  it('普通键入 + Enter 记录命令（SSH 回显未到也能记录）', () => {
    const ctx = makeCtx({ bufferInput: '' })
    for (const ch of '111') ctx.handleKeyBuffer(ch)
    ctx.handleInputEvent('\r')
    assert.deepEqual(ctx.recorded, ['111'])
  })

  it('退格修正后的最终命令被记录', () => {
    const ctx = makeCtx({ bufferInput: '' })
    for (const ch of '12\x7f3') ctx.handleKeyBuffer(ch)
    ctx.handleInputEvent('\r')
    assert.deepEqual(ctx.recorded, ['13'])
  })

  it('粘贴整段（含回车）整条记录', () => {
    const ctx = makeCtx({ bufferInput: '' })
    ctx.handleKeyBuffer('ls -la\r')
    ctx.handleInputEvent('ls -la\r')
    assert.deepEqual(ctx.recorded, ['ls -la'])
  })

  it('Ctrl+C 清空缓冲, 空命令不记录', () => {
    const ctx = makeCtx({ bufferInput: '' })
    for (const ch of 'abc') ctx.handleKeyBuffer(ch)
    ctx.handleKeyBuffer('\x03')
    ctx.handleInputEvent('\r')
    assert.deepEqual(ctx.recorded, [])
  })

  it('方向键导航清缓冲, 回车时回退读 buffer（远端已回显完整命令行）', () => {
    const ctx = makeCtx({ bufferInput: 'systemctl status nginx' })
    // 方向键与回车是两次独立的 onData
    ctx.handleKeyBuffer('\x1b[A')
    ctx.handleInputEvent('\x1b[A')
    ctx.handleKeyBuffer('\r')
    ctx.handleInputEvent('\r')
    assert.deepEqual(ctx.recorded, ['systemctl status nginx'])
  })

  it('粘贴多行段逐行记录', () => {
    const ctx = makeCtx({ bufferInput: '' })
    ctx.handleKeyBuffer('echo a\r\necho b\r')
    ctx.handleInputEvent('echo a\r\necho b\r')
    assert.deepEqual(ctx.recorded, ['echo a', 'echo b'])
  })

  it('反向验证: buffer 为空且缓冲为空时不记录（原缺陷场景不复发）', () => {
    const ctx = makeCtx({ bufferInput: '' })
    ctx.handleInputEvent('\r')
    assert.deepEqual(ctx.recorded, [])
  })

  it('OSC shell 集成激活时不走 manual 记录（避免双记）', () => {
    const ctx = makeCtx({ oscActive: true, bufferInput: '' })
    for (const ch of 'abc') ctx.handleKeyBuffer(ch)
    ctx.handleInputEvent('\r')
    assert.deepEqual(ctx.recorded, [])
  })
})
