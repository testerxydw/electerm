// 批量输入目标 tab 口径守护：只允许 shell 会话 tab（ssh/local/telnet/serial）
// 背景（218 真机回归）：三处入口（底栏批量输入 / 命令历史多终端运行 / store
// 选中集管理）原为黑名单式过滤（只排 web/rdp/vnc），后加的 database/ftp/spice
// 类型漏放——列表把 [MySQL]/[Redis] tab 列出来，选中后 term?.batchInput 静默
// 跳过（点了没反应）。修复为白名单口径（constants.js isShellSessionTab），
// 与 store.hasShellSession 共用，禁止再回退黑名单枚举。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

// constants.js 含图片/(window) 依赖无法直接 require，提取纯函数源码文本
// 到沙箱执行，保证测试跑的是真实实现而非复制品
function loadIsShellSessionTab () {
  const src = read('src/client/common/constants.js')
  const setDecl = src.match(/const shellSessionTypeSet = new Set\(\[[^\]]*\]\)/)
  const fnDecl = src.match(/const isShellSessionTab = \(tab\) => \{[\s\S]*?\n\}/)
  assert.ok(setDecl && fnDecl, 'constants.js 须导出 shellSessionTypeSet + isShellSessionTab')
  // Set 里引用了类型常量（terminalLocalType 等），沙箱需先按源码还原这些定义
  const prelude = ['terminalLocalType', 'terminalTelnetType', 'terminalSerialType']
    .map(k => {
      const m = src.match(new RegExp(`export const ${k} = '([^']*)'`))
      assert.ok(m, `constants.js 须定义 ${k}`)
      return `const ${k} = '${m[1]}'`
    })
    .join('\n')
  const sandbox = {}
  sandbox.sandbox = sandbox
  vm.runInNewContext(
    `${prelude}\n${setDecl[0]}\n${fnDecl[0]}; sandbox.f = isShellSessionTab; sandbox.set = shellSessionTypeSet`,
    sandbox
  )
  return { isShellSessionTab: sandbox.f, set: sandbox.set }
}

describe('批量输入目标 tab 白名单口径', () => {
  const { isShellSessionTab } = loadIsShellSessionTab()

  test('isShellSessionTab：shell 会话类型放行（含旧数据 type 缺省）', () => {
    for (const type of ['ssh', 'local', 'telnet', 'serial', undefined]) {
      assert.equal(isShellSessionTab({ id: 't', type }), true, `${type} 须放行`)
    }
    assert.equal(isShellSessionTab({ id: 't' }), true, 'type 缺省的旧 ssh 数据须放行')
  })

  test('isShellSessionTab：无终端实例类型拒绝（218 漏放类型反向断言）', () => {
    for (const type of ['database', 'ftp', 'spice', 'web', 'rdp', 'vnc']) {
      assert.equal(isShellSessionTab({ id: 't', type }), false, `${type} 须拒绝`)
    }
    assert.equal(isShellSessionTab(null), false, '空 tab 须拒绝')
  })

  test('batch-input.jsx：列表用白名单，禁止黑名单残留', () => {
    const src = read('src/client/components/footer/batch-input.jsx')
    assert.match(src, /getTabs = \(\) => \{[\s\S]*?filter\(isShellSessionTab\)/,
      'getTabs 必须 filter(isShellSessionTab)')
    // 反向：黑名单枚举（218 版本缺陷根源）不得回潮
    for (const bad of ['terminalWebType', 'terminalRdpType', 'terminalVncType']) {
      assert.doesNotMatch(src, new RegExp(bad), `batch-input.jsx 不得再引用 ${bad}`)
    }
    assert.match(src, /!batchInputSelectedTabIds\.length/, '空选中集须阻断提交')
  })

  test('multi-tab-run-modal.jsx：列表用白名单，禁止黑名单残留', () => {
    const src = read('src/client/components/footer/multi-tab-run-modal.jsx')
    assert.match(src, /filter\(isShellSessionTab\)/, '弹窗列表必须 filter(isShellSessionTab)')
    for (const bad of ['terminalWebType', 'terminalRdpType', 'terminalVncType']) {
      assert.doesNotMatch(src, new RegExp(bad), `multi-tab-run-modal.jsx 不得再引用 ${bad}`)
    }
  })

  test('tab.js：选中集管理按白名单清理/全选/兜底', () => {
    const src = read('src/client/store/tab.js')
    // filter：非法类型选中态须被清理
    assert.match(
      src,
      /filterBatchInputSelectedTabIds = action\(function \(\) \{[\s\S]*?tabs\.filter\(isShellSessionTab\)/,
      'filter 必须按 isShellSessionTab 清理选中集'
    )
    // selectAll：全选不得把无终端实例 tab 圈进来
    assert.match(
      src,
      /selectAllBatchInputTabs = function \(\) \{[\s\S]*?tabs\.filter\(isShellSessionTab\)/,
      '全选必须只圈 shell 会话 tab'
    )
    // update：当前 tab 非 shell 时不重置选中集（不得把 database tab 设为目标）
    const update = src.match(/updateBatchInputSelectedTabIds = function \(\) \{[\s\S]*?\n {2}\}/)[0]
    assert.match(update, /isShellSessionTab\(store\.currentTab\)/,
      '切 tab 重置选中集前须校验当前 tab 为 shell 会话')
    // 兜底 helper：非 shell 当前 tab 回落到第一个 shell tab
    assert.match(src, /function pickBatchInputFallbackId[\s\S]*?isShellSessionTab/,
      '兜底 helper 必须按白名单选取')
  })

  test('store.js hasShellSession：委托共享口径，禁止字面量白名单重复', () => {
    const src = read('src/client/store/store.js')
    const getter = src.match(/get hasShellSession \(\) \{[\s\S]*?\n {2}\}/)[0]
    assert.match(getter, /isShellSessionTab\(currentTab\)/, 'getter 必须委托 isShellSessionTab')
    // 反向：getter 内不得再复制一份类型字面量（口径漂移温床）
    assert.doesNotMatch(getter, /'ssh'|'local'|'telnet'|'serial'/,
      'getter 不得重复类型字面量')
  })
})
