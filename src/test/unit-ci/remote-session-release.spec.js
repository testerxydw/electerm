const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const SRC = path.join(ROOT, 'src')
const RDP = path.join(SRC, 'client/components/rdp/rdp-session.jsx')
const VNC = path.join(SRC, 'client/components/vnc/vnc-session.jsx')
const SPICE = path.join(SRC, 'client/components/spice/spice-session.jsx')
const SERVER = path.join(SRC, 'app/server/session-server.js')
const TAB_STORE = path.join(SRC, 'client/store/tab.js')
const SESSION = path.join(SRC, 'client/components/session/session.jsx')

const read = p => fs.readFileSync(p, 'utf8')
const at = (src, s) => src.indexOf(s)
// 断言 a 出现在 b 之前（两者都必须存在）
const before = (src, a, b, msg) => {
  assert.ok(at(src, a) > -1, msg + ' (missing: ' + a + ')')
  assert.ok(at(src, b) > at(src, a), msg + ' (order: ' + a + ' -> ' + b + ')')
}
// 返回 anchor 之后第一次出现 s 的位置
const next = (src, anchor, s, msg) => {
  const base = at(src, anchor)
  assert.ok(base > -1, msg + ' (missing anchor: ' + anchor + ')')
  const p = src.indexOf(s, base)
  assert.ok(p > -1, msg + ' (missing: ' + s + ' after ' + anchor + ')')
  return p
}

// 远程页面（VNC/RDP/SPICE）关闭后的资源释放契约。
// 背景：关闭 tab 只靠“组件卸载 + ws 断开”收尾，历史上存在三类缺口：
//   1. SPICE 子进程无 close → cleanup，每关一个页面留一个常驻 session server；
//   2. 关闭发生在 createTerm/connect 的异步窗口里时，新建的会话没有人回收；
//   3. RDP 只 shutdown 不 free，WASM 堆等 GC 才还，反复开关页面内存一直涨。

