// 右面板"终端日志"页签 gating 回归（方案 B）：
//  - 非终端类页（database/web 等）时页签隐藏（与底栏按钮同口径，但不含弹窗因素）
//  - store 拆出 inTerminalTab（无 showModal），inActiveTerminal 复用它
//  - 面板正开在 info 页签且切到非终端页时自动切 transfer（不留空白面板）
// 源码契约式断言（组件行为依赖 manate/electron 运行时，unit-ci 惯例如是）
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

describe('右面板终端日志页签 gating', () => {
  const storeJs = read('src/client/store/store.js')
  const mainJsx = read('src/client/components/main/main.jsx')
  const panelJsx = read('src/client/components/side-panel-r/side-panel-r.jsx')

  test('store 拆分 inTerminalTab（不含 showModal），inActiveTerminal 复用', () => {
    assert.match(storeJs, /get inTerminalTab \(\) \{/, 'inTerminalTab getter 必须存在')
    // 反向：inTerminalTab 内不得读 showModal（弹窗打开时页签不消失）
    const getter = storeJs.match(/get inTerminalTab \(\) \{[\s\S]*?\n {2}\}/)[0]
    assert.doesNotMatch(getter, /showModal/, 'inTerminalTab 不得含 showModal 因素')
    // inActiveTerminal 必须委托 inTerminalTab（禁止复制一份判定逻辑漂移）
    const active = storeJs.match(/get inActiveTerminal \(\) \{[\s\S]*?\n {2}\}/)[0]
    assert.match(active, /store\.inTerminalTab/)
    assert.doesNotMatch(active, /paneMap\.terminal/, '判定逻辑不得在 inActiveTerminal 重复')
  })

  test('main.jsx 向右面板传 inTerminalTab / hasShellSession', () => {
    assert.match(mainJsx, /inTerminalTab: store\.inTerminalTab/)
    assert.match(mainJsx, /hasShellSession: store\.hasShellSession/)
  })

  test('side-panel-r：info/monitor 页签按可用性过滤 + 自动切 transfer', () => {
    // 页签过滤（与 AI disabled 同链）
    assert.match(
      panelJsx,
      /t\.key !== 'info' \|\| inTerminalTab/,
      'info 页签必须按 inTerminalTab 过滤'
    )
    assert.match(
      panelJsx,
      /t\.key !== 'monitor' \|\| hasShellSession/,
      'monitor 页签必须按 hasShellSession 过滤'
    )
    // info/monitor 正被选中且不可用时自动切 transfer 的重定向 effect 存在
    const redirect = panelJsx.match(
      /rightPanelTab === 'info' && !inTerminalTab[\s\S]{0,80}rightPanelTab === 'monitor' && !hasShellSession[\s\S]{0,80}rightPanelTab = 'transfer'/
    )
    assert.ok(redirect, '必须存在 info/monitor→transfer 重定向')
    // 反向：重定向 effect 必须在渲染期 early return（return null）之前声明；
    // 用 return null 特征匹配，避开 Esc effect 内同文本的 if (!rightPanelVisible)
    const effectIdx = panelJsx.indexOf("rightPanelTab === 'info' && !inTerminalTab")
    const earlyReturnIdx = panelJsx.indexOf('if (!rightPanelVisible) {\n    return null\n  }')
    assert.ok(effectIdx > -1 && earlyReturnIdx > effectIdx, 'hook 必须保持在 early return 之上')
  })

  test('hasShellSession：shell 会话页口径（不含 pane/弹窗因素）+ 监控按钮 gating', () => {
    const getter = storeJs.match(/get hasShellSession \(\) \{[\s\S]*?\n {2}\}/)[0]
    assert.ok(getter, 'hasShellSession getter 必须存在')
    // 反向：监控可用性是会话 server 级（ssh 页 sftp pane 也可采集），不得读 pane
    assert.doesNotMatch(getter, /pane/, 'hasShellSession 不得含 pane 因素')
    assert.doesNotMatch(getter, /showModal/, 'hasShellSession 不得含 showModal 因素')
    // ssh/local/telnet/serial 白名单 + 旧数据 type 缺省视为 ssh
    for (const t of ["'ssh'", "'local'", "'telnet'", "'serial'", '!type']) {
      assert.match(getter, new RegExp(t.replace(/'/g, "\\'").replace('!', '\\!')), `须覆盖 ${t}`)
    }
    // 底栏监控按钮：inActiveTerminal 且 hasShellSession
    const footerJsx = read('src/client/components/footer/footer-entry.jsx')
    assert.match(
      footerJsx,
      /inActiveTerminal && props\.store\.hasShellSession && renderMonitorIcon\(\)/,
      '监控按钮必须叠加 hasShellSession'
    )
    // AI/传输保持全局（不得被 hasShellSession 误伤）
    assert.match(footerJsx, /inActiveTerminal && !isAIDisabled\(\) && renderTransferIcon\(\)/)
  })

  test('TerminalInfo 空态门控仍在（双保险不拆除）', () => {
    const infoJsx = read('src/client/components/terminal-info/terminal-info.jsx')
    assert.match(infoJsx, /props\.pid !== tab\?\.id/)
  })
})