describe('SPICE 关闭：最后一条通道断开后结束 session server 进程', () => {
  const src = read(SERVER)

  test('spice 路由在最后一条通道关闭时调用 cleanup()', () => {
    const spiceRoute = src.split("app.ws('/spice/:pid'")[1] || ''
    assert.ok(spiceRoute, 'spice route must exist')
    assert.match(
      spiceRoute,
      /ws\.on\('close', \(\) => \{[\s\S]{0,160}term\.wsMap\.size === 0[\s\S]{0,120}cleanup\(\)/,
      'spice 路由必须在 wsMap 清空后 cleanup()，否则子进程常驻'
    )
  })

  test('反向：spice 路由不能像 rdp/vnc 一样单条 close 直接 cleanup()', () => {
    const spiceRoute = src.split("app.ws('/spice/:pid'")[1].split('} else {')[0]
    const closes = spiceRoute.match(/ws\.on\('close'/g) || []
    assert.equal(closes.length, 1, 'spice 路由只能有一个受 wsMap 保护的 close 处理')
    assert.doesNotMatch(
      spiceRoute,
      /ws\.on\('close', \(\) => \{\s*cleanup\(\)/,
      '单通道关闭不能结束整个进程（SPICE 一个页面有多条通道）'
    )
  })
})

describe('RDP 关闭：显式释放 WASM 会话与 canvas 显存', () => {
  const src = read(RDP)

  test('会话在 run() 结束后才 free（不能在 shutdown 后立刻 free）', () => {
    assert.match(
      src,
      /session\.run\(\)[\s\S]{0,900}\.finally\(\(\) => \{[\s\S]{0,200}session\.free\(\)/,
      'run 结束后才能释放 Rust 侧会话内存'
    )
    assert.doesNotMatch(
      src,
      /this\.session\.shutdown\(\)[\s\S]{0,240}this\.session\.free\(\)/,
      'shutdown 后立刻 free 会 use-after-free（run 的 future 仍在借用）'
    )
  })

  test('卸载与原地重连共用同一份 canvas 归零', () => {
    assert.match(
      src,
      /_releaseCanvas = \(\) => \{[\s\S]{0,200}canvas\.width = 0[\s\S]{0,100}canvas\.height = 0[\s\S]{0,120}this\._canvasEl = null/,
      '归零 + 解引用必须在同一个私有方法里'
    )
    assert.match(
      src,
      /componentWillUnmount \(\)[\s\S]{0,200}this\._releaseCanvas\(\)/,
      '卸载时 canvas 归零，显存不必等 GC'
    )
    const reInit = src.split('handleReInit = () => {')[1].split('}')[0]
    assert.match(reInit, /this\._releaseCanvas\(\)/, '重连不归零 = 每重连一次多滞留一帧位图')
    assert.match(src, /this\._canvasEl = canvas/, '连接时记住 canvas，供卸载时释放')
  })

  test('connect 期间卸载要补做关闭（不能留下已握手的会话）', () => {
    assert.match(
      src,
      /this\.session = await builder\.connect\(\)[\s\S]{0,900}if \(this\._unmounting\) \{[\s\S]{0,160}this\.cleanup\(\)/,
      'connect 返回后必须检查卸载标志并 cleanup'
    )
  })

  test('createTerm / loadWasmModule 之后都有卸载短路', () => {
    const createGuard = next(src, 'if (!r) {', 'if (this._unmounting) {', 'createTerm 之后必须检查卸载')
    const wasmGuard = next(src, 'await loadWasmModule()', 'if (this._unmounting) {', 'loadWasmModule 之后必须检查卸载')
    const connect = next(src, 'await loadWasmModule()', 'this.session = await builder.connect()', '必须建连')
    assert.ok(wasmGuard < connect, '短路必须在建连之前')
    assert.ok(createGuard > 0, 'createTerm 短路必须存在')
  })
})

describe('VNC 关闭：断开前释放 canvas，异步窗口后不再新建 RFB', () => {
  const src = read(VNC)

  test('卸载与原地重连共用同一份"先归零两份 canvas 再 disconnect"', () => {
    assert.match(
      src,
      /_releaseRfb = \(\) => \{[\s\S]{0,400}rfb\._canvas[\s\S]{0,200}canvas\.width = 0[\s\S]{0,100}canvas\.height = 0[\s\S]{0,100}rfb\.disconnect\(\)/,
      'noVNC 的 disconnect 不归还 backing store，需要先归零'
    )
    assert.match(
      src,
      /componentWillUnmount \(\)[\s\S]{0,200}this\._releaseRfb\(\)/,
      '卸载走共享实现'
    )
    const reInit = src.split('handleReInit = () => {')[1].split('}')[0]
    assert.match(reInit, /this\._releaseRfb\(\)/, '重连走同一份释放')
    assert.doesNotMatch(reInit, /disconnect\(\)/, '重连不能再只 disconnect（旧帧缓冲会滞留）')
  })

  test('loadVncModule 之后、new RFB 之前有卸载短路', () => {
    before(src, 'await loadVncModule()', 'if (this._unmounting) {', '加载模块后必须检查卸载')
    before(src, 'if (this._unmounting) {', 'new RFB(', '卸载后新建 RFB 会留下无人关闭的 ws')
  })
})

describe('SPICE 关闭：stop 前释放 canvas，异步窗口后不再新建连接', () => {
  const src = read(SPICE)

  test('卸载与原地重连都在 cleanup 前把自建 canvas 归零', () => {
    assert.match(
      src,
      /_releaseCanvases = \(\) => \{[\s\S]{0,200}querySelectorAll\('canvas'\)[\s\S]{0,200}canvas\.width = 0[\s\S]{0,100}canvas\.height = 0/,
      'stop() 会销毁 canvas，必须先归零 backing store'
    )
    assert.match(
      src,
      /componentWillUnmount \(\)[\s\S]{0,220}this\._releaseCanvases\(\)[\s\S]{0,80}this\.cleanup\(\)/,
      '卸载：归零必须在 cleanup 之前'
    )
    const reInit = src.split('handleReInit = () => {')[1].split('}')[0]
    assert.match(
      reInit,
      /this\._releaseCanvases\(\)[\s\S]{0,60}this\.cleanup\(\)/,
      '重连：归零必须在 cleanup 之前，否则 stop 后画布已查不到'
    )
  })

  test('loadSpiceModule 之后、new SpiceMainConn 之前有卸载短路', () => {
    before(src, 'await loadSpiceModule()', 'if (this._unmounting) {', '加载模块后必须检查卸载')
    before(src, 'if (this._unmounting) {', 'new SpiceMainConn(', '卸载后建连会留下没人 stop 的会话')
  })
})

describe('子进程兜底定时器：任何一条通道连上都不该误杀', () => {
  const src = read(SERVER)

  // 独立 SFTP/FTP tab 只开 /sftp、/transfer，没有 /terminals/:pid。这两条路由
  // 当年漏了 markConnected()，firstWsConnected 恒 false，2 分钟的孤儿兜底定时器
  // 会把正在使用中的子进程连同 sftp 通道一起 kill。
  test('每条 ws 路由都置位 firstWsConnected（反向：新增路由忘了标记）', () => {
    const routes = src.split('app.ws(').slice(1)
    assert.ok(routes.length >= 6, '路由数量应覆盖 rdp/vnc/spice/terminals/sftp/transfer')
    routes.forEach((route, i) => {
      const name = (route.match(/^'([^']+)'/) || [])[1]
      assert.match(
        route,
        /markConnected\(\)/,
        `路由 ${name} 必须在连接建立时 markConnected()，否则 120s 兜底会误杀子进程`
      )
    })
  })

  test('兜底定时器只认 firstWsConnected，且 unref 不阻塞退出', () => {
    assert.match(src, /if \(!firstWsConnected\) \{[\s\S]{0,120}cleanup\(\)/)
    assert.match(src, /noConnectionTimer\.unref/)
  })
})

describe('tab 关闭：统一的按 tab 资源释放', () => {
  const src = read(TAB_STORE)

  test('releaseTabResources 覆盖数据库连接/会话数据/快速命令/录制状态', () => {
    assert.match(src, /function releaseTabResources \(tab\)/)
    assert.match(src, /closeDbTab/)
    assert.match(src, /clearSessionInfo\(tab\.id\)/)
    assert.match(src, /stopQuickCommand\(tab\.id\)/)
    assert.match(src, /delete store\.recState\[tab\.id\]/)
  })

  test('removeTabs 与重连复用同一释放实现，批量关闭经 closeTabsBatch 收口到 removeTabs', () => {
    for (const fn of ['removeTabs', 'reloadTab']) {
      const block = src.split(`Store.prototype.${fn}`)[1] || ''
      assert.ok(block, fn + ' must exist')
      assert.match(block, /releaseTabResources\(/, fn + ' 必须复用 releaseTabResources')
    }
    const batch = src.split('async function closeTabsBatch')[1] || ''
    assert.ok(batch, '缺 closeTabsBatch：批量关闭的统一收尾')
    assert.match(batch.split('export default')[0], /store\.removeTabs\(/,
      'closeTabsBatch 必须把删除交给 removeTabs（释放/压栈/指针都在里面）')
    for (const fn of ['closeOtherTabs', 'closeTabsRight', 'closeTabsLeft', 'closeAllTabs']) {
      const block = (src.split(`Store.prototype.${fn}`)[1] || '').split('Store.prototype.')[0]
      assert.match(block, /closeTabsBatch\(/, fn + ' 必须走 closeTabsBatch')
    }
  })

  test('反向：批量关闭不再自己 splice（少了 splice 就少了"忘记释放"的机会）', () => {
    for (const fn of ['closeOtherTabs', 'closeTabsRight', 'closeTabsLeft', 'closeAllTabs']) {
      const block = (src.split(`Store.prototype.${fn}`)[1] || '').split('Store.prototype.')[0]
      assert.ok(block, fn + ' must exist')
      assert.doesNotMatch(block, /tabs\.splice/, fn + ' 不该再自己 splice，删除统一走 removeTabs')
    }
  })
})

describe('隐藏远程 tab 挂起（M1）：切走超过宽限期就断开，回切自动重连', () => {
  const SRC_ = SRC

  test('激活信号必须下发到远程组件（session.jsx 的 rdpProps 带 currentBatchTabId）', () => {
    const src = read(SESSION)
    assert.match(
      src,
      /'currentBatchTabId'/,
      'VNC/RDP/SPICE 收不到 currentBatchTabId 的话，挂起逻辑无从谈起'
    )
  })

  test('每个远程组件都接入同一个挂起器，且信号缺失时按“激活”兜底', () => {
    const sus = read(path.join(SRC_, 'client/common/remote-suspend.js'))
    assert.match(sus, /export function isTabActive \(props\)/)
    assert.match(sus, /currentBatchTabId === undefined[\s\S]{0,80}return true/, '信号缺失绝不能误挂起正在看的会话')
    for (const [name, file] of [
      ['vnc', 'client/components/vnc/vnc-session.jsx'],
      ['rdp', 'client/components/rdp/rdp-session.jsx'],
      ['spice', 'client/components/spice/spice-session.jsx']
    ]) {
      const src = read(path.join(SRC_, file))
      assert.match(src, /new RemoteSuspend\(/, name + ' 必须接入挂起器')
      assert.match(src, /_suspendRemote = \(\) => \{/, name + ' 必须有挂起方法')
      assert.match(src, /_resumeRemote = \(\) => \{/, name + ' 必须有恢复方法')
      assert.match(src, /componentDidUpdate \(prevProps[\s\S]{0,400}_suspendGuard\.update\(isTabActive\(this\.props\)\)/, name + ' 激活变化时同步挂起器')
    }
  })

  test('vnc：挂起走共享释放且不误报失败，恢复走 remoteInit', () => {
    const src = read(path.join(SRC_, 'client/components/vnc/vnc-session.jsx'))
    assert.match(src, /_suspendRemote = \(\) => \{[\s\S]{0,200}_releaseRfb\(\)/, 'vnc 挂起必须复用 canvas 归零的释放')
    assert.match(src, /_resumeRemote = \(\) => \{[\s\S]{0,160}this\.remoteInit\(\)/, 'vnc 恢复按重连按钮同口径')
    assert.match(src, /if \(this\._suspending\) \{[\s\S]{0,120}return\s*\}/, '挂起主动断开不能误判为连接失败')
  })

  test('rdp：挂起走 cleanup + 归零，恢复走 remoteInit，且 unmount 前不重连', () => {
    const src = read(path.join(SRC_, 'client/components/rdp/rdp-session.jsx'))
    assert.match(src, /_suspendRemote = \(\) => \{[\s\S]{0,120}this\.cleanup\(\)[\s\S]{0,120}this\._releaseCanvas\(\)/, 'rdp 挂起 = cleanup + 归零 canvas')
    assert.match(src, /_resumeRemote = \(\) => \{[\s\S]{0,200}if \(this\._unmounting \|\| this\.session\) \{[\s\S]{0,120}this\.remoteInit\(\)/, 'rdp 恢复前必须先确认已卸载/未建新会话')
  })

  test('spice：挂起走归零 + cleanup，恢复走 reloadTab（与重连按钮同一条路径）', () => {
    const src = read(path.join(SRC_, 'client/components/spice/spice-session.jsx'))
    assert.match(src, /_suspendRemote = \(\) => \{[\s\S]{0,120}this\._releaseCanvases\(\)[\s\S]{0,80}this\.cleanup\(\)/, 'spice 挂起 = 先归零再 stop')
    assert.match(src, /_resumeRemote = \(\) => \{[\s\S]{0,200}this\.props\.reloadTab\(this\.props\.tab\)/, 'spice 恢复与重连按钮一致走 reloadTab')
  })
})

describe('挂起档位选择器：三端顶栏 B 区共用 RemoteSuspendSelect', () => {
  const SELECT = path.join(SRC, 'client/components/common/remote-suspend-select.jsx')

  test('共享组件读写同一全局配置 remoteSuspendSeconds', () => {
    const src = read(SELECT)
    assert.match(src, /config\?\.remoteSuspendSeconds/, '必须读 config.remoteSuspendSeconds')
    assert.match(src, /updateConfig\(\{ remoteSuspendSeconds/, '必须写回同一 config 键')
    assert.match(src, /remote-suspend/, '默认值必须派生自 suspendGraceDefaultMs，不能双写')
  })

  test('三端 renderDisplayItems 都挂载该选择器', () => {
    for (const [name, file] of [
      ['vnc', 'client/components/vnc/vnc-session.jsx'],
      ['rdp', 'client/components/rdp/rdp-session.jsx'],
      ['spice', 'client/components/spice/spice-session.jsx']
    ]) {
      const src = read(path.join(SRC, file))
      assert.match(src, /import RemoteSuspendSelect from '\.\.\/common\/remote-suspend-select'/, name + ' 必须引入共享选择器')
      next(src, 'renderDisplayItems', '<RemoteSuspendSelect />', name + ' 的 B 区必须挂载挂起档位选择器')
    }
  })
})
